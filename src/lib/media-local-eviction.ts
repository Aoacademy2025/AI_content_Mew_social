import { unlink, rmdir } from "node:fs/promises";
import path from "node:path";
import { MediaCatalog } from "@/lib/media-catalog";
import {
  getMediaCleanupPlan,
  type MediaCleanupPlan,
  type MediaManifestRecord,
} from "@/lib/media-cleanup";
import {
  manifestSha256ForRecords,
  quarantineMediaCleanupPlan,
  restoreQuarantineRun,
} from "@/lib/media-quarantine";
import {
  contentAddressedMediaIdentity,
  type MediaIdentity,
} from "@/lib/media-storage";
import {
  createR2MediaStorageFromEnv,
  type RemoteMediaReplicaVerifier,
} from "@/lib/media-storage-r2";
import {
  safeMediaFileStat,
  sha256MediaFile,
} from "@/lib/media-storage-support";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type CatalogInspection = Awaited<ReturnType<MediaCatalog["inspect"]>>;

export type VerifiedLocalReplica = {
  record: MediaManifestRecord;
  identity: MediaIdentity;
  remoteIdentity: MediaIdentity;
  sha256: string;
  remoteFilename: string | null;
};

export type LocalEvictionSkipReason =
  | "catalog_unverified"
  | "remote_unverified"
  | "limit"
  | "changed"
  | "quarantine_skipped"
  | "catalog_changed"
  | "restore_failed"
  | "operation_failed";

export type LocalEvictionReport = {
  mode: "dry-run" | "apply";
  generatedAt: string;
  cleanupManifestSha256: string;
  scanned: number;
  eligible: { count: number; sizeBytes: number };
  evicted: { count: number; sizeBytes: number };
  skipped: Record<LocalEvictionSkipReason, number>;
  errors: number;
};

export type LocalEvictionCatalog = Pick<
  MediaCatalog,
  "inspect" | "markLocalEvicted" | "markLocalPresent"
>;

export type LocalEvictionOptions = {
  mode?: "dry-run" | "apply";
  maxObjects?: number;
  maxBytes?: number;
  now?: Date;
  catalog?: LocalEvictionCatalog;
  remote?: RemoteMediaReplicaVerifier;
  env?: Record<string, string | undefined>;
};

function emptySkips(): Record<LocalEvictionSkipReason, number> {
  return {
    catalog_unverified: 0,
    remote_unverified: 0,
    limit: 0,
    changed: 0,
    quarantine_skipped: 0,
    catalog_changed: 0,
    restore_failed: 0,
    operation_failed: 0,
  };
}

function identityForRecord(record: MediaManifestRecord): MediaIdentity | null {
  const slash = record.key.indexOf("/");
  if (slash < 1) return null;
  const area = record.key.slice(0, slash);
  const filename = record.key.slice(slash + 1);
  if (
    (area !== "renders" && area !== "stocks") ||
    !filename ||
    filename !== path.basename(filename)
  ) {
    return null;
  }
  return { area, filename };
}

export function verifiedLocalReplica(
  record: MediaManifestRecord,
  row: CatalogInspection,
): VerifiedLocalReplica | null {
  const identity = identityForRecord(record);
  if (
    !identity ||
    !row ||
    row.remoteState !== "verified" ||
    row.localState !== "present" ||
    typeof row.sha256 !== "string" ||
    !SHA256_PATTERN.test(row.sha256) ||
    row.sizeBytes !== BigInt(record.sizeBytes) ||
    row.localMtimeMs !== BigInt(Math.trunc(record.mtimeMs))
  ) {
    return null;
  }

  let remoteIdentity: MediaIdentity;
  if (row.remoteFilename) {
    const expected = contentAddressedMediaIdentity(identity, row.sha256);
    if (row.remoteFilename !== expected.filename) return null;
    remoteIdentity = expected;
  } else {
    // Pre-v2 render objects were written with If-None-Match and SHA metadata.
    // Legacy stock aliases are mutable and are never eligible for eviction.
    if (identity.area !== "renders") return null;
    remoteIdentity = identity;
  }

  return {
    record,
    identity,
    remoteIdentity,
    sha256: row.sha256,
    remoteFilename: row.remoteFilename,
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Number.isSafeInteger(value) && value! >= min && value! <= max
    ? value!
    : fallback;
}

function singleRecordPlan(
  plan: MediaCleanupPlan,
  record: MediaManifestRecord,
): MediaCleanupPlan {
  const candidates = [record];
  return {
    ...plan,
    candidates,
    manifestSha256: manifestSha256ForRecords(candidates),
  };
}

function quarantinePath(
  workspaceRoot: string,
  runId: string,
  replica: VerifiedLocalReplica,
): string {
  return path.join(
    workspaceRoot,
    ".media-quarantine",
    runId,
    replica.identity.area,
    replica.identity.filename,
  );
}

async function cleanupEmptyRun(
  workspaceRoot: string,
  runId: string,
  area: MediaIdentity["area"],
): Promise<void> {
  const runDir = path.join(workspaceRoot, ".media-quarantine", runId);
  await unlink(path.join(runDir, "manifest.json")).catch(() => undefined);
  await rmdir(path.join(runDir, area)).catch(() => undefined);
  await rmdir(runDir).catch(() => undefined);
}

async function restoreAfterFailure(
  plan: MediaCleanupPlan,
  runId: string,
  replica: VerifiedLocalReplica,
  catalog: LocalEvictionCatalog,
  catalogWasEvicted: boolean,
): Promise<boolean> {
  try {
    const restored = await restoreQuarantineRun(runId, {
      cwd: plan.workspaceRoot,
    });
    if (restored.restored.count !== 1 || restored.errors.count !== 0) return false;
    await cleanupEmptyRun(plan.workspaceRoot, runId, replica.identity.area);
    if (catalogWasEvicted) {
      return catalog.markLocalPresent({
        identity: replica.identity,
        sizeBytes: replica.record.sizeBytes,
        localMtimeMs: replica.record.mtimeMs,
        sha256: replica.sha256,
        remoteFilename: replica.remoteFilename,
      });
    }
    return true;
  } catch {
    return false;
  }
}

async function evictOne(
  plan: MediaCleanupPlan,
  replica: VerifiedLocalReplica,
  catalog: LocalEvictionCatalog,
  remote: RemoteMediaReplicaVerifier,
): Promise<{ status: "evicted" | LocalEvictionSkipReason; error: boolean }> {
  const currentRow = await catalog.inspect(replica.identity);
  const currentReplica = verifiedLocalReplica(replica.record, currentRow);
  if (
    !currentReplica ||
    currentReplica.sha256 !== replica.sha256 ||
    currentReplica.remoteIdentity.filename !== replica.remoteIdentity.filename
  ) {
    return { status: "changed", error: false };
  }

  const one = singleRecordPlan(plan, replica.record);
  const quarantined = await quarantineMediaCleanupPlan(one, one.manifestSha256, {
    batchSize: 1,
  });
  if (quarantined.quarantined.count !== 1) {
    return { status: "quarantine_skipped", error: false };
  }

  const stagedPath = quarantinePath(plan.workspaceRoot, quarantined.runId, replica);
  let catalogWasEvicted = false;
  try {
    const stagedStat = await safeMediaFileStat(stagedPath);
    if (
      stagedStat.size !== replica.record.sizeBytes ||
      stagedStat.mtimeMs !== replica.record.mtimeMs ||
      await sha256MediaFile(stagedPath) !== replica.sha256
    ) {
      const restored = await restoreAfterFailure(
        plan,
        quarantined.runId,
        replica,
        catalog,
        false,
      );
      return {
        status: restored ? "changed" : "restore_failed",
        error: !restored,
      };
    }

    const remoteMatches = await remote.verifyReplica({
      identity: replica.remoteIdentity,
      expectedSizeBytes: replica.record.sizeBytes,
      expectedSha256: replica.sha256,
    });
    if (!remoteMatches) {
      const restored = await restoreAfterFailure(
        plan,
        quarantined.runId,
        replica,
        catalog,
        false,
      );
      return {
        status: restored ? "remote_unverified" : "restore_failed",
        error: !restored,
      };
    }

    catalogWasEvicted = await catalog.markLocalEvicted({
      identity: replica.identity,
      sizeBytes: replica.record.sizeBytes,
      localMtimeMs: replica.record.mtimeMs,
      sha256: replica.sha256,
      remoteFilename: replica.remoteFilename,
    });
    if (!catalogWasEvicted) {
      const restored = await restoreAfterFailure(
        plan,
        quarantined.runId,
        replica,
        catalog,
        false,
      );
      return {
        status: restored ? "catalog_changed" : "restore_failed",
        error: !restored,
      };
    }

    await unlink(stagedPath);
    await cleanupEmptyRun(
      plan.workspaceRoot,
      quarantined.runId,
      replica.identity.area,
    );
    return { status: "evicted", error: false };
  } catch {
    const restored = await restoreAfterFailure(
      plan,
      quarantined.runId,
      replica,
      catalog,
      catalogWasEvicted,
    );
    return {
      status: restored ? "operation_failed" : "restore_failed",
      error: true,
    };
  }
}

export async function runLocalMediaEviction(
  plan: MediaCleanupPlan,
  options: LocalEvictionOptions = {},
): Promise<LocalEvictionReport> {
  if (plan.graphErrors.length > 0) {
    throw new Error(`media graph incomplete: ${plan.graphErrors.length} error(s)`);
  }
  const mode = options.mode ?? "dry-run";
  const env = options.env ?? process.env;
  if (env.MEDIA_R2_DELETE === "1") {
    throw new Error("R2 deletion must remain disabled during local eviction");
  }
  if (
    mode === "apply" &&
    (
      env.MEDIA_LOCAL_EVICTION !== "1" ||
      (env.MEDIA_READ_MODE !== "r2-local" && env.MEDIA_READ_MODE !== "r2")
    )
  ) {
    throw new Error("local eviction is blocked by rollout mode");
  }

  const maxObjects = boundedInteger(options.maxObjects, 10, 1, 500);
  const maxBytes = boundedInteger(
    options.maxBytes,
    1024 * 1024 * 1024,
    1,
    50 * 1024 * 1024 * 1024,
  );
  const catalog = options.catalog ?? new MediaCatalog();
  const remote = options.remote ?? createR2MediaStorageFromEnv(env, "read");
  const report: LocalEvictionReport = {
    mode,
    generatedAt: (options.now ?? new Date()).toISOString(),
    cleanupManifestSha256: plan.manifestSha256,
    scanned: plan.candidates.length,
    eligible: { count: 0, sizeBytes: 0 },
    evicted: { count: 0, sizeBytes: 0 },
    skipped: emptySkips(),
    errors: 0,
  };

  const selected: VerifiedLocalReplica[] = [];
  for (const record of plan.candidates) {
    const identity = identityForRecord(record);
    const row = identity ? await catalog.inspect(identity) : null;
    const replica = verifiedLocalReplica(record, row);
    if (!replica) {
      report.skipped.catalog_unverified++;
      continue;
    }
    if (
      selected.length >= maxObjects ||
      report.eligible.sizeBytes + record.sizeBytes > maxBytes
    ) {
      report.skipped.limit++;
      continue;
    }
    try {
      const remoteMatches = await remote.verifyReplica({
        identity: replica.remoteIdentity,
        expectedSizeBytes: record.sizeBytes,
        expectedSha256: replica.sha256,
      });
      if (!remoteMatches) {
        report.skipped.remote_unverified++;
        continue;
      }
    } catch {
      report.skipped.remote_unverified++;
      report.errors++;
      continue;
    }
    selected.push(replica);
    report.eligible.count++;
    report.eligible.sizeBytes += record.sizeBytes;
  }

  if (mode === "dry-run" || report.errors > 0) return report;

  for (const replica of selected) {
    const result = await evictOne(plan, replica, catalog, remote);
    if (result.status === "evicted") {
      report.evicted.count++;
      report.evicted.sizeBytes += replica.record.sizeBytes;
    } else {
      report.skipped[result.status]++;
      if (result.error) report.errors++;
    }
  }
  return report;
}

export async function planAndRunLocalMediaEviction(input: {
  olderThanDays?: number;
  includeStocks?: boolean;
  cwd?: string;
  options?: LocalEvictionOptions;
} = {}): Promise<LocalEvictionReport> {
  const plan = await getMediaCleanupPlan({
    olderThanDays: input.olderThanDays,
    includeStocks: input.includeStocks,
    cwd: input.cwd,
    now: input.options?.now,
  });
  return runLocalMediaEviction(plan, input.options);
}
