import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { geminiGenerateText } from "@/lib/gemini";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { recordTelemetryEvent } from "@/lib/telemetry";
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

const SEARCH_CONCURRENCY = readConcurrencyEnv("STOCK_SEARCH_CONCURRENCY", 8, 20);
const DOWNLOAD_CONCURRENCY = readConcurrencyEnv("STOCK_DOWNLOAD_CONCURRENCY", 2, 6);
const NORMALIZE_CONCURRENCY = readConcurrencyEnv("STOCK_NORMALIZE_CONCURRENCY", 1, 4);
const NORMALIZE_TIMEOUT_MS = readIntEnv("STOCK_NORMALIZE_TIMEOUT_MS", 120_000, 30_000, 600_000);
const PER_SUBTITLE_DOWNLOAD_LIMIT = readIntEnv("STOCK_PER_SUBTITLE_DOWNLOAD_LIMIT", 36, 6, 120);

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
function normalizedMarkerPath(filePath: string): string {
  return `${filePath}.normalized`;
}

type NormalizeResult = { status: "skipped" | "normalized" | "failed"; durationMs: number };

async function normalizeForRemotion(filePath: string): Promise<NormalizeResult> {
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
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
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
    // If normalization fails, keep the original download rather than losing the clip
    console.warn(`[fetch-stock] normalize failed for ${path.basename(filePath)}, keeping original:`, e);
    safeUnlink(tmp);
    return { status: "failed", durationMs: Date.now() - startedAt };
  }
}

export const maxDuration = 600;
export const runtime = "nodejs";

interface PexelsVideoFile {
  quality: string;
  file_type: string;
  width: number;
  height: number;
  link: string;
}

interface PexelsVideo {
  id: number;
  duration: number;
  width: number;
  height: number;
  url: string;   // e.g. https://www.pexels.com/video/woman-cooking-soup-1234567/
  video_files: PexelsVideoFile[];
}

// Extract human-readable slug from Pexels video URL
// "https://www.pexels.com/video/woman-cooking-soup-1234567/" → "woman cooking soup"
function slugToTitle(url: string): string {
  try {
    const slug = new URL(url).pathname.replace(/^\/video\//, "").replace(/\/$/, "");
    // Remove trailing numeric ID
    return slug.replace(/-\d+$/, "").replace(/-/g, " ").trim();
  } catch {
    return "";
  }
}

// Search Pexels for portrait videos ≥ minDuration seconds (max perPage = 80)
async function searchPexels(query: string, apiKey: string, minDuration = 3, perPage = 15, page = 1): Promise<PexelsVideo[]> {
  const params = new URLSearchParams({
    query,
    orientation: "portrait",
    size: "medium",
    per_page: String(Math.min(80, perPage)),
    min_duration: String(minDuration),
    page: String(page),
  });

  const res = await fetch(`https://api.pexels.com/videos/search?${params}`, {
    headers: { Authorization: apiKey },
  });

  if (!res.ok) throw new Error(`Pexels search failed: ${res.status}`);
  const data = await res.json();
  return (data.videos ?? []) as PexelsVideo[];
}

// Pick best video file: prefer HD portrait ≤1080p, fallback to any
// Cap at 1920px on the long side — 4K files (2160p) are too large to download reliably
function pickBestFile(video: PexelsVideo): PexelsVideoFile | null {
  const files = video.video_files.filter(f => f.file_type === "video/mp4");
  const under1080 = (f: PexelsVideoFile) => Math.max(f.width, f.height) <= 1920;
  const portrait = files.filter(f => f.height > f.width);
  const hdPortrait = portrait.filter(under1080).find(f => f.quality === "hd")
    ?? portrait.filter(under1080)[0];
  if (hdPortrait) return hdPortrait;
  if (portrait[0]) return portrait[0]; // fallback: any portrait even if large
  const hd = files.filter(under1080).find(f => f.quality === "hd") ?? files.filter(under1080)[0];
  if (hd) return hd;
  return files[0] ?? null;
}

function safeUnlink(filePath: string) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

function cleanupStaleTempFiles(dir: string, prefix: string, maxAgeMs: number): number {
  let deleted = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      if (!name.endsWith(".part") && !name.endsWith(".norm.mp4")) continue;
      const filePath = path.join(dir, name);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs <= maxAgeMs) continue;
      safeUnlink(filePath);
      deleted++;
    }
  } catch {}
  return deleted;
}

function isValidMp4Path(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const size = fs.statSync(filePath).size;
    return size > 1_500; // ignore empty/truncated files
  } catch {
    return false;
  }
}

async function downloadAndCrop(url: string, outPath: string): Promise<void> {
  const MAX_ATTEMPTS = 4;
  const TIMEOUT_MS = 90_000; // 90s — Pixabay CDN บางไฟล์ใหญ่ช้ามาก

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const tmp = `${outPath}.part`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          // บาง CDN บล็อก bot — ใส่ User-Agent เหมือน browser
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        },
      });
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);

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

// Search Pixabay for portrait videos
async function searchPixabay(query: string, pixabayKey: string, minDuration = 5): Promise<{ id: number; duration: number; videoUrl: string; tags: string }[]> {
  const params = new URLSearchParams({
    key: pixabayKey,
    q: query,
    video_type: "film",
    orientation: "vertical",
    per_page: "15",
    min_duration: String(minDuration),
  });
  const res = await fetch(`https://pixabay.com/api/videos/?${params}`);
  if (!res.ok) throw new Error(`Pixabay search failed: ${res.status}`);
  const data = await res.json();
  return (data.hits ?? []).map((h: { id: number; duration: number; videos: { medium?: { url: string }; large?: { url: string } }; tags?: string }) => ({
    id: h.id,
    duration: h.duration,
    videoUrl: h.videos?.large?.url ?? h.videos?.medium?.url ?? "",
    tags: (h.tags ?? "").slice(0, 60),
  })).filter((v: { videoUrl: string }) => v.videoUrl);
}

// LLM rank: given subtitle texts and candidate titles per keyword,
// return the best-matching candidate index for each keyword.
// Batched in chunks of RANK_BATCH_SIZE to handle long scripts reliably.
const RANK_BATCH_SIZE = 30;

async function llmRankBatch(
  keywords: string[],
  subtitleTexts: string[],
  candidateTitles: string[][],
  llmKey: string,
  visualDirection?: string,
): Promise<number[]> {
  const lines = keywords.map((kw, ki) => {
    const sub = subtitleTexts[ki] ?? kw;
    const titles = candidateTitles[ki].map((t, i) => `${i}:${t || "untitled"}`).join("|");
    return `${ki}. subtitle="${sub}" candidates=[${titles}]`;
  });

  const directionLine = visualDirection
    ? `\nVIDEO DIRECTION: ${visualDirection}\nPrioritize candidates that match this overall visual tone/theme.\n`
    : "";

  const prompt = `You are a B-roll video editor. For each subtitle, pick the candidate video index (0-based) that BEST matches the subtitle's visual content AND the overall video direction.
${directionLine}
RULES:
- Output ONLY a JSON array of integers, one per subtitle, same order
- Pick the index whose title most literally matches what is described in the subtitle
- Prefer candidates that fit the VIDEO DIRECTION tone (mood, setting, energy)
- Prefer concrete, specific matches over generic ones
- If no candidate fits well, pick index 0

${lines.join("\n")}

OUTPUT (JSON array of ${keywords.length} integers):`;

  // max_tokens: each integer + comma is ~3 tokens; 10 tokens overhead
  const maxTokens = Math.max(128, keywords.length * 4 + 20);
  const text = await geminiGenerateText(llmKey, prompt, maxTokens, 0);

  let parsed: unknown[] = [];
  const arrMatch = text.match(/\[[\d,\s]+\]/);
  if (arrMatch) {
    parsed = JSON.parse(arrMatch[0]);
  } else {
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
      const obj = JSON.parse(objMatch[0]);
      const arr = Array.isArray(obj) ? obj : Object.values(obj).find(v => Array.isArray(v));
      if (Array.isArray(arr)) parsed = arr;
    }
  }

  if (parsed.length !== keywords.length) {
    console.warn(`[fetch-stock] LLM ranking length mismatch: got ${parsed.length}, expected ${keywords.length} — using longest-duration fallback`);
    return keywords.map(() => 0);
  }

  return parsed.map((v, i) => {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    const maxIdx = (candidateTitles[i]?.length ?? 1) - 1;
    return isNaN(n) ? 0 : Math.max(0, Math.min(n, maxIdx));
  });
}

async function llmRankCandidates(
  keywords: string[],
  subtitleTexts: string[],
  candidateTitles: string[][],
  llmKey: string,
  visualDirection?: string,
): Promise<number[]> {
  if (keywords.length <= RANK_BATCH_SIZE) {
    return llmRankBatch(keywords, subtitleTexts, candidateTitles, llmKey, visualDirection);
  }

  // Split into chunks and call sequentially to avoid LLM output-length limits
  const results: number[] = new Array(keywords.length).fill(0);
  for (let start = 0; start < keywords.length; start += RANK_BATCH_SIZE) {
    const end = Math.min(start + RANK_BATCH_SIZE, keywords.length);
    const chunkKws = keywords.slice(start, end);
    const chunkSubs = subtitleTexts.slice(start, end);
    const chunkTitles = candidateTitles.slice(start, end);
    console.log(`[fetch-stock] LLM ranking chunk ${start}-${end - 1} of ${keywords.length}`);
    try {
      const chunkResult = await llmRankBatch(chunkKws, chunkSubs, chunkTitles, llmKey, visualDirection);
      for (let i = 0; i < chunkResult.length; i++) {
        results[start + i] = chunkResult[i];
      }
    } catch (e) {
      console.warn(`[fetch-stock] LLM chunk ${start}-${end - 1} failed:`, e);
      // Keep default 0 for this chunk
    }
  }
  return results;
}

// POST /api/videos/fetch-stock
export async function POST(req: Request) {
  const routeStartedAt = Date.now();
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = authUser.id;

  const body = await req.json().catch(() => null);
  const {
    keywords,
    keywordAlternatives,
    download = false,
    totalDurationSec = 0,
    overrideClipCount = 0,
    stockSource = "both",
    subtitleTexts,
    perSubtitleMode: perSubtitleFlag = false,
    fullScript,
    visualDirection,
  }: {
    keywords: string[];
    keywordAlternatives?: string[][];
    download?: boolean;
    totalDurationSec?: number;
    overrideClipCount?: number;
    stockSource?: string;
    subtitleTexts?: string[];
    perSubtitleMode?: boolean;
    fullScript?: string;
    visualDirection?: string;
  } = body ?? {};

  const usePexels = stockSource === "pexels" || stockSource === "both";
  const usePixabay = stockSource === "pixabay" || stockSource === "both";

  if (!keywords?.length) return NextResponse.json({ error: "keywords required" }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { id: authUser.id },
    select: { pixabayKey: true, pexelsKey: true, geminiKey: true, ttsProvider: true },
  });
  const pexelsKey = user?.pexelsKey ? Buffer.from(user.pexelsKey, "base64").toString("utf-8") : null;
  const pixabayKey = user?.pixabayKey ? Buffer.from(user.pixabayKey, "base64").toString("utf-8") : null;

  const canUsePexels = usePexels && !!pexelsKey;
  const canUsePixabay = usePixabay && !!pixabayKey;

  if (!canUsePexels && !canUsePixabay) {
    const needPexels = usePexels;
    const needPixabay = usePixabay;
    if (needPexels && needPixabay) {
      return NextResponse.json(
        { error: "No usable stock source configured. Add Pexels or Pixabay key in Settings > API Keys", missingKey: stockSource === "both" ? "pexels" : (needPexels ? "pexels" : "pixabay") },
        { status: 400 },
      );
    }
    if (needPexels) return NextResponse.json({ error: "Pexels API key ยังไม่ได้ตั้งค่า — ไปที่ Settings > API Keys", missingKey: "pexels" }, { status: 400 });
    return NextResponse.json({ error: "Pixabay API key ยังไม่ได้ตั้งค่า — ไปที่ Settings", missingKey: "pixabay" }, { status: 400 });
  }

  if (usePexels && !canUsePexels) {
    console.log("[fetch-stock] Pexels requested but key missing; continuing with Pixabay only");
  }
  if (usePixabay && !canUsePixabay) {
    console.log("[fetch-stock] Pixabay requested but key missing; continuing with Pexels only");
  }

  const llmKey = user?.geminiKey ? Buffer.from(user.geminiKey, "base64").toString("utf-8") : null;

  function avgCutSec(dur: number): number {
    if (dur <= 10) return 5;
    if (dur <= 20) return 4;
    if (dur <= 40) return 3.5;
    return 2.5;
  }
  void avgCutSec; // used for future adaptive logic

  const BUFFER = 1.6; // เผื่อ clip บางตัว download ไม่ได้
  // ใช้ avg 3.5s/clip (realistic สำหรับ stock portrait) แทน 2.0s
  const autoClipsNeeded = totalDurationSec > 0
    ? Math.max(keywords.length, Math.ceil((totalDurationSec / 3.5) * BUFFER))
    : keywords.length;
  const totalClipsNeeded = overrideClipCount > 0 ? overrideClipCount : autoClipsNeeded;
  const cappedClipsNeeded = Math.min(totalClipsNeeded, overrideClipCount > 0 ? 500 : 400);
  const subtitleCount = Array.isArray(subtitleTexts) ? subtitleTexts.length : 0;
  const subtitleCountMatchesKeywords = subtitleCount > 0 && subtitleCount === keywords.length;
  const isPerSubtitleMode = perSubtitleFlag ||
    subtitleCountMatchesKeywords ||
    (overrideClipCount > 0 && overrideClipCount === keywords.length);
  const downloadClipLimit = isPerSubtitleMode
    ? Math.max(1, Math.min(
        keywords.length,
        overrideClipCount > 0 ? overrideClipCount : subtitleCount || keywords.length,
        PER_SUBTITLE_DOWNLOAD_LIMIT,
      ))
    : cappedClipsNeeded;
  const clipsPerKeyword = keywords.length > 0
    ? Math.min(15, Math.max(1, Math.ceil(downloadClipLimit / keywords.length)))
    : 1;

  console.log(`[fetch-stock] duration=${totalDurationSec}s need=${totalClipsNeeded} clips${overrideClipCount > 0 ? " (manual)" : " (auto)"}, limit=${downloadClipLimit}, ${clipsPerKeyword}/keyword over ${keywords.length} keywords${isPerSubtitleMode ? " (per-subtitle)" : ""}`);

  const rendersDir = path.join(process.cwd(), "stocks");
  fs.mkdirSync(rendersDir, { recursive: true });

  const userPrefix = `stock-${userId}-`;
  const staleTempDeleted = cleanupStaleTempFiles(rendersDir, userPrefix, 30 * 60 * 1000);
  if (staleTempDeleted > 0) {
    console.log(`[fetch-stock] cleaned ${staleTempDeleted} stale temp files`);
  }

  const stockTelemetry = {
    searchQueries: 0,
    pexelsCandidates: 0,
    pixabayCandidates: 0,
    searchCandidatesTotal: 0,
    keywordsWithCandidates: 0,
    noCandidateKeywords: 0,
    page2CandidateHits: 0,
    llmRankingUsed: false,
    llmRankingFailed: false,
    foundCount: 0,
    cappedCount: 0,
    selectedPexelsCount: 0,
    selectedPixabayCount: 0,
    cacheHitCount: 0,
    downloadedCount: 0,
    downloadFailCount: 0,
    servedClipCount: 0,
    normalizeRanCount: 0,
    normalizeSkippedCount: 0,
    normalizeFailedCount: 0,
    normalizeMsTotal: 0,
  };

  function applyNormalizeTelemetry(result: NormalizeResult) {
    stockTelemetry.normalizeMsTotal += result.durationMs;
    if (result.status === "normalized") stockTelemetry.normalizeRanCount++;
    if (result.status === "skipped") stockTelemetry.normalizeSkippedCount++;
    if (result.status === "failed") stockTelemetry.normalizeFailedCount++;
  }

  const srcLabel = canUsePexels && canUsePixabay ? "Pexels+Pixabay" : canUsePexels ? "Pexels" : "Pixabay";

  async function recordFetchStockTelemetry(status: "done" | "error", extra: Record<string, unknown> = {}) {
    const normalizeAttempts = stockTelemetry.normalizeRanCount + stockTelemetry.normalizeFailedCount;
    await recordTelemetryEvent(userId, {
      name: status === "done" ? "fetch_stock_server_done" : "fetch_stock_server_error",
      category: status === "done" ? "performance" : "error",
      source: "server",
      step: "fetchStock",
      status,
      durationMs: Date.now() - routeStartedAt,
      properties: {
        stockSource,
        resolvedSource: srcLabel,
        download,
        keywordCount: keywords.length,
        subtitleCount,
        isPerSubtitleMode,
        totalDurationSec: Math.round(Number(totalDurationSec) || 0),
        overrideClipCount,
        totalClipsNeeded,
        downloadClipLimit,
        clipsPerKeyword,
        canUsePexels,
        canUsePixabay,
        searchConcurrency: SEARCH_CONCURRENCY,
        downloadConcurrency: DOWNLOAD_CONCURRENCY,
        normalizeConcurrency: NORMALIZE_CONCURRENCY,
        normalizeTimeoutMs: NORMALIZE_TIMEOUT_MS,
        perSubtitleDownloadLimit: PER_SUBTITLE_DOWNLOAD_LIMIT,
        staleTempDeleted,
        normalizeMsAvg: normalizeAttempts > 0 ? Math.round(stockTelemetry.normalizeMsTotal / normalizeAttempts) : 0,
        ...stockTelemetry,
        ...extra,
      },
    }).catch(() => {});
  }

  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  try {
    for (const f of fs.readdirSync(rendersDir)) {
      if (!f.startsWith(userPrefix) || !f.endsWith(".mp4")) continue;
      const fp = path.join(rendersDir, f);
      if (Date.now() - fs.statSync(fp).mtimeMs > MAX_AGE_MS) {
        fs.unlinkSync(fp);
        safeUnlink(normalizedMarkerPath(fp)); // drop its normalize marker too
      }
    }
  } catch {}

  const results: {
    keyword: string;
    pexelsId: number;
    duration: number;
    videoUrl: string;
    localPath?: string;
    localUrl?: string;
  }[] = [];

  const usedIds = new Set<number>();

  async function withConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length > 0) { const item = queue.shift()!; await fn(item); }
    });
    await Promise.all(workers);
  }

  async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await fn(items[index]!, index);
      }
    });
    await Promise.all(workers);
    return results;
  }

  type FoundVideo = { keyword: string; id: number; duration: number; link: string };
  // Extended candidate that keeps Pexels URL slug for LLM ranking
  type CandidateVideo = FoundVideo & { title: string };

  console.log(`[fetch-stock] source=${srcLabel}`);

  // Pexels supports up to 80 per page — use that headroom for long videos
  const basePerPage = isPerSubtitleMode ? 15 : Math.min(80, Math.max(15, clipsPerKeyword * 5));

  // ── Search phase — try keyword alternatives in order until candidates found ──
  const candidatesByKeyword: CandidateVideo[][] = await mapWithConcurrency(
    keywords,
    SEARCH_CONCURRENCY,
    async (keyword, ki): Promise<CandidateVideo[]> => {
      // Build list of queries to try: alternatives first, then broad fallbacks
      const alts = keywordAlternatives?.[ki] ?? [];
      const queriesToTry = [
        ...alts.filter(Boolean),
        keyword,
        keyword.split(" ").slice(0, 2).join(" "),
        keyword.split(" ")[0],
      ].filter((q, idx, arr) => q && arr.indexOf(q) === idx); // deduplicate

      try {
        for (const query of queriesToTry) {
          console.log(`[fetch-stock] searching "${query}" (perPage=${basePerPage}) from ${srcLabel}`);
          stockTelemetry.searchQueries++;

          const [pexelsRaw, pixabayRaw] = await Promise.allSettled([
            canUsePexels
              ? searchPexels(query, pexelsKey!, 3, basePerPage)
              : Promise.resolve([] as PexelsVideo[]),
            canUsePixabay
              ? searchPixabay(query, pixabayKey).catch(() => [] as { id: number; duration: number; videoUrl: string }[])
              : Promise.resolve([] as { id: number; duration: number; videoUrl: string }[]),
          ]);

          const pexelsVideos = pexelsRaw.status === "fulfilled" ? pexelsRaw.value : [];
          const pixabayVideos = pixabayRaw.status === "fulfilled" ? pixabayRaw.value : [];
          stockTelemetry.pexelsCandidates += pexelsVideos.length;
          stockTelemetry.pixabayCandidates += pixabayVideos.length;

          const candidates: CandidateVideo[] = [];
          for (const v of pexelsVideos) {
            const file = pickBestFile(v);
            if (!file) continue;
            const title = slugToTitle(v.url ?? "");
            candidates.push({ keyword, id: v.id, duration: v.duration, link: file.link, title });
          }
          for (const pv of pixabayVideos as { id: number; duration: number; videoUrl: string; tags?: string }[]) {
            // Use Pixabay tags as title for LLM ranking — much more descriptive than query alone
            const pbTitle = pv.tags ? pv.tags.split(",").slice(0, 4).map((t: string) => t.trim()).join(" ") : query;
            candidates.push({ keyword, id: pv.id + 9_000_000, duration: pv.duration, link: pv.videoUrl, title: pbTitle });
          }

          if (candidates.length > 0) {
            stockTelemetry.searchCandidatesTotal += candidates.length;
            stockTelemetry.keywordsWithCandidates++;
            console.log(`[fetch-stock] "${query}": ${candidates.length} candidates (used alt ${queriesToTry.indexOf(query) + 1}/${queriesToTry.length})`);
            return candidates;
          }
        }

        // Last resort: try page 2 of the first query for fresh IDs
        if (canUsePexels && queriesToTry[0]) {
          try {
            const page2 = await searchPexels(queriesToTry[0], pexelsKey!, 3, basePerPage, 2);
            const candidates: CandidateVideo[] = [];
            stockTelemetry.searchQueries++;
            stockTelemetry.pexelsCandidates += page2.length;
            for (const v of page2) {
              const file = pickBestFile(v);
              if (!file) continue;
              candidates.push({ keyword, id: v.id, duration: v.duration, link: file.link, title: slugToTitle(v.url ?? "") });
            }
            if (candidates.length > 0) {
              stockTelemetry.searchCandidatesTotal += candidates.length;
              stockTelemetry.keywordsWithCandidates++;
              stockTelemetry.page2CandidateHits += candidates.length;
              console.log(`[fetch-stock] "${keyword}": ${candidates.length} candidates from page 2`);
              return candidates;
            }
          } catch {}
        }
        console.warn(`[fetch-stock] "${keyword}": no candidates found after ${queriesToTry.length} queries + page2`);
        stockTelemetry.noCandidateKeywords++;
        return [];
      } catch (err) {
        console.error(`[fetch-stock] error for "${keyword}":`, err);
        stockTelemetry.noCandidateKeywords++;
        return [];
      }
    }
  );

  // ── LLM ranking phase (per-subtitle mode only, 1 batched call) ──
  let bestIdxByKeyword: number[] = keywords.map(() => 0);

  if (isPerSubtitleMode && llmKey && subtitleTexts?.length === keywords.length) {
    const candidateTitles = candidatesByKeyword.map(cs => cs.map(c => c.title));
    const hasAnyCandidates = candidateTitles.some(t => t.length > 0);
    if (hasAnyCandidates) {
      stockTelemetry.llmRankingUsed = true;
      console.log(`[fetch-stock] LLM ranking ${keywords.length} keywords in 1 call`);
      try {
        bestIdxByKeyword = await llmRankCandidates(keywords, subtitleTexts, candidateTitles, llmKey, visualDirection);
        console.log(`[fetch-stock] LLM picked indices:`, bestIdxByKeyword);
      } catch (e) {
        stockTelemetry.llmRankingFailed = true;
        console.error(`[fetch-stock] LLM ranking failed, falling back to best-duration pick:`, e);
        // Fallback: pick candidate with longest duration (more content = better match than index 0)
        bestIdxByKeyword = candidatesByKeyword.map(cs => {
          let best = 0;
          for (let i = 1; i < cs.length; i++) { if (cs[i].duration > cs[best].duration) best = i; }
          return best;
        });
      }
    }
  } else if (isPerSubtitleMode) {
    // No LLM key or subtitle texts mismatch — pick longest-duration candidate instead of index 0
    bestIdxByKeyword = candidatesByKeyword.map(cs => {
      let best = 0;
      for (let i = 1; i < cs.length; i++) { if (cs[i].duration > cs[best].duration) best = i; }
      return best;
    });
    if (!llmKey) console.warn(`[fetch-stock] no LLM key — using longest-duration fallback`);
  }

  // ── Pick phase — apply LLM choice first, then fill remaining slots, dedup globally ──
  const found: FoundVideo[] = [];

  for (let ki = 0; ki < keywords.length; ki++) {
    const candidates = candidatesByKeyword[ki];
    if (!candidates.length) continue;

    if (isPerSubtitleMode) {
      // Per-subtitle: pick LLM-chosen index first, skip if already used, then try others
      const rawPreferred = bestIdxByKeyword[ki] ?? 0;
      const preferred = Math.max(0, Math.min(rawPreferred, candidates.length - 1));
      const ordered = [
        preferred,
        ...candidates.map((_, i) => i).filter(i => i !== preferred),
      ];
      let picked = false;
      for (const idx of ordered) {
        const c = candidates[idx];
        if (!c || usedIds.has(c.id)) continue;
        usedIds.add(c.id);
        found.push({ keyword: c.keyword, id: c.id, duration: c.duration, link: c.link });
        picked = true;
        break; // 1 clip per subtitle
      }
      if (!picked) {
        const kw = keywords[ki];
        // Build progressively broader fallback queries
        const words = kw.split(" ");
        const broadFallbacks = [
          words.slice(0, 2).join(" "),          // first 2 words
          words[0],                              // first word only
          words[words.length - 1],              // last word (often the noun)
          "people city street",                 // generic human activity
          "nature landscape aerial",            // generic nature
          "technology abstract dark",           // generic tech
        ].filter((q, i, a) => q && q !== kw && a.indexOf(q) === i);

        for (const fbQuery of broadFallbacks) {
          if (picked) break;
          try {
            const [fbPexels, fbPixabay] = await Promise.all([
              canUsePexels ? searchPexels(fbQuery, pexelsKey!, 3, 30) : Promise.resolve([] as PexelsVideo[]),
              canUsePixabay ? searchPixabay(fbQuery, pixabayKey!) : Promise.resolve([] as { id: number; duration: number; videoUrl: string }[]),
            ]);
            // Try page 2 of Pexels for more variety if page 1 all used
            const fbPexels2 = canUsePexels && fbPexels.every(v => usedIds.has(v.id))
              ? await searchPexels(fbQuery, pexelsKey!, 3, 30).catch(() => [] as PexelsVideo[])
              : [];
            const allPexels = [...fbPexels, ...fbPexels2];
            for (const v of allPexels) {
              const file = pickBestFile(v);
              if (!file || usedIds.has(v.id)) continue;
              usedIds.add(v.id);
              found.push({ keyword: kw, id: v.id, duration: v.duration, link: file.link });
              picked = true;
              break;
            }
            if (!picked) {
              for (const pv of fbPixabay) {
                if (usedIds.has(pv.id + 9_000_000)) continue;
                usedIds.add(pv.id + 9_000_000);
                found.push({ keyword: kw, id: pv.id + 9_000_000, duration: pv.duration, link: pv.videoUrl });
                picked = true;
                break;
              }
            }
          } catch { /* ignore, try next fallback */ }
        }
        if (!picked) console.warn(`[fetch-stock] "${kw}": no unique clip found after all fallbacks`);
      }
    } else {
      // Normal mode: pick up to clipsPerKeyword, interleave Pexels+Pixabay
      let picked = 0;
      for (const c of candidates) {
        if (picked >= clipsPerKeyword) break;
        if (usedIds.has(c.id)) continue;
        usedIds.add(c.id);
        found.push({ keyword: c.keyword, id: c.id, duration: c.duration, link: c.link });
        picked++;
      }
    }
  }

  function capFoundClips(clips: FoundVideo[], limit: number): FoundVideo[] {
    if (limit <= 0 || clips.length <= limit) return clips;
    const buckets = new Map<string, FoundVideo[]>();
    for (const clip of clips) {
      const bucket = buckets.get(clip.keyword) ?? [];
      bucket.push(clip);
      buckets.set(clip.keyword, bucket);
    }
    const orderedKeywords = keywords.filter((kw, i, arr) => arr.indexOf(kw) === i);
    const capped: FoundVideo[] = [];
    let added = true;
    while (capped.length < limit && added) {
      added = false;
      for (const kw of orderedKeywords) {
        const bucket = buckets.get(kw);
        const next = bucket?.shift();
        if (!next) continue;
        capped.push(next);
        added = true;
        if (capped.length >= limit) break;
      }
    }
    return capped;
  }

  const clipsToDownload = capFoundClips(found, downloadClipLimit);
  stockTelemetry.foundCount = found.length;
  stockTelemetry.cappedCount = clipsToDownload.length;
  stockTelemetry.selectedPexelsCount = clipsToDownload.filter((clip) => clip.id < 9_000_000).length;
  stockTelemetry.selectedPixabayCount = clipsToDownload.length - stockTelemetry.selectedPexelsCount;
  console.log(`[fetch-stock] found ${found.length} clips total${clipsToDownload.length < found.length ? `, capped downloads to ${clipsToDownload.length}` : ""}`);
  if (!clipsToDownload.length) {
    await recordFetchStockTelemetry("done", { emptyResult: true });
    return NextResponse.json({ results: [] });
  }

  // ── Download phase ──
  await withConcurrency(clipsToDownload, DOWNLOAD_CONCURRENCY, async ({ keyword, id, duration, link }) => {
    if (download) {
      const outFile = `${userPrefix}${id}.mp4`;
      const outPath = path.join(rendersDir, outFile);
      if (isValidMp4Path(outPath)) {
        console.log(`[fetch-stock] cache hit: ${outFile}`);
        stockTelemetry.cacheHitCount++;
        // Older cached clips may predate normalization (or were left B-frame'd) —
        // normalizeForRemotion no-ops if already clean, re-encodes otherwise.
        applyNormalizeTelemetry(await normalizeForRemotion(outPath));
        results.push({ keyword, pexelsId: id, duration, videoUrl: link, localPath: outPath, localUrl: `/api/stocks/${outFile}` });
        return;
      }
      console.log(`[fetch-stock] downloading: ${outFile}`);
      try {
        await downloadAndCrop(link, outPath);
        if (!isValidMp4Path(outPath)) {
          stockTelemetry.downloadFailCount++;
          return;
        }
        stockTelemetry.downloadedCount++;
        // Re-encode to Remotion-safe CFR/no-B-frame so the compositor can seek
        // every frame (fixes "No frame found at position X" render crashes).
        applyNormalizeTelemetry(await normalizeForRemotion(outPath));
        if (!isValidMp4Path(outPath)) {
          stockTelemetry.downloadFailCount++;
          return;
        }
        results.push({ keyword, pexelsId: id, duration, videoUrl: link, localPath: outPath, localUrl: `/api/stocks/${outFile}` });
      } catch (e) {
        stockTelemetry.downloadFailCount++;
        console.error(`[fetch-stock] failed to download ${outFile}:`, e);
      }
    } else {
      results.push({ keyword, pexelsId: id, duration, videoUrl: link });
    }
  });

  stockTelemetry.servedClipCount = results.length;
  await recordFetchStockTelemetry("done");
  console.log(`[fetch-stock] downloaded ${results.length} clips`);
  return NextResponse.json({ results });
}

// DELETE /api/videos/fetch-stock — no-op, files are kept
export async function DELETE() {
  return NextResponse.json({ deleted: 0 });
}
