// Task C5b fix 6 (A4 rows #5, #69, #70, #72, #76, #83, #111) — the definitions cluster on
// /admin/insights.
//
// (a) "Video completed" and the Health Score's video terms used to read the `Video` table. On prod
//     every single `Video` row is COMPLETED (Video_ever_nonCOMPLETED = 0), so the tile was the
//     constant 100 % and two of the Health Score's six penalty terms — videoCompletionPenalty and
//     statusStuckWithOutput, 35 of its 100 points — could never fire. The number now means what its
//     label says: VideoJob rows of type "create" that reached status "done".
// (b) `jobOutcomes` had no `canceled` field, so 55 canceled jobs in a 30-day window were rendered
//     nowhere and a reader adding up the tiles was short by 55 with no explanation.
//
// Day boundary reference (Asia/Bangkok = UTC+7, no DST):
//   2026-09-10T16:59:00Z → Bangkok 2026-09-10 23:59 → day "2026-09-10"
//   2026-09-10T17:00:00Z → Bangkok 2026-09-11 00:00 → day "2026-09-11"
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "admin-number-video-completed-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string) {
  if (condition) { passed += 1; console.log(`ok: ${label}`); }
  else { failed += 1; console.error(`FAIL: ${label}`); }
}

const LATE_DAY_10 = new Date("2026-09-10T16:59:00Z");  // Bangkok 2026-09-10 23:59
const EARLY_DAY_11 = new Date("2026-09-10T17:00:00Z"); // Bangkok 2026-09-11 00:00

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { summarizeCreationJobs, hasCreationOutput } = await import("../src/lib/insights-creation-jobs");

  const OWNER = "user-owner";
  await prisma.user.create({ data: { id: OWNER, name: "Owner", email: "owner@example.com" } });

  const withVideo = JSON.stringify({ version: 1, videoUrl: "/renders/out.mp4" });
  const job = (id: string, type: string, status: string, createdAt: Date, outputJson: string | null = null) =>
    prisma.videoJob.create({
      data: { id, userId: OWNER, type, status, inputJson: "{}", outputJson, createdAt },
    });

  // 7 creation jobs straddling the Bangkok midnight, plus one export job that must never reach the
  // creation tile, plus five Video rows — every one COMPLETED, exactly like prod.
  await job("c-done-1", "create", "done", LATE_DAY_10, withVideo);
  await job("c-done-2", "create", "done", EARLY_DAY_11, withVideo);
  await job("c-done-3", "create", "done", EARLY_DAY_11, withVideo);
  await job("c-failed", "create", "failed", LATE_DAY_10);
  await job("c-canceled", "create", "canceled", EARLY_DAY_11);
  await job("c-queued", "create", "queued", EARLY_DAY_11);
  await job("c-stuck", "create", "processing", LATE_DAY_10, withVideo);
  await job("x-export", "export", "done", EARLY_DAY_11, withVideo);
  for (let i = 0; i < 5; i++) {
    await prisma.video.create({
      data: {
        id: `v-${i}`, userId: OWNER, avatarModel: "none", voiceModel: "gemini", sceneCount: 3,
        script: "s", status: "COMPLETED", videoUrl: "/renders/v.mp4",
      },
    });
  }

  // Read them back through the same select the route uses — this pins that `type` and `outputJson`
  // are actually carried, not just referenced.
  const rows = await prisma.videoJob.findMany({ select: { status: true, type: true, outputJson: true } });
  const summary = summarizeCreationJobs(rows);

  // ---- (a) the tile counts creation jobs, not the all-COMPLETED Video table ------------------
  check(summary.total === 7, `(a) total = the 7 creation jobs, the export job excluded (${summary.total})`);
  check(summary.completed === 3, `(a) completed = VideoJob type=create, status=done (${summary.completed})`);
  check(summary.completionPct === 43, `(a) completionPct = 3/7 = 43 %, not the constant 100 % (${summary.completionPct})`);

  const videoRows = await prisma.video.findMany({ select: { status: true } });
  check(
    videoRows.length === 5 && videoRows.every((v) => v.status === "COMPLETED"),
    "(a) the fixture reproduces prod: every Video row is COMPLETED",
  );
  check(summary.completionPct !== 100,
    "(a) with an all-COMPLETED Video table the tile is no longer a constant 100 %");

  // ---- (b) canceled jobs are accounted for ---------------------------------------------------
  check(summary.canceled === 1, `(b) canceled creation jobs are counted (${summary.canceled})`);
  check(
    summary.completed + summary.failed + summary.canceled + summary.pending + summary.processing === summary.total,
    "(b) the status buckets add up to the total — no job goes missing",
  );

  // ---- (c) the Health Score's stuck term can actually fire ------------------------------------
  check(summary.statusStuckWithOutput === 1,
    `(c) a job still in flight whose outputJson already carries a videoUrl is 'stuck with output' (${summary.statusStuckWithOutput})`);
  check(summary.outputReady === 4, `(c) outputReady = the 3 done + the 1 stuck job (${summary.outputReady})`);
  check(summary.processingWithoutOutput === 1,
    `(c) the queued job has no output yet (${summary.processingWithoutOutput})`);
  check(hasCreationOutput({ status: "done", type: "create", outputJson: null }) === false,
    "(c) a job with no outputJson has no output");
  check(hasCreationOutput({ status: "done", type: "create", outputJson: "not json" }) === false,
    "(c) garbage outputJson is tolerated, not counted as an output");
  check(hasCreationOutput({ status: "done", type: "create", outputJson: JSON.stringify({ videoUrl: "  " }) }) === false,
    "(c) a blank videoUrl is not an output");

  // ---- (d) the surfaces actually use it -------------------------------------------------------
  const route = readFileSync("src/app/api/admin/insights/route.ts", "utf8");
  check(/summarizeCreationJobs\(/.test(route),
    "(d) the route derives the video tile from creation jobs");
  check(!/summarizeVideoJobs\(/.test(route),
    "(d) the dead Video-table summarizer is gone from the route");
  check(/canceled:/.test(route),
    "(d) jobOutcomes reports canceled jobs");

  const page = readFileSync("src/app/(dashboard)/admin/insights/page.tsx", "utf8");
  check(!/เปอร์เซ็นต์งานจากตาราง Video/.test(page),
    "(d) the tile's help text no longer describes the Video table");
  check(/VideoJob/.test(page) && /Video completed/.test(page),
    "(d) the tile's help text names VideoJob as its source");
  check(/jobOutcomes\.canceled/.test(page),
    "(d) the server job panel renders the canceled count");
  check(/canceled: number/.test(page),
    "(d) the payload type carries canceled");

  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
