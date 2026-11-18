"use client";

import { useCallback, useEffect, useState } from "react";

// أنواع البيانات القادمة من واجهاتنا
interface HealthInfo {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

interface KeyItem {
  id: string;
  provider: string;
  label: string;
  api_key: string; // مُقنَّع دائمًا
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_error: string | null;
  created_at: string;
}

interface TaskItem {
  id: string;
  provider: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
}

interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

const TOOL_CHIPS: { name: string; desc: string }[] = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي عبر gpt-image-2-6/flare-text-to-image" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي عبر grok-imagine-video-1-5-preview" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب المطلوب (حتى 10 مقاطع)" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها — توليد أو دمج — وتحديثها حية" },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها دون إعادة توليد" },
];

const TYPE_AR: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_AR: Record<string, string> = {
  pending: "بانتظار",
  processing: "جارية",
  completed: "مكتملة",
  failed: "فاشلة",
};

function statusBadge(s: string) {
  const map: Record<string, string> = {
    active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40",
    exhausted: "bg-amber-500/15 text-amber-400 border-amber-500/40",
    disabled: "bg-slate-500/15 text-slate-400 border-slate-500/40",
    completed: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40",
    failed: "bg-red-500/15 text-red-400 border-red-500/40",
    processing: "bg-cyan-500/15 text-cyan-400 border-cyan-500/40",
    pending: "bg-slate-500/15 text-slate-400 border-slate-500/40",
  };
  return map[s] || map.pending;
}

export default function Dashboard() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, processing: 0 });

  // نموذج إضافة مفتاح
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keysMsg, setKeysMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // بطاقة الربط
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const [copied, setCopied] = useState("");
  const [mcpUrl, setMcpUrl] = useState("/mcp");

  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys");
      const j = await r.json();
      if (j.keys) setKeys(j.keys);
    } catch {}
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20");
      const j = await r.json();
      if (j.tasks) setTasks(j.tasks);
      if (j.stats) setStats(j.stats);
    } catch {}
  }, []);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => {});
    loadKeys();
    loadTasks();
    setMcpUrl(`${window.location.origin}/mcp`);
    // لوحة المهام تتحدث تلقائيًا كل ~5 ثوانٍ
    const t = setInterval(loadTasks, 5000);
    return () => clearInterval(t);
  }, [loadKeys, loadTasks]);

  async function addKey() {
    setKeysMsg(null);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey, label }),
      });
      const j = await r.json();
      if (r.ok) {
        setKeysMsg({ ok: true, text: "✅ أُضيف المفتاح بنجاح" });
        setApiKey("");
        setLabel("");
        loadKeys();
      } else {
        setKeysMsg({ ok: false, text: `❌ ${j.error}` });
      }
    } catch (e) {
      setKeysMsg({ ok: false, text: `❌ ${(e as Error).message}` });
    }
  }

  async function toggleKey(k: KeyItem) {
    const next = k.status === "disabled" ? "active" : "disabled";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    loadKeys();
  }

  async function removeKey(k: KeyItem) {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    loadKeys();
  }

  function connectJson(): string {
    const headers = health?.authRequired ? { Authorization: "Bearer <MCP_ACCESS_TOKEN>" } : undefined;
    const serverObj: Record<string, unknown> = headers ? { url: mcpUrl, headers } : { url: mcpUrl };
    if (tab === "claude") serverObj.type = "http";
    return JSON.stringify({ mcpServers: { "media-generator": serverObj } }, null, 2);
  }

  async function copyText(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(""), 1500);
    } catch {}
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      {/* الهيدر */}
      <header className="mb-8 text-center">
        <h1 className="bg-gradient-to-l from-cyan-400 to-violet-400 bg-clip-text text-3xl font-extrabold text-transparent md:text-4xl">
          MCP Media Generator
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — تبديل تسلسلي صارم للمفاتيح دون توقف
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <span
            className={`chip ${health?.database === "turso-connected" ? "border-emerald-500/40 text-emerald-400" : "border-red-500/40 text-red-400"}`}
          >
            {health ? (health.ok ? "● Turso متصل" : "● غير متصل") : "● جارٍ الفحص…"}
          </span>
          <span className={`chip ${health?.merger.healthy ? "border-emerald-500/40 text-emerald-400" : "border-amber-500/40 text-amber-400"}`}>
            خدمة الدمج: {health ? (health.merger.healthy ? "جاهزة" : "غير متاحة") : "…"}
          </span>
          {health?.authRequired && <span className="chip border-cyan-500/40 text-cyan-400">محمي بـ Bearer token</span>}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-1">
        {/* (أ) مدير المفاتيح */}
        <section className="card">
          <h2 className="mb-1 text-lg font-bold">🔑 مدير المفاتيح</h2>
          <p className="mb-4 text-xs leading-relaxed text-slate-400">
            أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
          </p>
          <div className="flex flex-wrap gap-2">
            <select value={provider} onChange={(e) => setProvider(e.target.value)} className="input">
              <option value="kie">kie.ai</option>
              <option value="cometapi">CometAPI</option>
            </select>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="تسمية (اختياري)" className="input w-36" />
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="المفتاح الكامل"
              className="input min-w-52 flex-1"
              dir="ltr"
              type="password"
            />
            <button onClick={addKey} className="btn-primary" disabled={!apiKey}>
              إضافة
            </button>
          </div>
          {keysMsg && <p className={`mt-2 text-xs ${keysMsg.ok ? "text-emerald-400" : "text-red-400"}`}>{keysMsg.text}</p>}

          <div className="mt-4 overflow-x-auto">
            {keys.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-500">لا توجد مفاتيح بعد — أضف أول مفتاح لتبدأ التوليد.</p>
            ) : (
              <table className="w-full min-w-[720px] text-right text-xs">
                <thead className="text-slate-400">
                  <tr className="border-b border-[#2a3354]">
                    <th className="p-2">المزود</th>
                    <th className="p-2">المفتاح</th>
                    <th className="p-2">الحالة</th>
                    <th className="p-2">استخدام/نجاح/فشل</th>
                    <th className="p-2">آخر خطأ</th>
                    <th className="p-2">إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id} className="border-b border-[#232b47]">
                      <td className="p-2 font-bold">{k.provider === "kie" ? "kie.ai" : "CometAPI"}{k.label ? ` · ${k.label}` : ""}</td>
                      <td className="p-2 font-mono" dir="ltr">{k.api_key}</td>
                      <td className="p-2">
                        <span className={`chip ${statusBadge(k.status)}`}>{k.status}</span>
                      </td>
                      <td className="p-2">{k.usage_count} / {k.success_count} / {k.fail_count}</td>
                      <td className="max-w-40 truncate p-2 text-red-400/80" title={k.last_error || ""}>{k.last_error || "—"}</td>
                      <td className="p-2">
                        <div className="flex gap-1">
                          <button onClick={() => toggleKey(k)} className="btn-ghost">
                            {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                          </button>
                          <button onClick={() => removeKey(k)} className="btn-ghost hover:border-red-400 hover:text-red-400">
                            حذف
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* (ب) لوحة المهام */}
        <section className="card">
          <h2 className="mb-4 text-lg font-bold">📋 لوحة المهام</h2>
          <div className="mb-4 grid grid-cols-4 gap-2 text-center">
            {[
              { label: "الإجمالي", v: stats.total, c: "text-slate-200" },
              { label: "مكتملة", v: stats.completed, c: "text-emerald-400" },
              { label: "فاشلة", v: stats.failed, c: "text-red-400" },
              { label: "جارية", v: stats.processing, c: "text-cyan-400" },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-[#2a3354] bg-[#0e1322] p-3">
                <div className={`text-2xl font-extrabold ${s.c}`}>{s.v}</div>
                <div className="text-xs text-slate-400">{s.label}</div>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            {tasks.length === 0 && <p className="py-4 text-center text-sm text-slate-500">لا توجد مهام بعد.</p>}
            {tasks.map((t) => {
              const urls = t.result_urls_json ? (JSON.parse(t.result_urls_json) as string[]) : [];
              const attempts = t.attempts_json ? (JSON.parse(t.attempts_json) as unknown[]) : [];
              return (
                <div key={t.id} className="rounded-xl border border-[#232b47] bg-[#0e1322] p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="chip">{TYPE_AR[t.type]}</span>
                    <span className={`chip ${statusBadge(t.status)}`}>{STATUS_AR[t.status] || t.status}</span>
                    <span className="font-mono text-xs text-slate-300" dir="ltr">{t.model}</span>
                    <span className="text-xs text-slate-500">
                      {new Date(t.created_at + "Z").toLocaleString("ar", { dateStyle: "short", timeStyle: "short" })}
                    </span>
                    {attempts.length > 1 && <span className="chip border-violet-500/40 text-violet-400">محاولات: {attempts.length}</span>}
                  </div>
                  <div className="mt-1 truncate text-xs text-slate-400" dir="auto">{t.prompt}</div>
                  {t.status === "processing" && (
                    <div className="mt-2 h-1.5 w-full rounded-full bg-[#1a2138]">
                      <div className="h-1.5 rounded-full bg-gradient-to-l from-cyan-400 to-violet-400" style={{ width: `${t.progress}%` }} />
                    </div>
                  )}
                  {t.status === "completed" && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {urls.map((u, i) => (
                        <a key={i} href={u} target="_blank" rel="noreferrer" className="btn-ghost border-emerald-500/40 text-emerald-400">
                          🔗 فتح النتيجة {urls.length > 1 ? i + 1 : ""}
                        </a>
                      ))}
                    </div>
                  )}
                  {t.status === "failed" && t.error_message && <div className="mt-2 text-xs text-red-400">❌ {t.error_message}</div>}
                </div>
              );
            })}
          </div>
        </section>

        {/* (ج) ربط السيرفر */}
        <section className="card">
          <h2 className="mb-4 text-lg font-bold">🔌 ربط السيرفر</h2>
          <div className="flex items-center gap-2">
            <input value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} className="input min-w-56 flex-1 font-mono text-xs" dir="ltr" />
            <button onClick={() => copyText(mcpUrl, "url")} className="btn-primary">
              {copied === "url" ? "✅ نُسخ" : "نسخ"}
            </button>
          </div>

          <div className="mt-4 flex gap-2">
            {(
              [
                ["chatgpt", "ChatGPT / GPT Agents"],
                ["claude", "Claude Desktop"],
                ["cursor", "Cursor / Windsurf / Cline"],
              ] as const
            ).map(([id, name]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${tab === id ? "bg-cyan-400 text-[#06121b]" : "border border-[#2a3354] text-slate-400"}`}
              >
                {name}
              </button>
            ))}
          </div>

          <pre className="mt-3 max-h-60 overflow-auto rounded-xl border border-[#2a3354] bg-[#0a0f1c] p-3 text-xs text-slate-300" dir="ltr">
            {connectJson()}
          </pre>
          <div className="mt-2 flex items-center justify-between">
            <p className="text-xs text-slate-400">
              {tab === "chatgpt" && "في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL»."}
              {tab === "claude" && "ضِع المحتوى في ملف claude_desktop_config.json ثم أعد تشغيل التطبيق."}
              {tab === "cursor" && "ضِع المحتوى في mcp.json ثم أعد تشغيل المحرر."}
            </p>
            <button onClick={() => copyText(connectJson(), "json")} className="btn-ghost">
              {copied === "json" ? "✅ نُسخ" : "نسخ JSON"}
            </button>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {TOOL_CHIPS.map((t) => (
              <span key={t.name} className="chip" title={t.desc}>
                <code className="text-cyan-400" dir="ltr">{t.name}</code>
                <span className="text-slate-400">— {t.desc}</span>
              </span>
            ))}
          </div>

          <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-400">
            الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف.
            أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
          </div>
        </section>
      </div>
    </main>
  );
}
