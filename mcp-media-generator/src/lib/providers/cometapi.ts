// مزود CometAPI (المزود الثاني): صور متزامنة عبر نقطة images المتوافقة مع OpenAI،
// وفيديو عبر نقطة مهام غير متزامنة بنمط create/check.
// ملاحظة: الأشكال هنا وفق التوثيق المتوافق مع OpenAI المتداول لدى CometAPI —
// حدّث المسارات حسب docs المزود الحالية عند إضافة مفاتيحهم (لا يوجد مفتاح CometAPI في التجارب).
import { providerError, type ProviderAdapter } from "./types";

const BASE = "https://api.cometapi.com";

async function callApi(path: string, key: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
  } catch (e) {
    throw providerError(0, `network error: ${(e as Error).message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (body && typeof body === "object" && ((body as { error?: { message?: string } }).error?.message ||
        (body as { message?: string }).message)) || `HTTP ${res.status}`;
    throw providerError(res.status, msg);
  }
  return body;
}

export const cometapiAdapter: ProviderAdapter = {
  // الصور: استجابة فورية — نطلب response_format:url لتخزين رابط لا base64
  async createImageSync(key, providerModel, input) {
    const body = (await callApi("/v1/images/generations", key, {
      method: "POST",
      body: JSON.stringify({
        model: providerModel,
        prompt: input.prompt,
        n: 1,
        size: "auto",
        response_format: "url",
      }),
    })) as { data?: Array<{ url?: string; b64_json?: string }> };

    const urls: string[] = [];
    for (const item of body?.data || []) {
      if (item.url) urls.push(item.url);
      else if (item.b64_json) urls.push(`data:image/png;base64,${item.b64_json}`);
    }
    if (!urls.length) throw providerError(500, "استجابة الصور بلا روابط");
    return { urls };
  },

  // الفيديو: نمط مهام غير متزامن
  async createTask(key, providerModel, input) {
    const body = (await callApi("/v1/video/tasks", key, {
      method: "POST",
      body: JSON.stringify({ model: providerModel, input }),
    })) as { task_id?: string; id?: string; data?: { task_id?: string } };
    const id = body?.task_id || body?.id || body?.data?.task_id;
    if (!id) throw providerError(500, "createTask رد بلا معرّف مهمة");
    return { providerTaskId: id };
  },

  async checkTask(key, providerTaskId) {
    const body = (await callApi(`/v1/video/tasks/${encodeURIComponent(providerTaskId)}`, key)) as {
      status?: string;
      state?: string;
      progress?: number;
      video_url?: string;
      url?: string;
      result?: { video_url?: string; url?: string };
      error?: string;
      message?: string;
    };
    const status = String(body?.status || body?.state || "").toLowerCase();
    const url = body?.video_url || body?.url || body?.result?.video_url || body?.result?.url;
    if (["succeeded", "success", "completed", "done"].includes(status) && url) {
      return { status: "completed", urls: [url], progress: 100 };
    }
    if (["failed", "error", "cancelled"].includes(status)) {
      throw providerError(500, body?.error || body?.message || "فشل المزود دون رسالة");
    }
    let progress = body?.progress ?? undefined;
    if (progress != null && progress <= 1) progress = Math.round(progress * 100);
    return { status: "processing", progress: progress ?? 30 };
  },
};
