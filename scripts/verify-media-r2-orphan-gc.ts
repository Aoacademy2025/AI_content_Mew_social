import assert from "node:assert/strict";
import { mediaObjectKey, type MediaIdentity } from "../src/lib/media-storage";
import type {
  MediaCatalogRemoteGcRow,
  MediaCatalogRemoteIdentityRow,
} from "../src/lib/media-catalog";
import type { MediaGraph } from "../src/lib/media-reference-graph";
import type {
  R2ListedObject,
  R2ObjectHead,
  R2ObjectPage,
} from "../src/lib/media-storage-r2";

const NOW = new Date("2026-08-13T00:00:00.000Z");
const DAY_MS = 86_400_000;
const APPLY_ENV = {
  MEDIA_R2_DELETE: "1",
  MEDIA_R2_ORPHAN_DELETE: "1",
  R2_REMOTE_GC_ENABLED: "1",
  MEDIA_READ_MODE: "r2-local",
};
let runR2OrphanGc: typeof import("../src/lib/media-r2-orphan-gc")["runR2OrphanGc"];

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

function catalogRow(identity: MediaIdentity, sha256: string): MediaCatalogRemoteGcRow {
  return {
    id: `row-${identity.filename}`,
    area: identity.area,
    filename: identity.filename,
    objectKey: mediaObjectKey(identity),
    sizeBytes: BigInt(100),
    sha256,
    remoteFilename: identity.filename,
    remoteState: "verified",
    localState: "evicted",
    localMtimeMs: BigInt(NOW.getTime() - 30 * DAY_MS),
    producedAt: new Date(NOW.getTime() - 30 * DAY_MS),
    nextRetryAt: null,
    lastErrorCode: null,
    version: 0,
  };
}

class FakeCatalog {
  constructor(private readonly rows: MediaCatalogRemoteGcRow[]) {}

  async r2OrphanProtectionInventory(): Promise<MediaCatalogRemoteIdentityRow[]> {
    return this.rows.map((row) => ({
      area: row.area,
      filename: row.filename,
      remoteFilename: row.remoteFilename,
      remoteState: row.remoteState,
    }));
  }
}

class FakeRemote {
  readonly objects = new Map<string, R2ObjectHead>();
  listTimestampOffsetMs = 0;

  add(
    identity: MediaIdentity,
    sha256: string,
    ageDays: number,
    sizeBytes = 100,
  ): string {
    const key = mediaObjectKey(identity);
    this.objects.set(key, {
      sizeBytes,
      contentType: "video/mp4",
      lastModified: new Date(NOW.getTime() - ageDays * DAY_MS),
      sha256,
      etag: null,
    });
    return key;
  }

  async list(_prefix: string, _token?: string): Promise<R2ObjectPage> {
    const objects: R2ListedObject[] = [...this.objects].map(([key, value]) => ({
      key,
      sizeBytes: value.sizeBytes,
      lastModified: new Date(value.lastModified.getTime() + this.listTimestampOffsetMs),
    }));
    return { objects, continuationToken: null };
  }

  async head(key: string): Promise<R2ObjectHead | null> {
    const value = this.objects.get(key);
    return value ? { ...value } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

async function toleratesR2TimestampPrecision(): Promise<void> {
  const remote = new FakeRemote();
  remote.listTimestampOffsetMs = 101;
  const identity: MediaIdentity = { area: "renders", filename: "timestamp-skew.mp4" };
  remote.add(identity, "9".repeat(64), 30, 123);

  const dry = await runR2OrphanGc({
    now: NOW,
    graph: graph(),
    catalog: new FakeCatalog([]),
    remote,
  });
  assert.equal(dry.selected.count, 1, "sub-second LIST/HEAD timestamp skew remains verifiable");
  assert.equal(dry.skipped.remote_unverified, 0);
  assert.equal(dry.errors, 0);

  const applied = await runR2OrphanGc({
    mode: "apply",
    now: NOW,
    graph: graph(),
    catalog: new FakeCatalog([]),
    remote,
    manifestSha256: dry.manifestSha256,
    env: APPLY_ENV,
  });
  assert.equal(applied.deleted.count, 1, "apply uses the same safe timestamp precision rule");

  const changed = new FakeRemote();
  changed.listTimestampOffsetMs = 1_100;
  changed.add({ area: "renders", filename: "timestamp-changed.mp4" }, "8".repeat(64), 30);
  const rejected = await runR2OrphanGc({
    now: NOW,
    graph: graph(),
    catalog: new FakeCatalog([]),
    remote: changed,
  });
  assert.equal(rejected.selected.count, 0, "cross-second timestamp changes still fail closed");
  assert.equal(rejected.skipped.remote_unverified, 1);
}

async function boundedDeletion(): Promise<void> {
  const trackedIdentity: MediaIdentity = { area: "renders", filename: "tracked.mp4" };
  const trackedSha = "a".repeat(64);
  const catalog = new FakeCatalog([catalogRow(trackedIdentity, trackedSha)]);
  const remote = new FakeRemote();
  remote.add(trackedIdentity, trackedSha, 30);
  const oldLegacy: MediaIdentity = { area: "renders", filename: "old-orphan.mp4" };
  const oldLegacyKey = remote.add(oldLegacy, "b".repeat(64), 22, 200);
  const oldV2: MediaIdentity = {
    area: "stocks",
    filename: `sha256-${"c".repeat(64)}.mp4`,
  };
  const oldV2Key = remote.add(oldV2, "c".repeat(64), 30, 300);
  remote.add({ area: "stocks", filename: "young.mp4" }, "d".repeat(64), 20);
  const referenced: MediaIdentity = { area: "renders", filename: "referenced.mp4" };
  remote.add(referenced, "e".repeat(64), 30);
  const expiredReferenced: MediaIdentity = {
    area: "renders",
    filename: "expired-referenced.mp4",
  };
  const expiredReferencedKey = remote.add(expiredReferenced, "f".repeat(64), 30, 400);
  const refs: MediaGraph["refs"] = new Map([
    ["renders/referenced.mp4", [{
      ownerKind: "video",
      ownerId: "owner-1",
      expiresAt: new Date(NOW.getTime() - DAY_MS),
    }]],
    ["renders/expired-referenced.mp4", [{
      ownerKind: "video",
      ownerId: "owner-2",
      expiresAt: new Date(NOW.getTime() - 30 * DAY_MS),
    }]],
  ]);

  const dry = await runR2OrphanGc({
    now: NOW,
    graph: graph(refs),
    catalog,
    remote,
    maxObjects: 10,
    maxBytes: 10_000,
  });
  assert.deepEqual(
    dry.records.map((record) => record.key),
    [expiredReferencedKey, oldV2Key, oldLegacyKey],
  );
  assert.equal(dry.skipped.tracked, 1);
  assert.equal(dry.skipped.too_young, 1);
  assert.equal(dry.skipped.referenced_legacy, 1);
  assert.equal(dry.errors, 0);

  await assert.rejects(
    runR2OrphanGc({
      mode: "apply",
      now: NOW,
      graph: graph(refs),
      catalog,
      remote,
      maxObjects: 10,
      maxBytes: 10_000,
      manifestSha256: "0".repeat(64),
      env: APPLY_ENV,
    }),
    /manifest SHA-256 approval mismatch/,
  );
  const applied = await runR2OrphanGc({
    mode: "apply",
    now: NOW,
    graph: graph(refs),
    catalog,
    remote,
    maxObjects: 10,
    maxBytes: 10_000,
    manifestSha256: dry.manifestSha256,
    env: APPLY_ENV,
  });
  assert.equal(applied.deleted.count, 3);
  assert.equal(remote.objects.has(oldLegacyKey), false);
  assert.equal(remote.objects.has(oldV2Key), false);
  assert.equal(remote.objects.has(expiredReferencedKey), false);
  assert.equal(remote.objects.has(mediaObjectKey(trackedIdentity)), true);
}

async function failClosed(): Promise<void> {
  const remote = new FakeRemote();
  const invalidV2: MediaIdentity = {
    area: "renders",
    filename: `sha256-${"f".repeat(64)}.mp4`,
  };
  remote.add(invalidV2, "1".repeat(64), 30);
  const dry = await runR2OrphanGc({
    now: NOW,
    graph: graph(),
    catalog: new FakeCatalog([]),
    remote,
  });
  assert.equal(dry.selected.count, 0);
  assert.equal(dry.skipped.remote_unverified, 1);
  assert.equal(dry.errors, 1);

  await assert.rejects(
    runR2OrphanGc({
      mode: "apply",
      now: NOW,
      graph: graph(),
      catalog: new FakeCatalog([]),
      remote,
      manifestSha256: "0".repeat(64),
      env: {},
    }),
    /blocked by rollout gates/,
  );
}

async function main(): Promise<void> {
  process.env.DATABASE_URL = "file::memory:";
  ({ runR2OrphanGc } = await import("../src/lib/media-r2-orphan-gc"));
  await boundedDeletion();
  await failClosed();
  await toleratesR2TimestampPrecision();
  console.log("PASS R2 orphan GC 21-day retention, reference guard, manifest, and SHA gates");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
