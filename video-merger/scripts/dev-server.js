// خادم تطوير محلي يحاكي بيئة Vercel: يحلّل المسارات الديناميكية ويضعها في req.query
// ويخدم api/*.js بنفس توقيع الدوال (req, res) — و public/ كملفات ثابتة
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { loadEnv } = require("../lib/env");
loadEnv();

const PORT = parseInt(process.env.PORT || "4000", 10);
const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// خريطة المسارات الديناميكية → ملف الدالة
function resolveApi(pathname) {
  // /api/jobs/<id>/process | /video
  let m = pathname.match(/^\/api\/jobs\/([^/]+)\/(process|video)$/);
  if (m) {
    const mod = require(path.join(ROOT, "api", "jobs", m[2] === "video" ? "[id]/video.js" : "[id]/process.js"));
    return { handler: mod, query: { id: decodeURIComponent(m[1]) } };
  }
  m = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (m) {
    const mod = require(path.join(ROOT, "api", "jobs", "[id].js"));
    return { handler: mod, query: { id: decodeURIComponent(m[1]) } };
  }
  if (pathname === "/api/jobs") return { handler: require(path.join(ROOT, "api", "jobs.js")), query: {} };
  if (pathname === "/api/upload") return { handler: require(path.join(ROOT, "api", "upload.js")), query: {} };
  if (pathname === "/api/config") return { handler: require(path.join(ROOT, "api", "config.js")), query: {} };
  if (pathname === "/api/cron") return { handler: require(path.join(ROOT, "api", "cron.js")), query: {} };
  return null;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  try {
    if (pathname.startsWith("/api/")) {
      const resolved = resolveApi(pathname);
      if (!resolved) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "نقطة النهاية غير موجودة" }));
      }
      // توحيد req.query مع معاملات الاستعلام + معاملات المسار الديناميكي
      req.query = { ...parsed.query, ...resolved.query };
      console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}${parsed.search || ""}`);
      const t0 = Date.now();
      res.on("finish", () => console.log(`  → ${res.statusCode} (${Date.now() - t0}ms)`));
      return await resolved.handler(req, res);
    }

    // ملفات ثابتة: / و public/*
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
    const filePath = path.join(PUBLIC, rel);
    if (!filePath.startsWith(PUBLIC) || !fs.existsSync(filePath)) {
      // ملفات اختبار داخل scripts/testmedia تُقدَّم عبر /testmedia/*
      if (rel.startsWith("testmedia/")) {
        const tp = path.join(ROOT, "scripts", rel);
        if (fs.existsSync(tp)) {
          res.writeHead(200, { "Content-Type": "video/mp4" });
          return fs.createReadStream(tp).pipe(res);
        }
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not Found");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error("dev-server error:", e);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message || "خطأ داخلي" }));
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, () => {
  console.log(`video-merger dev server على http://127.0.0.1:${PORT}`);
});
