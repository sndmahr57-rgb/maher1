// طبقة Turso: عميل واحد عبر HTTP (متوافق مع Vercel serverless) + مخطط يُنشأ تلقائيًا عند أول وصول
import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;
let schemaPromise: Promise<void> | null = null;

export function getDb(): Client {
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

export async function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const c = getDb();
      await c.batch(
        [
          `CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            provider TEXT,
            provider_task_id TEXT,
            key_id TEXT,
            model TEXT NOT NULL,
            type TEXT NOT NULL,
            prompt TEXT DEFAULT '',
            params_json TEXT DEFAULT '{}',
            status TEXT NOT NULL,
            progress INTEGER DEFAULT 0,
            result_urls_json TEXT,
            error_message TEXT,
            attempts_json TEXT DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            completed_at TEXT
          )`,
          `CREATE TABLE IF NOT EXISTS api_keys (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            label TEXT DEFAULT '',
            api_key TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            usage_count INTEGER DEFAULT 0,
            success_count INTEGER DEFAULT 0,
            fail_count INTEGER DEFAULT 0,
            last_used_at TEXT,
            last_checked_at TEXT,
            last_error TEXT,
            created_at TEXT DEFAULT (datetime('now'))
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

export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    const r = await getDb().execute("SELECT 1");
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

// ===== أنواع المهام =====
export type TaskType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type ProviderId = "kie" | "cometapi";

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: TaskType;
  prompt: string;
  params_json: string;
  status: TaskStatus;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskAttempt {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

// تسجيل مهمة جديدة قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
export async function insertTask(t: {
  id: string;
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  model: string;
  type: TaskType;
  prompt?: string;
  params_json?: string;
  status: TaskStatus;
}): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [t.id, t.provider ?? null, t.provider_task_id ?? null, t.key_id ?? null, t.model, t.type, t.prompt ?? "", t.params_json ?? "{}", t.status],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await getDb().execute({ sql: `SELECT * FROM tasks WHERE id = ?`, args: [id] });
  return (r.rows[0] as unknown as TaskRow) || null;
}

// patch جزئي — يضيف محاولة إلى attempts ويضبط completed_at عند الاكتمال تلقائيًا
export async function updateTask(
  id: string,
  patch: Partial<{
    provider: string;
    provider_task_id: string;
    key_id: string;
    status: TaskStatus;
    progress: number;
    result_urls_json: string | null;
    error_message: string | null;
    newAttempt: TaskAttempt;
    params_json: string;
  }>
): Promise<void> {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.provider_task_id !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.provider_task_id); }
  if (patch.key_id !== undefined) { sets.push("key_id = ?"); args.push(patch.key_id); }
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(patch.progress); }
  if (patch.result_urls_json !== undefined) { sets.push("result_urls_json = ?"); args.push(patch.result_urls_json); }
  if (patch.error_message !== undefined) { sets.push("error_message = ?"); args.push(patch.error_message); }
  if (patch.params_json !== undefined) { sets.push("params_json = ?"); args.push(patch.params_json); }

  if (patch.newAttempt) {
    const task = await getTask(id);
    const attempts: TaskAttempt[] = task ? safeParseJson(task.attempts_json, []) : [];
    attempts.push(patch.newAttempt);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(attempts).slice(0, 40000));
  }
  if (!sets.length) return;
  if (patch.status === "completed") {
    sets.push("completed_at = datetime('now')");
  }
  sets.push("updated_at = datetime('now')");
  args.push(id);
  await getDb().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function listRecentTasks(
  limit = 20,
  filter?: { type?: TaskType; status?: TaskStatus }
): Promise<TaskRow[]> {
  await ensureSchema();
  const conds: string[] = [];
  const args: string[] = [];
  if (filter?.type) { conds.push("type = ?"); args.push(filter.type); }
  if (filter?.status) { conds.push("status = ?"); args.push(filter.status); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  args.push(String(limit));
  const r = await getDb().execute({
    sql: `SELECT * FROM tasks ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    args,
  });
  return r.rows as unknown as TaskRow[];
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const r = await getDb().execute(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  const row = r.rows[0] as unknown as Record<string, number | null>;
  return {
    total: Number(row.total || 0),
    completed: Number(row.completed || 0),
    failed: Number(row.failed || 0),
    processing: Number(row.processing || 0),
  };
}

export function safeParseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
