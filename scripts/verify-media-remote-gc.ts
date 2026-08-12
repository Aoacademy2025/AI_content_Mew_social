import assert from "node:assert/strict";
import {
  contentAddressedMediaIdentity,
  mediaObjectKey,
  type MediaIdentity,
  type MediaRemoveResult,
} from "../src/lib/media-storage";
import type {
  MediaCatalogRemoteGcClaim,
  MediaCatalogRemoteGcRow,
} from "../src/lib/media-catalog";
import type { MediaGraph } from "../src/lib/media-reference-graph";

const NOW = new Date("2026-07-30T12:00:00.000Z");
const DAY_MS = 86_400_000;
const APPLY_ENV = {
  MEDIA_R2_DELETE: "1",
  R2_REMOTE_GC_ENABLED: "1",
  MEDIA_LOCAL_EVICTION: "1",
  MEDIA_READ_MODE: "r2-local",
};
let runRemoteMediaGc: typeof import("../src/lib/media-remote-gc")["runRemoteMediaGc"];

function graph(refs: MediaGraph["refs"] = new Map()): MediaGraph {
  return {
    refs,
    errors: [],
    scannedOwners: {
      video: 0,
      "video-job": 0,
      "project-draft": 0,
      "render-job": 0,
      "generated-image": 0,
      "ai-generation-job": 0,
    },
  };
}

function reference(expiresAt: Date) {
  return {
    ownerKind: "video" as const,
    ownerId: `owner-${expiresAt.toISOString()}`,
    expiresAt,
  };
}

let sequence = 0;
function row(input: {
  filename: string;
  sha256: string;
  area?: "renders" | "stocks";
  remoteFilename?: string | null;
  localState?: string;
  remoteState?: string;
  mtime?: Date;
  sizeBytes?: number;
}): MediaCatalogRemoteGcRow {
  const area = input.area ?? "renders";
  const identity = { area, filename: input.filename };
  const mtime = input.mtime ?? new Date(NOW.getTime() - 20 * DAY_MS);
  return {
    id: `row-${++sequence}`,
    area,
    filename: input.filename,
    objectKey: mediaObjectKey(identity),
    sizeBytes: BigInt(input.sizeBytes ?? 100),
    sha256: input.sha256,
    remoteFilename: input.remoteFilename === undefined
      ? contentAddressedMediaIdentity(identity, input.sha256).filename
      : input.remoteFilename,
    remoteState: input.remoteState ?? "verified",
    localState: input.localState ?? "evicted",
    localMtimeMs: BigInt(mtime.getTime()),
    producedAt: mtime,
    nextRetryAt: null,
    lastErrorCode: null,
    version: 0,
  };
}

class FakeCatalog {
  readonly rows: MediaCatalogRemoteGcRow[];

  constructor(rows: MediaCatalogRemoteGcRow[]) {
    this.rows = rows;
  }

  async remoteGcInventory(): Promise<MediaCatalogRemoteGcRow[]> {
    return this.rows.map((item) => ({ ...item }));
  }

  private matching(claim: MediaCatalogRemoteGcClaim): MediaCatalogRemoteGcRow | null {
    const found = this.rows.find((item) =>
      item.id === claim.id && item.version === claim.version
    );
    return found ?? null;
  }

  async stageRemoteDelete(
    claims: readonly MediaCatalogRemoteGcClaim[],
    eligibleAt: Date,
  ): Promise<MediaCatalogRemoteGcClaim[] | null> {
    const rows = claims.map((claim) => this.matching(claim));
    if (rows.some((item) =>
      !item || item.remoteState !== "verified" || item.localState !== "evicted"
    )) {
      return null;
    }
    return rows.map((item) => {
      item!.remoteState = "delete_pending";
      item!.nextRetryAt = eligibleAt;
      item!.lastErrorCode = "RemoteGcPending";
      item!.version++;
      return { id: item!.id, version: item!.version };
    });
  }

  async claimRemoteDelete(
    claims: readonly MediaCatalogRemoteGcClaim[],
    now: Date,
    leaseUntil: Date,
  ): Promise<MediaCatalogRemoteGcClaim[] | null> {
    const rows = claims.map((claim) => this.matching(claim));
    if (rows.some((item) =>
      !item ||
      item.remoteState !== "delete_pending" ||
      item.localState !== "evicted" ||
      !item.nextRetryAt ||
      item.nextRetryAt > now
    )) {
      return null;
    }
    return rows.map((item) => {
      item!.nextRetryAt = leaseUntil;
      item!.lastErrorCode = "RemoteGcDeleting";
      item!.version++;
      return { id: item!.id, version: item!.version };
    });
  }

  async markRemoteDeleted(
    claims: readonly MediaCatalogRemoteGcClaim[],
    _now: Date,
  ): Promise<boolean> {
    const rows = claims.map((claim) => this.matching(claim));
    if (rows.some((item) =>
      !item ||
      item.remoteState !== "delete_pending" ||
      item.lastErrorCode !== "RemoteGcDeleting"
    )) {
      return false;
    }
    for (const item of rows) {
      item!.remoteState = "deleted";
      item!.nextRetryAt = null;
      item!.lastErrorCode = "RemoteGcDeleted";
      item!.version++;
    }
    return true;
  }

  async deferRemoteDelete(
    claims: readonly MediaCatalogRemoteGcClaim[],
    retryAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    const rows = claims.map((claim) => this.matching(claim));
    if (rows.some((item) => !item)) return false;
    for (const item of rows) {
      item!.nextRetryAt = retryAt;
      item!.lastErrorCode = errorCode;
      item!.version++;
    }
    return true;
  }

  async restoreRemoteDeletePending(
    claims: readonly MediaCatalogRemoteGcClaim[],
  ): Promise<boolean> {
    const rows = claims.map((claim) => this.matching(claim));
    if (rows.some((item) => !item || item.remoteState !== "delete_pending")) {
      return false;
    }
    for (const item of rows) {
      item!.remoteState = "verified";
      item!.nextRetryAt = null;
      item!.lastErrorCode = null;
      item!.version++;
    }
    return true;
  }
}

class FakeRemote {
  readonly objects = new Map<string, { sha256: string; sizeBytes: number }>();

  add(row: MediaCatalogRemoteGcRow): void {
    if (!row.sha256) return;
    const identity = row.remoteFilename
      ? { area: row.area as MediaIdentity["area"], filename: row.remoteFilename }
      : { area: row.area as MediaIdentity["area"], filename: row.filename };
    this.objects.set(mediaObjectKey(identity), {
      sha256: row.sha256,
      sizeBytes: Number(row.sizeBytes),
    });
  }

  async verifyReplica(input: {
    identity: MediaIdentity;
    expectedSizeBytes: number;
    expectedSha256: string;
  }): Promise<boolean> {
    const found = this.objects.get(mediaObjectKey(input.identity));
    return Boolean(
      found &&
      found.sizeBytes === input.expectedSizeBytes &&
      found.sha256 === input.expectedSha256,
    );
  }

  async remove(input: {
    identity: MediaIdentity;
    expectedSha256: string;
  }): Promise<MediaRemoveResult> {
    const key = mediaObjectKey(input.identity);
    const found = this.objects.get(key);
    if (!found) return { status: "missing" };
    if (found.sha256 !== input.expectedSha256) {
      return { status: "checksum_mismatch", actualSha256: found.sha256 };
    }
    this.objects.delete(key);
    return { status: "deleted" };
  }
}

async function stageAndDelete(): Promise<void> {
  const expired = row({ filename: "expired.mp4", sha256: "a".repeat(64) });
  const orphan = row({ filename: "orphan.mp4", sha256: "b".repeat(64) });
  const live = row({ filename: "live.mp4", sha256: "c".repeat(64) });
  const local = row({
    filename: "local.mp4",
    sha256: "d".repeat(64),
    localState: "present",
  });
  const legacyLocal = row({
    filename: "legacy-local.mp4",
    sha256: "2".repeat(64),
    remoteFilename: "legacy-local.mp4",
    localState: "present",
  });
  const sharedExpired = row({
    filename: "shared-expired.mp4",
    sha256: "e".repeat(64),
  });
  const sharedLive = row({
    filename: "shared-live.mp4",
    sha256: "e".repeat(64),
  });
  const young = row({
    filename: "young.mp4",
    sha256: "f".repeat(64),
    mtime: new Date(NOW.getTime() - DAY_MS),
  });
  const legacyStock = row({
    area: "stocks",
    filename: "legacy.mp4",
    sha256: "1".repeat(64),
    remoteFilename: null,
  });
  const rows = [
    expired,
    orphan,
    live,
    local,
    legacyLocal,
    sharedExpired,
    sharedLive,
    young,
    legacyStock,
  ];
  const catalog = new FakeCatalog(rows);
  const remote = new FakeRemote();
  for (const item of rows) remote.add(item);
  const refs: MediaGraph["refs"] = new Map([
    ["renders/expired.mp4", [reference(new Date(NOW.getTime() - DAY_MS))]],
    ["renders/live.mp4", [reference(new Date(NOW.getTime() + DAY_MS))]],
    ["renders/shared-expired.mp4", [reference(new Date(NOW.getTime() - DAY_MS))]],
    ["renders/shared-live.mp4", [reference(new Date(NOW.getTime() + DAY_MS))]],
  ]);

  const dryRun = await runRemoteMediaGc({
    now: NOW,
    graph: graph(refs),
    catalog,
    remote,
    maxObjects: 20,
    maxBytes: 10_000,
  });
  assert.equal(dryRun.selected.count, 2, "only expired and old orphan objects stage");
  assert.deepEqual(
    dryRun.records.map((record) => record.physicalKey),
    [expired, orphan].map((item) =>
      mediaObjectKey({
        area: item.area as MediaIdentity["area"],
        filename: item.remoteFilename!,
      })
    ).sort(),
  );
  assert.equal(dryRun.skipped.live_reference, 2);
  assert.equal(dryRun.skipped.local_present, 2);
  assert.equal(dryRun.skipped.unreferenced_grace, 1);
  assert.equal(dryRun.skipped.unsupported_legacy_stock, 1);
  assert.equal(dryRun.errors, 0);

  await assert.rejects(
    runRemoteMediaGc({
      mode: "apply",
      now: NOW,
      graph: graph(refs),
      catalog,
      remote,
      maxObjects: 20,
      maxBytes: 10_000,
      manifestSha256: "0".repeat(64),
      env: APPLY_ENV,
    }),
    /manifest SHA-256 approval mismatch/,
  );
  const staged = await runRemoteMediaGc({
    mode: "apply",
    now: NOW,
    graph: graph(refs),
    catalog,
    remote,
    maxObjects: 20,
    maxBytes: 10_000,
    manifestSha256: dryRun.manifestSha256,
    env: APPLY_ENV,
  });
  assert.equal(staged.staged.count, 2);
  assert.equal(expired.remoteState, "delete_pending");
  assert.equal(orphan.remoteState, "delete_pending");
  const recoveryDeadline = new Date(NOW.getTime() + 7 * DAY_MS);
  assert.equal(
    expired.nextRetryAt?.toISOString(),
    recoveryDeadline.toISOString(),
    "expired media remains recoverable in R2 for seven days before physical deletion",
  );

  const beforeRecoveryDeadline = await runRemoteMediaGc({
    now: new Date(NOW.getTime() + 25 * 60 * 60 * 1000),
    graph: graph(refs),
    catalog,
    remote,
    pendingOnly: true,
    maxObjects: 20,
    maxBytes: 10_000,
  });
  assert.equal(beforeRecoveryDeadline.selected.count, 0);
  assert.equal(beforeRecoveryDeadline.skipped.pending_grace, 2);

  const dueAt = new Date(recoveryDeadline.getTime() + 60 * 60 * 1000);
  const due = await runRemoteMediaGc({
    now: dueAt,
    graph: graph(refs),
    catalog,
    remote,
    pendingOnly: true,
    maxObjects: 20,
    maxBytes: 10_000,
  });
  assert.equal(due.records.filter((record) => record.action === "delete").length, 2);

  // Reconcile one object as already absent, covering a crash after R2 delete.
  remote.objects.delete(orphan.remoteFilename
    ? mediaObjectKey({
        area: orphan.area as MediaIdentity["area"],
        filename: orphan.remoteFilename,
      })
    : orphan.objectKey);
  const deleted = await runRemoteMediaGc({
    mode: "apply",
    now: dueAt,
    graph: graph(refs),
    catalog,
    remote,
    pendingOnly: true,
    maxObjects: 20,
    maxBytes: 10_000,
    manifestSha256: due.manifestSha256,
    env: APPLY_ENV,
  });
  assert.equal(deleted.deleted.count, 1);
  assert.equal(deleted.missingFinalized.count, 1);
  assert.equal(expired.remoteState, "deleted");
  assert.equal(orphan.remoteState, "deleted");
}

async function restoreWhenReferenceBecomesLive(): Promise<void> {
  const candidate = row({ filename: "restore.mp4", sha256: "9".repeat(64) });
  const catalog = new FakeCatalog([candidate]);
  const remote = new FakeRemote();
  remote.add(candidate);
  const expiredRefs: MediaGraph["refs"] = new Map([
    ["renders/restore.mp4", [reference(new Date(NOW.getTime() - DAY_MS))]],
  ]);
  const dry = await runRemoteMediaGc({
    now: NOW,
    graph: graph(expiredRefs),
    catalog,
    remote,
  });
  await runRemoteMediaGc({
    mode: "apply",
    now: NOW,
    graph: graph(expiredRefs),
    catalog,
    remote,
    manifestSha256: dry.manifestSha256,
    env: APPLY_ENV,
  });
  assert.equal(candidate.remoteState, "delete_pending");

  const liveRefs: MediaGraph["refs"] = new Map([
    ["renders/restore.mp4", [reference(new Date(NOW.getTime() + DAY_MS))]],
  ]);
  const restore = await runRemoteMediaGc({
    now: new Date(NOW.getTime() + 60_000),
    graph: graph(liveRefs),
    catalog,
    remote,
  });
  assert.equal(restore.records[0]?.action, "restore");
  const restored = await runRemoteMediaGc({
    mode: "apply",
    now: new Date(NOW.getTime() + 60_000),
    graph: graph(liveRefs),
    catalog,
    remote,
    manifestSha256: restore.manifestSha256,
    env: APPLY_ENV,
  });
  assert.equal(restored.restored.count, 1);
  assert.equal(candidate.remoteState, "verified");
}

async function main(): Promise<void> {
  process.env.DATABASE_URL = "file::memory:";
  ({ runRemoteMediaGc } = await import("../src/lib/media-remote-gc"));
  await assert.rejects(
    runRemoteMediaGc({
      mode: "apply",
      now: NOW,
      graph: graph(),
      catalog: new FakeCatalog([]),
      remote: new FakeRemote(),
      manifestSha256: "0".repeat(64),
      env: {},
    }),
    /blocked by rollout gates/,
  );
  await stageAndDelete();
  await restoreWhenReferenceBecomesLive();
  console.log("PASS R2 remote GC dry-run, manifest gate, grace, delete, and restore");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
