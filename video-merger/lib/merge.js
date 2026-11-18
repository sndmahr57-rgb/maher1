// محرك الدمج: ffprobe لكل مصدر ← توحيد (scale+pad+fps+setsar+yuv420p) ← concat ← ترميز عالي الجودة
// libx264 CRF 18 + AAC 192k/44100 + faststart — الناتج MP4 يعمل فورًا على الويب
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");

function ffprobeBin() {
  return ffprobeStatic.path || ffprobeStatic;
}

// الثنائي قد يفقد صلاحية التنفيذ على الاستضافة — ننسخه إلى /tmp بصلاحية 755 عند الحاجة
function ensureExecutable(binPath, name) {
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return binPath;
  } catch {
    const tmpPath = path.join(os.tmpdir(), name);
    fs.copyFileSync(binPath, tmpPath);
    fs.chmodSync(tmpPath, 0o755);
    return tmpPath;
  }
}

function ffmpegPath() {
  return ensureExecutable(ffmpegStatic, "ffmpeg-run");
}
function ffprobePath() {
  return ensureExecutable(ffprobeBin(), "ffprobe-run");
}

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => {
      const s = d.toString();
      if (opts.onStdoutLine) {
        for (const line of s.split("\n")) opts.onStdoutLine(line);
      }
      stdout += s;
    });
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(bin)} exit=${code}: ${stderr.slice(-800)}`));
    });
  });
}

// استخراج دقة/مدة/معدل الإطارات/وجود صوت لكل مصدر
async function probeSource(filePath) {
  const { stdout } = await run(ffprobePath(), [
    "-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath,
  ]);
  const info = JSON.parse(stdout);
  const v = (info.streams || []).find((s) => s.codec_type === "video");
  const a = (info.streams || []).find((s) => s.codec_type === "audio");
  if (!v) throw new Error("المصدر لا يحتوي مسار فيديو صالح");
  return {
    width: v.width,
    height: v.height,
    duration: Number(v.duration || info.format?.duration || 0),
    fps: (() => {
      const [n, d] = (v.avg_frame_rate || "30/1").split("/").map(Number);
      return d ? n / d : 30;
    })(),
    hasAudio: !!a,
  };
}

function even(n) {
  return Math.max(2, Math.floor(n / 2) * 2);
}

// حساب أبعاد اللوحة: أكبر دقة بين المدخلات مع حد أقصى 1920×1080 (الحفاظ على النسبة)
function computeCanvas(probes) {
  const maxW = Math.max(...probes.map((p) => p.width));
  const maxH = Math.max(...probes.map((p) => p.height));
  let scale = 1;
  if (maxW > 1920 || maxH > 1080) {
    scale = Math.min(1920 / maxW, 1080 / maxH, 1);
  }
  return { w: even(maxW * scale), h: even(maxH * scale) };
}

async function mergeVideos({ sources, outPath, preset, onProgress }) {
  const ffmpeg = ffmpegPath();
  const probes = [];
  for (const s of sources) {
    probes.push(await probeSource(s.tmpPath));
  }
  const totalDuration = probes.reduce((a, p) => a + (p.duration || 0), 0);
  const canvas = computeCanvas(probes);

  const args = ["-hide_banner", "-y"];
  // مصدر بلا صوت → نضيف مسارًا صامتًا (anullsrc) بنفس عدد المدخلات بدل أن يفشل الدمج
  const silentInputs = [];
  sources.forEach((s, i) => {
    args.push("-i", s.tmpPath);
    if (!probes[i].hasAudio) silentInputs.push(i);
  });
  for (const i of silentInputs) {
    args.push("-f", "lavfi", "-t", String(Math.max(1, probes[i].duration || 5)), "-i", "anullsrc=r=44100:cl=stereo");
  }

  // بناء filter_complex: توحيد كل مسار فيديو إلى اللوحة المشتركة
  const fps = 30;
  const parts = [];
  sources.forEach((_, i) => {
    parts.push(
      `[${i}:v]scale=${canvas.w}:${canvas.h}:force_original_aspect_ratio=decrease,pad=${canvas.w}:${canvas.h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`
    );
    const audioIn = probes[i].hasAudio ? `${i}:a` : `${sources.length + silentInputs.indexOf(i)}:a`;
    if (probes[i].hasAudio) {
      parts.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      const silIdx = sources.length + silentInputs.indexOf(i);
      parts.push(`[${silIdx}:a]atrim=0:${Math.max(1, probes[i].duration || 5)},asetpts=PTS-STARTPTS[a${i}]`);
    }
  });
  // ترتيب مدخلات concat: مقطعًا-بمقطع (v ثم a لكل مقطع) وليس كل الفيديو ثم كل الصوت
  const segLabels = sources.map((_, i) => `[v${i}][a${i}]`).join("");
  parts.push(`${segLabels}concat=n=${sources.length}:v=1:a=1[vout][aout]`);
  args.push("-filter_complex", parts.join(";"), "-map", "[vout]", "-map", "[aout]");

  args.push(
    "-c:v", "libx264",
    "-preset", preset || process.env.FFMPEG_PRESET || "medium",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "44100",
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    "-nostats",
    outPath
  );

  // قراءة تقدم الترميز من out_time_us وربطه بالمدة الإجمالية (40→90)
  let lastEmit = 0;
  await run(ffmpeg, args, {
    onStdoutLine: (line) => {
      const m = line.match(/^out_time_us=(\d+)/);
      if (m && totalDuration > 0 && onProgress) {
        const now = Date.now();
        if (now - lastEmit > 1500) {
          lastEmit = now;
          const frac = Math.min(1, Number(m[1]) / 1e6 / totalDuration);
          onProgress(Math.round(40 + frac * 50));
        }
      }
    },
  });

  return { canvas, totalDuration };
}

module.exports = { mergeVideos, probeSource, ffmpegPath, ffprobePath, computeCanvas };
