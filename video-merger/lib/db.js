// طبقة قاعدة البيانات: Turso (libSQL) عبر HTTP — متوافقة مع بيئة Vercel السيرفركس
const { createClient } = require("@libsql/client");
const { loadEnv } = require("./env");
loadEnv();

let client = null;
let schemaPromise = null;

function db() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة");
    }
    client = createClient({ url, authToken: token });
  }
  return client;
}

async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const c = db();
      // المخطط كله عبر CREATE TABLE IF NOT EXISTS فلا حاجة لأداة migrations
      await c.batch(
        [
          `CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'queued',
            progress INTEGER NOT NULL DEFAULT 0,
            sources_json TEXT NOT NULL DEFAULT '[]',
            error TEXT,
            output_size INTEGER,
            output_duration REAL,
            output_resolution TEXT,
            video_url TEXT,
            download_url TEXT,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )`,
          `CREATE TABLE IF NOT EXISTS sources (
            job_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            kind TEXT NOT NULL,
            url TEXT,
            name TEXT,
            mime TEXT,
            size INTEGER,
            bytes_received INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (job_id, seq)
          )`,
          // كل Blob يُقسَّم لصفوف 2MB (الحد الآمن لحجم طلب HTTP في Turso)
          `CREATE TABLE IF NOT EXISTS source_chunks (
            job_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            data BLOB NOT NULL,
            PRIMARY KEY (job_id, seq, chunk_index)
          )`,
          `CREATE TABLE IF NOT EXISTS output_chunks (
            job_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            data BLOB NOT NULL,
            PRIMARY KEY (job_id, chunk_index)
          )`,
        ],
        "write"
      );
    })().catch((e) => {
      schemaPromise = null; // اسمح بإعادة المحاولة في الطلب التالي
      throw e;
    });
  }
  return schemaPromise;
}

async function createJob(job) {
  await ensureSchema();
  await db().batch(
    [
      {
        sql: `INSERT INTO jobs (id, status, progress, expires_at) VALUES (?, ?, 0, ?)`,
        args: [job.id, job.status, job.expiresAt],
      },
      ...job.sources.map(
        (s) =>
          ({
            sql: `INSERT INTO sources (job_id, seq, kind, url, name, mime, size) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [job.id, s.seq, s.kind, s.url || null, s.name || null, s.mime || null, s.size ?? null],
          })
      ),
    ],
    "write"
  );
}

async function getJob(id) {
  await ensureSchema();
  const r = await db().execute({ sql: `SELECT * FROM jobs WHERE id = ?`, args: [id] });
  return r.rows[0] || null;
}

async function getSources(jobId) {
  const r = await db().execute({ sql: `SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC`, args: [jobId] });
  return r.rows.map((row) => ({
    seq: Number(row.seq),
    kind: row.kind,
    url: row.url || null,
    name: row.name || null,
    mime: row.mime || null,
    size: row.size == null ? null : Number(row.size),
    bytesReceived: Number(row.bytes_received || 0),
  }));
}

// patch جزئي للمهمة — يضبط updated_at تلقائيًا
async function updateJob(id, patch) {
  const sets = [];
  const args = [];
  const allowed = ["status", "progress", "error", "output_size", "output_duration", "output_resolution", "video_url", "download_url"];
  for (const k of allowed) {
    if (k in patch) {
      sets.push(`${k} = ?`);
      args.push(patch[k]);
    }
  }
  if (!sets.length) return;
  sets.push(`updated_at = datetime('now')`);
  args.push(id);
  await db().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

async function appendSourceChunk(jobId, seq, index, buf) {
  await ensureSchema();
  // يُقسَّم كل جزء مرفوع إلى صفوف 2MB داخل Turso
  const rows = [];
  for (let off = 0; off < buf.length; off += 2 * 1024 * 1024) {
    const slice = buf.subarray(off, Math.min(off + 2 * 1024 * 1024, buf.length));
    rows.push({ sql: `INSERT INTO source_chunks (job_id, seq, chunk_index, data) VALUES (?, ?, ?, ?)`, args: [jobId, seq, index, slice] });
  }
  await db().batch(rows, "write");
  // حساب البايتات المستلمة: عدد الصفوف الكلي × حجمها (أدق من عدّاد ذاكرة)
  const r = await db().execute({
    sql: `SELECT COALESCE(SUM(length(data)), 0) AS total FROM source_chunks WHERE job_id = ? AND seq = ?`,
    args: [jobId, seq],
  });
  const total = Number(r.rows[0].total || 0);
  await db().execute({ sql: `UPDATE sources SET bytes_received = ? WHERE job_id = ? AND seq = ?`, args: [total, jobId, seq] });
  return total;
}

// حذف شامل لكل صفوف المهمة في دفعة واحدة
async function deleteJobRows(id) {
  await ensureSchema();
  await db().batch(
    [
      { sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM sources WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM jobs WHERE id = ?`, args: [id] },
    ],
    "write"
  );
}

// تنظيف كسول للمهام المنتهية (24 ساعة) — يُستدعى عند الإنشاء/الدمج وعبر /api/cron
async function cleanupExpired() {
  await ensureSchema();
  const now = new Date().toISOString();
  const r = await db().execute({ sql: `SELECT id FROM jobs WHERE expires_at < ?`, args: [now] });
  for (const row of r.rows) await deleteJobRows(row.id);
  return r.rows.length;
}

async function countActiveJobs() {
  await ensureSchema();
  const r = await db().execute({ sql: `SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','uploading','processing')`, args: [] });
  return Number(r.rows[0].n);
}

module.exports = { db, ensureSchema, createJob, getJob, getSources, updateJob, appendSourceChunk, deleteJobRows, cleanupExpired, countActiveJobs };
