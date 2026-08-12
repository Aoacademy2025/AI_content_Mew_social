import { createHash } from "node:crypto";
import path from "node:path";
import {
  MediaCatalog,
  type MediaCatalogRemoteIdentityRow,
} from "@/lib/media-catalog";
import {
  buildMediaReferenceGraph,
  type MediaGraph,
} from "@/lib/media-reference-graph";
import { mediaObjectKey, type MediaIdentity } from "@/lib/media-storage";
import {
  MEDIA_RECOVERY_GRACE_HOURS,
  mediaReferenceIsLive,
  type MediaReference,
} from "@/lib/media-retention";
import {
  AwsR2ObjectClient,
  r2StorageConfigFromEnv,
  type R2ObjectClientPort,
  type R2ObjectInventoryPort,
} from "@/lib/media-storage-r2";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DAY_MS = 86_400_000;
export const R2_ORPHAN_RETENTION_DAYS = 21;

type OrphanGcMode = "dry-run" | "apply";
type OrphanGcCatalog = Pick<MediaCatalog, "r2OrphanProtectionInventory">;
type OrphanGcRemote = Pick<R2ObjectClientPort, "head" | "delete"> &
  R2ObjectInventoryPort;

export type R2OrphanGcRecord = {
  key: string;
  sizeBytes: number;
  lastModified: string;
  sha256: string;
  reason: "untracked_21d";
};

export type R2OrphanGcSkipReason =
  | "tracked"
  | "too_young"
  | "referenced_legacy"
  | "invalid_key"
  | "remote_unverified"
  | "remote_changed"
  | "limit"
  | "operation_failed";

export type R2OrphanGcReport = {
  mode: OrphanGcMode;
  generatedAt: string;
  manifestSha256: string;
  scanned: { objects: number; sizeBytes: number };
  eligible: { count: number; sizeBytes: number };
  selected: { count: number; sizeBytes: number };
  deleted: { count: number; sizeBytes: number };
  skipped: Record<R2OrphanGcSkipReason, number>;
  errors: number;
  records: R2OrphanGcRecord[];
};

export type R2OrphanGcOptions = {
  mode?: OrphanGcMode;
  automated?: boolean;
  manifestSha256?: string;
  maxObjects?: number;
  maxBytes?: number;
  now?: Date;
  cwd?: string;
  env?: Record<string, string | undefined>;
  catalog?: OrphanGcCatalog;
  remote?: OrphanGcRemote;
  graph?: MediaGraph;
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

function emptySkips(): Record<R2OrphanGcSkipReason, number> {
  return {
    tracked: 0,
    too_young: 0,
    referenced_legacy: 0,
    invalid_key: 0,
    remote_unverified: 0,
    remote_changed: 0,
    limit: 0,
    operation_failed: 0,
  };
}

function physicalKey(area: string, filename: string): string | null {
  if (
    (area !== "renders" && area !== "stocks") ||
    !filename ||
    filename !== path.basename(filename)
  ) {
    return null;
  }
  try {
    return mediaObjectKey({ area, filename });
  } catch {
    return null;
  }
}

function activeCatalogKeys(rows: MediaCatalogRemoteIdentityRow[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.remoteState === "deleted") continue;
    const filename = row.remoteFilename ?? (
      row.area === "renders" &&
      (row.remoteState === "verified" || row.remoteState === "delete_pending")
        ? row.filename
        : null
    );
    if (!filename) continue;
    const key = physicalKey(row.area, filename);
    if (!key) throw new Error("invalid active catalog R2 identity");
    keys.add(key);
  }
  return keys;
}

function identityFromKey(key: string): { identity: MediaIdentity; legacy: boolean } | null {
  const v1 = /^media\/v1\/(renders|stocks)\/([^/]+)$/.exec(key);
  if (v1) {
    const identity = { area: v1[1] as MediaIdentity["area"], filename: v1[2]! };
    return physicalKey(identity.area, identity.filename) === key
      ? { identity, legacy: true }
      : null;
  }
  const v2 = /^media\/v2\/(renders|stocks)\/blobs\/[a-f0-9]{2}\/([^/]+)$/.exec(key);
  if (!v2) return null;
  const identity = { area: v2[1] as MediaIdentity["area"], filename: v2[2]! };
  return physicalKey(identity.area, identity.filename) === key
    ? { identity, legacy: false }
    : null;
}

function manifestSha256(records: R2OrphanGcRecord[]): string {
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

function applyEnabled(env: Record<string, string | undefined>): boolean {
  return env.MEDIA_R2_DELETE === "1" &&
    env.MEDIA_R2_ORPHAN_DELETE === "1" &&
    env.R2_REMOTE_GC_ENABLED === "1" &&
    (env.MEDIA_READ_MODE === "r2-local" || env.MEDIA_READ_MODE === "r2");
}

function verifiedShaForKey(key: string, sha256: string | null): string | null {
  if (!sha256 || !SHA256_PATTERN.test(sha256)) return null;
  const encoded = /^media\/v2\/(?:renders|stocks)\/blobs\/[a-f0-9]{2}\/sha256-([a-f0-9]{64})\./
    .exec(key)?.[1];
  return encoded && encoded !== sha256 ? null : sha256;
}

function legacyReferencesProtect(
  refs: MediaReference[],
  now: Date,
): boolean {
  if (refs.length === 0) return false;
  if (refs.some((ref) => mediaReferenceIsLive(ref, now))) return true;
  const latestExpiryMs = Math.max(...refs.map((ref) =>
    ref.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY
  ));
  return !Number.isFinite(latestExpiryMs) ||
    latestExpiryMs + MEDIA_RECOVERY_GRACE_HOURS * 3_600_000 > now.getTime();
}

export async function runR2OrphanGc(
  options: R2OrphanGcOptions = {},
): Promise<R2OrphanGcReport> {
  const mode = options.mode ?? "dry-run";
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("invalid R2 orphan GC clock");
  const env = options.env ?? process.env;
  if (mode === "apply" && !applyEnabled(env)) {
    throw new Error("R2 orphan GC apply is blocked by rollout gates");
  }
  const maxObjects = boundedInteger(options.maxObjects, 10, 1, 500);
  const maxBytes = boundedInteger(
    options.maxBytes,
    1024 * 1024 * 1024,
    1,
    50 * 1024 * 1024 * 1024,
  );
  const catalog = options.catalog ?? new MediaCatalog();
  const config = options.remote ? null : r2StorageConfigFromEnv(env, "write");
  const remote = options.remote ?? new AwsR2ObjectClient(config!);
  const graph = options.graph ?? await buildMediaReferenceGraph(now, {
    workspaceRoot: options.cwd,
  });
  if (graph.errors.length > 0) {
    throw new Error(`media graph incomplete: ${graph.errors.length} error(s)`);
  }
  const catalogKeys = activeCatalogKeys(await catalog.r2OrphanProtectionInventory());
  const skipped = emptySkips();
  const candidates: Array<{
    key: string;
    sizeBytes: number;
    lastModified: Date;
  }> = [];
  let scannedObjects = 0;
  let scannedBytes = 0;
  const seenTokens = new Set<string>();
  let token: string | undefined;
  do {
    const page = await remote.list("media/", token);
    for (const object of page.objects) {
      scannedObjects++;
      scannedBytes += object.sizeBytes;
      if (catalogKeys.has(object.key)) {
        skipped.tracked++;
        continue;
      }
      const parsed = identityFromKey(object.key);
      if (!parsed || object.sizeBytes <= 0 || !Number.isFinite(object.lastModified.getTime())) {
        skipped.invalid_key++;
        continue;
      }
      if (parsed.legacy) {
        const logicalKey = `${parsed.identity.area}/${parsed.identity.filename}`;
        if (legacyReferencesProtect(graph.refs.get(logicalKey) ?? [], now)) {
          skipped.referenced_legacy++;
          continue;
        }
      }
      if (
        object.lastModified.getTime() >
        now.getTime() - R2_ORPHAN_RETENTION_DAYS * DAY_MS
      ) {
        skipped.too_young++;
        continue;
      }
      candidates.push(object);
    }
    token = page.continuationToken ?? undefined;
    if (token && seenTokens.has(token)) throw new Error("R2 inventory token loop");
    if (token) seenTokens.add(token);
  } while (token);

  candidates.sort((left, right) =>
    left.lastModified.getTime() - right.lastModified.getTime() ||
    left.key.localeCompare(right.key)
  );
  const records: R2OrphanGcRecord[] = [];
  let eligibleBytes = 0;
  let selectedBytes = 0;
  for (const candidate of candidates) {
    eligibleBytes += candidate.sizeBytes;
    if (
      records.length >= maxObjects ||
      selectedBytes + candidate.sizeBytes > maxBytes
    ) {
      skipped.limit++;
      continue;
    }
    try {
      const head = await remote.head(candidate.key);
      const sha256 = verifiedShaForKey(candidate.key, head?.sha256 ?? null);
      if (
        !head ||
        !sha256 ||
        head.sizeBytes !== candidate.sizeBytes ||
        head.lastModified.getTime() !== candidate.lastModified.getTime()
      ) {
        skipped.remote_unverified++;
        continue;
      }
      records.push({
        key: candidate.key,
        sizeBytes: candidate.sizeBytes,
        lastModified: candidate.lastModified.toISOString(),
        sha256,
        reason: "untracked_21d",
      });
      selectedBytes += candidate.sizeBytes;
    } catch {
      skipped.remote_unverified++;
    }
  }

  const hash = manifestSha256(records);
  const report: R2OrphanGcReport = {
    mode,
    generatedAt: now.toISOString(),
    manifestSha256: hash,
    scanned: { objects: scannedObjects, sizeBytes: scannedBytes },
    eligible: { count: candidates.length, sizeBytes: eligibleBytes },
    selected: { count: records.length, sizeBytes: selectedBytes },
    deleted: { count: 0, sizeBytes: 0 },
    skipped,
    errors: skipped.invalid_key + skipped.remote_unverified,
    records,
  };
  if (mode === "dry-run") return report;
  const automated = options.automated === true && env.R2_ORPHAN_GC_AUTOMATED === "1";
  if (!automated && (
    !options.manifestSha256 ||
    options.manifestSha256 !== hash ||
    !SHA256_PATTERN.test(options.manifestSha256)
  )) {
    throw new Error("R2 orphan GC manifest SHA-256 approval mismatch");
  }
  if (report.errors > 0) return report;

  for (const record of records) {
    try {
      const head = await remote.head(record.key);
      const sha256 = verifiedShaForKey(record.key, head?.sha256 ?? null);
      if (
        !head ||
        sha256 !== record.sha256 ||
        head.sizeBytes !== record.sizeBytes ||
        head.lastModified.toISOString() !== record.lastModified
      ) {
        report.skipped.remote_changed++;
        report.errors++;
        continue;
      }
      await remote.delete(record.key);
      if (await remote.head(record.key)) {
        report.skipped.operation_failed++;
        report.errors++;
        continue;
      }
      report.deleted.count++;
      report.deleted.sizeBytes += record.sizeBytes;
    } catch {
      report.skipped.operation_failed++;
      report.errors++;
    }
  }
  return report;
}
