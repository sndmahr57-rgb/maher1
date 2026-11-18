// تنزيل مصادر الروابط إلى /tmp مع عدّ بايتات ورفض تجاوز الحد (200MB افتراضيًا)
const fs = require("fs");
const path = require("path");
const { LIMITS } = require("./utils");

async function downloadToFile(url, destPath, maxBytes = LIMITS.sourceMaxBytes) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status})`);
  }
  if (!res.body) throw new Error("استجابة التنزيل بلا جسم");
  const out = fs.createWriteStream(destPath);
  let received = 0;
  const reader = res.body.getReader();
  return new Promise((resolve, reject) => {
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > maxBytes) {
            await reader.cancel().catch(() => {});
            out.destroy();
            try { fs.unlinkSync(destPath); } catch {}
            reject(new Error(`حجم المصدر يتجاوز الحد (${Math.round(maxBytes / 1024 / 1024)}MB)`));
            return;
          }
          if (!out.write(Buffer.from(value))) {
            await new Promise((r) => out.once("drain", r));
          }
        }
        out.end(() => resolve({ bytes: received }));
      } catch (e) {
        reject(e);
      }
    };
    pump();
  });
}

// إعادة تجميع مصدر مرفوع من صفوف Turso إلى ملف في /tmp
async function reassembleSourceChunked(db, jobId, seq, destPath, table) {
  const { Readable } = require("stream");
  const stream = Readable.from(streamBlobRows(table, jobId, seq, db));
  const out = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    stream.pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
    stream.on("error", reject);
  });
  return { bytes: fs.statSync(destPath).size };
}

// مولّد يقرأ صفوف Blobs صفحة صفحة — يستقبل عميل db صراحةً
async function* streamBlobRows(table, jobId, seq, db) {
  const PAGE = 8;
  let page = 0;
  while (true) {
    const sql =
      table === "source_chunks"
        ? `SELECT data FROM source_chunks WHERE job_id = ? AND seq = ? ORDER BY chunk_index ASC LIMIT ${PAGE} OFFSET ${page * PAGE}`
        : `SELECT data FROM output_chunks WHERE job_id = ? ORDER BY chunk_index ASC LIMIT ${PAGE} OFFSET ${page * PAGE}`;
    const r = await db.execute({ sql, args: [jobId, ...(table === "source_chunks" ? [seq] : [])] });
    if (!r.rows.length) return;
    for (const row of r.rows) yield require("./storage").toBuf(row.data);
    page++;
  }
}

function tmpFile(name) {
  // أدخل اللاحقة العشوائية قبل الامتداد كي يتعرف ffmpeg على صيغة المخرج
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const rand = Math.random().toString(36).slice(2, 10);
  return path.join("/tmp", `vm_${stem}_${rand}${ext || ""}`);
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch {}
}

module.exports = { downloadToFile, reassembleSourceChunked, tmpFile, safeUnlink };
