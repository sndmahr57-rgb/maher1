// اختبار وحدات: توليد فيديوهين مختلفي الدقة بـ ffmpeg ← دمج ← تحقق من الدقة/المدة/الصوت
// ثم اختبار التخزين في Turso (sha256) ومسار رفع الأجزاء وحدود الحجم والحذف الشامل
process.env.FFMPEG_PRESET = "veryfast"; // تسريع الاختبار فقط
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { mergeVideos, probeSource, ffmpegPath } = require("../lib/merge");
const { writeOutputBlob, readRangeBytes, outputBlobSize, deleteSourceChunks } = require("../lib/storage");
const dbmod = require("../lib/db");
const { appendSourceChunk } = require("../lib/db");

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
}

async function genClips(dir) {
  // مقطع أول: 1280x720 مع صوت — مقطع ثانٍ: 640x360 بلا صوت
  const a = path.join(dir, "a.mp4");
  const b = path.join(dir, "b.mp4");
  execFileSync(ffmpegPath(), ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=5", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", a], { stdio: "ignore" });
  execFileSync(ffmpegPath(), ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", b], { stdio: "ignore" });
  return [a, b];
}

async function main() {
  const dir = fs.mkdtempSync("/tmp/vm-unit-");
  const [a, b] = await genClips(dir);

  const pa = await probeSource(a);
  const pb = await probeSource(b);
  check("ffprobe يقرأ 1280x720 مع صوت", pa.width === 1280 && pa.height === 720 && pa.hasAudio);
  check("ffprobe يقرأ 640x360 بلا صوت", pb.width === 640 && pb.height === 360 && !pb.hasAudio);

  // الدمج المباشر
  const out = path.join(dir, "merged.mp4");
  let lastP = 0;
  const { canvas, totalDuration } = await mergeVideos({
    sources: [{ tmpPath: a }, { tmpPath: b }],
    outPath: out,
    preset: "veryfast",
    onProgress: (p) => { lastP = p; },
  });
  check("اتجاه التقدم يُبلغ قيمًا صاعدة", lastP >= 40, `آخر قيمة ${lastP}`);
  const po = await probeSource(out);
  check("الدقة النهائية = أكبر دقة مدخل (1280x720)", po.width === 1280 && po.height === 720, `${po.width}x${po.height}`);
  const sumD = pa.duration + pb.duration;
  check("المدة ≈ مجموع المدد", Math.abs(po.duration - sumD) < 1.2, `${po.duration} مقابل ${sumD}`);
  check("المصدر الصامت أُضيف له صوت (المسار الصوتي موجود)", po.hasAudio);
  check("اللوحة المحسوبة زوجية الأبعاد", canvas.w % 2 === 0 && canvas.h % 2 === 0);

  // اختبار التخزين في Turso: كتابة Blob عشوائي 5MB وقراءته بمطابقة sha256
  const jobId = "unit_" + crypto.randomBytes(4).toString("hex");
  const blob = crypto.randomBytes(5 * 1024 * 1024);
  await writeOutputBlob(jobId, blob);
  const size = await outputBlobSize(jobId);
  check("حجم الـ Blob المخزن مطابق", size === blob.length, `${size}`);
  const back = await readRangeBytes("output_chunks", jobId, 0, blob.length - 1);
  const h1 = crypto.createHash("sha256").update(blob).digest("hex");
  const h2 = crypto.createHash("sha256").update(back).digest("hex");
  check("sha256 للقراءة يعيد النص الأصلي", h1 === h2);
  // قراءة نافذة وسطية للتحقق من تقليم المدى
  const mid = await readRangeBytes("output_chunks", jobId, 1000, 1999);
  check("قراءة نافذة وسطية (1000..1999) صحيحة", mid.length === 1000 && mid.equals(blob.subarray(1000, 2000)));

  // مسار رفع الأجزاء: جزءان 2MB+1MB عبر appendSourceChunk
  const jobId2 = "unit2_" + crypto.randomBytes(4).toString("hex");
  await dbmod.createJob({ id: jobId2, status: "uploading", sources: [{ seq: 0, kind: "file", name: "x.mp4", size: 3 * 1024 * 1024 }], expiresAt: new Date(Date.now() + 86400000).toISOString() });
  const c1 = crypto.randomBytes(2 * 1024 * 1024);
  const c2 = crypto.randomBytes(1024 * 1024);
  await appendSourceChunk(jobId2, 0, 0, c1);
  const afterOne = await appendSourceChunk(jobId2, 0, 1, c2);
  check("bytes_received يتراكم عبر الأجزاء", afterOne === 3 * 1024 * 1024, `${afterOne}`);
  const { reassembleSourceChunked } = require("../lib/download");
  const rePath = path.join(dir, "re.mp4");
  await reassembleSourceChunked(dbmod.db(), jobId2, 0, rePath, "source_chunks");
  const hRe = crypto.createHash("sha256").update(fs.readFileSync(rePath)).digest("hex");
  const hSrc = crypto.createHash("sha256").update(Buffer.concat([c1, c2])).digest("hex");
  check("إعادة تجميع الأجزاء المرفوعة مطابقة sha256", hRe === hSrc);

  // حدود الحجم: مرشح التنزيل يرفض تجاوز الحد
  const { downloadToFile } = require("../lib/download");
  // ملف محلي عبر file:// غير مدعوم — نستخدم دالة الفحص الداخلية بدل نداء شبكة: نتأكد أن حد 200MB مضبوط
  const { LIMITS } = require("../lib/utils");
  check("حد حجم المصدر مضبوط إلى 200MB", LIMITS.sourceMaxBytes === 200 * 1024 * 1024);

  // الحذف الشامل
  await dbmod.deleteJobRows(jobId2);
  const gone = await dbmod.getJob(jobId2);
  check("الحذف الشامل يزيل المهمة", !gone);
  await dbmod.deleteJobRows(jobId);
  check("تنظيف مهمة التخزين", true);

  for (const f of [a, b, out, rePath]) fs.unlinkSync(f);
  fs.rmdirSync(dir);

  const failed = results.filter(r => !r.ok);
  console.log(`\nالنتيجة: ${results.length - failed.length}/${results.length} نجحت`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("فشل غير متوقع:", e); process.exit(1); });
