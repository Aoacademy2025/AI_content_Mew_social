import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "media-catalog-"));
process.env.DATABASE_URL = `file:${path.join(root, "catalog.db")}`;
execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
  cwd: path.resolve(__dirname, ".."),
  env: process.env,
  stdio: "ignore",
});

async function main() {
  const [{ prisma }, { MediaCatalog }] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/media-catalog"),
  ]);
  const catalog = new MediaCatalog(prisma);
  const identity = { area: "renders" as const, filename: "catalog.mp4" };
  const descriptor = {
    identity,
    objectKey: "media/v1/renders/catalog.mp4",
    canonicalUrl: "/api/renders/catalog.mp4",
    contentType: "video/mp4",
    sizeBytes: 10,
    lastModified: new Date("2026-07-28T00:00:00.000Z"),
  };
  const now = new Date("2026-07-28T01:00:00.000Z");

  const first = await catalog.claim({ descriptor, localMtimeMs: 1000 }, { now });
  assert.equal(first.status, "claimed");
  if (first.status !== "claimed") throw new Error("expected first claim");

  assert.deepEqual(
    await catalog.claim({ descriptor, localMtimeMs: 1000 }, { now }),
    { status: "deferred" },
  );
  assert.equal(await catalog.markFailed(first.claim, new Error("NetworkTimeout"), now), true);
  assert.deepEqual(
    await catalog.claim({ descriptor, localMtimeMs: 1000 }, { now }),
    { status: "deferred" },
  );

  await prisma.mediaObject.update({
    where: { objectKey: descriptor.objectKey },
    data: { nextRetryAt: new Date(now.getTime() - 1) },
  });
  const retry = await catalog.claim({ descriptor, localMtimeMs: 1000 }, { now });
  assert.equal(retry.status, "claimed");
  if (retry.status !== "claimed") throw new Error("expected retry claim");

  const receipt = { ...descriptor, sha256: "a".repeat(64) };
  assert.equal(await catalog.markVerified(retry.claim, receipt, now), true);
  assert.deepEqual(
    await catalog.claim({ descriptor, localMtimeMs: 1000 }, { now }),
    { status: "verified" },
  );

  const changedObservation = {
    descriptor: {
      ...descriptor,
      sizeBytes: 11,
      lastModified: new Date("2026-07-28T00:00:01.000Z"),
    },
    localMtimeMs: 2000,
  };
  const concurrent = await Promise.all([
    catalog.claim(changedObservation, { now }),
    catalog.claim(changedObservation, { now }),
  ]);
  const changed = concurrent.find((result) => result.status === "claimed");
  assert(changed && changed.status === "claimed", "a changed local file must be re-verified");
  assert(
    concurrent.some((result) => result.status === "busy" || result.status === "deferred"),
    "only one process may own the changed-file upload lease",
  );
  assert.equal(
    await catalog.markFailed(
      changed.claim,
      new (await import("../src/lib/media-storage")).MediaCollisionError(),
      now,
    ),
    true,
  );
  assert.deepEqual(
    await catalog.claim(
      {
        descriptor: { ...descriptor, sizeBytes: 11 },
        localMtimeMs: 2000,
      },
      { now },
    ),
    { status: "conflict" },
  );

  const row = await catalog.inspect(identity);
  assert.equal(row?.remoteState, "conflict");
  assert.equal(row?.lastErrorCode, "MediaCollisionError");
  await prisma.$disconnect();
  console.log("PASS media catalog");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
