// Run with: npm run verify:video-job-watchdog
// Spins a throwaway SQLite DB and exercises the server-side VideoJob watchdog:
// stalled `processing` jobs are failed with a refundable reason, and
// `waiting_provider` rows that no claim query can ever reach are repaired.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "vjw-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
// The watchdog reads VIDEO_JOB_STALE_MS at module load. Leave it unset so this run
// pins the shipped default (45 min) and the exact user-facing copy derived from it.
delete process.env.VIDEO_JOB_STALE_MS;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

// Verbatim customer copy. Written out literally (not imported) so a change to the
// message is a deliberate test edit, never an accidental silent rewording.
const EXPECTED_MESSAGE =
  "งานหยุดตอบสนองนานเกิน 45 นาที (job_stalled) — ระบบยกเลิกและคืนโควต้าให้แล้ว กรุณาลองใหม่";

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) { failures++; console.error("FAIL:", msg); } else console.log("ok:", msg);
};

async function main() {
  const watchdog = await import("../src/lib/mcp/video-job-watchdog");
  const { claimNextRunnableJob } = await import("../src/lib/mcp/video-job");
  const { prisma } = await import("../src/lib/prisma");

  ok(watchdog.VIDEO_JOB_STALE_MS === 45 * 60_000, "VIDEO_JOB_STALE_MS defaults to 45 minutes");

  const now = new Date("2026-08-30T12:00:00.000Z");
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  const user = await prisma.user.create({
    data: { name: "Watchdog Tester", email: "watchdog@example.com" },
  });
  const projectA = await prisma.editorProject.create({
    data: { userId: user.id, title: "A", status: "rendering" },
  });

  // A) processing, last touched 50 min ago, pre-provider step → stalled
  const jobA = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: projectA.id,
      inputJson: "{}",
      status: "processing",
      currentStep: "tts",
      updatedAt: minutesAgo(50),
    },
  });
  await prisma.editorProject.update({
    where: { id: projectA.id },
    data: { activeJobId: jobA.id },
  });

  // B) processing but recently alive → untouched
  const jobB = await prisma.videoJob.create({
    data: {
      userId: user.id,
      inputJson: "{}",
      status: "processing",
      currentStep: "stock",
      updatedAt: minutesAgo(10),
    },
  });

  // C) waiting_provider with no next poll → unclaimable forever, must be repaired
  const jobC = await prisma.videoJob.create({
    data: {
      userId: user.id,
      inputJson: "{}",
      status: "waiting_provider",
      currentStep: "avatar",
      providerCheckpointJson: JSON.stringify({ v: 1, phase: "intro_wait" }),
      providerNextPollAt: null,
      updatedAt: minutesAgo(60),
    },
  });

  // D) processing at a provider-bound step with a live checkpoint → provider work owns
  //    its own (longer) deadline, so the 45-min stall rule must not touch it
  const jobD = await prisma.videoJob.create({
    data: {
      userId: user.id,
      inputJson: "{}",
      status: "processing",
      currentStep: "avatar",
      providerCheckpointJson: JSON.stringify({ v: 1, phase: "intro_wait" }),
      updatedAt: minutesAgo(50),
    },
  });

  // E) queued for 3 h → worker backlog, not a stall
  const jobE = await prisma.videoJob.create({
    data: {
      userId: user.id,
      inputJson: "{}",
      status: "queued",
      createdAt: minutesAgo(180),
      updatedAt: minutesAgo(180),
    },
  });

  const first = await watchdog.sweepStalledVideoJobs(now);
  ok(
    first.failed.length === 1 && first.failed[0] === jobA.id,
    `sweep fails exactly the stalled job (got ${JSON.stringify(first.failed)})`,
  );
  ok(
    first.repairedPoll.length === 1 && first.repairedPoll[0] === jobC.id,
    `sweep repairs exactly the unclaimable provider wait (got ${JSON.stringify(first.repairedPoll)})`,
  );

  // A: failed the same way a normal terminal failure does (refund + project transition)
  const afterA = await prisma.videoJob.findUniqueOrThrow({ where: { id: jobA.id } });
  ok(afterA.status === "failed", "A) stalled job → failed");
  ok(afterA.errorCode === "job_stalled", "A) errorCode is job_stalled");
  ok(afterA.errorMessage === EXPECTED_MESSAGE, `A) exact Thai failure copy (got ${afterA.errorMessage})`);
  ok(afterA.reservationRefundPending === true, "A) reservationRefundPending set for settlement retry");
  ok(afterA.reservationRefundReason === "job_stalled", "A) reservationRefundReason is job_stalled");
  ok(afterA.finishedAt !== null, "A) finishedAt stamped");
  ok(afterA.providerNextPollAt === null, "A) provider poll cleared");
  const afterProjectA = await prisma.editorProject.findUniqueOrThrow({ where: { id: projectA.id } });
  ok(afterProjectA.status === "draft", `A) owning project returns to draft (got ${afterProjectA.status})`);

  // telemetry
  const events = await prisma.telemetryEvent.findMany({ where: { name: "video_job_stalled" } });
  ok(events.length === 1, `telemetry: one video_job_stalled event (got ${events.length})`);
  ok(events[0]?.category === "error", "telemetry: category error");
  ok(events[0]?.source === "server", "telemetry: source server");
  ok(events[0]?.step === "tts", `telemetry: step is the stalled step (got ${events[0]?.step})`);
  ok(events[0]?.userId === user.id, "telemetry: attributed to the job owner");

  // B, D, E untouched
  const afterB = await prisma.videoJob.findUniqueOrThrow({ where: { id: jobB.id } });
  ok(afterB.status === "processing", "B) recently-alive job untouched");
  ok(afterB.updatedAt.getTime() === minutesAgo(10).getTime(), "B) row not rewritten");
  const afterD = await prisma.videoJob.findUniqueOrThrow({ where: { id: jobD.id } });
  ok(afterD.status === "processing", "D) provider-bound job untouched by the 45-min rule");
  ok(afterD.updatedAt.getTime() === minutesAgo(50).getTime(), "D) row not rewritten");
  const afterE = await prisma.videoJob.findUniqueOrThrow({ where: { id: jobE.id } });
  ok(afterE.status === "queued", "E) 3h-old queued job stays queued (backlog, not a stall)");
  ok(afterE.updatedAt.getTime() === minutesAgo(180).getTime(), "E) row not rewritten");

  // C repaired, status untouched
  const afterC = await prisma.videoJob.findUniqueOrThrow({ where: { id: jobC.id } });
  ok(afterC.status === "waiting_provider", "C) repaired row keeps waiting_provider");
  ok(afterC.providerNextPollAt?.getTime() === now.getTime(), "C) providerNextPollAt set to now");
  ok(afterC.providerCheckpointJson !== null, "C) provider checkpoint preserved");

  // idempotency: a second sweep at the same instant finds nothing left to do
  const second = await watchdog.sweepStalledVideoJobs(now);
  ok(second.failed.length === 0, `second sweep fails nothing (got ${JSON.stringify(second.failed)})`);
  ok(
    second.repairedPoll.length === 0,
    `second sweep repairs nothing (got ${JSON.stringify(second.repairedPoll)})`,
  );
  const eventsAfter = await prisma.telemetryEvent.count({ where: { name: "video_job_stalled" } });
  ok(eventsAfter === 1, "idempotent sweep does not re-emit telemetry");

  // claim change: a waiting_provider row with a NULL next poll must be claimable, so a
  // repaired-or-not row can never sit outside every claim query.
  await prisma.videoJob.deleteMany({});
  const jobF = await prisma.videoJob.create({
    data: {
      userId: user.id,
      inputJson: "{}",
      status: "waiting_provider",
      currentStep: "avatar",
      providerNextPollAt: null,
    },
  });
  const claimed = await claimNextRunnableJob(now);
  ok(claimed?.id === jobF.id, "claimNextRunnableJob claims a NULL-poll provider wait");
  ok(claimed?.status === "processing", "claimed NULL-poll job moves to processing");
  const claimedTwice = await claimNextRunnableJob(now);
  ok(claimedTwice === null, "the NULL-poll job cannot be double-claimed");

  // wiring: the sweep only protects customers if the worker actually runs it and CI guards it.
  const workerSrc = readFileSync("scripts/mcp-video-worker.ts", "utf8");
  ok(workerSrc.includes("sweepStalledVideoJobs"), "worker loop calls sweepStalledVideoJobs");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  ok(
    typeof pkg.scripts["verify:video-job-watchdog"] === "string",
    "package.json exposes verify:video-job-watchdog",
  );
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  ok(ci.includes("npm run verify:video-job-watchdog"), "ci.yml runs verify:video-job-watchdog");

  await prisma.$disconnect();
}

main()
  .then(() => {
    if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
    console.log("\nall video-job watchdog checks passed");
  })
  .catch((e) => { console.error(e); process.exit(1); });
