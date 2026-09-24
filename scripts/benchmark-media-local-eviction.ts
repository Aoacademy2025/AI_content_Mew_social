import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { MediaCatalog } from "../src/lib/media-catalog";

const root = mkdtempSync(path.join(tmpdir(), "hero41-media-eviction-benchmark-"));
const databasePath = path.join(root, "benchmark.db");
const fileCount = 18_865;
const verifiedCount = 938;
const evictionCount = 326;
const bytes = Buffer.alloc(4 * 1024, 0x41);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const now = new Date("2026-09-23T12:00:00.000Z");
const old = new Date(now.getTime() - 20 * 86_400_000);
const renderRoot = path.join(root, "public", "renders");
const filenames = Array.from(
  { length: fileCount },
  (_, index) => `fixture-${String(index).padStart(5, "0")}.mp4`,
);
const rolloutEnv = {
  MEDIA_READ_MODE: "r2-local",
  MEDIA_LOCAL_EVICTION: "1",
  MEDIA_R2_DELETE: "0",
};

process.env.DATABASE_URL = `file:${databasePath}`;
execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
  cwd: path.resolve(__dirname, ".."),
  env: process.env,
  stdio: "ignore",
});

type Timing = { calls: number; totalMs: number; maxMs: number };
type Timings = Record<string, Timing>;

async function timed<T>(timings: Timings, name: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await run();
  } finally {
    const elapsed = performance.now() - started;
    const timing = timings[name] ?? { calls: 0, totalMs: 0, maxMs: 0 };
    timing.calls += 1;
    timing.totalMs += elapsed;
    timing.maxMs = Math.max(timing.maxMs, elapsed);
    timings[name] = timing;
  }
}

function roundTimings(timings: Timings): Record<string, {
  calls: number;
  totalMs: number;
  averageMs: number;
  maxMs: number;
}> {
  return Object.fromEntries(Object.entries(timings).map(([name, timing]) => [name, {
    calls: timing.calls,
    totalMs: Number(timing.totalMs.toFixed(1)),
    averageMs: Number((timing.totalMs / timing.calls).toFixed(3)),
    maxMs: Number(timing.maxMs.toFixed(1)),
  }]));
}

function profiledCatalog(catalog: MediaCatalog, timings: Timings): MediaCatalog {
  return new Proxy(catalog, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => timed(
        timings,
        `catalog.${String(property)}`,
        () => Reflect.apply(value, target, args),
      );
    },
  });
}

function writeFixtureFile(filename: string): void {
  const absolutePath = path.join(renderRoot, filename);
  writeFileSync(absolutePath, bytes);
  utimesSync(absolutePath, old, old);
}

async function main(): Promise<void> {
  const [
    { prisma },
    { MediaCatalog, LOCAL_EVICTION_CATALOG_BATCH_SIZE },
    { getMediaCleanupPlan },
    { runLocalMediaEviction },
    { reconcileMissingVerifiedLocalMedia },
    { activeCustomerMediaJobs, hasActiveCustomerMediaJobs },
  ] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/media-catalog"),
    import("../src/lib/media-cleanup"),
    import("../src/lib/media-local-eviction"),
    import("../src/lib/media-local-missing-reconcile"),
    import("../src/lib/customer-media-activity"),
  ]);
  mkdirSync(renderRoot, { recursive: true });
  for (const filename of filenames) writeFixtureFile(filename);
  await prisma.mediaObject.createMany({
    data: filenames.slice(0, verifiedCount).map((filename) => ({
      area: "renders",
      filename,
      objectKey: `media/v1/renders/${filename}`,
      contentType: "video/mp4",
      sizeBytes: BigInt(bytes.length),
      sha256,
      remoteState: "verified",
      localState: "present",
      localMtimeMs: BigInt(old.getTime()),
    })),
  });

  const catalog = new MediaCatalog(prisma);
  const runs = [];
  for (let index = 0; index < 3; index++) {
    if (index > 0) {
      for (const filename of filenames.slice(0, evictionCount)) writeFixtureFile(filename);
      await prisma.mediaObject.updateMany({
        where: { filename: { in: filenames.slice(0, evictionCount) } },
        data: { localState: "present" },
      });
    }

    const rssBefore = process.memoryUsage().rss;

    const reconcileTimings: Timings = {};
    const reconcileStarted = performance.now();
    const reconciliation = await reconcileMissingVerifiedLocalMedia({
      mode: "apply",
      cwd: root,
      now,
      catalog: profiledCatalog(catalog, reconcileTimings),
      remote: {
        verifyReplica: (input) => timed(
          reconcileTimings,
          "remote.verifyReplica",
          async () => Boolean(input),
        ),
      },
      quarantinedKeys: new Set(),
      maxObjects: evictionCount,
      maxBytes: 50 * 1024 * 1024 * 1024,
      env: rolloutEnv,
      shouldYield: () => timed(
        reconcileTimings,
        "activity.activeCustomerMediaJobs",
        async () => hasActiveCustomerMediaJobs(await activeCustomerMediaJobs()),
      ),
    });
    const reconcileMs = performance.now() - reconcileStarted;
    assert.equal(reconciliation.scanned, verifiedCount);
    assert.equal(reconciliation.eligible.count, 0);
    assert.equal(reconciliation.reconciled.count, 0);
    assert.equal(reconciliation.errors, 0);

    const planStarted = performance.now();
    const plan = await getMediaCleanupPlan({ cwd: root, now, includeStocks: true });
    const planMs = performance.now() - planStarted;

    const selectionTimings: Timings = {};
    const selectionStarted = performance.now();
    const selection = await runLocalMediaEviction(plan, {
      mode: "dry-run",
      now,
      catalog: profiledCatalog(catalog, selectionTimings),
      remote: {
        verifyReplica: (input) => timed(
          selectionTimings,
          "remote.verifyReplica",
          async () => Boolean(input),
        ),
      },
      maxObjects: evictionCount,
      maxBytes: 50 * 1024 * 1024 * 1024,
      env: rolloutEnv,
      shouldYield: () => timed(
        selectionTimings,
        "activity.activeCustomerMediaJobs",
        async () => hasActiveCustomerMediaJobs(await activeCustomerMediaJobs()),
      ),
    });
    const selectionMs = performance.now() - selectionStarted;
    assert.equal(selection.eligible.count, evictionCount);
    assert.equal(selection.evicted.count, 0);
    assert.equal(selection.errors, 0);

    const selectionActivityChecks = Math.ceil(
      plan.candidates.length / LOCAL_EVICTION_CATALOG_BATCH_SIZE,
    ) * 2;
    async function applyRun(activityAtEverySafeBoundary: boolean) {
      const timings: Timings = {};
      let activityGateCalls = 0;
      const started = performance.now();
      const report = await runLocalMediaEviction(plan, {
        mode: "apply",
        now,
        catalog: profiledCatalog(catalog, timings),
        remote: {
          verifyReplica: (input) => timed(
            timings,
            "remote.verifyReplica",
            async () => Boolean(input),
          ),
        },
        maxObjects: evictionCount,
        maxBytes: 50 * 1024 * 1024 * 1024,
        env: rolloutEnv,
        shouldYield: async () => {
          activityGateCalls++;
          if (!activityAtEverySafeBoundary && activityGateCalls > selectionActivityChecks) {
            return false;
          }
          return timed(
            timings,
            activityGateCalls <= selectionActivityChecks
              ? "activity.selection"
              : "activity.safeApplyBoundary",
            async () => hasActiveCustomerMediaJobs(await activeCustomerMediaJobs()),
          );
        },
      });
      return {
        report,
        elapsedMs: performance.now() - started,
        activityGateCalls,
        timings,
      };
    }

    const preFixSimulation = await applyRun(false);
    for (const filename of filenames.slice(0, evictionCount)) writeFixtureFile(filename);
    await prisma.mediaObject.updateMany({
      where: { filename: { in: filenames.slice(0, evictionCount) } },
      data: { localState: "present" },
    });
    const fixed = await applyRun(true);
    const { report } = fixed;
    const evictionMs = fixed.elapsedMs;
    assert.deepEqual(
      report,
      preFixSimulation.report,
      "safe-boundary activity checks must not change the cleanup result on an idle fixture",
    );
    assert.equal(report.scanned, fileCount);
    assert.equal(report.skipped.catalog_unverified, fileCount - verifiedCount);
    assert.equal(report.skipped.limit, verifiedCount - evictionCount);
    assert.equal(report.evicted.count, evictionCount);
    assert.equal(report.errors, 0);
    assert.equal(fixed.timings["remote.verifyReplica"]?.calls, evictionCount * 2);
    assert.equal(fixed.timings["catalog.markLocalEvicted"]?.calls, evictionCount);
    assert.equal(preFixSimulation.timings["activity.selection"]?.calls, selectionActivityChecks);
    assert.equal(fixed.timings["activity.selection"]?.calls, selectionActivityChecks);
    assert.equal(fixed.timings["activity.safeApplyBoundary"]?.calls, evictionCount);
    assert.equal(fixed.activityGateCalls, selectionActivityChecks + evictionCount);

    runs.push({
      run: index + 1,
      phasesMs: {
        missingLocalReconciliation: Math.round(reconcileMs),
        cleanupPlanning: Math.round(planMs),
        evictionSelectionDryRun: Math.round(selectionMs),
        preFixDefaultPollingSimulation: Math.round(preFixSimulation.elapsedMs),
        fixedSafeBoundaryPolling: Math.round(evictionMs),
        fixedMinusPreFixSimulation: Math.round(evictionMs - preFixSimulation.elapsedMs),
        totalActualRunnerPath: Math.round(reconcileMs + planMs + evictionMs),
      },
      rssBeforeMiB: Math.round(rssBefore / 1024 / 1024),
      rssAfterMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      operations: {
        missingLocalReconciliation: roundTimings(reconcileTimings),
        evictionSelectionDryRun: roundTimings(selectionTimings),
        preFixDefaultPollingSimulation: roundTimings(preFixSimulation.timings),
        fixedSafeBoundaryPolling: roundTimings(fixed.timings),
      },
      outcome: {
        scanned: report.scanned,
        catalogUnverified: report.skipped.catalog_unverified,
        limited: report.skipped.limit,
        evicted: report.evicted.count,
        errors: report.errors,
      },
    });
  }

  console.log(JSON.stringify({
    fixture: {
      files: fileCount,
      verifiedCatalogRows: verifiedCount,
      selectedEvictions: evictionCount,
      bytesPerFile: bytes.length,
      fakeRemoteLatencyMs: 0,
      activityChecksUseDisposableSqlite: true,
      preFixSimulation: "selection queries run; safe-boundary callbacks return false without SQLite",
    },
    runs,
  }, null, 2));
  await prisma.$disconnect();
}

main()
  .finally(() => rmSync(root, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
