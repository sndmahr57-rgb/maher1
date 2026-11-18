// GET /api/jobs/{id} — الحالة والتقدم | DELETE — حذف فوري شامل
const { json, apiError, baseUrlOf } = require("../../lib/utils");
const dbmod = require("../../lib/db");
const { jobDto } = require("../../lib/process");

// تحليل دفاعي للحالة — قيم متعددة متوقعة من الخدمة
function normalizeStatus(s) {
  const v = String(s || "").toLowerCase();
  if (["done", "completed", "complete", "success", "succeeded", "finished"].includes(v)) return "done";
  if (["error", "failed", "failure", "cancelled", "canceled"].includes(v)) return "failed";
  if (["queued", "uploading", "processing"].includes(v)) return v;
  return v || "queued";
}

module.exports = async (req, res) => {
  const id = req.query.id;
  if (!id) return apiError(res, 400, "معرّف المهمة مطلوب");

  if (req.method === "GET") {
    const row = await dbmod.getJob(id);
    if (!row) return apiError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
    const dto = jobDto(row, baseUrlOf(req));
    dto.status = normalizeStatus(row.status);
    // progress يأتي أحيانًا كسرًا 0..1 — اضربه في 100
    let p = Number(row.progress || 0);
    if (p > 0 && p < 1) p = Math.round(p * 100);
    dto.progress = p;
    return json(res, 200, dto);
  }

  if (req.method === "DELETE") {
    const row = await dbmod.getJob(id);
    if (!row) return apiError(res, 404, "المهمة غير موجودة");
    await dbmod.deleteJobRows(id);
    return json(res, 200, { deleted: true, jobId: id });
  }

  return apiError(res, 405, "طريقة الطلب غير مدعومة");
};
