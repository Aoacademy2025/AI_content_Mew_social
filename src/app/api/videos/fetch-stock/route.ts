import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { geminiGenerateText } from "@/lib/gemini";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { fetchWithBudget } from "@/lib/fetch-budget";
import { isProviderError, toErrorResponse, type ProviderError } from "@/lib/provider-errors";
import {
  detectContentProfile,
  normalizeContentProfile,
  type ContentProfile,
} from "@/lib/broll-profile";
import { clampedLongSide, pickPixabayVariant } from "@/lib/broll-source-quality";
import {
  specToTerms,
  profileToTerms,
  scoreCandidateSoft,
  shouldDistrustRanker,
  type RelevanceSpec,
  type RelevanceTerms,
} from "@/lib/relevance-spec";
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
// 300s default: long 4K source clips legitimately take minutes to re-encode;
// a SIGKILL'd encode must not be the common case (override via env, max 600s).
const NORMALIZE_TIMEOUT_MS = readIntEnv("STOCK_NORMALIZE_TIMEOUT_MS", 300_000, 30_000, 600_000);
const PER_SUBTITLE_DOWNLOAD_LIMIT = readIntEnv("STOCK_PER_SUBTITLE_DOWNLOAD_LIMIT", 36, 6, 120);

type StockProvider = "pexels" | "pixabay";

type FoundVideo = {
  keyword: string;
  id: number;
  duration: number;
  link: string;
  width?: number;   // source resolution → HD tiebreak when relevance scores tie (#9)
  height?: number;
  title?: string;
  query?: string;
  provider?: StockProvider;
  contentProfile?: ContentProfile;
  selectionReason?: string;
  relevanceScore?: number;
};

type CandidateVideo = FoundVideo & {
  title: string;
  query: string;
  provider: StockProvider;
};

type PixabayVideo = { id: number; duration: number; videoUrl: string; width?: number; height?: number; tags?: string };

type CandidateFit = {
  index: number;
  score: number;
  rejectReason?: string;
  isRelevant: boolean;
};

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
      // Downscale oversized sources (e.g. Pixabay 4K) to fit a 1080×1920 box
      // BEFORE the libx264 re-encode. A full 4096×2160 normalize on the GPU-less
      // VPS can blow past NORMALIZE_TIMEOUT_MS → SIGKILL → ~5 min of CPU burned on
      // a clip that gets dropped anyway (and the render output is only 1080×1920,
      // so extra resolution is wasted). decrease = never upscale; the trailing
      // trunc pair forces even dimensions (yuv420p requires it) and is compatible
      // with the prod ffmpeg 4.4 (avoids the newer force_divisible_by option).
      "-vf", "scale='min(1080,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
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

  // Stock-search budget: 20s/attempt, 2 retries (429 honors Retry-After).
  // Final non-ok throws ProviderError — existing callers already treat a
  // throw as "no candidates for this keyword".
  const res = await fetchWithBudget(`https://api.pexels.com/videos/search?${params}`, {
    headers: { Authorization: apiKey },
  }, { provider: "pexels", timeoutMs: 20_000, retries: 2, wallClockMs: 60_000 });
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

// Search Pixabay for portrait videos
async function searchPixabay(query: string, pixabayKey: string, minDuration = 5, perPage = 15): Promise<PixabayVideo[]> {
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
  return (data.hits ?? []).map((h: { id: number; duration: number; videos: { medium?: { url: string; width?: number; height?: number }; large?: { url: string; width?: number; height?: number } }; tags?: string }) => {
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
    };
  }).filter((v: PixabayVideo) => v.videoUrl);
}


function scoreCandidate(
  candidate: CandidateVideo,
  keyword: string,
  subtitleText: string,
  terms: RelevanceTerms,
): CandidateFit {
  const titleText = `${candidate.title} ${candidate.query}`;
  const contextText = `${keyword} ${subtitleText}`;
  const score = scoreCandidateSoft(titleText, contextText, terms);
  // Soft mode: never eliminate. Everything is "relevant"; ranking by score decides the pick.
  return { index: -1, score, rejectReason: undefined, isRelevant: true };
}

function orderCandidateIndices(
  candidates: CandidateVideo[],
  preferredIndex: number,
  keyword: string,
  subtitleText: string,
  terms: RelevanceTerms,
  allowNeutral = false,
): CandidateFit[] {
  const fits = candidates.map((candidate, index) => ({
    ...scoreCandidate(candidate, keyword, subtitleText, terms),
    index,
  }));

  const relevant = fits
    .filter((fit) => fit.isRelevant || (allowNeutral && !fit.rejectReason))
    .sort((a, b) => {
      if (a.index === preferredIndex) return -1;
      if (b.index === preferredIndex) return 1;
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      // #9 HD tiebreak: equal relevance → prefer the sharper clip (long side clamped
      // to 1920 so ≥Full-HD clips rank equally and no provider is systematically favored).
      const resA = clampedLongSide(candidates[a.index]?.width, candidates[a.index]?.height);
      const resB = clampedLongSide(candidates[b.index]?.width, candidates[b.index]?.height);
      if (resB !== resA) return resB - resA;
      return (candidates[b.index]?.duration ?? 0) - (candidates[a.index]?.duration ?? 0);
    });

  return relevant;
}

function bestRelevantCandidateIndex(
  candidates: CandidateVideo[],
  keyword: string,
  subtitleText: string,
  terms: RelevanceTerms,
): number {
  return orderCandidateIndices(candidates, -1, keyword, subtitleText, terms, false)[0]?.index ?? -1;
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
  terms: RelevanceTerms = { positive: [], avoid: [], fallbackQueries: [], domainLabel: "general" },
): Promise<number[]> {
  const lines = keywords.map((kw, ki) => {
    const sub = subtitleTexts[ki] ?? kw;
    const titles = candidateTitles[ki].map((t, i) => `${i}:${t || "untitled"}`).join("|");
    return `${ki}. subtitle="${sub}" candidates=[${titles}]`;
  });

  const directionLine = visualDirection
    ? `\nVIDEO DIRECTION: ${visualDirection}\nPrioritize candidates that match this overall visual tone/theme.\n`
    : "";
  const profileLine = `\nVISUAL DOMAIN: ${terms.domainLabel}\nPrefer footage of: ${terms.positive.slice(0, 12).join(", ") || "the subject described"}.\nDown-rank (do NOT hard-reject) footage of: ${terms.avoid.slice(0, 8).join(", ") || "obviously unrelated subjects"}.\n`;

  const prompt = `You are a B-roll video editor. For each subtitle, pick the candidate video index (0-based) that BEST matches the subtitle's visual content, content profile, and overall video direction.
${directionLine}
${profileLine}
RULES:
- Output ONLY a JSON array of integers, one per subtitle, same order
- Pick the index whose title most literally matches what is described in the subtitle
- Return the BEST available index even if imperfect. Use -1 ONLY for a candidate that is truly unusable. NEVER return -1 for every subtitle.
- Prefer candidates that fit the VIDEO DIRECTION tone (mood, setting, energy)
- Prefer concrete, specific matches over generic ones

${lines.join("\n")}

OUTPUT (JSON array of ${keywords.length} integers; values may be -1):`;

  // max_tokens: each integer + comma is ~3 tokens; 10 tokens overhead
  const maxTokens = Math.max(128, keywords.length * 4 + 20);
  const text = await geminiGenerateText(llmKey, prompt, maxTokens, 0);

  let parsed: unknown[] = [];
  const arrMatch = text.match(/\[[\d,\s-]+\]/);
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
    console.warn(`[fetch-stock] LLM ranking length mismatch: got ${parsed.length}, expected ${keywords.length} — using profile fallback`);
    return keywords.map(() => -1);
  }

  return parsed.map((v, i) => {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    const maxIdx = (candidateTitles[i]?.length ?? 1) - 1;
    if (isNaN(n) || n < 0) return -1;
    return Math.min(n, maxIdx);
  });
}

async function llmRankCandidates(
  keywords: string[],
  subtitleTexts: string[],
  candidateTitles: string[][],
  llmKey: string,
  visualDirection?: string,
  terms: RelevanceTerms = { positive: [], avoid: [], fallbackQueries: [], domainLabel: "general" },
): Promise<number[]> {
  if (keywords.length <= RANK_BATCH_SIZE) {
    return llmRankBatch(keywords, subtitleTexts, candidateTitles, llmKey, visualDirection, terms);
  }

  // Split into chunks and call sequentially to avoid LLM output-length limits
  const results: number[] = new Array(keywords.length).fill(-1);
  for (let start = 0; start < keywords.length; start += RANK_BATCH_SIZE) {
    const end = Math.min(start + RANK_BATCH_SIZE, keywords.length);
    const chunkKws = keywords.slice(start, end);
    const chunkSubs = subtitleTexts.slice(start, end);
    const chunkTitles = candidateTitles.slice(start, end);
    console.log(`[fetch-stock] LLM ranking chunk ${start}-${end - 1} of ${keywords.length}`);
    try {
      const chunkResult = await llmRankBatch(chunkKws, chunkSubs, chunkTitles, llmKey, visualDirection, terms);
      for (let i = 0; i < chunkResult.length; i++) {
        results[start + i] = chunkResult[i];
      }
    } catch (e) {
      console.warn(`[fetch-stock] LLM chunk ${start}-${end - 1} failed:`, e);
      // Keep default -1 for this chunk so selection uses soft-score fallback.
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
    contentProfile,
    relevanceSpec,
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
    contentProfile?: string;
    relevanceSpec?: RelevanceSpec | null;
  } = body ?? {};
  const resolvedContentProfile = normalizeContentProfile(
    contentProfile || detectContentProfile([
      fullScript,
      ...(Array.isArray(subtitleTexts) ? subtitleTexts : []),
      ...(Array.isArray(keywords) ? keywords : []),
    ].filter(Boolean).join(" "))
  );

  const RANK_DISTRUST_PCT = readIntEnv("MCP_RANK_DISTRUST_PCT", 80, 50, 100);
  const relSpec: RelevanceSpec | null = relevanceSpec ?? null;
  const relTerms: RelevanceTerms = relSpec ? specToTerms(relSpec) : profileToTerms(resolvedContentProfile);
  console.log(`[fetch-stock] relevance source=${relSpec ? "spec" : "profile"} domain="${relTerms.domainLabel}" +${relTerms.positive.length}/-${relTerms.avoid.length}`);

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
    llmRejectedCount: 0,
    candidateRejectedCount: 0,
    profileFallbackUsedCount: 0,
    forcedFallbackCount: 0,
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
        contentProfile: resolvedContentProfile,
        relevanceSource: relSpec ? "spec" : "profile",
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
    title?: string;
    query?: string;
    provider?: StockProvider;
    contentProfile?: ContentProfile;
    selectionReason?: string;
    relevanceScore?: number;
  }[] = [];

  const usedIds = new Set<number>();
  // eslint-disable-next-line prefer-const
  let stockProviderError = null as ProviderError | null; // จับ invalid_key ไว้รายงานตอนท้าย — เดิมถูกกลืนเงียบ

  async function searchCandidatesForQuery(query: string, keyword: string, perPage = 30): Promise<CandidateVideo[]> {
    stockTelemetry.searchQueries++;
    const [pexelsRaw, pixabayRaw] = await Promise.allSettled([
      canUsePexels
        ? searchPexels(query, pexelsKey!, 3, perPage)
        : Promise.resolve([] as PexelsVideo[]),
      canUsePixabay
        ? searchPixabay(query, pixabayKey!, 5, perPage)
        : Promise.resolve([] as PixabayVideo[]),
    ]);

    for (const settled of [pexelsRaw, pixabayRaw]) {
      if (settled.status === "rejected" && isProviderError(settled.reason) && !stockProviderError) {
        stockProviderError = settled.reason;
      }
    }

    const pexelsVideos = pexelsRaw.status === "fulfilled" ? pexelsRaw.value : [];
    const pixabayVideos = pixabayRaw.status === "fulfilled" ? pixabayRaw.value : [];
    stockTelemetry.pexelsCandidates += pexelsVideos.length;
    stockTelemetry.pixabayCandidates += pixabayVideos.length;

    const candidates: CandidateVideo[] = [];
    for (const v of pexelsVideos) {
      const file = pickBestFile(v);
      if (!file) continue;
      candidates.push({
        keyword,
        id: v.id,
        duration: v.duration,
        link: file.link,
        width: file.width,
        height: file.height,
        title: slugToTitle(v.url ?? ""),
        query,
        provider: "pexels",
      });
    }
    for (const pv of pixabayVideos) {
      const title = pv.tags ? pv.tags.split(",").slice(0, 6).map((t) => t.trim()).join(" ") : query;
      candidates.push({
        keyword,
        id: pv.id + 9_000_000,
        duration: pv.duration,
        link: pv.videoUrl,
        width: pv.width,
        height: pv.height,
        title,
        query,
        provider: "pixabay",
      });
    }

    stockTelemetry.searchCandidatesTotal += candidates.length;
    return candidates;
  }

  function addFoundClip(candidate: CandidateVideo, selectionReason: string, relevanceScore = 0): FoundVideo {
    usedIds.add(candidate.id);
    return {
      keyword: candidate.keyword,
      id: candidate.id,
      duration: candidate.duration,
      link: candidate.link,
      title: candidate.title,
      query: candidate.query,
      provider: candidate.provider,
      contentProfile: resolvedContentProfile,
      selectionReason,
      relevanceScore,
    };
  }

  async function findProfileFallbackClip(keyword: string, keywordIndex: number, reason: string): Promise<FoundVideo | null> {
    const subtitleText = Array.isArray(subtitleTexts) ? subtitleTexts[keywordIndex] ?? "" : "";
    const words = keyword.split(/\s+/).filter(Boolean);
    const queries = [
      ...relTerms.fallbackQueries,
      words.slice(0, 2).join(" "),
      words[0],
      words[words.length - 1],
    ].filter((query, index, arr) => query && query !== keyword && arr.indexOf(query) === index);

    for (const query of queries) {
      try {
        const fallbackCandidates = await searchCandidatesForQuery(query, keyword, 30);
        if (!fallbackCandidates.length) continue;
        const ordered = orderCandidateIndices(
          fallbackCandidates,
          -1,
          keyword,
          subtitleText,
          relTerms,
          true,
        );
        stockTelemetry.candidateRejectedCount += fallbackCandidates.length - ordered.length;
        for (const fit of ordered) {
          const candidate = fallbackCandidates[fit.index];
          if (!candidate || usedIds.has(candidate.id)) continue;
          stockTelemetry.profileFallbackUsedCount++;
          return addFoundClip(candidate, `${reason}:profile-fallback:${query}`, fit.score);
        }
      } catch {
        // Ignore failed fallback query and try the next profile-safe option.
      }
    }

    return null;
  }

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

  console.log(`[fetch-stock] source=${srcLabel}`);

  // Pexels supports up to 80 per page — use that headroom for long videos
  const basePerPage = isPerSubtitleMode ? 25 : Math.min(80, Math.max(15, clipsPerKeyword * 5));

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
              ? searchPixabay(query, pixabayKey!, 5, basePerPage)
              : Promise.resolve([] as PixabayVideo[]),
          ]);

          for (const settled of [pexelsRaw, pixabayRaw]) {
            if (settled.status === "rejected" && isProviderError(settled.reason) && !stockProviderError) {
              stockProviderError = settled.reason;
            }
          }
          const pexelsVideos = pexelsRaw.status === "fulfilled" ? pexelsRaw.value : [];
          const pixabayVideos = pixabayRaw.status === "fulfilled" ? pixabayRaw.value : [];
          stockTelemetry.pexelsCandidates += pexelsVideos.length;
          stockTelemetry.pixabayCandidates += pixabayVideos.length;

          const candidates: CandidateVideo[] = [];
          for (const v of pexelsVideos) {
            const file = pickBestFile(v);
            if (!file) continue;
            const title = slugToTitle(v.url ?? "");
            candidates.push({ keyword, id: v.id, duration: v.duration, link: file.link, width: file.width, height: file.height, title, query, provider: "pexels" });
          }
          for (const pv of pixabayVideos) {
            // Use Pixabay tags as title for LLM ranking — much more descriptive than query alone
            const pbTitle = pv.tags ? pv.tags.split(",").slice(0, 6).map((t: string) => t.trim()).join(" ") : query;
            candidates.push({ keyword, id: pv.id + 9_000_000, duration: pv.duration, link: pv.videoUrl, width: pv.width, height: pv.height, title: pbTitle, query, provider: "pixabay" });
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
              candidates.push({ keyword, id: v.id, duration: v.duration, link: file.link, width: file.width, height: file.height, title: slugToTitle(v.url ?? ""), query: queriesToTry[0], provider: "pexels" });
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
  let bestIdxByKeyword: number[] = keywords.map(() => -1);

  if (isPerSubtitleMode && llmKey && subtitleTexts?.length === keywords.length) {
    const candidateTitles = candidatesByKeyword.map(cs => cs.map(c => c.title));
    const hasAnyCandidates = candidateTitles.some(t => t.length > 0);
    if (hasAnyCandidates) {
      stockTelemetry.llmRankingUsed = true;
      console.log(`[fetch-stock] LLM ranking ${keywords.length} keywords in 1 call`);
      try {
        bestIdxByKeyword = await llmRankCandidates(keywords, subtitleTexts, candidateTitles, llmKey, visualDirection, relTerms);
        console.log(`[fetch-stock] LLM picked indices:`, bestIdxByKeyword);
        stockTelemetry.llmRejectedCount = bestIdxByKeyword.filter((idx) => idx < 0).length;
        if (shouldDistrustRanker(bestIdxByKeyword, RANK_DISTRUST_PCT)) {
          console.warn(`[fetch-stock] LLM ranker rejected >=${RANK_DISTRUST_PCT}% — using deterministic relevance ranking instead`);
          bestIdxByKeyword = candidatesByKeyword.map((cs, i) =>
            bestRelevantCandidateIndex(cs, keywords[i] ?? "", subtitleTexts[i] ?? "", relTerms),
          );
          stockTelemetry.llmRejectedCount = bestIdxByKeyword.filter((idx) => idx < 0).length;
          stockTelemetry.llmRankingFailed = true;
        }
      } catch (e) {
        stockTelemetry.llmRankingFailed = true;
        console.error(`[fetch-stock] LLM ranking failed, falling back to soft relevance pick:`, e);
        bestIdxByKeyword = candidatesByKeyword.map((cs, i) =>
          bestRelevantCandidateIndex(cs, keywords[i] ?? "", subtitleTexts[i] ?? "", relTerms)
        );
        stockTelemetry.llmRejectedCount = bestIdxByKeyword.filter((idx) => idx < 0).length;
      }
    }
  } else if (isPerSubtitleMode) {
    // No LLM key or subtitle texts mismatch — pick best soft-relevant candidate instead of index 0.
    bestIdxByKeyword = candidatesByKeyword.map((cs, i) =>
      bestRelevantCandidateIndex(cs, keywords[i] ?? "", subtitleTexts?.[i] ?? "", relTerms)
    );
    stockTelemetry.llmRejectedCount = bestIdxByKeyword.filter((idx) => idx < 0).length;
    if (!llmKey) console.warn(`[fetch-stock] no LLM key — using soft relevance fallback`);
  }

  // ── Pick phase — apply LLM choice first, then fill remaining slots, dedup globally ──
  const found: FoundVideo[] = [];

  for (let ki = 0; ki < keywords.length; ki++) {
    const candidates = candidatesByKeyword[ki] ?? [];
    const keyword = keywords[ki] ?? "";
    const subtitleText = Array.isArray(subtitleTexts) ? subtitleTexts[ki] ?? "" : "";

    if (isPerSubtitleMode) {
      let picked = false;

      if (candidates.length) {
        const rawPreferred = bestIdxByKeyword[ki] ?? -1;
        const preferred = rawPreferred >= 0 && rawPreferred < candidates.length ? rawPreferred : -1;
        const strictOrder = orderCandidateIndices(
          candidates,
          preferred,
          keyword,
          subtitleText,
          relTerms,
          false,
        );
        const neutralOrder = orderCandidateIndices(
          candidates,
          preferred,
          keyword,
          subtitleText,
          relTerms,
          true,
        );
        stockTelemetry.candidateRejectedCount += Math.max(0, candidates.length - neutralOrder.length);

        for (const fit of strictOrder) {
          const c = candidates[fit.index];
          if (!c || usedIds.has(c.id)) continue;
          found.push(addFoundClip(c, fit.index === preferred ? "llm-profile-match" : "profile-match", fit.score));
          picked = true;
          break; // 1 clip per subtitle
        }

        if (!picked) {
          const fallback = await findProfileFallbackClip(
            keyword,
            ki,
            preferred < 0 ? "llm-reject" : "candidate-reject",
          );
          if (fallback) {
            found.push(fallback);
            picked = true;
          }
        }

        if (!picked) {
          for (const fit of neutralOrder) {
            const c = candidates[fit.index];
            if (!c || usedIds.has(c.id)) continue;
            found.push(addFoundClip(c, "neutral-after-profile-fallback", fit.score));
            picked = true;
            break;
          }
        }

        if (!picked) {
          const remaining = [...candidates]
            .filter((candidate) => !usedIds.has(candidate.id))
            .sort((a, b) => b.duration - a.duration);
          const forced = remaining[0];
          if (forced) {
            stockTelemetry.forcedFallbackCount++;
            found.push(addFoundClip(forced, "forced-original-after-profile-fallback", 0));
            picked = true;
          }
        }
      } else {
        const fallback = await findProfileFallbackClip(keyword, ki, "no-candidates");
        if (fallback) {
          found.push(fallback);
          picked = true;
        }
      }

      if (!picked) console.warn(`[fetch-stock] "${keyword}": no unique clip found after profile-safe fallbacks`);
    } else {
      // Normal mode: pick up to clipsPerKeyword, interleave Pexels+Pixabay
      let picked = 0;
      const ordered = orderCandidateIndices(
        candidates,
        -1,
        keyword,
        subtitleText,
        relTerms,
        true,
      );
      stockTelemetry.candidateRejectedCount += Math.max(0, candidates.length - ordered.length);

      for (const fit of ordered) {
        if (picked >= clipsPerKeyword) break;
        const c = candidates[fit.index];
        if (!c) continue;
        if (usedIds.has(c.id)) continue;
        found.push(addFoundClip(c, "normal-profile-match", fit.score));
        picked++;
      }

      if (picked < clipsPerKeyword) {
        const fallback = await findProfileFallbackClip(
          keyword,
          ki,
          candidates.length ? "normal-candidate-reject" : "normal-no-candidates",
        );
        if (fallback) {
          found.push(fallback);
          picked++;
        }
      }

      if (picked < clipsPerKeyword) {
        const remaining = [...candidates]
          .filter((candidate) => !usedIds.has(candidate.id))
          .sort((a, b) => b.duration - a.duration);
        for (const c of remaining) {
          if (picked >= clipsPerKeyword) break;
          stockTelemetry.forcedFallbackCount++;
          found.push(addFoundClip(c, "normal-forced-after-profile-filter", 0));
          picked++;
        }
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
  const selectionDebugSample = clipsToDownload.slice(0, 10).map((clip) => ({
    keyword: clip.keyword,
    title: clip.title,
    query: clip.query,
    provider: clip.provider,
    selectionReason: clip.selectionReason,
    relevanceScore: clip.relevanceScore,
  }));
  console.log(`[fetch-stock] found ${found.length} clips total${clipsToDownload.length < found.length ? `, capped downloads to ${clipsToDownload.length}` : ""}`);
  if (!clipsToDownload.length) {
    // หาคลิปไม่ได้เลยและสาเหตุคือ key ใช้ไม่ได้ — บอกผู้ใช้ตรง ๆ แทน results ว่าง
    const capturedStockErr = stockProviderError; // capture into const — TS CFA can't narrow a let assigned in closures
    if (capturedStockErr && capturedStockErr.code === "invalid_key") {
      await recordFetchStockTelemetry("error", {
        providerErrorCode: capturedStockErr.code,
        errorProvider: capturedStockErr.provider,
      });
      const { body: errBody, status } = toErrorResponse(capturedStockErr);
      return NextResponse.json(errBody, { status });
    }
    await recordFetchStockTelemetry("done", { emptyResult: true, selectionDebugSample });
    return NextResponse.json({ results: [] });
  }

  // ── Download phase ──
  await withConcurrency(clipsToDownload, DOWNLOAD_CONCURRENCY, async (clip) => {
    const { keyword, id, duration, link } = clip;
    const resultMeta = {
      title: clip.title,
      query: clip.query,
      provider: clip.provider,
      contentProfile: clip.contentProfile,
      selectionReason: clip.selectionReason,
      relevanceScore: clip.relevanceScore,
    };
    if (download) {
      const outFile = `${userPrefix}${id}.mp4`;
      const outPath = path.join(rendersDir, outFile);
      if (isValidMp4Path(outPath)) {
        console.log(`[fetch-stock] cache hit: ${outFile}`);
        stockTelemetry.cacheHitCount++;
        // Older cached clips may predate normalization (or were left B-frame'd) —
        // normalizeForRemotion no-ops if already clean, re-encodes otherwise.
        const cachedNormalize = await normalizeForRemotion(outPath);
        applyNormalizeTelemetry(cachedNormalize);
        if (cachedNormalize.status === "failed") {
          // Un-normalized clips crash Remotion later ("Invalid data"). Drop the
          // broken file and skip this clip — the render timeline gap-fills with
          // neighboring clips, and the next fetch re-downloads it fresh.
          safeUnlink(outPath);
          safeUnlink(normalizedMarkerPath(outPath));
          console.warn(`[fetch-stock] dropped broken cached clip after normalize failure: ${outFile}`);
          return;
        }
        results.push({ keyword, pexelsId: id, duration, videoUrl: link, localPath: outPath, localUrl: `/api/stocks/${outFile}`, ...resultMeta });
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
        const freshNormalize = await normalizeForRemotion(outPath);
        applyNormalizeTelemetry(freshNormalize);
        if (freshNormalize.status === "failed") {
          // Un-normalized clips crash Remotion later ("Invalid data"). Drop the
          // broken file and skip this clip — the render timeline gap-fills with
          // neighboring clips instead of rendering a corrupt one.
          safeUnlink(outPath);
          safeUnlink(normalizedMarkerPath(outPath));
          stockTelemetry.downloadFailCount++;
          console.warn(`[fetch-stock] dropped ${outFile} after normalize failure`);
          return;
        }
        if (!isValidMp4Path(outPath)) {
          stockTelemetry.downloadFailCount++;
          return;
        }
        results.push({ keyword, pexelsId: id, duration, videoUrl: link, localPath: outPath, localUrl: `/api/stocks/${outFile}`, ...resultMeta });
      } catch (e) {
        stockTelemetry.downloadFailCount++;
        console.error(`[fetch-stock] failed to download ${outFile}:`, e);
      }
    } else {
      results.push({ keyword, pexelsId: id, duration, videoUrl: link, ...resultMeta });
    }
  });

  stockTelemetry.servedClipCount = results.length;
  await recordFetchStockTelemetry("done", { selectionDebugSample });
  console.log(`[fetch-stock] downloaded ${results.length} clips`);
  return NextResponse.json({ results });
}

// DELETE /api/videos/fetch-stock — no-op, files are kept
export async function DELETE() {
  return NextResponse.json({ deleted: 0 });
}
