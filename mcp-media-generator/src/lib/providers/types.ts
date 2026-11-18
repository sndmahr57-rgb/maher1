// واجهة المزودات: أي خطأ يُرمى كـ ProviderError ليُصنَّف في classifyProviderError
import type { ProviderId } from "../models";

export interface ProviderError extends Error {
  status: number; // 0 = خطأ شبكة/انقطاع
  message: string;
}

export function providerError(status: number, message: string): ProviderError {
  const e = new Error(message) as ProviderError;
  e.status = status;
  e.message = message;
  return e;
}

export interface ImageInput {
  prompt: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
}

export interface VideoInput {
  prompt: string;
  image_url?: string;
  aspect_ratio?: string;
  resolution?: string;
  enable_audio?: boolean;
  duration?: number;
}

export interface ProviderAdapter {
  // مهمة غير متزامنة: تعيد providerTaskId فورًا
  createTask(key: string, providerModel: string, input: ImageInput | VideoInput, type: "image" | "video"): Promise<{ providerTaskId: string }>;
  // صور متزامنة إن كان المزود يدعمها
  createImageSync?(key: string, providerModel: string, input: ImageInput): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(key: string, providerTaskId: string): Promise<{
    status: "processing" | "completed" | "failed";
    urls?: string[];
    error?: string;
    progress?: number;
  }>;
}

export interface ProviderContext {
  id: ProviderId;
  adapter: ProviderAdapter;
}
