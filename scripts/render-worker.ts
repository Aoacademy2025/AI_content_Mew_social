// Long-lived render worker: drains the RenderJob queue (QUEUED→DONE/FAILED) by
// rendering through the shared runRender core. Heartbeat is PROGRESS-DERIVED
// (advances only while the render advances), backed by a stall watchdog and a
// wall-clock cap; cancellation flows through Remotion's makeCancelSignal (which
// tears down its own headless Chromium). Graceful drain on deploy requeues the
// in-flight job WITHOUT consuming a retry attempt.
//
// Start (prod): pm2 start ecosystem.config.js --only render-worker --update-env && pm2 save
import "dotenv/config"; // load .env BEFORE prisma init — tsx (unlike Next) doesn't auto-load it
import { makeCancelSignal } from "@remotion/renderer";
import { prisma } from "../src/lib/prisma";
import {
  claimNextRenderJob,
  updateRenderProgress,
  heartbeat,
  isCancelRequested,
  finishRenderJob,
  failRenderJob,
  requeueForShutdown,
} from "../src/lib/render/job-store";
import { runRender, type ResolvedRenderInput } from "../src/lib/render/run-render";

const POLL_MS = Number(process.env.RENDER_WORKER_POLL_MS) || 3000;
const STALL_MS = Number(process.env.RENDER_STALL_MS) || 120_000; // no progress for 2 min ⇒ stuck
const WALLCLOCK_MS = Number(process.env.RENDER_WALLCLOCK_MS) || 45 * 60_000; // hard cap per job
const WATCHDOG_MS = 10_000;

let draining = false;
let current: { id: string; cancel: () => void } | null = null;

// Process-level bundle cache (the cross-process seam). The persisted payload is a
// ResolvedRenderInput MINUS `bundleCache` — a by-reference object with methods that
// can't be serialized across processes. This worker supplies its OWN. Because these
// vars are module-level they persist across jobs, so the Remotion webpack bundle is
// built ONCE and reused for every subsequent render (the "bundle once" goal), exactly
// like the route's cachedBundleLocation/cachedBundleMtime (route.ts:159-160 / 683-688).
// NOTE: the route also persists the cache to disk via saveBundleCache() so it survives
// pm2 restarts; that path uses getRenderTmpDir()/fs in the route module. The worker
// keeps an in-memory cache only — runRender's ensureBundle() rebuilds on first job per
// process boot, then reuses; correctness is unaffected (a missing/stale bundle is
// detected by fingerprint + index.html existence inside runRender).
let workerBundleLocation: string | null = null;
let workerBundleMtime = "";
const workerBundleCache = {
  get: () => ({ location: workerBundleLocation, mtime: workerBundleMtime }),
  set: (location: string | null, mtime: string) => {
    workerBundleLocation = location;
    workerBundleMtime = mtime;
  },
};

type ClaimedJob = NonNullable<Awaited<ReturnType<typeof claimNextRenderJob>>>;

/** A render was cancelled (user request / stall / wall-clock / drain) — Remotion's
 * cancelSignal throws an abort-flavored error. We classify it so an explicit cancel
 * is terminal (no retry) while a genuine failure can requeue. */
function isCancelError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /cancel|aborted|Request closed|stopped/i.test(msg);
}

async function runOne(job: ClaimedJob): Promise<void> {
  const { cancel, cancelSignal } = makeCancelSignal();
  current = { id: job.id, cancel };
  const startedAt = Date.now();
  let lastProgressAt = Date.now();
  let cancelledByWatchdog = false; // a worker-initiated cancel (stall/wallclock/external/drain)

  // Watchdog: progress-derived heartbeat. Every ~10s, in priority order:
  //   1. no progress for STALL_MS         ⇒ cancel (stuck render)
  //   2. running longer than WALLCLOCK_MS  ⇒ cancel (runaway)
  //   3. external cancel requested in DB   ⇒ cancel (user pressed Cancel)
  //   4. otherwise the render is healthy   ⇒ heartbeat() to keep the sweeper away
  // So heartbeatAt only advances while BOTH the watchdog is alive AND no kill
  // condition is met — it is liveness of a *healthy advancing* render, not a dumb tick.
  const watchdog = setInterval(async () => {
    try {
      const now = Date.now();
      if (now - lastProgressAt > STALL_MS) {
        console.warn(`[render-worker] stall (no progress ${Math.round((now - lastProgressAt) / 1000)}s) — cancelling ${job.id}`);
        cancelledByWatchdog = true;
        cancel();
      } else if (now - startedAt > WALLCLOCK_MS) {
        console.warn(`[render-worker] wallclock cap (${Math.round((now - startedAt) / 1000)}s) — cancelling ${job.id}`);
        cancelledByWatchdog = true;
        cancel();
      } else if (await isCancelRequested(job.id)) {
        console.log(`[render-worker] cancel requested — cancelling ${job.id}`);
        cancelledByWatchdog = true;
        cancel();
      } else {
        await heartbeat(job.id);
      }
    } catch {
      // fail-open: a transient DB hiccup in the watchdog must never crash the worker
    }
  }, WATCHDOG_MS);

  try {
    // Reconstruct the full render input by re-attaching THIS process's bundleCache.
    const input: ResolvedRenderInput = {
      ...(JSON.parse(job.payload) as Omit<ResolvedRenderInput, "bundleCache">),
      bundleCache: workerBundleCache,
    };
    const result = await runRender(input, {
      jobId: job.id,
      cancelSignal,
      onProgress: (pct, phase) => {
        lastProgressAt = Date.now();
        void updateRenderProgress(job.id, pct, phase).catch(() => {});
      },
    });
    await finishRenderJob(job.id, result.videoUrl);
    console.log(`[render-worker] done ${job.id} → ${result.videoUrl}`);
  } catch (e) {
    // runRender's finally releases its bundle ref; Remotion tears down its own
    // headless Chromium when cancelSignal fires. No ffmpeg/probe children are
    // spawned inside runRender (those live in the route's pre-enqueue asset
    // resolution), so there is no orphan-child surface to reap in the worker.
    const cancelled = cancelledByWatchdog || isCancelError(e);
    // An explicit cancel (user / stall / wallclock) is TERMINAL — no retry, requeue:false.
    // This is intentional first-version policy: stalled renders would just re-stall.
    // A genuine render error retries (requeue, attempts permitting).
    await failRenderJob(job.id, e, { requeue: !cancelled });
    console.error(`[render-worker] ${cancelled ? "cancelled" : "failed"} ${job.id}:`, e instanceof Error ? e.message : e);
  } finally {
    clearInterval(watchdog);
    current = null;
  }
}

async function loop(): Promise<void> {
  while (!draining) {
    const job = await claimNextRenderJob().catch((e) => {
      console.error("[render-worker] claim error:", e);
      return null;
    });
    if (draining) break; // a drain may have started while we were claiming
    if (!job) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    console.log(`[render-worker] claimed ${job.id} (${job.type})`);
    await runOne(job);
  }
}

// Graceful drain (deploy / SIGTERM): stop claiming, cancel the in-flight render, and
// put it back to QUEUED via requeueForShutdown — which DECREMENTS attempts by 1 to undo
// the claim's increment, so a deploy nets ZERO consumed attempts (a deploy is not a
// real failure). cancel() aborts renderMedia (Chromium torn down); runRender's finally
// releases the bundle ref. PM2 kill_timeout (30s) gives this time before SIGKILL.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  draining = true;
  console.log(`[render-worker] ${signal} received — draining`);
  if (current) {
    const { id, cancel } = current;
    try {
      cancel();
    } catch {}
    try {
      await requeueForShutdown(id); // QUEUED + attempts-1 (net-zero attempt for deploy)
      console.log(`[render-worker] requeued in-flight ${id} for shutdown (no attempt consumed)`);
    } catch (e) {
      console.error(`[render-worker] requeueForShutdown failed for ${id}:`, e);
    }
  }
  try {
    await prisma.$disconnect();
  } catch {}
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("[render-worker] DATABASE_URL not set — refusing to start");
    process.exit(1);
  }
  console.log(
    `[render-worker] started (poll=${POLL_MS}ms, stall=${STALL_MS}ms, wallclock=${WALLCLOCK_MS}ms)`,
  );
  await loop();
}

main().catch((e) => {
  console.error("[render-worker] fatal:", e);
  process.exit(1);
});
