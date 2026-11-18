// GET: قائمة المفاتيح المُقنَّعة دائمًا | POST: إضافة مفتاح مع رفض التكرار لنفس المزود
import { listKeys, addKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const keys = await listKeys();
    return Response.json({ keys });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { provider?: string; api_key?: string; label?: string };
    const provider = body.provider;
    const apiKey = (body.api_key || "").trim();
    const label = (body.label || "").trim();
    if (provider !== "kie" && provider !== "cometapi") {
      return Response.json({ error: "المزود يجب أن يكون kie أو cometapi" }, { status: 400 });
    }
    if (!apiKey) {
      return Response.json({ error: "المفتاح مطلوب" }, { status: 400 });
    }
    const { id } = await addKey(provider, apiKey, label);
    return Response.json({ ok: true, id }, { status: 201 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
