// اختبار HTTP كامل ضد خادم التطوير: إنشاء من روابط ← دمج ← بث مع Range 206
// ثم مهمة مختلطة (رابط + ملف مرفوع) ← حذف → 404 → JSON تالف → قائمة فارغة
const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { ffmpegPath } = require("../lib/merge");

const BASE = process.env.BASE_URL || "http://127.0.0.1:4000";
const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
}

// ===== خادم ذاتي: npm run test:http يعمل من الصفر بلا خادم خارجي =====
let serverChild = null;
async function ensureServer() {
  // إن كان خادمًا يعمل مسبقًا على BASE نستخدمه كما هو
  try {
    await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(1500) });
    return;
  } catch {}
  // إطلاق خادم التطوير (يقرأ .env تلقائيًا عبر lib/env.js)
  serverChild = spawn(process.execPath, [path.join(__dirname, "dev-server.js")], {
    stdio: "ignore",
    env: process.env,
  });
  // انتظار أول استجابة HTTP مهما كان رمزها — الاستجابة تعني أن الخادم يعمل
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {}
    if (serverChild.exitCode !== null) {
      throw new Error("انطفأ خادم التطوير فور تشغيله — جرّب npm run dev وحده لرؤية السبب (غالبًا المنفذ 4000 مشغول)");
    }
  }
  throw new Error("خادم التطوير لم يجهز خلال 15 ثانية");
}
function stopServer() {
  if (serverChild) { try { serverChild.kill(); } catch {} serverChild = null; }
}

async function jfetch(url, opts = {}) {
  const r = await fetch(url, opts);
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body, headers: r.headers };
}

async function genClips(dir) {
  const a = path.join(dir, "a.mp4");
  const b = path.join(dir, "b.mp4");
  execFileSync(ffmpegPath(), ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=960x540:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", a], { stdio: "ignore" });
  execFileSync(ffmpegPath(), ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", b], { stdio: "ignore" });
  return [a, b];
}

async function main() {
  await ensureServer();
  // تحقق أن الخدمة تعمل
  const cfg = await jfetch(`${BASE}/api/config`);
  check("GET /api/config يعمل", cfg.status === 200 && cfg.body.ok === true, JSON.stringify(cfg.body).slice(0, 80));

  const dir = fs.mkdtempSync("/tmp/vm-http-");
  const [a, b] = await genClips(dir);
  // انسخ المقاطع إلى مجلد يخدمه الخادم كملفات ثابتة (/testmedia/)
  const tmDir = path.join(__dirname, "testmedia");
  fs.mkdirSync(tmDir, { recursive: true });
  fs.copyFileSync(a, path.join(tmDir, "a.mp4"));
  fs.copyFileSync(b, path.join(tmDir, "b.mp4"));

  // 1) مهمة من روابط
  const c1 = await jfetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: [`${BASE}/testmedia/a.mp4`, `${BASE}/testmedia/b.mp4`] }),
  });
  check("إنشاء مهمة من روابط يعيد 201", c1.status === 201 && c1.body.jobId, JSON.stringify(c1.body).slice(0, 120));
  const jobId = c1.body.jobId;
  check("الاستجابة تحتوي statusUrl و processUrl و expiresAt", !!c1.body.statusUrl && !!c1.body.processUrl && !!c1.body.expiresAt);

  // 2) تنفيذ الدمج
  const pr = await jfetch(`${BASE}/api/jobs/${jobId}/process`, { method: "POST" });
  check("process يعيد 200 done", pr.status === 200 && pr.body.status === "done", JSON.stringify(pr.body).slice(0, 160));
  check("الناتج يحمل duration وحجمًا موجبًا", pr.body.size > 0 && pr.body.duration > 0, `${pr.body.size}B / ${pr.body.duration}s / ${pr.body.resolution}`);

  // 3) بث الناتج مع Range 206
  const head = await fetch(`${BASE}/api/jobs/${jobId}/video`);
  const totalSize = Number(head.headers.get("content-length"));
  check("بث كامل 200 بطول صحيح", head.status === 200 && totalSize === pr.body.size, `content-length=${totalSize}`);
  // نستهلك الجسم كاملًا (الإلغاء منتصفًا يفسد اتصال keep-alive في undici ويؤثر على الطلبات التالية)
  const fullBody = Buffer.from(await head.arrayBuffer());
  check("البث الكامل يطابق حجم الناتج", fullBody.length === totalSize);
  const rng = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: "bytes=100-1099" } });
  const rb = Buffer.from(await rng.arrayBuffer());
  check("Range يعيد 206 مع Content-Range", rng.status === 206 && rng.headers.get("content-range") === `bytes 100-1099/${totalSize}`);
  check("طول نافذة Range صحيح", rb.length === 1000);

  // 4) مهمة مختلطة: رابط + ملف مرفوع بالأجزاء
  const c2 = await jfetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sources: [ { kind: "url", url: `${BASE}/testmedia/b.mp4` }, { kind: "file", name: "up.mp4", size: fs.statSync(a).size, mime: "video/mp4" } ] }),
  });
  check("إنشاء مهمة مختلطة يعيد 201 وstatus=uploading", c2.status === 201 && c2.body.status === "uploading" && Array.isArray(c2.body.uploads));
  const up = c2.body.uploads[0];
  check("uploads[] تحمل uploadUrl و uploadChunkBytes=4MB", up && up.uploadChunkBytes === 4 * 1024 * 1024);
  const fileBuf = fs.readFileSync(a);
  const CH = 1.5 * 1024 * 1024; // قسّم لجزأين صغيرين للاختبار
  let nChunks = 0;
  for (let k = 0; k * CH < fileBuf.length; k++) {
    const slice = fileBuf.subarray(k * CH, Math.min((k + 1) * CH, fileBuf.length));
    const ur = await fetch(up.uploadUrl.replace("<n>", String(k)), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: slice,
    });
    if (ur.ok) nChunks++;
  }
  check("رفع الأجزاء عبر HTTP يعمل", nChunks === Math.ceil(fileBuf.length / CH), `${nChunks} أجزاء`);
  const pr2 = await jfetch(`${BASE}/api/jobs/${c2.body.jobId}/process`, { method: "POST" });
  check("دمج المهمة المختلطة يكتمل", pr2.status === 200 && pr2.body.status === "done", JSON.stringify(pr2.body).slice(0, 120));

  // 5) حذف ثم 404
  const del = await jfetch(`${BASE}/api/jobs/${jobId}`, { method: "DELETE" });
  check("DELETE يعيد deleted:true", del.status === 200 && del.body.deleted === true);
  const g404 = await jfetch(`${BASE}/api/jobs/${jobId}`);
  check("GET بعد الحذف يعيد 404 برسالة عربية", g404.status === 404 && /غير موجودة/.test(g404.body.error));
  const v404 = await fetch(`${BASE}/api/jobs/${jobId}/video`);
  check("بث ناتج محذوف يعيد 404", v404.status === 404);
  await v404.body?.cancel?.().catch?.(() => {});

  // 6) JSON تالف → 400
  const bad = await jfetch(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  check("JSON تالف يعيد 400", bad.status === 400);

  // 7) قائمة فارغة (مقطع واحد) → 400
  const one = await jfetch(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: [] }) });
  check("مقاطع أقل من اثنين تعيد 400", one.status === 400);
  const empty = await jfetch(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  check("جسم بلا videos/sources يعيد 400 برسالة عربية", empty.status === 400 && /videos|sources/.test(empty.body.error));

  // 8) 405 لطريقة خاطئة
  const m405 = await jfetch(`${BASE}/api/jobs/${c2.body.jobId}/process`, { method: "GET" });
  check("GET على process يعيد 405", m405.status === 405);

  // تنظيف: احذف كل مهام الاختبار
  for (const id of [jobId, c2.body.jobId]) {
    await jfetch(`${BASE}/api/jobs/${id}`, { method: "DELETE" });
  }
  const cron = await jfetch(`${BASE}/api/cron`);
  check("GET /api/cron يعمل", cron.status === 200 && cron.body.ok === true);

  for (const f of [a, b]) fs.unlinkSync(f);
  fs.rmSync(tmDir, { recursive: true, force: true });
  fs.rmdirSync(dir);

  const failed = results.filter(r => !r.ok);
  console.log(`\nالنتيجة: ${results.length - failed.length}/${results.length} نجحت`);
  stopServer();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("فشل غير متوقع:", e); stopServer(); process.exit(1); });
