// GET /api/health — جهوزية قاعدة البيانات + الموديلات + خدمة الدمج + حالة التوثيق
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerBase, mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const healthy = await dbHealthy();
  const merger = await mergerHealthy();
  return Response.json({
    ok: healthy,
    database: healthy ? "turso-connected" : "turso-unavailable",
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger: { base: mergerBase(), healthy: merger },
    authRequired: !!process.env.MCP_ACCESS_TOKEN,
  });
}
