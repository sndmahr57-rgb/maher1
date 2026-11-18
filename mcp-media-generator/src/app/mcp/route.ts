// خادم MCP على /mcp — بروتوكول Streamable HTTP عبر SDK الرسمي
// نستخدم WebStandardStreamableHTTPServerTransport (يعمل مباشرة مع Request/Response
// في Next.js App Router دون طبقة وسطى) + McpServer مع الأدوات الخمس.
// الوضع stateless (sessionIdGenerator: undefined) هو المناسب لبيئة serverless على Vercel —
// لا جلسات في الذاكرة، وكل طلب مستقل، والعميل يعيد إرسال الحالة بنفسه.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { resolveModel, availableModels } from "@/lib/models";
import { startGeneration, refreshTask, type GenerationParams } from "@/lib/generation";
import { runMerge, refreshMergeTask } from "@/lib/merger";
import { listRecentTasks, getTask, safeParseJson } from "@/lib/turso";
import {
  formatTaskReply,
  noKeysMessage,
  unknownModelMessage,
  mergeNeedsTwoMessage,
  mergeTooManyMessage,
  unknownToolMessage,
} from "@/lib/arabic";
import { SERVER_INFO, SERVER_INSTRUCTIONS } from "@/lib/mcp-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// نافذة الانتظار تصل 240 ثانية — نسمح بـ 300 كي تكتمل حتى على الاستضافة
export const maxDuration = 300;

const TOOL_NAMES = ["generate_image", "generate_video", "merge_videos", "get_task", "list_media"];

// إرسال تقدم حي أثناء نافذة الانتظار (يعمل فقط إن زوّد العميل الطلب بـ progressToken)
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

async function sendProgress(extra: ToolExtra, task: { status: string; progress: number }, message: string): Promise<void> {
  const token = extra?._meta?.progressToken;
  if (token === undefined || token === null) return;
  try {
    const notification = {
      method: "notifications/progress" as const,
      params: { progressToken: token, progress: task.progress, total: 100, message },
    };
    await extra.sendNotification(notification as ServerNotification);
  } catch {
    // العميل قد يكون فصل الاتصال — نتجاهل
  }
}

// بناء خادم جديد لكل طلب (stateless) مع تسجيل الأدوات الخمس بأوصافها الإنجليزية الدقيقة
// أما نتائج الاستدعاء فتُصاغ بالعربية.
function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential failover across all active keys). Returns the finished image URL if it completes within the wait window; otherwise returns a task_id — then call get_task every ~10 seconds until completed, show the URL, and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z.enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"]).default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z.enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"]).default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const { prompt, model, aspect_ratio, resolution, background, output_format, wait_seconds } = args;
      const modelDef = resolveModel(model);
      if (!modelDef || modelDef.type !== "image") {
        return { content: [{ type: "text", text: unknownModelMessage(model, availableModels()) }], isError: true };
      }
      const params: GenerationParams = { prompt, aspect_ratio, resolution, background, output_format };
      const started = await startGeneration(modelDef, "image", params, wait_seconds, (t, msg) => {
        void sendProgress(extra, t, msg);
      });
      // لا مفاتيح مطلقًا → رسالة no_keys؛ فشل على كل المفاتيح → تبقى processing بـ task_id
      // ويُتابعها get_task تلقائيًا حتى يتوفر مفتاح صالح (مثلًا بعد شحن الرصيد)
      if (started.noKeys) {
        return { content: [{ type: "text", text: noKeysMessage(modelDef.canonical) }], isError: true };
      }
      const reply = formatTaskReply(started.task);
      return { content: [{ type: "text", text: reply.text }], isError: reply.isError };
    }
  );

  server.registerTool(
    "generate_video",
    {
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio — dialogue/effects/music; optional image-to-video). Videos take minutes: a short wait streams live progress, then a task_id is returned — track it with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z.enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"]).default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const { prompt, image_url, model, aspect_ratio, resolution, enable_audio, duration, wait_seconds } = args;
      const modelDef = resolveModel(model);
      if (!modelDef || modelDef.type !== "video") {
        return { content: [{ type: "text", text: unknownModelMessage(model, availableModels()) }], isError: true };
      }
      const params: GenerationParams = { prompt, image_url, aspect_ratio, resolution, enable_audio, duration };
      const started = await startGeneration(modelDef, "video", params, wait_seconds, (t, msg) => {
        void sendProgress(extra, t, msg);
      });
      if (started.noKeys) {
        return { content: [{ type: "text", text: noKeysMessage(modelDef.canonical) }], isError: true };
      }
      const reply = formatTaskReply(started.task);
      return { content: [{ type: "text", text: reply.text }], isError: reply.isError };
    }
  );

  server.registerTool(
    "merge_videos",
    {
      description:
        'Merge several clips into ONE final video in the given order. Pass "urls" (public direct video links) or "task_ids" (completed video tasks whose result URLs are resolved from the database in order). Merging is usually fast: a short wait streams progress, then a merge task_id — track with get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.',
      inputSchema: {
        // رسائل الرفض عربية وفق المواصفة (مع الإبقاء على الحدود في المخطط المنشور)
        urls: z.array(z.string())
          .min(2, { message: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." })
          .max(10, { message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." })
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z.array(z.string())
          .min(2, { message: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." })
          .max(10, { message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." })
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const { urls, task_ids, wait_seconds } = args;
      const directUrls: string[] = [];
      const failedIds: string[] = [];

      // الترتيب: روابط task_ids أولًا ثم urls المباشرة بنفس ترتيبها
      if (task_ids?.length) {
        for (const tid of task_ids) {
          const t = await getTask(tid);
          const urlsOfT = t ? safeParseJson<string[]>(t.result_urls_json, []) : [];
          if (t?.status === "completed" && urlsOfT.length && t.type === "video") {
            directUrls.push(urlsOfT[0]);
          } else {
            failedIds.push(tid);
          }
        }
      }
      if (urls?.length) directUrls.push(...urls);

      if (failedIds.length) {
        return {
          content: [
            { type: "text", text: mergeNeedsTwoMessage() + `\nتفاصيل كل معرّف فاشل:\n${failedIds.map((id) => `- ${id}`).join("\n")}` },
          ],
          isError: true,
        };
      }
      if (directUrls.length < 2) {
        return { content: [{ type: "text", text: mergeNeedsTwoMessage() }], isError: true };
      }
      if (directUrls.length > 10) {
        return { content: [{ type: "text", text: mergeTooManyMessage() }], isError: true };
      }
      // كل الروابط يجب أن تكون http/https مباشرة وعامة
      const bad = directUrls.filter((u) => !/^https?:\/\//i.test(u));
      if (bad.length) {
        return { content: [{ type: "text", text: `❌ روابط غير صالحة (يجب أن تكون http/https مباشرة وعامة): ${bad.join(", ")}` }], isError: true };
      }

      const taskId = crypto.randomUUID();
      const task = await runMerge(taskId, directUrls, wait_seconds ?? 60, (t, msg) => {
        void sendProgress(extra, t, msg);
      });
      const reply = formatTaskReply(task);
      return { content: [{ type: "text", text: reply.text }], isError: reply.isError };
    }
  );

  server.registerTool(
    "get_task",
    {
      description:
        "Track any task by its id — image/video generation AND merging (reads the Turso database and live-updates from the provider/merging service if still running). Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().describe("The task_id returned by generate_image / generate_video / merge_videos."),
      },
    },
    async (args) => {
      const { task_id } = args;
      const t = await getTask(task_id);
      if (!t) {
        return { content: [{ type: "text", text: `❌ المهمة غير موجودة: ${task_id}` }], isError: true };
      }
      // المهمة الجارية تُحدَّث حية من المزود/خدمة الدمج مع منطق التبديل نفسه
      const task = t.status === "completed" || t.status === "failed" ? t : t.type === "merge" ? await refreshMergeTask(task_id) : await refreshTask(task_id);
      const reply = formatTaskReply(task);
      return { content: [{ type: "text", text: reply.text }], isError: reply.isError };
    }
  );

  server.registerTool(
    "list_media",
    {
      description:
        "List the latest images / videos / merges stored in the database with their URLs (no regeneration) — to recall previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const { type, status, limit } = args;
      const rows = await listRecentTasks(limit ?? 10, { type, status });
      if (!rows.length) {
        return { content: [{ type: "text", text: "📭 لا توجد مهام مخزنة بعد بهذه الفلاتر." }] };
      }
      const lines = rows.map((r) => {
        const urls = safeParseJson<string[]>(r.result_urls_json, []);
        const link = urls.length ? ` — ${urls[0]}` : "";
        const typeAr = r.type === "image" ? "صورة" : r.type === "video" ? "فيديو" : "دمج";
        const stAr = r.status === "completed" ? "مكتملة" : r.status === "failed" ? "فاشلة" : "جارية";
        return `- [${typeAr} • ${stAr}] ${r.model}${link} (task_id: ${r.id})`;
      });
      return { content: [{ type: "text", text: `📚 أحدث الوسائط (${rows.length}):\n${lines.join("\n")}` }] };
    }
  );

  return server;
}

// فحص توكن الوصول الاختياري على /mcp (إن ضُبط MCP_ACCESS_TOKEN)
function authOk(req: Request): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true;
  const header = req.headers.get("authorization") || "";
  return header === `Bearer ${token}`;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, mcp-session-id, mcp-protocol-version",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, mcp-session-id",
  };
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function POST(req: Request) {
  if (!authOk(req)) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
  return handleWithLifecycle(req);
}

// نربط دورة حياة النقل/الخادم بنهاية تدفق الاستجابة:
// أدواتنا الطويلة تُبقي قناة SSE مفتوحة أثناء نافذة الانتظار، فلا يُغلق النقل إلا بعد انتهاء التدفق فعليًا
function handleWithLifecycle(req: Request): Promise<Response> {
  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const closeResources = () => {
    void transport.close?.().catch?.(() => {});
    void server.close?.().catch?.(() => {});
  };
  return server.connect(transport).then(() =>
    transport.handleRequest(req).then((response) => {
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
      if (!response.body) {
        closeResources();
        return new Response(null, { status: response.status, headers });
      }
      const body = response.body.pipeThrough(
        new TransformStream({
          // إغلاق الموارد عند اكتمال التدفق (يشمل نهاية أدوات نافذة الانتظار)
          flush: closeResources,
        })
      );
      return new Response(body, { status: response.status, headers });
    })
  );
}

export async function GET(req: Request) {
  if (!authOk(req)) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
  }
  return handleWithLifecycle(req);
}

export async function DELETE(req: Request) {
  if (!authOk(req)) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
  }
  return handleWithLifecycle(req);
}
