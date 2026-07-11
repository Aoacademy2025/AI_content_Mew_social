import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { createAdminCleanupReviewCoordinator } from "../src/lib/admin-cleanup-review";
import {
  buildQuarantinedMediaIndex,
  fingerprintMediaRecord,
  manifestSha256ForRecords,
  pathIsStrictlyAbsent,
  purgeMediaQuarantine,
  restoreQuarantineRun,
  writeMediaCleanupReviewArtifact,
  writeMediaHealthMetrics,
} from "../src/lib/media-quarantine";

const first = {
  key: "renders/example.mp4" as const,
  absolutePath: "/fixture-a/public/renders/example.mp4",
  sizeBytes: 42,
  mtimeMs: 1_700_000_000_000,
  effectiveExpiresAt: "2026-07-10T00:00:00.000Z",
  reason: "all_references_expired" as const,
};
const second = { ...first, absolutePath: "/fixture-b/public/renders/example.mp4" };

assert.equal(
  fingerprintMediaRecord(first),
  fingerprintMediaRecord(second),
  "fingerprints use only key, size, and mtime",
);
assert.notEqual(
  manifestSha256ForRecords([{ ...first, fingerprint: fingerprintMediaRecord(first) }]),
  manifestSha256ForRecords([{ ...second, fingerprint: fingerprintMediaRecord(second) }]),
  "review hashes cover the mutation-relevant absolute path",
);

const missingPathError = Object.assign(new Error("missing"), { code: "ENOENT" });
const permissionPathError = Object.assign(new Error("indeterminate"), { code: "EACCES" });
assert.equal(
  pathIsStrictlyAbsent("/not-observed", () => { throw missingPathError; }),
  true,
  "strict absence accepts only a missing-path result",
);
assert.throws(
  () => pathIsStrictlyAbsent("/not-observed", () => { throw permissionPathError; }),
  /indeterminate original path/,
  "strict absence propagates indeterminate lstat failures",
);

const REPO_ROOT = process.cwd();
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), "media-quarantine-"));
const DATABASE_URL = `file:${join(FIXTURE_ROOT, "media-quarantine.db")}`;
const NOW = new Date("2026-07-20T00:00:00.000Z");
const DAY_MS = 86_400_000;
const EXTERNAL_ROOTS: string[] = [];

process.env.DATABASE_URL = DATABASE_URL;
mkdirSync(join(FIXTURE_ROOT, "public", "renders"), { recursive: true });
mkdirSync(join(FIXTURE_ROOT, "stocks"), { recursive: true });
execFileSync(
  join(REPO_ROOT, "node_modules", ".bin", "prisma"),
  ["db", "push", "--skip-generate"],
  { cwd: REPO_ROOT, env: process.env, stdio: "pipe" },
);

function atDays(days: number): Date {
  return new Date(NOW.getTime() + days * DAY_MS);
}

function writeMedia(filename: string, days: number, area: "renders" | "stocks" = "renders"): string {
  const filePath = area === "renders"
    ? join(FIXTURE_ROOT, "public", "renders", filename)
    : join(FIXTURE_ROOT, "stocks", filename);
  writeFileSync(filePath, `${area}/${filename}`);
  utimesSync(filePath, atDays(days), atDays(days));
  return filePath;
}

function fsNames(dir: string): string[] {
  return readdirSync(dir).sort();
}

function singleRecordPlan<T extends { candidates: Array<{ key: string }> }>(
  plan: T,
  key: string,
): T {
  const record = plan.candidates.find((candidate) => candidate.key === key);
  assert.ok(
    record,
    `expected cleanup record ${key}; graphErrors=${JSON.stringify(
      (plan as T & { graphErrors?: unknown }).graphErrors,
    )}`,
  );
  return {
    ...plan,
    candidates: [record],
    manifestSha256: manifestSha256ForRecords([record]),
  };
}

async function seed(prisma: PrismaClient): Promise<void> {
  await prisma.user.create({
    data: {
      id: "quarantine-user",
      name: "Quarantine User",
      email: "quarantine@example.test",
      plan: "BUSINESS",
    },
  });
  await prisma.video.createMany({
    data: [
      {
        id: "quarantine-expired",
        userId: "quarantine-user",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        videoUrl: "/api/renders/expired-owned.mp4",
        expiresAt: atDays(-1),
      },
      {
        id: "quarantine-live",
        userId: "quarantine-user",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        videoUrl: "/api/renders/live-owned.mp4",
        expiresAt: atDays(1),
      },
      {
        id: "quarantine-null",
        userId: "quarantine-user",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        videoUrl: "/api/renders/null-owned.mp4",
        expiresAt: null,
      },
      {
        id: "quarantine-shared-expired",
        userId: "quarantine-user",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        videoUrl: "/api/renders/shared-owned.mp4",
        expiresAt: atDays(-2),
      },
      {
        id: "quarantine-shared-live",
        userId: "quarantine-user",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        videoUrl: "/api/renders/shared-owned.mp4",
        expiresAt: atDays(2),
      },
    ],
  });
}

let prisma: PrismaClient | undefined;

async function main(): Promise<void> {
  let resolveOldReview!: (value: string) => void;
  let resolveCurrentReview!: (value: string) => void;
  const oldReview = new Promise<string>((resolve) => { resolveOldReview = resolve; });
  const currentReview = new Promise<string>((resolve) => { resolveCurrentReview = resolve; });
  const reviewCoordinator = createAdminCleanupReviewCoordinator({
    olderThanDays: 3,
    includeStocks: false,
    includeTmp: false,
  });
  const oldRequest = reviewCoordinator.request(async (selection) => {
    assert.equal(selection.olderThanDays, 3);
    return oldReview;
  });
  reviewCoordinator.setSelection({
    olderThanDays: 7,
    includeStocks: true,
    includeTmp: false,
  });
  const currentRequest = reviewCoordinator.request(async (selection) => {
    assert.deepEqual(selection, {
      olderThanDays: 7,
      includeStocks: true,
      includeTmp: false,
    });
    return currentReview;
  });
  resolveCurrentReview("current");
  assert.deepEqual(await currentRequest, {
    current: true,
    ok: true,
    selection: { olderThanDays: 7, includeStocks: true, includeTmp: false },
    value: "current",
  });
  resolveOldReview("stale");
  assert.equal((await oldRequest).current, false, "older deferred GET cannot become current");
  const postDeleteRefresh = await reviewCoordinator.request(async (selection) => selection);
  assert.deepEqual(
    postDeleteRefresh.ok ? postDeleteRefresh.value : null,
    { olderThanDays: 7, includeStocks: true, includeTmp: false },
    "a stable post-DELETE refresh reads the latest selection instead of an old closure",
  );

  const oldOrphanPath = writeMedia("orphan-15d.mp4", -15);
  const youngOrphanPath = writeMedia("orphan-14d-boundary.mp4", -14);
  const expiredPath = writeMedia("expired-owned.mp4", -30);
  const livePath = writeMedia("live-owned.mp4", -30);
  const nullPath = writeMedia("null-owned.mp4", -30);
  const sharedPath = writeMedia("shared-owned.mp4", -30);
  const oldStockPath = writeMedia("orphan-stock.mp4", -30, "stocks");
  const outsidePath = join(FIXTURE_ROOT, "outside.mp4");
  writeFileSync(outsidePath, "outside");
  const symlinkPath = join(FIXTURE_ROOT, "public", "renders", "escape-link.mp4");
  symlinkSync(outsidePath, symlinkPath);

  process.chdir(FIXTURE_ROOT);
  const [prismaModule, cleanupModule] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/media-cleanup"),
  ]);
  prisma = prismaModule.prisma;
  await seed(prisma);

  const before = new Map([
    [oldOrphanPath, lstatSync(oldOrphanPath).mtimeMs],
    [youngOrphanPath, lstatSync(youngOrphanPath).mtimeMs],
    [expiredPath, lstatSync(expiredPath).mtimeMs],
    [livePath, lstatSync(livePath).mtimeMs],
    [nullPath, lstatSync(nullPath).mtimeMs],
    [sharedPath, lstatSync(sharedPath).mtimeMs],
    [oldStockPath, lstatSync(oldStockPath).mtimeMs],
    [symlinkPath, lstatSync(symlinkPath).mtimeMs],
  ]);

  const plan = await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW });
  assert.equal(plan.graphErrors.length, 0);
  assert.deepEqual(
    plan.candidates.map((record) => record.key),
    ["renders/expired-owned.mp4", "renders/orphan-15d.mp4"],
    "only all-expired refs and orphans older than 14 days are eligible",
  );
  assert.equal(
    plan.candidates.some((record) => record.key === "renders/orphan-14d-boundary.mp4"),
    false,
    "the exact orphan boundary remains protected",
  );
  for (const protectedKey of [
    "renders/live-owned.mp4",
    "renders/null-owned.mp4",
    "renders/shared-owned.mp4",
    "renders/escape-link.mp4",
    "stocks/orphan-stock.mp4",
  ]) {
    assert.equal(
      plan.candidates.some((record) => record.key === protectedKey),
      false,
      `${protectedKey} must not be selected by the default dry-run`,
    );
  }
  assert.deepEqual(
    Object.keys(plan.candidates[0]).sort(),
    [
      "absolutePath",
      "effectiveExpiresAt",
      "fingerprint",
      "key",
      "mtimeMs",
      "reason",
      "sizeBytes",
    ],
    "manifest records expose exactly the stable reviewed fields",
  );
  assert.equal(
    plan.manifestSha256,
    manifestSha256ForRecords(plan.candidates),
    "plan hash covers the stable manifest records",
  );
  assert.equal(
    (await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW })).manifestSha256,
    plan.manifestSha256,
    "the same filesystem and clock produce the same reviewed hash",
  );
  for (const [filePath, mtimeMs] of before) {
    assert.equal(existsSync(filePath), true, `dry-run preserves ${filePath}`);
    assert.equal(lstatSync(filePath).mtimeMs, mtimeMs, `dry-run does not touch ${filePath}`);
  }

  const planWithStocks = await cleanupModule.getMediaCleanupPlan({
    cwd: FIXTURE_ROOT,
    now: NOW,
    includeStocks: true,
  });
  const defaultMetricsPath = await writeMediaHealthMetrics(plan, { cwd: FIXTURE_ROOT, now: NOW });
  const defaultScopeMetrics = JSON.parse(readFileSync(defaultMetricsPath, "utf8")) as {
    expired: number;
    candidates: number;
  };
  const stockMetricsPath = await writeMediaHealthMetrics(planWithStocks, { cwd: FIXTURE_ROOT, now: NOW });
  const stockScopeMetrics = JSON.parse(readFileSync(stockMetricsPath, "utf8")) as {
    expired: number;
    candidates: number;
  };
  assert.equal(
    defaultScopeMetrics.expired,
    stockScopeMetrics.expired,
    "expired health counts all scanned customer media independent of apply scope",
  );
  assert.equal(
    stockScopeMetrics.candidates,
    defaultScopeMetrics.candidates + 1,
    "only reviewed candidates change when stocks are explicitly selected",
  );
  const reviewArtifact = await writeMediaCleanupReviewArtifact(plan, {
    cwd: FIXTURE_ROOT,
    now: NOW,
  });
  assert.equal(reviewArtifact, ".ops-metrics/media-cleanup-review.json");
  const reviewArtifactPath = join(FIXTURE_ROOT, reviewArtifact);
  assert.equal(lstatSync(reviewArtifactPath).mode & 0o777, 0o600);
  const reviewPayload = JSON.parse(readFileSync(reviewArtifactPath, "utf8")) as {
    manifestSha256: string;
    candidates: unknown[];
  };
  assert.equal(reviewPayload.manifestSha256, plan.manifestSha256);
  assert.deepEqual(reviewPayload.candidates, plan.candidates);
  rmSync(join(FIXTURE_ROOT, ".ops-metrics"), { recursive: true, force: true });
  if (process.argv.includes("--metrics-only")) {
    console.log("PASS media health scope semantics");
    return;
  }

  const earlySymlinkPlan = singleRecordPlan(plan, "renders/orphan-15d.mp4");
  const earlyOutsideQuarantineRoot = mkdtempSync(join(tmpdir(), "media-quarantine-ancestor-red-"));
  EXTERNAL_ROOTS.push(earlyOutsideQuarantineRoot);
  symlinkSync(earlyOutsideQuarantineRoot, join(FIXTURE_ROOT, ".media-quarantine"));
  await assert.rejects(
    cleanupModule.applyMediaCleanupPlan(
      earlySymlinkPlan,
      earlySymlinkPlan.manifestSha256,
      { now: NOW },
    ),
    /unsafe operation directory/,
    "a symlinked .media-quarantine ancestor cannot redirect a rename outside cwd",
  );
  assert.equal(existsSync(oldOrphanPath), true);
  assert.deepEqual(fsNames(earlyOutsideQuarantineRoot), []);
  rmSync(join(FIXTURE_ROOT, ".media-quarantine"), { force: true });

  const earlyOutsideMetricsRoot = mkdtempSync(join(tmpdir(), "media-metrics-ancestor-red-"));
  EXTERNAL_ROOTS.push(earlyOutsideMetricsRoot);
  symlinkSync(earlyOutsideMetricsRoot, join(FIXTURE_ROOT, ".ops-metrics"));
  await assert.rejects(
    writeMediaHealthMetrics(plan, { cwd: FIXTURE_ROOT, now: NOW }),
    /unsafe operation directory/,
    "a symlinked .ops-metrics ancestor cannot redirect an atomic write outside cwd",
  );
  assert.deepEqual(fsNames(earlyOutsideMetricsRoot), []);
  rmSync(join(FIXTURE_ROOT, ".ops-metrics"), { force: true });
  if (process.argv.includes("--symlink-only")) {
    console.log("PASS media quarantine ancestor containment");
    return;
  }

  await assert.rejects(
    cleanupModule.applyMediaCleanupPlan(plan, "0".repeat(64), { now: NOW }),
    /reviewed manifest hash mismatch/,
    "an unreviewed manifest cannot move customer media",
  );
  assert.equal(existsSync(oldOrphanPath), true, "hash mismatch moves zero files");
  assert.equal(existsSync(expiredPath), true, "hash mismatch preserves referenced candidates");

  await prisma.video.create({
    data: {
      id: "quarantine-malformed",
      userId: "quarantine-user",
      avatarModel: "none",
      voiceModel: "none",
      sceneCount: 1,
      renderConfig: "{not-json",
      expiresAt: atDays(-1),
    },
  });
  const incompletePlan = await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW });
  assert.ok(incompletePlan.graphErrors.some((error) => error.code === "malformed_json"));
  assert.equal(incompletePlan.candidates.length, 0, "an incomplete graph yields no movable manifest");
  await assert.rejects(
    cleanupModule.applyMediaCleanupPlan(incompletePlan, incompletePlan.manifestSha256, { now: NOW }),
    /media graph incomplete/,
  );
  assert.equal(existsSync(oldOrphanPath), true, "malformed owner JSON yields zero moves");
  await prisma.video.delete({ where: { id: "quarantine-malformed" } });

  const recheckPath = writeMedia("reference-added-after-plan.mp4", -30);
  const recheckFullPlan = await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW });
  const recheckRecord = recheckFullPlan.candidates.find(
    (record) => record.key === "renders/reference-added-after-plan.mp4",
  );
  assert.ok(recheckRecord, "old orphan is eligible before a new reference is created");
  const recheckPlan = {
    ...recheckFullPlan,
    candidates: [recheckRecord],
    manifestSha256: manifestSha256ForRecords([recheckRecord]),
  };
  await prisma.video.create({
    data: {
      id: "quarantine-reference-added",
      userId: "quarantine-user",
      avatarModel: "none",
      voiceModel: "none",
      sceneCount: 1,
      videoUrl: "/api/renders/reference-added-after-plan.mp4",
      expiresAt: atDays(2),
    },
  });
  const recheckSafetyPlan = await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW });
  assert.equal(
    recheckSafetyPlan.graphErrors.length,
    0,
    `reference recheck graph must remain complete: ${JSON.stringify(recheckSafetyPlan.graphErrors)}`,
  );
  const rechecked = await cleanupModule.applyMediaCleanupPlan(
    recheckPlan,
    recheckPlan.manifestSha256,
    { now: NOW, batchSize: 1 },
  );
  assert.equal(rechecked.quarantined.count, 0);
  assert.equal(rechecked.skipped.count, 1);
  assert.equal(existsSync(recheckPath), true, "a live reference added after planning prevents move");

  const changedPath = writeMedia("changed-after-plan.mp4", -30);
  const changedFullPlan = await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW });
  const changedRecord = changedFullPlan.candidates.find(
    (record) => record.key === "renders/changed-after-plan.mp4",
  );
  assert.ok(changedRecord);
  const changedPlan = {
    ...changedFullPlan,
    candidates: [changedRecord],
    manifestSha256: manifestSha256ForRecords([changedRecord]),
  };
  utimesSync(changedPath, atDays(-29), atDays(-29));
  const changed = await cleanupModule.applyMediaCleanupPlan(
    changedPlan,
    changedPlan.manifestSha256,
    { now: NOW },
  );
  assert.equal(changed.quarantined.count, 0);
  assert.equal(changed.skipped.count, 1, "mtime fingerprint change is skipped at apply");
  assert.equal(existsSync(changedPath), true);

  const tamperedRecord = {
    ...plan.candidates[0],
    key: "renders/../outside.mp4" as const,
    absolutePath: outsidePath,
  };
  tamperedRecord.fingerprint = fingerprintMediaRecord(tamperedRecord);
  const tamperedPlan = {
    ...plan,
    candidates: [tamperedRecord],
    manifestSha256: manifestSha256ForRecords([tamperedRecord]),
  };
  await assert.rejects(
    cleanupModule.applyMediaCleanupPlan(tamperedPlan, tamperedPlan.manifestSha256, { now: NOW }),
    /invalid media manifest record/,
    "a re-hashed traversal manifest still fails canonical containment",
  );
  assert.equal(readFileSync(outsidePath, "utf8"), "outside");

  const restorePath = writeMedia("restore-me.mp4", -30);
  const restorePlan = singleRecordPlan(
    await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW }),
    "renders/restore-me.mp4",
  );
  const quarantinedForRestore = await cleanupModule.applyMediaCleanupPlan(
    restorePlan,
    restorePlan.manifestSha256,
    { now: NOW, batchSize: 1 },
  );
  assert.equal(quarantinedForRestore.quarantined.count, 1);
  assert.ok(quarantinedForRestore.runId);
  assert.equal(existsSync(restorePath), false);
  const restoreManifestPath = join(
    FIXTURE_ROOT,
    ".media-quarantine",
    quarantinedForRestore.runId,
    "manifest.json",
  );
  assert.equal(existsSync(restoreManifestPath), true, "quarantine manifest is committed after moves");
  const restored = await restoreQuarantineRun(quarantinedForRestore.runId, {
    cwd: FIXTURE_ROOT,
    now: NOW,
  });
  assert.equal(restored.restored.count, 1);
  assert.equal(existsSync(restorePath), true, "restore moves the unchanged file back");
  await assert.doesNotReject(
    buildQuarantinedMediaIndex(FIXTURE_ROOT),
    "a restored record is ignored without invalidating its intact manifest",
  );

  const collisionPath = writeMedia("restore-collision.mp4", -30);
  await assert.doesNotReject(
    buildQuarantinedMediaIndex(FIXTURE_ROOT),
    "new source files do not invalidate the quarantine index",
  );
  const collisionPlan = singleRecordPlan(
    await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW }),
    "renders/restore-collision.mp4",
  );
  const collisionRun = await cleanupModule.applyMediaCleanupPlan(
    collisionPlan,
    collisionPlan.manifestSha256,
    { now: NOW },
  );
  writeFileSync(collisionPath, "new-file-must-win");
  const collisionRestore = await restoreQuarantineRun(collisionRun.runId, {
    cwd: FIXTURE_ROOT,
    now: NOW,
  });
  assert.equal(collisionRestore.restored.count, 0);
  assert.equal(collisionRestore.skipped.count, 1, "restore collision is reported and skipped");
  assert.equal(readFileSync(collisionPath, "utf8"), "new-file-must-win");

  const restoreRacePath = writeMedia("restore-collision-race.mp4", -30);
  const restoreRacePlan = singleRecordPlan(
    await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW }),
    "renders/restore-collision-race.mp4",
  );
  const restoreRaceRun = await cleanupModule.applyMediaCleanupPlan(
    restoreRacePlan,
    restoreRacePlan.manifestSha256,
    { now: NOW },
  );
  const restoreRace = await restoreQuarantineRun(restoreRaceRun.runId, {
    cwd: FIXTURE_ROOT,
    now: NOW,
    beforeMove: async (record) => {
      writeFileSync(record.absolutePath, "concurrent-restore-output");
    },
  });
  assert.equal(restoreRace.restored.count, 0);
  assert.equal(restoreRace.skipped.count, 1, "atomic restore collision is skipped");
  assert.equal(readFileSync(restoreRacePath, "utf8"), "concurrent-restore-output");
  assert.equal(
    existsSync(join(
      FIXTURE_ROOT,
      ".media-quarantine",
      restoreRaceRun.runId,
      "renders",
      "restore-collision-race.mp4",
    )),
    true,
    "collision leaves the quarantined source recoverable",
  );

  const rollbackPath = writeMedia("rollback-manifest-failure.mp4", -30);
  const rollbackPlan = singleRecordPlan(
    await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW }),
    "renders/rollback-manifest-failure.mp4",
  );
  await assert.rejects(
    cleanupModule.applyMediaCleanupPlan(
      rollbackPlan,
      rollbackPlan.manifestSha256,
      {
        now: NOW,
        writeManifest: async () => {
          throw new Error("forced atomic manifest write failure");
        },
      },
    ),
    /forced atomic manifest write failure/,
  );
  assert.equal(existsSync(rollbackPath), true, "manifest failure rolls every move back");
  assert.equal(
    readFileSync(rollbackPath, "utf8"),
    "renders/rollback-manifest-failure.mp4",
    "rollback restores the original bytes",
  );

  const rollbackRacePath = writeMedia("rollback-collision-race.mp4", -30);
  const rollbackRacePlan = singleRecordPlan(
    await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW }),
    "renders/rollback-collision-race.mp4",
  );
  let rollbackRaceError: unknown;
  try {
    await cleanupModule.applyMediaCleanupPlan(
      rollbackRacePlan,
      rollbackRacePlan.manifestSha256,
      {
        now: NOW,
        writeManifest: async () => {
          throw new Error("force rollback collision race");
        },
        beforeRollbackMove: async (record) => {
          writeFileSync(record.absolutePath, "concurrent-rollback-output");
        },
      },
    );
    assert.fail("forced rollback failure must reject");
  } catch (error) {
    rollbackRaceError = error;
  }
  assert.equal(readFileSync(rollbackRacePath, "utf8"), "concurrent-rollback-output");
  assert.equal(
    (rollbackRaceError as { operationReport?: { errors?: { count?: number } } })
      .operationReport?.errors?.count,
    1,
    "atomic rollback collision is reported without overwrite",
  );

  const unresolvedRollbackPath = writeMedia("rollback-collision-recovery.mp4", -30);
  const unresolvedRollbackPlan = singleRecordPlan(
    await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW }),
    "renders/rollback-collision-recovery.mp4",
  );
  let unresolvedRunId = "";
  let unresolvedRollbackError: unknown;
  try {
    await cleanupModule.applyMediaCleanupPlan(
      unresolvedRollbackPlan,
      unresolvedRollbackPlan.manifestSha256,
      {
        now: NOW,
        writeManifest: async (_manifestPath, manifest) => {
          writeFileSync(unresolvedRollbackPath, "concurrent-original-collision");
          unresolvedRunId = manifest.runId;
          throw new Error("forced manifest failure with rollback collision");
        },
      },
    );
    assert.fail("manifest failure must reject");
  } catch (error) {
    unresolvedRollbackError = error;
    assert.match(String(error), /forced manifest failure with rollback collision/);
  }
  assert.equal(
    (unresolvedRollbackError as { operationReport?: { errors?: { count?: number } } })
      .operationReport?.errors?.count,
    1,
    "rollback collision is surfaced in the operation report",
  );
  assert.equal(readFileSync(unresolvedRollbackPath, "utf8"), "concurrent-original-collision");
  assert.equal(
    existsSync(join(
      FIXTURE_ROOT,
      ".media-quarantine",
      unresolvedRunId,
      "renders",
      "rollback-collision-recovery.mp4",
    )),
    true,
    "failed rollback preserves the only quarantined copy for manual recovery",
  );

  const disabledPurgePath = writeMedia("purge-disabled.mp4", -30);
  const disabledPurgePlan = singleRecordPlan(
    await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW }),
    "renders/purge-disabled.mp4",
  );
  const disabledPurgeRun = await cleanupModule.applyMediaCleanupPlan(
    disabledPurgePlan,
    disabledPurgePlan.manifestSha256,
    { now: NOW },
  );
  const disabledPurgeQuarantinePath = join(
    FIXTURE_ROOT,
    ".media-quarantine",
    disabledPurgeRun.runId,
    "renders",
    "purge-disabled.mp4",
  );
  let disabledPurgeError: unknown;
  try {
    await purgeMediaQuarantine({
      cwd: FIXTURE_ROOT,
      now: new Date(NOW.getTime() + 25 * 60 * 60 * 1000),
    });
  } catch (error) {
    disabledPurgeError = error;
  }
  assert.match(String(disabledPurgeError), /permanent purge disabled pending shared writer exclusion/);
  assert.equal(
    (disabledPurgeError as { operationReport?: { errors?: { count?: number } } })
      .operationReport?.errors?.count,
    1,
    "disabled purge reports a nonzero error tally",
  );
  assert.equal(existsSync(disabledPurgePath), false);
  assert.equal(
    existsSync(disabledPurgeQuarantinePath),
    true,
    "disabled purge preserves the only quarantined copy",
  );
  await prisma.video.create({
    data: {
      id: "quarantine-disabled-purge-live-reference",
      userId: "quarantine-user",
      avatarModel: "none",
      voiceModel: "none",
      sceneCount: 1,
      videoUrl: "/api/renders/purge-disabled.mp4",
      expiresAt: atDays(3),
    },
  });
  let forgedBarrierRan = false;
  await assert.rejects(
    purgeMediaQuarantine({
      cwd: FIXTURE_ROOT,
      writerBarrier: {
        runExclusive: async (operation: () => Promise<unknown>) => {
          forgedBarrierRan = true;
          return operation();
        },
      },
    } as Parameters<typeof purgeMediaQuarantine>[0]),
    /permanent purge disabled pending shared writer exclusion/,
    "an actual live reference remains protected when a caller supplies a forged barrier object",
  );
  assert.equal(forgedBarrierRan, false);
  assert.equal(existsSync(disabledPurgeQuarantinePath), true);
  await prisma.video.delete({ where: { id: "quarantine-disabled-purge-live-reference" } });
  await restoreQuarantineRun(disabledPurgeRun.runId, { cwd: FIXTURE_ROOT, now: NOW });

  const metricsPlan = await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW });
  const metricsPath = await writeMediaHealthMetrics(metricsPlan, {
    cwd: FIXTURE_ROOT,
    now: NOW,
  });
  const metricsRaw = readFileSync(metricsPath, "utf8");
  const metrics = JSON.parse(metricsRaw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(metrics).sort(), [
    "candidates",
    "expired",
    "generatedAt",
    "graphErrors",
    "missingBeforeExpiry",
    "protected",
  ]);
  assert.equal(metrics.graphErrors, 0);
  assert.doesNotMatch(metricsRaw, /quarantine-user|api\/renders|media-quarantine-|[/\\]Users[/\\]/);

  const restoreDespiteGraphPath = writeMedia("restore-despite-graph-error.mp4", -30);
  const restoreDespiteGraphPlan = singleRecordPlan(
    await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW }),
    "renders/restore-despite-graph-error.mp4",
  );
  const restoreDespiteGraphRun = await cleanupModule.applyMediaCleanupPlan(
    restoreDespiteGraphPlan,
    restoreDespiteGraphPlan.manifestSha256,
    { now: NOW },
  );
  assert.equal(existsSync(restoreDespiteGraphPath), false);

  await prisma.video.create({
    data: {
      id: "quarantine-metrics-malformed",
      userId: "quarantine-user",
      avatarModel: "none",
      voiceModel: "none",
      sceneCount: 1,
      renderConfig: "{not-json",
      expiresAt: atDays(-1),
    },
  });
  const failedMetricsPlan = await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW });
  await assert.rejects(
    writeMediaHealthMetrics(failedMetricsPlan, { cwd: FIXTURE_ROOT, now: NOW }),
    /media graph incomplete/,
  );
  assert.equal(
    readFileSync(metricsPath, "utf8"),
    metricsRaw,
    "an incomplete graph cannot overwrite the last good sanitized metrics",
  );
  const restoredDespiteGraph = await restoreQuarantineRun(restoreDespiteGraphRun.runId, {
    cwd: FIXTURE_ROOT,
    now: NOW,
  });
  assert.equal(restoredDespiteGraph.restored.count, 1, "restore remains available during graph incidents");
  assert.equal(existsSync(restoreDespiteGraphPath), true);
  await prisma.video.delete({ where: { id: "quarantine-metrics-malformed" } });

  const restoreHierarchyPath = writeMedia("restore-area-symlink.mp4", -30);
  const restoreHierarchyPlan = singleRecordPlan(
    await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW }),
    "renders/restore-area-symlink.mp4",
  );
  const restoreHierarchyRun = await cleanupModule.applyMediaCleanupPlan(
    restoreHierarchyPlan,
    restoreHierarchyPlan.manifestSha256,
    { now: NOW },
  );
  const restoreAreaPath = join(
    FIXTURE_ROOT,
    ".media-quarantine",
    restoreHierarchyRun.runId,
    "renders",
  );
  const outsideRestoreHierarchy = mkdtempSync(join(tmpdir(), "media-restore-area-symlink-"));
  EXTERNAL_ROOTS.push(outsideRestoreHierarchy);
  const outsideRestoreArea = join(outsideRestoreHierarchy, "renders");
  renameSync(restoreAreaPath, outsideRestoreArea);
  symlinkSync(outsideRestoreArea, restoreAreaPath);
  await assert.rejects(
    restoreQuarantineRun(restoreHierarchyRun.runId, { cwd: FIXTURE_ROOT, now: NOW }),
    /unsafe quarantine path/,
    "restore rejects a symlinked quarantine area instead of renaming an external file",
  );
  assert.equal(existsSync(restoreHierarchyPath), false);
  assert.equal(existsSync(join(outsideRestoreArea, "restore-area-symlink.mp4")), true);
  rmSync(restoreAreaPath, { force: true });
  renameSync(outsideRestoreArea, restoreAreaPath);
  await restoreQuarantineRun(restoreHierarchyRun.runId, { cwd: FIXTURE_ROOT, now: NOW });

  const concurrentPath = writeMedia("concurrent-run-claim.mp4", -30);
  const concurrentPlan = singleRecordPlan(
    await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW }),
    "renders/concurrent-run-claim.mp4",
  );
  const firstConcurrentRun = await cleanupModule.applyMediaCleanupPlan(
    concurrentPlan,
    concurrentPlan.manifestSha256,
    { now: NOW },
  );
  const firstConcurrentManifestPath = join(
    FIXTURE_ROOT,
    ".media-quarantine",
    firstConcurrentRun.runId,
    "manifest.json",
  );
  const firstConcurrentManifest = readFileSync(firstConcurrentManifestPath, "utf8");
  await restoreQuarantineRun(firstConcurrentRun.runId, { cwd: FIXTURE_ROOT, now: NOW });
  const secondConcurrentRun = await cleanupModule.applyMediaCleanupPlan(
    concurrentPlan,
    concurrentPlan.manifestSha256,
    { now: NOW },
  );
  assert.notEqual(
    secondConcurrentRun.runId,
    firstConcurrentRun.runId,
    "same-millisecond applies receive isolated unique run directories",
  );
  await restoreQuarantineRun(secondConcurrentRun.runId, { cwd: FIXTURE_ROOT, now: NOW });
  await assert.rejects(
    cleanupModule.applyMediaCleanupPlan(
      concurrentPlan,
      concurrentPlan.manifestSha256,
      {
        now: NOW,
        runIdFactory: () => firstConcurrentRun.runId,
      },
    ),
    /quarantine run already exists/,
    "exclusive run-directory claim rejects a collision before moving media",
  );
  assert.equal(readFileSync(firstConcurrentManifestPath, "utf8"), firstConcurrentManifest);
  assert.equal(existsSync(concurrentPath), true, "collision failure leaves the source untouched");

  const expiredProjectPath = writeMedia("expired-project-post-metrics.mp4", -30);
  await prisma.editorProject.create({
    data: {
      id: "quarantine-expired-project",
      userId: "quarantine-user",
      draftJson: JSON.stringify({ clipUrl: "/api/renders/expired-project-post-metrics.mp4" }),
    },
  });
  const expiredProjectPlan = singleRecordPlan(
    await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW }),
    "renders/expired-project-post-metrics.mp4",
  );
  const expiredProjectRun = await cleanupModule.applyMediaCleanupPlan(
    expiredProjectPlan,
    expiredProjectPlan.manifestSha256,
    { now: NOW },
  );
  assert.equal(existsSync(expiredProjectPath), false);
  const expiredProjectPostPlan = await cleanupModule.getMediaCleanupPlan({
    cwd: FIXTURE_ROOT,
    now: NOW,
  });
  assert.equal(
    expiredProjectPostPlan.graphErrors.length,
    0,
    "intentional quarantine of an expired project file keeps post-apply graph complete",
  );
  await writeMediaHealthMetrics(expiredProjectPostPlan, { cwd: FIXTURE_ROOT, now: NOW });
  assert.equal(
    existsSync(join(
      FIXTURE_ROOT,
      ".media-quarantine",
      expiredProjectRun.runId,
      "renders",
      "expired-project-post-metrics.mp4",
    )),
    true,
    "expired project media remains recoverable in quarantine",
  );
  await restoreQuarantineRun(expiredProjectRun.runId, { cwd: FIXTURE_ROOT, now: NOW });
  assert.equal(existsSync(expiredProjectPath), true);
  await prisma.editorProject.delete({ where: { id: "quarantine-expired-project" } });

  const restoredProjectPath = writeMedia("restored-project-then-missing.mp4", -30);
  await prisma.editorProject.create({
    data: {
      id: "quarantine-restored-project",
      userId: "quarantine-user",
      draftJson: JSON.stringify({ clipUrl: "/api/renders/restored-project-then-missing.mp4" }),
    },
  });
  const restoredProjectPlan = singleRecordPlan(
    await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW }),
    "renders/restored-project-then-missing.mp4",
  );
  const restoredProjectRun = await cleanupModule.applyMediaCleanupPlan(
    restoredProjectPlan,
    restoredProjectPlan.manifestSha256,
    { now: NOW },
  );
  await restoreQuarantineRun(restoredProjectRun.runId, { cwd: FIXTURE_ROOT, now: NOW });
  rmSync(restoredProjectPath);
  const missingAfterRestorePlan = await cleanupModule.getMediaCleanupPlan({
    cwd: FIXTURE_ROOT,
    now: NOW,
  });
  assert.ok(
    missingAfterRestorePlan.graphErrors.some((error) =>
      error.ownerId === "quarantine-restored-project" && error.code === "media_file_missing"
    ),
    "restored media later removed without a purge tombstone remains fail-closed",
  );
  await prisma.editorProject.delete({ where: { id: "quarantine-restored-project" } });

  const historicalIntentPath = writeMedia("historical-purge-intent.mp4", -30);
  await prisma.editorProject.create({
    data: {
      id: "quarantine-historical-purge-intent",
      userId: "quarantine-user",
      draftJson: JSON.stringify({ clipUrl: "/api/renders/historical-purge-intent.mp4" }),
    },
  });
  const historicalIntentPlan = singleRecordPlan(
    await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW }),
    "renders/historical-purge-intent.mp4",
  );
  const historicalIntentRun = await cleanupModule.applyMediaCleanupPlan(
    historicalIntentPlan,
    historicalIntentPlan.manifestSha256,
    { now: NOW },
  );
  assert.equal(existsSync(historicalIntentPath), false);
  const historicalManifestPath = join(
    FIXTURE_ROOT,
    ".media-quarantine",
    historicalIntentRun.runId,
    "manifest.json",
  );
  const historicalManifest = JSON.parse(readFileSync(historicalManifestPath, "utf8")) as {
    version: 1;
    runId: string;
    generatedAt: string;
    reviewedManifestSha256: string;
    recordsSha256: string;
    records: Array<{ key: string; fingerprint: string }>;
    purgeIntents: Array<{ key: string; fingerprint: string; markedAt: string }>;
    stateSha256: string;
  };
  const historicalRecord = historicalManifest.records.find(
    (record) => record.key === "renders/historical-purge-intent.mp4",
  );
  assert.ok(historicalRecord);
  historicalManifest.purgeIntents = [{
    key: historicalRecord.key,
    fingerprint: historicalRecord.fingerprint,
    markedAt: new Date(NOW.getTime() + 25 * 60 * 60 * 1000).toISOString(),
  }];
  historicalManifest.stateSha256 = createHash("sha256").update(JSON.stringify({
    version: historicalManifest.version,
    runId: historicalManifest.runId,
    generatedAt: historicalManifest.generatedAt,
    reviewedManifestSha256: historicalManifest.reviewedManifestSha256,
    recordsSha256: historicalManifest.recordsSha256,
    purgeIntents: historicalManifest.purgeIntents,
  })).digest("hex");
  writeFileSync(historicalManifestPath, `${JSON.stringify(historicalManifest, null, 2)}\n`);
  rmSync(join(
    FIXTURE_ROOT,
    ".media-quarantine",
    historicalIntentRun.runId,
    "renders",
    "historical-purge-intent.mp4",
  ));
  const historicalIntentPostPlan = await cleanupModule.getMediaCleanupPlan({
    cwd: FIXTURE_ROOT,
    now: new Date(NOW.getTime() + 25 * 60 * 60 * 1000),
  });
  assert.equal(
    historicalIntentPostPlan.graphErrors.length,
    0,
    "historical integrity-checked purge intents remain readable without enabling new purge",
  );
  writeMedia("historical-purge-intent.mp4", -30);
  const newerHistoricalNow = new Date(NOW.getTime() + 26 * 60 * 60 * 1000);
  const newerHistoricalPlan = singleRecordPlan(
    await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: newerHistoricalNow }),
    "renders/historical-purge-intent.mp4",
  );
  const newerHistoricalRun = await cleanupModule.applyMediaCleanupPlan(
    newerHistoricalPlan,
    newerHistoricalPlan.manifestSha256,
    { now: newerHistoricalNow },
  );
  await restoreQuarantineRun(newerHistoricalRun.runId, {
    cwd: FIXTURE_ROOT,
    now: newerHistoricalNow,
  });
  rmSync(historicalIntentPath);
  const newerHistoricalMissingPlan = await cleanupModule.getMediaCleanupPlan({
    cwd: FIXTURE_ROOT,
    now: newerHistoricalNow,
  });
  assert.ok(
    newerHistoricalMissingPlan.graphErrors.some((error) =>
      error.ownerId === "quarantine-historical-purge-intent" &&
      error.code === "media_file_missing"
    ),
    "a newer restored-then-missing lifecycle overrides an older historical purge intent",
  );
  await prisma.editorProject.delete({ where: { id: "quarantine-historical-purge-intent" } });
  rmSync(join(FIXTURE_ROOT, ".media-quarantine", historicalIntentRun.runId), {
    recursive: true,
    force: true,
  });
  rmSync(join(FIXTURE_ROOT, ".media-quarantine", newerHistoricalRun.runId), {
    recursive: true,
    force: true,
  });

  await prisma.editorProject.create({
    data: {
      id: "quarantine-unexpected-missing-project",
      userId: "quarantine-user",
      draftJson: JSON.stringify({ clipUrl: "/api/renders/unexpected-missing-project.mp4" }),
    },
  });
  const unexpectedMissingPlan = await cleanupModule.getMediaCleanupPlan({
    cwd: FIXTURE_ROOT,
    now: NOW,
  });
  assert.ok(
    unexpectedMissingPlan.graphErrors.some((error) =>
      error.ownerId === "quarantine-unexpected-missing-project" &&
      error.code === "media_file_missing"
    ),
    "a missing project file without a validated quarantine copy remains fail-closed",
  );
  await prisma.editorProject.delete({ where: { id: "quarantine-unexpected-missing-project" } });

  const tamperedAgePath = writeMedia("purge-tampered-age.mp4", -30);
  const tamperedAgePlan = singleRecordPlan(
    await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW }),
    "renders/purge-tampered-age.mp4",
  );
  const tamperedAgeRun = await cleanupModule.applyMediaCleanupPlan(
    tamperedAgePlan,
    tamperedAgePlan.manifestSha256,
    { now: NOW },
  );
  const tamperedManifestPath = join(
    FIXTURE_ROOT,
    ".media-quarantine",
    tamperedAgeRun.runId,
    "manifest.json",
  );
  const tamperedManifest = JSON.parse(readFileSync(tamperedManifestPath, "utf8")) as {
    generatedAt: string;
  } & Record<string, unknown>;
  tamperedManifest.generatedAt = atDays(-10).toISOString();
  writeFileSync(tamperedManifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`);
  const tamperedGraphPlan = await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW });
  assert.ok(
    tamperedGraphPlan.graphErrors.some((error) => error.code === "quarantine_manifest_invalid"),
    "tampered quarantine metadata makes the graph fail closed",
  );
  assert.equal(tamperedGraphPlan.candidates.length, 0);
  assert.equal(existsSync(tamperedAgePath), false);
  assert.equal(
    existsSync(join(
      FIXTURE_ROOT,
      ".media-quarantine",
      tamperedAgeRun.runId,
      "renders",
      "purge-tampered-age.mp4",
    )),
    true,
  );
  rmSync(join(FIXTURE_ROOT, ".media-quarantine", tamperedAgeRun.runId), {
    recursive: true,
    force: true,
  });

  const symlinkCandidatePath = writeMedia("quarantine-root-symlink.mp4", -30);
  const symlinkCandidatePlan = singleRecordPlan(
    await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW }),
    "renders/quarantine-root-symlink.mp4",
  );
  rmSync(join(FIXTURE_ROOT, ".media-quarantine"), { recursive: true, force: true });
  const outsideQuarantineRoot = mkdtempSync(join(tmpdir(), "media-quarantine-outside-"));
  symlinkSync(outsideQuarantineRoot, join(FIXTURE_ROOT, ".media-quarantine"));
  await assert.rejects(
    cleanupModule.applyMediaCleanupPlan(
      symlinkCandidatePlan,
      symlinkCandidatePlan.manifestSha256,
      { now: NOW },
    ),
    /unsafe operation directory/,
    "a symlinked quarantine ancestor cannot redirect customer media outside cwd",
  );
  assert.equal(existsSync(symlinkCandidatePath), true);
  assert.deepEqual(fsNames(outsideQuarantineRoot), []);
  rmSync(join(FIXTURE_ROOT, ".media-quarantine"), { force: true });
  rmSync(outsideQuarantineRoot, { recursive: true, force: true });

  rmSync(join(FIXTURE_ROOT, ".ops-metrics"), { recursive: true, force: true });
  const outsideMetricsRoot = mkdtempSync(join(tmpdir(), "media-metrics-outside-"));
  symlinkSync(outsideMetricsRoot, join(FIXTURE_ROOT, ".ops-metrics"));
  await assert.rejects(
    writeMediaHealthMetrics(metricsPlan, { cwd: FIXTURE_ROOT, now: NOW }),
    /unsafe operation directory/,
    "a symlinked metrics ancestor cannot redirect the atomic file outside cwd",
  );
  assert.deepEqual(fsNames(outsideMetricsRoot), []);
  rmSync(join(FIXTURE_ROOT, ".ops-metrics"), { force: true });
  rmSync(outsideMetricsRoot, { recursive: true, force: true });

  const cliSource = readFileSync(join(REPO_ROOT, "scripts", "media-cleanup.ts"), "utf8");
  const adminSource = readFileSync(
    join(REPO_ROOT, "src", "app", "api", "admin", "cleanup", "route.ts"),
    "utf8",
  );
  const adminPageSource = readFileSync(
    join(REPO_ROOT, "src", "app", "(dashboard)", "admin", "page.tsx"),
    "utf8",
  );
  const quarantineSource = readFileSync(
    join(REPO_ROOT, "src", "lib", "media-quarantine.ts"),
    "utf8",
  );
  const opsRunbookSource = readFileSync(
    join(REPO_ROOT, "docs", "ops", "ops-guardrails-runbook.md"),
    "utf8",
  );
  assert.match(cliSource, /--manifestSha256/);
  assert.match(cliSource, /--restore-run=/);
  assert.match(cliSource, /purge-quarantine/);
  assert.match(cliSource, /permanent purge disabled pending shared writer exclusion/);
  assert.doesNotMatch(cliSource, /purgeMediaQuarantine/);
  assert.match(cliSource, /writeMediaCleanupReviewArtifact/);
  assert.ok(
    cliSource.lastIndexOf("writeMediaHealthMetrics") < cliSource.lastIndexOf("writeCronHeartbeat"),
    "metrics must complete before the cleanup heartbeat advances",
  );
  const cliApplyIndex = cliSource.indexOf("await applyMediaCleanupPlan");
  assert.ok(
    cliSource.indexOf("getMediaCleanupPlan", cliApplyIndex + 1) > cliApplyIndex,
    "CLI apply rebuilds the plan after mutations for fresh health metrics",
  );
  assert.match(adminSource, /apply\s*!==\s*true/);
  assert.match(adminSource, /manifestSha256/);
  assert.match(adminSource, /candidates:\s*plan\.candidates/);
  assert.doesNotMatch(adminSource, /purgeMediaQuarantine|restoreQuarantineRun/);
  assert.doesNotMatch(adminSource, /\{\s*error:\s*message\s*\}/, "admin never echoes raw internal errors");
  const adminApplyIndex = adminSource.indexOf("await applyMediaCleanupPlan");
  assert.ok(
    adminSource.indexOf("getMediaCleanupPlan", adminApplyIndex + 1) > adminApplyIndex,
    "admin apply rebuilds the plan after mutations for fresh health metrics",
  );
  assert.match(adminPageSource, /new URLSearchParams/);
  assert.match(adminPageSource, /createAdminCleanupReviewCoordinator/);
  assert.match(adminPageSource, /cleanupReviewCoordinator\.current\.request/);
  assert.match(adminPageSource, /olderThanDays:\s*String\(selection\.olderThanDays\)/);
  assert.match(adminPageSource, /includeStocks:\s*selection\.includeStocks\s*\?\s*"1"\s*:\s*"0"/);
  assert.match(adminPageSource, /includeTmp:\s*selection\.includeTmp\s*\?\s*"1"\s*:\s*"0"/);
  assert.match(adminPageSource, /\/api\/admin\/cleanup\?\$\{params\.toString\(\)\}/);
  assert.match(adminPageSource, /apply:\s*true/);
  assert.match(adminPageSource, /manifestSha256:\s*review\.manifestSha256/);
  assert.match(adminPageSource, /olderThanDays:\s*review\.selected\.olderThanDays/);
  assert.match(adminPageSource, /includeStocks:\s*review\.selected\.includeStocks/);
  assert.match(adminPageSource, /includeTmp:\s*review\.selected\.includeTmp/);
  assert.match(adminPageSource, /res\.status\s*===\s*409/);
  assert.match(adminPageSource, /setCleanupInfo\(null\)/);
  assert.match(adminPageSource, /result\?\.quarantined\?\.count/);
  assert.match(adminPageSource, /cleanupInfo\.manifestSha256\.slice/);
  assert.doesNotMatch(adminPageSource, /purge-quarantine|purgeMediaQuarantine/);
  assert.match(opsRunbookSource, /permanent purge is disabled pending shared writer exclusion/i);
  assert.doesNotMatch(opsRunbookSource, /closes the race/i);
  const purgeFunctionIndex = quarantineSource.indexOf("export async function purgeMediaQuarantine");
  const nextFunctionIndex = quarantineSource.indexOf(
    "export async function writeMediaHealthMetrics",
    purgeFunctionIndex,
  );
  const purgeSource = quarantineSource.slice(purgeFunctionIndex, nextFunctionIndex);
  assert.ok(purgeFunctionIndex >= 0 && nextFunctionIndex > purgeFunctionIndex);
  assert.match(purgeSource, /permanent purge disabled pending shared writer exclusion/);
  assert.doesNotMatch(purgeSource, /\b(?:unlink|rm)\s*\(|buildMediaReferenceGraph|writerBarrier/);

  const tsconfigPath = join(REPO_ROOT, "tsconfig.json");
  const tsxLoader = join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
  const cleanupScript = join(REPO_ROOT, "scripts", "media-cleanup.ts");
  const spawnCleanupCli = (args: string[], heartbeatDir: string) => spawnSync(
    process.execPath,
    ["--import", tsxLoader, cleanupScript, ...args],
    {
      cwd: FIXTURE_ROOT,
      env: {
        ...process.env,
        DATABASE_URL,
        HEARTBEAT_DIR: heartbeatDir,
        TSX_TSCONFIG_PATH: tsconfigPath,
      },
      encoding: "utf8",
    },
  );
  const successfulHeartbeatDir = join(FIXTURE_ROOT, "heartbeat-success");
  const successfulCli = spawnCleanupCli([], successfulHeartbeatDir);
  assert.equal(successfulCli.status, 0, successfulCli.stderr);
  assert.equal(existsSync(join(successfulHeartbeatDir, "media-cleanup")), true);
  assert.equal(existsSync(join(FIXTURE_ROOT, ".ops-metrics", "media-health.json")), true);
  assert.doesNotMatch(successfulCli.stdout, new RegExp(FIXTURE_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const successfulCliOutput = JSON.parse(successfulCli.stdout) as {
    reviewArtifact?: string;
    manifestSha256?: string;
  };
  assert.equal(successfulCliOutput.reviewArtifact, ".ops-metrics/media-cleanup-review.json");
  assert.match(successfulCliOutput.manifestSha256 ?? "", /^[a-f0-9]{64}$/);

  const missingHashHeartbeatDir = join(FIXTURE_ROOT, "heartbeat-missing-hash");
  const missingHashCli = spawnCleanupCli(["--apply"], missingHashHeartbeatDir);
  assert.notEqual(missingHashCli.status, 0, "apply without reviewed hash must fail");
  assert.equal(existsSync(join(missingHashHeartbeatDir, "media-cleanup")), false);

  const conflictingHeartbeatDir = join(FIXTURE_ROOT, "heartbeat-conflicting-mode");
  const conflictingCli = spawnCleanupCli(
    ["--purge-quarantine", "--restore-run=invalid"],
    conflictingHeartbeatDir,
  );
  assert.notEqual(conflictingCli.status, 0, "cleanup operation modes are mutually exclusive");
  assert.equal(existsSync(join(conflictingHeartbeatDir, "media-cleanup")), false);

  const disabledPurgeHeartbeatDir = join(FIXTURE_ROOT, "heartbeat-disabled-purge");
  const disabledPurgeCli = spawnCleanupCli(["--purge-quarantine"], disabledPurgeHeartbeatDir);
  assert.notEqual(disabledPurgeCli.status, 0, "CLI permanent purge remains disabled");
  assert.match(
    disabledPurgeCli.stderr,
    /permanent purge disabled pending shared writer exclusion/,
  );
  assert.equal(existsSync(join(disabledPurgeHeartbeatDir, "media-cleanup")), false);

  const ignoredAgeHeartbeatDir = join(FIXTURE_ROOT, "heartbeat-ignored-age");
  const ignoredAgeCli = spawnCleanupCli(
    ["--purge-quarantine", "--olderThanDays=3"],
    ignoredAgeHeartbeatDir,
  );
  assert.notEqual(ignoredAgeCli.status, 0, "purge rejects irrelevant --olderThanDays");
  assert.match(ignoredAgeCli.stderr, /restore and purge do not accept cleanup selection flags/);
  assert.equal(existsSync(join(ignoredAgeHeartbeatDir, "media-cleanup")), false);

  const bareIgnoredAgeHeartbeatDir = join(FIXTURE_ROOT, "heartbeat-bare-ignored-age");
  const bareIgnoredAgeCli = spawnCleanupCli(
    ["--purge-quarantine", "--olderThanDays"],
    bareIgnoredAgeHeartbeatDir,
  );
  assert.notEqual(bareIgnoredAgeCli.status, 0, "purge rejects bare --olderThanDays");
  assert.match(bareIgnoredAgeCli.stderr, /restore and purge do not accept cleanup selection flags/);
  assert.equal(existsSync(join(bareIgnoredAgeHeartbeatDir, "media-cleanup")), false);

  await prisma.video.create({
    data: {
      id: "quarantine-cli-malformed",
      userId: "quarantine-user",
      avatarModel: "none",
      voiceModel: "none",
      sceneCount: 1,
      renderConfig: "{not-json",
      expiresAt: atDays(-1),
    },
  });
  const failedHeartbeatDir = join(FIXTURE_ROOT, "heartbeat-graph-failure");
  const failedCli = spawnCleanupCli([], failedHeartbeatDir);
  assert.notEqual(failedCli.status, 0, "incomplete graph must fail the CLI dry-run");
  assert.equal(existsSync(join(failedHeartbeatDir, "media-cleanup")), false);
  const failedCliOutput = `${failedCli.stdout}\n${failedCli.stderr}`;
  assert.match(failedCliOutput, /media graph incomplete: 1 error\(s\)/);
  assert.doesNotMatch(
    failedCliOutput,
    /quarantine-cli-malformed|ownerId|absolutePath|api\/renders|media-quarantine-/,
    "CLI failure output contains counts, never owner/path details",
  );
  await prisma.video.delete({ where: { id: "quarantine-cli-malformed" } });

  rmSync(join(FIXTURE_ROOT, ".ops-metrics"), { recursive: true, force: true });
  const failedArtifactOutsideRoot = mkdtempSync(join(tmpdir(), "media-review-artifact-failure-"));
  EXTERNAL_ROOTS.push(failedArtifactOutsideRoot);
  symlinkSync(failedArtifactOutsideRoot, join(FIXTURE_ROOT, ".ops-metrics"));
  const failedArtifactHeartbeatDir = join(FIXTURE_ROOT, "heartbeat-artifact-failure");
  const failedArtifactCli = spawnCleanupCli([], failedArtifactHeartbeatDir);
  assert.notEqual(failedArtifactCli.status, 0, "review artifact failure aborts dry-run completion");
  assert.equal(existsSync(join(failedArtifactHeartbeatDir, "media-cleanup")), false);
  assert.deepEqual(fsNames(failedArtifactOutsideRoot), []);
  rmSync(join(FIXTURE_ROOT, ".ops-metrics"), { force: true });

  console.log("PASS media quarantine");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (prisma) await prisma.$disconnect();
    } finally {
      process.chdir(REPO_ROOT);
      rmSync(FIXTURE_ROOT, { recursive: true, force: true });
      for (const externalRoot of EXTERNAL_ROOTS) {
        rmSync(externalRoot, { recursive: true, force: true });
      }
    }
  });
