import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RemoteMediaReplicaVerifier } from "../src/lib/media-storage-r2";

const root = mkdtempSync(path.join(tmpdir(), "media-local-eviction-"));
const now = new Date("2026-07-29T12:00:00.000Z");
process.env.DATABASE_URL = `file:${path.join(root, "eviction.db")}`;
execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
  cwd: path.resolve(__dirname, ".."),
  env: process.env,
  stdio: "ignore",
});

function writeOldRender(filename: string, bytes: string): {
  absolutePath: string;
  sha256: string;
  mtimeMs: number;
} {
  const dir = path.join(root, "public", "renders");
  mkdirSync(dir, { recursive: true });
  const absolutePath = path.join(dir, filename);
  writeFileSync(absolutePath, bytes);
  const old = new Date(now.getTime() - 20 * 86_400_000);
  utimesSync(absolutePath, old, old);
  return {
    absolutePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mtimeMs: old.getTime(),
  };
}

class FakeVerifier implements RemoteMediaReplicaVerifier {
  calls = 0;

  constructor(private readonly failAfterFirst = false) {}

  async verifyReplica(): Promise<boolean> {
    this.calls++;
    return !(this.failAfterFirst && this.calls > 1);
  }
}

async function catalogRender(
  prisma: (typeof import("../src/lib/prisma"))["prisma"],
  filename: string,
  file: ReturnType<typeof writeOldRender>,
): Promise<void> {
  await prisma.mediaObject.create({
    data: {
      area: "renders",
      filename,
      objectKey: `media/v1/renders/${filename}`,
      contentType: "video/mp4",
      sizeBytes: BigInt(Buffer.byteLength(readFileSync(file.absolutePath))),
      sha256: file.sha256,
      remoteState: "verified",
      localState: "present",
      localMtimeMs: BigInt(file.mtimeMs),
    },
  });
}

async function main(): Promise<void> {
  const [
    { prisma },
    { MediaCatalog },
    { getMediaCleanupPlan },
    { runLocalMediaEviction, verifiedLocalReplica },
  ] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/media-catalog"),
    import("../src/lib/media-cleanup"),
    import("../src/lib/media-local-eviction"),
  ]);
  const catalog = new MediaCatalog(prisma);

  assert(
    verifiedLocalReplica(
      {
        key: "renders/fractional-mtime.mp4",
        absolutePath: path.join(root, "public", "renders", "fractional-mtime.mp4"),
        sizeBytes: 10,
        mtimeMs: 1000.75,
        effectiveExpiresAt: null,
        reason: "unreferenced_14d",
        fingerprint: "fixture",
      },
      {
        remoteState: "verified",
        localState: "present",
        sizeBytes: 10n,
        sha256: "a".repeat(64),
        remoteFilename: null,
        localMtimeMs: 1001n,
        lastVerifiedAt: null,
        nextRetryAt: null,
        lastErrorCode: null,
      },
    ),
    "filesystem Date rounding and cleanup mtime validation must use the same millisecond",
  );

  const successName = "evict-success.mp4";
  const successFile = writeOldRender(successName, "verified-r2-copy");
  await catalogRender(prisma, successName, successFile);
  const successPlan = await getMediaCleanupPlan({
    cwd: root,
    now,
    includeStocks: true,
  });
  const successRemote = new FakeVerifier();

  const dryRun = await runLocalMediaEviction(successPlan, {
    mode: "dry-run",
    now,
    catalog,
    remote: successRemote,
    maxObjects: 1,
    maxBytes: 1024,
    env: {
      MEDIA_READ_MODE: "r2-local",
      MEDIA_LOCAL_EVICTION: "0",
      MEDIA_R2_DELETE: "0",
    },
  });
  assert.equal(dryRun.eligible.count, 1);
  assert.equal(existsSync(successFile.absolutePath), true);

  const applied = await runLocalMediaEviction(successPlan, {
    mode: "apply",
    now,
    catalog,
    remote: successRemote,
    maxObjects: 1,
    maxBytes: 1024,
    env: {
      MEDIA_READ_MODE: "r2-local",
      MEDIA_LOCAL_EVICTION: "1",
      MEDIA_R2_DELETE: "0",
    },
  });
  assert.equal(applied.evicted.count, 1);
  assert.equal(applied.errors, 0);
  assert.equal(existsSync(successFile.absolutePath), false);
  assert.equal((await catalog.inspect({
    area: "renders",
    filename: successName,
  }))?.localState, "evicted");
  assert.equal(successRemote.calls, 3, "dry-run, preflight, and post-quarantine verify R2");

  const rollbackName = "evict-rollback.mp4";
  const rollbackFile = writeOldRender(rollbackName, "must-be-restored");
  await catalogRender(prisma, rollbackName, rollbackFile);
  const rollbackPlan = await getMediaCleanupPlan({
    cwd: root,
    now,
    includeStocks: true,
  });
  const rollbackRemote = new FakeVerifier(true);
  const rolledBack = await runLocalMediaEviction(rollbackPlan, {
    mode: "apply",
    now,
    catalog,
    remote: rollbackRemote,
    maxObjects: 1,
    maxBytes: 1024,
    env: {
      MEDIA_READ_MODE: "r2-local",
      MEDIA_LOCAL_EVICTION: "1",
      MEDIA_R2_DELETE: "0",
    },
  });
  assert.equal(rolledBack.evicted.count, 0);
  assert.equal(rolledBack.skipped.remote_unverified, 1);
  assert.equal(rolledBack.errors, 0);
  assert.equal(existsSync(rollbackFile.absolutePath), true);
  assert.equal(readFileSync(rollbackFile.absolutePath, "utf8"), "must-be-restored");
  assert.equal((await catalog.inspect({
    area: "renders",
    filename: rollbackName,
  }))?.localState, "present");

  const degraded = await runLocalMediaEviction(rollbackPlan, {
    mode: "apply",
    now,
    catalog,
    remote: {
      verifyReplica: async () => {
        throw new Error("simulated R2 outage");
      },
    },
    maxObjects: 1,
    maxBytes: 1024,
    env: {
      MEDIA_READ_MODE: "r2-local",
      MEDIA_LOCAL_EVICTION: "1",
      MEDIA_R2_DELETE: "0",
    },
  });
  assert.equal(degraded.errors, 1);
  assert.equal(degraded.evicted.count, 0, "a degraded R2 preflight performs no eviction");
  assert.equal(existsSync(rollbackFile.absolutePath), true);

  await assert.rejects(
    runLocalMediaEviction(rollbackPlan, {
      mode: "apply",
      catalog,
      remote: new FakeVerifier(),
      env: {
        MEDIA_READ_MODE: "local",
        MEDIA_LOCAL_EVICTION: "1",
        MEDIA_R2_DELETE: "0",
      },
    }),
    /local eviction is blocked by rollout mode/,
  );
  await assert.rejects(
    runLocalMediaEviction(rollbackPlan, {
      mode: "apply",
      catalog,
      remote: new FakeVerifier(),
      env: {
        MEDIA_READ_MODE: "r2-local",
        MEDIA_LOCAL_EVICTION: "1",
        MEDIA_R2_DELETE: "1",
      },
    }),
    /R2 deletion must remain disabled/,
  );

  await prisma.$disconnect();
  console.log("PASS verified local media eviction and rollback");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
