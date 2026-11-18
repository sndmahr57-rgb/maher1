# MCP Media Generator + Video Merger

مستودع يحوي مشروعين متكاملين يعملان معًا على Vercel:

| المشروع | المجلد | الوظيفة |
|---|---|---|
| **خادم MCP لتوليد الوسائط** | `mcp-media-generator/` | Next.js + بروتوكول MCP على `/mcp` بخمس أدوات (توليد صور، توليد فيديو بصوت متزامن، دمج مقاطع، تتبع مهام، استرجاع الوسائط) + لوحة إدارة عربية RTL |
| **خدمة دمج الفيديو** | `video-merger/` | Node خالص (Serverless) + ffmpeg + Turso — واجهة موقع عربية + API عامة للدمج، وهي الخدمة التي يستدعيها الخادم الأول عبر `MERGER_API_BASE` |

القواعد الجوهرية المطبقة في الخادم الأول:

1. **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر؛ تُخزَّن روابط النتائج في قاعدة Turso فقط.
2. **ترتيب تسلسلي صارم للمفاتيح** بترتيب الإضافة (`created_at ASC, id ASC`) — ليس round-robin.
3. **تبديل فوري تلقائي** عند أي خطأ أو نفاد رصيد، واستئناف نفس المهمة بنفس `task_id` — العميل لا يرى أي ذكر للمفاتيح أو الرصيد أبدًا.
4. مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة 45 ثانية).
5. المفتاح المستنزف (`exhausted`) يبقى في القاعدة ويُعاد تفعيله تلقائيًا عند أول نجاح؛ `disabled` فقط يُستبعد من القائمة.
6. أخطاء خدمة الدمج المعلنة (HTTP 4xx/5xx) = فشل حتمي فوري؛ أخطاء الشبكة = مؤقتة وتستمر بالاستعلام.
7. ملفات الدمج تُحذف بعد 24 ساعة — مذكورة في وصف الأداة وفي تعليمات السيرفر وفي الردود.
8. المفاتيح مُقنَّعة (`ABCD123••••••••WXYZ`) في كل الاستجابات — لا يعاد المفتاح الكامل أبدًا.

---

## 1) قاعدة Turso

الطبقة إلزامية عبر HTTP (`@libsql/client`) — متوافقة مع Vercel serverless بلا أي ملف محلي.

```bash
# إنشاء قاعدة مجانية (مرة واحدة)
turso db create <name>
turso db show <name> --url          # → TURSO_DATABASE_URL
turso db tokens create <name>       # → TURSO_AUTH_TOKEN
```

المخطط يُنشأ تلقائيًا عند أول وصول (`CREATE TABLE IF NOT EXISTS`) — لا حاجة لأداة migrations.

## 2) التشغيل المحلي

```bash
# خدمة الدمج أولًا (المنفذ 4000)
cd video-merger
cp .env.example .env          # ضع متغيري Turso
npm install
npm run dev                    # http://127.0.0.1:4000

# خادم MCP (المنفذ 3000)
cd ../mcp-media-generator
cp .env.example .env.local     # ضع متغيري Turso + MERGER_API_BASE=http://127.0.0.1:4000
npm install
npm run build && npm start     # http://127.0.0.1:3000
```

الاختبارات:

```bash
cd video-merger
npm run test:unit    # 15/15 ✅ — دمج ffmpeg + تخزين Turso (sha256) + رفع أجزاء + حدود + حذف
npm run test:http    # 21/21 ✅ — واجهة HTTP كاملة ضد خادم التطوير (يشمل Range 206)
```

## 3) النشر على Vercel خطوة بخطوة

> ملاحظة: لا يمكن نشر المشروع برمجيًا من هنا (لا يوجد توكن Vercel) — الخطوات أدناه تستغرق دقيقتين من لوحة التحكم.

### 3.1 خدمة الدمج (`video-merger`)

1. ادخل [vercel.com/new](https://vercel.com/new) واربط مستودع `maher1`.
2. في صفحة الإعداد قبل النشر: **Root Directory** = `video-merger` (Framework Preset: Other).
3. **Environment Variables** (لازمتان):
   - `TURSO_DATABASE_URL` = `libsql://sanad-mahersanad.aws-eu-west-1.turso.io`
   - `TURSO_AUTH_TOKEN` = التوكن الخاص بقاعدة Turso
4. Deploy. بعد النشر خذ رابط المشروع (مثل `https://video-merger-xxx.vercel.app`) — هذا هو `MERGER_API_BASE` للخطوة التالية.
5. ملف `vercel.json` جاهز: `maxDuration: 300` لكل الدوال + Cron يومي `/api/cron` للتنظيف.

### 3.2 خادم MCP (`mcp-media-generator`)

1. أنشئ مشروع Vercel آخر من نفس المستودع: **Root Directory** = `mcp-media-generator` (Next.js).
2. **Environment Variables**:
   - `TURSO_DATABASE_URL` — نفس القيمة
   - `TURSO_AUTH_TOKEN` — نفس القيمة
   - `MERGER_API_BASE` = رابط مشروع الدمج من 3.1 (مثل `https://video-merger-xxx.vercel.app`)
   - اختياري: `MCP_ACCESS_TOKEN` (يحمي `/mcp` بـ Bearer)، `KIE_IMAGE_MODEL`، `KIE_VIDEO_MODEL`، `COMETAPI_IMAGE_MODEL`، `COMETAPI_VIDEO_MODEL`
3. Deploy، ثم افتح لوحة الإدارة على رابط المشروع وأضف مفتاح kie.ai (أو CometAPI) من بطاقة «مدير المفاتيح».

### 3.3 ربط عميل MCP بالسيرفر المنشور

> **أخطأ NOT_FOUND (404) بعد النشر؟** راجع القسم 3.4 أدناه — أشهر أسبابه في هذا المستودع ثلاثة مواضع محددة.

بعد النشر، رابط الخادم هو `https://<project>.vercel.app/mcp`. اللوحة تعرض JSON جاهزًا للنسخ لكل عميل:

- **ChatGPT / GPT Agents**: Settings → Connectors → Create → Custom MCP server → ضع الرابط في «Server URL»، أو:
  ```json
  {"mcpServers":{"media-generator":{"url":"https://<project>.vercel.app/mcp"}}}
  ```
- **Claude Desktop** (`claude_desktop_config.json`):
  ```json
  {"mcpServers":{"media-generator":{"type":"http","url":"https://<project>.vercel.app/mcp"}}}
  ```
- **Cursor / Windsurf / Cline** (`mcp.json`): نفس صيغة ChatGPT أعلاه.

إن ضُبط `MCP_ACCESS_TOKEN` أضف في كل عميل:
```json
"headers": {"Authorization": "Bearer <MCP_ACCESS_TOKEN>"}
```

### 3.4 استكشاف خطأ NOT_FOUND (404) وإصلاحه

خطأ `NOT_FOUND` يعني أن **المسار المطلوب غير موجود داخل النشر المُستهدف** — الحساب الذي يهم فيه: أي رابط أعطى الخطأ؟

| ما الذي أعطى 404؟ | السبب المرجح | الإصلاح |
|---|---|---|
| كل المسارات (`/` و`/api/*` وكل شيء) على نشر واحد | **Root Directory لم يُضبط** — نُشرت الشجرة الجذرية للمستودع التي لا فيها أي مشروع | في كل مشروع: Settings → General → **Root Directory** = `video-merger` أو `mcp-media-generator` → Redeploy |
| `404` عند فتح `/` على نشر خدمة الدمج | النشر اكتُشف كـ «Other» بلا مخرجات ثابتة | تأكد من Root Directory ثم Redeploy — يجب أن يفتح موقع الدمج من `public/index.html` |
| `/api/jobs` أو `/api/upload` أو `/api/config` على نشر **خادم MCP** | هذه النقاط **في مشروع الدمج فقط** — استُدعيت على المشروع الخطأ | استخدم رابط مشروع الدمج؛ واضبط `MERGER_API_BASE` على مشروع MCP لرابط الدمج ثم Redeploy |
| `/mcp` على نشر **خدمة الدمج** | خادم MCP في المشروع الآخر | استخدم رابط مشروع `mcp-media-generator` |
| 404 JSON عربي «حُذفت أو انتهت صلاحيتها» | **ليست مشكلة نشر** — استجابة التطبيق نفسها (مهمة غير موجودة أو انقضت بعد 24 ساعة) | طبيعي وفق التصميم |

بعد أي تغيير في Root Directory أو متغيرات البيئة يلزم **Redeploy** (التغييرات لا تُطبق على النشر الحالي تلقائيًا). للتمييز السريع: افتح `https://<merger>/api/config` على نشر الدمج و`https://<mcp>/api/health` على نشر MCP — إذا أعادا JSON صحيحًا فالنشر سليم والمشكلة في الرابط المستخدم.

## 4) جدول متغيرات البيئة

| المتغير | المشروع | إلزامي | الوصف |
|---|---|---|---|
| `TURSO_DATABASE_URL` | كلاهما | ✅ | رابط قاعدة Turso (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | كلاهما | ✅ | توكن قاعدة Turso |
| `MERGER_API_BASE` | mcp | ✅ | رابط خدمة الدمج المنشورة على Vercel |
| `MCP_ACCESS_TOKEN` | mcp | — | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | mcp | — | تجاوز أسماء الموديلات لدى kie |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | mcp | — | تجاوز أسماء الموديلات لدى CometAPI |
| `MAX_SOURCES` | merger | — | أقصى عدد مقاطع (10) |
| `SOURCE_MAX_MB` / `OUTPUT_MAX_MB` | merger | — | حدود الأحجام (200 / 150) |
| `MAX_TOTAL_DURATION_SEC` | merger | — | أقصى مجموع مدد (600) |
| `FFMPEG_PRESET` | merger | — | preset الترميز (medium) |

## 5) توثيق API خدمة الدمج

جميع النقاط بلا تسجيل دخول، CORS مفتوح، والأخطاء بصيغة `{"error":"..."}` برسائل عربية:

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة — يقبل `{"videos":[...]}` أو `{"sources":[{kind:"url"|"file",...}]}` → `201` مع `jobId/statusUrl/processUrl/expiresAt` و`uploads[]` عند وجود ملفات |
| `POST` | `/api/upload?job=&seq=&chunk=` | رفع أجزاء ثنائية ≤4MB (octet-stream) مع إعادة محاولة ×3 من العميل |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا (متزامن ~10–15 ث) → `{"status":"done","videoUrl":...,"downloadUrl":...,"size":...,"duration":...,"resolution":...}` أو `202` إن كانت قيد المعالجة |
| `GET` | `/api/jobs/<id>` | الحالة + التقدم 0–100 + الرابط عند الاكتمال |
| `GET` | `/api/jobs/<id>/video` | بث الناتج بدعم Range (206) — و`?download=1` للتحميل |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل (كل صفوف المهمة في دفعة واحدة) |
| `GET` | `/api/config` | الحدود العامة + version — يُستخدم لفحص الجهوزية |
| `GET` | `/api/cron` | حذف المهام المنتهية (Cron يومي عبر `vercel.json`) |

أمثلة curl:

```bash
# إنشاء مهمة من روابط
curl -s https://<merger>.vercel.app/api/jobs -H "Content-Type: application/json" \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'

# تنفيذ الدمج
curl -s -X POST https://<merger>.vercel.app/api/jobs/<jobId>/process

# متابعة الحالة / تحميل الناتج
curl -s https://<merger>.vercel.app/api/jobs/<jobId>
curl -sL "https://<merger>.vercel.app/api/jobs/<jobId>/video?download=1" -o merged.mp4
```

## 6) اختبار خادم MCP بعد النشر

```bash
# تهيئة جلسة (الوضع stateless — لا حاجة لمعرّف جلسة)
curl -s -X POST https://<mcp>.vercel.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}'

# قائمة الأدوات
curl -s -X POST https://<mcp>.vercel.app/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# استدعاء أداة (توليد صورة)
curl -s -X POST https://<mcp>.vercel.app/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"a red apple","wait_seconds":90}}}'
```

## 7) حدود الخطة المجانية التي يجب معرفتها

| الحد | القيمة | التأثير |
|---|---|---|
| مدة الدالة (Fluid) | حتى 300 ثانية | الفيديو الطويل جدًا قد يقترب من السقف — قسّمه إلى مقاطع |
| حجم جسم الطلب | ~4.5MB | الرفع من الواجهة يعمل بأجزاء 4MB مع إعادة محاولة ×3 |
| حجم الـ Bundle للدالة | 250MB غير مضغوط | ffmpeg + ffprobe ثنائيات مضمنة عبر `includeFiles` (~110MB) — مناسب |
| قاعدة Turso المجانية | 500MB تخزين / 1 مليار قراءة شهريًا تقريبًا | الناتج ≤150MB لكل مهمة ويُحذف بعد 24 ساعة عبر Cron |
| Cron | يومي واحد مجانًا | `/api/cron` يوميًا 03:00 UTC |

## 8) بنية المستودع

```
maher1/
├── mcp-media-generator/          # خادم MCP (Next.js 15 + App Router + TypeScript + Tailwind)
│   ├── src/app/mcp/route.ts      #   مسار /mcp — SDK الرسمي WebStandardStreamableHTTPServerTransport
│   ├── src/app/api/              #   health / keys / tasks
│   ├── src/app/page.tsx          #   لوحة الإدارة العربية RTL (مفاتيح + مهام + ربط)
│   └── src/lib/                  #   turso / keys / models / generation / merger / providers
└── video-merger/                 # خدمة الدمج (Node CommonJS خالص بلا خطوة بناء)
    ├── api/                      #   دوال Vercel Serverless
    ├── lib/                      #   db / storage / merge (ffmpeg) / process / download
    ├── public/index.html         #   واجهة الموقع العربية (سحب وإفلات + ترتيب + تقدم + نتيجة)
    └── scripts/                  #   dev-server (يحاكي Vercel) + اختبارات الوحدات و HTTP
```

## 9) نتائج الاختبارات المسجلة أثناء البناء

- `tsc --noEmit` نظيف و `next build` ينجح بلا أخطاء.
- وحدات خدمة الدمج: **15/15** (دقة الدمج = أكبر دقة مدخل، المدة ≈ المجموع، صوت تلقائي للمصادر الصامتة، sha256 للتخزين والقراءة، رفع الأجزاء، حدود، حذف شامل).
- HTTP خدمة الدمج: **21/21** (إنشاء/دمج/بث/Range 206/مهمة مختلطة/حذف→404/JSON تالف→400/405).
- MCP عبر curl: تهيئة + 5 أدوات بمخططات مطابقة (الدمج بحد 10 وبلا resolution/fps) + `list_media` عربي.
- تبديل تسلسلي حقيقي: مفتاح خاطئ أولًا → `disabled` تلقائيًا، والمفتاح الحقيقي بعد نفاد رصيده فعليًا → `exhausted` مع بقاء المهمة `processing` وإعادة محاولة كل 45 ث، **وبدون أي ذكر للمفاتيح أو الرصيد في ردود العميل**.
- توليد صورة وفيديو حقيقيان عبر مزود kie.ai (قبل نفاد الرصيد) — الروابط تعمل مباشرة (PNG 783KB / MP4).
- دمج e2e عبر `merge_videos`: مقطعان عامان → MP4 نهائي (h264، 640x360، 20 ث) يبث بـ Range 206 ويُنزَّل.
- رفض الدمج (<2 و>10) برسائل عربية، وحل `task_ids` بالترتيب مع تفاصيل المعرّفات الفاشلة.
- Progress notifications حية عبر SSE برسالة عربية عند تمرير `_meta.progressToken`.
