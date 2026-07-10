import fs from "fs";
import path from "path";
import { prisma } from "./prisma";
import { lowResPreviewFilenamesForRender } from "./low-res-preview-paths";

export type MediaArea = "renders" | "stocks";
export type MediaKey = `${MediaArea}/${string}`;

export type MediaRootPaths = Record<MediaArea, string> & { workspaceRoot: string };

export type CanonicalMediaRef = {
  area: MediaArea;
  filename: string;
  key: MediaKey;
  absolutePath: string;
};

export type CanonicalMediaRefParseResult =
  | { kind: "reference"; ref: CanonicalMediaRef }
  | { kind: "ignored" }
  | { kind: "error"; code: string };

export type CanonicalMediaRefCollection = {
  refs: CanonicalMediaRef[];
  errors: string[];
};

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

export class MediaCleanupPlanningError extends Error {
  readonly code = "media_cleanup_plan_incomplete";

  constructor(readonly errorCount: number) {
    super(`media cleanup planning aborted: ${errorCount} validation error(s)`);
    this.name = "MediaCleanupPlanningError";
  }
}

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
    const stat = fs.lstatSync(filePath);
    return stat.isSymbolicLink() ? null : stat;
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

export function mediaRootPaths(cwd = process.cwd()): MediaRootPaths {
  const workspaceRoot = path.resolve(cwd);
  return {
    workspaceRoot,
    renders: path.resolve(workspaceRoot, "public", "renders"),
    stocks: path.resolve(workspaceRoot, "stocks"),
  };
}

function extractPathname(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const absoluteMatch = /^https?:\/\//i.exec(value);
  if (absoluteMatch) {
    try {
      new URL(value);
    } catch {
      return null;
    }

    // WHATWG URL parsing normalizes literal and percent-encoded dot segments. Retain the raw
    // pathname for validation so `/api/renders/%2e%2e/file` cannot disappear before rejection.
    const authorityStart = absoluteMatch[0].length;
    const firstDelimiterOffset = value.slice(authorityStart).search(/[/?#\\]/);
    if (firstDelimiterOffset < 0) return "";
    const firstDelimiter = authorityStart + firstDelimiterOffset;
    if (value[firstDelimiter] !== "/") return null;
    const pathnameEndOffset = value.slice(firstDelimiter).search(/[?#]/);
    return pathnameEndOffset < 0
      ? value.slice(firstDelimiter)
      : value.slice(firstDelimiter, firstDelimiter + pathnameEndOffset);
  }
  return value.split("?")[0].split("#")[0];
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function pathErrorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return null;
  return "media_path_lstat_failed";
}

function configuredMediaRootError(
  area: MediaArea,
  roots: MediaRootPaths,
): string | null {
  const root = path.resolve(roots[area]);
  try {
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink()) return "media_path_symlink";
    if (!rootStat.isDirectory()) return "media_path_invalid";

    const canonicalWorkspace = fs.realpathSync.native(path.resolve(roots.workspaceRoot));
    const canonicalRoot = fs.realpathSync.native(root);
    const expectedRoot = area === "renders"
      ? path.resolve(canonicalWorkspace, "public", "renders")
      : path.resolve(canonicalWorkspace, "stocks");
    return canonicalRoot === expectedRoot ? null : "media_path_outside_root";
  } catch (error) {
    return pathErrorCode(error);
  }
}

export function parseCanonicalMediaRef(
  raw: string,
  roots: MediaRootPaths = mediaRootPaths(),
): CanonicalMediaRefParseResult {
  const value = raw.trim();
  if (/[\\\u0000-\u001f\u007f]/.test(value)) {
    try {
      const normalizedPathname = /^https?:\/\//i.test(value)
        ? new URL(value).pathname
        : new URL(value, "https://local-media.invalid").pathname;
      if (
        RENDER_PREFIXES.some((prefix) => normalizedPathname.startsWith(prefix)) ||
        STOCK_PREFIXES.some((prefix) => normalizedPathname.startsWith(prefix))
      ) {
        return { kind: "error", code: "media_path_invalid" };
      }
    } catch {
      // The invalid-absolute-URL path below records an error if it resembles a local ref.
    }
  }
  const pathname = extractPathname(raw);
  if (!pathname) {
    return RENDER_PREFIXES.some((prefix) => raw.includes(prefix)) ||
      STOCK_PREFIXES.some((prefix) => raw.includes(prefix))
      ? { kind: "error", code: "media_path_invalid" }
      : { kind: "ignored" };
  }

  let area: MediaArea | null = null;
  let encodedFilename = "";
  for (const [candidateArea, prefixes] of [
    ["renders", RENDER_PREFIXES],
    ["stocks", STOCK_PREFIXES],
  ] as const) {
    const prefix = prefixes.find((candidate) => pathname.startsWith(candidate));
    if (!prefix) continue;
    area = candidateArea;
    encodedFilename = pathname.slice(prefix.length);
    break;
  }
  if (!area) return { kind: "ignored" };

  let filename: string;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    return { kind: "error", code: "media_path_invalid" };
  }

  // A remaining escape can be decoded by a second HTTP layer. Reject it so double-encoded
  // traversal/separators never become a different filesystem path after validation.
  if (/%[0-9a-f]{2}/i.test(filename)) {
    return { kind: "error", code: "media_path_invalid" };
  }
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    filename !== path.basename(filename) ||
    /[/\\\u0000-\u001f\u007f]/.test(filename)
  ) {
    return { kind: "error", code: "media_path_invalid" };
  }

  const root = path.resolve(roots[area]);
  const absolutePath = path.resolve(root, filename);
  if (!pathIsWithin(root, absolutePath)) {
    return { kind: "error", code: "media_path_outside_root" };
  }

  const rootError = configuredMediaRootError(area, roots);
  if (rootError) return { kind: "error", code: rootError };

  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) return { kind: "error", code: "media_path_symlink" };
    if (!stat.isFile()) return { kind: "error", code: "media_path_invalid" };
    const canonicalRoot = fs.realpathSync.native(root);
    const canonicalPath = fs.realpathSync.native(absolutePath);
    if (!pathIsWithin(canonicalRoot, canonicalPath)) {
      return { kind: "error", code: "media_path_outside_root" };
    }
  } catch (error) {
    const code = pathErrorCode(error);
    if (code) return { kind: "error", code };
  }

  return {
    kind: "reference",
    ref: {
      area,
      filename,
      key: `${area}/${filename}`,
      absolutePath,
    },
  };
}

export function collectCanonicalMediaRefs(
  value: unknown,
  roots: MediaRootPaths = mediaRootPaths(),
  depth = 0,
): CanonicalMediaRefCollection {
  if (depth > 8) return { refs: [], errors: ["media_reference_depth_exceeded"] };
  if (value == null) return { refs: [], errors: [] };

  if (typeof value === "string") {
    const result = parseCanonicalMediaRef(value, roots);
    if (result.kind === "reference") return { refs: [result.ref], errors: [] };
    if (result.kind === "error") return { refs: [], errors: [result.code] };
    return { refs: [], errors: [] };
  }

  const refs: CanonicalMediaRef[] = [];
  const errors: string[] = [];
  const children = Array.isArray(value)
    ? value
    : typeof value === "object"
      ? Object.values(value as Record<string, unknown>)
      : [];
  for (const child of children) {
    const collected = collectCanonicalMediaRefs(child, roots, depth + 1);
    refs.push(...collected.refs);
    errors.push(...collected.errors);
  }
  return { refs, errors };
}

function addProtected(refs: Record<MediaArea, Set<string>>, area: MediaArea, filename: string) {
  if (!filename || filename === "." || filename === "..") return;
  refs[area].add(filename);
  if (area === "stocks") refs[area].add(`${filename}.normalized`);
  if (area === "renders") {
    for (const previewFilename of lowResPreviewFilenamesForRender(filename)) refs[area].add(previewFilename);
  }
}

function collectRefs(
  value: unknown,
  refs: Record<MediaArea, Set<string>>,
  roots: MediaRootPaths,
  depth = 0,
): number {
  if (depth > 8) return 1;
  if (value == null) return 0;

  if (typeof value === "string") {
    const direct = parseCanonicalMediaRef(value, roots);
    if (direct.kind === "reference") addProtected(refs, direct.ref.area, direct.ref.filename);
    let errorCount = direct.kind === "error" ? 1 : 0;

    const parsed = parseJson(value);
    if (parsed) errorCount += collectRefs(parsed, refs, roots, depth + 1);
    return errorCount;
  }

  if (Array.isArray(value)) {
    return value.reduce(
      (errorCount, item) => errorCount + collectRefs(item, refs, roots, depth + 1),
      0,
    );
  }

  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (errorCount, item) => errorCount + collectRefs(item, refs, roots, depth + 1),
      0,
    );
  }
  return 0;
}

async function buildProtectedRefs(
  cwd: string,
): Promise<{ refs: Record<MediaArea, Set<string>>; errorCount: number }> {
  const refs: Record<MediaArea, Set<string>> = {
    renders: new Set(),
    stocks: new Set(),
  };
  const roots = mediaRootPaths(cwd);
  let errorCount = 0;

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

  for (const video of videos) errorCount += collectRefs(video, refs, roots);

  const images = await prisma.generatedImage.findMany({
    select: { url: true },
  });
  for (const image of images) errorCount += collectRefs(image.url, refs, roots);

  return { refs, errorCount };
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
): {
  total: CleanupBucket;
  buckets: Record<number, CleanupBucket>;
  errorCount: number;
  selectedFiles: (olderThanDays: number, area: MediaArea) => FileCandidate[];
} {
  const buckets: Record<number, CleanupBucket> = {};
  for (const day of days) buckets[day] = { count: 0, sizeMb: 0 };

  const files: Array<{ filePath: string; filename: string; sizeBytes: number; mtimeMs: number }> = [];
  let totalBytes = 0;
  let errorCount = 0;

  if (!fs.existsSync(dir)) {
    return {
      total: { count: 0, sizeMb: 0 },
      buckets,
      errorCount,
      selectedFiles: () => [],
    };
  }

  let filenames: string[];
  try {
    filenames = fs.readdirSync(dir);
  } catch {
    filenames = [];
    errorCount++;
  }
  for (const filename of filenames) {
    if (isProtected(filename, protectedSet)) continue;
    const filePath = path.join(dir, filename);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filePath);
    } catch {
      errorCount++;
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    totalBytes += stat.size;
    files.push({ filePath, filename, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
  }

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
    errorCount,
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
  const roots = mediaRootPaths(cwd);
  let protectedDiscovery: Awaited<ReturnType<typeof buildProtectedRefs>>;
  try {
    protectedDiscovery = await buildProtectedRefs(cwd);
  } catch {
    throw new MediaCleanupPlanningError(1);
  }
  const rootErrorCount = (["renders", "stocks"] as const)
    .filter((area) => configuredMediaRootError(area, roots) !== null)
    .length;
  const discoveryErrorCount = protectedDiscovery.errorCount + rootErrorCount;
  if (discoveryErrorCount > 0) throw new MediaCleanupPlanningError(discoveryErrorCount);
  const protectedRefs = protectedDiscovery.refs;

  const rendersDir = path.join(cwd, "public", "renders");
  const stocksDir = path.join(cwd, "stocks");

  const renderScan = scanMediaDir(rendersDir, protectedRefs.renders, [1, 3, 7]);
  const stockScan = scanMediaDir(stocksDir, protectedRefs.stocks, [1, 3, 7, 14]);
  const scanErrorCount = renderScan.errorCount + stockScan.errorCount;
  if (scanErrorCount > 0) throw new MediaCleanupPlanningError(scanErrorCount);
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
