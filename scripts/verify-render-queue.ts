// Run with: npm run verify:render-queue
// Spins a throwaway SQLite DB, exercises job-store transitions, asserts, exits non-zero on failure.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "rq-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let failures = 0;
const ok = (cond: boolean, msg: string) => { if (!cond) { failures++; console.error("FAIL:", msg); } else console.log("ok:", msg); };

async function main() {
  const store = await import("../src/lib/render/job-store");
  const { prisma } = await import("../src/lib/prisma");

  // 1. enqueue → claim moves QUEUED→RUNNING exactly once
  const a = await store.enqueueRenderJob({ userId: "u1", type: "RENDER", payload: { shortVideoConfig: {} } });
  const c1 = await store.claimNextRenderJob();
  const c2 = await store.claimNextRenderJob();
  ok(c1?.id === a.id, "first claim returns the queued job");
  ok(c2 === null, "second claim returns null (no double-claim)");

  // 2. concurrent claim: two enqueued, two parallel claimers, no double-claim
  await store.enqueueRenderJob({ userId: "u1", type: "RENDER", payload: { shortVideoConfig: {} } });
  await store.enqueueRenderJob({ userId: "u1", type: "RENDER", payload: { shortVideoConfig: {} } });
  const [x, y] = await Promise.all([store.claimNextRenderJob(), store.claimNextRenderJob()]);
  ok(!!x && !!y && x!.id !== y!.id, "two parallel claimers get two different jobs");

  // 2b. markReserved flags reservedQuota WITHOUT calling reserveClipUsage (PR-7):
  // the route reserves once before enqueue, so the queue path must NOT double-reserve.
  // No User row exists here, so a reserveClipUsage call would throw quota_exceeded —
  // markReserved must succeed regardless and set reservedQuota=true on the row.
  const mr = await store.enqueueRenderJob({ userId: "u1", type: "RENDER", payload: { shortVideoConfig: {} }, markReserved: true });
  const mrJob = await store.getRenderJob(mr.id);
  ok(mrJob?.reservedQuota === true, "markReserved sets reservedQuota=true without re-reserving");

  // 2c. a BURN job (markReserved omitted/false) holds NO reservation — it reuses the
  // video's existing charge.
  // NOTE: the complementary route-level contract — "BURN must skip reserveClipUsage when
  // RENDER_VIA_QUEUE=1" — is enforced in src/app/api/videos/render/route.ts (the gate
  // around reserveClipUsage at ~line 314). It cannot be exercised here because this
  // store-level verify cannot invoke the HTTP handler's reserve-then-return flow.
  const burn = await store.enqueueRenderJob({ userId: "u1", type: "BURN", payload: { shortVideoConfig: {}, subtitleOverlayConfig: {} } });
  const burnJob = await store.getRenderJob(burn.id);
  ok(burnJob?.reservedQuota === false, "BURN job (no markReserved) holds no reservation");

  // 3. sweeper requeues a RUNNING job with a stale heartbeat (attempts left)
  const stale = await prisma.renderJob.create({ data: { userId: "u1", type: "RENDER", payload: "{}", status: "RUNNING", attempts: 0, maxAttempts: 2, heartbeatAt: new Date(Date.now() - 10 * 60_000) } });
  const swept = await store.sweepDeadRenderJobs(90_000);
  const after = await store.getRenderJob(stale.id);
  ok(swept >= 1, "sweeper reports work");
  ok(after?.status === "QUEUED", "stale RUNNING job requeued (attempts left)");

  // 4. sweeper fails (not requeues) when attempts exhausted, and refunds quota once
  const dead = await prisma.renderJob.create({ data: { userId: "u1", type: "RENDER", payload: "{}", status: "RUNNING", attempts: 2, maxAttempts: 2, reservedQuota: true, videoId: "v1", heartbeatAt: new Date(Date.now() - 10 * 60_000) } });
  await store.sweepDeadRenderJobs(90_000);
  const deadAfter = await store.getRenderJob(dead.id);
  ok(deadAfter?.status === "FAILED", "exhausted job → FAILED");

  // 5. idempotent refund: failing an already-FAILED job does not double-refund (no throw, status stays FAILED)
  await store.failRenderJob(dead.id, new Error("again"));
  const deadAfter2 = await store.getRenderJob(dead.id);
  ok(deadAfter2?.status === "FAILED", "re-failing a FAILED job is a no-op (idempotent)");

  // 6. graceful-drain requeue nets ZERO consumed attempts: enqueue → claim (attempts 0→1)
  // → requeueForShutdown (QUEUED, attempts 1→0). A deploy must not burn a retry.
  // Drain any leftover QUEUED jobs first (e.g. the requeued stale job from step 3) so
  // the oldest-first claim deterministically returns OUR job, not an earlier one.
  await prisma.renderJob.deleteMany({ where: { status: "QUEUED" } });
  const dr = await store.enqueueRenderJob({ userId: "u1", type: "RENDER", payload: { shortVideoConfig: {} } });
  const drBefore = await store.getRenderJob(dr.id);
  ok(drBefore?.attempts === 0, "newly enqueued job has attempts=0");
  const drClaimed = await store.claimNextRenderJob();
  ok(drClaimed?.id === dr.id && drClaimed?.attempts === 1, "claim increments attempts to 1 and sets RUNNING");
  ok(drClaimed?.status === "RUNNING", "claimed job is RUNNING");
  await store.requeueForShutdown(dr.id);
  const drAfter = await store.getRenderJob(dr.id);
  ok(drAfter?.status === "QUEUED", "drain requeues job to QUEUED");
  ok(drAfter?.attempts === 0, "drain requeue decrements attempts back to 0 (net-zero attempt consumed)");
  ok(drAfter?.startedAt === null && drAfter?.heartbeatAt === null, "drain requeue clears startedAt + heartbeatAt");

  // 6b. requeueForShutdown is a no-op on a non-RUNNING job (can't resurrect terminal/queued)
  await store.requeueForShutdown(dr.id); // dr is QUEUED now
  const drNoop = await store.getRenderJob(dr.id);
  ok(drNoop?.attempts === 0, "requeueForShutdown on a QUEUED job is a no-op (attempts unchanged, not negative)");

  // 7. drain-race guard: a late catch calling failRenderJob on a QUEUED job (already
  // requeued by requeueForShutdown) must be a no-op — QUEUED must stay QUEUED.
  // This closes the shutdown race: shutdown() calls requeueForShutdown (RUNNING→QUEUED),
  // then runOne's catch calls failRenderJob — without the QUEUED guard the job would be
  // re-failed, defeating the drain guarantee.
  const race = await store.enqueueRenderJob({ userId: "u1", type: "RENDER", payload: { shortVideoConfig: {} } });
  await prisma.renderJob.update({ where: { id: race.id }, data: { status: "QUEUED" } }); // ensure QUEUED
  await store.failRenderJob(race.id, new Error("late catch from runOne during drain"));
  const raceAfter = await store.getRenderJob(race.id);
  ok(raceAfter?.status === "QUEUED", "failRenderJob on a QUEUED job is a no-op (drain-race guard)");

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nALL PASS");
}
main().catch((e) => { console.error(e); process.exit(1); });
