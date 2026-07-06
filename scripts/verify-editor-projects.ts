// Run with: npx tsx scripts/verify-editor-projects.ts
// Spins a throwaway SQLite DB and verifies EditorProject ownership/persistence contracts.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "editorprojects-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else { passed++; console.log("ok:", msg); }
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const projects = await import("../src/lib/editor-projects");
  const jobs = await import("../src/lib/mcp/video-job");

  const now = new Date();
  const alice = await prisma.user.create({
    data: {
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      plan: "PRO",
      usageCount: 7,
      usageLimit: 100,
      minutesUsed: 12,
      minutesLimit: 80,
      usagePeriodStartedAt: now,
    },
  });
  const bob = await prisma.user.create({
    data: {
      id: "bob",
      name: "Bob",
      email: "bob@example.com",
      plan: "PRO",
      usageCount: 0,
      usageLimit: 100,
      usagePeriodStartedAt: now,
    },
  });

  const p = await projects.createEditorProject(alice.id, {
    title: "  Launch Reel  ",
    draft: { mode: "script", script: "hello" },
  });
  ok(p.title === "Launch Reel", "create trims title");
  ok(p.draft?.script === "hello", "create stores structured draft JSON");

  const usageAfterCreate = await prisma.user.findUnique({ where: { id: alice.id } });
  ok(usageAfterCreate?.usageCount === 7 && usageAfterCreate?.minutesUsed === 12, "project create does not mutate quota counters");

  const aliceList = await projects.listEditorProjects(alice.id);
  const bobList = await projects.listEditorProjects(bob.id);
  ok(aliceList.length === 1 && aliceList[0].id === p.id, "list returns current user's project");
  ok(bobList.length === 0, "list does not leak projects across users");

  let crossUserDenied = false;
  try { await projects.assertEditorProjectOwner(bob.id, p.id); } catch { crossUserDenied = true; }
  ok(crossUserDenied, "assertEditorProjectOwner denies cross-user project");

  const updated = await projects.updateEditorProject(alice.id, p.id, {
    title: "",
    status: "rendering",
    draft: JSON.stringify({ mode: "upload", clipUrl: "/api/renders/a.mp4" }),
    touchLastOpened: true,
  });
  ok(updated?.title === "New Project", "empty title falls back to New Project");
  ok(updated?.status === "rendering", "update accepts known status");
  ok(updated?.draft?.mode === "upload", "update accepts JSON-string draft");

  const job = await jobs.createVideoJob(alice.id, { script: "hello", previewMode: true }, undefined, { projectId: p.id });
  const jobRow = await prisma.videoJob.findUnique({ where: { id: job.id } });
  ok(jobRow?.projectId === p.id, "createVideoJob stores optional projectId");

  await projects.updateEditorProject(alice.id, p.id, { activeJobId: job.id, status: "rendering" });
  await jobs.finishJob(job.id, { version: 2, mode: "preview", videoUrl: "/api/renders/base.mp4" });
  const afterFinish = await prisma.editorProject.findUnique({ where: { id: p.id } });
  ok(afterFinish?.activeJobId === job.id && afterFinish?.status === "post", "finishJob moves preview project to post");

  const failedJob = await jobs.createVideoJob(alice.id, { script: "boom", previewMode: true }, undefined, { projectId: p.id });
  await projects.updateEditorProject(alice.id, p.id, { activeJobId: failedJob.id, status: "rendering" });
  await jobs.failJob(failedJob.id, "expected failure");
  const afterFail = await prisma.editorProject.findUnique({ where: { id: p.id } });
  ok(afterFail?.status === "draft", "failJob clears rendering project back to draft");

  const archived = await projects.archiveEditorProject(alice.id, p.id);
  ok(archived, "archive succeeds for owner");
  ok((await projects.listEditorProjects(alice.id)).length === 0, "archived projects are hidden by default");
  ok((await projects.listEditorProjects(alice.id, { includeArchived: true })).length === 1, "includeArchived returns archived projects");

  let archivedDenied = false;
  try { await projects.assertEditorProjectOwner(alice.id, p.id); } catch { archivedDenied = true; }
  ok(archivedDenied, "archived projects cannot be used for new jobs/videos");

  const usageAfterAll = await prisma.user.findUnique({ where: { id: alice.id } });
  ok(usageAfterAll?.usageCount === 7 && usageAfterAll?.minutesUsed === 12, "project update/archive/job metadata does not mutate quota counters");

  await prisma.$disconnect();

  if (failures) {
    console.error(`\n${failures} FAILED (${passed} passed)`);
    process.exit(1);
  }
  console.log(`\nALL ${passed} EDITOR-PROJECT CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
