// GET/POST /api/<أي مسار غير معروف> — رد 404 عربي مفيد بدل صفحة Vercel NOT_FOUND
// يعمل عبر rewrites في vercel.json (تُنفَّذ فقط عندما لا يطابق المسار أي دالة موجودة)
const KNOWN_ENDPOINTS = [
  "POST /api/jobs",
  "POST /api/upload?job=&seq=&chunk=",
  "POST /api/jobs/<id>/process",
  "GET /api/jobs/<id>",
  "GET /api/jobs/<id>/video (?download=1)",
  "DELETE /api/jobs/<id>",
  "GET /api/config",
  "GET /api/cron",
];

module.exports = async (req, res) => {
  res.writeHead(404, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(
    JSON.stringify(
      {
        error: `المسار «${req.url}» غير موجود في خدمة الدمج`,
        hint: "إن كنت تبحث عن نقاط توليد الصور/الفيديو (mcp أو keys أو tasks) فهي في مشروع خادم MCP المنفصل — هذه الخدمة للدمج فقط",
        endpoints: KNOWN_ENDPOINTS,
      },
      null,
      2
    )
  );
};
