import fs from "fs";
import path from "path";
import { prisma } from "./prisma";
import { lowResPreviewFilenamesForRender } from "./low-res-preview-paths";
import {
  fingerprintMediaRecord,
  manifestSha256ForRecords,
  quarantineMediaCleanupPlan,
  type ApplyMediaCleanupOptions,
  type CleanupTally,
  type MediaOperationReport,
} from "./media-quarantine";
import {
  effectiveMediaExpiry,
  mediaReferenceIsLive,
  type MediaReference,
} from "./media-retention";
import type { MediaGraph, MediaGraphError } from "./media-reference-graph";

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

export type MediaManifestRecord = {
  key: MediaKey;
  absolutePath: string;
  sizeBytes: number;
  mtimeMs: number;
  effectiveExpiresAt: string | null;
  reason: "all_references_expired" | "unreferenced_14d";
  fingerprint: string;
};

export type MissingMediaCategory = "critical" | "primary" | "derived";

export type MissingMediaInventoryRecord = {
  key: MediaKey;
  category: MissingMediaCategory;
  ownerKinds: MediaReference["ownerKind"][];
  ownerIds: string[];
  effectiveExpiresAt: string | null;
  sourceKey?: MediaKey;
};

export type TmpCleanupCandidate = {
  filePath: string;
  sizeBytes: number;
};

type FileCandidate = TmpCleanupCandidate & { area: MediaArea | "tmp" };

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
  generatedAt: string;
  workspaceRoot: string;
  graphErrors: MediaGraphError[];
  manifestSha256: string;
  tallies: {
    scanned: CleanupTally;
    protected: CleanupTally;
    expired: CleanupTally;
  };
  health: {
    missingBeforeExpiry: number;
    missingCriticalBeforeExpiry: number;
    missingPrimaryBeforeExpiry: number;
    missingDerivedBeforeExpiry: number;
    expired: number;
    protected: number;
    candidates: number;
  };
  missingInventory: MissingMediaInventoryRecord[];
  candidates: MediaManifestRecord[];
  tmpCandidates: TmpCleanupCandidate[];
};

export type MediaCleanupOptions = {
  olderThanDays?: number;
  includeStocks?: boolean;
  includeTmp?: boolean;
  cwd?: string;
  now?: Date;
};

export type TmpCleanupApplyResult = {
  deleted: number;
  savedMb: number;
  skipped: number;
  message: string;
};

export type MediaCleanupApplyResult = MediaOperationReport;

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

type ScannedMediaFile = {
  key: MediaKey;
  absolutePath: string;
  sizeBytes: number;
  mtimeMs: number;
};

type GraphAreaScan = {
  files: ScannedMediaFile[];
  candidates: MediaManifestRecord[];
  scanned: CleanupTally;
  protected: CleanupTally;
};

function cleanupGraphError(field: string, code: string): MediaGraphError {
  return {
    ownerKind: "project-draft",
    ownerId: "*",
    field,
    code,
  };
}

function addTallyValue(tally: CleanupTally, sizeBytes: number): void {
  tally.count++;
  tally.sizeBytes += sizeBytes;
}

function compareStableText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function refsAreAllExpired(refs: MediaReference[], now: Date): boolean {
  return refs.length > 0 && refs.every((ref) =>
    ref.alwaysProtect !== true &&
    ref.expiresAt !== null &&
    Number.isFinite(ref.expiresAt.getTime()) &&
    ref.expiresAt.getTime() < now.getTime()
  );
}

function scanGraphArea(
  area: MediaArea,
  graph: MediaGraph,
  roots: MediaRootPaths,
  now: Date,
  graphErrors: MediaGraphError[],
): GraphAreaScan {
  const files: ScannedMediaFile[] = [];
  const candidates: MediaManifestRecord[] = [];
  const scanned: CleanupTally = { count: 0, sizeBytes: 0 };
  const protectedTally: CleanupTally = { count: 0, sizeBytes: 0 };
  const dir = roots[area];
  const rootError = configuredMediaRootError(area, roots);
  if (rootError) {
    graphErrors.push(cleanupGraphError(`$scan:${area}`, rootError));
    return { files, candidates, scanned, protected: protectedTally };
  }
  if (!fs.existsSync(dir)) return { files, candidates, scanned, protected: protectedTally };

  let filenames: string[];
  try {
    filenames = fs.readdirSync(dir).sort();
  } catch {
    graphErrors.push(cleanupGraphError(`$scan:${area}`, "media_scan_failed"));
    return { files, candidates, scanned, protected: protectedTally };
  }

  for (const filename of filenames) {
    const absolutePath = path.join(dir, filename);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch {
      graphErrors.push(cleanupGraphError(`$scan:${area}`, "media_path_lstat_failed"));
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      addTallyValue(scanned, 0);
      addTallyValue(protectedTally, 0);
      continue;
    }

    addTallyValue(scanned, stat.size);
    const parsed = parseCanonicalMediaRef(
      area === "renders"
        ? `/api/renders/${encodeURIComponent(filename)}`
        : `/api/stocks/${encodeURIComponent(filename)}`,
      roots,
    );
    if (parsed.kind !== "reference") {
      graphErrors.push(cleanupGraphError(`$scan:${area}`, parsed.kind === "error" ? parsed.code : "media_path_invalid"));
      addTallyValue(protectedTally, stat.size);
      continue;
    }

    const file: ScannedMediaFile = {
      key: parsed.ref.key,
      absolutePath: parsed.ref.absolutePath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    };
    files.push(file);
    const refs = graph.refs.get(file.key) ?? [];
    let effectiveExpiresAt: string | null = null;
    let reason: MediaManifestRecord["reason"] | null = null;
    if (refs.length > 0 && refsAreAllExpired(refs, now)) {
      effectiveExpiresAt = effectiveMediaExpiry(refs)?.toISOString() ?? null;
      reason = "all_references_expired";
    } else if (refs.length === 0 && stat.mtimeMs < now.getTime() - 14 * 86_400_000) {
      reason = "unreferenced_14d";
    }

    if (!reason) {
      addTallyValue(protectedTally, stat.size);
      continue;
    }
    const base = {
      key: file.key,
      absolutePath: file.absolutePath,
      sizeBytes: file.sizeBytes,
      mtimeMs: file.mtimeMs,
      effectiveExpiresAt,
      reason,
    };
    candidates.push({ ...base, fingerprint: fingerprintMediaRecord(base) });
  }
  return { files, candidates, scanned, protected: protectedTally };
}

function ageBucket(files: ScannedMediaFile[], now: Date, days: number): CleanupBucket {
  const selected = files.filter((file) => file.mtimeMs < now.getTime() - days * 86_400_000);
  return {
    count: selected.length,
    sizeMb: mb(selected.reduce((sum, file) => sum + file.sizeBytes, 0)),
  };
}

function totalBucket(files: ScannedMediaFile[]): CleanupBucket {
  return {
    count: files.length,
    sizeMb: mb(files.reduce((sum, file) => sum + file.sizeBytes, 0)),
  };
}

function derivedSourceKey(key: MediaKey, graph: MediaGraph): MediaKey | undefined {
  if (key.startsWith("stocks/") && key.endsWith(".normalized")) {
    const sourceKey = key.slice(0, -".normalized".length) as MediaKey;
    return graph.refs.has(sourceKey) ? sourceKey : undefined;
  }
  if (key.startsWith("renders/")) {
    const filename = key.slice("renders/".length);
    const match = /^preview-(.+)-(?:540|720)p\.mp4$/.exec(filename);
    if (match) {
      const sourceKey = `renders/${match[1]}.mp4` as MediaKey;
      return graph.refs.has(sourceKey) ? sourceKey : undefined;
    }
  }
  return undefined;
}

function missingMediaInventory(
  graph: MediaGraph,
  roots: MediaRootPaths,
  now: Date,
): MissingMediaInventoryRecord[] {
  const inventory: MissingMediaInventoryRecord[] = [];
  for (const [rawKey, refs] of [...graph.refs.entries()].sort(([a], [b]) => compareStableText(a, b))) {
    const liveRefs = refs.filter((ref) => mediaReferenceIsLive(ref, now));
    if (liveRefs.length === 0) continue;
    const key = rawKey as MediaKey;
    const slash = key.indexOf("/");
    const area = key.slice(0, slash);
    const filename = key.slice(slash + 1);
    if ((area !== "renders" && area !== "stocks") || filename !== path.basename(filename)) continue;
    const stat = safeStat(path.join(roots[area], filename));
    if (stat?.isFile()) continue;

    const sourceKey = derivedSourceKey(key, graph);
    const category: MissingMediaCategory = sourceKey
      ? "derived"
      : liveRefs.some((ref) => ref.critical === true)
        ? "critical"
        : "primary";
    inventory.push({
      key,
      category,
      ownerKinds: [...new Set(liveRefs.map((ref) => ref.ownerKind))].sort(compareStableText),
      ownerIds: [...new Set(liveRefs.map((ref) => ref.ownerId))].sort(compareStableText),
      effectiveExpiresAt: effectiveMediaExpiry(liveRefs)?.toISOString() ?? null,
      ...(sourceKey ? { sourceKey } : {}),
    });
  }
  return inventory;
}

function stripCandidates(
  plan: MediaCleanupPlan,
): Omit<MediaCleanupPlan, "candidates" | "tmpCandidates" | "workspaceRoot" | "missingInventory"> {
  const {
    candidates: _candidates,
    tmpCandidates: _tmpCandidates,
    workspaceRoot: _workspaceRoot,
    missingInventory: _missingInventory,
    ...summary
  } = plan;
  return summary;
}

export function mediaCleanupSummary(plan: MediaCleanupPlan) {
  const { graphErrors, ...summary } = stripCandidates(plan);
  return { ...summary, graphErrorCount: graphErrors.length };
}

export async function getMediaCleanupPlan(options: MediaCleanupOptions = {}): Promise<MediaCleanupPlan> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("invalid cleanup clock");
  const olderThanDays = clampDays(options.olderThanDays, 3);
  const includeStocks = Boolean(options.includeStocks);
  const includeTmp = Boolean(options.includeTmp);
  const roots = mediaRootPaths(cwd);
  let graph: MediaGraph;
  try {
    const { buildMediaReferenceGraph } = await import("./media-reference-graph");
    graph = await buildMediaReferenceGraph(now, { workspaceRoot: cwd });
  } catch {
    graph = {
      refs: new Map(),
      errors: [cleanupGraphError("$graph", "graph_build_failed")],
      scannedOwners: {
        video: 0,
        "video-job": 0,
        "project-draft": 0,
        "render-job": 0,
        "generated-image": 0,
      },
    };
  }
  const graphErrors = [...graph.errors];
  const renderScan = scanGraphArea("renders", graph, roots, now, graphErrors);
  const stockScan = scanGraphArea("stocks", graph, roots, now, graphErrors);
  const tmpScan = scanTmp(olderThanDays, cwd);

  const allExpiredCustomerMedia = [
    ...renderScan.candidates,
    ...stockScan.candidates,
  ].sort((a, b) => compareStableText(a.key, b.key));
  const discoveredCandidates = allExpiredCustomerMedia.filter(
    (record) => record.key.startsWith("renders/") || includeStocks,
  );
  const candidates = graphErrors.length === 0 ? discoveredCandidates : [];
  const renderCandidates = candidates.filter((record) => record.key.startsWith("renders/"));
  const stockCandidates = candidates.filter((record) => record.key.startsWith("stocks/"));
  const tmpCandidates = includeTmp
    ? tmpScan.candidates.map(({ filePath, sizeBytes }) => ({ filePath, sizeBytes }))
    : [];

  const selectedRenders = {
    count: renderCandidates.length,
    sizeMb: mb(renderCandidates.reduce((sum, record) => sum + record.sizeBytes, 0)),
  };
  const selectedStocks = {
    count: stockCandidates.length,
    sizeMb: mb(stockCandidates.reduce((sum, record) => sum + record.sizeBytes, 0)),
  };
  const selectedTmp = {
    count: tmpCandidates.length,
    sizeMb: mb(tmpCandidates.reduce((sum, file) => sum + file.sizeBytes, 0)),
  };
  const scanned: CleanupTally = {
    count: renderScan.scanned.count + stockScan.scanned.count,
    sizeBytes: renderScan.scanned.sizeBytes + stockScan.scanned.sizeBytes,
  };
  const protectedTally: CleanupTally = graphErrors.length > 0
    ? { ...scanned }
    : {
      count: renderScan.protected.count + stockScan.protected.count,
      sizeBytes: renderScan.protected.sizeBytes + stockScan.protected.sizeBytes,
    };
  const expired: CleanupTally = {
    count: graphErrors.length === 0 ? allExpiredCustomerMedia.length : 0,
    sizeBytes: graphErrors.length === 0
      ? allExpiredCustomerMedia.reduce((sum, record) => sum + record.sizeBytes, 0)
      : 0,
  };
  const manifestSha256 = manifestSha256ForRecords(candidates);
  const missingInventory = missingMediaInventory(graph, roots, now);
  const missingCriticalBeforeExpiry = missingInventory.filter(
    (record) => record.category === "critical",
  ).length;
  const missingPrimaryBeforeExpiry = missingInventory.filter(
    (record) => record.category === "primary",
  ).length;
  const missingDerivedBeforeExpiry = missingInventory.filter(
    (record) => record.category === "derived",
  ).length;

  return {
    renders: {
      total: totalBucket(renderScan.files),
      older1d: ageBucket(renderScan.files, now, 1),
      older3d: ageBucket(renderScan.files, now, 3),
      older7d: ageBucket(renderScan.files, now, 7),
    },
    stocks: {
      total: totalBucket(stockScan.files),
      older1d: ageBucket(stockScan.files, now, 1),
      older3d: ageBucket(stockScan.files, now, 3),
      older7d: ageBucket(stockScan.files, now, 7),
      older14d: ageBucket(stockScan.files, now, 14),
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
    protectedCount: protectedTally.count,
    protected: {
      renders: graphErrors.length > 0 ? renderScan.scanned.count : renderScan.protected.count,
      stocks: graphErrors.length > 0 ? stockScan.scanned.count : stockScan.protected.count,
    },
    generatedAt: now.toISOString(),
    workspaceRoot: cwd,
    graphErrors,
    manifestSha256,
    tallies: { scanned, protected: protectedTally, expired },
    health: {
      missingBeforeExpiry: missingInventory.length,
      missingCriticalBeforeExpiry,
      missingPrimaryBeforeExpiry,
      missingDerivedBeforeExpiry,
      expired: expired.count,
      protected: protectedTally.count,
      candidates: candidates.length,
    },
    missingInventory,
    candidates,
    tmpCandidates,
  };
}

export async function applyMediaCleanupPlan(
  plan: MediaCleanupPlan,
  reviewedManifestSha256: string,
  options: ApplyMediaCleanupOptions = {},
): Promise<MediaCleanupApplyResult> {
  return quarantineMediaCleanupPlan(plan, reviewedManifestSha256, options);
}

export function applyTmpCleanupPlan(plan: MediaCleanupPlan): TmpCleanupApplyResult {
  let deleted = 0;
  let savedBytes = 0;
  let skipped = 0;

  if (!plan.selected.includeTmp) throw new Error("tmp cleanup was not explicitly selected");
  for (const candidate of plan.tmpCandidates) {
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
