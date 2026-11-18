// أدوات عامة: حدود الخدمة، توليد المعرّفات، بناء استجابات JSON، فحص الروابط
const { loadEnv } = require("./env");
loadEnv();

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const LIMITS = {
  maxSources: intEnv("MAX_SOURCES", 10),
  sourceMaxBytes: intEnv("SOURCE_MAX_MB", 200) * 1024 * 1024,
  outputMaxBytes: intEnv("OUTPUT_MAX_MB", 150) * 1024 * 1024,
  maxTotalDurationSec: intEnv("MAX_TOTAL_DURATION_SEC", 600),
  uploadChunkBytes: 4 * 1024 * 1024, // أقل من حد 4.5MB لجسم الطلب في Vercel
  chunkRowsBytes: 2 * 1024 * 1024,   // تقسيم صفوف Blobs في Turso (حد آمن عبر HTTP)
  retentionHours: 24,
};

function newId(prefix = "") {
  const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return prefix + rand;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  });
  res.end(body);
}

function apiError(res, status, message) {
  json(res, status, { error: message });
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error("BODY_TOO_LARGE"), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isPublicHttpUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function expiresAtIso() {
  return new Date(Date.now() + LIMITS.retentionHours * 3600 * 1000).toISOString();
}

// يعيد عنوان القاعدة العام للطلب الحالي لبناء روابط النتائج
function baseUrlOf(req) {
  const proto = (req.headers["x-forwarded-proto"] || "http").toString().split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "localhost:4000").toString().split(",")[0].trim();
  return `${proto}://${host}`;
}

module.exports = { LIMITS, newId, json, apiError, readRawBody, isPublicHttpUrl, expiresAtIso, baseUrlOf };
