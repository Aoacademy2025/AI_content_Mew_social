// Verifies the nightly DB backup's R2 off-box copy (Task C9): upload shape,
// same-day-rerun content verification (size/sha256, not just key existence),
// prefix-scoped pruning (incl. multi-page listings), the "not configured"
// skip, and the upload-failure contract (local file kept, non-zero exit).
// Uses the team's temp-fixture + injected-fake-client pattern (see
// scripts/verify-media-storage-r2.ts).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BACKUP_R2_PREFIX,
  backupObjectKey,
  backupR2ConfigFromEnv,
  pruneBackupObjects,
  uploadBackupSnapshot,
  type BackupR2Client,
} from "../src/lib/backup-r2";
import type { R2ObjectHead, R2ObjectPage, R2PutResult } from "../src/lib/media-storage-r2";

type FakeRecord = { bytes: Uint8Array; head: R2ObjectHead };

class FakeBackupR2Client implements BackupR2Client {
  readonly records = new Map<string, FakeRecord>();
  readonly deleted: string[] = [];
  failNextPut = false;

  async head(key: string): Promise<R2ObjectHead | null> {
    const record = this.records.get(key);
    return record ? { ...record.head } : null;
  }

  async put(input: {
    key: string;
    sourcePath: string;
    sizeBytes: number;
    contentType: string;
    sha256: string;
    contentMd5Base64: string;
  }): Promise<R2PutResult> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("simulated network failure");
    }
    if (this.records.has(input.key)) return "precondition_failed";
    const bytes = new Uint8Array(await readFile(input.sourcePath));
    this.records.set(input.key, {
      bytes,
      head: {
        sizeBytes: input.sizeBytes,
        contentType: input.contentType,
        lastModified: new Date(),
        sha256: input.sha256,
        etag: '"fake-etag"',
      },
    });
    return "created";
  }

  async get(): Promise<{ body: ReadableStream<Uint8Array>; contentLength: number }> {
    throw new Error("not used by backup upload/prune");
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
    this.deleted.push(key);
  }

  async list(prefix: string): Promise<R2ObjectPage> {
    const objects = [...this.records.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, record]) => ({
        key,
        sizeBytes: record.head.sizeBytes,
        lastModified: record.head.lastModified,
      }));
    return { objects, continuationToken: null };
  }

  // Seeds an object directly (bypassing put) so pruning tests can plant
  // objects with arbitrary ages and prefixes, media included.
  seed(key: string, ageDays: number, sizeBytes = 10): void {
    this.records.set(key, {
      bytes: new Uint8Array(sizeBytes),
      head: {
        sizeBytes,
        contentType: "application/octet-stream",
        lastModified: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000),
        sha256: "0".repeat(64),
        etag: '"seed"',
      },
    });
  }
}

const validEnv = {
  R2_ACCOUNT_ID: "a".repeat(32),
  R2_BUCKET: "heroai-media-staging",
  R2_WRITE_ACCESS_KEY_ID: "write-key",
  R2_WRITE_SECRET_ACCESS_KEY: "w".repeat(32),
};

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), "backup-r2-verify-"));
  const dbPath = path.join(root, "dev-2026-09-13.db");
  writeFileSync(dbPath, "fake-sqlite-snapshot-bytes");

  // (a) upload key + bucket + body size for a fixture .db
  const config = backupR2ConfigFromEnv(validEnv);
  assert(config, "valid env must resolve a config");
  assert.equal(config.storage.bucket, "heroai-media-staging");
  assert.equal(config.retentionDays, 30, "default retention is 30 days");

  const key = backupObjectKey(path.basename(dbPath));
  assert.equal(key, `${BACKUP_R2_PREFIX}dev-2026-09-13.db`);

  const client = new FakeBackupR2Client();
  const firstOutcome = await uploadBackupSnapshot(client, { key, sourcePath: dbPath });
  assert.equal(firstOutcome, "uploaded");
  const uploaded = client.records.get(key);
  assert(uploaded, "object must be uploaded under the db-backups/ key");
  assert.equal(uploaded.head.sizeBytes, Buffer.byteLength("fake-sqlite-snapshot-bytes"));

  // Same-day re-run with an IDENTICAL existing object -> verified, no re-upload.
  const rerunOutcome = await uploadBackupSnapshot(client, { key, sourcePath: dbPath });
  assert.equal(rerunOutcome, "already-uploaded");
  assert.equal(client.deleted.length, 0, "an identical existing object must not be deleted");
  assert.equal(
    Buffer.from(client.records.get(key)!.bytes).toString("utf8"),
    "fake-sqlite-snapshot-bytes",
    "identical re-run must not disturb the stored object",
  );

  // Same-day re-run where the existing object has NO sha256 metadata (older
  // object) falls back to a size comparison.
  const sizeFallbackKey = `${BACKUP_R2_PREFIX}dev-2026-09-14.db`;
  const sizeFallbackClient = new FakeBackupR2Client();
  sizeFallbackClient.records.set(sizeFallbackKey, {
    bytes: new Uint8Array(Buffer.byteLength("fake-sqlite-snapshot-bytes")),
    head: {
      sizeBytes: Buffer.byteLength("fake-sqlite-snapshot-bytes"),
      contentType: "application/vnd.sqlite3",
      lastModified: new Date(),
      sha256: null,
      etag: '"legacy"',
    },
  });
  const fallbackOutcome = await uploadBackupSnapshot(sizeFallbackClient, {
    key: sizeFallbackKey,
    sourcePath: dbPath,
  });
  assert.equal(fallbackOutcome, "already-uploaded", "no-sha256 object with matching size is verified");

  // Same-day re-run where the existing object's content DIFFERS (size/sha
  // mismatch) -> the stale object is deleted and the fresh file re-uploaded.
  const mismatchPath = path.join(root, "dev-2026-09-13-changed.db");
  writeFileSync(mismatchPath, "fake-sqlite-snapshot-bytes-but-longer-now");
  const overwriteOutcome = await uploadBackupSnapshot(client, { key, sourcePath: mismatchPath });
  assert.equal(overwriteOutcome, "overwritten");
  assert.deepEqual(client.deleted, [key], "the mismatched object must be deleted before re-upload");
  assert.equal(
    Buffer.from(client.records.get(key)!.bytes).toString("utf8"),
    "fake-sqlite-snapshot-bytes-but-longer-now",
    "the overwritten object must hold the fresh file's bytes",
  );

  // Bucket override via BACKUP_R2_BUCKET
  const overridden = backupR2ConfigFromEnv({ ...validEnv, BACKUP_R2_BUCKET: "heroai-backups" });
  assert.equal(overridden?.storage.bucket, "heroai-backups");

  // (b) prune deletes only db-backups/ objects older than retention, never media
  const pruneClient = new FakeBackupR2Client();
  pruneClient.seed(`${BACKUP_R2_PREFIX}dev-2026-08-01.db`, 40); // old backup -> pruned
  pruneClient.seed(`${BACKUP_R2_PREFIX}dev-2026-09-10.db`, 3); // recent backup -> kept
  pruneClient.seed("media/v1/renders/old-video.mp4", 400); // old MEDIA object -> never touched

  const { removed } = await pruneBackupObjects(pruneClient, { retentionDays: 30 });
  assert.deepEqual(removed, [`${BACKUP_R2_PREFIX}dev-2026-08-01.db`]);
  assert(pruneClient.records.has(`${BACKUP_R2_PREFIX}dev-2026-09-10.db`), "recent backup kept");
  assert(pruneClient.records.has("media/v1/renders/old-video.mp4"), "media object never pruned");
  assert.equal(pruneClient.deleted.length, 1);

  // A stray object outside the prefix that a naive `list` implementation
  // returned anyway must still never be deleted (defense in depth).
  class LeakyListClient extends FakeBackupR2Client {
    async list(): Promise<R2ObjectPage> {
      return {
        objects: [
          { key: "media/v1/renders/leak.mp4", sizeBytes: 10, lastModified: new Date(0) },
        ],
        continuationToken: null,
      };
    }
  }
  const leaky = new LeakyListClient();
  leaky.seed("media/v1/renders/leak.mp4", 400);
  const leakyResult = await pruneBackupObjects(leaky, { retentionDays: 30 });
  assert.deepEqual(leakyResult.removed, [], "objects outside the backups prefix are never removed");

  // Advisory: a multi-page listing (continuationToken) must be followed to
  // completion rather than pruning only the first page.
  class PagedListClient extends FakeBackupR2Client {
    // Snapshot the listing once so a delete triggered by page 1 can't shrink
    // page 2 out from under us — a real ListObjectsV2 continuation token
    // refers to a fixed listing position, not a live view.
    private snapshot: Awaited<ReturnType<FakeBackupR2Client["list"]>>["objects"] | null = null;
    async list(prefix: string, token?: string): Promise<R2ObjectPage> {
      if (!this.snapshot) this.snapshot = (await super.list(prefix)).objects;
      return token
        ? { objects: this.snapshot.slice(1), continuationToken: null }
        : { objects: this.snapshot.slice(0, 1), continuationToken: "page2" };
    }
  }
  const paged = new PagedListClient();
  paged.seed(`${BACKUP_R2_PREFIX}dev-2026-07-01.db`, 90);
  paged.seed(`${BACKUP_R2_PREFIX}dev-2026-08-05.db`, 40);
  const pagedResult = await pruneBackupObjects(paged, { retentionDays: 30 });
  assert.equal(pagedResult.removed.length, 2, "pagination must be followed across both pages");

  // (c) absent env -> skip (null config), no exception
  assert.equal(backupR2ConfigFromEnv({}), null);
  assert.equal(
    backupR2ConfigFromEnv({ R2_BUCKET: "only-a-bucket" }),
    null,
    "partial/invalid R2 env must resolve to not-configured, not throw",
  );

  // (d) upload failure -> local file kept, error surfaced (caller exits non-zero)
  const failingClient = new FakeBackupR2Client();
  failingClient.failNextPut = true;
  await assert.rejects(
    uploadBackupSnapshot(failingClient, { key, sourcePath: dbPath }),
    /simulated network failure/,
  );
  assert(existsSync(dbPath), "local snapshot must survive an R2 upload failure");
  assert.equal(failingClient.records.has(key), false, "failed upload leaves no partial object");

  console.log("PASS db backup R2 off-box copy");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
