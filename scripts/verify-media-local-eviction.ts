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

function writeOldRender(filename: string, bytes: string, base = root): {
  absolutePath: string;
  sha256: string;
  mtimeMs: number;
} {
  const dir = path.join(base, "public", "renders");
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
    { runLocalMediaEviction, verifiedLocalReplica, evictionRunExitCode },
  ] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/media-catalog"),
    import("../src/lib/media-cleanup"),
    import("../src/lib/media-local-eviction"),
  ]);
  const catalog = new MediaCatalog(prisma);

  // HERO-41: a production-shaped scan is overwhelmingly catalog-unverified.
  // Selection must not turn that mix into one SQLite round trip per local file.
  const scanRoot = mkdtempSync(path.join(tmpdir(), "media-local-eviction-scan-"));
  const scanFiles = Array.from({ length: 450 }, (_, index) => {
    const name = `scan-${String(index).padStart(3, "0")}.mp4`;
    return { name, file: writeOldRender(name, `scan-${index}`, scanRoot) };
  });
  for (const { name, file } of scanFiles.slice(0, 5)) {
    await catalogRender(prisma, name, file);
  }
  await prisma.mediaObject.createMany({
    data: Array.from({ length: 501 }, (_, index) => ({
      area: "renders",
      filename: `unrelated-${String(index).padStart(3, "0")}.mp4`,
      objectKey: `media/v1/renders/unrelated-${String(index).padStart(3, "0")}.mp4`,
      contentType: "video/mp4",
      sizeBytes: 1n,
      sha256: "a".repeat(64),
      remoteState: "verified",
      localState: "present",
      localMtimeMs: BigInt(now.getTime()),
    })),
  });
  const scanPlan = await getMediaCleanupPlan({
    cwd: scanRoot,
    now,
    includeStocks: true,
  });
  let catalogReadOperations = 0;
  let maxCatalogBatchRequested = 0;
  let catalogRowsReturned = 0;
  const countedCatalog = new Proxy(catalog, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        (property === "inspect" || property === "localEvictionInventory") &&
        typeof value === "function"
      ) {
        return (...args: unknown[]) => {
          catalogReadOperations++;
          if (property === "localEvictionInventory") {
            maxCatalogBatchRequested = Math.max(
              maxCatalogBatchRequested,
              Array.isArray(args[0]) ? args[0].length : -1,
            );
          }
          const result = Reflect.apply(value, target, args);
          return Promise.resolve(result).then((rows) => {
            if (property === "localEvictionInventory" && Array.isArray(rows)) {
              catalogRowsReturned += rows.length;
            }
            return rows;
          });
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const singleCandidatePlan = {
    ...scanPlan,
    candidates: scanPlan.candidates.slice(0, 1),
  };
  const deadlineRemote = new FakeVerifier();
  const deadlineCatalog = new Proxy(catalog, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "localEvictionInventory") {
        return async (...args: unknown[]) => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return Reflect.apply(value, target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const deadlineReport = await runLocalMediaEviction(singleCandidatePlan, {
    mode: "dry-run",
    now,
    catalog: deadlineCatalog,
    remote: deadlineRemote,
    maxObjects: 1,
    maxBytes: 1024,
    yieldDeadlineAt: Date.now() + 10,
    env: {
      MEDIA_READ_MODE: "r2-local",
      MEDIA_LOCAL_EVICTION: "0",
      MEDIA_R2_DELETE: "0",
    },
  });
  let becameBusy = false;
  const busyRemote = new FakeVerifier();
  const busyCatalog = new Proxy(catalog, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "localEvictionInventory") {
        return async (...args: unknown[]) => {
          const rows = await Reflect.apply(value, target, args);
          becameBusy = true;
          return rows;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const busyReport = await runLocalMediaEviction(singleCandidatePlan, {
    mode: "dry-run",
    now,
    catalog: busyCatalog,
    remote: busyRemote,
    maxObjects: 1,
    maxBytes: 1024,
    shouldYield: () => becameBusy,
    env: {
      MEDIA_READ_MODE: "r2-local",
      MEDIA_LOCAL_EVICTION: "0",
      MEDIA_R2_DELETE: "0",
    },
  });
  const scanRemote = new FakeVerifier();
  const scanReport = await runLocalMediaEviction(scanPlan, {
    mode: "dry-run",
    now,
    catalog: countedCatalog,
    remote: scanRemote,
    maxObjects: 2,
    maxBytes: 1024,
    env: {
      MEDIA_READ_MODE: "r2-local",
      MEDIA_LOCAL_EVICTION: "0",
      MEDIA_R2_DELETE: "0",
    },
  });
  assert.equal(scanReport.scanned, 450);
  assert.equal(scanReport.skipped.catalog_unverified, 445);
  assert.equal(scanReport.skipped.limit, 3);
  assert.equal(scanReport.eligible.count, 2);
  assert.equal(scanRemote.calls, 2, "only selected replicas reach remote verification");
  assert.deepEqual(
    {
      deadlineReason: deadlineReport.deferredReason ?? null,
      deadlineRemoteCalls: deadlineRemote.calls,
      busyReason: busyReport.deferredReason ?? null,
      busyRemoteCalls: busyRemote.calls,
      catalogReadOperations,
      maxCatalogBatchRequested,
      catalogRowsReturned,
    },
    {
      deadlineReason: "runtime_budget",
      deadlineRemoteCalls: 0,
      busyReason: "customer_media_active",
      busyRemoteCalls: 0,
      catalogReadOperations: 3,
      maxCatalogBatchRequested: 200,
      catalogRowsReturned: 5,
    },
    "catalog reads must stay plan-bounded and yield after awaited query boundaries",
  );

  // The inventory is only a selection snapshot. Every selected row must still
  // survive the existing per-object compare-and-set inspection before quarantine.
  const raceRoot = mkdtempSync(path.join(tmpdir(), "media-local-eviction-race-"));
  const raceNames = {
    changedSha: "race-changed-sha.mp4",
    missingRemote: "race-missing-remote.mp4",
    deletedRow: "race-deleted-row.mp4",
    newlyVerified: "race-newly-verified.mp4",
  };
  const raceFiles = new Map(
    Object.values(raceNames).map((name) => [name, writeOldRender(name, name, raceRoot)]),
  );
  for (const name of Object.values(raceNames)) {
    await catalogRender(prisma, name, raceFiles.get(name)!);
  }
  const missingRemoteFile = raceFiles.get(raceNames.missingRemote)!;
  await prisma.mediaObject.update({
    where: { objectKey: `media/v1/renders/${raceNames.missingRemote}` },
    data: { remoteFilename: `sha256-${missingRemoteFile.sha256}.mp4` },
  });
  await prisma.mediaObject.update({
    where: { objectKey: `media/v1/renders/${raceNames.newlyVerified}` },
    data: { remoteState: "failed" },
  });
  const racePlan = await getMediaCleanupPlan({ cwd: raceRoot, now, includeStocks: true });
  let inventoryRead = false;
  const racingCatalog = new Proxy(catalog, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "localEvictionInventory") {
        return async (...args: unknown[]) => {
          const inventory = await Reflect.apply(value, target, args);
          inventoryRead = true;
          await prisma.mediaObject.update({
            where: { objectKey: `media/v1/renders/${raceNames.changedSha}` },
            data: { sha256: "b".repeat(64) },
          });
          await prisma.mediaObject.update({
            where: { objectKey: `media/v1/renders/${raceNames.missingRemote}` },
            data: { remoteFilename: null },
          });
          await prisma.mediaObject.delete({
            where: { objectKey: `media/v1/renders/${raceNames.deletedRow}` },
          });
          await prisma.mediaObject.update({
            where: { objectKey: `media/v1/renders/${raceNames.newlyVerified}` },
            data: { remoteState: "verified" },
          });
          return inventory;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const raceRemote = new FakeVerifier();
  const raceReport = await runLocalMediaEviction(racePlan, {
    mode: "apply",
    now,
    catalog: racingCatalog,
    remote: raceRemote,
    maxObjects: 10,
    maxBytes: 1024 * 1024,
    env: {
      MEDIA_READ_MODE: "r2-local",
      MEDIA_LOCAL_EVICTION: "1",
      MEDIA_R2_DELETE: "0",
    },
  });
  assert.equal(inventoryRead, true);
  assert.equal(raceReport.evicted.count, 0);
  assert.equal(raceReport.skipped.changed, 3);
  assert.equal(raceReport.skipped.catalog_unverified, 1);
  assert.equal(raceReport.errors, 0);
  assert.equal(raceRemote.calls, 3, "only rows present in the snapshot receive preflight verification");
  for (const file of raceFiles.values()) {
    assert.equal(existsSync(file.absolutePath), true, "catalog races must preserve every local file");
  }

  const casRoot = mkdtempSync(path.join(tmpdir(), "media-local-eviction-cas-"));
  const casName = "race-after-quarantine.mp4";
  const casFile = writeOldRender(casName, "restore-after-catalog-race", casRoot);
  await catalogRender(prisma, casName, casFile);
  const casPlan = await getMediaCleanupPlan({ cwd: casRoot, now, includeStocks: true });
  const casCatalog = new Proxy(catalog, {
    get(target, property) {
      if (property === "markLocalEvicted") return async () => false;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const casReport = await runLocalMediaEviction(casPlan, {
    mode: "apply",
    now,
    catalog: casCatalog,
    remote: new FakeVerifier(),
    maxObjects: 1,
    maxBytes: 1024,
    env: {
      MEDIA_READ_MODE: "r2-local",
      MEDIA_LOCAL_EVICTION: "1",
      MEDIA_R2_DELETE: "0",
    },
  });
  assert.equal(casReport.evicted.count, 0);
  assert.equal(casReport.skipped.catalog_changed, 1);
  assert.equal(casReport.errors, 0);
  assert.equal(existsSync(casFile.absolutePath), true, "CAS loss after quarantine must restore the file");
  assert.equal(readFileSync(casFile.absolutePath, "utf8"), "restore-after-catalog-race");

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

  // The gate itself: it must throttle by count AND by time, and latch once fired,
  // so polling the database for activity can never become the load it relieves.
  {
    const { createYieldGate } = await import("../src/lib/media-job-yield");
    let checks = 0;
    let clock = 0;
    const gate = createYieldGate(
      () => {
        checks += 1;
        return checks > 2;
      },
      { everyItems: 3, minIntervalMs: 1_000, now: () => clock },
    );
    assert.equal(await gate(), null);
    assert.equal(await gate(), null);
    assert.equal(checks, 0, "the check must not run before everyItems iterations");
    assert.equal(await gate(), null);
    assert.equal(checks, 1, "third iteration polls once");
    clock = 500;
    assert.equal(await gate(), null);
    assert.equal(await gate(), null);
    assert.equal(await gate(), null);
    assert.equal(checks, 1, "a poll inside minIntervalMs is suppressed");
    clock = 2_000;
    assert.equal(await gate(), null);
    assert.equal(await gate(), null);
    assert.equal(await gate(), null);
    assert.equal(checks, 2, "the next interval polls again");
    clock = 4_000;
    assert.equal(await gate(), null);
    assert.equal(await gate(), null);
    assert.equal(await gate(), "customer_media_active", "third poll fires");
    assert.equal(await gate(), "customer_media_active", "and latches without polling again");
    assert.equal(checks, 3, "a latched gate never re-queries");
    assert.equal(await createYieldGate(undefined)(), null, "no check and no deadline means never yield");

    // The runtime budget is what bounds a run on an IDLE box, where the activity
    // check never fires because no customer work ever arrives to displace it.
    let budgetClock = 0;
    let budgetChecks = 0;
    const budgeted = createYieldGate(
      () => {
        budgetChecks += 1;
        return false;
      },
      { everyItems: 1, minIntervalMs: 0, deadlineAt: 1_000, now: () => budgetClock },
    );
    assert.equal(await budgeted(), null);
    budgetClock = 999;
    assert.equal(await budgeted(), null);
    budgetClock = 1_000;
    assert.equal(await budgeted(), "runtime_budget", "the deadline fires on an idle box");
    assert.equal(await budgeted(), "runtime_budget", "and latches");
    assert.equal(budgetChecks, 2, "the deadline short-circuits before querying activity");

    const budgetOnly = createYieldGate(undefined, { deadlineAt: 5, now: () => 10 });
    assert.equal(
      await budgetOnly(),
      "runtime_budget",
      "a budget works without --deferWhenBusy",
    );
  }

  // HERO-41: --deferWhenBusy must be re-evaluated while the run is in flight, not
  // only at process start. A run that begins on an idle box must hand the machine
  // back when customer renders arrive, instead of holding a core for 100+ minutes.
  const yieldNames = ["evict-yield-a.mp4", "evict-yield-b.mp4"];
  const yieldRoot = mkdtempSync(path.join(tmpdir(), "media-local-eviction-yield-"));
  const yieldFiles = yieldNames.map((name) => writeOldRender(name, `yield-${name}`, yieldRoot));
  for (const [index, name] of yieldNames.entries()) {
    await catalogRender(prisma, name, yieldFiles[index]);
  }
  const yieldEnv = {
    MEDIA_READ_MODE: "r2-local",
    MEDIA_LOCAL_EVICTION: "1",
    MEDIA_R2_DELETE: "0",
  };

  const selectionPlan = await getMediaCleanupPlan({ cwd: yieldRoot, now, includeStocks: true });
  const selectionVerifier = new FakeVerifier();
  const deferredDuringSelection = await runLocalMediaEviction(selectionPlan, {
    mode: "apply",
    now,
    catalog,
    remote: selectionVerifier,
    maxObjects: 10,
    maxBytes: 1024 * 1024,
    env: yieldEnv,
    yieldEveryItems: 1,
    yieldMinIntervalMs: 0,
    shouldYield: () => true,
  });
  assert.equal(
    deferredDuringSelection.deferredReason,
    "customer_media_active",
    "a busy box during the scan must be reported as a deferral, not a completed run",
  );
  assert.equal(deferredDuringSelection.evicted.count, 0);
  for (const file of yieldFiles) {
    assert.equal(existsSync(file.absolutePath), true, "nothing may be deleted after yielding");
  }
  assert.ok(
    selectionVerifier.calls < yieldNames.length,
    "yielding must stop the scan early rather than finish it and discard the work",
  );

  // The apply phase checks only BETWEEN whole objects, so work that appears
  // during one eviction cannot strand it mid-quarantine or start the next one.
  const evictionPlan = await getMediaCleanupPlan({ cwd: yieldRoot, now, includeStocks: true });
  assert.equal(evictionPlan.candidates.length, yieldNames.length, "yield fixtures must be the only candidates");
  const evictionVerifier = new FakeVerifier();
  const deferredDuringEviction = await runLocalMediaEviction(evictionPlan, {
    mode: "apply",
    now,
    catalog,
    remote: evictionVerifier,
    maxObjects: 10,
    maxBytes: 1024 * 1024,
    env: yieldEnv,
    shouldYield: () => evictionVerifier.calls > yieldNames.length,
  });
  assert.equal(deferredDuringEviction.deferredReason, "customer_media_active");
  assert.equal(
    deferredDuringEviction.evicted.count,
    1,
    "the object in flight when the gate fired must finish, and the next one must not start",
  );
  assert.equal(
    yieldFiles.filter((file) => existsSync(file.absolutePath)).length,
    1,
    "exactly one of the two fixtures survives a mid-apply yield",
  );

  const budgetPlan = await getMediaCleanupPlan({ cwd: yieldRoot, now, includeStocks: true });
  const budgetRun = await runLocalMediaEviction(budgetPlan, {
    mode: "apply",
    now,
    catalog,
    remote: new FakeVerifier(),
    maxObjects: 10,
    maxBytes: 1024 * 1024,
    env: yieldEnv,
    yieldDeadlineAt: 0,
  });
  assert.equal(
    budgetRun.deferredReason,
    "runtime_budget",
    "an expired budget stops the scan even with no customer work and no shouldYield",
  );
  assert.equal(budgetRun.evicted.count, 0);

  // HERO-41 second defect: one failed object out of hundreds exited 1 and made
  // systemd mark the unit FAILED. Only a run that achieved nothing may exit non-zero.
  assert.equal(
    evictionRunExitCode({ errors: 1, evicted: { count: 326 } }, { errors: 0, reconciled: { count: 0 } }),
    0,
    "326 of 327 evicted is a successful run that reports one error",
  );
  assert.equal(
    evictionRunExitCode({ errors: 2, evicted: { count: 0 } }, { errors: 0, reconciled: { count: 0 } }),
    1,
    "errors with nothing achieved still needs a human",
  );
  assert.equal(
    evictionRunExitCode({ errors: 1, evicted: { count: 0 } }, { errors: 0, reconciled: { count: 4 } }),
    0,
    "reconciliation progress counts as work achieved",
  );
  assert.equal(
    evictionRunExitCode({ errors: 0, evicted: { count: 0 } }, { errors: 0, reconciled: { count: 0 } }),
    0,
    "a clean no-op run is not a failure",
  );

  await prisma.$disconnect();
  console.log("PASS verified local media eviction, rollback, busy-yield and exit code");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
