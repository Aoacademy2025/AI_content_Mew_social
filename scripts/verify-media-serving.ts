import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryMediaStorageAdapter } from "../src/lib/media-storage";
import { serveMediaGet, serveMediaHead } from "../src/lib/media-serving";
import { RolloutMediaStorage } from "../src/lib/media-storage-rollout";
import { mediaStorageRuntimeConfig } from "../src/lib/media-storage-config";
import { resolveProjectMediaState } from "../src/lib/media-retention";

async function responseBody(response: Response): Promise<string> {
  return Buffer.from(await response.arrayBuffer()).toString("utf8");
}

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), "media-serving-"));
  const sourcePath = path.join(root, "fixture.mp4");
  writeFileSync(sourcePath, "0123456789");
  const storage = new InMemoryMediaStorageAdapter(path.join(root, "materialized"));
  const identity = { area: "renders" as const, filename: "fixture.mp4" };
  await storage.commit({ identity, sourcePath });
  const options = {
    ...identity,
    storage,
    cors: { "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" },
    cacheControl: "private, max-age=86400",
  };

  const head = await serveMediaHead(options);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(head.headers.get("content-type"), "video/mp4");

  const full = await serveMediaGet(new Request("https://example.test/api/renders/fixture.mp4"), options);
  assert.equal(full.status, 200);
  assert.equal(await responseBody(full), "0123456789");

  const partial = await serveMediaGet(
    new Request("https://example.test/api/renders/fixture.mp4", {
      headers: { range: "bytes=2-5" },
    }),
    options,
  );
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await responseBody(partial), "2345");

  const invalidRange = await serveMediaGet(
    new Request("https://example.test/api/renders/fixture.mp4", {
      headers: { range: "bytes=10-" },
    }),
    options,
  );
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get("content-range"), "bytes */10");

  const missing = await serveMediaHead({ ...options, filename: "missing.mp4" });
  assert.equal(missing.status, 404);
  const invalid = await serveMediaHead({ ...options, filename: "../escape.mp4" });
  assert.equal(invalid.status, 400);

  const remoteOnlyWithoutCredentials = new RolloutMediaStorage({
    config: mediaStorageRuntimeConfig({ MEDIA_READ_MODE: "r2" }),
    local: storage,
  });
  const unavailable = await serveMediaHead({
    ...options,
    storage: remoteOnlyWithoutCredentials,
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("retry-after"), "5");

  assert.deepEqual(
    await resolveProjectMediaState({
      videoUrl: "/api/renders/fixture.mp4",
      mediaExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
      now: new Date("2026-07-28T00:00:00.000Z"),
      storage,
    }),
    {
      status: "available",
      expiresAt: "2026-08-01T00:00:00.000Z",
    },
    "project availability follows the storage seam after local eviction",
  );

  console.log("PASS media serving");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
