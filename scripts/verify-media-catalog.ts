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

  const {
    contentAddressedMediaIdentity,
    contentAddressedStockIdentity,
    mediaObjectKey,
  } =
    await import("../src/lib/media-storage");
  const recoveredRenderPhysical = contentAddressedMediaIdentity(
    identity,
    "d".repeat(64),
  );
  const recoveredRender = await catalog.claim({
    descriptor: { ...descriptor, sizeBytes: 11 },
    localMtimeMs: 2000,
    remoteIdentity: recoveredRenderPhysical,
  }, { now });
  assert.equal(recoveredRender.status, "claimed");
  if (recoveredRender.status !== "claimed") {
    throw new Error("content-addressed target must recover a legacy render conflict");
  }
  assert.equal(
    await catalog.markVerified(recoveredRender.claim, {
      ...descriptor,
      identity: recoveredRenderPhysical,
      objectKey: mediaObjectKey(recoveredRenderPhysical),
      sizeBytes: 11,
      sha256: "d".repeat(64),
    }, now),
    true,
  );
  assert.deepEqual(
    await catalog.resolveRemoteIdentity(identity),
    recoveredRenderPhysical,
  );
  assert.equal(
    await catalog.markLocalEvicted({
      identity,
      sizeBytes: 11,
      localMtimeMs: 2000,
      sha256: "d".repeat(64),
      remoteFilename: recoveredRenderPhysical.filename,
    }),
    true,
  );
  assert.equal((await catalog.inspect(identity))?.localState, "evicted");
  assert.equal(
    await catalog.markLocalPresent({
      identity,
      sizeBytes: 11,
      localMtimeMs: 2000,
      sha256: "d".repeat(64),
      remoteFilename: recoveredRenderPhysical.filename,
    }),
    true,
  );
  assert.equal((await catalog.inspect(identity))?.localState, "present");

  const stockIdentity = { area: "stocks" as const, filename: "mutable-slot.mp4" };
  const stockDescriptor = {
    identity: stockIdentity,
    objectKey: mediaObjectKey(stockIdentity),
    canonicalUrl: "/api/stocks/mutable-slot.mp4",
    contentType: "video/mp4",
    sizeBytes: 20,
    lastModified: new Date("2026-07-28T02:00:00.000Z"),
  };
  const legacyStock = await catalog.claim({
    descriptor: stockDescriptor,
    localMtimeMs: 3000,
  }, { now });
  assert.equal(legacyStock.status, "claimed");
  if (legacyStock.status !== "claimed") throw new Error("expected legacy stock claim");
  assert.equal(
    await catalog.markFailed(
      legacyStock.claim,
      new (await import("../src/lib/media-storage")).MediaCollisionError(),
      now,
    ),
    true,
  );
  assert.deepEqual(
    await catalog.claim({
      descriptor: stockDescriptor,
      localMtimeMs: 3000,
    }, { now }),
    { status: "conflict" },
  );

  const firstStockPhysical = contentAddressedStockIdentity(
    stockIdentity,
    "b".repeat(64),
  );
  const firstStock = await catalog.claim({
    descriptor: stockDescriptor,
    localMtimeMs: 3000,
    remoteIdentity: firstStockPhysical,
  }, { now });
  assert.equal(firstStock.status, "claimed");
  if (firstStock.status !== "claimed") {
    throw new Error("content-addressed target must recover a legacy stock conflict");
  }
  assert.equal(
    await catalog.markVerified(firstStock.claim, {
      ...stockDescriptor,
      identity: firstStockPhysical,
      objectKey: mediaObjectKey(firstStockPhysical),
      sha256: "b".repeat(64),
    }, now),
    true,
  );
  assert.deepEqual(
    await catalog.resolveRemoteIdentity(stockIdentity),
    firstStockPhysical,
  );

  const replacementPhysical = contentAddressedStockIdentity(
    stockIdentity,
    "c".repeat(64),
  );
  const replacement = await catalog.claim({
    descriptor: {
      ...stockDescriptor,
      sizeBytes: 21,
      lastModified: new Date("2026-07-28T02:00:01.000Z"),
    },
    localMtimeMs: 4000,
    remoteIdentity: replacementPhysical,
  }, { now });
  assert.equal(replacement.status, "claimed");
  if (replacement.status !== "claimed") throw new Error("expected replacement stock claim");
  assert.deepEqual(
    await catalog.resolveRemoteIdentity(stockIdentity),
    firstStockPhysical,
    "the last verified alias stays readable while its replacement uploads",
  );
  assert.equal(
    await catalog.markVerified(replacement.claim, {
      ...stockDescriptor,
      identity: replacementPhysical,
      objectKey: mediaObjectKey(replacementPhysical),
      sizeBytes: 21,
      sha256: "c".repeat(64),
    }, now),
    true,
  );
  assert.deepEqual(
    await catalog.resolveRemoteIdentity(stockIdentity),
    replacementPhysical,
    "the alias switches only after the replacement blob is verified",
  );

  const gcIdentity = { area: "renders" as const, filename: "remote-gc.mp4" };
  await prisma.mediaObject.create({
    data: {
      area: gcIdentity.area,
      filename: gcIdentity.filename,
      objectKey: mediaObjectKey(gcIdentity),
      contentType: "video/mp4",
      sizeBytes: 30n,
      sha256: "e".repeat(64),
      remoteFilename: contentAddressedMediaIdentity(
        gcIdentity,
        "e".repeat(64),
      ).filename,
      remoteState: "verified",
      localState: "evicted",
      localMtimeMs: 5000n,
      lastVerifiedAt: now,
    },
  });
  const gcRow = (await catalog.remoteGcInventory()).find(
    (candidate) => candidate.objectKey === mediaObjectKey(gcIdentity),
  );
  assert(gcRow, "verified remote-only row participates in GC inventory");
  const pendingAt = new Date(now.getTime() + 60_000);
  const pending = await catalog.stageRemoteDelete(
    [{ id: gcRow.id, version: gcRow.version }],
    pendingAt,
  );
  assert(pending);
  assert.equal((await catalog.inspect(gcIdentity))?.remoteState, "delete_pending");
  assert.equal(
    await catalog.claimRemoteDelete(
      pending,
      now,
      new Date(now.getTime() + 120_000),
    ),
    null,
    "delete lease cannot be claimed before the grace deadline",
  );
  const deleteClaim = await catalog.claimRemoteDelete(
    pending,
    pendingAt,
    new Date(pendingAt.getTime() + 120_000),
  );
  assert(deleteClaim);
  assert.equal(await catalog.markRemoteDeleted(deleteClaim, pendingAt), true);
  assert.equal((await catalog.inspect(gcIdentity))?.remoteState, "deleted");

  const restoreIdentity = { area: "renders" as const, filename: "remote-restore.mp4" };
  await prisma.mediaObject.create({
    data: {
      area: restoreIdentity.area,
      filename: restoreIdentity.filename,
      objectKey: mediaObjectKey(restoreIdentity),
      contentType: "video/mp4",
      sizeBytes: 31n,
      sha256: "f".repeat(64),
      remoteFilename: contentAddressedMediaIdentity(
        restoreIdentity,
        "f".repeat(64),
      ).filename,
      remoteState: "verified",
      localState: "evicted",
      localMtimeMs: 6000n,
      lastVerifiedAt: now,
    },
  });
  const restoreRow = (await catalog.remoteGcInventory()).find(
    (candidate) => candidate.objectKey === mediaObjectKey(restoreIdentity),
  );
  assert(restoreRow);
  const restorePending = await catalog.stageRemoteDelete(
    [{ id: restoreRow.id, version: restoreRow.version }],
    pendingAt,
  );
  assert(restorePending);
  assert.equal(await catalog.restoreRemoteDeletePending(restorePending), true);
  assert.equal((await catalog.inspect(restoreIdentity))?.remoteState, "verified");

  const missingIdentity = { area: "renders" as const, filename: "missing-local.mp4" };
  const missingDescriptor = {
    ...descriptor,
    identity: missingIdentity,
    objectKey: mediaObjectKey(missingIdentity),
    canonicalUrl: "/api/renders/missing-local.mp4",
  };
  const missingClaim = await catalog.claim(
    { descriptor: missingDescriptor, localMtimeMs: 7000 },
    { now },
  );
  assert.equal(missingClaim.status, "claimed");
  if (missingClaim.status !== "claimed") throw new Error("expected missing-local claim");
  assert.equal(
    await catalog.markFailed(
      missingClaim.claim,
      new (await import("../src/lib/media-storage")).UnsafeMediaFileError(),
      now,
    ),
    true,
  );
  const missingRow = (await catalog.failedLocalInventory()).find(
    (candidate) => candidate.objectKey === mediaObjectKey(missingIdentity),
  );
  assert(missingRow, "failed local observation participates in reconciliation inventory");
  assert.equal(
    await catalog.abandonMissingFailed([
      { id: missingRow.id, version: missingRow.version },
    ]),
    true,
  );
  assert.deepEqual(
    await catalog.inspect(missingIdentity),
    {
      remoteState: "abandoned",
      localState: "missing",
      sizeBytes: 10n,
      sha256: null,
      remoteFilename: null,
      localMtimeMs: 7000n,
      lastVerifiedAt: null,
      nextRetryAt: null,
      lastErrorCode: "LocalMediaMissingUnreferenced",
    },
    "an abandoned observation keeps its audit row",
  );
  assert.equal(
    await catalog.abandonMissingFailed([
      { id: missingRow.id, version: missingRow.version },
    ]),
    false,
    "the abandoned observation cannot be changed twice",
  );
  const rediscovered = await catalog.claim(
    { descriptor: missingDescriptor, localMtimeMs: 7000 },
    { now },
  );
  assert.equal(
    rediscovered.status,
    "claimed",
    "a file that reappears after abandonment can re-enter backfill",
  );

  await prisma.$disconnect();
  console.log("PASS media catalog");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
