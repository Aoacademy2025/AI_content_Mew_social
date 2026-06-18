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

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nALL PASS");
}
main().catch((e) => { console.error(e); process.exit(1); });
