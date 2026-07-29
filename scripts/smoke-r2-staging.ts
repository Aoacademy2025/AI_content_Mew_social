import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createR2MediaStorageFromEnv,
  r2StorageConfigFromEnv,
} from "../src/lib/media-storage-r2";

async function readBody(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(body).arrayBuffer());
}

async function main() {
  const config = r2StorageConfigFromEnv(process.env, "write");
  const productionSmoke = process.env.R2_PRODUCTION_SMOKE_ENABLED === "1";
  if (productionSmoke && config.bucket !== "heroai-media-production") {
    throw new Error("R2 production smoke refuses an unexpected bucket");
  }
  if (!productionSmoke && !/(?:^|[-.])(staging|test)(?:[-.]|$)/i.test(config.bucket)) {
    throw new Error("R2 staging smoke refuses a bucket without staging/test in its name");
  }

  const environment = productionSmoke ? "production" : "staging";
  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), `heroai-r2-${environment}-smoke-`),
  );
  const sourcePath = path.join(fixtureRoot, "fixture.bin");
  const bytes = Buffer.from(`heroai-r2-${environment}-smoke:${randomUUID()}`, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const identity = {
    area: "renders" as const,
    filename: `${environment}-smoke-${randomUUID()}.bin`,
  };
  writeFileSync(sourcePath, bytes);

  const writeStorage = createR2MediaStorageFromEnv(process.env, "write");
  const readStorage = createR2MediaStorageFromEnv(process.env, "read");
  try {
    const committed = await writeStorage.commit({ identity, sourcePath, expectedSha256: sha256 });
    assert.equal(committed.sha256, sha256);
    assert.equal(committed.sizeBytes, bytes.length);

    const full = await readStorage.open(identity);
    assert(full);
    assert.deepEqual(await readBody(full.body), bytes);

    const range = await readStorage.open(identity, {
      start: 3,
      end: Math.min(12, bytes.length - 1),
    });
    assert(range);
    assert.deepEqual(
      await readBody(range.body),
      bytes.subarray(range.start, range.end + 1),
    );

    const materialized = await readStorage.materialize(identity);
    assert(materialized);
    assert.deepEqual(readFileSync(materialized.absolutePath), bytes);
    await materialized.release();

    assert.deepEqual(
      await writeStorage.remove({ identity, expectedSha256: sha256 }),
      { status: "deleted" },
    );
    assert.equal(await readStorage.open(identity), null);
  } finally {
    await writeStorage.remove({ identity, expectedSha256: sha256 }).catch(() => {});
    await rm(fixtureRoot, { recursive: true, force: true });
  }

  console.log(`PASS R2 ${environment} smoke`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "R2 staging smoke failed");
  process.exit(1);
});
