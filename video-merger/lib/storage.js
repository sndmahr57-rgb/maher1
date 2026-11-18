// تخزين Blobs مُقسَّم في Turso + بث الناتج مع دعم Range (206) للمشغل
const { db, ensureSchema } = require("./db");

const ROW_BYTES = 2 * 1024 * 1024; // صف Turso ≤ 2MB
const PAGE_ROWS = 8;               // قراءة تدفُّقية 8 صفوف لكل استعلام (16MB)

// عميل libsql قد يعيد BLOB كـ ArrayBuffer أو Uint8Array أو نص base64 — نوحّد إلى Buffer
function toBuf(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof ArrayBuffer) return Buffer.from(new Uint8Array(v));
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === "string") return Buffer.from(v, "base64");
  return Buffer.from(v);
}

async function writeOutputBlob(jobId, buffer) {
  await ensureSchema();
  const rows = [];
  for (let i = 0, off = 0; off < buffer.length; i++, off += ROW_BYTES) {
    rows.push({ sql: `INSERT INTO output_chunks (job_id, chunk_index, data) VALUES (?, ?, ?)`, args: [jobId, i, buffer.subarray(off, Math.min(off + ROW_BYTES, buffer.length))] });
  }
  if (!rows.length) return;
  await db().batch(rows, "write");
}

async function deleteSourceChunks(jobId) {
  await db().execute({ sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [jobId] });
}

async function outputBlobSize(jobId) {
  const r = await db().execute({ sql: `SELECT COALESCE(SUM(length(data)), 0) AS n FROM output_chunks WHERE job_id = ?`, args: [jobId] });
  return Number(r.rows[0].n || 0);
}

// قراءة مجال بايتات محدد [start..end] من الـ Blob المُقسَّم
async function readRangeBytes(table, jobId, start, end) {
  const idCol = table === "output_chunks" ? "chunk_index" : "chunk_index";
  const sql = `SELECT chunk_index, data FROM ${table} WHERE job_id = ? ORDER BY ${idCol} ASC`;
  const r = await db().execute({ sql, args: [jobId] });
  let out = [];
  let offset = 0;
  for (const row of r.rows) {
    const data = toBuf(row.data);
    const len = data.length;
    const rowStart = offset;
    const rowEnd = offset + len - 1;
    offset += len;
    if (rowEnd < start) continue;
    if (rowStart > end) break;
    const s = Math.max(0, start - rowStart);
    const e = Math.min(len - 1, end - rowStart);
    out.push(Buffer.from(data.subarray(s, e + 1)));
    if (offset > end) break;
  }
  return Buffer.concat(out);
}

// بث الناتج عبر Readable يسحب صفوف Turso تدفقيًا (صفحات من 8 صفوف) مع تقليم أول/آخر جزء حسب المدى
function streamOutputRange(table, jobId, start, end) {
  const { Readable } = require("stream");
  let cursor = start;
  let nextPage = 0;
  let currentPage = null; // {rows, idx}
  let done = false;
  const rowStartsCache = []; // لا نحتاجها — نحسب أثناء السير

  const fetchPage = async (page) => {
    const r = await db().execute({
      sql: `SELECT chunk_index, data FROM ${table} WHERE job_id = ? ORDER BY chunk_index ASC LIMIT ${PAGE_ROWS} OFFSET ?`,
      args: [jobId, page * PAGE_ROWS],
    });
    return r.rows.map((row) => toBuf(row.data));
  };

  return new Readable({
    async read(_size) {
      try {
        while (!done) {
          if (!currentPage) {
            currentPage = { rows: await fetchPage(nextPage++), idx: 0, rowStartOffset: 0 };
            if (currentPage.rows.length === 0) {
              done = true;
              this.push(null);
              return;
            }
          }
          while (currentPage.idx < currentPage.rows.length) {
            const buf = currentPage.rows[currentPage.idx];
            const rowStart = currentPage.rowStartOffset;
            const rowEnd = rowStart + buf.length - 1;
            if (rowEnd < cursor) {
              currentPage.idx++;
              currentPage.rowStartOffset = rowEnd + 1;
              continue;
            }
            if (rowStart > cursor) {
              cursor = rowStart; // فجوة غير متوقعة — انتقل للأمان
            }
            const s = cursor - rowStart;
            const take = Math.min(buf.length - s, end - cursor + 1);
            if (take <= 0) {
              done = true;
              this.push(null);
              return;
            }
            const piece = buf.subarray(s, s + take);
            cursor += take;
            currentPage.idx++;
            currentPage.rowStartOffset = rowEnd + 1;
            if (cursor > end) {
              done = true;
              this.push(Buffer.from(piece));
              this.push(null); // إلزامي: إنهاء التدفق كي تُكمل استجابة HTTP وتتحرر قناة keep-alive
              return;
            }
            if (!this.push(Buffer.from(piece))) {
              return; // Backpressure — سيُستدعى read لاحقًا
            }
          }
          currentPage = null;
        }
      } catch (e) {
        this.destroy(e);
      }
    },
  });
}

module.exports = { writeOutputBlob, deleteSourceChunks, outputBlobSize, readRangeBytes, streamOutputRange, toBuf, ROW_BYTES, PAGE_ROWS };
