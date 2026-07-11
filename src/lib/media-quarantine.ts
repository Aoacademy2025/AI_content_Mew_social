import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import type { MediaCleanupPlan, MediaKey, MediaManifestRecord } from "./media-cleanup";
import type { MediaGraph, MediaGraphError } from "./media-reference-graph";
import type { MediaReference } from "./media-retention";

const DAY_MS = 86_400_000;
const MANIFEST_RECORD_KEYS = [
  "absolutePath",
  "effectiveExpiresAt",
  "fingerprint",
  "key",
  "mtimeMs",
  "reason",
  "sizeBytes",
] as const;

export type CleanupTally = { count: number; sizeBytes: number };

export type MediaOperationReport = {
  runId: string;
  scanned: CleanupTally;
  protected: CleanupTally;
  expired: CleanupTally;
  quarantined: CleanupTally;
  restored: CleanupTally;
  purged: CleanupTally;
  skipped: CleanupTally;
  errors: CleanupTally;
};

export type ApplyMediaCleanupOptions = {
  now?: Date;
  batchSize?: number;
  runIdFactory?: (now: Date, reviewedManifestSha256: string) => string;
  beforeRollbackMove?: (record: MediaManifestRecord) => Promise<void>;
  writeManifest?: (manifestPath: string, manifest: QuarantineManifest) => Promise<void>;
};

export type QuarantineManifest = {
  version: 1;
  runId: string;
  generatedAt: string;
  reviewedManifestSha256: string;
  recordsSha256: string;
  records: MediaManifestRecord[];
  purgeIntents: Array<{ key: MediaKey; fingerprint: string; markedAt: string }>;
  stateSha256: string;
};

export type RestoreQuarantineOptions = {
  cwd?: string;
  now?: Date;
  batchSize?: number;
  beforeMove?: (record: MediaManifestRecord) => Promise<void>;
};
export type PurgeQuarantineOptions = {
  cwd?: string;
  now?: Date;
  batchSize?: number;
};

type FingerprintInput = Pick<MediaManifestRecord, "key" | "sizeBytes" | "mtimeMs">;
type MovedRecord = { record: MediaManifestRecord; quarantinePath: string };
type QuarantineRunLock = { release: () => Promise<void> };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareStableText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function manifestStateSha256(
  manifest: Omit<QuarantineManifest, "stateSha256">,
): string {
  return sha256(JSON.stringify({
    version: manifest.version,
    runId: manifest.runId,
    generatedAt: manifest.generatedAt,
    reviewedManifestSha256: manifest.reviewedManifestSha256,
    recordsSha256: manifest.recordsSha256,
    purgeIntents: [...manifest.purgeIntents].sort((a, b) =>
      compareStableText(a.key, b.key) || compareStableText(a.fingerprint, b.fingerprint)
    ),
  }));
}

function completeManifest(
  manifest: Omit<QuarantineManifest, "stateSha256">,
): QuarantineManifest {
  return { ...manifest, stateSha256: manifestStateSha256(manifest) };
}

function tally(records: Array<Pick<MediaManifestRecord, "sizeBytes">>): CleanupTally {
  return {
    count: records.length,
    sizeBytes: records.reduce((sum, record) => sum + record.sizeBytes, 0),
  };
}

function emptyTally(): CleanupTally {
  return { count: 0, sizeBytes: 0 };
}

function addTally(target: CleanupTally, sizeBytes: number): void {
  target.count++;
  target.sizeBytes += sizeBytes;
}

function reportForPlan(plan?: MediaCleanupPlan, runId = ""): MediaOperationReport {
  return {
    runId,
    scanned: plan ? { ...plan.tallies.scanned } : emptyTally(),
    protected: plan ? { ...plan.tallies.protected } : emptyTally(),
    expired: plan ? { ...plan.tallies.expired } : emptyTally(),
    quarantined: emptyTally(),
    restored: emptyTally(),
    purged: emptyTally(),
    skipped: emptyTally(),
    errors: emptyTally(),
  };
}

export function fingerprintMediaRecord(record: FingerprintInput): string {
  return sha256(JSON.stringify({
    key: record.key,
    sizeBytes: record.sizeBytes,
    mtimeMs: record.mtimeMs,
  }));
}

export function manifestSha256ForRecords(records: MediaManifestRecord[]): string {
  const stable = records
    .map((record) => ({
      key: record.key,
      absolutePath: record.absolutePath,
      sizeBytes: record.sizeBytes,
      mtimeMs: record.mtimeMs,
      effectiveExpiresAt: record.effectiveExpiresAt,
      reason: record.reason,
      fingerprint: record.fingerprint,
    }))
    .sort((a, b) =>
      compareStableText(a.key, b.key) || compareStableText(a.absolutePath, b.absolutePath)
    );
  return sha256(JSON.stringify(stable));
}

function graphIncompleteError(errors: MediaGraphError[]): Error {
  return new Error(`media graph incomplete: ${errors.length} error(s)`);
}

function assertGraphComplete(graph: MediaGraph): void {
  if (graph.errors.length > 0) throw graphIncompleteError(graph.errors);
}

function referenceSetIsExpired(refs: MediaReference[], now: Date): boolean {
  return refs.length > 0 && refs.every((reference) =>
    reference.alwaysProtect !== true &&
    reference.expiresAt !== null &&
    Number.isFinite(reference.expiresAt.getTime()) &&
    reference.expiresAt.getTime() < now.getTime()
  );
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function exactManifestRecordShape(record: MediaManifestRecord): boolean {
  return JSON.stringify(Object.keys(record).sort()) === JSON.stringify([...MANIFEST_RECORD_KEYS].sort());
}

async function canonicalRecordPath(
  record: MediaManifestRecord,
  cwd: string,
): Promise<{ area: "renders" | "stocks"; filename: string; absolutePath: string }> {
  if (!exactManifestRecordShape(record)) throw new Error("invalid media manifest record");
  const slash = record.key.indexOf("/");
  if (slash < 1) throw new Error("invalid media manifest record");
  const area = record.key.slice(0, slash);
  const filename = record.key.slice(slash + 1);
  if ((area !== "renders" && area !== "stocks") || !filename) {
    throw new Error("invalid media manifest record");
  }

  const { mediaRootPaths, parseCanonicalMediaRef } = await import("./media-cleanup");
  const roots = mediaRootPaths(cwd);
  const parsed = parseCanonicalMediaRef(
    area === "renders"
      ? `/api/renders/${encodeURIComponent(filename)}`
      : `/api/stocks/${encodeURIComponent(filename)}`,
    roots,
  );
  if (parsed.kind !== "reference" || parsed.ref.key !== record.key) {
    throw new Error("invalid media manifest record");
  }
  let reviewedAbsolutePath: string;
  let parsedAbsolutePath: string;
  try {
    reviewedAbsolutePath = path.join(
      fs.realpathSync.native(path.dirname(path.resolve(record.absolutePath))),
      path.basename(record.absolutePath),
    );
    parsedAbsolutePath = path.join(
      fs.realpathSync.native(path.dirname(parsed.ref.absolutePath)),
      path.basename(parsed.ref.absolutePath),
    );
  } catch {
    throw new Error("invalid media manifest record");
  }
  if (reviewedAbsolutePath !== parsedAbsolutePath) {
    throw new Error("invalid media manifest record");
  }
  if (record.fingerprint !== fingerprintMediaRecord(record)) {
    throw new Error("invalid media manifest record fingerprint");
  }
  return { area, filename, absolutePath: parsed.ref.absolutePath };
}

function safeLstat(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return null;
  }
}

export function pathIsStrictlyAbsent(
  filePath: string,
  lstat: (candidate: string) => fs.Stats = fs.lstatSync,
): boolean {
  try {
    lstat(filePath);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return true;
    throw new Error("indeterminate original path");
  }
}

function statMatchesRecord(stat: fs.Stats, record: MediaManifestRecord): boolean {
  return stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.size === record.sizeBytes &&
    stat.mtimeMs === record.mtimeMs &&
    fingerprintMediaRecord({
      key: record.key,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    }) === record.fingerprint;
}

async function assertSafeDirectory(dir: string, workspaceRoot: string): Promise<void> {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(dir);
  if (!pathIsWithin(root, target)) throw new Error("unsafe operation directory");

  const rootStat = safeLstat(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("unsafe operation directory");
  }
  let current = root;
  const relative = path.relative(root, target);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat = safeLstat(current);
    if (!stat) {
      await fsp.mkdir(current);
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("unsafe operation directory");
    }
  }
}

async function existingPathHasNoSymlink(filePath: string, workspaceRoot: string): Promise<boolean> {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(filePath);
  if (!pathIsWithin(root, target)) throw new Error("unsafe quarantine path");
  const rootStat = safeLstat(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("unsafe quarantine path");
  }
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = safeLstat(current);
    if (!stat) return false;
    if (stat.isSymbolicLink()) throw new Error("unsafe quarantine path");
  }
  return true;
}

async function atomicWriteJson(filePath: string, value: unknown, workspaceRoot: string): Promise<void> {
  await assertSafeDirectory(path.dirname(filePath), workspaceRoot);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function moveFileNoReplace(
  source: string,
  destination: string,
  beforeLink?: () => Promise<void>,
): Promise<"moved" | "collision"> {
  await beforeLink?.();
  try {
    await fsp.link(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "collision";
    throw error;
  }
  try {
    await fsp.unlink(source);
  } catch (error) {
    // If source unlink fails, remove only the link we just created. If that cleanup also
    // fails, both names remain; at least one recoverable copy is always preserved.
    await fsp.unlink(destination).catch(() => undefined);
    throw error;
  }
  return "moved";
}

function runIdBase(now: Date, manifestSha256: string): string {
  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  return `${timestamp}-${manifestSha256.slice(0, 16)}`;
}

function createRunId(now: Date, manifestSha256: string): string {
  return `${runIdBase(now, manifestSha256)}-${randomUUID().replace(/-/g, "")}`;
}

function batches<T>(items: T[], requestedSize?: number): T[][] {
  const size = Number.isFinite(requestedSize)
    ? Math.max(1, Math.min(500, Math.floor(requestedSize!)))
    : 50;
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function rollbackMoves(
  moved: MovedRecord[],
  report: MediaOperationReport,
  beforeMove?: (record: MediaManifestRecord) => Promise<void>,
): Promise<boolean> {
  let fullyRestored = true;
  for (const move of [...moved].reverse()) {
    try {
      if (!safeLstat(move.quarantinePath)) {
        addTally(report.errors, move.record.sizeBytes);
        fullyRestored = false;
        continue;
      }
      const movedBack = await moveFileNoReplace(
        move.quarantinePath,
        move.record.absolutePath,
        beforeMove ? () => beforeMove(move.record) : undefined,
      );
      if (movedBack === "collision") {
        addTally(report.errors, move.record.sizeBytes);
        fullyRestored = false;
        continue;
      }
      addTally(report.restored, move.record.sizeBytes);
    } catch {
      addTally(report.errors, move.record.sizeBytes);
      fullyRestored = false;
    }
  }
  return fullyRestored;
}

function throwWithReport(error: unknown, report: MediaOperationReport): never {
  const result = error instanceof Error ? error : new Error(String(error));
  Object.assign(result, { operationReport: report });
  throw result;
}

export async function quarantineMediaCleanupPlan(
  plan: MediaCleanupPlan,
  reviewedManifestSha256: string,
  options: ApplyMediaCleanupOptions = {},
): Promise<MediaOperationReport> {
  if (plan.graphErrors.length > 0) throw graphIncompleteError(plan.graphErrors);
  if (reviewedManifestSha256 !== plan.manifestSha256) {
    throw new Error("reviewed manifest hash mismatch");
  }
  if (manifestSha256ForRecords(plan.candidates) !== plan.manifestSha256) {
    throw new Error("reviewed manifest hash mismatch");
  }

  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("invalid cleanup clock");
  const cwd = plan.workspaceRoot;
  for (const record of plan.candidates) await canonicalRecordPath(record, cwd);

  const runId = (options.runIdFactory ?? createRunId)(now, plan.manifestSha256);
  if (
    !safeRunId(runId) ||
    !runId.startsWith(`${runIdBase(now, plan.manifestSha256)}-`)
  ) {
    throw new Error("invalid quarantine run id");
  }
  const quarantineRoot = path.join(cwd, ".media-quarantine");
  const runDir = path.join(quarantineRoot, runId);
  await assertSafeDirectory(quarantineRoot, cwd);
  try {
    await fsp.mkdir(runDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("quarantine run already exists");
    }
    throw error;
  }
  const report = reportForPlan(plan, runId);
  const moved: MovedRecord[] = [];

  try {
    for (const batch of batches(plan.candidates, options.batchSize)) {
      const { buildMediaReferenceGraph } = await import("./media-reference-graph");
      const graph = await buildMediaReferenceGraph(now, {
        workspaceRoot: cwd,
        ignoreQuarantineRunIds: new Set([runId]),
        inFlightQuarantinedMedia: new Map(moved.map(({ record }) => [
          record.key,
          { mtimeMs: record.mtimeMs },
        ])),
      });
      assertGraphComplete(graph);

      for (const record of batch) {
        const canonical = await canonicalRecordPath(record, cwd);
        const refs = graph.refs.get(record.key) ?? [];
        const eligible = refs.length > 0
          ? referenceSetIsExpired(refs, now)
          : record.mtimeMs < now.getTime() - 14 * DAY_MS;
        if (!eligible) {
          addTally(report.skipped, record.sizeBytes);
          continue;
        }

        const stat = safeLstat(canonical.absolutePath);
        if (!stat || !statMatchesRecord(stat, record)) {
          addTally(report.skipped, record.sizeBytes);
          continue;
        }

        const areaDir = path.join(runDir, canonical.area);
        await assertSafeDirectory(areaDir, cwd);
        const quarantinePath = path.join(areaDir, canonical.filename);
        if (!pathIsWithin(areaDir, quarantinePath) || safeLstat(quarantinePath)) {
          addTally(report.skipped, record.sizeBytes);
          continue;
        }
        await fsp.rename(canonical.absolutePath, quarantinePath);
        moved.push({ record, quarantinePath });
        addTally(report.quarantined, record.sizeBytes);
      }
    }

    if (moved.length > 0) {
      const records = moved.map((move) => move.record);
      const manifest = completeManifest({
        version: 1,
        runId,
        generatedAt: now.toISOString(),
        reviewedManifestSha256,
        recordsSha256: manifestSha256ForRecords(records),
        records,
        purgeIntents: [],
      });
      const manifestPath = path.join(runDir, "manifest.json");
      await (options.writeManifest ?? ((filePath, value) => atomicWriteJson(filePath, value, cwd)))(
        manifestPath,
        manifest,
      );
    } else {
      await fsp.rmdir(runDir);
    }
    return report;
  } catch (error) {
    const fullyRestored = await rollbackMoves(moved, report, options.beforeRollbackMove);
    if (fullyRestored) {
      await fsp.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    } else {
      const records = moved
        .filter((move) => safeLstat(move.quarantinePath))
        .map((move) => move.record);
      if (records.length > 0) {
        const recoveryManifest = completeManifest({
          version: 1,
          runId,
          generatedAt: now.toISOString(),
          reviewedManifestSha256,
          recordsSha256: manifestSha256ForRecords(records),
          records,
          purgeIntents: [],
        });
        await atomicWriteJson(path.join(runDir, "manifest.json"), recoveryManifest, cwd)
          .catch(() => undefined);
      }
    }
    throwWithReport(error, report);
  }
}

function safeRunId(runId: string): boolean {
  return /^\d{8}T\d{9}Z-[a-f0-9]{16}-[a-f0-9]{32}$/.test(runId);
}

async function acquireQuarantineRunLock(cwd: string, runId: string): Promise<QuarantineRunLock> {
  if (!safeRunId(runId)) throw new Error("invalid quarantine run id");
  const runDir = path.join(cwd, ".media-quarantine", runId);
  if (!await existingPathHasNoSymlink(runDir, cwd)) throw new Error("invalid quarantine run id");
  const lockPath = path.join(runDir, ".operation.lock");
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("quarantine run busy");
    }
    throw error;
  }
  return {
    release: async () => {
      await handle.close().catch(() => undefined);
      await fsp.unlink(lockPath).catch(() => undefined);
    },
  };
}

async function loadManifestIntegrity(cwd: string, runId: string): Promise<QuarantineManifest> {
  if (!safeRunId(runId)) throw new Error("invalid quarantine run id");
  const manifestPath = path.join(cwd, ".media-quarantine", runId, "manifest.json");
  if (!await existingPathHasNoSymlink(manifestPath, cwd)) {
    throw new Error("invalid quarantine manifest");
  }
  const parsed = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as QuarantineManifest;
  const generatedAt = new Date(parsed.generatedAt);
  const recordByKey = new Map((Array.isArray(parsed.records) ? parsed.records : []).map(
    (record) => [record.key, record],
  ));
  const purgeIntentsValid = Array.isArray(parsed.purgeIntents) && parsed.purgeIntents.every(
    (intent) => {
      const record = recordByKey.get(intent.key);
      const markedAt = new Date(intent.markedAt);
      return Boolean(record) &&
        record!.fingerprint === intent.fingerprint &&
        Number.isFinite(markedAt.getTime()) &&
        intent.markedAt === markedAt.toISOString() &&
        markedAt.getTime() >= generatedAt.getTime();
    },
  );
  if (
    parsed.version !== 1 ||
    parsed.runId !== runId ||
    !/^[a-f0-9]{64}$/.test(parsed.reviewedManifestSha256) ||
    !Number.isFinite(generatedAt.getTime()) ||
    parsed.generatedAt !== generatedAt.toISOString() ||
    !runId.startsWith(`${runIdBase(generatedAt, parsed.reviewedManifestSha256)}-`) ||
    !Array.isArray(parsed.records) ||
    parsed.recordsSha256 !== manifestSha256ForRecords(parsed.records) ||
    !purgeIntentsValid ||
    new Set(parsed.purgeIntents.map((intent) => intent.key)).size !== parsed.purgeIntents.length ||
    parsed.stateSha256 !== manifestStateSha256({
      version: parsed.version,
      runId: parsed.runId,
      generatedAt: parsed.generatedAt,
      reviewedManifestSha256: parsed.reviewedManifestSha256,
      recordsSha256: parsed.recordsSha256,
      records: parsed.records,
      purgeIntents: parsed.purgeIntents,
    })
  ) {
    throw new Error("invalid quarantine manifest");
  }
  return parsed;
}

async function loadManifest(cwd: string, runId: string): Promise<QuarantineManifest> {
  const parsed = await loadManifestIntegrity(cwd, runId);
  for (const record of parsed.records) await canonicalRecordPath(record, cwd);
  return parsed;
}

function quarantinePathFor(cwd: string, runId: string, record: MediaManifestRecord): string {
  const slash = record.key.indexOf("/");
  return path.join(cwd, ".media-quarantine", runId, record.key.slice(0, slash), record.key.slice(slash + 1));
}

async function restoreQuarantineRunLocked(
  runId: string,
  options: RestoreQuarantineOptions = {},
): Promise<MediaOperationReport> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  let manifest = await loadManifest(cwd, runId);
  const report = reportForPlan(undefined, runId);
  report.scanned = tally(manifest.records);
  const restoredMoves: MovedRecord[] = [];

  try {
    for (const batch of batches(manifest.records, options.batchSize)) {
      for (const record of batch) {
        await canonicalRecordPath(record, cwd);
        const quarantinePath = quarantinePathFor(cwd, runId, record);
        if (!await existingPathHasNoSymlink(quarantinePath, cwd)) {
          addTally(report.skipped, record.sizeBytes);
          continue;
        }
        const quarantineStat = safeLstat(quarantinePath);
        if (!quarantineStat || !statMatchesRecord(quarantineStat, record)) {
          addTally(report.skipped, record.sizeBytes);
          continue;
        }
        if (manifest.purgeIntents.some((intent) => intent.key === record.key)) {
          const { stateSha256: _stateSha256, ...manifestState } = manifest;
          manifest = completeManifest({
            ...manifestState,
            purgeIntents: manifest.purgeIntents.filter((intent) => intent.key !== record.key),
          });
          await atomicWriteJson(
            path.join(cwd, ".media-quarantine", runId, "manifest.json"),
            manifest,
            cwd,
          );
        }
        let movedBack: "moved" | "collision";
        try {
          movedBack = await moveFileNoReplace(
            quarantinePath,
            record.absolutePath,
            options.beforeMove ? () => options.beforeMove!(record) : undefined,
          );
        } catch (error) {
          addTally(report.errors, record.sizeBytes);
          throw error;
        }
        if (movedBack === "collision") {
          addTally(report.skipped, record.sizeBytes);
          continue;
        }
        restoredMoves.push({ record, quarantinePath });
        addTally(report.restored, record.sizeBytes);
      }
    }
    return report;
  } catch (error) {
    for (const move of [...restoredMoves].reverse()) {
      try {
        if (!safeLstat(move.quarantinePath) && safeLstat(move.record.absolutePath)) {
          const rolledBack = await moveFileNoReplace(move.record.absolutePath, move.quarantinePath);
          if (rolledBack === "collision") addTally(report.errors, move.record.sizeBytes);
        }
      } catch {
        addTally(report.errors, move.record.sizeBytes);
      }
    }
    throwWithReport(error, report);
  }
}

export async function restoreQuarantineRun(
  runId: string,
  options: RestoreQuarantineOptions = {},
): Promise<MediaOperationReport> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const lock = await acquireQuarantineRunLock(cwd, runId);
  try {
    return await restoreQuarantineRunLocked(runId, { ...options, cwd });
  } finally {
    await lock.release();
  }
}

export async function purgeMediaQuarantine(
  _options: PurgeQuarantineOptions = {},
): Promise<MediaOperationReport> {
  const report = reportForPlan();
  addTally(report.errors, 0);
  throwWithReport(
    new Error("permanent purge disabled pending shared writer exclusion"),
    report,
  );
}

export async function writeMediaHealthMetrics(
  plan: MediaCleanupPlan,
  options: { cwd?: string; now?: Date } = {},
): Promise<string> {
  if (plan.graphErrors.length > 0) throw graphIncompleteError(plan.graphErrors);
  const cwd = path.resolve(options.cwd ?? plan.workspaceRoot);
  const now = options.now ?? new Date();
  const metrics = {
    generatedAt: now.toISOString(),
    missingBeforeExpiry: plan.health.missingBeforeExpiry,
    expired: plan.health.expired,
    protected: plan.health.protected,
    candidates: plan.health.candidates,
    graphErrors: plan.graphErrors.length,
  };
  const metricsPath = path.join(cwd, ".ops-metrics", "media-health.json");
  await atomicWriteJson(metricsPath, metrics, cwd);
  return metricsPath;
}

export async function writeMediaCleanupReviewArtifact(
  plan: MediaCleanupPlan,
  options: { cwd?: string; now?: Date } = {},
): Promise<string> {
  if (plan.graphErrors.length > 0) throw graphIncompleteError(plan.graphErrors);
  if (manifestSha256ForRecords(plan.candidates) !== plan.manifestSha256) {
    throw new Error("reviewed manifest hash mismatch");
  }
  const cwd = path.resolve(options.cwd ?? plan.workspaceRoot);
  const now = options.now ?? new Date();
  const relativePath = ".ops-metrics/media-cleanup-review.json";
  await atomicWriteJson(path.join(cwd, ...relativePath.split("/")), {
    generatedAt: now.toISOString(),
    manifestSha256: plan.manifestSha256,
    candidates: plan.candidates,
  }, cwd);
  return relativePath;
}

export async function buildQuarantinedMediaIndex(
  cwd = process.cwd(),
  options: { ignoreRunIds?: ReadonlySet<string> } = {},
): Promise<Map<MediaKey, MediaManifestRecord>> {
  const workspaceRoot = path.resolve(cwd);
  const quarantineRoot = path.join(workspaceRoot, ".media-quarantine");
  const rootStat = safeLstat(quarantineRoot);
  if (!rootStat) return new Map();
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("invalid quarantine hierarchy");
  }

  const lifecycles = new Map<MediaKey, {
    generatedAt: number;
    record: MediaManifestRecord;
    usable: boolean;
    ambiguous: boolean;
  }>();
  for (const runId of (await fsp.readdir(quarantineRoot)).sort()) {
    if (options.ignoreRunIds?.has(runId)) continue;
    const runPath = path.join(quarantineRoot, runId);
    const runStat = safeLstat(runPath);
    if (!runStat || runStat.isSymbolicLink() || !runStat.isDirectory()) {
      throw new Error("invalid quarantine hierarchy");
    }
    const manifest = await loadManifest(workspaceRoot, runId);
    const generatedAt = new Date(manifest.generatedAt).getTime();
    for (const record of manifest.records) {
      const quarantinePath = quarantinePathFor(workspaceRoot, runId, record);
      const purgeIntent = manifest.purgeIntents.find((intent) =>
        intent.key === record.key && intent.fingerprint === record.fingerprint
      );
      const existsWithoutSymlink = await existingPathHasNoSymlink(quarantinePath, workspaceRoot);
      const stat = existsWithoutSymlink ? safeLstat(quarantinePath) : null;
      const usable = Boolean(stat && statMatchesRecord(stat, record)) || (!stat && Boolean(purgeIntent));
      const current = lifecycles.get(record.key);
      if (!current || generatedAt > current.generatedAt) {
        lifecycles.set(record.key, { generatedAt, record, usable, ambiguous: false });
      } else if (generatedAt === current.generatedAt) {
        // Unique run suffixes do not establish chronology. Equal-time lifecycles are
        // conservatively unusable so an older tombstone can never win by iteration order.
        current.ambiguous = true;
        current.usable = false;
      }
    }
  }
  return new Map(
    [...lifecycles]
      .filter(([, lifecycle]) => lifecycle.usable && !lifecycle.ambiguous)
      .map(([key, lifecycle]) => [key, lifecycle.record]),
  );
}
