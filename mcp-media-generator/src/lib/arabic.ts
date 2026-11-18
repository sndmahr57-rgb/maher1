// صياغة الردود العربية للأدوات — النموذج يقرأ هذه النصوص ويعرضها للمستخدم
// لا رسائل مفاتيح أو رصيد تخرج للعميل أبدًا (التبديل صامت تمامًا)
import type { TaskRow } from "./turso";
import { safeParseJson } from "./turso";

export function formatTaskReply(task: TaskRow | null): { text: string; isError: boolean } {
  if (!task) {
    return { text: "❌ المهمة غير موجودة — تحقق من task_id.", isError: true };
  }
  const urls = safeParseJson<string[]>(task.result_urls_json, []);

  if (task.status === "completed") {
    const links = urls.map((u) => `الرابط المباشر: ${u}`).join("\n");
    switch (task.type) {
      case "image":
        return {
          text: `✅ تم توليد الصورة بنجاح\n![image](${urls[0] || ""})\n${links}`,
          isError: false,
        };
      case "video":
        return {
          text: `✅ تم توليد الفيديو بنجاح\n${urls.map((u) => `- ${u}`).join("\n")}\nالرابط المباشر: ${urls[0] || ""}`,
          isError: false,
        };
      case "merge":
        return {
          text: `✅ تم دمج المقاطع بنجاح\nالرابط المباشر: ${urls[0] || ""}\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`,
          isError: false,
        };
    }
  }

  if (task.status === "failed") {
    return { text: `❌ فشلت المهمة: ${task.error_message || "سبب غير معروف"}`, isError: true };
  }

  // pending | processing
  return {
    text: `⏳ المهمة قيد المعالجة — task_id: ${task.id}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
    isError: false,
  };
}

export function noKeysMessage(model: string): string {
  return `❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`;
}

export function unknownModelMessage(name: string, models: string[]): string {
  return `❌ موديل غير معروف: ${name}. المتاح: ${models.join(", ")}`;
}

export function mergeNeedsTwoMessage(): string {
  return "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
}

export function mergeTooManyMessage(): string {
  return "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).";
}

export function unknownToolMessage(name: string, available: string[]): string {
  return `❌ أداة غير معروفة: ${name}. المتاح: ${available.join(", ")}`;
}
