import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  AwsR2ObjectClient,
  R2ConfigurationError,
  R2MediaStorageAdapter,
  R2ObjectTooLargeError,
  R2VerificationError,
  R2WriteConflictError,
  r2StorageConfigFromEnv,
  type R2ObjectClientPort,
  type R2ObjectHead,
  type R2PutResult,
} from "../src/lib/media-storage-r2";
import {
  MediaCollisionError,
  InvalidMediaIdentityError,
  MediaRangeError,
} from "../src/lib/media-storage";

type FakeRecord = {
  bytes: Uint8Array;
  head: R2ObjectHead;
};

class FakeR2Client implements R2ObjectClientPort {
  readonly records = new Map<string, FakeRecord>();
  preconditionWithoutWinner = false;

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
    if (this.preconditionWithoutWinner) return "precondition_failed";
    if (this.records.has(input.key)) return "precondition_failed";
    const bytes = new Uint8Array(await readFile(input.sourcePath));
    this.records.set(input.key, {
      bytes,
      head: {
        sizeBytes: input.sizeBytes,
        contentType: input.contentType,
        lastModified: new Date("2026-07-28T00:00:00.000Z"),
        sha256: input.sha256,
        etag: "\"fake-etag\"",
      },
    });
    return "created";
  }

  async get(input: {
    key: string;
    start: number;
    end: number;
  }): Promise<{ body: ReadableStream<Uint8Array>; contentLength: number }> {
    const record = this.records.get(input.key);
    if (!record) throw new Error("missing fake object");
    const bytes = record.bytes.slice(input.start, input.end + 1);
    return {
      body: Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>,
      contentLength: bytes.byteLength,
    };
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }
}

async function readBody(body: ReadableStream<Uint8Array>): Promise<string> {
  return Buffer.from(await new Response(body).arrayBuffer()).toString("utf8");
}

async function main() {
  const validConfig = r2StorageConfigFromEnv({
    R2_ACCOUNT_ID: "a".repeat(32),
    R2_BUCKET: "heroai-media-staging",
    R2_WRITE_ACCESS_KEY_ID: "write-key",
    R2_WRITE_SECRET_ACCESS_KEY: "w".repeat(32),
    R2_READ_ACCESS_KEY_ID: "read-key",
    R2_READ_SECRET_ACCESS_KEY: "r".repeat(32),
    R2_MAX_ATTEMPTS: "4",
    R2_REQUEST_TIMEOUT_MS: "300000",
    R2_MATERIALIZE_ROOT: path.join(tmpdir(), "r2-config-materialized"),
  });
  assert.equal(validConfig.endpoint, `https://${"a".repeat(32)}.r2.cloudflarestorage.com`);
  assert.equal(validConfig.accessKeyId, "write-key");
  assert.equal(validConfig.maxAttempts, 4);
  assert.equal(validConfig.requestTimeoutMs, 300_000);

  const readConfig = r2StorageConfigFromEnv({
    R2_ACCOUNT_ID: "b".repeat(32),
    R2_BUCKET: "heroai-media-staging",
    R2_READ_ACCESS_KEY_ID: "read-key",
    R2_READ_SECRET_ACCESS_KEY: "r".repeat(32),
  }, "read");
  assert.equal(readConfig.accessKeyId, "read-key", "web reads use a separate read-only credential");

  for (const invalid of [
    {},
    {
      R2_ACCOUNT_ID: "not-an-account",
      R2_BUCKET: "heroai-media-staging",
      R2_WRITE_ACCESS_KEY_ID: "write-key",
      R2_WRITE_SECRET_ACCESS_KEY: "w".repeat(32),
    },
    {
      R2_ENDPOINT: "http://127.0.0.1:9000",
      R2_ACCOUNT_ID: "c".repeat(32),
      R2_BUCKET: "heroai-media-staging",
      R2_WRITE_ACCESS_KEY_ID: "write-key",
      R2_WRITE_SECRET_ACCESS_KEY: "w".repeat(32),
    },
    {
      R2_ENDPOINT: "https://attacker.example",
      R2_ACCOUNT_ID: "c".repeat(32),
      R2_BUCKET: "heroai-media-staging",
      R2_WRITE_ACCESS_KEY_ID: "write-key",
      R2_WRITE_SECRET_ACCESS_KEY: "w".repeat(32),
    },
  ]) {
    assert.throws(() => r2StorageConfigFromEnv(invalid), R2ConfigurationError);
  }

  const root = mkdtempSync(path.join(tmpdir(), "media-storage-r2-"));
  const sourceRoot = path.join(root, "source");
  mkdirSync(sourceRoot, { recursive: true });
  const sourcePath = path.join(sourceRoot, "video.mp4");
  writeFileSync(sourcePath, "0123456789");
  const sha256 = createHash("sha256").update("0123456789").digest("hex");
  const identity = { area: "renders" as const, filename: "r2 sample.mp4" };

  const fake = new FakeR2Client();
  const storage = new R2MediaStorageAdapter(fake, {
    materializeRoot: path.join(root, "materialized"),
  });
  const committed = await storage.commit({ identity, sourcePath, expectedSha256: sha256 });
  assert.equal(committed.objectKey, "media/v1/renders/r2 sample.mp4");
  assert.equal(committed.canonicalUrl, "/api/renders/r2%20sample.mp4");
  assert.equal(committed.sha256, sha256);
  assert.equal((await storage.stat(identity))?.sizeBytes, 10);
  assert.equal(
    await storage.verifyReplica({
      identity,
      expectedSizeBytes: 10,
      expectedSha256: sha256,
    }),
    true,
  );
  assert.equal(
    await storage.verifyReplica({
      identity: { area: "renders", filename: "missing.mp4" },
      expectedSizeBytes: 10,
      expectedSha256: sha256,
    }),
    false,
  );
  await assert.rejects(
    storage.verifyReplica({
      identity,
      expectedSizeBytes: 11,
      expectedSha256: sha256,
    }),
    MediaCollisionError,
  );
  await assert.rejects(
    storage.commit({
      identity: { area: "renders", filename: "../escape.mp4" },
      sourcePath,
    }),
    InvalidMediaIdentityError,
  );

  const idempotent = await storage.commit({ identity, sourcePath, expectedSha256: sha256 });
  assert.equal(idempotent.sha256, sha256);

  const range = await storage.open(identity, { start: 2, end: 5 });
  assert(range);
  assert.equal(range.contentLength, 4);
  assert.equal(await readBody(range.body), "2345");
  await assert.rejects(storage.open(identity, { start: 10 }), MediaRangeError);

  const materialized = await storage.materialize(identity);
  assert(materialized);
  assert.equal(readFileSync(materialized.absolutePath, "utf8"), "0123456789");
  await materialized.release();
  assert.equal(existsSync(materialized.absolutePath), false);

  const collisionPath = path.join(sourceRoot, "collision.mp4");
  writeFileSync(collisionPath, "different");
  await assert.rejects(
    storage.commit({ identity, sourcePath: collisionPath }),
    MediaCollisionError,
  );

  const mismatch = await storage.remove({
    identity,
    expectedSha256: "0".repeat(64),
  });
  assert.equal(mismatch.status, "checksum_mismatch");
  assert(await storage.open(identity));
  assert.deepEqual(await storage.remove({ identity, expectedSha256: sha256 }), { status: "deleted" });
  assert.equal(await storage.open(identity), null);

  const noWinner = new FakeR2Client();
  noWinner.preconditionWithoutWinner = true;
  const conflictStorage = new R2MediaStorageAdapter(noWinner, {
    materializeRoot: path.join(root, "conflict-materialized"),
  });
  await assert.rejects(
    conflictStorage.commit({
      identity: { area: "renders", filename: "conflict.mp4" },
      sourcePath,
    }),
    R2WriteConflictError,
  );

  fake.records.set("media/v1/renders/unverified.mp4", {
    bytes: new TextEncoder().encode("unsafe"),
    head: {
      sizeBytes: 6,
      contentType: "video/mp4",
      lastModified: new Date(),
      sha256: null,
      etag: "\"unverified\"",
    },
  });
  await assert.rejects(
    storage.open({ area: "renders", filename: "unverified.mp4" }),
    R2VerificationError,
  );

  const awsClient = new AwsR2ObjectClient(validConfig);
  await assert.rejects(
    awsClient.put({
      key: "media/v1/renders/too-large.mp4",
      sourcePath,
      sizeBytes: 5 * 1024 * 1024 * 1024 + 1,
      contentType: "video/mp4",
      sha256,
      contentMd5Base64: "dGVzdA==",
    }),
    R2ObjectTooLargeError,
  );

  console.log("PASS media storage R2 adapter");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
