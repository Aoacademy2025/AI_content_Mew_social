/**
 * normalize-stock-cache.mjs
 *
 * One-off backfill: re-encode every cached stock clip to the Remotion-safe
 * 30fps CFR / no-B-frame format so the compositor never throws
 * "No frame found at position X". Mirrors normalizeForRemotion() in
 * src/app/api/videos/fetch-stock/route.ts (same ffmpeg args, same marker file),
 * so already-done clips are skipped and the route stays idempotent afterwards.
 *
 * Run: node scripts/normalize-stock-cache.mjs
 */
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

const TARGET_FPS = 30;
const CONCURRENCY = 3; // keep CPU usable; encodes are heavy
// Match the route's default (STOCK_NORMALIZE_TIMEOUT_MS, 300s). Without a
// timeout one pathological clip hangs the whole backfill forever.
const TIMEOUT_MS = Number(process.env.STOCK_NORMALIZE_TIMEOUT_MS) || 300_000;
const ffmpeg = path.join(
  process.cwd(), "node_modules", "@ffmpeg-installer",
  `${process.platform}-${process.arch}`,
  `ffmpeg${process.platform === "win32" ? ".exe" : ""}`,
);
const stocksDir = path.join(process.cwd(), "stocks");

function safeUnlink(p) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {} }

async function normalize(filePath) {
  const marker = `${filePath}.normalized`;
  if (fs.existsSync(marker)) return "skip";
  const tmp = `${filePath}.norm.mp4`;
  try {
    await execFileAsync(ffmpeg, [
      "-y", "-i", filePath, "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-r", String(TARGET_FPS), "-g", String(TARGET_FPS), "-keyint_min", String(TARGET_FPS),
      "-bf", "0", "-vsync", "cfr", "-movflags", "+faststart", tmp,
    ], { maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT_MS, killSignal: "SIGKILL" });
    if (fs.existsSync(tmp) && fs.statSync(tmp).size > 1_500) {
      fs.renameSync(tmp, filePath);
      try { fs.writeFileSync(marker, ""); } catch {}
      return "ok";
    }
    safeUnlink(tmp);
    safeUnlink(filePath); // un-normalizable clip would crash Remotion — drop it
    return "fail";
  } catch (e) {
    safeUnlink(tmp);
    // Un-normalizable clips crash Remotion later ("Invalid data") — drop them.
    safeUnlink(filePath);
    console.warn(`  ! ${path.basename(filePath)}: dropped (${e.message?.slice(0, 120)})`);
    return "fail";
  }
}

const files = fs.readdirSync(stocksDir)
  .filter(f => f.endsWith(".mp4"))
  .map(f => path.join(stocksDir, f));

console.log(`Normalizing ${files.length} stock clips (concurrency=${CONCURRENCY})...`);
const counts = { ok: 0, skip: 0, fail: 0 };
let done = 0;
const queue = [...files];

async function worker() {
  while (queue.length) {
    const fp = queue.shift();
    const r = await normalize(fp);
    counts[r]++;
    done++;
    if (done % 50 === 0 || done === files.length) {
      console.log(`  ${done}/${files.length} — ok:${counts.ok} skip:${counts.skip} fail:${counts.fail}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`\nDone. ok:${counts.ok} skip:${counts.skip} fail:${counts.fail}`);
