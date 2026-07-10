import fs from "node:fs";
import path from "node:path";
import {
  mediaManifestFingerprint,
  mediaManifestSha256,
  mediaRecordIsEligible,
  quarantinedMediaMtimes,
  quarantineMediaCleanupPlan,
} from "./media-quarantine";
import type { MediaGraphError } from "./media-reference-graph";

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
  area: MediaArea;
  key: MediaKey;
  absolutePath: string;
  sizeBytes: number;
  mtimeMs: number;
  effectiveExpiresAt: string | null;
  reason: "all-references-expired" | "unreferenced-14d";
  fingerprint: string;
};

export type TmpCleanupCandidate = {
  absolutePath: string;
  sizeBytes: number;
  mtimeMs: number;
};

export type CountBytes = {
  count: number;
  sizeBytes: number;
};

export type MediaOperationMetrics = {
  scanned: CountBytes;
  protected: CountBytes;
  expired: CountBytes;
  quarantined: CountBytes;
  restored: CountBytes;
  purged: CountBytes;
  skipped: CountBytes;
  errors: CountBytes;
};

export type CleanupBucket = {
  count: number;
  sizeMb: number;
};

export type MediaCleanupPlan = {
  cwd: string;
  generatedAt: string;
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
  graphErrors: MediaGraphError[];
  manifestSha256: string;
  candidates: MediaManifestRecord[];
  tmpCandidates: TmpCleanupCandidate[];
  health: {
    missingBeforeExpiry: number;
    expired: number;
    protected: number;
    candidates: number;
  };
  operationMetrics: MediaOperationMetrics;
};

export type MediaCleanupOptions = {
  olderThanDays?: number;
  includeStocks?: boolean;
  includeTmp?: boolean;
  cwd?: string;
  now?: Date;
};

export type MediaCleanupApplyResult = {
  runId: string;
  manifestPath: string;
  metrics: MediaOperationMetrics;
  quarantined: number;
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

export function mediaRootPaths(cwd = process.cwd()): MediaRootPaths {
  const workspaceRoot = fs.realpathSync.native(path.resolve(cwd));
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

type ScannedMediaFile = {
  area: MediaArea;
  key: MediaKey;
  absolutePath: string;
  sizeBytes: number;
  mtimeMs: number;
};

type MediaScan = {
  files: ScannedMediaFile[];
  skipped: number;
  errors: MediaGraphError[];
  total: CleanupBucket;
  buckets: Record<number, CleanupBucket>;
};

function cleanupGraphError(field: string, code: string): MediaGraphError {
  return {
    ownerKind: "project-draft",
    ownerId: "*",
    field,
    code,
  };
}

function scanMediaArea(
  area: MediaArea,
  roots: MediaRootPaths,
  days: number[],
  now: Date,
): MediaScan {
  const buckets: Record<number, CleanupBucket> = {};
  for (const day of days) buckets[day] = { count: 0, sizeMb: 0 };
  const root = path.resolve(roots[area]);
  const rootError = configuredMediaRootError(area, roots);
  if (rootError) {
    return {
      files: [],
      skipped: 0,
      errors: [cleanupGraphError(`$scan.${area}`, rootError)],
      total: { count: 0, sizeMb: 0 },
      buckets,
    };
  }
  if (!fs.existsSync(root)) {
    return { files: [], skipped: 0, errors: [], total: { count: 0, sizeMb: 0 }, buckets };
  }

  let filenames: string[];
  try {
    filenames = fs.readdirSync(root).sort();
  } catch {
    return {
      files: [],
      skipped: 0,
      errors: [cleanupGraphError(`$scan.${area}`, "media_directory_read_failed")],
      total: { count: 0, sizeMb: 0 },
      buckets,
    };
  }

  const files: ScannedMediaFile[] = [];
  const errors: MediaGraphError[] = [];
  let skipped = 0;
  let totalBytes = 0;
  const canonicalRoot = fs.realpathSync.native(root);
  for (const filename of filenames) {
    if (
      !filename ||
      filename === "." ||
      filename === ".." ||
      filename !== path.basename(filename) ||
      /[/\\\u0000-\u001f\u007f]/.test(filename)
    ) {
      skipped++;
      continue;
    }
    const absolutePath = path.resolve(root, filename);
    if (!pathIsWithin(root, absolutePath)) {
      errors.push(cleanupGraphError(`$scan.${area}`, "media_path_outside_root"));
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch {
      errors.push(cleanupGraphError(`$scan.${area}`, "media_path_lstat_failed"));
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      skipped++;
      continue;
    }
    try {
      if (!pathIsWithin(canonicalRoot, fs.realpathSync.native(absolutePath))) {
        errors.push(cleanupGraphError(`$scan.${area}`, "media_path_outside_root"));
        continue;
      }
    } catch {
      errors.push(cleanupGraphError(`$scan.${area}`, "media_path_lstat_failed"));
      continue;
    }
    totalBytes += stat.size;
    files.push({
      area,
      key: `${area}/${filename}`,
      absolutePath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  for (const day of days) {
    const cutoff = now.getTime() - day * 24 * 60 * 60 * 1000;
    const selected = files.filter((file) => file.mtimeMs < cutoff);
    buckets[day] = {
      count: selected.length,
      sizeMb: mb(selected.reduce((sum, file) => sum + file.sizeBytes, 0)),
    };
  }
  return {
    files,
    skipped,
    errors,
    total: { count: files.length, sizeMb: mb(totalBytes) },
    buckets,
  };
}

function scanTmp(
  olderThanDays: number,
  cwd: string,
  now: Date,
): { total: CleanupBucket; candidates: TmpCleanupCandidate[] } {
  const roots = [
    { dir: "/tmp", patterns: TMP_PATTERNS },
    { dir: path.join(cwd, ".tmp", "remotion"), patterns: [""] },
  ];
  const cutoff = now.getTime() - olderThanDays * 24 * 60 * 60 * 1000;
  const candidates: TmpCleanupCandidate[] = [];
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
          candidates.push({ absolutePath: filePath, sizeBytes, mtimeMs: stat.mtimeMs });
        }
      }
    } catch {}
  }

  return {
    total: { count, sizeMb: mb(totalBytes) },
    candidates,
  };
}

export function mediaCleanupSummary(plan: MediaCleanupPlan) {
  return {
    generatedAt: plan.generatedAt,
    renders: plan.renders,
    stocks: plan.stocks,
    tmp: plan.tmp,
    selected: plan.selected,
    protectedCount: plan.protectedCount,
    protected: plan.protected,
    graphErrors: plan.graphErrors.length,
    manifestSha256: plan.manifestSha256,
    manifest: plan.candidates,
    tmpCandidates: plan.tmpCandidates,
    health: plan.health,
  };
}

export async function getMediaCleanupPlan(options: MediaCleanupOptions = {}): Promise<MediaCleanupPlan> {
  const roots = mediaRootPaths(options.cwd ?? process.cwd());
  const cwd = roots.workspaceRoot;
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new MediaCleanupPlanningError(1);
  const olderThanDays = clampDays(options.olderThanDays, 3);
  const includeStocks = Boolean(options.includeStocks);
  const includeTmp = Boolean(options.includeTmp);
  let graph: Awaited<ReturnType<typeof import("./media-reference-graph")["buildMediaReferenceGraph"]>>;
  try {
    const { buildMediaReferenceGraph } = await import("./media-reference-graph");
    graph = await buildMediaReferenceGraph(now, cwd, quarantinedMediaMtimes(cwd));
  } catch {
    graph = {
      refs: new Map(),
      scannedOwners: {
        video: 0,
        "video-job": 0,
        "project-draft": 0,
        "render-job": 0,
        "generated-image": 0,
      },
      errors: [cleanupGraphError("$graph", "media_graph_build_failed")],
    };
  }

  const renderScan = scanMediaArea("renders", roots, [1, 3, 7], now);
  const stockScan = scanMediaArea("stocks", roots, [1, 3, 7, 14], now);
  const graphErrors = [...graph.errors, ...renderScan.errors, ...stockScan.errors];
  const tmpScan = includeTmp
    ? scanTmp(olderThanDays, cwd, now)
    : { total: { count: 0, sizeMb: 0 }, candidates: [] };

  const records: MediaManifestRecord[] = [];
  const operationMetrics: MediaOperationMetrics = {
    scanned: { count: 0, sizeBytes: 0 },
    protected: { count: 0, sizeBytes: 0 },
    expired: { count: 0, sizeBytes: 0 },
    quarantined: { count: 0, sizeBytes: 0 },
    restored: { count: 0, sizeBytes: 0 },
    purged: { count: 0, sizeBytes: 0 },
    skipped: { count: renderScan.skipped + stockScan.skipped, sizeBytes: 0 },
    errors: { count: graphErrors.length, sizeBytes: 0 },
  };
  for (const file of [...renderScan.files, ...stockScan.files]) {
    operationMetrics.scanned.count++;
    operationMetrics.scanned.sizeBytes += file.sizeBytes;
    const eligibility = mediaRecordIsEligible(file, graph, now);
    if (!eligibility.eligible) {
      operationMetrics.protected.count++;
      operationMetrics.protected.sizeBytes += file.sizeBytes;
      continue;
    }
    operationMetrics.expired.count++;
    operationMetrics.expired.sizeBytes += file.sizeBytes;
    if (file.area === "stocks" && !includeStocks) continue;
    const record: MediaManifestRecord = {
      ...file,
      effectiveExpiresAt: eligibility.effectiveExpiresAt?.toISOString() ?? null,
      reason: eligibility.reason,
      fingerprint: "",
    };
    record.fingerprint = mediaManifestFingerprint(record);
    records.push(record);
  }
  const candidates = graphErrors.length === 0
    ? records.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    : [];

  const selectedRenders = {
    count: candidates.filter((file) => file.area === "renders").length,
    sizeMb: mb(candidates.filter((file) => file.area === "renders").reduce((sum, file) => sum + file.sizeBytes, 0)),
  };
  const selectedStocks = {
    count: candidates.filter((file) => file.area === "stocks").length,
    sizeMb: mb(candidates.filter((file) => file.area === "stocks").reduce((sum, file) => sum + file.sizeBytes, 0)),
  };
  const selectedTmp = {
    count: tmpScan.candidates.length,
    sizeMb: mb(tmpScan.candidates.reduce((sum, file) => sum + file.sizeBytes, 0)),
  };

  const scannedKeys = new Set<string>([...renderScan.files, ...stockScan.files].map((file) => file.key));
  let missingBeforeExpiry = 0;
  for (const [key, refs] of graph.refs) {
    const filename = key.slice(key.indexOf("/") + 1);
    const isDerived = filename.startsWith("preview-") || filename.endsWith(".normalized");
    if (
      !isDerived &&
      !scannedKeys.has(key) &&
      refs.some((ref) => ref.expiresAt !== null && ref.expiresAt.getTime() >= now.getTime())
    ) {
      missingBeforeExpiry++;
    }
  }

  const protectedRenders = renderScan.files.filter((file) => !mediaRecordIsEligible(file, graph, now).eligible).length;
  const protectedStocks = stockScan.files.filter((file) => !mediaRecordIsEligible(file, graph, now).eligible).length;

  return {
    cwd,
    generatedAt: now.toISOString(),
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
    protectedCount: protectedRenders + protectedStocks,
    protected: {
      renders: protectedRenders,
      stocks: protectedStocks,
    },
    graphErrors,
    manifestSha256: mediaManifestSha256(candidates),
    candidates,
    tmpCandidates: tmpScan.candidates,
    health: {
      missingBeforeExpiry,
      expired: graphErrors.length === 0 ? operationMetrics.expired.count : 0,
      protected: operationMetrics.protected.count,
      candidates: candidates.length,
    },
    operationMetrics,
  };
}

export async function applyMediaCleanupPlan(
  plan: MediaCleanupPlan,
  reviewedHash: string,
  options: {
    now?: Date;
    runId?: string;
    batchSize?: number;
    writeManifest?: (manifestPath: string, manifest: unknown) => Promise<void>;
  } = {},
): Promise<MediaCleanupApplyResult> {
  return quarantineMediaCleanupPlan(plan, reviewedHash, options);
}

export function applyTmpCleanupPlan(plan: MediaCleanupPlan): {
  deleted: number;
  savedMb: number;
  skipped: number;
} {
  if (plan.graphErrors.length > 0) {
    throw new Error(`media graph incomplete: ${plan.graphErrors.length} error(s)`);
  }
  let deleted = 0;
  let savedBytes = 0;
  let skipped = 0;
  for (const candidate of plan.tmpCandidates) {
    try {
      const stat = safeStat(candidate.absolutePath);
      if (
        !stat ||
        stat.mtimeMs !== candidate.mtimeMs ||
        pathSizeBytes(candidate.absolutePath) !== candidate.sizeBytes
      ) {
        skipped++;
        continue;
      }
      savedBytes += pathSizeBytes(candidate.absolutePath);
      fs.rmSync(candidate.absolutePath, { recursive: true, force: true });
      deleted++;
    } catch {
      skipped++;
    }
  }
  return { deleted, savedMb: mb(savedBytes), skipped };
}
