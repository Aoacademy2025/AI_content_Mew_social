import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { decryptKey } from "@/lib/key-crypto";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { reserveAiTextCall } from "@/lib/ai-text-limits";
import { geminiGenerateText, geminiGenerateVision } from "@/lib/gemini";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { isProviderError, toErrorResponse, type ProviderError } from "@/lib/provider-errors";
import {
  detectContentProfile,
  normalizeContentProfile,
  type ContentProfile,
} from "@/lib/broll-profile";
import { clampedLongSide } from "@/lib/broll-source-quality";
import { parseLlmRankResponse } from "@/lib/llm-rank-parse";
import {
  specToTerms,
  profileToTerms,
  scoreCandidateSoft,
  shouldDistrustRanker,
  type RelevanceSpec,
  type RelevanceTerms,
} from "@/lib/relevance-spec";
import { buildKieImagePrompt } from "@/lib/kie-image-prompt";
import {
  spendCredits,
  refundCredits,
  creditCostFor,
  costKeyForKieModel,
  ensureMonthlyGrant,
} from "@/lib/credits";
import {
  kieMaxImagesPerJob,
  tryConsumeKieImageRate,
  capKiePrompt,
  resolveKieImageAccess,
  shouldGuardKieImages,
  mergeCapClampReason,
} from "@/lib/kie-image-guards";
import { aiGenPieceCount } from "@/lib/broll-even-split";
import { planAutoMixSources, pickEvenIndices } from "@/lib/automix-plan";
import { parseAutoMixWeights } from "@/lib/automix-weights";
import {
  applyBrollPreferenceToSearchQueries,
  brollPreferenceInstruction,
  type BrollPreferenceInput,
} from "@/lib/broll-preferences";
import {
  kieCreateTask,
  kiePollResult,
  type KieImageModel,
  DEFAULT_KIE_IMAGE_MODEL,
  isKieImageModel,
  buildKieImageInput,
} from "@/lib/kie-client";
import {
  normalizeForRemotion,
  type NormalizeResult,
  normalizedMarkerPath,
  safeUnlink,
  isValidMp4Path,
  downloadAndCrop,
  searchPexels,
  type PexelsVideo,
  type PexelsVideoFile,
  searchPixabay,
  type PixabayVideo,
  applyKenBurns,
  generateKieImageKenBurns,
  KEN_BURNS_DURATION_SEC,
  NORMALIZE_CONCURRENCY,
  NORMALIZE_TIMEOUT_MS,
  NORMALIZE_PRESET,
} from "@/lib/broll-asset-lib";
import path from "path";
import fs from "fs";

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
  /** poster/thumbnail URL (Pexels `image`, Pixabay `videos.medium.thumbnail`) — vision re-rank */
  thumb?: string;
};

type CandidateFit = {
  index: number;
  score: number;
  rejectReason?: string;
  isRelevant: boolean;
};

export const maxDuration = 600;
export const runtime = "nodejs";

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

// Pick best video file: HD portrait ≤1080p preferred, any portrait accepted.
// Cap at 1920px on the long side — 4K files (2160p) are too large to download reliably.
// PORTRAIT-ONLY (2026-07-03): a hit with no portrait mp4 is SKIPPED (return null) instead
// of falling back to a landscape file — the 9:16 renderer center-crops landscape and loses
// the subject (เหรียญหลุดเฟรมเหลือแต่กำแพงขาว). Pools are deep (up to 80 hits/keyword), so
// skipping rogue landscape hits beats shipping a broken crop. Resolution caps unchanged
// (#63 no-4K + HD preference stay — that's the download/normalize-speed protection).
function pickBestFile(video: PexelsVideo): PexelsVideoFile | null {
  const files = video.video_files.filter(f => f.file_type === "video/mp4");
  const under1080 = (f: PexelsVideoFile) => Math.max(f.width, f.height) <= 1920;
  const portrait = files.filter(f => f.height > f.width);
  const hdPortrait = portrait.filter(under1080).find(f => f.quality === "hd")
    ?? portrait.filter(under1080)[0];
  if (hdPortrait) return hdPortrait;
  if (portrait[0]) return portrait[0]; // fallback: any portrait even if large
  return null; // no portrait file → skip this hit (never crop landscape into 9:16)
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
// กันชน id กับ source อื่นๆ — kie.ai generated item ใช้ index เป็น id ฐาน
const KIE_ID_OFFSET = 2_000_000_000;

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

// ── VISION re-rank (2026-07-03) ──────────────────────────────────────────────
// The text ranker judges clips by title/tags — it never SEES them, which is the
// root of "บีโรลไม่ตรงเนื้อหา" feedback (stock titles are thin/wrong). This pass
// sends the top-N candidates' REAL thumbnails to Gemini Flash (1 call per fetch,
// ~258 tokens/image ≈ ฿0.05-0.15/clip) and picks by what the footage actually
// shows. Kill-switch: BROLL_VISION_RERANK=0. Every failure path falls back to
// the existing text ranker → deterministic ranking (fail-open, never blocks).
const VISION_RERANK_ON = process.env.BROLL_VISION_RERANK !== "0";
const VISION_TOP_N = 4;          // thumbnails considered per subtitle
const VISION_MAX_IMAGES = 60;    // total per call — long clips beyond this keep text ranking
const VISION_THUMB_TIMEOUT_MS = 5_000;
const VISION_THUMB_MAX_BYTES = 400_000;

async function fetchThumbBase64(url: string): Promise<{ mimeType: string; dataBase64: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(VISION_THUMB_TIMEOUT_MS) });
    if (!res.ok) return null;
    const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    if (!mimeType.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > VISION_THUMB_MAX_BYTES) return null;
    return { mimeType, dataBase64: buf.toString("base64") };
  } catch { return null; }
}

/**
 * Returns bestIdxByKeyword like llmRankCandidates, with -1 for any subtitle the
 * vision pass could not judge (no thumbs / over budget / unparseable) — the
 * caller merges those from the text-ranking result.
 */
async function visionRerankCandidates(
  keywords: string[],
  subtitleTexts: string[],
  candidatesByKeyword: CandidateVideo[][],
  llmKey: string,
  terms: RelevanceTerms,
  preferenceInstruction: string = "",
): Promise<number[]> {
  // Pick top-N judgeable candidates per subtitle by the existing soft ranking.
  const perKeyword: { ki: number; entries: { candIdx: number; thumb: string }[] }[] = [];
  let imageBudget = VISION_MAX_IMAGES;
  for (let ki = 0; ki < keywords.length && imageBudget > 0; ki++) {
    const cands = candidatesByKeyword[ki] ?? [];
    if (!cands.length) continue;
    const order = orderCandidateIndices(cands, -1, keywords[ki] ?? "", subtitleTexts[ki] ?? "", terms, true);
    const entries: { candIdx: number; thumb: string }[] = [];
    for (const fit of order) {
      const c = cands[fit.index];
      if (c?.thumb && entries.length < VISION_TOP_N) entries.push({ candIdx: fit.index, thumb: c.thumb });
    }
    if (entries.length >= 2 && imageBudget >= entries.length) {
      imageBudget -= entries.length;
      perKeyword.push({ ki, entries });
    }
  }
  if (!perKeyword.length) return keywords.map(() => -1);

  // Download thumbnails (parallel, failures drop the entry).
  const fetched = await Promise.all(perKeyword.map(async (group) => ({
    ...group,
    images: await Promise.all(group.entries.map(async (e) => ({ ...e, img: await fetchThumbBase64(e.thumb) }))),
  })));

  const images: { mimeType: string; dataBase64: string }[] = [];
  const promptGroups: string[] = [];
  const letterOf = (i: number) => String.fromCharCode(65 + i); // A, B, C…
  const groupMap: { ki: number; candIdxs: number[] }[] = [];
  for (const group of fetched) {
    const ok = group.images.filter((e) => e.img);
    if (ok.length < 2) continue;
    const candIdxs: number[] = [];
    const labels: string[] = [];
    for (let i = 0; i < ok.length; i++) {
      images.push(ok[i].img!);
      candIdxs.push(ok[i].candIdx);
      labels.push(`${letterOf(i)}=image#${images.length}`);
    }
    promptGroups.push(`S${group.ki}: subtitle="${(subtitleTexts[group.ki] ?? keywords[group.ki] ?? "").slice(0, 160)}" options: ${labels.join(", ")}`);
    groupMap.push({ ki: group.ki, candIdxs });
  }
  if (!groupMap.length) return keywords.map(() => -1);

  const preferenceLine = preferenceInstruction
    ? `\nSTRICT VISUAL PREFERENCE: ${preferenceInstruction} Reject options whose people clearly violate this preference.`
    : "";

  const prompt = `You are a B-roll editor. Images are numbered in the order attached (image#1, image#2, …).
For EACH subtitle below, look at its option images and pick the letter whose footage VISUALLY matches the subtitle's content best.
Down-rank footage of: ${terms.avoid.slice(0, 8).join(", ") || "unrelated subjects"}. Visual domain: ${terms.domainLabel}.${preferenceLine}
Output ONLY a JSON object mapping subtitle keys to a letter, e.g. {"S0":"B","S3":"A"}. Use "NONE" only if every option is truly unrelated.

${promptGroups.join("\n")}`;

  const raw = await geminiGenerateVision(llmKey, prompt, images, Math.max(200, groupMap.length * 10 + 80));
  const jsonText = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  const parsed = JSON.parse(jsonText) as Record<string, string>;

  const out = keywords.map(() => -1);
  for (const g of groupMap) {
    const pick = String(parsed[`S${g.ki}`] ?? "").trim().toUpperCase();
    const li = pick.charCodeAt(0) - 65;
    if (pick.length === 1 && li >= 0 && li < g.candIdxs.length) out[g.ki] = g.candIdxs[li];
  }
  return out;
}

async function llmRankBatch(
  keywords: string[],
  subtitleTexts: string[],
  candidateTitles: string[][],
  llmKey: string,
  visualDirection?: string,
  terms: RelevanceTerms = { positive: [], avoid: [], fallbackQueries: [], domainLabel: "general" },
  preferenceInstruction: string = "",
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
  const preferenceRankLine = preferenceInstruction
    ? `\nVISUAL PREFERENCE (strict): ${preferenceInstruction} Prefer candidates matching it; use -1 rather than picking a clear violation when alternatives exist.\n`
    : "";

  const lastIdx = keywords.length - 1;
  const prompt = `You are a B-roll video editor. For each subtitle, pick the candidate video index (0-based) that BEST matches the subtitle's visual content, content profile, and overall video direction.
${directionLine}
${profileLine}${preferenceRankLine}
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
  preferenceInstruction: string = "",
): Promise<number[]> {
  if (keywords.length <= RANK_BATCH_SIZE) {
    return llmRankBatch(keywords, subtitleTexts, candidateTitles, llmKey, visualDirection, terms, preferenceInstruction);
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
      const chunkResult = await llmRankBatch(chunkKws, chunkSubs, chunkTitles, llmKey, visualDirection, terms, preferenceInstruction);
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
    autoMixWeights,
    subtitleTexts,
    perSubtitleMode: perSubtitleFlag = false,
    brollWindowMode = false,
    fullScript,
    visualDirection,
    contentProfile,
    relevanceSpec,
    brollRegionPreference,
    brollVisualStyle,
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
    autoMixWeights?: unknown;
    subtitleTexts?: string[];
    perSubtitleMode?: boolean;
    brollWindowMode?: boolean;
    fullScript?: string;
    visualDirection?: string;
    contentProfile?: string;
    relevanceSpec?: RelevanceSpec | null;
    brollRegionPreference?: string;
    brollVisualStyle?: string;
    pipelineRunId?: string;
    draftId?: string;
  } = body ?? {};
  const brollPreference: BrollPreferenceInput = { brollRegionPreference, brollVisualStyle };
  const withBrollPreference = (queries: string[]) => applyBrollPreferenceToSearchQueries(queries, brollPreference);
  const preferenceInstruction = brollPreferenceInstruction(brollPreference);
  const telemetryPipelineRunId = typeof pipelineRunId === "string" && pipelineRunId.trim()
    ? pipelineRunId.trim().slice(0, 120)
    : null;
  const telemetryDraftId = typeof draftId === "string" && draftId.trim()
    ? draftId.trim().slice(0, 120)
    : null;
  // Auto Mix: ผู้ใช้เลือกได้ว่าจะเปิด provider ภาพ fallback ตัวไหนบ้าง (undefined = ทุกตัว, ตาม default เดิม)
  const allowedAutoMixProviders: Set<string> | null = Array.isArray(autoMixProviders) ? new Set(autoMixProviders) : null;
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
    select: { pixabayKey: true, pexelsKey: true, kieKey: true, unsplashKey: true, flickrKey: true, geminiKey: true, ttsProvider: true, role: true, plan: true },
  });

  // ── Managed-kie gate + key resolution (flag MANAGED_KIE) ──────────────────
  // Flag OFF → byte-identical to before: kie sources are ADMIN-only and use the
  // user's own BYOK key (never charged). Flag ON + CREDITS_LIVE → PRO/BUSINESS
  // users are un-gated and generate on the server's managed KIE_API_KEY, metered
  // to their credits (spend-before-generate below). FREE always stays 403.
  const managedKieOn = process.env.MANAGED_KIE === "1";
  const creditsLive = process.env.CREDITS_LIVE === "1";
  const isAdmin = user?.role === "ADMIN";
  const isPaidPlan = user?.plan === "PRO" || user?.plan === "BUSINESS";
  const kieEnvKey = process.env.KIE_API_KEY || null;
  // Access + metering decision (single source of truth — tested in
  // scripts/verify-image-credit-spend.ts). Paid users may reach kie sources only
  // under the full managed+credits flag set; only non-admin paid users are charged.
  const { kiePaidUnlocked, chargeImages } = resolveKieImageAccess({
    managedKieOn, creditsLive, isAdmin, isPaidPlan,
  });

  // AI Image-to-Video (kie.ai) — admins always; paid users only when un-gated.
  if (useKieImage && !isAdmin && !kiePaidUnlocked) {
    return NextResponse.json({ error: "AI Image-to-Video (kie.ai) ยังไม่เปิดให้ใช้งาน — เร็วๆ นี้" }, { status: 403 });
  }

  // Auto Mix (video + image fallback ผ่าน Ken Burns) — same gate as kie image.
  if (useAutoMix && !isAdmin && !kiePaidUnlocked) {
    return NextResponse.json({ error: "Auto Mix ยังไม่เปิดให้ใช้งาน — เร็วๆ นี้" }, { status: 403 });
  }

  const pexelsKey = user?.pexelsKey ? decryptKey(user.pexelsKey) : null;
  const pixabayKey = user?.pixabayKey ? decryptKey(user.pixabayKey) : null;
  const kieKey = user?.kieKey ? decryptKey(user.kieKey) : null;
  // Token actually sent to kie.ai. Flag off → BYOK key (today). Flag on: admins
  // use the managed key when set (else fall back to their BYOK key); paid users
  // use the managed key only. Never logged. Managed key is server-side env only.
  const kieToken: string | null = !managedKieOn
    ? kieKey
    : isAdmin
      ? (kieEnvKey ?? kieKey)
      : isPaidPlan
        ? kieEnvKey
        : kieKey;
  // Does this request actually run on the shared server key? (admin or paid; NOT a
  // user's BYOK key and NOT flag-off). Guardrails (rate/cap/prompt) apply to ANY
  // managed-key generation — admins included (still uncharged) — so one unguarded
  // admin can't loop the shared key. Mirrors the managed-Gemini precedent.
  const usesManagedKey = managedKieOn && !!kieEnvKey && kieToken === kieEnvKey;
  const guardImages = shouldGuardKieImages({ usesManagedKey, chargeImages });
  const unsplashKey = user?.unsplashKey ? decryptKey(user.unsplashKey) : null;
  const flickrKey = user?.flickrKey ? decryptKey(user.flickrKey) : null;

  const canUsePexels = usePexels && !!pexelsKey;
  const canUsePixabay = usePixabay && !!pixabayKey;
  const canUseKieImage = useKieImage && !!kieToken;
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
  const canUseKieFallback = useAutoMix && !!kieToken && isAutoMixProviderAllowed("kie-ai");

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

  let llmKey: string | null = null;
  let llmMode: "managed" | "byok" | null = null;
  if (user) {
    try { const resolved = resolveGeminiKey(user); llmKey = resolved.key; llmMode = resolved.mode; }
    catch (e) { if (!(e instanceof KeyRequiredError)) throw e; /* no key + managed off → null → soft heuristic fallback below */ }
  }

  // ── Managed-kie credit metering (money path) ──────────────────────────────
  // Non-admin paid users are restricted to the 3 priced models server-side; if a
  // client somehow requests an unpriced/admin-only model, coerce to the default
  // priced model so we never hand out free unpriced generation.
  const effectiveKieModel: KieImageModel =
    chargeImages && costKeyForKieModel(resolvedKieModel) === null
      ? DEFAULT_KIE_IMAGE_MODEL
      : resolvedKieModel;
  const imageCostKey = costKeyForKieModel(effectiveKieModel);
  const imageCost = imageCostKey ? creditCostFor(imageCostKey) : 0;
  const imageSpendAction = "ai-image";
  const imageRefundAction = "ai-image-refund";
  const maxImagesPerJob = kieMaxImagesPerJob();
  // Captured non-null id (narrowing from the early !authUser 401 guard is not
  // preserved into the nested spend/refund closures below).
  const spenderUserId = authUser.id;
  const aiBillingMode =
    chargeImages ? "paid-managed-charged"
    : usesManagedKey && isAdmin ? "admin-managed-free"
    : usesManagedKey ? "managed-free"
    : isAdmin && !!kieToken ? "admin-byok"
    : !!kieToken ? "byok-free"
    : "unavailable";
  const aiTelemetry = {
    aiModel: effectiveKieModel,
    aiCreditCostKey: imageCostKey,
    aiCreditCostPerImage: imageCost,
    aiBillingMode,
    aiChargeImages: chargeImages,
    aiUsesManagedKey: usesManagedKey,
    aiGenRequestedCount: 0,
    aiGenPlannedCount: 0,
    aiGenAttemptCount: 0,
    aiGenSuccessCount: 0,
    aiGenFailedCount: 0,
    aiGenSkippedCount: 0,
    aiGenSkippedCreditsCount: 0,
    aiGenSkippedRateCount: 0,
    aiGenSkippedCapCount: 0,
    aiChargedCount: 0,
    aiCreditsSpent: 0,
    aiCreditsSpentGranted: 0,
    aiCreditsSpentPurchased: 0,
    aiRefundedCount: 0,
    aiCreditsRefunded: 0,
    aiCreditsRefundedGranted: 0,
    aiCreditsRefundedPurchased: 0,
    aiLastCreditBalanceAfterSpend: null as number | null,
  };

  function trackAiSkip(reason: "credits" | "rate" | "cap" | null, count = 1) {
    aiTelemetry.aiGenSkippedCount += count;
    if (reason === "credits") aiTelemetry.aiGenSkippedCreditsCount += count;
    if (reason === "rate") aiTelemetry.aiGenSkippedRateCount += count;
    if (reason === "cap") aiTelemetry.aiGenSkippedCapCount += count;
  }

  // Ensure the paid user's current-period monthly credit allowance is granted
  // before the first spend (idempotent; itself CREDITS_LIVE-gated).
  if (chargeImages) {
    try { await ensureMonthlyGrant(spenderUserId); } catch { /* non-fatal */ }
  }

  // Signal surfaced in the response when AI generation was skipped mid-job:
  //   "credits" = out of credits · "rate" = hourly rate ceiling · "cap" = per-job cap.
  let aiSkippedReason: "credits" | "rate" | "cap" | null = null;
  let aiGenCount = 0; // managed-key generation attempts this job (charged OR admin-free)

  type ImageSpendGate =
    | { proceed: true; charged: false }
    | { proceed: true; charged: true; creditsSpent: number; balanceAfter: number; fromGranted: number; fromPurchased: number }
    | { proceed: false; reason: "credits" | "rate" | "cap" | null };

  // Gate before each managed-key generation. Guardrails (per-job cap + hourly rate)
  // apply to EVERY managed-key request — admins included (uncharged) — so one admin
  // can't loop the shared key. Metering (spend) applies only to non-admin paid users.
  // Once any guard trips, aiSkippedReason halts all remaining AI attempts this job.
  async function attemptImageSpend(): Promise<ImageSpendGate> {
    if (guardImages) {
      if (aiSkippedReason) {
        trackAiSkip(aiSkippedReason);
        return { proceed: false, reason: aiSkippedReason };
      }
      if (aiGenCount >= maxImagesPerJob) {
        aiSkippedReason = "cap";
        trackAiSkip("cap");
        return { proceed: false, reason: "cap" };
      }
      if (!tryConsumeKieImageRate(spenderUserId)) {
        aiSkippedReason = "rate";
        trackAiSkip("rate");
        return { proceed: false, reason: "rate" };
      }
    }
    if (chargeImages) {
      aiGenCount++; // reserve the slot synchronously (precise cap under concurrency)
      const spend = await spendCredits(spenderUserId, imageCost, imageSpendAction);
      if (!spend.ok) {
        aiSkippedReason = "credits";
        aiGenCount--;
        trackAiSkip("credits");
        return { proceed: false, reason: "credits" };
      }
      aiTelemetry.aiChargedCount++;
      aiTelemetry.aiCreditsSpent += imageCost;
      aiTelemetry.aiCreditsSpentGranted += spend.fromGranted;
      aiTelemetry.aiCreditsSpentPurchased += spend.fromPurchased;
      aiTelemetry.aiLastCreditBalanceAfterSpend = spend.balanceAfter;
      return { proceed: true, charged: true, creditsSpent: imageCost, balanceAfter: spend.balanceAfter, fromGranted: spend.fromGranted, fromPurchased: spend.fromPurchased };
    }
    // Admin on the managed key: guarded above (cap/rate consumed) but never charged.
    if (guardImages) aiGenCount++;
    return { proceed: true, charged: false };
  }

  // Refund the exact buckets a prior spend drained (kie generation failed AFTER
  // the charge). The createTask attempt still counted toward the per-job cap.
  async function refundImageSpend(g: { creditsSpent: number; fromGranted: number; fromPurchased: number }): Promise<void> {
    await refundCredits(spenderUserId, g.fromGranted, g.fromPurchased, imageRefundAction);
    aiTelemetry.aiRefundedCount++;
    aiTelemetry.aiCreditsRefunded += g.creditsSpent;
    aiTelemetry.aiCreditsRefundedGranted += g.fromGranted;
    aiTelemetry.aiCreditsRefundedPurchased += g.fromPurchased;
  }

  // Prompt sent to kie is length-capped on any managed-key request (admin or paid);
  // flag-off / BYOK prompts untouched — byte-identical.
  const promptFor = (raw: string): string => (guardImages ? capKiePrompt(raw) : raw);

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

  // ── Auto Mix source plan ──────────────────────────────────────────────────
  // Pre-assign each b-roll PIECE a source (video / free photo / paid AI) by weight so
  // the result is a real, interleaved mix — NOT "all video, image only where video is
  // missing" (the old video-first-fallback that collapsed to 100% video). Piece count is
  // cadence-capped (21s → ~6) so we never pay for one AI image per caption. Default
  // weight video:photo:ai = 3:2:1 (env-tunable AUTOMIX_WEIGHT_*); only providers the user
  // actually enabled (key present + checked) get a non-zero weight. Active only for
  // stockSource=auto-mix; every other mode is untouched.
  const autoMixActiveVideo = new Set<number>();   // ki → fetch a real video clip
  const autoMixPhotoSlots = new Set<number>();    // ki → free-photo provider (Ken Burns)
  const autoMixAiSlots = new Set<number>();       // ki → kie.ai generated image (paid)
  if (useAutoMix) {
    const anyPhotoUsable =
      canUseUnsplashFallback || canUsePexelsPhotoFallback || canUsePixabayPhotoFallback ||
      canUseFlickrFallback || canUseWikimediaFallback || canUseNasaFallback || canUseMetFallback;
    // Editor v2 "mix preset" (D5.1): honor request-supplied autoMixWeights over the env
    // defaults ONLY under MANAGED_KIE and only when they are sane ints 0–9. The ai weight
    // is force-zeroed for users NOT authorized for kie spend — same gate as the 403 above
    // (isAdmin || kiePaidUnlocked). Flag off / field absent / invalid → reqWeights is null
    // and the else branch is BYTE-IDENTICAL to the pre-preset env-only behavior.
    const reqWeights = managedKieOn ? parseAutoMixWeights(autoMixWeights) : null;
    const weights = reqWeights
      ? {
          video: autoMixUsesVideo ? reqWeights.video : 0,
          photo: anyPhotoUsable ? reqWeights.photo : 0,
          ai: (canUseKieFallback && (isAdmin || kiePaidUnlocked)) ? reqWeights.ai : 0,
        }
      : {
          video: autoMixUsesVideo ? readIntEnv("AUTOMIX_WEIGHT_VIDEO", 3, 0, 100) : 0,
          photo: anyPhotoUsable ? readIntEnv("AUTOMIX_WEIGHT_PHOTO", 2, 0, 100) : 0,
          ai: canUseKieFallback ? readIntEnv("AUTOMIX_WEIGHT_AI", 1, 0, 100) : 0,
        };
    const pieceCount = brollWindowMode
      ? keywords.length
      : aiGenPieceCount(totalDurationSec, Math.min(keywords.length, downloadClipLimit), isPerSubtitleMode, downloadClipLimit);
    const activeIdx = pickEvenIndices(keywords.length, pieceCount);
    const plan = planAutoMixSources(activeIdx.length, weights);
    activeIdx.forEach((ki, j) => {
      const src = plan[j] ?? "video";
      if (src === "ai") autoMixAiSlots.add(ki);
      else if (src === "photo") autoMixPhotoSlots.add(ki);
      else autoMixActiveVideo.add(ki);
    });
    aiTelemetry.aiGenRequestedCount += autoMixAiSlots.size;
    aiTelemetry.aiGenPlannedCount += autoMixAiSlots.size;
    console.log(`[fetch-stock] Auto Mix plan: ${pieceCount} pieces over ${keywords.length} kw → ${autoMixActiveVideo.size} video / ${autoMixPhotoSlots.size} photo / ${autoMixAiSlots.size} ai (weights v${weights.video}:p${weights.photo}:a${weights.ai})`);
  }

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
    visionRankingUsed: false,
    visionRankingFailed: false,
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

  async function recordAiGenerationTelemetry(input: {
    status: "done" | "error";
    mode: "kie-image" | "auto-mix";
    keywordIndex: number;
    assetId: number;
    durationMs: number;
    charged: boolean;
    creditsSpent: number;
    creditsRefunded: number;
    fromGranted: number;
    fromPurchased: number;
    balanceAfterSpend: number | null;
    failureReason: string | null;
  }) {
    await recordTelemetryEvent(userId, {
      name: input.status === "done" ? "ai_image_generation_server_done" : "ai_image_generation_server_error",
      category: input.status === "done" ? "performance" : "error",
      source: "server",
      step: "fetchStock.aiImage",
      status: input.status,
      durationMs: input.durationMs,
      properties: {
        stockSource,
        resolvedSource: srcLabel,
        pipelineRunId: telemetryPipelineRunId,
        draftId: telemetryDraftId,
        aiProvider: "kie",
        aiMode: input.mode,
        aiModel: effectiveKieModel,
        aiCreditCostKey: imageCostKey,
        aiCreditCostPerImage: imageCost,
        aiBillingMode,
        aiChargeImages: chargeImages,
        aiUsesManagedKey: usesManagedKey,
        aiCharged: input.charged,
        aiCreditsSpent: input.creditsSpent,
        aiCreditsRefunded: input.creditsRefunded,
        aiCreditsNet: input.creditsSpent - input.creditsRefunded,
        aiCreditsSpentGranted: input.fromGranted,
        aiCreditsSpentPurchased: input.fromPurchased,
        aiCreditsRefundedGranted: input.creditsRefunded > 0 ? input.fromGranted : 0,
        aiCreditsRefundedPurchased: input.creditsRefunded > 0 ? input.fromPurchased : 0,
        aiBalanceAfterSpend: input.balanceAfterSpend,
        aiKeywordIndex: input.keywordIndex,
        aiAssetId: input.assetId,
        aiFailureReason: input.failureReason,
      },
    }).catch(() => {});
  }

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
        ...aiTelemetry,
        aiCreditsNet: aiTelemetry.aiCreditsSpent - aiTelemetry.aiCreditsRefunded,
        normalizeMsAvg: normalizeAttempts > 0 ? Math.round(stockTelemetry.normalizeMsTotal / normalizeAttempts) : 0,
        ...stockTelemetry,
        ...extra,
      },
    }).catch(() => {});
  }

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
    // Cost cap: on the per-subtitle AUTO path, pay for ~ceil(duration/cadence) images
    // (e.g. 21s → ~6), NOT one per caption. Manual clip counts (overrideClipCount set by
    // the user, perSubtitleMode false) bypass the cadence cap via isAuto=false.
    const clipsToGenerateRaw = brollWindowMode
      ? Math.min(keywords.length, PER_SUBTITLE_DOWNLOAD_LIMIT)
      : aiGenPieceCount(
          totalDurationSec,
          Math.min(keywords.length, downloadClipLimit),
          isPerSubtitleMode,
          PER_SUBTITLE_DOWNLOAD_LIMIT,
        );
    // Managed-key generations (admin or paid) are bounded by the per-job cap. When
    // the clamp reduces the requested count, surface "cap" so the client can tell the
    // user some windows were dropped (not silently fewer clips). CRITICAL: track the
    // clamp in a SEPARATE local — it must NOT be written into the shared in-loop
    // `aiSkippedReason`, whose first job is to short-circuit the gate. Setting it here
    // would bail every item in the already-clamped batch (0 clips). Merged in after
    // the loop via mergeCapClampReason.
    const clipsToGenerate = guardImages ? Math.min(clipsToGenerateRaw, maxImagesPerJob) : clipsToGenerateRaw;
    const capClampHit = guardImages && clipsToGenerateRaw > clipsToGenerate;
    aiTelemetry.aiGenRequestedCount += clipsToGenerateRaw;
    aiTelemetry.aiGenPlannedCount += clipsToGenerate;
    if (capClampHit) trackAiSkip("cap", clipsToGenerateRaw - clipsToGenerate);
    console.log(`[fetch-stock] source=${srcLabel}, model=${effectiveKieModel}, generating ${clipsToGenerate} clips`);

    await withConcurrency(
      keywords.slice(0, clipsToGenerate).map((keyword, i) => ({ keyword, i })),
      Math.min(2, DOWNLOAD_CONCURRENCY),
      async ({ keyword, i }) => {
        const query = subtitleTexts?.[i] || keyword;
        const id = KIE_ID_OFFSET + i;
        const imageFile = `${userPrefix}${id}.src.jpg`;
        const imagePath = path.join(rendersDir, imageFile);
        // Spend-before-generate. Skipped (credits/rate/cap) → no generation.
        const gate = await attemptImageSpend();
        if (!gate.proceed) return;
        aiTelemetry.aiGenAttemptCount++;
        const aiStartedAt = Date.now();
        let success = false;
        let failureReason: string | null = null;
        try {
          if (download) {
            const outFile = `${userPrefix}${id}.mp4`;
            const outPath = path.join(rendersDir, outFile);
            try {
              const genPrompt = promptFor(buildKieImagePrompt(keyword, {
                visualDirection,
                terms: relTerms,
                region: brollPreference.brollRegionPreference,
                style: brollPreference.brollVisualStyle,
              }));
              const { duration, imageUrl } = await generateKieImageKenBurns(genPrompt, keyword, kieToken!, effectiveKieModel, imagePath, outPath);
              if (!isValidMp4Path(outPath)) {
                stockTelemetry.downloadFailCount++;
                failureReason = "invalid_output";
                return;
              }
              stockTelemetry.downloadedCount++;
              stockTelemetry.normalizeSkippedCount++; // Ken Burns output is already CFR/no-B-frames — no extra normalize pass needed
              try { fs.writeFileSync(normalizedMarkerPath(outPath), ""); } catch {}
              results.push({
                keyword, pexelsId: id, duration, videoUrl: imageUrl,
                localPath: outPath, localUrl: `/api/stocks/${outFile}`,
                imageUrl, imageLocalUrl: `/api/stocks/${imageFile}`,
                assetMeta: { provider: "kie-ai", assetId: String(id), downloadUrl: imageUrl },
              });
              success = true;
            } catch (e) {
              stockTelemetry.downloadFailCount++;
              failureReason = "provider_error";
              console.error(`[fetch-stock] kie.ai Ken Burns failed for "${query}":`, e);
            }
          } else {
            const imageTaskId = await kieCreateTask(effectiveKieModel, buildKieImageInput(effectiveKieModel, promptFor(buildKieImagePrompt(keyword, {
              visualDirection,
              terms: relTerms,
              region: brollPreference.brollRegionPreference,
              style: brollPreference.brollVisualStyle,
            }))), kieToken!);
            const imageUrl = await kiePollResult(imageTaskId, kieToken!);
            results.push({ keyword, pexelsId: id, duration: KEN_BURNS_DURATION_SEC, videoUrl: imageUrl, imageUrl, assetMeta: { provider: "kie-ai", assetId: String(id), downloadUrl: imageUrl } });
            success = true;
          }
        } catch (e) {
          stockTelemetry.noCandidateKeywords++;
          failureReason = "provider_error";
          console.error(`[fetch-stock] kie.ai generation failed for "${query}":`, e);
        } finally {
          let creditsRefunded = 0;
          let refundError: unknown = null;
          // Refund the exact buckets if we charged but produced no usable clip.
          if (gate.charged && !success) {
            try {
              await refundImageSpend(gate);
              creditsRefunded = gate.creditsSpent;
            } catch (e) {
              refundError = e;
              failureReason = "refund_error";
            }
          }
          if (success) aiTelemetry.aiGenSuccessCount++;
          else aiTelemetry.aiGenFailedCount++;
          await recordAiGenerationTelemetry({
            status: success ? "done" : "error",
            mode: "kie-image",
            keywordIndex: i,
            assetId: id,
            durationMs: Date.now() - aiStartedAt,
            charged: gate.charged,
            creditsSpent: gate.charged ? gate.creditsSpent : 0,
            creditsRefunded,
            fromGranted: gate.charged ? gate.fromGranted : 0,
            fromPurchased: gate.charged ? gate.fromPurchased : 0,
            balanceAfterSpend: gate.charged ? gate.balanceAfter : null,
            failureReason,
          });
          if (refundError) throw refundError;
        }
      },
    );

    stockTelemetry.foundCount = results.length;
    stockTelemetry.cappedCount = results.length;
    stockTelemetry.servedClipCount = results.length;
    await recordFetchStockTelemetry("done");
    console.log(`[fetch-stock] kie.ai generated ${results.length} clips`);
    // Merge the pre-loop clamp signal (capClampHit) with any in-loop guard reason —
    // in-loop reason wins; otherwise "cap" if the batch was clamped.
    const directReason = mergeCapClampReason(aiSkippedReason, capClampHit);
    return NextResponse.json({ results, ...(directReason ? { aiSkippedReason: directReason } : {}) });
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
        ...(v.image ? { thumb: v.image } : {}),
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
        ...(pv.thumb ? { thumb: pv.thumb } : {}),
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
    const queries = withBrollPreference([
      ...relTerms.fallbackQueries,
      words.slice(0, 2).join(" "),
      words[0],
      words[words.length - 1],
    ]).filter((query, index, arr) => query && query !== keyword && arr.indexOf(query) === index);

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
      const queriesToTry = withBrollPreference([
        ...alts.filter(Boolean),
        keyword,
        keyword.split(" ").slice(0, 2).join(" "),
        keyword.split(" ")[0],
      ]).filter((q, idx, arr) => q && arr.indexOf(q) === idx); // deduplicate

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
    // H1: bound managed-key text-LLM call frequency. At cap → skip the LLM ranker
    // and use deterministic relevance ranking (graceful — never blocks the fetch).
    // BYOK (enforce:false) → no-op, byte-identical to before.
    const rankReserve = hasAnyCandidates
      ? await reserveAiTextCall(userId, { enforce: llmMode === "managed" })
      : { allowed: true };
    if (hasAnyCandidates && !rankReserve.allowed) {
      console.warn(`[fetch-stock] AI text-call ceiling reached — using deterministic relevance ranking instead of LLM`);
      bestIdxByKeyword = candidatesByKeyword.map((cs, i) =>
        bestRelevantCandidateIndex(cs, keywords[i] ?? "", subtitleTexts[i] ?? "", relTerms),
      );
      stockTelemetry.llmRejectedCount = bestIdxByKeyword.filter((idx) => idx < 0).length;
    } else if (hasAnyCandidates) {
      // VISION pass first (sees actual thumbnails; 1 call, replaces the text call in the
      // happy path). Unjudged subtitles get deterministic soft ranking; a thrown vision
      // pass falls through to the text ranker below — today's behavior, unchanged.
      let visionDone = false;
      if (VISION_RERANK_ON) {
        try {
          const v = await visionRerankCandidates(keywords, subtitleTexts, candidatesByKeyword, llmKey, relTerms, preferenceInstruction);
          const judged = v.filter((idx) => idx >= 0).length;
          if (judged > 0) {
            bestIdxByKeyword = v.map((idx, i) =>
              idx >= 0 ? idx : bestRelevantCandidateIndex(candidatesByKeyword[i] ?? [], keywords[i] ?? "", subtitleTexts[i] ?? "", relTerms),
            );
            stockTelemetry.visionRankingUsed = true;
            visionDone = true;
            console.log(`[fetch-stock] VISION re-rank judged ${judged}/${keywords.length} subtitles`);
          }
        } catch (e) {
          stockTelemetry.visionRankingFailed = true;
          console.warn(`[fetch-stock] vision re-rank failed — falling back to text ranking:`, e);
        }
      }
      if (visionDone) { /* vision picked — skip text ranker */ } else {
      stockTelemetry.llmRankingUsed = true;
      console.log(`[fetch-stock] LLM ranking ${keywords.length} keywords in 1 call`);
      try {
        bestIdxByKeyword = await llmRankCandidates(keywords, subtitleTexts, candidateTitles, llmKey, visualDirection, relTerms, preferenceInstruction);
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
      } // end text-ranker fallback (vision-happy-path skips it)
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
    // Auto Mix: only the planned VIDEO slots fetch a real video clip. Photo/AI slots and
    // unselected captions are handled by the image-fallback loop below (or skipped), so
    // the mix isn't drowned out by per-caption video backfill. Other modes never skip.
    if (useAutoMix && !autoMixActiveVideo.has(ki)) continue;

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
    // Plan-driven: process the PHOTO and AI slots chosen up front (broll-source plan
    // above), plus any planned VIDEO slot that found no video (graceful → a photo so the
    // piece isn't lost). Each job carries `kind`: "ai" → kie.ai directly; "photo" → free
    // photo providers first, then kie.ai only if nothing matched. `slot` is unique across
    // all jobs so generated file ids never collide.
    const foundKeywords = new Set(found.map(f => f.keyword));
    type ImageJobKind = "photo" | "ai";
    const imageJobs: { kw: string; ki: number; slot: number; kind: ImageJobKind }[] = [];
    let imageSlotCounter = 0;
    const pushImageJob = (ki: number, kind: ImageJobKind) => {
      imageJobs.push({ kw: keywords[ki] ?? "", ki, slot: imageSlotCounter++, kind });
    };
    for (const ki of autoMixPhotoSlots) pushImageJob(ki, "photo");
    for (const ki of autoMixAiSlots) pushImageJob(ki, "ai");
    for (const ki of autoMixActiveVideo) {
      if (!foundKeywords.has(keywords[ki] ?? "")) pushImageJob(ki, "photo");
    }

    if (imageJobs.length > 0) {
      const aiJobCount = imageJobs.filter(j => j.kind === "ai").length;
      console.log(`[fetch-stock] Auto Mix image jobs: ${imageJobs.length} (${aiJobCount} ai, ${imageJobs.length - aiJobCount} photo); ${found.length} video found`);

      const IMAGE_PROVIDER_OFFSET: Record<ImageProvider, number> = {
        unsplash: UNSPLASH_ID_OFFSET,
        "pexels-photo": PEXELS_PHOTO_ID_OFFSET,
        "pixabay-photo": PIXABAY_PHOTO_ID_OFFSET,
        flickr: FLICKR_ID_OFFSET,
        wikimedia: WIKIMEDIA_ID_OFFSET,
        nasa: NASA_ID_OFFSET,
        met: MET_ID_OFFSET,
      };

      await withConcurrency(imageJobs, Math.min(2, DOWNLOAD_CONCURRENCY), async ({ kw, ki, slot, kind }) => {
        // English keyword is a better stock-search query than the raw Thai subtitle.
        const query = kw || subtitleTexts?.[ki] || "";

        // ลองตามลำดับ provider ที่ตรงกับ topic ของ query (keyword-aware routing).
        // AI slots skip stock search entirely → straight to the kie.ai block below.
        if (kind === "photo") for (const provider of getImageProviderOrder(query)) {
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

        // kie.ai generation — ONLY for planned "ai" slots. A "photo" slot that found no
        // stock image is dropped (the piece is skipped) rather than silently spending a
        // paid AI credit it wasn't budgeted for — keeps the plan's video/photo/ai cost
        // split honest. min-hold tolerates a smaller pool, so a missing piece is fine.
        if (kind === "ai" && canUseKieFallback) {
          // Spend-before-generate for the AutoMix AI slot (skip → piece dropped).
          const gate = await attemptImageSpend();
          if (!gate.proceed) return;
          aiTelemetry.aiGenAttemptCount++;
          const aiStartedAt = Date.now();
          const id = KIE_ID_OFFSET + slot;
          const imageFile = `${userPrefix}${id}.src.jpg`;
          const imagePath = path.join(rendersDir, imageFile);
          const outFile = `${userPrefix}${id}.mp4`;
          const outPath = path.join(rendersDir, outFile);
          let success = false;
          let failureReason: string | null = null;
          try {
            const genPrompt = promptFor(buildKieImagePrompt(kw, {
              visualDirection,
              terms: relTerms,
              region: brollPreference.brollRegionPreference,
              style: brollPreference.brollVisualStyle,
            }));
            const { duration, imageUrl } = await generateKieImageKenBurns(genPrompt, kw, kieToken!, effectiveKieModel, imagePath, outPath);
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
              success = true;
            } else {
              failureReason = "invalid_output";
            }
          } catch (e) {
            console.error(`[fetch-stock] Auto Mix kie.ai fallback failed for "${query}":`, e);
            // จับ "credit หมด" เพื่อแจ้งผู้ใช้ตอนท้าย (ไม่งั้นได้ 0 clips เงียบๆ)
            const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
            if (msg.includes("credit") || msg.includes("insufficient") || msg.includes("balance") || msg.includes("top up")) {
              kieCreditExhausted = true;
              failureReason = "provider_quota";
            } else {
              failureReason = "provider_error";
            }
          } finally {
            let creditsRefunded = 0;
            let refundError: unknown = null;
            // Refund the exact buckets if we charged but produced no usable clip.
            if (gate.charged && !success) {
              try {
                await refundImageSpend(gate);
                creditsRefunded = gate.creditsSpent;
              } catch (e) {
                refundError = e;
                failureReason = "refund_error";
              }
            }
            if (success) aiTelemetry.aiGenSuccessCount++;
            else aiTelemetry.aiGenFailedCount++;
            await recordAiGenerationTelemetry({
              status: success ? "done" : "error",
              mode: "auto-mix",
              keywordIndex: ki,
              assetId: id,
              durationMs: Date.now() - aiStartedAt,
              charged: gate.charged,
              creditsSpent: gate.charged ? gate.creditsSpent : 0,
              creditsRefunded,
              fromGranted: gate.charged ? gate.fromGranted : 0,
              fromPurchased: gate.charged ? gate.fromPurchased : 0,
              balanceAfterSpend: gate.charged ? gate.balanceAfter : null,
              failureReason,
            });
            if (refundError) throw refundError;
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
    return NextResponse.json({ results, ...(aiSkippedReason ? { aiSkippedReason } : {}) });
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

  // Auto Mix: images land in `results` first (rendered during the image loop) and videos
  // after (downloaded later), so without sorting the timeline shows all photos/AI then all
  // video — grouped, not mixed. Re-order by the keyword's position in the script so the
  // planned video/photo/ai sequence is interleaved across the clip. Scoped to auto-mix.
  if (useAutoMix) {
    const kwIdx = new Map<string, number>();
    keywords.forEach((kw, i) => { if (!kwIdx.has(kw)) kwIdx.set(kw, i); });
    const kwOrder = (kw: string) => kwIdx.get(kw) ?? Number.MAX_SAFE_INTEGER;
    results.sort((a, b) => kwOrder(a.keyword) - kwOrder(b.keyword));
  }

  stockTelemetry.servedClipCount = results.length;
  await recordFetchStockTelemetry("done", { selectionDebugSample });
  console.log(`[fetch-stock] downloaded ${results.length} clips`);
  return NextResponse.json({ results, ...(aiSkippedReason ? { aiSkippedReason } : {}) });
}

// DELETE /api/videos/fetch-stock — no-op, files are kept
export async function DELETE() {
  return NextResponse.json({ deleted: 0 });
}
