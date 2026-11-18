// GET /api/jobs/{id}/video — بث الناتج من Blobs Turso مع دعم Range (206) و ?download=1
const { apiError, baseUrlOf } = require("../../../lib/utils");
const dbmod = require("../../../lib/db");
const { streamOutputRange, outputBlobSize } = require("../../../lib/storage");

module.exports = async (req, res) => {
  if (req.method !== "GET") return apiError(res, 405, "طريقة الطلب غير مدعومة");
  const id = req.query.id;
  if (!id) return apiError(res, 400, "معرّف المهمة مطلوب");

  const job = await dbmod.getJob(id);
  if (!job || job.status !== "done") {
    return apiError(res, 404, "الفيديو الناتج غير متاح (المهمة غير موجودة أو لم تكتمل بعد)");
  }

  const total = await outputBlobSize(id);
  if (!total) return apiError(res, 404, "لا يوجد ناتج مخزن لهذه المهمة");

  const rangeHeader = req.headers.range;
  const download = req.query.download === "1";
  const filename = `merged-${id}.mp4`;
  const headersBase = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  if (download) headersBase["Content-Disposition"] = `attachment; filename="${filename}"`;

  if (rangeHeader) {
    // دعم Range ليعمل التقديم/الترجيع في المشغل
    const m = String(rangeHeader).match(/bytes=(\d*)-(\d*)/);
    let start = 0;
    let end = total - 1;
    if (m) {
      if (m[1] !== "") start = parseInt(m[1], 10);
      if (m[2] !== "") end = Math.min(parseInt(m[2], 10), total - 1);
      if (m[1] === "" && m[2] !== "") {
        // لاحقة: آخر N بايت
        start = Math.max(0, total - parseInt(m[2], 10));
      }
    }
    if (start >= total || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      return res.end();
    }
    res.writeHead(206, {
      ...headersBase,
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": end - start + 1,
    });
    const stream = streamOutputRange("output_chunks", id, start, end);
    stream.pipe(res);
    stream.on("error", () => res.destroy());
    return;
  }

  res.writeHead(200, { ...headersBase, "Content-Length": total });
  const stream = streamOutputRange("output_chunks", id, 0, total - 1);
  stream.pipe(res);
  stream.on("error", () => res.destroy());
};
