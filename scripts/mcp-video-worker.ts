// MCP headless video worker: claims queued VideoJobs and runs the orchestrator.
// Start (prod): export MCP_SERVICE_SECRET=...; pm2 start ecosystem.config.js --only mcp-video-worker --update-env && pm2 save
import "dotenv/config"; // load .env BEFORE prisma init — tsx (unlike Next) doesn't auto-load it
import { prisma } from "../src/lib/prisma";
import { claimNextQueuedJob } from "../src/lib/mcp/video-job";
import { runOrchestrator } from "../src/lib/mcp/orchestrator";
import { startLoanwordRefresh } from "../src/lib/thai-loanwords-runtime";

const POLL_MS = Number(process.env.MCP_WORKER_POLL_MS ?? 4000);
let running = true;
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

async function tick(): Promise<boolean> {
  const job = await claimNextQueuedJob();
  if (!job) return false;
  console.log(`[mcp-worker] running job ${job.id} for user ${job.userId}`);
  await runOrchestrator(job.id, job.userId); // orchestrator wraps its own errors in failJob
  console.log(`[mcp-worker] finished job ${job.id}`);
  return true;
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
  // Reaper: with a single worker, any 'processing' job at startup was orphaned by a previous
  // crash/restart (e.g. OOM mid-render). Fail them so they don't wedge as 'processing' forever.
  const orphaned = await prisma.videoJob.updateMany({
    where: { status: "processing" },
    data: { status: "failed", errorMessage: "worker restarted — job did not finish", finishedAt: new Date() },
  });
  if (orphaned.count > 0) console.log(`[mcp-worker] reaped ${orphaned.count} orphaned processing job(s)`);
  startLoanwordRefresh(); // load auto-mined loanwords now + refresh every 10 min (unref'd)
  console.log("[mcp-worker] started");
  while (running) {
    try {
      const did = await tick();
      if (!did) await new Promise((r) => setTimeout(r, POLL_MS));
    } catch (e) {
      console.error("[mcp-worker] tick error:", e);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
  await prisma.$disconnect();
  console.log("[mcp-worker] stopped");
}

main();
