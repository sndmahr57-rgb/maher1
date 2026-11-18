// صفحة 404 العربية لأي مسار صفحة غير موجود في خادم MCP
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col items-center px-4 py-20 text-center">
      <div className="bg-gradient-to-l from-cyan-400 to-violet-400 bg-clip-text text-7xl font-extrabold text-transparent">
        404
      </div>
      <h1 className="mt-4 text-2xl font-bold">الصفحة غير موجودة في خادم MCP</h1>
      <p className="mt-3 max-w-xl leading-relaxed text-slate-400">
        هذا المشروع يعرض ثلاثة مسارات فقط: الواجهة على «/»، خادم بروتوكول MCP على
        «/mcp»، وواجهات الإدارة تحت «/api». إن كنت تبحث عن نقاط دمج الفيديو
        (jobs أو upload أو config) فهي في مشروع <b>خدمة الدمج</b> المنفصل.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Link href="/" className="btn-primary">
          لوحة الإدارة «/»
        </Link>
        <Link href="/api/health" className="btn-ghost">
          فحص الجهوزية «/api/health»
        </Link>
      </div>
    </main>
  );
}
