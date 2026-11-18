// PATCH: تعطيل/تنشيط يدوي | DELETE: حذف المفتاح
import { setKeyStatus, deleteKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const body = (await req.json()) as { status?: string };
    if (body.status !== "active" && body.status !== "disabled") {
      return Response.json({ error: "الحالة المسموحة: active أو disabled" }, { status: 400 });
    }
    await setKeyStatus(id, body.status);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await deleteKey(id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
