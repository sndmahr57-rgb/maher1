// تدفق التنفيذ الكامل لمهمة الدمج: سحب المصادر (0–40) ← ترميز (40–90) ← تخزين الناتج (100)
const fs = require("fs");
const dbmod = require("./db");
const { LIMITS, newId } = require("./utils");
const { mergeVideos } = require("./merge");
const { downloadToFile, reassembleSourceChunked, tmpFile, safeUnlink } = require("./download");
const { writeOutputBlob, deleteSourceChunks } = require("./storage");

// قفل الذاكرة: منع تنفيذ process المتزامن لنفس المهمة
const processInFlight = new Set();

function jobDto(row, baseUrl) {
  const id = row.id;
  const base = baseUrl || "";
  const done = row.status === "done";
  return {
    jobId: id,
    status: row.status,
    progress: Number(row.progress || 0),
    error: row.error || undefined,
    videoUrl: done ? row.video_url || (base ? `${base}/api/jobs/${id}/video` : undefined) : undefined,
    downloadUrl: done ? row.download_url || (base ? `${base}/api/jobs/${id}/video?download=1` : undefined) : undefined,
    size: row.output_size == null ? undefined : Number(row.output_size),
    duration: row.output_duration == null ? undefined : Number(row.output_duration),
    resolution: row.output_resolution || undefined,
    expiresAt: row.expires_at,
  };
}

// تنفيذ الدمج كاملًا (متزامن) — يستدعيه POST /api/jobs/{id}/process أو سيرفر التطوير
async function runProcess(jobId, baseUrl) {
  if (processInFlight.has(jobId)) return { inFlight: true };
  processInFlight.add(jobId);
  const tmps = [];
  try {
    const job = await dbmod.getJob(jobId);
    if (!job) return { notFound: true };
    if (job.status === "done") return { done: true, job: jobDto(job, baseUrl) };
    if (["processing"].includes(job.status)) return { inFlight: true };

    const sources = await dbmod.getSources(jobId);
    // التحقق من حدود العدد والحجم الكلي قبل أي عمل
    if (sources.length < 2) {
      await dbmod.updateJob(jobId, { status: "failed", error: "الدمج يحتاج مقطعين على الأقل" });
      return { failed: "الدمج يحتاج مقطعين على الأقل" };
    }

    await dbmod.updateJob(jobId, { status: "processing", progress: 1, error: null });

    // سحب المصادر: رابط → تنزيل؛ ملف مرفوع → إعادة تجميع من قاعدة البيانات
    const localSources = [];
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const dest = tmpFile(`src${i}`);
      tmps.push(dest);
      if (s.kind === "url") {
        const r = await downloadToFile(s.url, dest);
        if (r.bytes > LIMITS.sourceMaxBytes) throw Object.assign(new Error("حجم مصدر يتجاوز الحد"), { fatal: true });
      } else {
        // ملف مرفوع: تحقق اكتمال البايتات المستلمة مقابل الحجم المعلن
        if (s.size != null && s.bytesReceived < s.size) {
          throw Object.assign(new Error(`الملف «${s.name || s.seq}» غير مكتمل الرفع (${s.bytesReceived}/${s.size} بايت)`), { fatal: true });
        }
        await reassembleSourceChunked(dbmod.db(), jobId, s.seq, dest, "source_chunks");
      }
      localSources.push({ tmpPath: dest, i });
      await dbmod.updateJob(jobId, { progress: Math.min(39, Math.round(((i + 1) / sources.length) * 39)) });
    }

    // الدمج والترميز مع رفع التقدم من داخل ffmpeg
    const outPath = tmpFile("out.mp4");
    tmps.push(outPath);
    await mergeVideos({
      sources: localSources,
      outPath,
      preset: process.env.FFMPEG_PRESET || "medium",
      onProgress: (p) => {
        // اكتب التقدم فورًا في القاعدة (40–90 أثناء الترميز)
        dbmod.updateJob(jobId, { progress: p }).catch(() => {});
      },
    });

    const stat = fs.statSync(outPath);
    if (stat.size > LIMITS.outputMaxBytes) {
      throw Object.assign(new Error(`حجم الناتج (${Math.round(stat.size / 1024 / 1024)}MB) يتجاوز الحد المسموح`), { fatal: true });
    }

    // قياس المدة والدقة من الناتج نفسه (ffprobe) للإبلاغ بدقة
    const { probeSource } = require("./merge");
    let outDur = null;
    let outRes = null;
    try {
      const pr = await probeSource(outPath);
      outDur = Math.round((pr.duration || 0) * 100) / 100;
      outRes = `${pr.width}x${pr.height}`;
    } catch {}

    // تخزين الناتج مُقسَّمًا في Turso ثم حذف أجزاء المصادر (الناتج فقط هو المطلوب)
    await dbmod.updateJob(jobId, { progress: 92 });
    const buffer = fs.readFileSync(outPath);
    await writeOutputBlob(jobId, buffer);
    await deleteSourceChunks(jobId);

    const base = baseUrl || "";
    const videoUrl = base ? `${base}/api/jobs/${jobId}/video` : null;
    const downloadUrl = base ? `${base}/api/jobs/${jobId}/video?download=1` : null;

    await dbmod.updateJob(jobId, {
      status: "done",
      progress: 100,
      output_size: stat.size,
      output_duration: outDur,
      output_resolution: outRes,
      video_url: videoUrl,
      download_url: downloadUrl,
    });

    return {
      done: true,
      job: {
        jobId,
        status: "done",
        progress: 100,
        videoUrl: videoUrl || undefined,
        downloadUrl: downloadUrl || undefined,
        size: stat.size,
        duration: outDur || undefined,
        resolution: outRes || undefined,
        expiresAt: job.expires_at,
      },
    };
  } catch (e) {
    // فشل حتمي واضح برسالة — لا انهيار
    const msg = e && e.message ? e.message : String(e);
    await dbmod.updateJob(jobId, { status: "failed", error: msg.slice(0, 500) }).catch(() => {});
    return { failed: msg };
  } finally {
    for (const t of tmps) safeUnlink(t);
    processInFlight.delete(jobId);
  }
}

module.exports = { runProcess, processInFlight, jobDto };
