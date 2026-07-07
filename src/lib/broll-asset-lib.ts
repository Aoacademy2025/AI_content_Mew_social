// ffmpeg normalize/Ken-Burns + stock-search (Pexels/Pixabay) machinery —
// extracted verbatim from `src/app/api/videos/fetch-stock/route.ts` (Task 5,
// 2026-07-07). Route files can't export non-handler symbols, so this shared
// plumbing lives here for reuse by fetch-stock and Phase 2's new routes.
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { fetchWithBudget } from "@/lib/fetch-budget";
import { pickPixabayVariant } from "@/lib/broll-source-quality";
import { kieCreateTask, kiePollResult, buildKieImageInput, type KieImageModel } from "@/lib/kie-client";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const execFileAsync = promisify(execFile);

function readConcurrencyEnv(name: string, fallback: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < 1) return fallback;
  return Math.max(1, Math.min(max, Math.floor(raw)));
}

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

// x264 speed preset for the Remotion-safe re-encode. `ultrafast` cuts encode CPU
// ~2-3× vs `veryfast` (the dominant cost of the b-roll step, which serializes through
// NORMALIZE_CONCURRENCY=1 — so a faster encode drains the queue faster for everyone
// when multiple users generate at once). Output stays CFR/no-B-frame/yuv420p (still
// Remotion-seekable); only the file is a bit larger. Env-tunable so it can be dialed
// back without a redeploy. Only known-good presets are accepted (no shell injection).
const X264_PRESETS = new Set([
  "ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow",
]);
function readPresetEnv(name: string, fallback: string): string {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return X264_PRESETS.has(raw) ? raw : fallback;
}

export const NORMALIZE_CONCURRENCY = readConcurrencyEnv("STOCK_NORMALIZE_CONCURRENCY", 1, 4);
// 300s default: long 4K source clips legitimately take minutes to re-encode;
// a SIGKILL'd encode must not be the common case (override via env, max 600s).
export const NORMALIZE_TIMEOUT_MS = readIntEnv("STOCK_NORMALIZE_TIMEOUT_MS", 300_000, 30_000, 600_000);
export const NORMALIZE_PRESET = readPresetEnv("STOCK_NORMALIZE_PRESET", "ultrafast");

let activeNormalizations = 0;
const normalizeWaiters: (() => void)[] = [];

async function withNormalizeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeNormalizations >= NORMALIZE_CONCURRENCY) {
    await new Promise<void>((resolve) => normalizeWaiters.push(resolve));
  } else {
    activeNormalizations++;
  }
  try {
    return await fn();
  } finally {
    const next = normalizeWaiters.shift();
    if (next) {
      next();
    } else {
      activeNormalizations = Math.max(0, activeNormalizations - 1);
    }
  }
}

// Remotion's compositor seeks frame-accurately and fails with
// "No frame found at position X" on clips that use B-frames or whose fps
// doesn't match the composition (Pexels/Pixabay ship 25fps + B-frames).
// Re-encode every downloaded clip to a clean 30fps CFR, no-B-frame stream
// with a keyframe every frame so seeking is always exact.
const TARGET_FPS = 30;
// We can't rely on ffprobe (the Windows @ffmpeg-installer package ships none)
// to detect whether a cached clip is already normalized, so drop a tiny marker
// file next to each clip after a successful re-encode. Cheap and unambiguous.
export function normalizedMarkerPath(filePath: string): string {
  return `${filePath}.normalized`;
}

export type NormalizeResult = { status: "skipped" | "normalized" | "failed"; durationMs: number };

export async function normalizeForRemotion(filePath: string): Promise<NormalizeResult> {
  const startedAt = Date.now();
  const marker = normalizedMarkerPath(filePath);
  if (fs.existsSync(marker)) return { status: "skipped", durationMs: 0 }; // already normalized in a previous run
  const ffmpeg = getFfmpegPath();
  const tmp = `${filePath}.norm.mp4`;
  try {
    safeUnlink(tmp);
    await withNormalizeSlot(() => execFileAsync(ffmpeg, [
      "-y", "-i", filePath,
      "-an",                              // B-roll is muted in render anyway
      // Downscale oversized sources (e.g. Pixabay 4K) to fit a 1080×1920 box
      // BEFORE the libx264 re-encode. A full 4096×2160 normalize on the GPU-less
      // VPS can blow past NORMALIZE_TIMEOUT_MS → SIGKILL → ~5 min of CPU burned on
      // a clip that gets dropped anyway (and the render output is only 1080×1920,
      // so extra resolution is wasted). decrease = never upscale; the trailing
      // trunc pair forces even dimensions (yuv420p requires it) and is compatible
      // with the prod ffmpeg 4.4 (avoids the newer force_divisible_by option).
      "-vf", "scale='min(1080,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v", "libx264", "-preset", NORMALIZE_PRESET, "-crf", "20",
      "-threads", "2",                     // bound CPU so one normalize can't starve the in-process render
      "-pix_fmt", "yuv420p",
      "-r", String(TARGET_FPS),           // force constant frame rate
      "-g", String(TARGET_FPS),           // keyframe interval = 1s
      "-keyint_min", String(TARGET_FPS),
      "-bf", "0",                          // no B-frames → in-order PTS
      "-vsync", "cfr",
      "-movflags", "+faststart",
      tmp,
    ], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: NORMALIZE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    }));
    // Swap normalized file in only if it produced a valid result
    if (fs.existsSync(tmp) && fs.statSync(tmp).size > 1_500) {
      fs.renameSync(tmp, filePath);
      try { fs.writeFileSync(marker, ""); } catch {}
      return { status: "normalized", durationMs: Date.now() - startedAt };
    } else {
      safeUnlink(tmp);
      return { status: "failed", durationMs: Date.now() - startedAt };
    }
  } catch (e) {
    // Normalization failed (timeout/SIGKILL or bad input). Callers DROP the
    // clip — an un-normalized file crashes Remotion later ("Invalid data").
    console.warn(`[fetch-stock] normalize failed for ${path.basename(filePath)}:`, e);
    safeUnlink(tmp);
    return { status: "failed", durationMs: Date.now() - startedAt };
  }
}

export interface PexelsVideoFile {
  quality: string;
  file_type: string;
  width: number;
  height: number;
  link: string;
}

export interface PexelsVideo {
  id: number;
  duration: number;
  width: number;
  height: number;
  url: string;   // e.g. https://www.pexels.com/video/woman-cooking-soup-1234567/
  image?: string; // poster frame — used by the vision re-rank
  video_files: PexelsVideoFile[];
}

// Search Pexels for portrait videos ≥ minDuration seconds (max perPage = 80)
export async function searchPexels(query: string, apiKey: string, minDuration = 3, perPage = 15, page = 1): Promise<PexelsVideo[]> {
  const params = new URLSearchParams({
    query,
    orientation: "portrait",
    size: "medium",
    per_page: String(Math.min(80, perPage)),
    min_duration: String(minDuration),
    page: String(page),
  });

  // Stock-search budget: 20s/attempt, 2 retries (429 honors Retry-After).
  // Final non-ok throws ProviderError — existing callers already treat a
  // throw as "no candidates for this keyword".
  const res = await fetchWithBudget(`https://api.pexels.com/videos/search?${params}`, {
    headers: { Authorization: apiKey },
  }, { provider: "pexels", timeoutMs: 20_000, retries: 2, wallClockMs: 60_000 });
  const data = await res.json();
  return (data.videos ?? []) as PexelsVideo[];
}

export function safeUnlink(filePath: string) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

export function isValidMp4Path(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const size = fs.statSync(filePath).size;
    return size > 1_500; // ignore empty/truncated files
  } catch {
    return false;
  }
}

export async function downloadAndCrop(url: string, outPath: string): Promise<void> {
  const MAX_ATTEMPTS = 4;
  const TIMEOUT_MS = 120_000; // 120s — Pixabay CDN บางไฟล์ใหญ่ช้ามาก (PR-5 stock-download budget)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const tmp = `${outPath}.part`;
    try {
      // retries: 0 — downloadAndCrop's own MAX_ATTEMPTS loop already retries
      // (it also re-validates the file on disk, which fetchWithBudget can't).
      const res = await fetchWithBudget(url, {
        headers: {
          // บาง CDN บล็อก bot — ใส่ User-Agent เหมือน browser
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        },
      }, { provider: "stock-cdn", timeoutMs: TIMEOUT_MS, retries: 0, wallClockMs: TIMEOUT_MS + 5_000 });

      const data = Buffer.from(await res.arrayBuffer());
      if (data.length < 1_500) {
        throw new Error(`Downloaded file too small: ${data.length} bytes`);
      }

      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, outPath);

      if (!isValidMp4Path(outPath)) {
        throw new Error(`Downloaded file failed validation (${outPath})`);
      }

      return;
    } catch (err) {
      safeUnlink(tmp);
      safeUnlink(outPath);
      if (attempt >= MAX_ATTEMPTS) throw err;
      const delay = attempt === 1 ? 2000 : attempt === 2 ? 5000 : 10000;
      console.warn(`[fetch-stock] download retry ${attempt + 1}/${MAX_ATTEMPTS} (wait ${delay / 1000}s): ${url}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new Error(`Download failed after ${MAX_ATTEMPTS} attempts`);
}

export type PixabayVideo = { id: number; duration: number; videoUrl: string; width?: number; height?: number; tags?: string; thumb?: string };

// Search Pixabay for portrait videos
export async function searchPixabay(query: string, pixabayKey: string, minDuration = 5, perPage = 15): Promise<PixabayVideo[]> {
  const params = new URLSearchParams({
    key: pixabayKey,
    q: query,
    video_type: "film",
    orientation: "vertical",
    // Honor the caller's perPage (was hardcoded 15) so per-subtitle search gets a
    // deeper pool to rank — better/less-repetitive picks. Pixabay allows 3–200.
    per_page: String(Math.max(3, Math.min(200, perPage))),
    min_duration: String(minDuration),
  });
  const res = await fetchWithBudget(`https://pixabay.com/api/videos/?${params}`, {},
    { provider: "pixabay", timeoutMs: 20_000, retries: 2, wallClockMs: 60_000 });
  const data = await res.json();
  return (data.hits ?? []).map((h: { id: number; duration: number; videos: { medium?: { url: string; width?: number; height?: number; thumbnail?: string }; large?: { url: string; width?: number; height?: number; thumbnail?: string } }; tags?: string }) => {
    // #8 soft resolution floor: prefer medium (avoids 4K, respects #63), but fall up
    // to large when medium is sub-720p and large stays ≤1920 — keeps soft/upscaled
    // clips out without reintroducing the 4K download #63 removed.
    const v = pickPixabayVariant(h.videos?.medium, h.videos?.large);
    return {
      id: h.id,
      duration: h.duration,
      videoUrl: v.url,
      width: v.width,
      height: v.height,
      tags: (h.tags ?? "").slice(0, 160), // richer tag string → better LLM ranking of Pixabay clips
      thumb: h.videos?.medium?.thumbnail ?? h.videos?.large?.thumbnail,
    };
  }).filter((v: PixabayVideo) =>
    // PORTRAIT-ONLY belt (2026-07-03, same rationale as pickBestFile): drop variants that
    // are provably landscape; keep unknown-dimension hits (orientation=vertical search).
    v.videoUrl && !(Number(v.width) > 0 && Number(v.height) > 0 && Number(v.width) > Number(v.height)),
  );
}

export const KEN_BURNS_DURATION_SEC = 5;
const KEN_BURNS_WIDTH = 1080;
const KEN_BURNS_HEIGHT = 1920;

// แปลงภาพนิ่ง 1 ภาพเป็นวิดีโอแนวตั้งด้วย Ken Burns effect (ffmpeg zoompan: pan+zoom ช้าๆ)
export async function applyKenBurns(imagePath: string, outPath: string): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const totalFrames = KEN_BURNS_DURATION_SEC * TARGET_FPS;
  // Cover-crop to 9:16 BEFORE zoompan so non-9:16 stills (landscape photos, kie
  // images off-ratio) get cropped like everywhere else (objectFit:"cover"),
  // never stretched. Scale to a larger 1350x2400 (9:16) intermediate first so
  // the zoompan zoom stays crisp, then crop to that exact box; zoompan then
  // does its usual zoom/pan and downsamples to the final 1080x1920 output.
  const zoompan = `scale=1350:2400:force_original_aspect_ratio=increase,crop=1350:2400,zoompan=z='min(zoom+0.0007,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${KEN_BURNS_WIDTH}x${KEN_BURNS_HEIGHT}:fps=${TARGET_FPS}`;
  const tmp = `${outPath}.kb.mp4`;
  safeUnlink(tmp);
  await withNormalizeSlot(() => execFileAsync(ffmpeg, [
    "-y", "-loop", "1", "-i", imagePath,
    "-vf", zoompan,
    "-t", String(KEN_BURNS_DURATION_SEC),
    "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-r", String(TARGET_FPS),
    "-g", String(TARGET_FPS),
    "-keyint_min", String(TARGET_FPS),
    "-bf", "0",
    "-vsync", "cfr",
    "-movflags", "+faststart",
    tmp,
  ], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: NORMALIZE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  }));
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size <= 1_500) {
    safeUnlink(tmp);
    throw new Error("Ken Burns ffmpeg produced an empty/invalid output");
  }
  fs.renameSync(tmp, outPath);
}

// Generate 1 image (text-to-image, model เลือกได้) จาก keyword/subtitle แล้ว
// แปลงเป็นวิดีโอแนวตั้งด้วย Ken Burns effect (ffmpeg pan/zoom, ~5s) แทน Kling.
export async function generateKieImageKenBurns(
  prompt: string,
  label: string,
  token: string,
  model: KieImageModel,
  imagePath: string,
  outPath: string,
): Promise<{ duration: number; imageUrl: string }> {
  const imageTaskId = await kieCreateTask(model, buildKieImageInput(model, prompt), token);
  const imageUrl = await kiePollResult(imageTaskId, token);
  console.log(`[fetch-stock] kie image ready for "${label}": ${imageUrl.slice(0, 80)}`);

  await downloadAndCrop(imageUrl, imagePath);
  console.log(`[fetch-stock] kie cropped "${label}" → ${imagePath.split(/[/\\]/).pop()}`);
  await applyKenBurns(imagePath, outPath);
  console.log(`[fetch-stock] kie Ken Burns done "${label}" → ${outPath.split(/[/\\]/).pop()}`);

  return { duration: KEN_BURNS_DURATION_SEC, imageUrl };
}
