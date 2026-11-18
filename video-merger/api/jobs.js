// POST /api/jobs — إنشاء مهمة دمج (روابط مباشرة أو مصادر ملفات مرفوعة)
const { LIMITS, newId, json, apiError, readRawBody, isPublicHttpUrl, expiresAtIso, baseUrlOf } = require("../lib/utils");
const dbmod = require("../lib/db");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "POST") return apiError(res, 405, "طريقة الطلب غير مدعومة — استخدم POST");

  let body;
  try {
    const raw = await readRawBody(req, 1024 * 1024);
    body = JSON.parse(raw.toString("utf8") || "{}");
  } catch (e) {
    if (e && e.code === 413) return apiError(res, 413, "جسم الطلب كبير جدًا");
    return apiError(res, 400, "JSON تالف — أرسل جسمًا صحيحًا بصيغة JSON");
  }

  // الشكلان المقبولان: {"videos":[...]} أو {"sources":[{kind:"url"|"file",...}]}
  let sources;
  if (Array.isArray(body.videos)) {
    sources = body.videos.map((u) => ({ kind: "url", url: u }));
  } else if (Array.isArray(body.sources)) {
    sources = body.sources.map((s) => ({
      kind: s.kind === "file" ? "file" : "url",
      url: s.url,
      name: s.name,
      size: s.size,
      mime: s.mime,
    }));
  } else {
    return apiError(res, 400, 'أرسل {"videos":[...]} أو {"sources":[...]}');
  }

  if (sources.length < 2) {
    return apiError(res, 400, "الدمج يحتاج مقطعين على الأقل");
  }
  if (sources.length > LIMITS.maxSources) {
    return apiError(res, 400, `أقصى عدد مقاطع للدمج هو ${LIMITS.maxSources}`);
  }
  for (const s of sources) {
    if (s.kind === "url") {
      if (!s.url || !isPublicHttpUrl(s.url)) {
        return apiError(res, 400, "كل المصادر يجب أن تكون روابط http/https مباشرة وعامة");
      }
    } else if (s.kind === "file") {
      if (s.size != null && s.size > LIMITS.sourceMaxBytes) {
        return apiError(res, 413, `حجم الملف يتجاوز الحد (${Math.round(LIMITS.sourceMaxBytes / 1024 / 1024)}MB)`);
      }
    }
  }

  // تنظيف كسول للمهام المنتهية عند كل إنشاء
  await dbmod.cleanupExpired().catch(() => {});

  const id = newId("j");
  const job = {
    id,
    status: sources.some((s) => s.kind === "file") ? "uploading" : "queued",
    sources: sources.map((s, seq) => ({ seq, ...s })),
    expiresAt: expiresAtIso(),
  };
  await dbmod.createJob(job);

  const base = baseUrlOf(req);
  const dto = {
    jobId: id,
    status: job.status,
    statusUrl: `${base}/api/jobs/${id}`,
    processUrl: `${base}/api/jobs/${id}/process`,
    expiresAt: job.expiresAt,
  };
  if (job.status === "uploading") {
    // روابط الرفع لملفات المصادر فقط (المصادر الرابطية لا تحتاج رفعًا)
    dto.uploads = job.sources
      .filter((s) => s.kind === "file")
      .map((s) => ({
        seq: s.seq,
        name: s.name || null,
        uploadUrl: `${base}/api/upload?job=${id}&seq=${s.seq}&chunk=<n>`,
        uploadChunkBytes: LIMITS.uploadChunkBytes,
      }));
  }
  return json(res, 201, dto);
};
