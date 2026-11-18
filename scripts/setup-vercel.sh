#!/usr/bin/env bash
# =====================================================================
# إصلاح خطأ Vercel NOT_FOUND (404) بأمر واحد
# ---------------------------------------------------------------------
# السبب الأشهر للخطأ في هذا المستودع: نشر الشجرة الجذرية بدل مجلد المشروع.
# هذا السكربت يفعل كل شيء تلقائيًا لكل مشروع (الدمج + خادم MCP):
#   1) إنشاء مشروع Vercel إن لم يكن موجودًا
#   2) ضبط Root Directory عبر واجهة برمجة Vercel (يصلح نشرات Git المستقبلية)
#   3) ضخ متغيرات البيئة (Turso + MERGER_API_BASE)
#   4) نشر Production والتحقق من نقاط الجهوزية عبر curl
#
# الاستخدام (من جذر المستودع بعد git pull):
#   VERCEL_TOKEN=xxxx TURSO_AUTH_TOKEN=yyyy bash scripts/setup-vercel.sh
#
# الحصول على التوكنات:
#   VERCEL_TOKEN     → vercel.com → Account Settings → Tokens → Create
#   TURSO_AUTH_TOKEN → app.turso.io → قاعدة sanad-mahersanad → Tokens
#
# إن كان لديك فريق (team) على Vercel أضف: VERCEL_SCOPE=اسم-الفريق
# =====================================================================
set -uo pipefail

# ---- الانتقال لجذر المستودع (حيث يقع هذا السكربت في scripts/) ----
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MERGER_DIR="video-merger"
MCP_DIR="mcp-media-generator"
MERGER_PROJECT="${MERGER_PROJECT:-video-merger-service}"
MCP_PROJECT="${MCP_PROJECT:-mcp-media-generator}"
# رابط قاعدة Turso ليس سرًا (موثق في README) لكن التوكن سر
TURSO_DATABASE_URL="${TURSO_DATABASE_URL:-libsql://sanad-mahersanad.aws-eu-west-1.turso.io}"

VC="npx --yes vercel"

# رسائل التقدم إلى stderr حتى لا تختلط بالروابط المُلتقطة من stdout
say()   { printf '\033[1;36m%s\033[0m\n' "$*" >&2; }
warn()  { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }
fail()  { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

# ---- 0) التحقق من المدخلات ----
[ -n "${VERCEL_TOKEN:-}" ] || fail "خطأ: ضع VERCEL_TOKEN (من vercel.com → Account Settings → Tokens)"
[ -n "${TURSO_AUTH_TOKEN:-}" ] || fail "خطأ: ضع TURSO_AUTH_TOKEN (من app.turso.io → Tokens)"
SCOPE_ARGS=""
[ -n "${VERCEL_SCOPE:-}" ] && SCOPE_ARGS="--scope $VERCEL_SCOPE"

say "→ التحقق من توكن Vercel…"
$VC whoami --token "$VERCEL_TOKEN" $SCOPE_ARGS >/dev/null 2>&1 \
  || fail "فشل التحقق: توكن Vercel غير صالح أو انتهت صلاحيته"
say "  التوكن سليم ✓"

# ---- دوال مساعدة ----
# إنشاء المشروع إن لم يكن موجودًا (يفشل بهدوء إن كان موجودًا)
ensure_project() { # $1 = اسم المشروع
  $VC project add "$1" --token "$VERCEL_TOKEN" $SCOPE_ARGS >/dev/null 2>&1 \
    && say "  أنشأت مشروع «$1» ✓" \
    || say "  مشروع «$1» موجود مسبقًا ✓"
}

# ضبط Root Directory عبر REST API — يصنع الفرق بين عمل نقاط المسارات و404
set_root_dir() { # $1 = اسم المشروع، $2 = المجلد
  local code
  code="$(curl -sS -X PATCH "https://api.vercel.com/v9/projects/$1$SCOPE_QUERY" \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"rootDirectory\":\"$2\"}" \
    -o /dev/null -w '%{http_code}' 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then
    say "  Root Directory = $2 ✓ (نشرات Git المستقبلية ستُبنى من المجلد الصحيح)"
  else
    warn "  ⚠ تعذر ضبط Root Directory عبر API (HTTP $code)"
    warn "    اضبطه يدويًا: Vercel → مشروع $1 → Settings → General → Root Directory = $2"
  fi
}

# ضخ متغير بيئة (يقرأ CLI القيمة من stdin)
set_env() { # $1 = المجلد، $2 = الاسم، $3 = القيمة
  ( cd "$1" && printf '%s\n' "$3" | timeout 120 $VC env add "$2" production --token "$VERCEL_TOKEN" $SCOPE_ARGS >/dev/null 2>&1 ) \
    && say "  متغير $2 ✓" \
    || warn "  ⚠ فشل ضخ $2 — أضفه يدويًا: Project Settings → Environment Variables"
}

# ربط المجلد بالمشروع ثم النشر، وإرجاع رابط الإنتاج
deploy_dir() { # $1 = المجلد، $2 = اسم المشروع
  local out url
  say "→ ربط $1 بمشروع $2…"
  ( cd "$1" && timeout 180 $VC link --yes --project "$2" --token "$VERCEL_TOKEN" $SCOPE_ARGS >/dev/null 2>&1 ) \
    || warn "  ⚠ تعذر الربط — إذا سألك Vercel عن الفريق أضف VERCEL_SCOPE=اسم-الفريق"
  say "→ نشر Production (البناء على خوادم Vercel، قد يستغرق دقيقتين)…"
  out="$( cd "$1" && timeout 420 $VC deploy --prod --yes --token "$VERCEL_TOKEN" $SCOPE_ARGS 2>&1 )"
  url="$(printf '%s\n' "$out" | grep -oE 'https://[A-Za-z0-9-]+\.vercel\.app' | tail -1)"
  [ -n "$url" ] || { printf '%s\n' "$out" | tail -20; fail "فشل النشر — راجع المخرجات أعلاه"; }
  say "  نُشر على: $url ✓"
  echo "$url"
}

# SCOPE_QUERY لاستدعاءات curl (سؤال الفريق في API يختلف عن CLI)
SCOPE_QUERY=""
[ -n "${VERCEL_SCOPE:-}" ] && SCOPE_QUERY="?teamId=$VERCEL_SCOPE"

# =====================================================================
say ""
say "═══ 1/4) خدمة الدمج ($MERGER_DIR) ═══"
ensure_project "$MERGER_PROJECT"
set_root_dir "$MERGER_PROJECT" "$MERGER_DIR"
set_env "$MERGER_DIR" "TURSO_DATABASE_URL" "$TURSO_DATABASE_URL"
set_env "$MERGER_DIR" "TURSO_AUTH_TOKEN" "$TURSO_AUTH_TOKEN"
MERGER_URL="$(deploy_dir "$MERGER_DIR" "$MERGER_PROJECT")"

say ""
say "═══ 2/4) خادم MCP ($MCP_DIR) ═══"
ensure_project "$MCP_PROJECT"
set_root_dir "$MCP_PROJECT" "$MCP_DIR"
set_env "$MCP_DIR" "TURSO_DATABASE_URL" "$TURSO_DATABASE_URL"
set_env "$MCP_DIR" "TURSO_AUTH_TOKEN" "$TURSO_AUTH_TOKEN"
set_env "$MCP_DIR" "MERGER_API_BASE" "$MERGER_URL"

say ""
say "═══ 3/4) نشر خادم MCP ═══"
MCP_URL="$(deploy_dir "$MCP_DIR" "$MCP_PROJECT")"

say ""
say "═══ 4/4) التحقق من الجهوزية ═══"
sleep 5
MERGER_RESP="$(curl -fsS --max-time 20 "$MERGER_URL/api/config" 2>/dev/null || true)"
if [ -n "$MERGER_RESP" ]; then printf '%s\n' "$MERGER_RESP" | head -c 160; echo; say "  خدمة الدمج تعمل ✓"
else warn "  ⚠ $MERGER_URL/api/config لم يرد بعد — انتظر 30 ثانية وأعد المحاولة"; fi
MCP_RESP="$(curl -fsS --max-time 20 "$MCP_URL/api/health" 2>/dev/null || true)"
if [ -n "$MCP_RESP" ]; then printf '%s\n' "$MCP_RESP" | head -c 160; echo; say "  خادم MCP يعمل ✓"
else warn "  ⚠ $MCP_URL/api/health لم يرد بعد — انتظر 30 ثانية وأعد المحاولة"; fi

say ""
say "═══ اكتمل ✓ ═══"
say "رابط خدمة الدمج : $MERGER_URL"
say "رابط خادم MCP   : $MCP_URL  (أضف /mcp لعميل MCP)"
say "لوحة الإدارة    : $MCP_URL  ← أضف مفتاح kie.ai من بطاقة «مدير المفاتيح»"
say "إن ظهر NOT_FOUND مجددًا: راجع README.md القسم 3.4"
