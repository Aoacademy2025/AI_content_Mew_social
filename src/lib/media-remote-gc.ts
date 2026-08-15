import { createHash } from "node:crypto";
import path from "node:path";
import {
  MediaCatalog,
  type MediaCatalogRemoteGcClaim,
  type MediaCatalogRemoteGcRow,
} from "@/lib/media-catalog";
import { type MediaGraph, buildMediaReferenceGraph } from "@/lib/media-reference-graph";
import {
  contentAddressedMediaIdentity,
  mediaObjectKey,
  type MediaIdentity,
  type MediaStorage,
} from "@/lib/media-storage";
import {
  createR2MediaStorageFromEnv,
  type RemoteMediaReplicaVerifier,
} from "@/lib/media-storage-r2";
import {
  MEDIA_RECOVERY_GRACE_HOURS,
  mediaReferenceIsLive,
} from "@/lib/media-retention";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DAY_MS = 86_400_000;
const DELETE_LEASE_MS = 15 * 60 * 1000;
const DELETE_RETRY_MS = 60 * 60 * 1000;

type RemoteGcMode = "dry-run" | "apply";
type RemoteGcAction = "stage" | "delete" | "restore";

type RemoteGcCatalog = Pick<
  MediaCatalog,
  | "remoteGcInventory"
  | "stageRemoteDelete"
  | "rebaseRemoteDeletePending"
  | "claimRemoteDelete"
  | "markRemoteDeleted"
  | "deferRemoteDelete"
  | "restoreRemoteDeletePending"
>;

type RemoteGcStorage = RemoteMediaReplicaVerifier & Pick<MediaStorage, "remove">;
type RemoteGcCatalogTransition = "stage" | "rebase" | null;

export type RemoteGcSkipReason =
  | "catalog_busy"
  | "catalog_changed"
  | "catalog_inconsistent"
  | "local_present"
  | "live_reference"
  | "unreferenced_grace"
  | "pending_grace"
  | "stage_disabled"
  | "limit"
  | "remote_unverified"
  | "checksum_mismatch"
  | "operation_failed"
  | "unsupported_legacy_stock";

export type RemoteGcManifestRecord = {
  action: RemoteGcAction;
  catalogTransition: RemoteGcCatalogTransition;
  physicalKey: string;
  sizeBytes: number;
  sha256: string;
  logicalKeys: string[];
  reason:
    | "all_references_expired"
    | "unreferenced_14d"
    | "reference_became_live"
    | "eligibility_changed";
  eligibleAt: string | null;
  aliases: MediaCatalogRemoteGcClaim[];
};

export type RemoteGcDiagnostic = {
  code: "invalid_catalog_identity" | "invalid_catalog_size" | "physical_metadata_mismatch";
  logicalKey: string;
  physicalKey?: string;
};

export type RemoteMediaGcReport = {
  mode: RemoteGcMode;
  generatedAt: string;
  manifestSha256: string;
  scanned: { aliases: number; physicalObjects: number };
  eligible: { count: number; sizeBytes: number };
  selected: { count: number; sizeBytes: number };
  staged: { count: number; sizeBytes: number };
  rebased: { count: number; sizeBytes: number };
  deleted: { count: number; sizeBytes: number };
  missingFinalized: { count: number; sizeBytes: number };
  restored: { count: number; sizeBytes: number };
  skipped: Record<RemoteGcSkipReason, number>;
  errors: number;
  diagnostics: RemoteGcDiagnostic[];
  records: RemoteGcManifestRecord[];
};

export type RemoteMediaGcOptions = {
  mode?: RemoteGcMode;
  maxObjects?: number;
  maxBytes?: number;
  graceHours?: number;
  manifestSha256?: string;
  automated?: boolean;
  pendingOnly?: boolean;
  now?: Date;
  cwd?: string;
  env?: Record<string, string | undefined>;
  catalog?: RemoteGcCatalog;
  remote?: RemoteGcStorage;
  graph?: MediaGraph;
};

type PhysicalGroup = {
  physicalIdentity: MediaIdentity;
  physicalKey: string;
  sha256: string;
  sizeBytes: number;
  rows: MediaCatalogRemoteGcRow[];
};

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

function emptySkips(): Record<RemoteGcSkipReason, number> {
  return {
    catalog_busy: 0,
    catalog_changed: 0,
    catalog_inconsistent: 0,
    local_present: 0,
    live_reference: 0,
    unreferenced_grace: 0,
    pending_grace: 0,
    stage_disabled: 0,
    limit: 0,
    remote_unverified: 0,
    checksum_mismatch: 0,
    operation_failed: 0,
    unsupported_legacy_stock: 0,
  };
}

function safeNumber(value: bigint | null): number | null {
  if (value === null) return null;
  const converted = Number(value);
  return Number.isSafeInteger(converted) && converted >= 0 ? converted : null;
}

function logicalIdentity(row: MediaCatalogRemoteGcRow): MediaIdentity | null {
  if (
    (row.area !== "renders" && row.area !== "stocks") ||
    !row.filename ||
    row.filename !== path.basename(row.filename)
  ) {
    return null;
  }
  const identity: MediaIdentity = { area: row.area, filename: row.filename };
  try {
    mediaObjectKey(identity);
    return identity;
  } catch {
    return null;
  }
}

function physicalIdentity(row: MediaCatalogRemoteGcRow): MediaIdentity | null {
  const logical = logicalIdentity(row);
  if (!logical || !row.sha256 || !SHA256_PATTERN.test(row.sha256)) return null;
  if (row.remoteFilename) {
    if (
      logical.area === "renders" &&
      row.remoteFilename === logical.filename
    ) {
      return logical;
    }
    const expected = contentAddressedMediaIdentity(logical, row.sha256);
    return row.remoteFilename === expected.filename ? expected : null;
  }
  return logical.area === "renders" ? logical : null;
}

function physicalGroups(
  rows: MediaCatalogRemoteGcRow[],
  skipped: Record<RemoteGcSkipReason, number>,
  diagnostics: RemoteGcDiagnostic[],
): PhysicalGroup[] {
  const groups = new Map<string, PhysicalGroup>();
  const invalidKeys = new Set<string>();
  for (const row of rows) {
    const logical = logicalIdentity(row);
    const physical = physicalIdentity(row);
    if (!physical) {
      if (logical?.area === "stocks" && !row.remoteFilename) {
        skipped.unsupported_legacy_stock++;
      } else {
        skipped.catalog_inconsistent++;
        if (diagnostics.length < 50) {
          diagnostics.push({
            code: "invalid_catalog_identity",
            logicalKey: `${row.area}/${row.filename}`,
          });
        }
      }
      continue;
    }
    const sizeBytes = safeNumber(row.sizeBytes);
    if (!row.sha256 || !SHA256_PATTERN.test(row.sha256) || !sizeBytes || sizeBytes <= 0) {
      skipped.catalog_inconsistent++;
      if (diagnostics.length < 50) {
        diagnostics.push({
          code: "invalid_catalog_size",
          logicalKey: `${row.area}/${row.filename}`,
          physicalKey: mediaObjectKey(physical),
        });
      }
      continue;
    }
    const key = mediaObjectKey(physical);
    if (invalidKeys.has(key)) continue;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        physicalIdentity: physical,
        physicalKey: key,
        sha256: row.sha256,
        sizeBytes,
        rows: [row],
      });
      continue;
    }
    if (existing.sha256 !== row.sha256 || existing.sizeBytes !== sizeBytes) {
      skipped.catalog_inconsistent++;
      if (diagnostics.length < 50) {
        diagnostics.push({
          code: "physical_metadata_mismatch",
          logicalKey: `${row.area}/${row.filename}`,
          physicalKey: key,
        });
      }
      groups.delete(key);
      invalidKeys.add(key);
      continue;
    }
    existing.rows.push(row);
  }
  return [...groups.values()].sort((left, right) =>
    left.physicalKey.localeCompare(right.physicalKey)
  );
}

function recordSha256(records: RemoteGcManifestRecord[]): string {
  const stable = records.map((record) => ({
    action: record.action,
    catalogTransition: record.catalogTransition,
    physicalKey: record.physicalKey,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    logicalKeys: [...record.logicalKeys].sort(),
    reason: record.reason,
    eligibleAt: record.eligibleAt,
    aliases: [...record.aliases].sort((left, right) => left.id.localeCompare(right.id)),
  }));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function claims(rows: MediaCatalogRemoteGcRow[]): MediaCatalogRemoteGcClaim[] {
  return rows
    .map((row) => ({ id: row.id, version: row.version }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function logicalKeys(rows: MediaCatalogRemoteGcRow[]): string[] {
  return [...new Set(rows.map((row) => `${row.area}/${row.filename}`))].sort();
}

function unreferencedRetentionEndsAtMs(row: MediaCatalogRemoteGcRow): number | null {
  const localMtimeMs = safeNumber(row.localMtimeMs);
  const producedAtMs = row.producedAt.getTime();
  const observedAt = localMtimeMs ?? producedAtMs;
  return Number.isFinite(observedAt) ? observedAt + 14 * DAY_MS : null;
}

function isPolicyPending(row: MediaCatalogRemoteGcRow): boolean {
  return row.lastErrorCode === null ||
    row.lastErrorCode === "RemoteGcPending" ||
    row.lastErrorCode === "RemoteGcPending7d";
}

function candidateForGroup(
  group: PhysicalGroup,
  graph: MediaGraph,
  now: Date,
  graceHours: number,
  skipped: Record<RemoteGcSkipReason, number>,
): RemoteGcManifestRecord | null {
  const active = group.rows.filter((row) => row.remoteState !== "deleted");
  if (active.length === 0) return null;
  if (active.some((row) => row.remoteState !== "verified" && row.remoteState !== "delete_pending")) {
    skipped.catalog_busy++;
    return null;
  }
  if (active.some((row) => row.localState !== "evicted")) {
    skipped.local_present++;
    return null;
  }

  let hasReferences = false;
  let becameLive = false;
  let hasIneligibleUnreferenced = false;
  let retentionEndedAtMs = Number.NEGATIVE_INFINITY;
  for (const row of active) {
    const refs = graph.refs.get(`${row.area}/${row.filename}`) ?? [];
    if (refs.length > 0) {
      hasReferences = true;
      if (refs.some((ref) => mediaReferenceIsLive(ref, now))) {
        becameLive = true;
      } else {
        for (const ref of refs) {
          const expiryMs = ref.expiresAt?.getTime() ?? Number.NaN;
          if (!Number.isFinite(expiryMs)) {
            becameLive = true;
            break;
          }
          retentionEndedAtMs = Math.max(retentionEndedAtMs, expiryMs);
        }
      }
    } else {
      const retentionEndsAtMs = unreferencedRetentionEndsAtMs(row);
      if (retentionEndsAtMs === null || retentionEndsAtMs >= now.getTime()) {
        hasIneligibleUnreferenced = true;
      } else {
        retentionEndedAtMs = Math.max(retentionEndedAtMs, retentionEndsAtMs);
      }
    }
  }

  const pending = active.filter((row) => row.remoteState === "delete_pending");
  const verified = active.filter((row) => row.remoteState === "verified");
  if (becameLive || hasIneligibleUnreferenced) {
    if (pending.length === active.length) {
      if (pending.some((row) => row.lastErrorCode === "RemoteGcDeleting")) {
        skipped.catalog_busy++;
        return null;
      }
      return {
        action: "restore",
        catalogTransition: null,
        physicalKey: group.physicalKey,
        sizeBytes: group.sizeBytes,
        sha256: group.sha256,
        logicalKeys: logicalKeys(active),
        reason: becameLive ? "reference_became_live" : "eligibility_changed",
        eligibleAt: null,
        aliases: claims(active),
      };
    }
    if (becameLive) skipped.live_reference++;
    else skipped.unreferenced_grace++;
    return null;
  }
  if (pending.length > 0 && verified.length > 0) {
    skipped.catalog_busy++;
    return null;
  }
  if (!Number.isFinite(retentionEndedAtMs)) {
    skipped.catalog_inconsistent++;
    return null;
  }

  const reason = hasReferences ? "all_references_expired" : "unreferenced_14d";
  const recoveryDeadlineMs = retentionEndedAtMs + graceHours * 60 * 60 * 1000;
  if (pending.length === active.length) {
    const storedEligibleAtMs = Math.max(...pending.map((row) =>
      row.nextRetryAt?.getTime() ?? Number.POSITIVE_INFINITY
    ));
    const policyPending = pending.every(isPolicyPending);
    const eligibleAtMs = policyPending ? recoveryDeadlineMs : storedEligibleAtMs;
    const needsRebase = policyPending && storedEligibleAtMs !== recoveryDeadlineMs;
    if (eligibleAtMs > now.getTime()) {
      if (needsRebase) {
        return {
          action: "stage",
          catalogTransition: "rebase",
          physicalKey: group.physicalKey,
          sizeBytes: group.sizeBytes,
          sha256: group.sha256,
          logicalKeys: logicalKeys(active),
          reason,
          eligibleAt: new Date(eligibleAtMs).toISOString(),
          aliases: claims(active),
        };
      }
      skipped.pending_grace++;
      return null;
    }
    if (!Number.isFinite(eligibleAtMs)) {
      skipped.pending_grace++;
      return null;
    }
    return {
      action: "delete",
      catalogTransition: needsRebase ? "rebase" : null,
      physicalKey: group.physicalKey,
      sizeBytes: group.sizeBytes,
      sha256: group.sha256,
      logicalKeys: logicalKeys(active),
      reason,
      eligibleAt: new Date(eligibleAtMs).toISOString(),
      aliases: claims(active),
    };
  }

  return {
    action: recoveryDeadlineMs <= now.getTime() ? "delete" : "stage",
    catalogTransition: "stage",
    physicalKey: group.physicalKey,
    sizeBytes: group.sizeBytes,
    sha256: group.sha256,
    logicalKeys: logicalKeys(active),
    reason,
    eligibleAt: new Date(recoveryDeadlineMs).toISOString(),
    aliases: claims(active),
  };
}

function remoteIdentityForRecord(record: RemoteGcManifestRecord): MediaIdentity {
  const v2 = /^media\/v2\/(renders|stocks)\/blobs\/[a-f0-9]{2}\/(.+)$/.exec(
    record.physicalKey,
  );
  if (v2) {
    return { area: v2[1] as MediaIdentity["area"], filename: v2[2]! };
  }
  const v1 = /^media\/v1\/(renders|stocks)\/(.+)$/.exec(record.physicalKey);
  if (!v1) throw new Error("invalid remote GC physical key");
  return { area: v1[1] as MediaIdentity["area"], filename: v1[2]! };
}

function applyIsEnabled(env: Record<string, string | undefined>): boolean {
  return (
    env.MEDIA_R2_DELETE === "1" &&
    env.R2_REMOTE_GC_ENABLED === "1" &&
    env.MEDIA_LOCAL_EVICTION === "1" &&
    (env.MEDIA_READ_MODE === "r2-local" || env.MEDIA_READ_MODE === "r2")
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "RemoteGcDeleteFailed";
}

export async function runRemoteMediaGc(
  options: RemoteMediaGcOptions = {},
): Promise<RemoteMediaGcReport> {
  const mode = options.mode ?? "dry-run";
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("invalid remote GC clock");
  const env = options.env ?? process.env;
  if (mode === "apply" && !applyIsEnabled(env)) {
    throw new Error("R2 remote GC apply is blocked by rollout gates");
  }

  const maxObjects = boundedInteger(options.maxObjects, 10, 1, 500);
  const maxBytes = boundedInteger(
    options.maxBytes,
    1024 * 1024 * 1024,
    1,
    50 * 1024 * 1024 * 1024,
  );
  const graceHours = boundedInteger(
    options.graceHours,
    MEDIA_RECOVERY_GRACE_HOURS,
    1,
    30 * 24,
  );
  const catalog = options.catalog ?? new MediaCatalog();
  const remote = options.remote ?? createR2MediaStorageFromEnv(env, "write");
  const graph = options.graph ?? await buildMediaReferenceGraph(now, {
    workspaceRoot: options.cwd,
  });
  if (graph.errors.length > 0) {
    throw new Error(`media graph incomplete: ${graph.errors.length} error(s)`);
  }

  const skipped = emptySkips();
  const diagnostics: RemoteGcDiagnostic[] = [];
  const inventory = await catalog.remoteGcInventory();
  const groups = physicalGroups(inventory, skipped, diagnostics);
  const records: RemoteGcManifestRecord[] = [];
  let eligibleCount = 0;
  let eligibleBytes = 0;
  let selectedBytes = 0;
  for (const group of groups) {
    const candidate = candidateForGroup(group, graph, now, graceHours, skipped);
    if (!candidate) continue;
    if (options.pendingOnly === true && candidate.catalogTransition === "stage") {
      skipped.stage_disabled++;
      continue;
    }
    eligibleCount++;
    eligibleBytes += candidate.sizeBytes;
    if (
      records.length >= maxObjects ||
      selectedBytes + candidate.sizeBytes > maxBytes
    ) {
      skipped.limit++;
      continue;
    }
    records.push(candidate);
    selectedBytes += candidate.sizeBytes;
  }
  const manifestSha256 = recordSha256(records);
  const report: RemoteMediaGcReport = {
    mode,
    generatedAt: now.toISOString(),
    manifestSha256,
    scanned: { aliases: inventory.length, physicalObjects: groups.length },
    eligible: { count: eligibleCount, sizeBytes: eligibleBytes },
    selected: { count: records.length, sizeBytes: selectedBytes },
    staged: { count: 0, sizeBytes: 0 },
    rebased: { count: 0, sizeBytes: 0 },
    deleted: { count: 0, sizeBytes: 0 },
    missingFinalized: { count: 0, sizeBytes: 0 },
    restored: { count: 0, sizeBytes: 0 },
    skipped,
    errors: skipped.catalog_inconsistent,
    diagnostics,
    records,
  };
  if (mode === "dry-run") return report;
  const automated =
    options.automated === true && env.R2_REMOTE_GC_AUTOMATED === "1";
  if (!automated && (
    !options.manifestSha256 ||
    options.manifestSha256 !== manifestSha256 ||
    !SHA256_PATTERN.test(options.manifestSha256)
  )) {
    throw new Error("remote GC manifest SHA-256 approval mismatch");
  }
  if (report.errors > 0) return report;

  // Verify every object that would be newly hidden or restored before making
  // any catalog mutation. Due deletes use remove(), which safely reconciles a
  // missing object after a prior process crashed between R2 and catalog writes.
  for (const record of records) {
    if (record.action === "delete" && record.catalogTransition === null) continue;
    try {
      const verified = await remote.verifyReplica({
        identity: remoteIdentityForRecord(record),
        expectedSizeBytes: record.sizeBytes,
        expectedSha256: record.sha256,
      });
      if (!verified) {
        report.skipped.remote_unverified++;
        report.errors++;
      }
    } catch {
      report.skipped.remote_unverified++;
      report.errors++;
    }
  }
  if (report.errors > 0) return report;

  for (const record of records) {
    if (record.action === "restore") {
      const restored = await catalog.restoreRemoteDeletePending(record.aliases);
      if (restored) {
        report.restored.count++;
        report.restored.sizeBytes += record.sizeBytes;
      } else {
        report.skipped.catalog_changed++;
      }
      continue;
    }
    let preparedClaims = record.aliases;
    if (record.catalogTransition === "stage") {
      const staged = await catalog.stageRemoteDelete(
        record.aliases,
        new Date(record.eligibleAt!),
      );
      if (!staged) {
        report.skipped.catalog_changed++;
        continue;
      }
      preparedClaims = staged;
      report.staged.count++;
      report.staged.sizeBytes += record.sizeBytes;
    } else if (record.catalogTransition === "rebase") {
      const rebased = await catalog.rebaseRemoteDeletePending(
        record.aliases,
        new Date(record.eligibleAt!),
      );
      if (!rebased) {
        report.skipped.catalog_changed++;
        continue;
      }
      preparedClaims = rebased;
      report.rebased.count++;
      report.rebased.sizeBytes += record.sizeBytes;
    }

    if (record.action === "stage") {
      if (record.catalogTransition === null) {
        report.skipped.catalog_changed++;
        report.errors++;
      }
      continue;
    }

    if (record.action !== "delete") {
      report.skipped.catalog_changed++;
      report.errors++;
      continue;
    }

    const claimed = await catalog.claimRemoteDelete(
      preparedClaims,
      now,
      new Date(now.getTime() + DELETE_LEASE_MS),
    );
    if (!claimed) {
      report.skipped.catalog_changed++;
      continue;
    }
    try {
      const removed = await remote.remove({
        identity: remoteIdentityForRecord(record),
        expectedSha256: record.sha256,
      });
      if (removed.status === "checksum_mismatch") {
        report.skipped.checksum_mismatch++;
        report.errors++;
        await catalog.deferRemoteDelete(
          claimed,
          new Date(now.getTime() + DELETE_RETRY_MS),
          "RemoteGcChecksumMismatch",
        );
        continue;
      }
      if (!await catalog.markRemoteDeleted(claimed, now)) {
        report.skipped.catalog_changed++;
        report.errors++;
        continue;
      }
      if (removed.status === "missing") {
        report.missingFinalized.count++;
        report.missingFinalized.sizeBytes += record.sizeBytes;
      } else {
        report.deleted.count++;
        report.deleted.sizeBytes += record.sizeBytes;
      }
    } catch (error) {
      report.skipped.operation_failed++;
      report.errors++;
      await catalog.deferRemoteDelete(
        claimed,
        new Date(now.getTime() + DELETE_RETRY_MS),
        errorName(error),
      );
    }
  }
  return report;
}
