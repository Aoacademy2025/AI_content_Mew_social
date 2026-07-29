import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  InMemoryMediaStorageAdapter,
  InvalidMediaIdentityError,
  LocalMediaStorageAdapter,
  MediaCollisionError,
  MediaRangeError,
  UnsafeMediaFileError,
  canonicalMediaUrl,
  mediaObjectKey,
  type MediaStorage,
} from "../src/lib/media-storage";
import { mediaStorageRuntimeConfig } from "../src/lib/media-storage-config";

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "media-storage-foundation-"));
const sourceRoot = path.join(fixtureRoot, "source");
mkdirSync(sourceRoot, { recursive: true });

function source(name: string, value: string): string {
  const filePath = path.join(sourceRoot, name);
  writeFileSync(filePath, value);
  return filePath;
}

async function readBody(body: ReadableStream<Uint8Array>): Promise<string> {
  return Buffer.from(await new Response(body).arrayBuffer()).toString("utf8");
}

async function verifyStorageContract(name: string, storage: MediaStorage): Promise<void> {
  const identity = { area: "renders" as const, filename: `${name} sample.mp4` };
  const sourcePath = source(`${name}-source.mp4`, "0123456789");
  const sha256 = createHash("sha256").update("0123456789").digest("hex");

  const committed = await storage.commit({ identity, sourcePath, expectedSha256: sha256 });
  assert.equal(committed.objectKey, `media/v1/renders/${name} sample.mp4`);
  assert.equal(committed.canonicalUrl, `/api/renders/${name}%20sample.mp4`);
  assert.equal(committed.contentType, "video/mp4");
  assert.equal(committed.sizeBytes, 10);
  assert.equal(committed.sha256, sha256);
  const descriptor = await storage.stat(identity);
  assert(descriptor);
  assert.equal(descriptor.sizeBytes, 10);

  const idempotent = await storage.commit({ identity, sourcePath, expectedSha256: sha256 });
  assert.equal(idempotent.sha256, sha256, `${name}: an identical retry is idempotent`);

  const full = await storage.open(identity);
  assert(full);
  assert.equal(full.start, 0);
  assert.equal(full.end, 9);
  assert.equal(full.contentLength, 10);
  assert.equal(await readBody(full.body), "0123456789");

  const range = await storage.open(identity, { start: 3, end: 6 });
  assert(range);
  assert.equal(range.contentLength, 4);
  assert.equal(await readBody(range.body), "3456");
  await assert.rejects(
    storage.open(identity, { start: 10 }),
    (error: unknown) => error instanceof MediaRangeError && error.totalSize === 10,
  );

  const materialized = await storage.materialize(identity);
  assert(materialized);
  assert.equal(readFileSync(materialized.absolutePath, "utf8"), "0123456789");
  await materialized.release();

  const collisionPath = source(`${name}-collision.mp4`, "different");
  await assert.rejects(
    storage.commit({ identity, sourcePath: collisionPath }),
    MediaCollisionError,
    `${name}: an immutable identity cannot be overwritten`,
  );

  const mismatch = await storage.remove({
    identity,
    expectedSha256: "0".repeat(64),
  });
  assert.equal(mismatch.status, "checksum_mismatch");
  assert(await storage.open(identity), `${name}: a checksum mismatch leaves media intact`);

  assert.deepEqual(await storage.remove({ identity, expectedSha256: sha256 }), { status: "deleted" });
  assert.equal(await storage.stat(identity), null);
  assert.equal(await storage.open(identity), null);
  assert.deepEqual(await storage.remove({ identity, expectedSha256: sha256 }), { status: "missing" });
}

async function main() {
  assert.equal(canonicalMediaUrl({ area: "stocks", filename: "ภาพ 1.jpg" }), "/api/stocks/%E0%B8%A0%E0%B8%B2%E0%B8%9E%201.jpg");
  assert.equal(mediaObjectKey({ area: "stocks", filename: "clip.mp4" }), "media/v1/stocks/clip.mp4");
  for (const filename of ["", ".", "..", "../escape.mp4", "nested/file.mp4", "bad\0.mp4"]) {
    assert.throws(
      () => mediaObjectKey({ area: "renders", filename }),
      InvalidMediaIdentityError,
      `${JSON.stringify(filename)} must fail closed`,
    );
  }

  assert.deepEqual(mediaStorageRuntimeConfig({}), {
    writeMode: "local",
    readMode: "local",
    localEvictionEnabled: false,
    r2DeleteEnabled: false,
    warnings: [],
  });
  const invalid = mediaStorageRuntimeConfig({
    MEDIA_WRITE_MODE: "typo",
    MEDIA_READ_MODE: "unknown",
    MEDIA_LOCAL_EVICTION: "1",
    MEDIA_R2_DELETE: "1",
  });
  assert.equal(invalid.writeMode, "local");
  assert.equal(invalid.readMode, "local");
  assert.equal(invalid.localEvictionEnabled, false);
  assert.equal(invalid.r2DeleteEnabled, false);
  assert.equal(invalid.warnings.length, 4);

  const reconciledLocalWrites = mediaStorageRuntimeConfig({
    MEDIA_WRITE_MODE: "local",
    MEDIA_READ_MODE: "r2-local",
    MEDIA_LOCAL_EVICTION: "1",
  });
  assert.equal(
    reconciledLocalWrites.localEvictionEnabled,
    true,
    "verified cleanup candidates may evict locally while new writes reconcile asynchronously",
  );
  assert.equal(reconciledLocalWrites.r2DeleteEnabled, false);

  const gated = mediaStorageRuntimeConfig({
    MEDIA_WRITE_MODE: "r2-required",
    MEDIA_READ_MODE: "r2",
    MEDIA_LOCAL_EVICTION: "1",
    MEDIA_R2_DELETE: "1",
  });
  assert.equal(gated.localEvictionEnabled, true);
  assert.equal(gated.r2DeleteEnabled, true);
  assert.deepEqual(gated.warnings, []);

  const localRoot = path.join(fixtureRoot, "local");
  await verifyStorageContract(
    "local",
    new LocalMediaStorageAdapter({
      renders: path.join(localRoot, "renders"),
      stocks: path.join(localRoot, "stocks"),
    }),
  );
  await verifyStorageContract(
    "memory",
    new InMemoryMediaStorageAdapter(path.join(fixtureRoot, "materialized")),
  );

  const symlinkSource = path.join(sourceRoot, "symlink.mp4");
  symlinkSync(source("real-source.mp4", "real"), symlinkSource);
  const local = new LocalMediaStorageAdapter({
    renders: path.join(fixtureRoot, "symlink-test", "renders"),
    stocks: path.join(fixtureRoot, "symlink-test", "stocks"),
  });
  await assert.rejects(
    local.commit({
      identity: { area: "renders", filename: "symlink.mp4" },
      sourcePath: symlinkSource,
    }),
    UnsafeMediaFileError,
  );

  console.log("PASS media storage foundation");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
