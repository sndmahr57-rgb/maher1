// نظام المفاتيح المتسلسلة: ترتيب إضافة صارم (created_at ASC, id ASC) — ليس round-robin
// + تصنيف موحد لأخطاء المزودين (قسم 4.2 في المواصفة)
import { getDb, ensureSchema, safeParseJson } from "./turso";

export interface KeyRow {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  api_key: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

// إخفاء المفتاح إلزاميًا في كل الاستجابات والسجلات — لا يُعاد المفتاح الكامل أبدًا
export function maskKey(key: string): string {
  if (key.length > 11) {
    return key.slice(0, 7) + "••••••••" + key.slice(-4);
  }
  return key.slice(0, 3) + "••••";
}

// تجلب كل المفاتيح غير المعطّلة لهذه المزودات بترتيب الإضافة بالضبط
// المفتاح exhausted يبقى في القائمة (يُستثنى فقط disabled اليدوي)
export async function getKeyPool(providers: string[]): Promise<KeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const r = await getDb().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return r.rows as unknown as KeyRow[];
}

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

// تصنيف موحد لأي خطأ مزود — الترتيب مقصود: نفاد الرصيد قبل 400 لأن بعض المزودين
// يرسلونه بحالة 400 برسالة رصيد
export function classifyProviderError(status: number, message: string): ErrorClass {
  const msg = String(message || "").toLowerCase();
  if (
    status === 402 ||
    /insufficient|quota|balance|credit|out of credits|exhausted|充值|رصيد/.test(msg)
  ) {
    return "exhausted";
  }
  if (
    status === 401 ||
    status === 403 ||
    /invalid api key|unauthorized|forbidden|authentication|invalid_token|token invalid/.test(msg)
  ) {
    return "disabled";
  }
  if (
    [400, 404, 422].includes(status) &&
    /model not found|unsupported model|invalid model|no such model/.test(msg)
  ) {
    return "provider";
  }
  if (status === 400 || status === 422) {
    return "params";
  }
  // 429 و5xx وانقطاع الشبكة (status=0) مؤقتة
  return "temporary";
}

// هل رسالة فشل منتصف المهمة تُشير لمشكلة مفتاح/رصيد (تبديل صامت) أم فشل حتمي؟
export function isKeyOrBalanceFailure(message: string): boolean {
  const msg = String(message || "").toLowerCase();
  return /insufficient|balance|credit|quota|402|401|unauthorized|forbidden|invalid api key|exhausted/.test(msg);
}

// تحديث عدّادات المفتاح — تُحدَّث دائمًا بعد كل محاولة
// النجاح يعيد المفتاح المستنزف سابقًا إلى active (يظل في القاعدة والقائمة بكل الأحوال)
export async function bumpKeyStats(
  keyId: string,
  outcome: { ok: boolean; error?: string; newStatus?: "exhausted" | "disabled" }
): Promise<void> {
  const sets = ["usage_count = usage_count + 1", "last_used_at = datetime('now')", "last_checked_at = datetime('now')"];
  const args: (string | number)[] = [];
  if (outcome.ok) {
    sets.push("success_count = success_count + 1", "last_error = NULL", "status = 'active'");
  } else {
    sets.push("fail_count = fail_count + 1");
    if (outcome.error) {
      sets.push("last_error = ?");
      args.push(String(outcome.error).slice(0, 500));
    }
  }
  if (outcome.newStatus) {
    sets.push("status = ?");
    args.push(outcome.newStatus);
  }
  args.push(keyId);
  await getDb().execute({ sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args });
}

// ===== عمليات إدارة المفاتيح للواجهة =====
export async function listKeys(): Promise<Omit<KeyRow, "api_key">[]> {
  await ensureSchema();
  const r = await getDb().execute({ sql: `SELECT * FROM api_keys ORDER BY created_at ASC, id ASC`, args: [] });
  const rows = r.rows as unknown as KeyRow[];
  // إخفاء المفاتيح دائمًا — الحقل الكامل لا يترك الطبقة هذه أبدًا
  return rows.map(({ api_key, ...rest }) => ({ ...rest, api_key: maskKey(api_key) }));
}

export async function addKey(provider: "kie" | "cometapi", apiKey: string, label: string): Promise<{ id: string }> {
  await ensureSchema();
  // رفض التكرار لنفس المزود: نفس نص المفتاح لا يُضاف مرتين
  const dup = await getDb().execute({
    sql: `SELECT id FROM api_keys WHERE provider = ? AND api_key = ?`,
    args: [provider, apiKey],
  });
  if (dup.rows.length) {
    throw new Error("هذا المفتاح مضاف مسبقًا لنفس المزود");
  }
  const id = crypto.randomUUID();
  await getDb().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [id, provider, label || "", apiKey],
  });
  return { id };
}

export async function setKeyStatus(id: string, status: "active" | "exhausted" | "disabled"): Promise<void> {
  await getDb().execute({ sql: `UPDATE api_keys SET status = ?, last_error = NULL WHERE id = ?`, args: [status, id] });
}

export async function deleteKey(id: string): Promise<void> {
  await getDb().execute({ sql: `DELETE FROM api_keys WHERE id = ?`, args: [id] });
}

export { safeParseJson };
