import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransientSqliteRetry } from "../src/lib/sqlite-retry";

async function waitForLock(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for SQLite lock")), 2_000);
    child.stdout.on("data", (chunk) => {
      if (!String(chunk).includes("LOCKED")) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`sqlite lock process exited early (${code})`)));
  });
}

async function main() {
  let attempts = 0;
  const retried = await withTransientSqliteRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("timed out fetching a new connection"), { code: "P1008" });
      return "ok";
    },
    { maxAttempts: 3, baseDelayMs: 1, sleep: async () => undefined },
  );
  assert.equal(retried, "ok");
  assert.equal(attempts, 3, "P1008 should receive a bounded retry");

  let nonTransientAttempts = 0;
  await assert.rejects(
    withTransientSqliteRetry(async () => {
      nonTransientAttempts += 1;
      throw Object.assign(new Error("bad input"), { code: "P2009" });
    }, { sleep: async () => undefined }),
  );
  assert.equal(nonTransientAttempts, 1, "non-transient Prisma errors must not retry");

  const dbDir = mkdtempSync(join(tmpdir(), "sqlite-read-contention-"));
  const dbPath = join(dbDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });
  const { prisma } = await import("../src/lib/prisma");
  const { syncSharedUsageCycle, usageLimitForPlan } = await import("../src/lib/usage-limits");
  const { minutesPerMonthForPlan } = await import("../src/lib/plan-limits");
  const now = new Date();
  const user = await prisma.user.create({
    data: {
      id: "active-usage-reader",
      name: "Active Usage Reader",
      email: "active-usage-reader@example.invalid",
      plan: "FREE",
      usagePeriodStartedAt: now,
      usageLimit: usageLimitForPlan("FREE"),
      minutesLimit: minutesPerMonthForPlan("FREE"),
    },
  });
  await prisma.creditBalance.create({
    data: { userId: user.id, granted: 0, purchased: 0, grantedResetAt: now },
  });
  const project = await prisma.editorProject.create({
    data: {
      id: "contention-editor-project",
      userId: user.id,
      title: "Before retry",
      status: "draft",
    },
  });
  const videoJob = await prisma.videoJob.create({
    data: {
      id: "contention-video-job",
      userId: user.id,
      projectId: project.id,
      status: "processing",
      currentStep: "captions",
      progress: 20,
      inputJson: "{}",
    },
  });
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  await prisma.$queryRawUnsafe("PRAGMA busy_timeout=50");

  const lock = spawn("sqlite3", [dbPath], { stdio: ["pipe", "pipe", "pipe"] });
  lock.stdin.write("PRAGMA journal_mode=WAL;\nPRAGMA busy_timeout=1000;\nBEGIN IMMEDIATE;\n.print LOCKED\n");
  await waitForLock(lock);
  try {
    const usage = await syncSharedUsageCycle(user.id, new Date(now.getTime() + 1_000));
    assert.equal(usage?.usageCount, 0, "an active usage-window read must not require SQLite's writer lock");
    const { getBalance } = await import("../src/lib/credits");
    const balance = await getBalance(user.id, new Date(now.getTime() + 1_000));
    assert.equal(balance.total, 0, "an existing balance with no expiry work must remain read-only");
    const { getStarterAiImageAllowanceStatus } = await import("../src/lib/starter-ai-image-allowance.server");
    const allowance = await getStarterAiImageAllowanceStatus(user.id, new Date(now.getTime() + 1_000));
    assert.equal(allowance.accessMode, "locked", "an existing non-trial allowance status must remain read-only");
  } finally {
    lock.stdin.end("ROLLBACK;\n.quit\n");
  }

  const { setJobStep } = await import("../src/lib/mcp/video-job");
  const originalVideoJobUpdate = prisma.videoJob.update.bind(prisma.videoJob);
  let stepAttempts = 0;
  prisma.videoJob.update = (async (...args: Parameters<typeof originalVideoJobUpdate>) => {
    stepAttempts += 1;
    if (stepAttempts === 1) {
      throw Object.assign(new Error("database failed to respond while changing pipeline step"), { code: "P1008" });
    }
    return originalVideoJobUpdate(...args);
  }) as typeof prisma.videoJob.update;
  try {
    await setJobStep(videoJob.id, "keywords", 30);
  } finally {
    prisma.videoJob.update = originalVideoJobUpdate as typeof prisma.videoJob.update;
  }
  assert.equal(stepAttempts, 2, "pipeline step transition retries a transient SQLite timeout exactly once");
  const transitioned = await prisma.videoJob.findUniqueOrThrow({ where: { id: videoJob.id } });
  assert.equal(transitioned.currentStep, "keywords", "pipeline step transition survives transient writer contention");
  assert.equal(transitioned.progress, 30);

  const { updateEditorProject } = await import("../src/lib/editor-projects");
  const originalTransaction = prisma.$transaction.bind(prisma);
  let editorAttempts = 0;
  prisma.$transaction = (async (...args: Parameters<typeof originalTransaction>) => {
    editorAttempts += 1;
    if (editorAttempts === 1) {
      throw Object.assign(new Error("database failed to respond while saving editor project"), { code: "P1008" });
    }
    return originalTransaction(...args);
  }) as typeof prisma.$transaction;
  try {
    await updateEditorProject(user.id, project.id, { title: "After retry" });
  } finally {
    prisma.$transaction = originalTransaction as typeof prisma.$transaction;
  }
  assert.equal(editorAttempts, 2, "editor PATCH retries a transient SQLite timeout exactly once");
  const updatedProject = await prisma.editorProject.findUniqueOrThrow({ where: { id: project.id } });
  assert.equal(updatedProject.title, "After retry", "editor PATCH survives transient writer contention");

  await prisma.$disconnect();

  console.log("PASS SQLite retries cover active reads, pipeline transitions, and editor PATCH writes");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
