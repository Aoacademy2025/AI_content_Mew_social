import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";

const REPO_ROOT = process.cwd();
const FIXTURE_ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), "media-quarantine-")));
const DATABASE_URL = `file:${join(FIXTURE_ROOT, "quarantine.db")}`;
const NOW = new Date("2026-07-20T00:00:00.000Z");
const DAY_MS = 86_400_000;

process.env.DATABASE_URL = DATABASE_URL;
mkdirSync(join(FIXTURE_ROOT, "public", "renders"), { recursive: true });
mkdirSync(join(FIXTURE_ROOT, "stocks"), { recursive: true });
execFileSync(
  join(REPO_ROOT, "node_modules", ".bin", "prisma"),
  ["db", "push", "--skip-generate"],
  { cwd: REPO_ROOT, env: process.env, stdio: "pipe" },
);

function dateAtOffset(days: number): Date {
  return new Date(NOW.getTime() + days * DAY_MS);
}

function mediaPath(area: "renders" | "stocks", filename: string): string {
  return area === "renders"
    ? join(FIXTURE_ROOT, "public", "renders", filename)
    : join(FIXTURE_ROOT, "stocks", filename);
}

function writeMedia(
  area: "renders" | "stocks",
  filename: string,
  mtime: Date,
  contents = `${area}/${filename}`,
): string {
  const filePath = mediaPath(area, filename);
  writeFileSync(filePath, contents);
  utimesSync(filePath, mtime, mtime);
  return filePath;
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

async function main(): Promise<void> {
  process.chdir(FIXTURE_ROOT);
  const [prismaModule, cleanupModule, quarantineModule] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/media-cleanup"),
    import("../src/lib/media-quarantine"),
  ]);
  prisma = prismaModule.prisma;

  await prisma.user.create({
    data: {
      id: "quarantine-user",
      name: "Quarantine User",
      email: "quarantine@example.test",
      plan: "BUSINESS",
    },
  });

  const oldUnreferenced = writeMedia("renders", "old-unreferenced.mp4", dateAtOffset(-15));
  const recentUnreferenced = writeMedia("renders", "recent-unreferenced.mp4", dateAtOffset(-10));
  const expiredReferenced = writeMedia("renders", "expired-referenced.mp4", dateAtOffset(-30));
  const liveReferenced = writeMedia("renders", "live-referenced.mp4", dateAtOffset(-30));
  const nullReferenced = writeMedia("renders", "null-referenced.mp4", dateAtOffset(-30));
  const activeRender = writeMedia("renders", "active-render.mp4", dateAtOffset(-30));
  const oldStock = writeMedia("stocks", "old-stock.mp4", dateAtOffset(-15));

  await prisma.video.createMany({
    data: [
      {
        id: "expired-video",
        userId: "quarantine-user",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        videoUrl: "/api/renders/expired-referenced.mp4",
        expiresAt: dateAtOffset(-1),
      },
      {
        id: "live-video",
        userId: "quarantine-user",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        videoUrl: "/api/renders/live-referenced.mp4",
        expiresAt: dateAtOffset(1),
      },
      {
        id: "null-video",
        userId: "quarantine-user",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        videoUrl: "/api/renders/null-referenced.mp4",
        expiresAt: null,
      },
      {
        id: "missing-live-video",
        userId: "quarantine-user",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        videoUrl: "/api/renders/missing-before-expiry.mp4",
        expiresAt: dateAtOffset(1),
      },
    ],
  });
  await prisma.renderJob.create({
    data: {
      id: "active-render-job",
      userId: "quarantine-user",
      type: "RENDER",
      status: "RUNNING",
      payload: JSON.stringify({ src: "/api/renders/active-render.mp4" }),
    },
  });

  const dryRunPlan = await cleanupModule.getMediaCleanupPlan({
    cwd: FIXTURE_ROOT,
    includeStocks: true,
    olderThanDays: 1,
    now: NOW,
  });
  assert.equal(dryRunPlan.graphErrors.length, 0);
  assert.match(dryRunPlan.manifestSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    dryRunPlan.candidates.map((candidate) => candidate.key),
    [
      "renders/expired-referenced.mp4",
      "renders/old-unreferenced.mp4",
      "stocks/old-stock.mp4",
    ],
    "eligibility uses expired refs or the fixed 14-day unreferenced window",
  );
  assert.equal(
    dryRunPlan.candidates.every((candidate) =>
      candidate.absolutePath &&
      candidate.sizeBytes > 0 &&
      Number.isFinite(candidate.mtimeMs) &&
      /^[a-f0-9]{64}$/.test(candidate.fingerprint)
    ),
    true,
    "manifest records contain stable path/stat fingerprints",
  );
  assert.equal(existsSync(oldUnreferenced), true, "default planning mutates zero files");
  assert.equal(existsSync(recentUnreferenced), true, "10-day unreferenced media is protected");
  assert.equal(existsSync(liveReferenced), true, "live references are protected");
  assert.equal(existsSync(nullReferenced), true, "null expiry is protected");
  assert.equal(existsSync(activeRender), true, "active RenderJob references are protected");

  const tmpRoot = join(FIXTURE_ROOT, ".tmp", "remotion");
  mkdirSync(tmpRoot, { recursive: true });
  const tmpEntry = join(tmpRoot, "explicit-tmp-entry");
  writeFileSync(tmpEntry, "tmp");
  utimesSync(tmpEntry, dateAtOffset(-5), dateAtOffset(-5));
  const tmpPlan = await cleanupModule.getMediaCleanupPlan({
    cwd: FIXTURE_ROOT,
    includeTmp: true,
    now: NOW,
  });
  assert.ok(tmpPlan.tmpCandidates.some((candidate) => candidate.absolutePath === tmpEntry));
  assert.equal(
    tmpPlan.candidates.some((candidate) => candidate.absolutePath === tmpEntry),
    false,
    "tmp remains structurally separate from customer-media quarantine candidates",
  );

  await quarantineModule.writeMediaHealthMetrics(dryRunPlan, { cwd: FIXTURE_ROOT, now: NOW });
  const metricsPath = join(FIXTURE_ROOT, ".ops-metrics", "media-health.json");
  const metrics = readJson(metricsPath) as Record<string, unknown>;
  assert.deepEqual(Object.keys(metrics).sort(), [
    "candidates",
    "expired",
    "generatedAt",
    "graphErrors",
    "missingBeforeExpiry",
    "protected",
  ]);
  assert.equal(metrics.missingBeforeExpiry, 1);
  assert.doesNotMatch(JSON.stringify(metrics), /quarantine-user|renders\/|stocks\/|\.mp4/);
  const lastGoodMetrics = readFileSync(metricsPath, "utf8");

  await prisma.video.update({
    where: { id: "live-video" },
    data: { renderConfig: "{malformed" },
  });
  const incompletePlan = await cleanupModule.getMediaCleanupPlan({
    cwd: FIXTURE_ROOT,
    includeStocks: true,
    now: NOW,
  });
  assert.ok(incompletePlan.graphErrors.length > 0, "malformed JSON is reported");
  assert.equal(incompletePlan.candidates.length, 0, "incomplete graph yields zero media candidates");
  await assert.rejects(
    cleanupModule.applyMediaCleanupPlan(
      incompletePlan,
      incompletePlan.manifestSha256,
      { now: NOW, runId: "incomplete-run" },
    ),
    /media graph incomplete/,
  );
  await assert.rejects(
    quarantineModule.writeMediaHealthMetrics(incompletePlan, { cwd: FIXTURE_ROOT, now: NOW }),
    /media graph incomplete/,
  );
  assert.equal(readFileSync(metricsPath, "utf8"), lastGoodMetrics, "failed graph preserves metrics");
  assert.equal(existsSync(oldUnreferenced), true, "malformed JSON yields zero moves");
  await prisma.video.update({
    where: { id: "live-video" },
    data: { renderConfig: null },
  });

  await assert.rejects(
    cleanupModule.applyMediaCleanupPlan(dryRunPlan, "0".repeat(64), {
      now: NOW,
      runId: "hash-mismatch-run",
    }),
    /reviewed manifest hash mismatch/,
  );
  assert.equal(existsSync(oldUnreferenced), true, "reviewed hash mismatch yields zero moves");
  await assert.rejects(
    cleanupModule.applyMediaCleanupPlan(dryRunPlan, dryRunPlan.manifestSha256, {
      now: NOW,
      runId: "../escape-run",
    }),
    /invalid media quarantine run id/,
  );
  await assert.rejects(
    quarantineModule.restoreQuarantineRun("../escape-run", { cwd: FIXTURE_ROOT, now: NOW }),
    /invalid media quarantine run id/,
  );
  assert.equal(existsSync(oldUnreferenced), true, "run-id traversal yields zero moves");

  const referencedAfterPlan = writeMedia("renders", "referenced-after-plan.mp4", dateAtOffset(-20));
  const stalePlan = await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW });
  assert.ok(stalePlan.candidates.some((candidate) => candidate.key === "renders/referenced-after-plan.mp4"));
  await prisma.video.create({
    data: {
      id: "added-after-plan-video",
      userId: "quarantine-user",
      avatarModel: "none",
      voiceModel: "none",
      sceneCount: 1,
      videoUrl: "/api/renders/referenced-after-plan.mp4",
      expiresAt: dateAtOffset(2),
    },
  });
  const staleResult = await cleanupModule.applyMediaCleanupPlan(
    stalePlan,
    stalePlan.manifestSha256,
    { now: NOW, runId: "stale-reference-run" },
  );
  assert.equal(staleResult.metrics.quarantined.count, 2);
  assert.equal(staleResult.metrics.skipped.count, 1);
  assert.equal(existsSync(referencedAfterPlan), true, "a new reference prevents the planned move");
  assert.equal(existsSync(oldUnreferenced), false);
  assert.equal(existsSync(expiredReferenced), false);
  const reusedRunPlan = await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW });
  await assert.rejects(
    cleanupModule.applyMediaCleanupPlan(reusedRunPlan, reusedRunPlan.manifestSha256, {
      now: NOW,
      runId: "stale-reference-run",
    }),
    /run already exists/,
    "apply never reuses or overwrites an existing run manifest",
  );

  const restoreResult = await quarantineModule.restoreQuarantineRun("stale-reference-run", {
    cwd: FIXTURE_ROOT,
    now: NOW,
  });
  assert.equal(restoreResult.metrics.restored.count, 2);
  assert.equal(existsSync(oldUnreferenced), true, "restore returns quarantined files");
  assert.equal(existsSync(expiredReferenced), true);

  const collisionPlan = await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW });
  await cleanupModule.applyMediaCleanupPlan(collisionPlan, collisionPlan.manifestSha256, {
    now: NOW,
    runId: "restore-collision-run",
  });
  const collisionManifestPath = join(
    FIXTURE_ROOT,
    ".media-quarantine",
    "restore-collision-run",
    "manifest.json",
  );
  const untamperedManifest = readFileSync(collisionManifestPath, "utf8");
  const collisionAreaPath = join(
    FIXTURE_ROOT,
    ".media-quarantine",
    "restore-collision-run",
    "renders",
  );
  const collisionAreaBackup = `${collisionAreaPath}-real`;
  renameSync(collisionAreaPath, collisionAreaBackup);
  symlinkSync(FIXTURE_ROOT, collisionAreaPath);
  await assert.rejects(
    quarantineModule.restoreQuarantineRun("restore-collision-run", { cwd: FIXTURE_ROOT, now: NOW }),
    /unsafe media quarantine directory|outside root/,
    "restore rejects a symlinked run area before accessing quarantine entries",
  );
  rmSync(collisionAreaPath);
  renameSync(collisionAreaBackup, collisionAreaPath);

  const invalidMetricsManifest = JSON.parse(untamperedManifest) as {
    metrics: { scanned: { count: number } };
  };
  invalidMetricsManifest.metrics.scanned.count = -1;
  writeFileSync(collisionManifestPath, JSON.stringify(invalidMetricsManifest));
  await assert.rejects(
    quarantineModule.restoreQuarantineRun("restore-collision-run", { cwd: FIXTURE_ROOT, now: NOW }),
    /invalid quarantine manifest/,
    "restore validates manifest metrics before moving files",
  );
  writeFileSync(collisionManifestPath, untamperedManifest);

  const tamperedManifest = JSON.parse(untamperedManifest) as {
    records: Array<{ absolutePath: string }>;
  };
  tamperedManifest.records[0].absolutePath = join(FIXTURE_ROOT, "tampered-outside.mp4");
  writeFileSync(collisionManifestPath, JSON.stringify(tamperedManifest));
  await assert.rejects(
    quarantineModule.restoreQuarantineRun("restore-collision-run", { cwd: FIXTURE_ROOT, now: NOW }),
    /invalid quarantine manifest|outside configured media root/,
    "restore rejects a tampered manifest before moving files",
  );
  writeFileSync(collisionManifestPath, untamperedManifest);
  writeFileSync(oldUnreferenced, "collision");
  const collisionRestore = await quarantineModule.restoreQuarantineRun("restore-collision-run", {
    cwd: FIXTURE_ROOT,
    now: NOW,
  });
  assert.ok(collisionRestore.metrics.skipped.count > 0, "restore collision skips instead of overwrite");
  assert.equal(readFileSync(oldUnreferenced, "utf8"), "collision");
  const collisionRunPath = join(FIXTURE_ROOT, ".media-quarantine", "restore-collision-run");
  const duplicateRunPath = join(FIXTURE_ROOT, ".media-quarantine", "restore-collision-duplicate");
  cpSync(collisionRunPath, duplicateRunPath, { recursive: true });
  const duplicateManifestPath = join(duplicateRunPath, "manifest.json");
  const duplicateManifest = readJson(duplicateManifestPath) as { runId: string };
  duplicateManifest.runId = "restore-collision-duplicate";
  writeFileSync(duplicateManifestPath, JSON.stringify(duplicateManifest));
  assert.ok(
    quarantineModule.quarantinedMediaMtimes(FIXTURE_ROOT).has("renders/old-unreferenced.mp4"),
    "duplicate manifest keys merge conservatively into a known latest mtime",
  );
  rmSync(duplicateRunPath, { recursive: true, force: true });
  rmSync(oldUnreferenced);
  symlinkSync(join(FIXTURE_ROOT, "missing-collision-target"), oldUnreferenced);
  const brokenSymlinkRestore = await quarantineModule.restoreQuarantineRun("restore-collision-run", {
    cwd: FIXTURE_ROOT,
    now: NOW,
  });
  assert.ok(brokenSymlinkRestore.metrics.skipped.count > collisionRestore.metrics.skipped.count);
  assert.equal(lstatSync(oldUnreferenced).isSymbolicLink(), true, "broken symlink is a restore collision");
  rmSync(oldUnreferenced);
  await quarantineModule.restoreQuarantineRun("restore-collision-run", { cwd: FIXTURE_ROOT, now: NOW });

  const outsideTarget = join(FIXTURE_ROOT, "outside-target.mp4");
  writeFileSync(outsideTarget, "outside");
  const leafSymlink = mediaPath("renders", "leaf-symlink.mp4");
  symlinkSync(outsideTarget, leafSymlink);
  const symlinkPlan = await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW });
  assert.equal(
    symlinkPlan.candidates.some((candidate) => candidate.absolutePath === leafSymlink),
    false,
    "leaf symlinks are skipped",
  );
  await prisma.video.update({
    where: { id: "live-video" },
    data: { renderConfig: JSON.stringify({ src: "/api/renders/%2e%2e%2foutside.mp4" }) },
  });
  const traversalPlan = await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW });
  assert.ok(traversalPlan.graphErrors.some((error) => error.code === "media_path_invalid"));
  assert.equal(traversalPlan.candidates.length, 0, "traversal graph errors fail closed");
  await prisma.video.update({ where: { id: "live-video" }, data: { renderConfig: null } });

  const rollbackFile = writeMedia("renders", "manifest-rollback.mp4", dateAtOffset(-20));
  const rollbackPlan = await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW });
  await assert.rejects(
    cleanupModule.applyMediaCleanupPlan(rollbackPlan, rollbackPlan.manifestSha256, {
      now: NOW,
      runId: "manifest-rollback-run",
      writeManifest: async () => {
        throw new Error("injected manifest write failure");
      },
    }),
    /injected manifest write failure/,
  );
  assert.equal(existsSync(rollbackFile), true, "manifest failure rolls all moved files back");

  const projectBatchA = writeMedia("renders", "project-batch-a.mp4", dateAtOffset(-20));
  const projectBatchB = writeMedia("renders", "project-batch-b.mp4", dateAtOffset(-20));
  await prisma.editorProject.create({
    data: {
      id: "quarantine-project-batch",
      userId: "quarantine-user",
      draftJson: JSON.stringify({ first: "/api/renders/project-batch-a.mp4", second: "/api/renders/project-batch-b.mp4" }),
    },
  });
  const projectBatchPlan = await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW });
  const projectBatchRecords = projectBatchPlan.candidates.filter((candidate) =>
    candidate.key === "renders/project-batch-a.mp4" || candidate.key === "renders/project-batch-b.mp4"
  );
  assert.equal(projectBatchRecords.length, 2);
  const projectOnlyPlan = {
    ...projectBatchPlan,
    candidates: projectBatchRecords,
    manifestSha256: quarantineModule.mediaManifestSha256(projectBatchRecords),
  };
  const projectBatchResult = await cleanupModule.applyMediaCleanupPlan(
    projectOnlyPlan,
    projectOnlyPlan.manifestSha256,
    { now: NOW, runId: "project-batch-run", batchSize: 1 },
  );
  assert.equal(projectBatchResult.quarantined, 2, "each batch recheck tolerates earlier validated moves");
  assert.equal(existsSync(projectBatchA), false);
  assert.equal(existsSync(projectBatchB), false);
  const projectRestore = await quarantineModule.restoreQuarantineRun("project-batch-run", {
    cwd: FIXTURE_ROOT,
    now: NOW,
  });
  assert.equal(projectRestore.metrics.restored.count, 2, "restore graph uses validated manifest mtimes");
  assert.equal(existsSync(projectBatchA), true);
  assert.equal(existsSync(projectBatchB), true);

  rmSync(join(FIXTURE_ROOT, ".media-quarantine"), { recursive: true, force: true });
  rmSync(leafSymlink);
  const purgePending = writeMedia("renders", "purge-a-pending.mp4", dateAtOffset(-20));
  const purgeUnlink = writeMedia("renders", "purge-b-unlink.mp4", dateAtOffset(-20));
  const purgeRace = writeMedia("renders", "purge-c-race.mp4", dateAtOffset(-20));
  const purgeOne = writeMedia("renders", "purge-one.mp4", dateAtOffset(-20));
  const purgeChanged = writeMedia("renders", "purge-changed.mp4", dateAtOffset(-20), "same-size-a");
  const purgeNowReferenced = writeMedia("renders", "purge-now-referenced.mp4", dateAtOffset(-20));
  const purgePlan = await cleanupModule.getMediaCleanupPlan({ cwd: FIXTURE_ROOT, now: NOW });
  const purgeKeys = new Set([
    "renders/purge-a-pending.mp4",
    "renders/purge-b-unlink.mp4",
    "renders/purge-c-race.mp4",
    "renders/purge-changed.mp4",
    "renders/purge-now-referenced.mp4",
    "renders/purge-one.mp4",
  ]);
  const purgeRecords = purgePlan.candidates.filter((candidate) => purgeKeys.has(candidate.key));
  assert.equal(purgeRecords.length, purgeKeys.size);
  const purgeOnlyPlan = {
    ...purgePlan,
    candidates: purgeRecords,
    manifestSha256: quarantineModule.mediaManifestSha256(purgeRecords),
  };
  await cleanupModule.applyMediaCleanupPlan(purgeOnlyPlan, purgeOnlyPlan.manifestSha256, {
    now: NOW,
    runId: "purge-run",
  });
  assert.equal(existsSync(purgeOne), false);
  assert.equal(existsSync(purgePending), false);
  assert.equal(existsSync(purgeUnlink), false);
  assert.equal(existsSync(purgeRace), false);
  await prisma.video.create({
    data: {
      id: "purge-added-reference-video",
      userId: "quarantine-user",
      avatarModel: "none",
      voiceModel: "none",
      sceneCount: 1,
      videoUrl: "/api/renders/purge-now-referenced.mp4",
      expiresAt: dateAtOffset(2),
    },
  });
  const purgeAreaPath = join(FIXTURE_ROOT, ".media-quarantine", "purge-run", "renders");
  const purgeAreaBackup = `${purgeAreaPath}-real`;
  renameSync(purgeAreaPath, purgeAreaBackup);
  symlinkSync(FIXTURE_ROOT, purgeAreaPath);
  await assert.rejects(
    quarantineModule.purgeMediaQuarantine({
      cwd: FIXTURE_ROOT,
      now: new Date(NOW.getTime() + 25 * 60 * 60 * 1000),
    }),
    /unsafe media quarantine directory|outside root/,
    "purge rejects a symlinked run area before unlinking entries",
  );
  rmSync(purgeAreaPath);
  renameSync(purgeAreaBackup, purgeAreaPath);
  const earlyPurge = await quarantineModule.purgeMediaQuarantine({
    cwd: FIXTURE_ROOT,
    now: new Date(NOW.getTime() + 23 * 60 * 60 * 1000),
  });
  assert.equal(earlyPurge.metrics.purged.count, 0, "purge before 24 hours deletes nothing");

  const changedQuarantinePath = join(
    FIXTURE_ROOT,
    ".media-quarantine",
    "purge-run",
    "renders",
    "purge-changed.mp4",
  );
  writeFileSync(changedQuarantinePath, "same-size-b");
  const changedStat = lstatSync(changedQuarantinePath);
  utimesSync(changedQuarantinePath, new Date(changedStat.mtimeMs + 1_000), new Date(changedStat.mtimeMs + 1_000));
  const exactPurgeTime = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
  await assert.rejects(
    quarantineModule.purgeMediaQuarantine({
      cwd: FIXTURE_ROOT,
      now: exactPurgeTime,
      afterPendingPurgeWrite: async (record) => {
        if (record.key === "renders/purge-a-pending.mp4") throw new Error("injected pending crash");
      },
    }),
    /injected pending crash/,
  );
  const purgeManifestPath = join(FIXTURE_ROOT, ".media-quarantine", "purge-run", "manifest.json");
  const pendingCrashManifest = readJson(purgeManifestPath) as { pendingPurgeKeys: string[] };
  assert.ok(pendingCrashManifest.pendingPurgeKeys.includes("renders/purge-a-pending.mp4"));
  assert.equal(
    existsSync(join(FIXTURE_ROOT, ".media-quarantine", "purge-run", "renders", "purge-a-pending.mp4")),
    true,
    "pending state written before unlink is recoverable",
  );

  await assert.rejects(
    quarantineModule.purgeMediaQuarantine({
      cwd: FIXTURE_ROOT,
      now: exactPurgeTime,
      afterPurgeUnlink: async (record) => {
        if (record.key === "renders/purge-b-unlink.mp4") throw new Error("injected post-unlink crash");
      },
    }),
    /injected post-unlink crash/,
  );
  assert.equal(
    existsSync(join(FIXTURE_ROOT, ".media-quarantine", "purge-run", "renders", "purge-a-pending.mp4")),
    false,
  );
  assert.equal(
    existsSync(join(FIXTURE_ROOT, ".media-quarantine", "purge-run", "renders", "purge-b-unlink.mp4")),
    false,
    "unlink-before-final-manifest state is recoverable",
  );

  const latePurge = await quarantineModule.purgeMediaQuarantine({
    cwd: FIXTURE_ROOT,
    now: exactPurgeTime,
    afterPendingPurgeWrite: async (record) => {
      if (record.key !== "renders/purge-c-race.mp4") return;
      await prisma.video.create({
        data: {
          id: "purge-race-reference-video",
          userId: "quarantine-user",
          avatarModel: "none",
          voiceModel: "none",
          sceneCount: 1,
          videoUrl: "/api/renders/purge-c-race.mp4",
          expiresAt: dateAtOffset(2),
        },
      });
    },
  });
  assert.ok(latePurge.metrics.purged.count > 0, "unchanged eligible entries purge at exactly 24h");
  assert.ok(latePurge.metrics.skipped.count > 0, "changed/live quarantine entries are skipped");
  assert.equal(existsSync(changedQuarantinePath), true);
  assert.equal(existsSync(purgeChanged), false);
  assert.equal(existsSync(purgeNowReferenced), false);
  assert.equal(existsSync(purgeRace), false);
  assert.equal(
    existsSync(join(FIXTURE_ROOT, ".media-quarantine", "purge-run", "renders", "purge-c-race.mp4")),
    true,
    "a live reference injected after pending persistence blocks unlink",
  );
  const raceManifest = readJson(purgeManifestPath) as { pendingPurgeKeys: string[] };
  assert.equal(
    raceManifest.pendingPurgeKeys.includes("renders/purge-c-race.mp4"),
    false,
    "a blocked final purge recheck clears pending state",
  );
  assert.equal(
    existsSync(join(FIXTURE_ROOT, ".media-quarantine", "purge-run", "renders", "purge-now-referenced.mp4")),
    true,
    "a live reference added while quarantined blocks permanent purge",
  );
  const repeatedPurge = await quarantineModule.purgeMediaQuarantine({
    cwd: FIXTURE_ROOT,
    now: new Date(NOW.getTime() + 26 * 60 * 60 * 1000),
  });
  assert.equal(repeatedPurge.metrics.purged.count, 0, "repeat purge remains complete after project tombstones");

  const heartbeatDir = join(FIXTURE_ROOT, ".heartbeat");
  await prisma.video.update({
    where: { id: "live-video" },
    data: { renderConfig: "{malformed-again" },
  });
  await prisma.$disconnect();
  const cliFailure = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
      "--tsconfig",
      join(REPO_ROOT, "tsconfig.json"),
      join(REPO_ROOT, "scripts", "media-cleanup.ts"),
    ],
    {
      cwd: FIXTURE_ROOT,
      env: {
        ...process.env,
        DATABASE_URL,
        HEARTBEAT_DIR: heartbeatDir,
      },
      encoding: "utf8",
    },
  );
  assert.notEqual(cliFailure.status, 0, "incomplete CLI graph exits non-zero");
  assert.equal(existsSync(join(heartbeatDir, "media-cleanup")), false, "failed CLI does not heartbeat");
  assert.equal(readFileSync(metricsPath, "utf8"), lastGoodMetrics, "failed CLI preserves last good metrics");
  await prisma.video.update({ where: { id: "live-video" }, data: { renderConfig: null } });

  rmSync(heartbeatDir, { recursive: true, force: true });
  rmSync(metricsPath, { force: true });
  mkdirSync(metricsPath);
  await prisma.$disconnect();
  const metricsFailure = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
      "--tsconfig",
      join(REPO_ROOT, "tsconfig.json"),
      join(REPO_ROOT, "scripts", "media-cleanup.ts"),
    ],
    {
      cwd: FIXTURE_ROOT,
      env: { ...process.env, DATABASE_URL, HEARTBEAT_DIR: heartbeatDir },
      encoding: "utf8",
    },
  );
  assert.notEqual(metricsFailure.status, 0, "metrics write failure exits non-zero");
  assert.equal(existsSync(join(heartbeatDir, "media-cleanup")), false, "metrics failure does not heartbeat");
  rmSync(metricsPath, { recursive: true, force: true });
  const preSuccessCliPlan = await cleanupModule.getMediaCleanupPlan({
    cwd: FIXTURE_ROOT,
    now: new Date(),
  });
  assert.deepEqual(preSuccessCliPlan.graphErrors, [], "successful CLI fixture graph must be complete");
  await prisma.$disconnect();
  const cliSuccess = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
      "--tsconfig",
      join(REPO_ROOT, "tsconfig.json"),
      join(REPO_ROOT, "scripts", "media-cleanup.ts"),
    ],
    {
      cwd: FIXTURE_ROOT,
      env: {
        ...process.env,
        DATABASE_URL,
        HEARTBEAT_DIR: heartbeatDir,
      },
      encoding: "utf8",
    },
  );
  assert.equal(cliSuccess.status, 0, `${cliSuccess.stdout}\n${cliSuccess.stderr}`);
  assert.equal(existsSync(metricsPath), true, "successful CLI writes metrics");
  assert.equal(existsSync(join(heartbeatDir, "media-cleanup")), true, "heartbeat follows metrics success");

  const routeSource = readFileSync(join(REPO_ROOT, "src", "app", "api", "admin", "cleanup", "route.ts"), "utf8");
  assert.match(routeSource, /apply\s*!==\s*true/);
  assert.match(routeSource, /manifestSha256/);
  assert.match(routeSource, /tmp_cleanup_requires_separate_cli_operation/);
  assert.doesNotMatch(routeSource, /purgeMediaQuarantine|purge-quarantine/);
  const cliSource = readFileSync(join(REPO_ROOT, "scripts", "media-cleanup.ts"), "utf8");
  assert.match(cliSource, /purge-quarantine/);
  assert.match(cliSource, /restore-run/);
  assert.match(cliSource, /cleanup-tmp/);

  console.log("PASS media quarantine");
}

let prisma: PrismaClient | undefined;
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
    }
  });
