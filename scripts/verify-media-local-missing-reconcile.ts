import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MediaIdentity } from "../src/lib/media-storage";
import type { RemoteMediaReplicaVerifier } from "../src/lib/media-storage-r2";

const root = mkdtempSync(path.join(tmpdir(), "media-missing-reconcile-"));
process.env.DATABASE_URL = `file:${path.join(root, "reconcile.db")}`;
execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
  cwd: path.resolve(__dirname, ".."),
  env: process.env,
  stdio: "ignore",
});

const sha256 = createHash("sha256").update("verified-remote").digest("hex");
const rolloutEnv = {
  MEDIA_READ_MODE: "r2-local",
  MEDIA_LOCAL_EVICTION: "1",
  MEDIA_R2_DELETE: "0",
};

class FakeVerifier implements RemoteMediaReplicaVerifier {
  calls: MediaIdentity[] = [];

  constructor(
    private readonly result: (identity: MediaIdentity) => boolean | Error = () => true,
  ) {}

  async verifyReplica(input: { identity: MediaIdentity }): Promise<boolean> {
    this.calls.push(input.identity);
    const result = this.result(input.identity);
    if (result instanceof Error) throw result;
    return result;
  }
}

async function main(): Promise<void> {
  const [
    { prisma },
    { MediaCatalog },
    { reconcileMissingVerifiedLocalMedia },
  ] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/media-catalog"),
    import("../src/lib/media-local-missing-reconcile"),
  ]);
  const catalog = new MediaCatalog(prisma);

  async function createVerifiedPresent(filename: string): Promise<void> {
    await prisma.mediaObject.create({
      data: {
        area: "renders",
        filename,
        objectKey: `media/v1/renders/${filename}`,
        contentType: "video/mp4",
        sizeBytes: 15n,
        sha256,
        remoteState: "verified",
        localState: "present",
        localMtimeMs: 1_700_000_000_000n,
      },
    });
  }

  await createVerifiedPresent("missing.mp4");
  await createVerifiedPresent("present.mp4");
  await createVerifiedPresent("quarantined.mp4");
  mkdirSync(path.join(root, "public", "renders"), { recursive: true });
  writeFileSync(path.join(root, "public", "renders", "present.mp4"), "local");

  const dryRemote = new FakeVerifier();
  const dry = await reconcileMissingVerifiedLocalMedia({
    mode: "dry-run",
    cwd: root,
    catalog,
    remote: dryRemote,
    quarantinedKeys: new Set(["renders/quarantined.mp4"]),
    maxObjects: 10,
    maxBytes: 1024,
    env: rolloutEnv,
  });
  assert.equal(dry.eligible.count, 1);
  assert.equal(dry.selected.count, 1);
  assert.equal(dry.reconciled.count, 0);
  assert.equal(dry.skipped.local_present, 1);
  assert.equal(dry.skipped.quarantined, 1);
  assert.equal(
    (await catalog.inspect({ area: "renders", filename: "missing.mp4" }))?.localState,
    "present",
  );

  const applied = await reconcileMissingVerifiedLocalMedia({
    mode: "apply",
    cwd: root,
    catalog,
    remote: new FakeVerifier(),
    quarantinedKeys: new Set(["renders/quarantined.mp4"]),
    maxObjects: 10,
    maxBytes: 1024,
    env: rolloutEnv,
  });
  assert.equal(applied.reconciled.count, 1);
  assert.equal(applied.errors, 0);
  assert.equal(
    (await catalog.inspect({ area: "renders", filename: "missing.mp4" }))?.localState,
    "evicted",
  );

  await createVerifiedPresent("remote-mismatch.mp4");
  const mismatched = await reconcileMissingVerifiedLocalMedia({
    mode: "apply",
    cwd: root,
    catalog,
    remote: new FakeVerifier((identity) => identity.filename !== "remote-mismatch.mp4"),
    quarantinedKeys: new Set(["renders/quarantined.mp4"]),
    maxObjects: 10,
    maxBytes: 1024,
    env: rolloutEnv,
  });
  assert.equal(mismatched.skipped.remote_unverified, 1);
  assert.equal(mismatched.reconciled.count, 0);
  assert.equal(
    (await catalog.inspect({ area: "renders", filename: "remote-mismatch.mp4" }))?.localState,
    "present",
  );

  await createVerifiedPresent("a-good-before-outage.mp4");
  await createVerifiedPresent("b-outage.mp4");
  const degraded = await reconcileMissingVerifiedLocalMedia({
    mode: "apply",
    cwd: root,
    catalog,
    remote: new FakeVerifier((identity) =>
      identity.filename === "b-outage.mp4" ? new Error("R2 unavailable") : true
    ),
    quarantinedKeys: new Set(["renders/quarantined.mp4"]),
    maxObjects: 10,
    maxBytes: 1024,
    env: rolloutEnv,
  });
  assert.equal(degraded.errors, 1);
  assert.equal(degraded.reconciled.count, 0, "an R2 outage makes the whole apply fail closed");
  assert.equal(
    (await catalog.inspect({ area: "renders", filename: "a-good-before-outage.mp4" }))?.localState,
    "present",
  );

  await assert.rejects(
    reconcileMissingVerifiedLocalMedia({
      mode: "apply",
      cwd: root,
      catalog,
      remote: new FakeVerifier(),
      quarantinedKeys: new Set(),
      env: { ...rolloutEnv, MEDIA_READ_MODE: "local" },
    }),
    /blocked by rollout mode/,
  );

  await prisma.$disconnect();
  console.log("PASS missing local catalog reconciliation is checksum-gated and fail-closed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
