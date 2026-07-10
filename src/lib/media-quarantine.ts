import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  MediaCleanupApplyResult,
  MediaCleanupPlan,
  MediaManifestRecord,
  MediaOperationMetrics,
} from "@/lib/media-cleanup";
import type { MediaGraph } from "@/lib/media-reference-graph";
import { effectiveMediaExpiry, mediaReferenceIsLive } from "@/lib/media-retention";

const DAY_MS = 86_400_000;
const UNREFERENCED_RETENTION_MS = 14 * DAY_MS;
const QUARANTINE_RETENTION_MS = DAY_MS;

type QuarantineManifest = {
  version: 1;
  runId: string;
  createdAt: string;
  manifestSha256: string;
  recordsSha256: string;
  records: MediaManifestRecord[];
  metrics: MediaOperationMetrics;
  restoredKeys: string[];
  purgedKeys: string[];
  pendingPurgeKeys: string[];
};

export type QuarantineOperationResult = {
  runId?: string;
  metrics: MediaOperationMetrics;
  manifestPath?: string;
};

function emptyMetric(): { count: number; sizeBytes: number } {
  return { count: 0, sizeBytes: 0 };
}

export function emptyMediaOperationMetrics(): MediaOperationMetrics {
  return {
    scanned: emptyMetric(),
    protected: emptyMetric(),
    expired: emptyMetric(),
    quarantined: emptyMetric(),
    restored: emptyMetric(),
    purged: emptyMetric(),
    skipped: emptyMetric(),
    errors: emptyMetric(),
  };
}

function addMetric(
  metric: { count: number; sizeBytes: number },
  sizeBytes: number,
): void {
  metric.count++;
  metric.sizeBytes += sizeBytes;
}

function canonicalFingerprintInput(
  value: Pick<MediaManifestRecord, "key" | "sizeBytes" | "mtimeMs">,
): string {
  return JSON.stringify([value.key, value.sizeBytes, value.mtimeMs]);
}

export function mediaManifestFingerprint(
  value: Pick<MediaManifestRecord, "key" | "sizeBytes" | "mtimeMs">,
): string {
  return createHash("sha256").update(canonicalFingerprintInput(value)).digest("hex");
}

export function mediaManifestSha256(records: MediaManifestRecord[]): string {
  const stable = [...records]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((record) => ({
      key: record.key,
      absolutePath: record.absolutePath,
      sizeBytes: record.sizeBytes,
      mtimeMs: record.mtimeMs,
      effectiveExpiresAt: record.effectiveExpiresAt,
      reason: record.reason,
      fingerprint: record.fingerprint,
    }));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function mediaRecordIsEligible(
  record: Pick<MediaManifestRecord, "key" | "mtimeMs">,
  graph: Pick<MediaGraph, "refs">,
  now: Date,
): { eligible: boolean; effectiveExpiresAt: Date | null; reason: MediaManifestRecord["reason"] } {
  const refs = graph.refs.get(record.key) ?? [];
  if (refs.length === 0) {
    return {
      eligible: record.mtimeMs < now.getTime() - UNREFERENCED_RETENTION_MS,
      effectiveExpiresAt: null,
      reason: "unreferenced-14d",
    };
  }

  const effectiveExpiresAt = effectiveMediaExpiry(refs);
  return {
    eligible: effectiveExpiresAt !== null && refs.every((ref) => !mediaReferenceIsLive(ref, now)),
    effectiveExpiresAt,
    reason: "all-references-expired",
  };
}

function assertValidClock(now: Date): void {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid media quarantine clock");
}

function assertValidRunId(runId: string): void {
  if (
    runId === "." ||
    runId === ".." ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId)
  ) {
    throw new Error("invalid media quarantine run id");
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function resolveWorkspace(cwd: string): string {
  return fs.realpathSync.native(path.resolve(cwd));
}

function ensureSafeDirectory(dir: string, expectedParent?: string): void {
  if (pathEntryExists(dir)) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe media quarantine directory");
  } else {
    fs.mkdirSync(dir, { recursive: false });
  }
  const canonicalDir = fs.realpathSync.native(dir);
  if (expectedParent) {
    const canonicalParent = fs.realpathSync.native(expectedParent);
    if (!pathIsWithin(canonicalParent, canonicalDir)) throw new Error("media quarantine path outside root");
  }
}

function pathEntryExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertSafeExistingDirectory(dir: string, expectedParent: string): void {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe media quarantine directory");
  const canonicalParent = fs.realpathSync.native(expectedParent);
  const canonicalDir = fs.realpathSync.native(dir);
  if (!pathIsWithin(canonicalParent, canonicalDir)) throw new Error("media quarantine path outside root");
}

function assertSafeExistingFile(filePath: string, expectedParent: string): void {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("unsafe media quarantine manifest");
  const canonicalParent = fs.realpathSync.native(expectedParent);
  const canonicalFile = fs.realpathSync.native(filePath);
  if (!pathIsWithin(canonicalParent, canonicalFile)) throw new Error("media quarantine path outside root");
}

function ensureManagedRoot(cwd: string, name: ".media-quarantine" | ".ops-metrics"): string {
  const workspace = resolveWorkspace(cwd);
  const workspaceStat = fs.lstatSync(workspace);
  if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) {
    throw new Error("unsafe media workspace root");
  }
  const root = path.join(workspace, name);
  ensureSafeDirectory(root, workspace);
  return root;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.promises.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function quarantinePathFor(root: string, runId: string, record: MediaManifestRecord): string {
  const filename = record.key.slice(record.area.length + 1);
  if (!filename || filename !== path.basename(filename)) throw new Error("invalid manifest media key");
  const areaRoot = path.join(root, runId, record.area);
  const candidate = path.resolve(areaRoot, filename);
  if (!pathIsWithin(areaRoot, candidate)) throw new Error("quarantine path outside run root");
  return candidate;
}

function expectedOriginalPath(cwd: string, record: MediaManifestRecord): string {
  const filename = record.key.slice(record.area.length + 1);
  if (!filename || filename !== path.basename(filename)) throw new Error("invalid manifest media key");
  const areaRoot = record.area === "renders"
    ? path.resolve(cwd, "public", "renders")
    : path.resolve(cwd, "stocks");
  const expected = path.resolve(areaRoot, filename);
  if (!pathIsWithin(areaRoot, expected) || expected !== path.resolve(record.absolutePath)) {
    throw new Error("manifest path outside configured media root");
  }
  const rootStat = fs.lstatSync(areaRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("unsafe configured media root");
  const canonicalWorkspace = fs.realpathSync.native(path.resolve(cwd));
  const canonicalRoot = fs.realpathSync.native(areaRoot);
  const expectedRoot = record.area === "renders"
    ? path.resolve(canonicalWorkspace, "public", "renders")
    : path.resolve(canonicalWorkspace, "stocks");
  if (canonicalRoot !== expectedRoot) throw new Error("configured media root outside workspace");
  return expected;
}

function statMatchesRecord(filePath: string, record: MediaManifestRecord): fs.Stats | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const actualFingerprint = mediaManifestFingerprint({
      key: record.key,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
    return actualFingerprint === record.fingerprint ? stat : null;
  } catch {
    return null;
  }
}

async function rollbackMoves(
  moved: Array<{ record: MediaManifestRecord; quarantinePath: string }>,
): Promise<number> {
  let failures = 0;
  for (const entry of [...moved].reverse()) {
    try {
      if (pathEntryExists(entry.record.absolutePath)) {
        failures++;
        continue;
      }
      await fs.promises.rename(entry.quarantinePath, entry.record.absolutePath);
    } catch {
      failures++;
    }
  }
  return failures;
}

function resultFromMetrics(
  runId: string,
  manifestPath: string,
  metrics: MediaOperationMetrics,
): MediaCleanupApplyResult {
  const savedMb = Math.round(metrics.quarantined.sizeBytes / 1024 / 1024);
  return {
    runId,
    manifestPath,
    metrics,
    quarantined: metrics.quarantined.count,
    savedMb,
    skipped: metrics.skipped.count,
    message: `ย้ายเข้า quarantine ${metrics.quarantined.count} รายการ ${savedMb} MB${metrics.skipped.count ? ` (ข้าม ${metrics.skipped.count} รายการ)` : ""}`,
  };
}

export async function quarantineMediaCleanupPlan(
  plan: MediaCleanupPlan,
  reviewedHash: string,
  options: {
    now?: Date;
    runId?: string;
    batchSize?: number;
    writeManifest?: (manifestPath: string, manifest: unknown) => Promise<void>;
  } = {},
): Promise<MediaCleanupApplyResult> {
  if (plan.graphErrors.length > 0) {
    throw new Error(`media graph incomplete: ${plan.graphErrors.length} error(s)`);
  }
  if (reviewedHash !== plan.manifestSha256) {
    throw new Error("reviewed manifest hash mismatch");
  }
  if (mediaManifestSha256(plan.candidates) !== plan.manifestSha256) {
    throw new Error("media cleanup manifest changed after planning");
  }

  const now = options.now ?? new Date();
  assertValidClock(now);
  const runId = options.runId ?? `${now.toISOString().replace(/[^0-9TZ]/g, "-")}-${randomUUID()}`;
  assertValidRunId(runId);
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? Math.max(1, plan.candidates.length)));
  const existingKnownMediaMtimes = quarantinedMediaMtimes(plan.cwd);
  const quarantineRoot = ensureManagedRoot(plan.cwd, ".media-quarantine");
  const runRoot = path.join(quarantineRoot, runId);
  if (pathEntryExists(runRoot)) throw new Error("media quarantine run already exists");
  ensureSafeDirectory(runRoot, quarantineRoot);
  for (const area of ["renders", "stocks"] as const) {
    ensureSafeDirectory(path.join(runRoot, area), runRoot);
  }

  const metrics = structuredClone(plan.operationMetrics);
  const moved: Array<{ record: MediaManifestRecord; quarantinePath: string }> = [];
  try {
    const { buildMediaReferenceGraph } = await import("@/lib/media-reference-graph");
    for (let offset = 0; offset < plan.candidates.length; offset += batchSize) {
      const batch = plan.candidates.slice(offset, offset + batchSize);
      const knownMediaMtimes = new Map(existingKnownMediaMtimes);
      for (const { record } of moved) knownMediaMtimes.set(record.key, new Date(record.mtimeMs));
      const graph = await buildMediaReferenceGraph(now, plan.cwd, knownMediaMtimes);
      if (graph.errors.length > 0) {
        throw new Error(`media graph incomplete: ${graph.errors.length} error(s)`);
      }

      for (const record of batch) {
        const originalPath = expectedOriginalPath(plan.cwd, record);
        const stat = statMatchesRecord(originalPath, record);
        const currentEligibility = mediaRecordIsEligible(record, graph, now);
        if (!stat || !currentEligibility.eligible) {
          addMetric(metrics.skipped, record.sizeBytes);
          continue;
        }
        const quarantinePath = quarantinePathFor(quarantineRoot, runId, record);
        assertSafeExistingDirectory(path.dirname(quarantinePath), runRoot);
        if (pathEntryExists(quarantinePath)) {
          addMetric(metrics.skipped, record.sizeBytes);
          continue;
        }
        await fs.promises.rename(originalPath, quarantinePath);
        moved.push({ record, quarantinePath });
        addMetric(metrics.quarantined, stat.size);
      }
    }

    const manifestPath = path.join(runRoot, "manifest.json");
    const manifestRecords = moved.map(({ record }) => record);
    const manifest: QuarantineManifest = {
      version: 1,
      runId,
      createdAt: now.toISOString(),
      manifestSha256: plan.manifestSha256,
      recordsSha256: mediaManifestSha256(manifestRecords),
      records: manifestRecords,
      metrics,
      restoredKeys: [],
      purgedKeys: [],
      pendingPurgeKeys: [],
    };
    await (options.writeManifest ?? atomicWriteJson)(manifestPath, manifest);
    return resultFromMetrics(runId, manifestPath, metrics);
  } catch (error) {
    const rollbackFailures = await rollbackMoves(moved);
    if (rollbackFailures > 0) {
      throw new AggregateError(
        [error],
        `media quarantine failed and ${rollbackFailures} rollback(s) failed`,
      );
    }
    try {
      await fs.promises.rm(runRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "media quarantine failed and the empty run could not be removed",
      );
    }
    throw error;
  }
}

function recordIsValid(record: unknown): record is MediaManifestRecord {
  if (!record || typeof record !== "object") return false;
  const candidate = record as Partial<MediaManifestRecord>;
  if (candidate.area !== "renders" && candidate.area !== "stocks") return false;
  if (typeof candidate.key !== "string" || !candidate.key.startsWith(`${candidate.area}/`)) return false;
  const filename = candidate.key.slice(candidate.area.length + 1);
  if (
    !filename ||
    filename !== path.basename(filename) ||
    /[/\\\u0000-\u001f\u007f]/.test(filename)
  ) return false;
  if (
    typeof candidate.absolutePath !== "string" ||
    typeof candidate.sizeBytes !== "number" ||
    !Number.isSafeInteger(candidate.sizeBytes) ||
    candidate.sizeBytes < 0 ||
    typeof candidate.mtimeMs !== "number" ||
    !Number.isFinite(candidate.mtimeMs) ||
    (candidate.effectiveExpiresAt !== null && (
      typeof candidate.effectiveExpiresAt !== "string" ||
      !Number.isFinite(new Date(candidate.effectiveExpiresAt).getTime())
    )) ||
    (candidate.reason !== "all-references-expired" && candidate.reason !== "unreferenced-14d") ||
    typeof candidate.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.fingerprint)
  ) return false;
  return mediaManifestFingerprint(candidate as MediaManifestRecord) === candidate.fingerprint;
}

function metricIsValid(metric: unknown): metric is { count: number; sizeBytes: number } {
  if (!metric || typeof metric !== "object") return false;
  const candidate = metric as { count?: unknown; sizeBytes?: unknown };
  return (
    typeof candidate.count === "number" &&
    Number.isSafeInteger(candidate.count) &&
    candidate.count >= 0 &&
    typeof candidate.sizeBytes === "number" &&
    Number.isSafeInteger(candidate.sizeBytes) &&
    candidate.sizeBytes >= 0
  );
}

function metricsAreValid(metrics: unknown): metrics is MediaOperationMetrics {
  if (!metrics || typeof metrics !== "object") return false;
  const candidate = metrics as Partial<MediaOperationMetrics>;
  return ([
    "scanned",
    "protected",
    "expired",
    "quarantined",
    "restored",
    "purged",
    "skipped",
    "errors",
  ] as const).every((key) => metricIsValid(candidate[key]));
}

function parseManifest(value: unknown, expectedRunId: string, cwd: string): QuarantineManifest {
  if (!value || typeof value !== "object") throw new Error("invalid quarantine manifest");
  const candidate = value as Partial<QuarantineManifest>;
  if (
    candidate.version !== 1 ||
    candidate.runId !== expectedRunId ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(new Date(candidate.createdAt).getTime()) ||
    typeof candidate.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.manifestSha256) ||
    typeof candidate.recordsSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.recordsSha256) ||
    !Array.isArray(candidate.records) ||
    !Array.isArray(candidate.restoredKeys) ||
    !Array.isArray(candidate.purgedKeys) ||
    !Array.isArray(candidate.pendingPurgeKeys) ||
    !metricsAreValid(candidate.metrics)
  ) {
    throw new Error("invalid quarantine manifest");
  }
  if (
    !candidate.records.every(recordIsValid) ||
    mediaManifestSha256(candidate.records as MediaManifestRecord[]) !== candidate.recordsSha256 ||
    !candidate.restoredKeys.every((key) => typeof key === "string") ||
    !candidate.purgedKeys.every((key) => typeof key === "string") ||
    !candidate.pendingPurgeKeys.every((key) => typeof key === "string")
  ) {
    throw new Error("invalid quarantine manifest");
  }
  const recordKeys = new Set<string>((candidate.records as MediaManifestRecord[]).map((record) => record.key));
  if (
    recordKeys.size !== candidate.records.length ||
    new Set(candidate.restoredKeys).size !== candidate.restoredKeys.length ||
    new Set(candidate.purgedKeys).size !== candidate.purgedKeys.length ||
    new Set(candidate.pendingPurgeKeys).size !== candidate.pendingPurgeKeys.length ||
    candidate.restoredKeys.some((key) => !recordKeys.has(key)) ||
    candidate.purgedKeys.some((key) => !recordKeys.has(key)) ||
    candidate.pendingPurgeKeys.some((key) => !recordKeys.has(key)) ||
    candidate.restoredKeys.some((key) => candidate.purgedKeys?.includes(key)) ||
    candidate.restoredKeys.some((key) => candidate.pendingPurgeKeys?.includes(key)) ||
    candidate.purgedKeys.some((key) => candidate.pendingPurgeKeys?.includes(key))
  ) {
    throw new Error("invalid quarantine manifest");
  }
  for (const record of candidate.records as MediaManifestRecord[]) expectedOriginalPath(cwd, record);
  return candidate as QuarantineManifest;
}

function readManifest(manifestPath: string, runId: string, cwd: string): QuarantineManifest {
  assertSafeExistingFile(manifestPath, path.dirname(manifestPath));
  return parseManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown, runId, cwd);
}

export async function restoreQuarantineRun(
  runId: string,
  options: { cwd?: string; now?: Date } = {},
): Promise<QuarantineOperationResult> {
  assertValidRunId(runId);
  const cwd = resolveWorkspace(options.cwd ?? process.cwd());
  const now = options.now ?? new Date();
  assertValidClock(now);
  const quarantineRoot = ensureManagedRoot(cwd, ".media-quarantine");
  const runRoot = path.join(quarantineRoot, runId);
  assertSafeExistingDirectory(runRoot, quarantineRoot);
  const manifestPath = path.join(runRoot, "manifest.json");
  const manifest = readManifest(manifestPath, runId, cwd);
  for (const area of ["renders", "stocks"] as const) {
    assertSafeExistingDirectory(path.join(runRoot, area), runRoot);
  }
  const knownMediaMtimes = quarantinedMediaMtimes(cwd);
  const { buildMediaReferenceGraph } = await import("@/lib/media-reference-graph");
  const graph = await buildMediaReferenceGraph(now, cwd, knownMediaMtimes);
  if (graph.errors.length > 0) throw new Error(`media graph incomplete: ${graph.errors.length} error(s)`);
  const metrics = structuredClone(manifest.metrics);
  const restored = new Set(manifest.restoredKeys);
  const purged = new Set(manifest.purgedKeys);
  const pendingPurge = new Set(manifest.pendingPurgeKeys);

  for (const record of manifest.records) {
    if (restored.has(record.key) || purged.has(record.key)) continue;
    const originalPath = expectedOriginalPath(cwd, record);
    const quarantinePath = quarantinePathFor(quarantineRoot, runId, record);
    if (pathEntryExists(originalPath)) {
      addMetric(metrics.skipped, record.sizeBytes);
      continue;
    }
    const stat = statMatchesRecord(quarantinePath, record);
    if (!stat) {
      addMetric(metrics.skipped, record.sizeBytes);
      continue;
    }
    assertSafeExistingDirectory(path.dirname(quarantinePath), runRoot);
    await fs.promises.rename(quarantinePath, originalPath);
    restored.add(record.key);
    pendingPurge.delete(record.key);
    addMetric(metrics.restored, stat.size);
  }

  manifest.metrics = metrics;
  manifest.restoredKeys = [...restored].sort();
  manifest.pendingPurgeKeys = [...pendingPurge].sort();
  await atomicWriteJson(manifestPath, manifest);
  return { runId, manifestPath, metrics };
}

export async function purgeMediaQuarantine(
  options: {
    cwd?: string;
    now?: Date;
    beforePurgeRecord?: (record: MediaManifestRecord) => Promise<void>;
    afterPendingPurgeWrite?: (record: MediaManifestRecord) => Promise<void>;
    afterPurgeUnlink?: (record: MediaManifestRecord) => Promise<void>;
  } = {},
): Promise<QuarantineOperationResult> {
  const cwd = resolveWorkspace(options.cwd ?? process.cwd());
  const now = options.now ?? new Date();
  assertValidClock(now);
  const aggregate = emptyMediaOperationMetrics();
  const quarantineRoot = ensureManagedRoot(cwd, ".media-quarantine");
  const runIds = fs.readdirSync(quarantineRoot).sort();
  const runs: Array<{
    runId: string;
    runPath: string;
    manifestPath: string;
    manifest: QuarantineManifest;
  }> = [];
  try {
    for (const runId of runIds) {
      assertValidRunId(runId);
      const runPath = path.join(quarantineRoot, runId);
      assertSafeExistingDirectory(runPath, quarantineRoot);
      const manifestPath = path.join(runPath, "manifest.json");
      const manifest = readManifest(manifestPath, runId, cwd);
      for (const area of ["renders", "stocks"] as const) {
        assertSafeExistingDirectory(path.join(runPath, area), runPath);
      }
      runs.push({ runId, runPath, manifestPath, manifest });
    }

    const knownMediaMtimes = new Map<string, Date>();
    const activeKeys = new Set<string>();
    for (const { manifest } of runs) {
      const restored = new Set(manifest.restoredKeys);
      const purged = new Set(manifest.purgedKeys);
      for (const record of manifest.records) {
        if (restored.has(record.key)) continue;
        const recordMtime = new Date(record.mtimeMs);
        const existingMtime = knownMediaMtimes.get(record.key);
        if (!existingMtime || recordMtime.getTime() > existingMtime.getTime()) {
          knownMediaMtimes.set(record.key, recordMtime);
        }
        if (purged.has(record.key)) continue;
        if (activeKeys.has(record.key)) {
          throw new Error("duplicate active quarantine media key");
        }
        activeKeys.add(record.key);
      }
    }

    const { buildMediaReferenceGraph } = await import("@/lib/media-reference-graph");
    const initialGraph = await buildMediaReferenceGraph(now, cwd, knownMediaMtimes);
    if (initialGraph.errors.length > 0) {
      throw new Error(`media graph incomplete: ${initialGraph.errors.length} error(s)`);
    }
    for (const { runId, runPath, manifestPath, manifest } of runs) {
      const createdAt = new Date(manifest.createdAt);
      if (!Number.isFinite(createdAt.getTime()) || now.getTime() - createdAt.getTime() < QUARANTINE_RETENTION_MS) {
        continue;
      }

      const restored = new Set(manifest.restoredKeys);
      const purged = new Set(manifest.purgedKeys);
      const pendingPurge = new Set(manifest.pendingPurgeKeys);
      for (const record of manifest.records) {
        if (restored.has(record.key) || purged.has(record.key)) continue;
        const quarantinePath = quarantinePathFor(quarantineRoot, runId, record);
        if (pendingPurge.has(record.key) && !pathEntryExists(quarantinePath)) {
          pendingPurge.delete(record.key);
          purged.add(record.key);
          addMetric(aggregate.purged, record.sizeBytes);
          addMetric(manifest.metrics.purged, record.sizeBytes);
          manifest.pendingPurgeKeys = [...pendingPurge].sort();
          manifest.purgedKeys = [...purged].sort();
          await atomicWriteJson(manifestPath, manifest);
          continue;
        }

        await options.beforePurgeRecord?.(record);
        const graph = await buildMediaReferenceGraph(now, cwd, knownMediaMtimes);
        if (graph.errors.length > 0) {
          throw new Error(`media graph incomplete: ${graph.errors.length} error(s)`);
        }
        const stat = statMatchesRecord(quarantinePath, record);
        const currentEligibility = mediaRecordIsEligible(record, graph, now);
        if (!stat || !currentEligibility.eligible) {
          if (pendingPurge.delete(record.key)) {
            manifest.pendingPurgeKeys = [...pendingPurge].sort();
            await atomicWriteJson(manifestPath, manifest);
          }
          addMetric(aggregate.skipped, record.sizeBytes);
          continue;
        }
        if (!pendingPurge.has(record.key)) {
          pendingPurge.add(record.key);
          manifest.pendingPurgeKeys = [...pendingPurge].sort();
          await atomicWriteJson(manifestPath, manifest);
        }
        await options.afterPendingPurgeWrite?.(record);
        const finalGraph = await buildMediaReferenceGraph(now, cwd, knownMediaMtimes);
        if (finalGraph.errors.length > 0) {
          throw new Error(`media graph incomplete: ${finalGraph.errors.length} error(s)`);
        }
        const finalStat = statMatchesRecord(quarantinePath, record);
        const finalEligibility = mediaRecordIsEligible(record, finalGraph, now);
        if (!finalStat || !finalEligibility.eligible) {
          pendingPurge.delete(record.key);
          manifest.pendingPurgeKeys = [...pendingPurge].sort();
          await atomicWriteJson(manifestPath, manifest);
          addMetric(aggregate.skipped, record.sizeBytes);
          continue;
        }
        assertSafeExistingDirectory(path.dirname(quarantinePath), runPath);
        await fs.promises.unlink(quarantinePath);
        await options.afterPurgeUnlink?.(record);
        pendingPurge.delete(record.key);
        purged.add(record.key);
        addMetric(aggregate.purged, finalStat.size);
        addMetric(manifest.metrics.purged, finalStat.size);
        manifest.pendingPurgeKeys = [...pendingPurge].sort();
        manifest.purgedKeys = [...purged].sort();
        await atomicWriteJson(manifestPath, manifest);
      }
    }
  } catch (error) {
    addMetric(aggregate.errors, 0);
    throw error;
  }

  return { metrics: aggregate };
}

export function quarantinedMediaMtimes(cwd = process.cwd()): ReadonlyMap<string, Date> {
  const workspace = resolveWorkspace(cwd);
  const workspaceStat = fs.lstatSync(workspace);
  if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) {
    throw new Error("unsafe media workspace root");
  }
  const quarantineRoot = path.join(workspace, ".media-quarantine");
  if (!pathEntryExists(quarantineRoot)) return new Map();
  assertSafeExistingDirectory(quarantineRoot, workspace);

  const mtimes = new Map<string, Date>();
  for (const runId of fs.readdirSync(quarantineRoot).sort()) {
    assertValidRunId(runId);
    const runPath = path.join(quarantineRoot, runId);
    assertSafeExistingDirectory(runPath, quarantineRoot);
    const manifest = readManifest(path.join(runPath, "manifest.json"), runId, workspace);
    for (const area of ["renders", "stocks"] as const) {
      assertSafeExistingDirectory(path.join(runPath, area), runPath);
    }
    const restored = new Set(manifest.restoredKeys);
    for (const record of manifest.records) {
      if (restored.has(record.key)) continue;
      const mtime = new Date(record.mtimeMs);
      const existing = mtimes.get(record.key);
      if (!existing || mtime.getTime() > existing.getTime()) mtimes.set(record.key, mtime);
    }
  }
  return mtimes;
}

export async function writeMediaHealthMetrics(
  plan: MediaCleanupPlan,
  options: { cwd?: string; now?: Date } = {},
): Promise<string> {
  if (plan.graphErrors.length > 0) {
    throw new Error(`media graph incomplete: ${plan.graphErrors.length} error(s)`);
  }
  const now = options.now ?? new Date();
  assertValidClock(now);
  const cwd = resolveWorkspace(options.cwd ?? plan.cwd);
  const metricsRoot = ensureManagedRoot(cwd, ".ops-metrics");
  const metricsPath = path.join(metricsRoot, "media-health.json");
  await atomicWriteJson(metricsPath, {
    generatedAt: now.toISOString(),
    missingBeforeExpiry: plan.health.missingBeforeExpiry,
    expired: plan.health.expired,
    protected: plan.health.protected,
    candidates: plan.health.candidates,
    graphErrors: plan.graphErrors.length,
  });
  return metricsPath;
}
