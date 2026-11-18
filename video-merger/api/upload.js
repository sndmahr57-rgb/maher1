// POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء ثنائية ≤4MB (octet-stream) مع إعادة تجميعها كصفوف 2MB في Turso
const { LIMITS, apiError, json, readRawBody } = require("../lib/utils");
const dbmod = require("../lib/db");

module.exports = async (req, res) => {
  if (req.method !== "POST") return apiError(res, 405, "طريقة الطلب غير مدعومة — استخدم POST");
  const jobId = req.query.job;
  const seq = parseInt(req.query.seq, 10);
  const chunkIndex = parseInt(req.query.chunk, 10);
  if (!jobId || !Number.isFinite(seq) || !Number.isFinite(chunkIndex)) {
    return apiError(res, 400, "المعاملات job و seq و chunk مطلوبة");
  }

  const job = await dbmod.getJob(jobId);
  if (!job) return apiError(res, 404, "المهمة غير موجودة");
  if (["processing", "done"].includes(job.status)) {
    return apiError(res, 409, "لا يمكن الرفع بعد بدء المعالجة أو اكتمالها");
  }

  let buf;
  try {
    buf = await readRawBody(req, LIMITS.uploadChunkBytes + 512 * 1024);
  } catch (e) {
    return apiError(res, 413, "حجم الجزء يتجاوز الحد المسموح (4MB)");
  }
  if (!buf.length) return apiError(res, 400, "جسم الطلب فارغ");

  const sources = await dbmod.getSources(jobId);
  const src = sources.find((s) => s.seq === seq);
  if (!src) return apiError(res, 404, "المصدر غير موجود في هذه المهمة");
  if (src.kind !== "file") return apiError(res, 400, "هذا المصدر رابط مباشر — لا يحتاج رفعًا");

  const total = await dbmod.appendSourceChunk(jobId, seq, chunkIndex, buf);
  // رفض تجاوز الحجم المعلن للملف (إن وُجد)
  if (src.size != null && total > src.size + 64 * 1024) {
    return apiError(res, 413, "تجاوزت البايتات المرفوعة الحجم المعلن للملف");
  }
  if (job.status === "queued") await dbmod.updateJob(jobId, { status: "uploading" });

  return json(res, 200, {
    ok: true,
    jobId,
    seq,
    chunk: chunkIndex,
    bytesReceived: total,
    size: src.size,
    complete: src.size != null ? total >= src.size : undefined,
  });
};
