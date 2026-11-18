// middleware: أي /api/* غير معروف في مشروع خادم MCP يرد بـ JSON عربي بدل 404 افتراضي
// السبب الأشهر: استدعاء نقاط خدمة الدمج (jobs/upload/config) على مشروع MCP بالخطأ
import { NextResponse, type NextRequest } from "next/server";

// نقاط /api المعروفة في هذا المشروع (المسارات الديناميكية تُغطى ببادئاتها)
const KNOWN_API = ["/api/health", "/api/keys", "/api/tasks"];

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const known = KNOWN_API.some((k) => path === k || path.startsWith(k + "/"));
  if (known) return NextResponse.next();

  const isMergerPath = /^\/api\/(jobs|upload|config|cron|fallback)/.test(path);
  return NextResponse.json(
    {
      error: `المسار «${path}» غير موجود في خادم MCP`,
      hint: isMergerPath
        ? "هذه نقطة من خدمة دمج الفيديو — استدعِها على رابط مشروع الدمج (MERGER_API_BASE) وليس على هذا المشروع"
        : "نقاط هذا المشروع: /api/health و /api/keys و /api/tasks و /mcp",
    },
    { status: 404, headers: { "Access-Control-Allow-Origin": "*" } }
  );
}

export const config = {
  matcher: ["/api/:path*"],
};
