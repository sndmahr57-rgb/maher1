// GET /api/tasks — أحدث المهام + الإحصائيات للوحة المهام الحية
import { listRecentTasks, taskStats, type TaskType, type TaskStatus } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
    const type = url.searchParams.get("type") as TaskType | null;
    const status = url.searchParams.get("status") as TaskStatus | null;
    const [tasks, stats] = await Promise.all([
      listRecentTasks(limit, { type: type || undefined, status: status || undefined }),
      taskStats(),
    ]);
    return Response.json({ tasks, stats });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
