// POST /api/jobs/{id}/process — تنفيذ الدمج كاملًا (متزامن) وإرجاع النتيجة مباشرة
const { json, apiError, baseUrlOf } = require("../../../lib/utils");
const { runProcess } = require("../../../lib/process");

module.exports = async (req, res) => {
  if (req.method !== "POST") return apiError(res, 405, "طريقة الطلب غير مدعومة — استخدم POST");
  const id = req.query.id;
  if (!id) return apiError(res, 400, "معرّف المهمة مطلوب");

  const result = await runProcess(id, baseUrlOf(req));
  if (result.notFound) return apiError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
  if (result.inFlight) return json(res, 202, { status: "processing", message: "المهمة قيد المعالجة حاليًا" });
  if (result.failed) return apiError(res, 500, result.failed);
  return json(res, 200, result.job);
};
