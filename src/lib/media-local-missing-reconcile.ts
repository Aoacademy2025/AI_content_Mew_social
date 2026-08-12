import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  MediaCatalog,
  type MediaCatalogRemoteGcRow,
} from "@/lib/media-catalog";
import { mediaRootPaths } from "@/lib/media-cleanup";
import { buildQuarantinedMediaIndex } from "@/lib/media-quarantine";
import {
  contentAddressedMediaIdentity,
  mediaObjectKey,
  type MediaIdentity,
} from "@/lib/media-storage";
import {
  createR2MediaStorageFromEnv,
  type RemoteMediaReplicaVerifier,
} from "@/lib/media-storage-r2";
import { safeMediaIdentity } from "@/lib/media-storage-support";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type MissingLocalReconcileSkipReason =
  | "not_verified_present"
  | "invalid_catalog"
  | "local_present"
  | "quarantined"
  | "local_stat_error"
  | "limit"
  | "remote_unverified"
  | "catalog_changed";

export type MissingLocalReconcileReport = {
  mode: "dry-run" | "apply";
  generatedAt: string;
  scanned: number;
  eligible: { count: number; sizeBytes: number };
  selected: { count: number; sizeBytes: number };
  reconciled: { count: number; sizeBytes: number };
  skipped: Record<MissingLocalReconcileSkipReason, number>;
  errors: number;
};

type MissingLocalCatalog = Pick<
  MediaCatalog,
  "remoteGcInventory" | "markLocalEvicted"
>;

export type MissingLocalReconcileOptions = {
  mode?: "dry-run" | "apply";
  cwd?: string;
  now?: Date;
  maxObjects?: number;
  maxBytes?: number;
  catalog?: MissingLocalCatalog;
  remote?: RemoteMediaReplicaVerifier;
  env?: Record<string, string | undefined>;
  quarantinedKeys?: ReadonlySet<string>;
};

type Candidate = {
  row: MediaCatalogRemoteGcRow;
  identity: MediaIdentity;
  remoteIdentity: MediaIdentity;
  sizeBytes: number;
  localMtimeMs: number;
  sha256: string;
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

function emptySkips(): Record<MissingLocalReconcileSkipReason, number> {
  return {
    not_verified_present: 0,
    invalid_catalog: 0,
    local_present: 0,
    quarantined: 0,
    local_stat_error: 0,
    limit: 0,
    remote_unverified: 0,
    catalog_changed: 0,
  };
}

function candidateForRow(row: MediaCatalogRemoteGcRow): Candidate | null {
  if (
    row.remoteState !== "verified" ||
    row.localState !== "present" ||
    typeof row.sha256 !== "string" ||
    !SHA256_PATTERN.test(row.sha256)
  ) {
    return null;
  }

  let identity: MediaIdentity;
  try {
    identity = safeMediaIdentity({
      area: row.area as MediaIdentity["area"],
      filename: row.filename,
    });
  } catch {
    return null;
  }
  if (row.objectKey !== mediaObjectKey(identity)) return null;

  const sizeBytes = Number(row.sizeBytes);
  const localMtimeMs = row.localMtimeMs === null
    ? Number.NaN
    : Number(row.localMtimeMs);
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    !Number.isSafeInteger(localMtimeMs) ||
    localMtimeMs < 0
  ) {
    return null;
  }

  let remoteIdentity: MediaIdentity;
  if (row.remoteFilename) {
    const expected = contentAddressedMediaIdentity(identity, row.sha256);
    if (row.remoteFilename !== expected.filename) return null;
    remoteIdentity = expected;
  } else {
    // A legacy render alias was immutable and checksum-verified. Legacy stock
    // aliases were mutable, so a missing local stock can never trust one.
    if (identity.area !== "renders") return null;
    remoteIdentity = identity;
  }

  return {
    row,
    identity,
    remoteIdentity,
    sizeBytes,
    localMtimeMs,
    sha256: row.sha256,
  };
}

async function localPathState(
  absolutePath: string,
): Promise<"missing" | "present" | "unsafe"> {
  try {
    const stat = await lstat(absolutePath);
    return stat.isFile() && !stat.isSymbolicLink() ? "present" : "unsafe";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unsafe";
  }
}

function applyIsEnabled(env: Record<string, string | undefined>): boolean {
  return (
    env.MEDIA_LOCAL_EVICTION === "1" &&
    env.MEDIA_R2_DELETE !== "1" &&
    (env.MEDIA_READ_MODE === "r2-local" || env.MEDIA_READ_MODE === "r2")
  );
}

/**
 * Repairs stale catalog rows left behind when a local file disappeared before
 * the catalog transition completed. No bytes are deleted here: the row moves
 * to `evicted` only after the canonical path is absent, no usable quarantine
 * copy owns it, and the R2 replica matches both size and SHA-256.
 */
export async function reconcileMissingVerifiedLocalMedia(
  options: MissingLocalReconcileOptions = {},
): Promise<MissingLocalReconcileReport> {
  const mode = options.mode ?? "dry-run";
  const env = options.env ?? process.env;
  if (mode === "apply" && !applyIsEnabled(env)) {
    throw new Error("missing local reconciliation is blocked by rollout mode");
  }

  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("invalid missing local reconciliation clock");
  }
  const maxObjects = boundedInteger(options.maxObjects, 100, 1, 500);
  const maxBytes = boundedInteger(
    options.maxBytes,
    10 * 1024 * 1024 * 1024,
    1,
    50 * 1024 * 1024 * 1024,
  );
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const roots = mediaRootPaths(cwd);
  const catalog = options.catalog ?? new MediaCatalog();
  const remote = options.remote ?? createR2MediaStorageFromEnv(env, "read");
  const quarantinedKeys = options.quarantinedKeys ?? new Set(
    (await buildQuarantinedMediaIndex(cwd)).keys(),
  );
  const inventory = await catalog.remoteGcInventory();
  const report: MissingLocalReconcileReport = {
    mode,
    generatedAt: now.toISOString(),
    scanned: inventory.length,
    eligible: { count: 0, sizeBytes: 0 },
    selected: { count: 0, sizeBytes: 0 },
    reconciled: { count: 0, sizeBytes: 0 },
    skipped: emptySkips(),
    errors: 0,
  };
  const selected: Candidate[] = [];

  for (const row of inventory) {
    if (row.remoteState !== "verified" || row.localState !== "present") {
      report.skipped.not_verified_present++;
      continue;
    }
    const candidate = candidateForRow(row);
    if (!candidate) {
      report.skipped.invalid_catalog++;
      continue;
    }
    const key = `${candidate.identity.area}/${candidate.identity.filename}`;
    const absolutePath = path.join(
      roots[candidate.identity.area],
      candidate.identity.filename,
    );
    const state = await localPathState(absolutePath);
    if (state === "present") {
      report.skipped.local_present++;
      continue;
    }
    if (state === "unsafe") {
      report.skipped.local_stat_error++;
      report.errors++;
      continue;
    }
    if (quarantinedKeys.has(key)) {
      report.skipped.quarantined++;
      continue;
    }

    report.eligible.count++;
    report.eligible.sizeBytes += candidate.sizeBytes;
    if (
      selected.length >= maxObjects ||
      report.selected.sizeBytes + candidate.sizeBytes > maxBytes
    ) {
      report.skipped.limit++;
      continue;
    }
    try {
      const verified = await remote.verifyReplica({
        identity: candidate.remoteIdentity,
        expectedSizeBytes: candidate.sizeBytes,
        expectedSha256: candidate.sha256,
      });
      if (!verified) {
        report.skipped.remote_unverified++;
        continue;
      }
    } catch {
      report.skipped.remote_unverified++;
      report.errors++;
      continue;
    }
    selected.push(candidate);
    report.selected.count++;
    report.selected.sizeBytes += candidate.sizeBytes;
  }

  if (mode === "dry-run" || report.errors > 0) return report;

  for (const candidate of selected) {
    const absolutePath = path.join(
      roots[candidate.identity.area],
      candidate.identity.filename,
    );
    if (await localPathState(absolutePath) !== "missing") {
      report.skipped.catalog_changed++;
      continue;
    }
    const changed = await catalog.markLocalEvicted({
      identity: candidate.identity,
      sizeBytes: candidate.sizeBytes,
      localMtimeMs: candidate.localMtimeMs,
      sha256: candidate.sha256,
      remoteFilename: candidate.row.remoteFilename,
    });
    if (!changed) {
      report.skipped.catalog_changed++;
      continue;
    }
    report.reconciled.count++;
    report.reconciled.sizeBytes += candidate.sizeBytes;
  }
  return report;
}
