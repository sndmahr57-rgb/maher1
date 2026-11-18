// عميل خدمة دمج الفيديو v2 — بلا مفاتيح أو توثيق، روابط فقط (لا ملفات تُنزَّل لنا)
// قواعد حتمية: أي HTTP 4xx/5xx معلن = فشل نهائي فوري؛ أخطاء شبكتنا = مؤقتة تُستمر
import { insertTask, getTask, updateTask, safeParseJson, type TaskRow } from "./turso";

const MERGER_BASE = (process.env.MERGER_API_BASE || "https://xxxxxxxx").replace(/\/+$/, "");

// قفل الذاكرة حتى لا يتزامن POST .../process مع get_task
const processInFlight = new Set<string>();

export function mergerBase(): string {
  return MERGER_BASE;
}

async function mergerFetch(path: string, init?: RequestInit, timeoutMs = 300_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${MERGER_BASE}${path}`, init ? { ...init, signal: controller.signal } : { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// إنشاء مهمة دمج في الخدمة
export async function createMergeJob(urls: string[]): Promise<{ jobId: string; expiresAt?: string }> {
  let res: Response;
  try {
    res = await mergerFetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: urls }),
    });
  } catch (e) {
    throw new Error(`network: ${(e as Error).message}`);
  }
  const body = await res.json().catch(() => null) as { jobId?: string; error?: string; expiresAt?: string } | null;
  if (!res.ok || !body?.jobId) {
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  return { jobId: body.jobId, expiresAt: body.expiresAt };
}

// تنفيذ الدمج (blocking ~10–15 ثانية)
export async function processMergeJob(jobId: string): Promise<{ done: boolean; result?: MergeResult; error?: string; processing?: boolean }> {
  if (processInFlight.has(jobId)) return { done: false, processing: true };
  processInFlight.add(jobId);
  try {
    const res = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" }, 290_000);
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (res.status === 202) return { done: false, processing: true };
    if (!res.ok) {
      // خطأ معلن من الخدمة = فشل حتمي نهائي (لا إعادة محاولة)
      return { done: false, error: (body?.error as string) || `HTTP ${res.status}` };
    }
    return { done: true, result: normalizeMergeResult(body, jobId) };
  } catch (e) {
    // أخطاء شبكتنا نحن (timeout/abort) — مؤقتة
    return { done: false, error: `network: ${(e as Error).message}` };
  } finally {
    processInFlight.delete(jobId);
  }
}

export interface MergeResult {
  status: "done" | "queued" | "failed";
  progress: number;
  videoUrl?: string;
  downloadUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  expiresAt?: string;
  error?: string;
}

// تحليل دفاعي لحالة المهمة — الأشكال الحقيقية المقاسة للخدمة
function normalizeMergeResult(body: Record<string, unknown> | null, jobId: string): MergeResult {
  if (!body) return { status: "failed", progress: 0, error: "استجابة غير قابلة للتحليل" };
  const rawStatus = String(body.status || "").toLowerCase();
  let status: MergeResult["status"] = "queued";
  if (["done", "completed", "complete", "success", "succeeded", "finished"].includes(rawStatus)) status = "done";
  else if (["error", "failed", "failure", "cancelled"].includes(rawStatus)) status = "failed";
  // قد يرد الجسم فيه error بلا status → فشل فوري
  if (body.error && !body.status) status = "failed";

  let progress = Number(body.progress ?? 0);
  if (progress > 0 && progress < 1) progress = Math.round(progress * 100); // يأتي أحيانًا كسرًا 0..1

  const base = MERGER_BASE;
  let videoUrl = (body.videoUrl as string) || undefined;
  const downloadUrl = (body.downloadUrl as string) || (videoUrl ? `${videoUrl}${videoUrl.includes("?") ? "&" : "?"}download=1` : undefined);
  // رابط النتيجة الافتراضي إن غاب videoUrl وdownloadUrl وبقي jobId
  if (!videoUrl && !downloadUrl && jobId) {
    videoUrl = `${base}/api/jobs/${encodeURIComponent(jobId)}/video`;
  }
  return {
    status,
    progress,
    videoUrl,
    downloadUrl,
    size: body.size == null ? undefined : Number(body.size),
    duration: body.duration == null ? undefined : Number(body.duration),
    resolution: (body.resolution as string) || undefined,
    expiresAt: (body.expiresAt as string) || undefined,
    error: (body.error as string) || undefined,
  };
}

// استعلام حالة مهمة الدمج
export async function getMergeStatus(jobId: string): Promise<MergeResult & { notFound?: boolean }> {
  let res: Response;
  try {
    res = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, undefined, 20_000);
  } catch (e) {
    // خطأ شبكتنا — مؤقت: نستمر بالاستعلام
    return { status: "queued", progress: 0, error: `network: ${(e as Error).message}` };
  }
  if (res.status === 404) {
    // حُذفت أو انتهت صلاحيتها بعد 24 ساعة — فشل نهائي
    return { status: "failed", progress: 0, notFound: true, error: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" };
  }
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  return normalizeMergeResult(body, jobId);
}

export async function deleteMergeJob(jobId: string): Promise<void> {
  try {
    await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }, 15_000);
  } catch {
    // التنظيف اختياري — نتجاهل الأخطاء
  }
}

// هل الخدمة صحية؟ (فحص GET /api/config بمهلة 4 ثوانٍ)
export async function mergerHealthy(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${MERGER_BASE}/api/config`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ===== تدفق runMerge وقواعده (قسم 7.3) =====
export async function runMerge(
  taskId: string,
  urls: string[],
  waitSeconds: number,
  onProgress?: (task: TaskRow, message: string) => void
): Promise<TaskRow> {
  // سجّل مهمة type="merge", provider="merger", model="video-merger" في Turso أولًا
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: urls.join("\n"),
    params_json: JSON.stringify({ urls, processTriggered: false }),
    status: "processing",
  });

  let jobId: string | undefined;
  try {
    const created = await createMergeJob(urls);
    jobId = created.jobId;
    await updateTask(taskId, { provider_task_id: jobId, error_message: null });
  } catch (e) {
    // خطأ HTTP معلن من الخدمة = فشل نهائي فوري — لا إعادة محاولة
    const msg = (e as Error).message || "";
    if (msg.startsWith("network:")) {
      await updateTask(taskId, { error_message: "بانتظار توفر خدمة الدمج… " + msg.slice(0, 200) });
      return (await getTask(taskId)) || ({} as TaskRow);
    }
    await updateTask(taskId, { status: "failed", error_message: msg.slice(0, 400) });
    return (await getTask(taskId)) || ({} as TaskRow);
  }

  // أطلق process خلفيًا وبمرة واحدة فقط (قفل params + Set ذاكرة)
  await triggerProcessOnce(taskId, jobId);

  // نافذة الانتظار: استعلم كل 3 ثوانٍ مع بث تقدم — تحديث الحالة يُكتب فورًا
  const deadline = Date.now() + waitSeconds * 1000;
  let task = (await getTask(taskId))!;
  while (Date.now() < deadline) {
    if (task.status === "completed" || task.status === "failed") return task;
    await sleep(3000);
    const refreshed = await refreshMergeTask(taskId);
    if (!refreshed) break; // المهمة حُذفت من القاعدة — نخرج بما لدينا
    task = refreshed;
    onProgress?.(task, task.status === "completed" ? "اكتمل الدمج" : `جارٍ الدمج… ${task.progress}%`);
  }
  return task;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// نفّذ POST .../process مرة واحدة فقط — بقفل في الذاكرة + علامة في القاعدة
async function triggerProcessOnce(taskId: string, jobId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task) return;
  const params = safeParseJson<{ processTriggered?: boolean }>(task.params_json, {});
  if (params.processTriggered) return;
  await updateTask(taskId, { params_json: JSON.stringify({ ...params, processTriggered: true }) });
  // خلفيًا وبمرة واحدة — نلتقط النتيجة ونكتبها في Turso فورًا
  void (async () => {
    const r = await processMergeJob(jobId);
    if (r.done && r.result) {
      await updateTask(taskId, {
        status: "completed",
        progress: 100,
        result_urls_json: JSON.stringify([r.result.videoUrl].filter(Boolean)),
        error_message: null,
      });
    } else if (r.error && !r.processing) {
      // فشل حتمي (مثل Download failed 403 من مصدر يرفض التحميل)
      await updateTask(taskId, { status: "failed", error_message: String(r.error).slice(0, 400) });
    }
    // processing → النداءات القادمة على get_task تستكمل
  })();
}

// تحديث مهمة دمج حية — يستدعيها get_task أيضًا (تعيد null إن لم توجد المهمة)
export async function refreshMergeTask(taskId: string): Promise<TaskRow | null> {
  const task = await getTask(taskId);
  if (!task || task.status === "completed" || task.status === "failed") return task;

  const jobId = task.provider_task_id;
  if (!jobId) {
    // لم تُنشأ لدى الخدمة بعد (انقطاع شبكة أثناء الإنشاء) — أعد المحاولة بعد تهدئة
    const params = safeParseJson<{ urls?: string[]; createdAt?: number }>(task.params_json, {});
    if (Date.now() - new Date(task.updated_at + "Z").getTime() < 45_000) return task;
    if (params.urls?.length) {
      return await runMerge(taskId, params.urls, 0);
    }
    return task;
  }

  const st = await getMergeStatus(jobId);
  if (st.notFound) {
    await updateTask(taskId, { status: "failed", error_message: st.error || "مهمة الدمج غير موجودة" });
    return (await getTask(taskId)) || task;
  }
  if (st.status === "done" && st.videoUrl) {
    await updateTask(taskId, {
      status: "completed",
      progress: 100,
      result_urls_json: JSON.stringify([st.videoUrl]),
      error_message: null,
    });
    return (await getTask(taskId)) || task;
  }
  if (st.status === "failed" && st.error && !st.error.startsWith("network:")) {
    // فشل معلن من الخدمة — حتمي
    await updateTask(taskId, { status: "failed", error_message: st.error.slice(0, 400) });
    return (await getTask(taskId)) || task;
  }
  // جارية — حدّث التقدم، وإن لم يُنفَّذ process بعد نفّذه الآن
  const params = safeParseJson<{ processTriggered?: boolean }>(task.params_json, {});
  if (!params.processTriggered) {
    await triggerProcessOnce(taskId, jobId);
  }
  await updateTask(taskId, { progress: Math.max(task.progress, st.progress || 0), status: "processing" });
  return (await getTask(taskId)) || task;
}
