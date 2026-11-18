// GET /api/config — الحدود العامة + version (تُستخدم لفحص جهوزية الخدمة من السيرفر الرئيسي)
const { LIMITS, json } = require("../lib/utils");
const { ensureSchema } = require("../lib/db");

module.exports = async (req, res) => {
  let dbOk = true;
  try {
    await ensureSchema();
  } catch {
    dbOk = false;
  }
  return json(res, 200, {
    ok: true,
    db: dbOk ? "turso-connected" : "turso-unavailable",
    version: "1.0.0",
    maxSources: LIMITS.maxSources,
    sourceMaxMB: Math.round(LIMITS.sourceMaxBytes / 1024 / 1024),
    outputMaxMB: Math.round(LIMITS.outputMaxBytes / 1024 / 1024),
    maxTotalDurationSec: LIMITS.maxTotalDurationSec,
    uploadChunkBytes: LIMITS.uploadChunkBytes,
    retentionHours: LIMITS.retentionHours,
    output: { format: "mp4 (H.264 + AAC)", quality: "CRF 18", note: "المخرج ثابت — لا توجد معاملات resolution/fps" },
  });
};
