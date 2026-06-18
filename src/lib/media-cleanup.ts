import fs from "fs";
import path from "path";
import { prisma } from "./prisma";
import { lowResPreviewFilenamesForRender } from "./low-res-preview-paths";

type MediaArea = "renders" | "stocks";

type FileCandidate = {
  area: MediaArea | "tmp";
  filePath: string;
  sizeBytes: number;
};

export type CleanupBucket = {
  count: number;
  sizeMb: number;
};

export type MediaCleanupPlan = {
  renders: {
    total: CleanupBucket;
    older1d: CleanupBucket;
    older3d: CleanupBucket;
    older7d: CleanupBucket;
  };
  stocks: {
    total: CleanupBucket;
    older1d: CleanupBucket;
    older3d: CleanupBucket;
    older7d: CleanupBucket;
    older14d: CleanupBucket;
  };
  tmp: CleanupBucket;
  selected: {
    olderThanDays: number;
    includeStocks: boolean;
    includeTmp: boolean;
    renders: CleanupBucket;
    stocks: CleanupBucket;
    tmp: CleanupBucket;
    total: CleanupBucket;
  };
  protectedCount: number;
  protected: {
    renders: number;
    stocks: number;
  };
  candidates: FileCandidate[];
};

export type MediaCleanupOptions = {
  olderThanDays?: number;
  includeStocks?: boolean;
  includeTmp?: boolean;
  cwd?: string;
};

export type MediaCleanupApplyResult = {
  deleted: number;
  savedMb: number;
  skipped: number;
  message: string;
};

const RENDER_PREFIXES = ["/api/renders/", "/renders/"];
const STOCK_PREFIXES = ["/api/stocks/", "/stocks/"];
const TMP_PATTERNS = [
  "remotion-webpack-bundle-",
  "react-motion-render",
  "puppeteer_dev_chrome_profile-",
];

function clampDays(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(30, Math.floor(n)));
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function addBucket(a: CleanupBucket, b: CleanupBucket): CleanupBucket {
  return { count: a.count + b.count, sizeMb: a.sizeMb + b.sizeMb };
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function pathSizeBytes(filePath: string): number {
  const stat = safeStat(filePath);
  if (!stat) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;

  let total = 0;
  try {
    for (const child of fs.readdirSync(filePath)) {
      total += pathSizeBytes(path.join(filePath, child));
    }
  } catch {}
  return total;
}

function parseJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractPathname(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  try {
    if (/^https?:\/\//i.test(value)) return new URL(value).pathname;
  } catch {}
  return value.split("?")[0].split("#")[0];
}

function mediaRefFromString(raw: string): { area: MediaArea; filename: string } | null {
  const pathname = extractPathname(raw);
  if (!pathname) return null;

  for (const prefix of RENDER_PREFIXES) {
    if (!pathname.startsWith(prefix)) continue;
    const filename = path.basename(pathname.slice(prefix.length));
    return filename ? { area: "renders", filename } : null;
  }

  for (const prefix of STOCK_PREFIXES) {
    if (!pathname.startsWith(prefix)) continue;
    const filename = path.basename(pathname.slice(prefix.length));
    return filename ? { area: "stocks", filename } : null;
  }

  return null;
}

function addProtected(refs: Record<MediaArea, Set<string>>, area: MediaArea, filename: string) {
  if (!filename || filename === "." || filename === "..") return;
  refs[area].add(filename);
  if (area === "stocks") refs[area].add(`${filename}.normalized`);
  if (area === "renders") {
    for (const previewFilename of lowResPreviewFilenamesForRender(filename)) refs[area].add(previewFilename);
  }
}

function collectRefs(value: unknown, refs: Record<MediaArea, Set<string>>, depth = 0) {
  if (depth > 8 || value == null) return;

  if (typeof value === "string") {
    const direct = mediaRefFromString(value);
    if (direct) addProtected(refs, direct.area, direct.filename);

    const parsed = parseJson(value);
    if (parsed) collectRefs(parsed, refs, depth + 1);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs, depth + 1);
    return;
  }

  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectRefs(item, refs, depth + 1);
    }
  }
}

async function buildProtectedRefs(): Promise<Record<MediaArea, Set<string>>> {
  const refs: Record<MediaArea, Set<string>> = {
    renders: new Set(),
    stocks: new Set(),
  };

  const videos = await prisma.video.findMany({
    select: {
      videoUrl: true,
      avatarVideoUrl: true,
      audioUrl: true,
      thumbnail: true,
      thumbnailConfig: true,
      renderConfig: true,
      generatedImages: true,
      sceneMapping: true,
    },
  });

  for (const video of videos) collectRefs(video, refs);

  const images = await prisma.generatedImage.findMany({
    select: { url: true },
  });
  for (const image of images) collectRefs(image.url, refs);

  return refs;
}

function isProtected(filename: string, protectedSet: Set<string>): boolean {
  if (protectedSet.has(filename)) return true;
  if (filename.endsWith(".normalized")) {
    return protectedSet.has(filename.slice(0, -".normalized".length));
  }
  return false;
}

function scanMediaDir(
  dir: string,
  protectedSet: Set<string>,
  days: number[],
): { total: CleanupBucket; buckets: Record<number, CleanupBucket>; selectedFiles: (olderThanDays: number, area: MediaArea) => FileCandidate[] } {
  const buckets: Record<number, CleanupBucket> = {};
  for (const day of days) buckets[day] = { count: 0, sizeMb: 0 };

  const files: Array<{ filePath: string; filename: string; sizeBytes: number; mtimeMs: number }> = [];
  let totalBytes = 0;

  try {
    if (!fs.existsSync(dir)) {
      return {
        total: { count: 0, sizeMb: 0 },
        buckets,
        selectedFiles: () => [],
      };
    }

    for (const filename of fs.readdirSync(dir)) {
      if (isProtected(filename, protectedSet)) continue;
      const filePath = path.join(dir, filename);
      const stat = safeStat(filePath);
      if (!stat?.isFile()) continue;
      totalBytes += stat.size;
      files.push({ filePath, filename, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  } catch {}

  const now = Date.now();
  for (const day of days) {
    const cutoff = now - day * 24 * 60 * 60 * 1000;
    const selected = files.filter((file) => file.mtimeMs < cutoff);
    buckets[day] = {
      count: selected.length,
      sizeMb: mb(selected.reduce((sum, file) => sum + file.sizeBytes, 0)),
    };
  }

  return {
    total: { count: files.length, sizeMb: mb(totalBytes) },
    buckets,
    selectedFiles: (olderThanDays, area) => {
      const cutoff = now - olderThanDays * 24 * 60 * 60 * 1000;
      return files
        .filter((file) => file.mtimeMs < cutoff)
        .map((file) => ({ area, filePath: file.filePath, sizeBytes: file.sizeBytes }));
    },
  };
}

function scanTmp(olderThanDays: number, cwd: string): { total: CleanupBucket; candidates: FileCandidate[] } {
  const roots = [
    { dir: "/tmp", patterns: TMP_PATTERNS },
    { dir: path.join(cwd, ".tmp", "remotion"), patterns: [""] },
  ];
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const candidates: FileCandidate[] = [];
  let totalBytes = 0;
  let count = 0;

  for (const root of roots) {
    try {
      if (!fs.existsSync(root.dir)) continue;
      for (const name of fs.readdirSync(root.dir)) {
        if (!root.patterns.some((pattern) => name.startsWith(pattern))) continue;
        const filePath = path.join(root.dir, name);
        const stat = safeStat(filePath);
        if (!stat) continue;
        const sizeBytes = pathSizeBytes(filePath);
        totalBytes += sizeBytes;
        count++;
        if (stat.mtimeMs < cutoff) {
          candidates.push({ area: "tmp", filePath, sizeBytes });
        }
      }
    } catch {}
  }

  return {
    total: { count, sizeMb: mb(totalBytes) },
    candidates,
  };
}

function stripCandidates(plan: MediaCleanupPlan): Omit<MediaCleanupPlan, "candidates"> {
  const { candidates: _candidates, ...summary } = plan;
  return summary;
}

export function mediaCleanupSummary(plan: MediaCleanupPlan) {
  return stripCandidates(plan);
}

export async function getMediaCleanupPlan(options: MediaCleanupOptions = {}): Promise<MediaCleanupPlan> {
  const cwd = options.cwd ?? process.cwd();
  const olderThanDays = clampDays(options.olderThanDays, 3);
  const includeStocks = Boolean(options.includeStocks);
  const includeTmp = Boolean(options.includeTmp);
  const protectedRefs = await buildProtectedRefs();

  const rendersDir = path.join(cwd, "public", "renders");
  const stocksDir = path.join(cwd, "stocks");

  const renderScan = scanMediaDir(rendersDir, protectedRefs.renders, [1, 3, 7]);
  const stockScan = scanMediaDir(stocksDir, protectedRefs.stocks, [1, 3, 7, 14]);
  const tmpScan = scanTmp(olderThanDays, cwd);

  const renderCandidates = renderScan.selectedFiles(olderThanDays, "renders");
  const stockCandidates = includeStocks ? stockScan.selectedFiles(olderThanDays, "stocks") : [];
  const tmpCandidates = includeTmp ? tmpScan.candidates : [];
  const candidates = [...renderCandidates, ...stockCandidates, ...tmpCandidates];

  const selectedRenders = {
    count: renderCandidates.length,
    sizeMb: mb(renderCandidates.reduce((sum, file) => sum + file.sizeBytes, 0)),
  };
  const selectedStocks = {
    count: stockCandidates.length,
    sizeMb: mb(stockCandidates.reduce((sum, file) => sum + file.sizeBytes, 0)),
  };
  const selectedTmp = {
    count: tmpCandidates.length,
    sizeMb: mb(tmpCandidates.reduce((sum, file) => sum + file.sizeBytes, 0)),
  };

  return {
    renders: {
      total: renderScan.total,
      older1d: renderScan.buckets[1],
      older3d: renderScan.buckets[3],
      older7d: renderScan.buckets[7],
    },
    stocks: {
      total: stockScan.total,
      older1d: stockScan.buckets[1],
      older3d: stockScan.buckets[3],
      older7d: stockScan.buckets[7],
      older14d: stockScan.buckets[14],
    },
    tmp: tmpScan.total,
    selected: {
      olderThanDays,
      includeStocks,
      includeTmp,
      renders: selectedRenders,
      stocks: selectedStocks,
      tmp: selectedTmp,
      total: addBucket(addBucket(selectedRenders, selectedStocks), selectedTmp),
    },
    protectedCount: protectedRefs.renders.size + protectedRefs.stocks.size,
    protected: {
      renders: protectedRefs.renders.size,
      stocks: protectedRefs.stocks.size,
    },
    candidates,
  };
}

export function applyMediaCleanupPlan(plan: MediaCleanupPlan): MediaCleanupApplyResult {
  let deleted = 0;
  let savedBytes = 0;
  let skipped = 0;

  for (const candidate of plan.candidates) {
    try {
      const stat = safeStat(candidate.filePath);
      if (!stat) {
        skipped++;
        continue;
      }
      savedBytes += pathSizeBytes(candidate.filePath);
      fs.rmSync(candidate.filePath, { recursive: true, force: true });
      deleted++;
    } catch {
      skipped++;
    }
  }

  const savedMb = mb(savedBytes);
  return {
    deleted,
    savedMb,
    skipped,
    message: `ลบ ${deleted} รายการ ประหยัด ${savedMb} MB${skipped ? ` (ข้าม ${skipped} รายการ)` : ""}`,
  };
}
