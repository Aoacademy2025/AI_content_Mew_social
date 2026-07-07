// MCP headless video worker: claims queued VideoJobs and runs the orchestrator.
// Start (prod): export MCP_SERVICE_SECRET=...; pm2 start ecosystem.config.js --only mcp-video-worker --update-env && pm2 save
import "dotenv/config"; // load .env BEFORE prisma init — tsx (unlike Next) doesn't auto-load it
import { prisma } from "../src/lib/prisma";
import { claimNextQueuedJob, recoverProcessingJobsAfterWorkerRestart } from "../src/lib/mcp/video-job";
import { runOrchestrator } from "../src/lib/mcp/orchestrator";
import { startLoanwordRefresh } from "../src/lib/thai-loanwords-runtime";
import { hydrateServerGeminiKeyEnv } from "../src/lib/server-keys";

const POLL_MS = Number(process.env.MCP_WORKER_POLL_MS ?? 4000);
const ORPHAN_MAX_REQUEUES = Number(process.env.MCP_WORKER_ORPHAN_MAX_REQUEUES ?? 2);

// How many videos this ONE worker orchestrates concurrently (CAP-1, docs/audits/
// 2026-07-07-system-optimization-audit.md). The box has 8 vCPU and 2 render-worker
// instances (ecosystem.config.js), so 2 base renders can run in parallel; matching that
// here (default 2) lets 2 videos flow end-to-end at once instead of serializing through a
// single orchestrator. Above 2 does NOT go faster — extra orchestrations just pile RenderJobs
// behind the 2 render-workers (they queue) and oversubscribe CPU — so 2 is the intended
// ceiling; clamped to [1,4]. Multi-instance was rejected: recoverProcessingJobsAfterWorkerRestart
// blindly requeues/fails ALL `processing` jobs on boot with no worker-id/heartbeat guard, so a
// second PM2 instance restarting mid-job would treat a live sibling's job as orphaned and
// double-run it. A single process keeps that boot-recovery invariant intact; in-process
// concurrency is the low-risk path. claimNextQueuedJob is an atomic guarded update, and slots
// are filled by claiming sequentially (below), so two slots never claim the same VideoJob.
const CONCURRENCY = (() => {
  const raw = Number(process.env.MCP_WORKER_CONCURRENCY ?? 2);
  if (!Number.isFinite(raw)) return 2;
  return Math.min(4, Math.max(1, Math.floor(raw)));
})();

let running = true;
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

async function runJob(job: { id: string; userId: string }): Promise<void> {
  console.log(`[mcp-worker] running job ${job.id} for user ${job.userId}`);
  try {
    await runOrchestrator(job.id, job.userId); // orchestrator wraps its own job errors in failJob
  } catch (e) {
    // runOrchestrator handles job-level failures internally (failJob). This only trips on an
    // infra-level throw (e.g. DB unavailable while reading the job). Swallow it so one job can
    // never crash the worker or leak a concurrency slot — the job stays `processing` and the
    // next boot's recoverProcessingJobsAfterWorkerRestart requeues/fails it safely.
    console.error(`[mcp-worker] job ${job.id} orchestrator threw:`, e);
  }
  console.log(`[mcp-worker] finished job ${job.id}`);
}

async function main() {
  if (!process.env.MCP_SERVICE_SECRET) {
    console.error("[mcp-worker] MCP_SERVICE_SECRET not set — refusing to start");
    process.exit(1);
  }
  if (process.env.MCP_SERVICE_SECRET.length < 32) {
    console.error("[mcp-worker] MCP_SERVICE_SECRET too short (need ≥32 chars) — refusing to start");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("[mcp-worker] DATABASE_URL not set — refusing to start");
    process.exit(1);
  }

  // Managed Gemini: this standalone worker doesn't run Next's instrumentation, and the
  // platform key now lives in SiteConfig (set via /admin) rather than .env — so hydrate
  // it into process.env.GEMINI_SERVER_KEY before the orchestrator makes any Gemini call,
  // otherwise managed MCP jobs would fall back to BYOK and dead-end on KEY_REQUIRED.
  if (await hydrateServerGeminiKeyEnv()) console.log("[mcp-worker] loaded server Gemini key from DB");

  // Recovery: with a single worker, any 'processing' job at startup was orphaned by a
  // previous deploy/restart. Requeue safe stages instead of failing the user's MCP job.
  const recovered = await recoverProcessingJobsAfterWorkerRestart({ maxRequeues: ORPHAN_MAX_REQUEUES });
  if (recovered.inspected > 0) {
    console.log(
      `[mcp-worker] recovered orphaned processing job(s): inspected=${recovered.inspected} requeued=${recovered.requeued} failed=${recovered.failed}`,
    );
  }
  startLoanwordRefresh(); // load auto-mined loanwords now + refresh every 10 min (unref'd)
  console.log(`[mcp-worker] started (concurrency=${CONCURRENCY})`);

  // Concurrency pool: keep up to CONCURRENCY orchestrations in flight. Slots are filled by
  // claiming SEQUENTIALLY — each claimNextQueuedJob() is awaited before the next, so the
  // just-claimed job is already `processing` (its atomic guarded updateMany committed) before
  // the next findFirst runs. Two slots therefore never claim the same row. Claimed jobs then
  // RUN concurrently: their promises live in `active` and are not awaited by this dispatch loop.
  const active = new Set<Promise<void>>();
  while (running) {
    let claimedThisRound = false;
    try {
      while (running && active.size < CONCURRENCY) {
        const job = await claimNextQueuedJob();
        if (!job) break; // queue empty right now
        claimedThisRound = true;
        const p: Promise<void> = runJob(job);
        active.add(p);
        void p.finally(() => { active.delete(p); });
      }
    } catch (e) {
      console.error("[mcp-worker] claim error:", e);
    }
    if (active.size >= CONCURRENCY) {
      await Promise.race(active).catch(() => {}); // all slots busy — wait for one to free
    } else if (!claimedThisRound) {
      await new Promise((r) => setTimeout(r, POLL_MS)); // free capacity but nothing queued — idle poll
    }
    // else: claimed a job with capacity to spare → loop straight back to fill more slots
  }

  // Drain: running=false stops new claims; let in-flight orchestrations settle. A PM2 deploy
  // SIGKILL may cut this short — any job still `processing` is recovered on the next boot.
  await Promise.allSettled(active);
  await prisma.$disconnect();
  console.log("[mcp-worker] stopped");
}

main();
