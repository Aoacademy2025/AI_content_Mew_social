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
import { parseLlmRankResponse } from "@/lib/llm-rank-parse";
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

const SEARCH_CONCURRENCY = readConcurrencyEnv("STOCK_SEARCH_CONCURRENCY", 8, 20);
const DOWNLOAD_CONCURRENCY = readConcurrencyEnv("STOCK_DOWNLOAD_CONCURRENCY", 2, 6);
const NORMALIZE_CONCURRENCY = readConcurrencyEnv("STOCK_NORMALIZE_CONCURRENCY", 1, 4);
// 300s default: long 4K source clips legitimately take minutes to re-encode;
// a SIGKILL'd encode must not be the common case (override via env, max 600s).
const NORMALIZE_TIMEOUT_MS = readIntEnv("STOCK_NORMALIZE_TIMEOUT_MS", 300_000, 30_000, 600_000);
const PER_SUBTITLE_DOWNLOAD_LIMIT = readIntEnv("STOCK_PER_SUBTITLE_DOWNLOAD_LIMIT", 36, 6, 120);
const NORMALIZE_PRESET = readPresetEnv("STOCK_NORMALIZE_PRESET", "ultrafast");

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

// ── Pexels Photos (Auto Mix fallback photo, ใช้ key Pexels เดิม) ──────────
// ใช้ key เดียวกับ Pexels video — ถ้ามี Pexels key อยู่แล้วใช้ photo search ได้ทันที
// กันชน id — Pexels photo ใช้ index เป็น id ฐาน
const PEXELS_PHOTO_ID_OFFSET = 8_000_000_000;

interface PexelsPhoto {
  id: number;
  src: { large2x?: string; large?: string; original?: string };
  photographer?: string;
  url?: string;
}

async function searchPexelsPhotos(query: string, apiKey: string, perPage = 10): Promise<PexelsPhoto[]> {
  const params = new URLSearchParams({
    query, orientation: "portrait", size: "large",
    per_page: String(Math.min(80, perPage)),
  });
  const res = await fetch(`https://api.pexels.com/v1/search?${params}`, {
    headers: { Authorization: apiKey },
  });
  if (!res.ok) throw new Error(`Pexels photo search failed: ${res.status}`);
  const data = await res.json();
  return (data.photos ?? []) as PexelsPhoto[];
}

// ── Pixabay Photos (Auto Mix fallback photo, ใช้ key Pixabay เดิม) ─────────
// ใช้ key เดียวกับ Pixabay video — ถ้ามี Pixabay key อยู่แล้วใช้ photo search ได้ทันที
// กันชน id — Pixabay photo ใช้ index เป็น id ฐาน
const PIXABAY_PHOTO_ID_OFFSET = 9_000_000_000;

interface PixabayPhoto {
  id: number;
  largeImageURL?: string;
  webformatURL?: string;
  user?: string;
  pageURL?: string;
}

async function searchPixabayPhotos(query: string, pixabayKey: string, perPage = 10): Promise<PixabayPhoto[]> {
  const params = new URLSearchParams({
    key: pixabayKey, q: query, image_type: "photo",
    orientation: "vertical", per_page: String(Math.min(200, Math.max(3, perPage))),
    safesearch: "true",
  });
  const res = await fetch(`https://pixabay.com/api/?${params}`);
  if (!res.ok) throw new Error(`Pixabay photo search failed: ${res.status}`);
  const data = await res.json();
  return (data.hits ?? []) as PixabayPhoto[];
}

// ── Unsplash (Auto Mix fallback photo, admin-only) ────────────────────────
// ใช้เป็น fallback ภาพคุณภาพสูงเมื่อหา video B-roll ที่ดีไม่เจอ — แปลงเป็น
// คลิปด้วย Ken Burns (ffmpeg zoompan) เหมือนกับ kie.ai AI image
// กันชน id กับ source อื่นๆ — Unsplash photo ใช้ index เป็น id ฐาน
const UNSPLASH_ID_OFFSET = 3_000_000_000;

interface UnsplashPhoto {
  id: string;
  urls: { regular?: string; full?: string; raw?: string };
  links: { download_location?: string; html?: string };
  user?: { name?: string; links?: { html?: string } };
  description?: string | null;
  alt_description?: string | null;
}

async function searchUnsplash(query: string, accessKey: string, perPage = 10): Promise<UnsplashPhoto[]> {
  const params = new URLSearchParams({
    query,
    orientation: "portrait",
    per_page: String(Math.min(30, perPage)),
    content_filter: "high",
  });
  const res = await fetch(`https://api.unsplash.com/search/photos?${params}`, {
    headers: { Authorization: `Client-ID ${accessKey}`, "Accept-Version": "v1" },
  });
  if (!res.ok) throw new Error(`Unsplash search failed: ${res.status}`);
  const data = await res.json();
  return (data.results ?? []) as UnsplashPhoto[];
}

// Unsplash API guideline: ทุกครั้งที่ "download" รูปมาใช้งานจริง ต้องยิง
// photo.links.download_location เพื่อ track download (fire-and-forget)
function trackUnsplashDownload(photo: UnsplashPhoto, accessKey: string) {
  const url = photo.links?.download_location;
  if (!url) return;
  fetch(url, { headers: { Authorization: `Client-ID ${accessKey}`, "Accept-Version": "v1" } }).catch(() => {});
}

// ── Wikimedia Commons (Auto Mix fallback photo, no key required) ──────────
// ดีสำหรับ landmark/history/documentary — ใช้ MediaWiki API ค้นหาไฟล์ภาพแล้วดึง imageinfo
// กันชน id — Wikimedia ใช้ index เป็น id ฐาน
const WIKIMEDIA_ID_OFFSET = 4_000_000_000;

interface WikimediaPhoto {
  pageid: number;
  title: string;
  url: string;
  descriptionUrl?: string;
  extMetadata?: { LicenseShortName?: { value?: string }; Artist?: { value?: string } };
}

async function searchWikimedia(query: string, limit = 5): Promise<WikimediaPhoto[]> {
  const searchParams = new URLSearchParams({
    action: "query", list: "search", srnamespace: "6", srlimit: String(Math.min(20, limit)),
    srsearch: `${query} filetype:bitmap`, format: "json", origin: "*",
  });
  const searchRes = await fetch(`https://commons.wikimedia.org/w/api.php?${searchParams}`);
  if (!searchRes.ok) throw new Error(`Wikimedia search failed: ${searchRes.status}`);
  const searchData = await searchRes.json();
  const titles = ((searchData?.query?.search ?? []) as { title: string }[]).map(s => s.title);
  if (!titles.length) return [];

  const infoParams = new URLSearchParams({
    action: "query", titles: titles.join("|"), prop: "imageinfo",
    iiprop: "url|extmetadata", iiurlwidth: "1080", format: "json", origin: "*",
  });
  const infoRes = await fetch(`https://commons.wikimedia.org/w/api.php?${infoParams}`);
  if (!infoRes.ok) throw new Error(`Wikimedia imageinfo failed: ${infoRes.status}`);
  const infoData = await infoRes.json();
  const pages = Object.values(infoData?.query?.pages ?? {}) as {
    pageid: number; title: string;
    imageinfo?: { url?: string; descriptionurl?: string; extmetadata?: WikimediaPhoto["extMetadata"] }[];
  }[];

  return pages
    .map(p => {
      const info = p.imageinfo?.[0];
      if (!info?.url) return null;
      return {
        pageid: p.pageid, title: p.title, url: info.url,
        descriptionUrl: info.descriptionurl, extMetadata: info.extmetadata,
      } as WikimediaPhoto;
    })
    .filter((p): p is WikimediaPhoto => p !== null);
}

// ── Flickr Creative Commons (Auto Mix fallback photo, admin-only BYOK) ────
// ดีสำหรับ travel/real-world/event — ค้นหาเฉพาะภาพที่มี Creative Commons license
// กันชน id — Flickr ใช้ index เป็น id ฐาน
const FLICKR_ID_OFFSET = 5_000_000_000;

interface FlickrPhoto {
  id: string;
  title: string;
  url: string;
  ownerName?: string;
  license?: string;
  sourcePage: string;
}

// Flickr CC license codes: 1-10 ครอบคลุม CC BY/BY-SA/BY-ND/BY-NC/etc + CC0 (9), Public Domain Mark (10)
const FLICKR_CC_LICENSES = "1,2,3,4,5,6,7,8,9,10";

async function searchFlickr(query: string, apiKey: string, perPage = 10): Promise<FlickrPhoto[]> {
  const params = new URLSearchParams({
    method: "flickr.photos.search", api_key: apiKey, text: query,
    license: FLICKR_CC_LICENSES, content_type: "1", media: "photos",
    sort: "relevance", per_page: String(Math.min(30, perPage)),
    extras: "url_l,url_o,owner_name,license", format: "json", nojsoncallback: "1",
  });
  const res = await fetch(`https://www.flickr.com/services/rest/?${params}`);
  if (!res.ok) throw new Error(`Flickr search failed: ${res.status}`);
  const data = await res.json();
  if (data?.stat !== "ok") throw new Error(`Flickr search error: ${data?.message ?? "unknown"}`);
  const photos = (data?.photos?.photo ?? []) as {
    id: string; title?: string; owner: string; secret: string; server: string;
    url_l?: string; url_o?: string; ownername?: string; license?: string;
  }[];
  return photos
    .map(p => {
      const url = p.url_o ?? p.url_l;
      if (!url) return null;
      return {
        id: p.id, title: p.title || query, url,
        ownerName: p.ownername, license: p.license,
        sourcePage: `https://www.flickr.com/photos/${p.owner}/${p.id}`,
      } as FlickrPhoto;
    })
    .filter((p): p is FlickrPhoto => p !== null);
}

// ── NASA Image and Video Library (Auto Mix fallback photo, no key required) ─
// ดีสำหรับ space/aircraft/science — ใช้ images-api.nasa.gov (DEMO_KEY ใช้ได้ ไม่ต้องสมัคร)
// กันชน id — NASA ใช้ index เป็น id ฐาน
const NASA_ID_OFFSET = 6_000_000_000;

interface NasaImage {
  nasaId: string;
  title: string;
  url: string;
  description?: string;
}

async function searchNasa(query: string, limit = 5): Promise<NasaImage[]> {
  const params = new URLSearchParams({ q: query, media_type: "image" });
  const res = await fetch(`https://images-api.nasa.gov/search?${params}`);
  if (!res.ok) throw new Error(`NASA search failed: ${res.status}`);
  const data = await res.json();
  const items = (data?.collection?.items ?? []) as {
    data?: { nasa_id?: string; title?: string; description?: string }[];
    links?: { href?: string; rel?: string; render?: string }[];
  }[];

  const results: NasaImage[] = [];
  for (const item of items.slice(0, limit)) {
    const meta = item.data?.[0];
    const link = item.links?.find(l => l.rel === "preview")?.href;
    if (!meta?.nasa_id || !link) continue;
    results.push({ nasaId: meta.nasa_id, title: meta.title || query, url: link, description: meta.description });
  }
  return results;
}

// ── The Met Museum API (Auto Mix fallback photo, no key required) ─────────
// ดีสำหรับ art/museum/painting/sculpture — Open Access public domain artworks
// กันชน id — Met ใช้ index เป็น id ฐาน
const MET_ID_OFFSET = 7_000_000_000;

interface MetArtwork {
  objectId: number;
  title: string;
  url: string;
  artist?: string;
  sourcePage: string;
}

async function searchMet(query: string, limit = 5): Promise<MetArtwork[]> {
  const searchParams = new URLSearchParams({ q: query, hasImages: "true" });
  const searchRes = await fetch(`https://collectionapi.metmuseum.org/public/collection/v1/search?${searchParams}`);
  if (!searchRes.ok) throw new Error(`Met search failed: ${searchRes.status}`);
  const searchData = await searchRes.json();
  const objectIds = (searchData?.objectIDs ?? []) as number[];
  if (!objectIds.length) return [];

  const results: MetArtwork[] = [];
  for (const objectId of objectIds.slice(0, limit)) {
    try {
      const objRes = await fetch(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${objectId}`);
      if (!objRes.ok) continue;
      const obj = await objRes.json();
      const url = obj?.primaryImage || obj?.primaryImageSmall;
      if (!url) continue;
      results.push({
        objectId, title: obj?.title || query, url,
        artist: obj?.artistDisplayName || undefined,
        sourcePage: obj?.objectURL || `https://www.metmuseum.org/art/collection/search/${objectId}`,
      });
    } catch { /* skip this object */ }
  }
  return results;
}

// ── kie.ai image-to-video (Premium, admin-only) ───────────────────────────
// สร้างภาพด้วย AI (GPT Image, text-to-image) จาก keyword/subtitle แล้วแปลง
// เป็นวิดีโอด้วย Kling 2.6 image-to-video ผ่าน kie.ai unified jobs API
// (createTask → recordInfo polling) เปิดเฉพาะ admin เพื่อทดลอง pipeline ก่อน
const KIE_API_BASE = "https://api.kie.ai/api/v1";
const KIE_POLL_INTERVAL_MS = 4_000;
const KIE_POLL_TIMEOUT_MS = 180_000;

// กันชน id กับ source อื่นๆ — kie.ai generated item ใช้ index เป็น id ฐาน
const KIE_ID_OFFSET = 2_000_000_000;

interface KieCreateTaskResponse {
  code: number;
  msg?: string;
  data?: { taskId?: string };
}

interface KieRecordInfoResponse {
  code: number;
  msg?: string;
  data?: {
    taskId: string;
    state: "waiting" | "queuing" | "generating" | "success" | "fail";
    resultJson?: string;
    failMsg?: string;
  };
}

// อ่าน body เป็น text ก่อนเสมอ — kie.ai อาจตอบ body ว่างหรือ non-JSON เวลา error
// (เช่น 401/500 บางกรณี) ซึ่งทำให้ res.json() throw "Unexpected end of JSON input"
async function parseKieResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new Error(`kie.ai returned non-JSON response (status ${res.status}): ${text.slice(0, 300) || "(empty body)"}`);
  }
  if (!res.ok) throw new Error(`kie.ai request failed (status ${res.status}): ${text.slice(0, 300)}`);
  return data;
}

async function kieCreateTask(model: string, input: Record<string, unknown>, token: string): Promise<string> {
  const res = await fetch(`${KIE_API_BASE}/jobs/createTask`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
  });
  const data = await parseKieResponse<KieCreateTaskResponse>(res);
  const taskId = data.data?.taskId;
  if (data.code !== 200 || !taskId) throw new Error(`kie.ai createTask error: ${data.msg ?? data.code}`);
  return taskId;
}

// Poll /jobs/recordInfo until state is success/fail, returns resultUrls[0]
async function kiePollResult(taskId: string, token: string): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < KIE_POLL_TIMEOUT_MS) {
    const res = await fetch(`${KIE_API_BASE}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await parseKieResponse<KieRecordInfoResponse>(res);
    const state = data.data?.state;
    if (state === "success") {
      const resultJson = data.data?.resultJson ? JSON.parse(data.data.resultJson) : {};
      const url = resultJson.resultUrls?.[0];
      if (!url) throw new Error(`kie.ai task ${taskId} succeeded but has no resultUrls`);
      return url;
    }
    if (state === "fail") throw new Error(`kie.ai task ${taskId} failed: ${data.data?.failMsg ?? "unknown error"}`);
    await new Promise((r) => setTimeout(r, KIE_POLL_INTERVAL_MS));
  }
  throw new Error(`kie.ai task ${taskId} timed out after ${KIE_POLL_TIMEOUT_MS}ms`);
}

// โมเดล text-to-image ที่เลือกได้จาก dropdown — ขนาดภาพ fix ที่ 9:16 เสมอ
// NOTE: ห้าม export จาก route.ts (Next.js อนุญาตเฉพาะ HTTP handlers/config) —
// export ตัวอื่นทำให้ type-check ของ .next/types fail และ build/หน้าเว็บ error
const KIE_IMAGE_MODELS = [
  "nano-banana-pro",
  "nano-banana-2",
  "gpt-image-2-text-to-image",
  "seedream/5-lite-text-to-image",
  "seedream/4.5-text-to-image",
  "flux-2/pro-text-to-image",
  "grok-imagine/text-to-image",
  "qwen2/text-to-image",
] as const;
type KieImageModel = (typeof KIE_IMAGE_MODELS)[number];
const DEFAULT_KIE_IMAGE_MODEL: KieImageModel = "nano-banana-pro";

function isKieImageModel(value: unknown): value is KieImageModel {
  return typeof value === "string" && (KIE_IMAGE_MODELS as readonly string[]).includes(value);
}

// แต่ละโมเดลรับ input shape ต่างกันเล็กน้อย — รวม prompt + aspect ratio (fix 9:16)
function buildKieImageInput(model: KieImageModel, prompt: string): Record<string, unknown> {
  switch (model) {
    case "gpt-image-2-text-to-image":
      return { prompt, aspect_ratio: "9:16" };
    case "seedream/5-lite-text-to-image":
    case "seedream/4.5-text-to-image":
      return { prompt, aspect_ratio: "9:16", quality: "basic" };
    case "flux-2/pro-text-to-image":
      return { prompt, aspect_ratio: "9:16", resolution: "1K" };
    case "grok-imagine/text-to-image":
      return { prompt, aspect_ratio: "9:16" };
    case "qwen2/text-to-image":
      return { prompt, image_size: "9:16", output_format: "png" };
    case "nano-banana-pro":
    case "nano-banana-2":
    default:
      return { prompt, image_input: [], aspect_ratio: "9:16", resolution: "1K", output_format: "png" };
  }
}

const KEN_BURNS_DURATION_SEC = 5;
const KEN_BURNS_WIDTH = 1080;
const KEN_BURNS_HEIGHT = 1920;

// แปลงภาพนิ่ง 1 ภาพเป็นวิดีโอแนวตั้งด้วย Ken Burns effect (ffmpeg zoompan: pan+zoom ช้าๆ)
async function applyKenBurns(imagePath: string, outPath: string): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const totalFrames = KEN_BURNS_DURATION_SEC * TARGET_FPS;
  // ซูมเข้าช้าๆ จาก 1.0 -> ~1.15 พร้อม pan ไปกลางภาพเล็กน้อย ให้ดูมีการเคลื่อนไหว
  const zoompan = `zoompan=z='min(zoom+0.0007,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${KEN_BURNS_WIDTH}x${KEN_BURNS_HEIGHT}:fps=${TARGET_FPS}`;
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
async function generateKieImageKenBurns(
  query: string,
  token: string,
  model: KieImageModel,
  imagePath: string,
  outPath: string,
): Promise<{ duration: number; imageUrl: string }> {
  const prompt = `${query}, cinematic photo, vertical 9:16, high detail, no text, no watermark`;
  const imageTaskId = await kieCreateTask(model, buildKieImageInput(model, prompt), token);
  const imageUrl = await kiePollResult(imageTaskId, token);
  console.log(`[fetch-stock] kie image ready for "${query}": ${imageUrl.slice(0, 80)}`);

  await downloadAndCrop(imageUrl, imagePath);
  console.log(`[fetch-stock] kie cropped "${query}" → ${imagePath.split(/[/\\]/).pop()}`);
  await applyKenBurns(imagePath, outPath);
  console.log(`[fetch-stock] kie Ken Burns done "${query}" → ${outPath.split(/[/\\]/).pop()}`);

  return { duration: KEN_BURNS_DURATION_SEC, imageUrl };
}

// Metadata สำหรับ license/attribution ของ asset — ดู StockVideo["assetMeta"] ใน
// video-editor/_components/types.ts (shape เดียวกัน)
type AssetMeta = {
  provider: "pexels" | "pixabay" | "unsplash" | "kie-ai" | "wikimedia" | "flickr" | "nasa" | "met";
  assetId: string;
  downloadUrl?: string;
  creator?: string;
  license?: string;
  sourcePage?: string;
};

type ImageFallbackResult = {
  duration: number;
  imageUrl: string;
  assetMeta: AssetMeta;
};

// Auto Mix: หา photo จาก Pexels ตาม query แล้วทำ Ken Burns — คืนค่า null ถ้าไม่เจอผลลัพธ์
async function tryPexelsPhotoKenBurns(
  query: string,
  apiKey: string,
  imagePath: string,
  outPath: string,
): Promise<ImageFallbackResult | null> {
  const photos = await searchPexelsPhotos(query, apiKey, 1);
  const photo = photos[0];
  const imageUrl = photo?.src?.large2x ?? photo?.src?.large ?? photo?.src?.original;
  if (!photo || !imageUrl) return null;

  await downloadAndCrop(imageUrl, imagePath);
  await applyKenBurns(imagePath, outPath);

  return {
    duration: KEN_BURNS_DURATION_SEC,
    imageUrl,
    assetMeta: {
      provider: "pexels",
      assetId: String(photo.id),
      downloadUrl: imageUrl,
      creator: photo.photographer,
      license: "Pexels License",
      sourcePage: photo.url,
    },
  };
}

// Auto Mix: หา photo จาก Pixabay ตาม query แล้วทำ Ken Burns — คืนค่า null ถ้าไม่เจอผลลัพธ์
async function tryPixabayPhotoKenBurns(
  query: string,
  apiKey: string,
  imagePath: string,
  outPath: string,
): Promise<ImageFallbackResult | null> {
  const photos = await searchPixabayPhotos(query, apiKey, 3);
  const photo = photos[0];
  const imageUrl = photo?.largeImageURL ?? photo?.webformatURL;
  if (!photo || !imageUrl) return null;

  await downloadAndCrop(imageUrl, imagePath);
  await applyKenBurns(imagePath, outPath);

  return {
    duration: KEN_BURNS_DURATION_SEC,
    imageUrl,
    assetMeta: {
      provider: "pixabay",
      assetId: String(photo.id),
      downloadUrl: imageUrl,
      creator: photo.user,
      license: "Pixabay License",
      sourcePage: photo.pageURL,
    },
  };
}

// Auto Mix: หา photo จาก Unsplash ตาม query แล้วทำ Ken Burns — คืนค่า null ถ้าไม่เจอผลลัพธ์
async function tryUnsplashKenBurns(
  query: string,
  accessKey: string,
  imagePath: string,
  outPath: string,
): Promise<ImageFallbackResult | null> {
  const photos = await searchUnsplash(query, accessKey, 1);
  const photo = photos[0];
  const imageUrl = photo?.urls?.regular ?? photo?.urls?.full;
  if (!photo || !imageUrl) return null;

  await downloadAndCrop(imageUrl, imagePath);
  await applyKenBurns(imagePath, outPath);
  trackUnsplashDownload(photo, accessKey); // ตาม Unsplash API guideline — ต้อง track download

  return {
    duration: KEN_BURNS_DURATION_SEC,
    imageUrl,
    assetMeta: {
      provider: "unsplash",
      assetId: photo.id,
      downloadUrl: imageUrl,
      creator: photo.user?.name,
      license: "Unsplash License",
      sourcePage: photo.links?.html,
    },
  };
}

// Auto Mix: หา photo จาก Wikimedia Commons ตาม query แล้วทำ Ken Burns — คืนค่า null ถ้าไม่เจอผลลัพธ์
async function tryWikimediaKenBurns(
  query: string,
  imagePath: string,
  outPath: string,
): Promise<ImageFallbackResult | null> {
  const photos = await searchWikimedia(query, 1);
  const photo = photos[0];
  if (!photo) return null;

  await downloadAndCrop(photo.url, imagePath);
  await applyKenBurns(imagePath, outPath);

  return {
    duration: KEN_BURNS_DURATION_SEC,
    imageUrl: photo.url,
    assetMeta: {
      provider: "wikimedia",
      assetId: String(photo.pageid),
      downloadUrl: photo.url,
      creator: photo.extMetadata?.Artist?.value,
      license: photo.extMetadata?.LicenseShortName?.value ?? "Wikimedia Commons",
      sourcePage: photo.descriptionUrl,
    },
  };
}

// Auto Mix: หา photo Creative Commons จาก Flickr ตาม query แล้วทำ Ken Burns — คืนค่า null ถ้าไม่เจอผลลัพธ์
async function tryFlickrKenBurns(
  query: string,
  apiKey: string,
  imagePath: string,
  outPath: string,
): Promise<ImageFallbackResult | null> {
  const photos = await searchFlickr(query, apiKey, 1);
  const photo = photos[0];
  if (!photo) return null;

  await downloadAndCrop(photo.url, imagePath);
  await applyKenBurns(imagePath, outPath);

  return {
    duration: KEN_BURNS_DURATION_SEC,
    imageUrl: photo.url,
    assetMeta: {
      provider: "flickr",
      assetId: photo.id,
      downloadUrl: photo.url,
      creator: photo.ownerName,
      license: "Creative Commons",
      sourcePage: photo.sourcePage,
    },
  };
}

// Auto Mix: หา photo จาก NASA Image Library ตาม query แล้วทำ Ken Burns — คืนค่า null ถ้าไม่เจอผลลัพธ์
async function tryNasaKenBurns(
  query: string,
  imagePath: string,
  outPath: string,
): Promise<ImageFallbackResult | null> {
  const images = await searchNasa(query, 1);
  const image = images[0];
  if (!image) return null;

  await downloadAndCrop(image.url, imagePath);
  await applyKenBurns(imagePath, outPath);

  return {
    duration: KEN_BURNS_DURATION_SEC,
    imageUrl: image.url,
    assetMeta: {
      provider: "nasa",
      assetId: image.nasaId,
      downloadUrl: image.url,
      license: "NASA (Public Domain)",
      sourcePage: `https://images.nasa.gov/details/${image.nasaId}`,
    },
  };
}

// Auto Mix: หา artwork public domain จาก The Met ตาม query แล้วทำ Ken Burns — คืนค่า null ถ้าไม่เจอผลลัพธ์
async function tryMetKenBurns(
  query: string,
  imagePath: string,
  outPath: string,
): Promise<ImageFallbackResult | null> {
  const artworks = await searchMet(query, 1);
  const artwork = artworks[0];
  if (!artwork) return null;

  await downloadAndCrop(artwork.url, imagePath);
  await applyKenBurns(imagePath, outPath);

  return {
    duration: KEN_BURNS_DURATION_SEC,
    imageUrl: artwork.url,
    assetMeta: {
      provider: "met",
      assetId: String(artwork.objectId),
      downloadUrl: artwork.url,
      creator: artwork.artist,
      license: "The Met Open Access (Public Domain)",
      sourcePage: artwork.sourcePage,
    },
  };
}

// Auto Mix keyword-aware routing: เลือกลำดับ provider fallback ตาม topic ของ query
// - space/aircraft/science -> NASA ก่อน
// - art/museum/painting -> The Met ก่อน
// - landmark/history/monument -> Wikimedia ก่อน
// - อื่นๆ -> Flickr, Unsplash ตามลำดับปกติ (NASA/Met/Wikimedia ต่อท้ายเป็น fallback เพิ่ม)
type ImageProvider = "unsplash" | "pexels-photo" | "pixabay-photo" | "flickr" | "wikimedia" | "nasa" | "met";

const NASA_KEYWORDS = /\b(space|nasa|rocket|galaxy|planet|astronaut|satellite|aircraft|spacecraft|orbit|moon|mars|cosmos|universe|telescope)\b/i;
const MET_KEYWORDS = /\b(art|museum|painting|sculpture|gallery|artwork|portrait|exhibit|masterpiece|fresco|artifact)\b/i;
const WIKIMEDIA_KEYWORDS = /\b(landmark|history|historical|monument|temple|ruins|heritage|ancient|castle|cathedral|documentary)\b/i;

// Default priority: unsplash -> pexels photo -> pixabay photo -> wikimedia -> flickr -> nasa/met (เฉพาะหมวด)
function getImageProviderOrder(query: string): ImageProvider[] {
  if (NASA_KEYWORDS.test(query)) return ["nasa", "wikimedia", "unsplash", "pexels-photo", "pixabay-photo", "flickr", "met"];
  if (MET_KEYWORDS.test(query)) return ["met", "wikimedia", "unsplash", "pexels-photo", "pixabay-photo", "flickr", "nasa"];
  if (WIKIMEDIA_KEYWORDS.test(query)) return ["wikimedia", "unsplash", "pexels-photo", "pixabay-photo", "flickr", "met", "nasa"];
  return ["unsplash", "pexels-photo", "pixabay-photo", "wikimedia", "flickr", "met", "nasa"];
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

  const lastIdx = keywords.length - 1;
  const prompt = `You are a B-roll video editor. For each subtitle, pick the candidate video index (0-based) that BEST matches the subtitle's visual content, content profile, and overall video direction.
${directionLine}
${profileLine}
RULES:
- Output ONLY a JSON object mapping each subtitle index to its chosen candidate index, e.g. {"0": 2, "1": -1, "2": 0}
- Include an entry for EVERY subtitle index from 0 to ${lastIdx}
- Pick the index whose title most literally matches what is described in the subtitle
- Return the BEST available index even if imperfect. Use -1 ONLY for a candidate that is truly unusable. NEVER return -1 for every subtitle.
- Prefer candidates that fit the VIDEO DIRECTION tone (mood, setting, energy)
- Prefer concrete, specific matches over generic ones

${lines.join("\n")}

OUTPUT (JSON object with keys "0".."${lastIdx}" → candidate index; values may be -1):`;

  // Keyed output is wordier than a bare array: each entry is ~6-8 tokens.
  const maxTokens = Math.max(160, keywords.length * 8 + 64);
  const text = await geminiGenerateText(llmKey, prompt, maxTokens, 0);

  // Robust parse: tolerant of off-by-count and truncation, no positional
  // mis-alignment, fail-open to -1 (deterministic fallback). See llm-rank-parse.
  return parseLlmRankResponse(text, keywords.length, candidateTitles.map((t) => t.length));
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
    kieModel,
    autoMixProviders,
    subtitleTexts,
    perSubtitleMode: perSubtitleFlag = false,
    fullScript,
    visualDirection,
    contentProfile,
    relevanceSpec,
    pipelineRunId,
    draftId,
  }: {
    keywords: string[];
    keywordAlternatives?: string[][];
    download?: boolean;
    totalDurationSec?: number;
    overrideClipCount?: number;
    stockSource?: string;
    kieModel?: string;
    autoMixProviders?: string[];
    subtitleTexts?: string[];
    perSubtitleMode?: boolean;
    fullScript?: string;
    visualDirection?: string;
    contentProfile?: string;
    relevanceSpec?: RelevanceSpec | null;
    pipelineRunId?: string;
    draftId?: string;
  } = body ?? {};
  // Auto Mix: ผู้ใช้เลือกได้ว่าจะเปิด provider ภาพ fallback ตัวไหนบ้าง (undefined = ทุกตัว, ตาม default เดิม)
  const allowedAutoMixProviders: Set<string> | null = Array.isArray(autoMixProviders) ? new Set(autoMixProviders) : null;
  const telemetryPipelineRunId = typeof pipelineRunId === "string" && pipelineRunId.trim()
    ? pipelineRunId.trim().slice(0, 120)
    : null;
  const telemetryDraftId = typeof draftId === "string" && draftId.trim()
    ? draftId.trim().slice(0, 120)
    : null;
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

  const resolvedKieModel: KieImageModel = isKieImageModel(kieModel) ? kieModel : DEFAULT_KIE_IMAGE_MODEL;

  const useKieImage = stockSource === "kie-image";
  const useAutoMix = stockSource === "auto-mix";
  // Auto Mix: ผู้ใช้เลือก "video" ใน autoMixProviders ไหม — ถ้าไม่เลือก = ข้ามการหา
  // video จริง ไปใช้ภาพ fallback ล้วน (เช่น kie.ai อย่างเดียว → ได้ภาพ AI ทุก keyword)
  // (undefined = เปิดทุกอย่างตาม default เดิม → video ทำงานปกติ)
  const autoMixUsesVideo = !allowedAutoMixProviders || allowedAutoMixProviders.has("video");
  const usePexels = stockSource === "pexels" || stockSource === "both" || (useAutoMix && autoMixUsesVideo);
  const usePixabay = stockSource === "pixabay" || stockSource === "both" || (useAutoMix && autoMixUsesVideo);

  if (!keywords?.length) return NextResponse.json({ error: "keywords required" }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { id: authUser.id },
    select: { pixabayKey: true, pexelsKey: true, kieKey: true, unsplashKey: true, flickrKey: true, geminiKey: true, ttsProvider: true, role: true },
  });

  // AI Image-to-Video (kie.ai) — ยังเปิดเฉพาะ ADMIN เพื่อทดลอง
  if (useKieImage && user?.role !== "ADMIN") {
    return NextResponse.json({ error: "AI Image-to-Video (kie.ai) ยังไม่เปิดให้ใช้งาน — เร็วๆ นี้" }, { status: 403 });
  }

  // Auto Mix (video + image fallback ผ่าน Ken Burns) — ยังเปิดเฉพาะ ADMIN เพื่อทดลอง
  if (useAutoMix && user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Auto Mix ยังไม่เปิดให้ใช้งาน — เร็วๆ นี้" }, { status: 403 });
  }

  const pexelsKey = user?.pexelsKey ? Buffer.from(user.pexelsKey, "base64").toString("utf-8") : null;
  const pixabayKey = user?.pixabayKey ? Buffer.from(user.pixabayKey, "base64").toString("utf-8") : null;
  const kieKey = user?.kieKey ? Buffer.from(user.kieKey, "base64").toString("utf-8") : null;
  const unsplashKey = user?.unsplashKey ? Buffer.from(user.unsplashKey, "base64").toString("utf-8") : null;
  const flickrKey = user?.flickrKey ? Buffer.from(user.flickrKey, "base64").toString("utf-8") : null;

  const canUsePexels = usePexels && !!pexelsKey;
  const canUsePixabay = usePixabay && !!pixabayKey;
  const canUseKieImage = useKieImage && !!kieKey;
  // Auto Mix: fallback ภาพใช้ตัวไหนก็ได้ที่มี key — ไม่บังคับ ไม่ error ถ้าไม่มี (แค่ skip fallback)
  // Wikimedia/NASA/Met ไม่ต้องใช้ key — เปิดใช้ได้เสมอเมื่อ Auto Mix
  // Pexels/Pixabay photo ใช้ key เดียวกับ video search — ใช้ได้ทันทีถ้ามี key อยู่แล้ว
  // ผู้ใช้เลือก provider เองได้ผ่าน autoMixProviders (undefined = เปิดทุกตัวตาม default เดิม)
  const isAutoMixProviderAllowed = (p: string) => !allowedAutoMixProviders || allowedAutoMixProviders.has(p);
  const canUseUnsplashFallback = useAutoMix && !!unsplashKey && isAutoMixProviderAllowed("unsplash");
  const canUsePexelsPhotoFallback = useAutoMix && !!pexelsKey && isAutoMixProviderAllowed("pexels-photo");
  const canUsePixabayPhotoFallback = useAutoMix && !!pixabayKey && isAutoMixProviderAllowed("pixabay-photo");
  const canUseFlickrFallback = useAutoMix && !!flickrKey && isAutoMixProviderAllowed("flickr");
  const canUseWikimediaFallback = useAutoMix && isAutoMixProviderAllowed("wikimedia");
  const canUseNasaFallback = useAutoMix && isAutoMixProviderAllowed("nasa");
  const canUseMetFallback = useAutoMix && isAutoMixProviderAllowed("met");
  const canUseKieFallback = useAutoMix && !!kieKey && isAutoMixProviderAllowed("kie-ai");

  if (useKieImage && !canUseKieImage) {
    return NextResponse.json({ error: "kie.ai API key ยังไม่ได้ตั้งค่า — ไปที่ Settings > API Keys", missingKey: "kie" }, { status: 400 });
  }

  // Auto Mix ที่ข้าม video (ผู้ใช้ติ๊กออก "video") ใช้ภาพ fallback ล้วน → ไม่ต้องมี
  // Pexels/Pixabay key. ข้าม guard นี้ ปล่อยให้ image fallback ด้านล่างจัดการ
  const autoMixImageOnly = useAutoMix && !autoMixUsesVideo;
  if (!useKieImage && !autoMixImageOnly && !canUsePexels && !canUsePixabay) {
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
    searchPhaseMs: 0,
    rankingPhaseMs: 0,
    selectionPhaseMs: 0,
    downloadPhaseMs: 0,
  };

  function applyNormalizeTelemetry(result: NormalizeResult) {
    stockTelemetry.normalizeMsTotal += result.durationMs;
    if (result.status === "normalized") stockTelemetry.normalizeRanCount++;
    if (result.status === "skipped") stockTelemetry.normalizeSkippedCount++;
    if (result.status === "failed") stockTelemetry.normalizeFailedCount++;
  }

  const srcLabel = canUseKieImage ? "AI Image-to-Video (kie.ai)" : useAutoMix ? "Auto Mix (video + image fallback)" : canUsePexels && canUsePixabay ? "Pexels+Pixabay" : canUsePexels ? "Pexels" : "Pixabay";

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
        pipelineRunId: telemetryPipelineRunId,
        draftId: telemetryDraftId,
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
        canUseKieImage,
        searchConcurrency: SEARCH_CONCURRENCY,
        downloadConcurrency: DOWNLOAD_CONCURRENCY,
        normalizeConcurrency: NORMALIZE_CONCURRENCY,
        normalizePreset: NORMALIZE_PRESET,
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
    imageUrl?: string;
    imageLocalUrl?: string;
    assetMeta?: AssetMeta;
    title?: string;
    query?: string;
    provider?: StockProvider;
    contentProfile?: ContentProfile;
    selectionReason?: string;
    relevanceScore?: number;
  }[] = [];

  // ── AI Image-to-Video (kie.ai, admin-only) — generation path ──────────────
  // ไม่มี "candidate pool" ให้ค้นหา — generate ภาพ 1 ภาพ/keyword แล้วทำ Ken Burns (ffmpeg pan/zoom)
  if (canUseKieImage) {
    const clipsToGenerate = Math.min(keywords.length, downloadClipLimit, PER_SUBTITLE_DOWNLOAD_LIMIT);
    console.log(`[fetch-stock] source=${srcLabel}, model=${resolvedKieModel}, generating ${clipsToGenerate} clips`);

    await withConcurrency(
      keywords.slice(0, clipsToGenerate).map((keyword, i) => ({ keyword, i })),
      Math.min(2, DOWNLOAD_CONCURRENCY),
      async ({ keyword, i }) => {
        const query = subtitleTexts?.[i] || keyword;
        const id = KIE_ID_OFFSET + i;
        const imageFile = `${userPrefix}${id}.src.jpg`;
        const imagePath = path.join(rendersDir, imageFile);
        try {
          if (download) {
            const outFile = `${userPrefix}${id}.mp4`;
            const outPath = path.join(rendersDir, outFile);
            try {
              const { duration, imageUrl } = await generateKieImageKenBurns(query, kieKey!, resolvedKieModel, imagePath, outPath);
              if (!isValidMp4Path(outPath)) {
                stockTelemetry.downloadFailCount++;
                return;
              }
              stockTelemetry.downloadedCount++;
              stockTelemetry.normalizeSkippedCount++; // Ken Burns output is already CFR/no-B-frames — no extra normalize pass needed
              try { fs.writeFileSync(normalizedMarkerPath(outPath), ""); } catch {}
              results.push({
                keyword, pexelsId: id, duration, videoUrl: imageUrl,
                localPath: outPath, localUrl: `/api/stocks/${outFile}`,
                imageUrl, imageLocalUrl: `/api/stocks/${imageFile}`,
              });
            } catch (e) {
              stockTelemetry.downloadFailCount++;
              console.error(`[fetch-stock] kie.ai Ken Burns failed for "${query}":`, e);
            }
          } else {
            const imageTaskId = await kieCreateTask(resolvedKieModel, buildKieImageInput(resolvedKieModel, `${query}, cinematic photo, vertical 9:16, high detail, no text, no watermark`), kieKey!);
            const imageUrl = await kiePollResult(imageTaskId, kieKey!);
            results.push({ keyword, pexelsId: id, duration: KEN_BURNS_DURATION_SEC, videoUrl: imageUrl, imageUrl });
          }
        } catch (e) {
          stockTelemetry.noCandidateKeywords++;
          console.error(`[fetch-stock] kie.ai generation failed for "${query}":`, e);
        }
      },
    );

    stockTelemetry.foundCount = results.length;
    stockTelemetry.cappedCount = results.length;
    stockTelemetry.servedClipCount = results.length;
    await recordFetchStockTelemetry("done");
    console.log(`[fetch-stock] kie.ai generated ${results.length} clips`);
    return NextResponse.json({ results });
  }

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
  const searchPhaseStartedAt = Date.now();
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
  stockTelemetry.searchPhaseMs = Date.now() - searchPhaseStartedAt;

  // ── LLM ranking phase (per-subtitle mode only, 1 batched call) ──
  const rankingPhaseStartedAt = Date.now();
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
  stockTelemetry.rankingPhaseMs = Date.now() - rankingPhaseStartedAt;

  // ── Pick phase — apply LLM choice first, then fill remaining slots, dedup globally ──
  const selectionPhaseStartedAt = Date.now();
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

  // ── Auto Mix: image fallback (keyword-aware: Unsplash/Pexels/Pixabay photo/Wikimedia/Flickr/NASA/Met -> kie.ai) for keywords with zero video clips ──
  // ไม่กระทบ keyword ที่หา video clip ได้แล้ว — เติมเฉพาะ keyword ที่ found ว่างเปล่าเท่านั้น
  // ทำเฉพาะตอน download=true (Ken Burns ต้อง render ไฟล์จริง — ไม่เหมาะกับ preview/search-only call)
  const hasImageFallback = canUseUnsplashFallback || canUsePexelsPhotoFallback || canUsePixabayPhotoFallback || canUseFlickrFallback || canUseWikimediaFallback || canUseNasaFallback || canUseMetFallback || canUseKieFallback;
  let kieCreditExhausted = false; // ตั้งเป็น true เมื่อ kie.ai ตอบ credit หมด → แจ้งผู้ใช้ตอนได้ 0 clips
  if (download && useAutoMix && hasImageFallback) {
    const foundKeywords = new Set(found.map(f => f.keyword));
    const seen = new Set<string>();
    const allMissing = keywords
      .map((kw, ki) => ({ kw, ki }))
      .filter(({ kw }) => {
        if (foundKeywords.has(kw) || seen.has(kw)) return false;
        seen.add(kw);
        return true;
      });
    // Cap จำนวนภาพ fallback ไม่ให้เกิน downloadClipLimit — สำคัญตอนข้าม video
    // (ทุก keyword missing) ไม่งั้น generate ภาพ kie.ai ทุก keyword = เปลือง credit
    // และเกินจำนวนที่ผู้ใช้ตั้ง (เช่น B-roll=2 ควรได้ภาพ 2 อัน ไม่ใช่ 64)
    const remainingSlots = Math.max(0, downloadClipLimit - found.length);
    const baseMissing = allMissing.slice(0, remainingSlots > 0 ? remainingSlots : allMissing.length);
    // slot = ตำแหน่งใน list (ใช้ทำ id ไม่ให้ชนกัน), ki = index ของ keyword เดิม (ใช้ map subtitle)
    let uniqueMissing = baseMissing.map((m, slot) => ({ ...m, slot }));
    // กรณี keyword น้อยกว่าจำนวนที่ตั้ง (เช่น script สั้น 1 keyword แต่ B-roll=3):
    // วน keyword ซ้ำให้ครบ slot — kie.ai สร้างภาพต่างกันแต่ละครั้ง แม้ query เดิม
    // (slot ต่างกัน → id/ไฟล์ไม่ชนกัน). ทำเฉพาะตอนกำหนดจำนวนเองชัดเจน
    if (overrideClipCount > 0 && allMissing.length > 0 && uniqueMissing.length < remainingSlots) {
      uniqueMissing = Array.from({ length: remainingSlots }, (_, slot) => ({
        ...allMissing[slot % allMissing.length],
        slot,
      }));
    }

    if (uniqueMissing.length > 0) {
      console.log(`[fetch-stock] Auto Mix: ${allMissing.length} keyword(s) missing video → image fallback for ${uniqueMissing.length} (limit=${downloadClipLimit}, found=${found.length})`);

      const IMAGE_PROVIDER_OFFSET: Record<ImageProvider, number> = {
        unsplash: UNSPLASH_ID_OFFSET,
        "pexels-photo": PEXELS_PHOTO_ID_OFFSET,
        "pixabay-photo": PIXABAY_PHOTO_ID_OFFSET,
        flickr: FLICKR_ID_OFFSET,
        wikimedia: WIKIMEDIA_ID_OFFSET,
        nasa: NASA_ID_OFFSET,
        met: MET_ID_OFFSET,
      };

      await withConcurrency(uniqueMissing, Math.min(2, DOWNLOAD_CONCURRENCY), async ({ kw, ki, slot }) => {
        const query = subtitleTexts?.[ki] || kw;

        // ลองตามลำดับ provider ที่ตรงกับ topic ของ query (keyword-aware routing)
        for (const provider of getImageProviderOrder(query)) {
          if (provider === "unsplash" && !canUseUnsplashFallback) continue;
          if (provider === "pexels-photo" && !canUsePexelsPhotoFallback) continue;
          if (provider === "pixabay-photo" && !canUsePixabayPhotoFallback) continue;
          if (provider === "flickr" && !canUseFlickrFallback) continue;
          if (provider === "wikimedia" && !canUseWikimediaFallback) continue;
          if (provider === "nasa" && !canUseNasaFallback) continue;
          if (provider === "met" && !canUseMetFallback) continue;

          const id = IMAGE_PROVIDER_OFFSET[provider] + slot;
          const imageFile = `${userPrefix}${id}.src.jpg`;
          const imagePath = path.join(rendersDir, imageFile);
          const outFile = `${userPrefix}${id}.mp4`;
          const outPath = path.join(rendersDir, outFile);
          try {
            let fallback: ImageFallbackResult | null = null;
            switch (provider) {
              case "unsplash":      fallback = await tryUnsplashKenBurns(query, unsplashKey!, imagePath, outPath); break;
              case "pexels-photo":  fallback = await tryPexelsPhotoKenBurns(query, pexelsKey!, imagePath, outPath); break;
              case "pixabay-photo": fallback = await tryPixabayPhotoKenBurns(query, pixabayKey!, imagePath, outPath); break;
              case "flickr":        fallback = await tryFlickrKenBurns(query, flickrKey!, imagePath, outPath); break;
              case "wikimedia":     fallback = await tryWikimediaKenBurns(query, imagePath, outPath); break;
              case "nasa":          fallback = await tryNasaKenBurns(query, imagePath, outPath); break;
              case "met":           fallback = await tryMetKenBurns(query, imagePath, outPath); break;
            }
            if (fallback && isValidMp4Path(outPath)) {
              stockTelemetry.downloadedCount++;
              stockTelemetry.normalizeSkippedCount++;
              try { fs.writeFileSync(normalizedMarkerPath(outPath), ""); } catch {}
              results.push({
                keyword: kw, pexelsId: id, duration: fallback.duration, videoUrl: fallback.imageUrl,
                localPath: outPath, localUrl: `/api/stocks/${outFile}`,
                imageUrl: fallback.imageUrl, imageLocalUrl: `/api/stocks/${imageFile}`,
                assetMeta: fallback.assetMeta,
              });
              return;
            }
          } catch (e) {
            console.error(`[fetch-stock] Auto Mix ${provider} fallback failed for "${query}":`, e);
          }
        }

        // Fall back to kie.ai AI image
        if (canUseKieFallback) {
          const id = KIE_ID_OFFSET + slot;
          const imageFile = `${userPrefix}${id}.src.jpg`;
          const imagePath = path.join(rendersDir, imageFile);
          const outFile = `${userPrefix}${id}.mp4`;
          const outPath = path.join(rendersDir, outFile);
          try {
            const { duration, imageUrl } = await generateKieImageKenBurns(query, kieKey!, resolvedKieModel, imagePath, outPath);
            if (isValidMp4Path(outPath)) {
              stockTelemetry.downloadedCount++;
              stockTelemetry.normalizeSkippedCount++;
              try { fs.writeFileSync(normalizedMarkerPath(outPath), ""); } catch {}
              results.push({
                keyword: kw, pexelsId: id, duration, videoUrl: imageUrl,
                localPath: outPath, localUrl: `/api/stocks/${outFile}`,
                imageUrl, imageLocalUrl: `/api/stocks/${imageFile}`,
                assetMeta: { provider: "kie-ai", assetId: String(id), downloadUrl: imageUrl },
              });
            }
          } catch (e) {
            console.error(`[fetch-stock] Auto Mix kie.ai fallback failed for "${query}":`, e);
            // จับ "credit หมด" เพื่อแจ้งผู้ใช้ตอนท้าย (ไม่งั้นได้ 0 clips เงียบๆ)
            const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
            if (msg.includes("credit") || msg.includes("insufficient") || msg.includes("balance") || msg.includes("top up")) {
              kieCreditExhausted = true;
            }
          }
        }
      });
    }
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
  stockTelemetry.selectionPhaseMs = Date.now() - selectionPhaseStartedAt;
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
    // kie.ai credit หมด และ generate ไม่ได้เลย → แจ้งผู้ใช้ตรงๆ (ไม่ใช่ results ว่างเงียบ)
    if (kieCreditExhausted && results.length === 0) {
      await recordFetchStockTelemetry("error", { providerErrorCode: "quota", errorProvider: "kie" });
      return NextResponse.json({
        error: "kie.ai เครดิตหมด — กรุณาเติมเครดิตที่ kie.ai หรือเลือกแหล่งภาพอื่น (Unsplash/Wikimedia ฟรี) ใน B-roll Sources",
        retryable: false,
        provider: "kie",
        code: "quota",
      }, { status: 402 });
    }
    // ไม่มี video clip — แต่ Auto Mix image fallback อาจ push ภาพเข้า results แล้ว
    // (เช่นข้าม video ใช้ kie.ai ล้วน) → คืน results ที่มีจริง ไม่ใช่ [] เปล่าๆ
    await recordFetchStockTelemetry("done", { emptyResult: results.length === 0, selectionDebugSample });
    return NextResponse.json({ results });
  }

  // ── Download phase ──
  const downloadPhaseStartedAt = Date.now();
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
  stockTelemetry.downloadPhaseMs = Date.now() - downloadPhaseStartedAt;

  stockTelemetry.servedClipCount = results.length;
  await recordFetchStockTelemetry("done", { selectionDebugSample });
  console.log(`[fetch-stock] downloaded ${results.length} clips`);
  return NextResponse.json({ results });
}

// DELETE /api/videos/fetch-stock — no-op, files are kept
export async function DELETE() {
  return NextResponse.json({ deleted: 0 });
}
