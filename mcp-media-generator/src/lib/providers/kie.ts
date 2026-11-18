// مزود kie.ai — Jobs API الموحد (الشكل الحقيقي مُتحقق منه بنداءات فعلية):
// POST /api/v1/jobs/createTask → {"code":200,"data":{"taskId":"..."}}
// GET  /api/v1/jobs/recordInfo → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
//        "resultJson":"{\"resultUrls\":[...]}",  ← نص JSON يحتاج JSON.parse ثانيًا
//        "failMsg":"..."}}
import { providerError, type ProviderAdapter } from "./types";
import type { ImageInput, VideoInput } from "./types";

const BASE = "https://api.kie.ai/api/v1/jobs";

async function callApi<T>(path: string, key: string, init?: RequestInit): Promise<T> {
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
    // انقطاع شبكة/مهلة — خطأ مؤقت (status 0)
    throw providerError(0, `network error: ${(e as Error).message}`);
  }
  const body = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: unknown } | null;
  if (!body) {
    throw providerError(res.status || 500, `bad response body (HTTP ${res.status})`);
  }
  // kie يعيد HTTP 200 غالبًا مع code داخلي — نحوله لخطأ مفهوم للتصنيف
  if (body.code !== 200) {
    throw providerError(body.code || res.status || 500, body.msg || `HTTP ${res.status}`);
  }
  return body.data as T;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, providerModel, input, type) {
    const data = await callApi<{ taskId: string }>("/createTask", key, {
      method: "POST",
      body: JSON.stringify({ model: providerModel, input }),
    });
    if (!data?.taskId) throw providerError(500, "createTask رد بلا taskId");
    return { providerTaskId: data.taskId };
  },

  async checkTask(key, providerTaskId) {
    const data = await callApi<{
      state: string;
      resultJson: string;
      failMsg: string;
      failCode?: number;
    }>(`/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, key);

    const state = data?.state || "waiting";
    if (state === "success") {
      // resultJson نص JSON داخل JSON — يحتاج تحليلًا ثانيًا (وإن تغيّر الشكل نتبع docs.kie.ai)
      let urls: string[] = [];
      try {
        const parsed = JSON.parse(data.resultJson || "{}") as { resultUrls?: string[] };
        urls = (parsed.resultUrls || []).filter((u) => /^https?:\/\//.test(u));
      } catch {
        throw providerError(500, "resultJson بصيغة غير متوقعة من kie.ai");
      }
      if (!urls.length) throw providerError(500, "اكتملت المهمة بلا روابط نتائج");
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail") {
      throw providerError(500, data?.failMsg || "فشل المزود دون رسالة");
    }
    // waiting | queuing | generating
    const progress = state === "generating" ? 50 : state === "queuing" ? 15 : 5;
    return { status: "processing", progress };
  },
};

// ملاحظة: مدخلات الفيديو تتطابق مع ما يقبل مزود kie لنموذج grok-imagine (prompt/aspect_ratio/duration/resolution/enable_audio/image_url)
export type { ImageInput, VideoInput };
