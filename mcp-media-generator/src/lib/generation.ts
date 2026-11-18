// منسّق التوليد (runGeneration): سجّل المهمة أولًا ← جرّب المفاتيح بالترتيب الصارم ←
// نافذة انتظار مع بث تقدم ← عند فشل مفتاح/رصيد في منتصف المهمة أعد الإنشاء بنفس task_id
// على المفتاح التالي — العميل لا يرى أي ذكر للمفاتيح أو الرصيد أبدًا.
import { getDb, ensureSchema, insertTask, getTask, updateTask, safeParseJson, type TaskRow, type TaskAttempt, type TaskType } from "./turso";
import { getKeyPool, bumpKeyStats, classifyProviderError, isKeyOrBalanceFailure, type KeyRow } from "./keys";
import { PROVIDERS } from "./providers";
import { providerError } from "./providers/types";
import { resolveModel, availableModels, type ModelDef } from "./models";

export interface GenerationParams {
  prompt: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  image_url?: string;
  enable_audio?: boolean;
  duration?: number;
}

export interface ProgressCb {
  (task: TaskRow, message: string): void;
}

const COOLDOWN_MS = 45_000; // هدئة قبل إعادة المحاولة عبر get_task حتى لا نضغط المزودين

function nowMs(updatedAt: string | null): number {
  if (!updatedAt) return 0;
  // created_at/updated_at بصيغة SQLite: "YYYY-MM-DD HH:MM:SS" بتوقيت UTC
  return Date.parse(updatedAt.replace(" ", "T") + "Z") || 0;
}

// إنشاء المهمة أولًا في Turso ثم تجربة كل مفتاح بالترتيب حتى نجاح الأول
async function tryCreateAcrossKeys(
  task: TaskRow,
  model: ModelDef,
  input: GenerationParams,
  isSyncImage: boolean
): Promise<TaskRow> {
  await ensureSchema();
  const pool = await getKeyPool(model.providers);
  const attempts: TaskAttempt[] = safeParseJson(task.attempts_json, []);

  if (!pool.length) {
    // لا مفاتيح — تبقى processing بانتظار إضافة مفتاح من الواجهة
    await updateTask(task.id, { error_message: "بانتظار توفر مفتاح صالح… لا توجد مفاتيح نشطة" });
    return { ...task, status: "processing", error_message: "بانتظار توفر مفتاح صالح…" };
  }

  for (const key of pool) {
    const adapter = PROVIDERS[key.provider];
    if (!adapter) continue;
    const providerModel = model.providerModel[key.provider];
    try {
      if (isSyncImage && adapter.createImageSync) {
        // صور متزامنة (CometAPI): النتيجة فورية — نربط المهمة ونعيد اكتمالها
        const { urls } = await adapter.createImageSync(key.api_key, providerModel, {
          prompt: input.prompt,
          aspect_ratio: input.aspect_ratio,
          resolution: input.resolution,
          background: input.background,
          output_format: input.output_format,
        });
        await bumpKeyStats(key.id, { ok: true });
        await updateTask(task.id, {
          provider: key.provider,
          key_id: key.id,
          status: "completed",
          progress: 100,
          result_urls_json: JSON.stringify(urls),
          newAttempt: { provider: key.provider, keyId: key.id, keyLabel: key.label, ok: true, at: new Date().toISOString() },
        });
        const updated = await getTask(task.id);
        if (updated) return updated;
      } else {
        const { providerTaskId } = await adapter.createTask(key.api_key, providerModel, input, task.type as "image" | "video");
        await bumpKeyStats(key.id, { ok: true });
        await updateTask(task.id, {
          provider: key.provider,
          provider_task_id: providerTaskId,
          key_id: key.id,
          status: "processing",
          error_message: null,
          newAttempt: { provider: key.provider, keyId: key.id, keyLabel: key.label, ok: true, at: new Date().toISOString() },
        });
        const updated = await getTask(task.id);
        if (updated) return updated;
      }
    } catch (e) {
      const err = e as Error & { status?: number };
      const status = err.status ?? 0;
      const cls = classifyProviderError(status, err.message);
      // عدّادات المفتاح تُحدَّث دائمًا؛ المفتاح المرفوض يُعلَّم تلقائيًا وينتقل للمفتاح التالي
      await bumpKeyStats(key.id, {
        ok: false,
        error: err.message,
        newStatus: cls === "disabled" ? "disabled" : cls === "exhausted" ? "exhausted" : undefined,
      });
      attempts.push({
        provider: key.provider,
        keyId: key.id,
        keyLabel: key.label,
        ok: false,
        errorClass: cls,
        error: String(err.message).slice(0, 300),
        at: new Date().toISOString(),
      });
      await updateTask(task.id, { newAttempt: { provider: key.provider, keyId: key.id, keyLabel: key.label, ok: false, errorClass: cls, error: String(err.message).slice(0, 300), at: new Date().toISOString() } });
      // خطأ معطيات/موديل غير مدعوم لدى كل المزودين؟ معطيات لن تتحسن بتبديل المفاتيح —
      // لكن لأن الموديل قد يكون مدعومًا لدى مزود وغيره (فئة provider) نستمر بالترتيب.
      // فئة params فقط توقف الفحوص الفورية — نعلمها برفع علامة على المهمة.
      if (cls === "params") {
        await updateTask(task.id, { error_message: `خطأ معطيات من المزود: ${String(err.message).slice(0, 200)}` });
      }
    }
  }

  // فشل الإنشاء على كل المفاتيح — تبقى processing (ليست failed) وتُعاد مع كل get_task
  await updateTask(task.id, { error_message: "بانتظار توفر مفتاح صالح…" });
  const t = await getTask(task.id);
  return t || task;
}

// تحديث المهمة الجارية حية من المزود — مع نفس منطق التبديل (يستدعيها get_task أيضًا)
export async function refreshTask(taskId: string): Promise<TaskRow> {
  await ensureSchema();
  const task = await getTask(taskId);
  if (!task) throw new Error("المهمة غير موجودة");

  if (task.status === "completed" || task.status === "failed") return task;

  // 1) لم يُربط بمزود بعد: أعد المحاولة بعد فترة تهدئة (بانتظار توفر مفتاح صالح)
  if (!task.provider_task_id) {
    const last = nowMs(task.updated_at);
    if (Date.now() - last < COOLDOWN_MS) return task;
    const model = resolveModel(task.model);
    if (!model) {
      await updateTask(task.id, { status: "failed", error_message: `موديل غير معروف: ${task.model}` });
      return (await getTask(task.id)) || task;
    }
    const params = safeParseJson<GenerationParams>(task.params_json, { prompt: task.prompt });
    const isSyncImage = task.type === "image" && model.providers.some((p) => PROVIDERS[p].createImageSync);
    return await tryCreateAcrossKeys(task, model, params, isSyncImage);
  }

  // 2) مرتبطة بمزود: استعلم الحالة بالمفتاح المرتبط
  const keyId = task.key_id;
  let key: KeyRow | null = null;
  if (keyId) {
    const r = await getDb().execute({ sql: `SELECT * FROM api_keys WHERE id = ?`, args: [keyId] });
    key = (r.rows[0] as unknown as KeyRow) || null;
  }
  const provider = task.provider as keyof typeof PROVIDERS;
  const adapter = PROVIDERS[provider];
  if (!adapter || !key) {
    // فقدنا المفتاح أو المزود — أعد الإنشاء من الصفر بنفس task_id
    await updateTask(task.id, { provider_task_id: undefined as unknown as string, key_id: "" });
    const model = resolveModel(task.model);
    if (!model) return task;
    const params = safeParseJson<GenerationParams>(task.params_json, { prompt: task.prompt });
    return await tryCreateAcrossKeys({ ...task, provider_task_id: null, key_id: null }, model, params, false);
  }

  try {
    const check = await adapter.checkTask(key.api_key, task.provider_task_id);
    if (check.status === "completed" && check.urls?.length) {
      await updateTask(task.id, {
        status: "completed",
        progress: 100,
        result_urls_json: JSON.stringify(check.urls),
        error_message: null,
      });
      return (await getTask(task.id)) || task;
    }
    // جارية — حدّث التقدم
    await updateTask(task.id, { progress: Math.max(task.progress, check.progress ?? 0), status: "processing" });
    return (await getTask(task.id)) || task;
  } catch (e) {
    const err = e as Error & { status?: number };
    const status = err.status ?? 0;
    const msg = err.message || "";

    if (isKeyOrBalanceFailure(msg) || status === 402 || status === 401 || status === 403) {
      // فشل مفتاح/رصيد في منتصف المهمة → علّم المفتاح وأعد الإنشاء بنفس task_id على التالي
      const cls = classifyProviderError(status, msg);
      await bumpKeyStats(key.id, {
        ok: false,
        error: msg,
        newStatus: cls === "disabled" ? "disabled" : cls === "exhausted" ? "exhausted" : undefined,
      });
      await updateTask(task.id, {
        newAttempt: { provider: task.provider || "", keyId: key.id, keyLabel: key.label, ok: false, errorClass: cls, error: msg.slice(0, 300), at: new Date().toISOString() },
        provider_task_id: "",
        key_id: "",
      });
      const model = resolveModel(task.model);
      const params = safeParseJson<GenerationParams>(task.params_json, { prompt: task.prompt });
      const fresh = await getTask(task.id);
      if (fresh && model) {
        return await tryCreateAcrossKeys({ ...fresh, provider_task_id: null, key_id: null } as TaskRow, model, params, false);
      }
      return task;
    }

    const cls = classifyProviderError(status, msg);
    if (cls === "temporary") {
      // 429/5xx/شبكة — انتقل للمفتاح التالي الآن (المفتاح يبقى سليمًا)
      await updateTask(task.id, {
        newAttempt: { provider: task.provider || "", keyId: key.id, keyLabel: key.label, ok: false, errorClass: cls, error: msg.slice(0, 300), at: new Date().toISOString() },
        provider_task_id: "",
        key_id: "",
      });
      const model = resolveModel(task.model);
      const params = safeParseJson<GenerationParams>(task.params_json, { prompt: task.prompt });
      const fresh = await getTask(task.id);
      if (fresh && model) {
        return await tryCreateAcrossKeys({ ...fresh, provider_task_id: null, key_id: null } as TaskRow, model, params, false);
      }
      return task;
    }

    // فشل حتمي (انتهاك سياسة/معطيات)
    await updateTask(task.id, { status: "failed", error_message: msg.slice(0, 400) });
    return (await getTask(task.id)) || task;
  }
}

export interface StartResult {
  task: TaskRow;
  noKeys: boolean;
}

// التدفق الكامل لأداة generate_image / generate_video
export async function startGeneration(
  modelDef: ModelDef,
  type: "image" | "video",
  params: GenerationParams,
  waitSeconds: number,
  onProgress?: ProgressCb
): Promise<StartResult> {
  const taskId = crypto.randomUUID();
  // سجّل المهمة في Turso قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  await insertTask({
    id: taskId,
    model: modelDef.canonical,
    type,
    prompt: params.prompt,
    params_json: JSON.stringify(params),
    status: "processing",
  });

  // تفريق بين «لا مفاتيح مطلقًا» و«فشل الإنشاء على كل المفاتيح» لصياغة رد عميل أدق
  const pool = await getKeyPool(modelDef.providers);
  const noKeys = pool.length === 0;

  let task = (await getTask(taskId))!;
  const isSyncImage = type === "image" && modelDef.providers.some((p) => PROVIDERS[p].createImageSync);
  task = await tryCreateAcrossKeys(task, modelDef, params, isSyncImage);

  // نافذة الانتظار: استعلم كل 3 ثوانٍ وأرسل تقدمًا حيًا
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    if (task.status === "completed") return { task, noKeys };
    if (task.status === "failed") return { task, noKeys };
    await sleep(3000);
    task = await refreshTask(task.id);
    onProgress?.(task, progressMessage(task));
  }
  return { task, noKeys };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function progressMessage(task: TaskRow): string {
  if (task.status === "completed") return "اكتمل التوليد";
  if (task.status === "failed") return "فشلت المهمة";
  return `قيد التوليد… ${task.progress}%`;
}

export { availableModels, resolveModel, providerError };
export type { TaskType };
