import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyMediaExpiryBackfill,
  assertTemporarySqliteDatabaseUrl,
  discoverMediaExpiryBackfill,
  hashMediaExpiryBackfillRows,
  planMediaExpiryBackfill,
  type MediaExpiryBackfillReport,
} from "../src/lib/media-expiry-backfill";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const FIXTURE_USER_IDS = ["media-backfill-pro", "media-backfill-business"];
const HISTORICAL_TRIAL_USER_ID = "media-backfill-historical-trial";
const NOW = new Date("2026-07-10T00:00:00.000Z");
let prisma: PrismaClient;

function verifyTemporaryDatabaseGuard() {
  assert.doesNotThrow(() => assertTemporarySqliteDatabaseUrl("file:/tmp/media-backfill-safe.db"));
  assert.throws(
    () => assertTemporarySqliteDatabaseUrl("file:/tmp/../media-backfill-unsafe.db"),
    /verification requires an explicit temporary SQLite DATABASE_URL under \/tmp/,
  );

  const guardRoot = mkdtempSync("/tmp/media-backfill-url-guard-");
  try {
    const escapingAncestor = join(guardRoot, "escaping-ancestor");
    symlinkSync(process.cwd(), escapingAncestor);
    assert.throws(
      () => assertTemporarySqliteDatabaseUrl(pathToFileURL(join(escapingAncestor, "unsafe.db")).href),
      /verification requires an explicit temporary SQLite DATABASE_URL under \/tmp/,
    );

    const escapingFile = join(guardRoot, "escaping-file.db");
    symlinkSync(join(process.cwd(), "package.json"), escapingFile);
    assert.throws(
      () => assertTemporarySqliteDatabaseUrl(pathToFileURL(escapingFile).href),
      /verification requires an explicit temporary SQLite DATABASE_URL under \/tmp/,
    );
  } finally {
    rmSync(guardRoot, { recursive: true, force: true });
  }
}

function runCli(args: string[]) {
  const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const result = spawnSync(
    process.execPath,
    [tsxCli, join(process.cwd(), "scripts", "backfill-media-expiry.ts"), ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL },
      encoding: "utf8",
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function cleanFixtures() {
  await prisma.user.deleteMany({ where: { id: { in: FIXTURE_USER_IDS } } });
}

function verifyPurePlanner() {
  const rows = planMediaExpiryBackfill(
    [
      {
        targetKind: "video-job",
        targetId: "job-finished-base",
        ownerPlan: "FREE",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        trialStartedAt: null,
        updatedAt: new Date("2026-07-02T00:00:00.000Z"),
        finishedAt: new Date("2026-07-03T00:00:00.000Z"),
      },
      {
        targetKind: "video-job",
        targetId: "job-updated-base",
        ownerPlan: "PRO",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        trialStartedAt: null,
        updatedAt: new Date("2026-07-02T00:00:00.000Z"),
        finishedAt: null,
      },
      {
        targetKind: "video-job",
        targetId: "job-created-base",
        ownerPlan: "BUSINESS",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        trialStartedAt: null,
        updatedAt: null,
        finishedAt: null,
      },
      {
        targetKind: "video",
        targetId: "video-created-base",
        ownerPlan: "FREE",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        trialStartedAt: null,
      },
    ],
    NOW,
  );

  assert.deepEqual(
    rows.map((row) => ({
      targetKind: row.targetKind,
      targetId: row.targetId,
      ownerPlan: row.ownerPlan,
      baseAt: row.baseAt,
      calculatedExpiresAt: row.calculatedExpiresAt,
      alreadyExpired: row.alreadyExpired,
    })),
    [
      {
        targetKind: "video",
        targetId: "video-created-base",
        ownerPlan: "FREE",
        baseAt: "2026-07-01T00:00:00.000Z",
        calculatedExpiresAt: "2026-07-04T00:00:00.000Z",
        alreadyExpired: true,
      },
      {
        targetKind: "video-job",
        targetId: "job-created-base",
        ownerPlan: "BUSINESS",
        baseAt: "2026-07-01T00:00:00.000Z",
        calculatedExpiresAt: "2026-07-15T00:00:00.000Z",
        alreadyExpired: false,
      },
      {
        targetKind: "video-job",
        targetId: "job-finished-base",
        ownerPlan: "FREE",
        baseAt: "2026-07-03T00:00:00.000Z",
        calculatedExpiresAt: "2026-07-06T00:00:00.000Z",
        alreadyExpired: true,
      },
      {
        targetKind: "video-job",
        targetId: "job-updated-base",
        ownerPlan: "PRO",
        baseAt: "2026-07-02T00:00:00.000Z",
        calculatedExpiresAt: "2026-07-09T00:00:00.000Z",
        alreadyExpired: true,
      },
    ],
  );
  assert.match(rows[0].reason, /current owner plan.*historical plan-at-creation is unavailable/);
  assert.match(rows[1].reason, /current owner plan.*historical plan-at-completion is unavailable/);
  assert.match(rows[1].reason, /createdAt/);
  assert.match(rows[2].reason, /finishedAt/);
  assert.match(rows[3].reason, /updatedAt/);
  assert.equal(
    hashMediaExpiryBackfillRows(rows),
    hashMediaExpiryBackfillRows([...rows].reverse()),
    "row hashing is deterministic across input order",
  );
}

function verifyHistoricalTrialPlanner() {
  const rows = planMediaExpiryBackfill(
    [
      {
        targetKind: "video",
        targetId: "trial-video-exact-start",
        ownerPlan: "FREE",
        createdAt: new Date("2026-07-04T00:00:00.000Z"),
        trialStartedAt: new Date("2026-07-04T00:00:00.000Z"),
      },
      {
        targetKind: "video-job",
        targetId: "trial-free-inside",
        ownerPlan: "FREE",
        createdAt: new Date("2026-07-04T00:00:00.000Z"),
        trialStartedAt: new Date("2026-07-04T00:00:00.000Z"),
        updatedAt: new Date("2026-07-05T00:00:00.000Z"),
        finishedAt: new Date("2026-07-05T00:00:00.000Z"),
      },
      {
        targetKind: "video-job",
        targetId: "trial-free-exact-end",
        ownerPlan: "FREE",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        trialStartedAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-08T00:00:00.000Z"),
        finishedAt: new Date("2026-07-08T00:00:00.000Z"),
      },
      {
        targetKind: "video-job",
        targetId: "trial-pro-inside",
        ownerPlan: "PRO",
        createdAt: new Date("2026-07-04T00:00:00.000Z"),
        trialStartedAt: new Date("2026-07-04T00:00:00.000Z"),
        updatedAt: new Date("2026-07-05T00:00:00.000Z"),
        finishedAt: new Date("2026-07-05T00:00:00.000Z"),
      },
      {
        targetKind: "video-job",
        targetId: "trial-business-inside",
        ownerPlan: "BUSINESS",
        createdAt: new Date("2026-07-04T00:00:00.000Z"),
        trialStartedAt: new Date("2026-07-04T00:00:00.000Z"),
        updatedAt: new Date("2026-07-05T00:00:00.000Z"),
        finishedAt: new Date("2026-07-05T00:00:00.000Z"),
      },
    ],
    NOW,
  );

  const inside = rows.find((row) => row.targetId === "trial-free-inside");
  assert.equal(inside?.ownerPlan, "PRO", "historical trial raises current FREE to PRO");
  assert.equal(inside?.calculatedExpiresAt, "2026-07-12T00:00:00.000Z");
  assert.equal(inside?.alreadyExpired, false, "seven-day trial media is not expired at day five");
  assert.match(inside?.reason ?? "", /historical PRO trial/);

  const videoAtStart = rows.find((row) => row.targetId === "trial-video-exact-start");
  assert.equal(videoAtStart?.ownerPlan, "PRO", "trial start is inclusive for Video media");
  assert.equal(videoAtStart?.calculatedExpiresAt, "2026-07-11T00:00:00.000Z");
  assert.match(videoAtStart?.reason ?? "", /historical PRO trial/);

  const exactEnd = rows.find((row) => row.targetId === "trial-free-exact-end");
  assert.equal(exactEnd?.ownerPlan, "FREE", "trial end is exclusive");
  assert.match(exactEnd?.reason ?? "", /current owner plan/);

  const pro = rows.find((row) => row.targetId === "trial-pro-inside");
  assert.equal(pro?.ownerPlan, "PRO");
  assert.match(pro?.reason ?? "", /historical PRO trial/);
  assert.match(pro?.reason ?? "", /current PRO retention matches/);

  const business = rows.find((row) => row.targetId === "trial-business-inside");
  assert.equal(business?.ownerPlan, "BUSINESS", "trial evidence never shortens BUSINESS");
  assert.equal(business?.calculatedExpiresAt, "2026-07-19T00:00:00.000Z");
  assert.match(business?.reason ?? "", /historical PRO trial/);
  assert.match(business?.reason ?? "", /current BUSINESS retention is longer/);

  assert.throws(
    () =>
      planMediaExpiryBackfill(
        [
          {
            targetKind: "video-job",
            targetId: "trial-invalid-start",
            ownerPlan: "FREE",
            createdAt: new Date("2026-07-04T00:00:00.000Z"),
            trialStartedAt: new Date("invalid"),
            updatedAt: new Date("2026-07-05T00:00:00.000Z"),
            finishedAt: new Date("2026-07-05T00:00:00.000Z"),
          },
        ],
        NOW,
      ),
    /invalid trialStartedAt/,
    "invalid historical evidence fails closed",
  );
}

async function verifyHistoricalTrialDiscovery() {
  await prisma.user.deleteMany({ where: { id: HISTORICAL_TRIAL_USER_ID } });
  try {
    await prisma.user.create({
      data: {
        id: HISTORICAL_TRIAL_USER_ID,
        name: "Historical Trial",
        email: "historical-trial@example.test",
        plan: "FREE",
        trialStartedAt: new Date("2026-07-04T00:00:00.000Z"),
      },
    });
    await prisma.videoJob.create({
      data: {
        id: "media-backfill-job-historical-trial",
        userId: HISTORICAL_TRIAL_USER_ID,
        status: "done",
        inputJson: "{}",
        createdAt: new Date("2026-07-05T00:00:00.000Z"),
        updatedAt: new Date("2026-07-05T00:00:00.000Z"),
        finishedAt: new Date("2026-07-05T00:00:00.000Z"),
        mediaExpiresAt: null,
      },
    });

    const report = await discoverMediaExpiryBackfill(prisma, NOW);
    const row = report.rows.find((candidate) => candidate.targetId === "media-backfill-job-historical-trial");
    assert.equal(row?.ownerPlan, "PRO", "discovery carries historical trial evidence");
    assert.equal(row?.calculatedExpiresAt, "2026-07-12T00:00:00.000Z");
    assert.equal(row?.alreadyExpired, false);
  } finally {
    await prisma.user.deleteMany({ where: { id: HISTORICAL_TRIAL_USER_ID } });
  }
}

async function seedFixtures() {
  const pro = await prisma.user.create({
    data: {
      id: FIXTURE_USER_IDS[0],
      name: "Media Backfill Pro",
      email: "media-backfill-pro@example.test",
      plan: "PRO",
    },
  });
  const business = await prisma.user.create({
    data: {
      id: FIXTURE_USER_IDS[1],
      name: "Media Backfill Business",
      email: "media-backfill-business@example.test",
      plan: "BUSINESS",
    },
  });

  await prisma.videoJob.createMany({
    data: [
      {
        id: "media-backfill-job-null",
        userId: pro.id,
        status: "done",
        inputJson: "{}",
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
        updatedAt: new Date("2020-01-02T00:00:00.000Z"),
        finishedAt: new Date("2020-01-03T00:00:00.000Z"),
        mediaExpiresAt: null,
      },
      {
        id: "media-backfill-job-updated-fallback",
        userId: business.id,
        status: "done",
        inputJson: "{}",
        createdAt: new Date("2020-02-01T00:00:00.000Z"),
        updatedAt: new Date("2020-02-02T00:00:00.000Z"),
        finishedAt: null,
        mediaExpiresAt: null,
      },
      {
        id: "media-backfill-job-existing",
        userId: pro.id,
        status: "done",
        inputJson: "{}",
        mediaExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
      {
        id: "media-backfill-job-not-done",
        userId: pro.id,
        status: "processing",
        inputJson: "{}",
        mediaExpiresAt: null,
      },
    ],
  });

  await prisma.video.createMany({
    data: [
      {
        id: "media-backfill-video-null",
        userId: pro.id,
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        createdAt: new Date("2020-03-01T00:00:00.000Z"),
        expiresAt: null,
      },
      {
        id: "media-backfill-video-existing",
        userId: business.id,
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
    ],
  });
}

async function main() {
  verifyTemporaryDatabaseGuard();
  assertTemporarySqliteDatabaseUrl(DATABASE_URL);
  prisma = (await import("../src/lib/prisma")).prisma;
  verifyPurePlanner();
  verifyHistoricalTrialPlanner();
  await cleanFixtures();
  await verifyHistoricalTrialDiscovery();

  const fileDir = mkdtempSync(join(tmpdir(), "media-backfill-files-"));
  const sentinel = join(fileDir, "must-not-be-deleted.mp4");
  writeFileSync(sentinel, "sentinel-media");

  try {
    await seedFixtures();
    const rowCountsBefore = {
      jobs: await prisma.videoJob.count({ where: { userId: { in: FIXTURE_USER_IDS } } }),
      videos: await prisma.video.count({ where: { userId: { in: FIXTURE_USER_IDS } } }),
    };

    const nullCountsBefore = {
      jobs: await prisma.videoJob.count({
        where: { userId: { in: FIXTURE_USER_IDS }, status: "done", mediaExpiresAt: null },
      }),
      videos: await prisma.video.count({
        where: { userId: { in: FIXTURE_USER_IDS }, expiresAt: null },
      }),
    };

    const dryRun = runCli([]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const report = JSON.parse(dryRun.stdout) as MediaExpiryBackfillReport;
    assert.equal(report.mode, "dry-run");
    assert.equal(report.rows.length, 3);
    assert.equal(report.sha256, hashMediaExpiryBackfillRows(report.rows));
    assert.deepEqual(
      report.rows.map((row) => row.targetKind),
      ["video", "video-job", "video-job"],
    );
    assert.ok(report.rows.every((row) => row.alreadyExpired), "already-expired rows are reported");
    assert.ok(
      report.rows.every((row) => row.reason.includes("current owner plan")),
      "current plan is used only as the documented historical fallback",
    );
    assert.deepEqual(
      {
        jobs: await prisma.videoJob.count({
          where: { userId: { in: FIXTURE_USER_IDS }, status: "done", mediaExpiresAt: null },
        }),
        videos: await prisma.video.count({
          where: { userId: { in: FIXTURE_USER_IDS }, expiresAt: null },
        }),
      },
      nullCountsBefore,
      "default dry-run writes zero rows",
    );

    const missingHash = runCli(["--apply"]);
    assert.notEqual(missingHash.status, 0);
    assert.match(missingHash.stderr, /--apply requires --report-sha256/);

    const mismatchedHash = runCli(["--apply", `--report-sha256=${"0".repeat(64)}`]);
    assert.notEqual(mismatchedHash.status, 0);
    assert.match(mismatchedHash.stderr, /reviewed report hash does not match current plan/);

    const apply = runCli(["--apply", `--report-sha256=${report.sha256}`]);
    assert.equal(apply.status, 0, apply.stderr);
    const appliedReport = JSON.parse(apply.stdout) as MediaExpiryBackfillReport;
    assert.equal(appliedReport.mode, "apply");
    assert.deepEqual(appliedReport.updated, { total: 3, videos: 1, videoJobs: 2 });
    assert.deepEqual(
      {
        jobs: await prisma.videoJob.count({ where: { userId: { in: FIXTURE_USER_IDS } } }),
        videos: await prisma.video.count({ where: { userId: { in: FIXTURE_USER_IDS } } }),
      },
      rowCountsBefore,
      "apply deletes no database row",
    );
    assert.equal(existsSync(sentinel), true, "apply deletes no file");
    assert.equal(readFileSync(sentinel, "utf8"), "sentinel-media");

    const preservedExpiry = new Date("2040-01-01T00:00:00.000Z");
    await prisma.video.create({
      data: {
        id: "media-backfill-video-concurrent",
        userId: FIXTURE_USER_IDS[0],
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        createdAt: new Date("2020-04-01T00:00:00.000Z"),
        expiresAt: null,
      },
    });
    const concurrentPlan = await discoverMediaExpiryBackfill(prisma, NOW);
    await prisma.video.update({
      where: { id: "media-backfill-video-concurrent" },
      data: { expiresAt: preservedExpiry },
    });
    const concurrentApply = await applyMediaExpiryBackfill(prisma, concurrentPlan.rows);
    assert.deepEqual(concurrentApply, { total: 0, videos: 0, videoJobs: 0 });
    assert.equal(
      (await prisma.video.findUnique({ where: { id: "media-backfill-video-concurrent" } }))?.expiresAt?.toISOString(),
      preservedExpiry.toISOString(),
      "nullable updateMany guard preserves a concurrent expiry",
    );

    const secondDryRun = runCli([]);
    assert.equal(secondDryRun.status, 0, secondDryRun.stderr);
    const emptyReport = JSON.parse(secondDryRun.stdout) as MediaExpiryBackfillReport;
    assert.deepEqual(emptyReport.rows, []);
    const secondApply = runCli(["--apply", `--report-sha256=${emptyReport.sha256}`]);
    assert.equal(secondApply.status, 0, secondApply.stderr);
    assert.deepEqual(
      (JSON.parse(secondApply.stdout) as MediaExpiryBackfillReport).updated,
      { total: 0, videos: 0, videoJobs: 0 },
      "second reviewed apply updates zero rows",
    );

    console.log("PASS media expiry backfill");
  } finally {
    await cleanFixtures();
    rmSync(fileDir, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (prisma) await prisma.$disconnect();
  });
