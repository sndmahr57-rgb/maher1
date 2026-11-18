// سجل الموديلات: الأسماء كما يراها عميل MCP + صيغ بديلة نقبلها ونوحّدها
// + اسم الموديل كما يُرسل فعليًا لكل مزود (قابل للتجاوز بمتغيرات البيئة)
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
}

export const MODELS: ModelDef[] = [
  {
    canonical: process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image",
      cometapi: process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image",
    },
  },
  {
    canonical: process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview",
      cometapi: process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview",
    },
  },
];

// توحيد اسم الموديل: نقبل الشرطات والنقاط بالتبادل (2.6 ↔ 2-6) ثم نطابق canonical أو alias
function normalizeName(name: string): string {
  return name.trim().replace(/\./g, "-").toLowerCase();
}

export function resolveModel(name: string): ModelDef | null {
  const n = normalizeName(name);
  for (const m of MODELS) {
    const forms = [m.canonical, ...m.aliases].map(normalizeName);
    if (forms.includes(n)) return m;
  }
  return null;
}

export function availableModels(): string[] {
  return MODELS.map((m) => m.canonical);
}
