// Run with: npx tsx scripts/verify-project-media-state.ts
// Task 6: machine-readable preview media state, safe local-file inspection, and owner isolation.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = mkdtempSync(join(tmpdir(), "project-media-state-"));
const renders = join(workspace, "public", "renders");
mkdirSync(renders, { recursive: true });
writeFileSync(join(renders, "available.mp4"), "video-bytes");
writeFileSync(join(renders, "preview.mp4"), "preview-bytes");
writeFileSync(join(renders, "export.mp4"), "export-bytes");
writeFileSync(join(renders, "zero.mp4"), "");
symlinkSync(join(renders, "available.mp4"), join(renders, "link.mp4"));

process.env.DATABASE_URL = `file:${join(workspace, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

const NOW = new Date("2026-07-11T12:00:00.000Z");
const FUTURE = new Date("2026-07-12T12:00:00.000Z");
const PAST = new Date("2026-07-10T12:00:00.000Z");

async function main() {
  const {
    inspectProjectMediaState,
    resolveProjectMediaState,
  } = await import("../src/lib/media-retention");
  const { prisma } = await import("../src/lib/prisma");
  const {
    getEditorProjectWithMediaState,
    listEditorProjects,
  } = await import("../src/lib/editor-projects");

  assert.deepEqual(
    resolveProjectMediaState({ expiresAt: FUTURE, mediaAvailable: true }, NOW),
    { status: "available", expiresAt: FUTURE.toISOString() },
    "a present preview before expiry is available",
  );
  assert.deepEqual(
    resolveProjectMediaState({ expiresAt: NOW, mediaAvailable: true }, NOW),
    { status: "expired", expiredAt: NOW.toISOString(), canRerender: true },
    "the exact expiry boundary is expired (now >= expiresAt)",
  );
  assert.deepEqual(
    resolveProjectMediaState({ expiresAt: FUTURE, mediaAvailable: false }, NOW),
    { status: "missing", canRerender: true, supportCode: "MEDIA_FILE_MISSING" },
    "a missing preview before expiry is an incident",
  );
  assert.deepEqual(
    resolveProjectMediaState({ expiresAt: PAST, mediaAvailable: false }, NOW),
    { status: "expired", expiredAt: PAST.toISOString(), canRerender: true },
    "expiry wins over missing after expiry",
  );
  assert.deepEqual(
    resolveProjectMediaState({ expiresAt: null, mediaAvailable: true }, NOW),
    { status: "missing", canRerender: true, supportCode: "MEDIA_EXPIRY_UNKNOWN" },
    "legacy null expiry remains unknown, never expired or available",
  );

  assert.deepEqual(
    await inspectProjectMediaState({
      videoUrl: "/api/renders/available.mp4",
      mediaExpiresAt: FUTURE,
      now: NOW,
      cwd: workspace,
    }),
    { status: "available", expiresAt: FUTURE.toISOString() },
    "a canonical non-empty regular file under public/renders is available",
  );
  assert.equal(
    (await inspectProjectMediaState({
      videoUrl: "/renders/missing.mp4",
      mediaExpiresAt: FUTURE,
      now: NOW,
      cwd: workspace,
    })).status,
    "missing",
    "a missing local file before expiry is missing",
  );
  assert.equal(
    (await inspectProjectMediaState({
      videoUrl: "/api/renders/%2e%2e/available.mp4",
      mediaExpiresAt: FUTURE,
      now: NOW,
      cwd: workspace,
    })).status,
    "missing",
    "an encoded traversal URL is never inspected outside public/renders",
  );
  for (const videoUrl of ["/api/renders/link.mp4", "/api/renders/zero.mp4"]) {
    assert.equal(
      (await inspectProjectMediaState({ videoUrl, mediaExpiresAt: FUTURE, now: NOW, cwd: workspace })).status,
      "missing",
      `${videoUrl} is unavailable because local media must be a non-empty regular file`,
    );
  }
  assert.deepEqual(
    await inspectProjectMediaState({
      videoUrl: "https://cdn.example.com/previews/external.mp4",
      mediaExpiresAt: FUTURE,
      now: NOW,
      cwd: workspace,
    }),
    { status: "available", expiresAt: FUTURE.toISOString() },
    "an external URL is available by future non-null expiry without a synchronous fetch",
  );
  assert.equal(
    (await inspectProjectMediaState({
      videoUrl: "/uploads/not-a-canonical-render.mp4",
      mediaExpiresAt: FUTURE,
      now: NOW,
      cwd: workspace,
    })).status,
    "missing",
    "a non-canonical relative path is not treated as an external URL",
  );
  assert.equal(
    (await inspectProjectMediaState({
      videoUrl: "/api/renders/missing.mp4",
      mediaExpiresAt: NOW,
      now: NOW,
      cwd: workspace,
    })).status,
    "expired",
    "exact-boundary expiry wins over a missing local file",
  );

  const userData = (id: string, email: string) => ({
    id,
    name: id,
    email,
    plan: "PRO" as const,
    usageCount: 0,
    usageLimit: 100,
    usagePeriodStartedAt: NOW,
  });
  await prisma.user.createMany({
    data: [userData("media-alice", "media-alice@example.com"), userData("media-bob", "media-bob@example.com")],
  });
  const project = await prisma.editorProject.create({
    data: {
      id: "media-project",
      userId: "media-alice",
      title: "Media state",
      draftJson: JSON.stringify({ script: "keep draft accessible" }),
    },
  });
  const previewJob = await prisma.videoJob.create({
    data: {
      id: "media-preview-job",
      userId: "media-alice",
      projectId: project.id,
      inputJson: "{}",
      outputJson: JSON.stringify({ version: 2, mode: "preview", videoUrl: "/api/renders/preview.mp4" }),
      status: "done",
      mediaExpiresAt: FUTURE,
    },
  });
  const exportExpiry = new Date("2026-07-13T12:00:00.000Z");
  const exportJob = await prisma.videoJob.create({
    data: {
      id: "media-export-job",
      userId: "media-alice",
      projectId: project.id,
      type: "export",
      inputJson: "{}",
      outputJson: JSON.stringify({ version: 2, mode: "export", videoUrl: "/api/renders/export.mp4" }),
      status: "done",
      mediaExpiresAt: exportExpiry,
    },
  });
  await prisma.editorProject.update({
    where: { id: project.id },
    data: { activeJobId: previewJob.id, activeExportJobId: exportJob.id },
  });

  const ownerDetail = await getEditorProjectWithMediaState("media-alice", project.id, {
    now: NOW,
    cwd: workspace,
  });
  assert.deepEqual(
    ownerDetail?.previewMediaState,
    { status: "available", expiresAt: exportExpiry.toISOString() },
    "project detail prefers activeExportJobId over activeJobId",
  );
  assert.equal(ownerDetail?.draft?.script, "keep draft accessible", "project detail preserves non-media draft data");
  assert.equal(
    await getEditorProjectWithMediaState("media-bob", project.id, { now: NOW, cwd: workspace }),
    null,
    "project media detail is owner isolated",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call((await listEditorProjects("media-alice"))[0], "previewMediaState"),
    false,
    "the project list query/response is not expanded with preview media state",
  );

  const legacyProject = await prisma.editorProject.create({
    data: { id: "legacy-media-project", userId: "media-alice", title: "Legacy pointer" },
  });
  const legacyJob = await prisma.videoJob.create({
    data: {
      id: "legacy-null-project-job",
      userId: "media-alice",
      projectId: null,
      inputJson: "{}",
      outputJson: JSON.stringify({ videoUrl: "https://cdn.example.com/legacy.mp4" }),
      status: "done",
      mediaExpiresAt: FUTURE,
    },
  });
  await prisma.editorProject.update({
    where: { id: legacyProject.id },
    data: { activeJobId: legacyJob.id },
  });
  assert.equal(
    (await getEditorProjectWithMediaState("media-alice", legacyProject.id, { now: NOW, cwd: workspace }))
      ?.previewMediaState?.status,
    "available",
    "a same-user legacy active job with null projectId remains resolvable",
  );

  await prisma.editorProject.update({
    where: { id: legacyProject.id },
    data: { activeJobId: exportJob.id },
  });
  assert.equal(
    (await getEditorProjectWithMediaState("media-alice", legacyProject.id, { now: NOW, cwd: workspace }))
      ?.previewMediaState,
    null,
    "a job attached to a different non-null project is not resolved through an invalid pointer",
  );

  const jobRoute = readFileSync(join(process.cwd(), "src/app/api/videos/jobs/[id]/route.ts"), "utf8");
  assert.match(jobRoute, /mediaExpiresAt:\s*true/, "the narrow job poll selects mediaExpiresAt");
  assert.doesNotMatch(jobRoute, /inputJson:\s*true/, "the hot job poll never selects inputJson");
  assert.match(jobRoute, /mediaState/, "done job responses include mediaState");

  const mediaRetention = readFileSync(join(process.cwd(), "src/lib/media-retention.ts"), "utf8");
  assert.doesNotMatch(
    mediaRetention,
    /media-cleanup/,
    "the hot media-state inspector does not load cleanup/quarantine modules",
  );

  const projectRoute = readFileSync(join(process.cwd(), "src/app/api/editor-projects/[id]/route.ts"), "utf8");
  assert.match(projectRoute, /getEditorProjectWithMediaState/, "only project detail GET uses the media-state helper");

  await prisma.$disconnect();
  console.log("PASS project media state verifier");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(workspace, { recursive: true, force: true });
  });
