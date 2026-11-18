// تحميل .env يدويًا (بدون اعتماديات خارجية) — لا نستبدل متغيرًا موجودًا مسبقًا
const fs = require("fs");
const path = require("path");

let loaded = false;
function loadEnv() {
  if (loaded) return;
  loaded = true;
  try {
    const envPath = path.join(__dirname, "..", ".env");
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let val = m[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!(m[1] in process.env)) process.env[m[1]] = val;
      }
    }
  } catch (e) {
    // تجاهل غياب .env في الإنتاج (Vercel يوفر المتغيرات)
  }
}
module.exports = { loadEnv };
