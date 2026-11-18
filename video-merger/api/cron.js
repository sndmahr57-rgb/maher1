// GET /api/cron — حذف المهام المنتهية (مجدولة يوميًا عبر vercel.json)
const { json, apiError } = require("../lib/utils");
const dbmod = require("../lib/db");

module.exports = async (req, res) => {
  if (req.method !== "GET") return apiError(res, 405, "طريقة الطلب غير مدعومة");
  try {
    const removed = await dbmod.cleanupExpired();
    return json(res, 200, { ok: true, removed });
  } catch (e) {
    return apiError(res, 500, e.message || "فشل التنظيف");
  }
};
