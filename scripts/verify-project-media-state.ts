import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureRoot = mkdtempSync(join(tmpdir(), "project-media-state-"));
const rendersRoot = join(fixtureRoot, "public", "renders");
mkdirSync(rendersRoot, { recursive: true });
writeFileSync(join(rendersRoot, "available.mp4"), "video");
writeFileSync(join(rendersRoot, "empty.mp4"), "");
mkdirSync(join(rendersRoot, "directory.mp4"));
writeFileSync(join(fixtureRoot, "outside.mp4"), "outside");
symlinkSync(join(fixtureRoot, "outside.mp4"), join(rendersRoot, "symlink.mp4"));

process.env.DATABASE_URL = `file:${join(fixtureRoot, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

const NOW = new Date("2026-07-11T00:00:00.000Z");
const FUTURE = new Date("2026-07-12T00:00:00.000Z");
const PAST = new Date("2026-07-10T00:00:00.000Z");

async function main() {
  const { projectMediaState, resolveProjectMediaState } = await import("../src/lib/media-retention");
  const { getEditorProjectWithMediaState } = await import("../src/lib/editor-projects");
  const { prisma } = await import("../src/lib/prisma");

  assert.deepEqual(
    projectMediaState({ mediaExpiresAt: FUTURE, mediaAvailable: true, now: NOW }),
    { status: "available", expiresAt: FUTURE.toISOString() },
    "pure state resolver reports available media",
  );
  assert.deepEqual(
    projectMediaState({ mediaExpiresAt: NOW, mediaAvailable: true, now: NOW }),
    { status: "expired", expiredAt: NOW.toISOString(), canRerender: true },
    "pure state resolver gives expiry precedence at the exact boundary",
  );

  assert.deepEqual(
    await resolveProjectMediaState({
      videoUrl: "/api/renders/available.mp4",
      mediaExpiresAt: FUTURE,
      now: NOW,
      rendersRoot,
    }),
    { status: "available", expiresAt: FUTURE.toISOString() },
    "a non-empty regular local render is available before expiry",
  );

  assert.deepEqual(
    await resolveProjectMediaState({
      videoUrl: "/renders/available.mp4",
      mediaExpiresAt: NOW,
      now: NOW,
      rendersRoot,
    }),
    { status: "expired", expiredAt: NOW.toISOString(), canRerender: true },
    "expiry wins at the exact timestamp even when the file still exists",
  );

  assert.deepEqual(
    await resolveProjectMediaState({
      videoUrl: "/api/renders/missing.mp4",
      mediaExpiresAt: FUTURE,
      now: NOW,
      rendersRoot,
    }),
    { status: "missing", canRerender: true, supportCode: "MEDIA_FILE_MISSING" },
    "missing before expiry is an incident",
  );

  assert.deepEqual(
    await resolveProjectMediaState({
      videoUrl: "/api/renders/missing.mp4",
      mediaExpiresAt: PAST,
      now: NOW,
      rendersRoot,
    }),
    { status: "expired", expiredAt: PAST.toISOString(), canRerender: true },
    "missing after expiry is normal expiry",
  );

  for (const videoUrl of [
    "/api/renders/../outside.mp4",
    "/api/renders/%2e%2e%2foutside.mp4",
    "/api/renders/symlink.mp4",
    "/api/renders/empty.mp4",
    "/api/renders/directory.mp4",
  ]) {
    assert.deepEqual(
      await resolveProjectMediaState({ videoUrl, mediaExpiresAt: FUTURE, now: NOW, rendersRoot }),
      { status: "missing", canRerender: true, supportCode: "MEDIA_FILE_MISSING" },
      `${videoUrl} fails closed as missing`,
    );
  }

  assert.deepEqual(
    await resolveProjectMediaState({
      videoUrl: "https://media.example.test/preview.mp4",
      mediaExpiresAt: FUTURE,
      now: NOW,
      rendersRoot,
    }),
    { status: "available", expiresAt: FUTURE.toISOString() },
    "external URLs use expiry without synchronous health fetching",
  );

  assert.deepEqual(
    await resolveProjectMediaState({
      videoUrl: "/api/renders/available.mp4",
      mediaExpiresAt: null,
      now: NOW,
      rendersRoot,
    }),
    { status: "missing", canRerender: true, supportCode: "MEDIA_EXPIRY_UNKNOWN" },
    "legacy done jobs with null expiry never render or claim normal expiry",
  );

  await prisma.user.createMany({
    data: [
      { id: "media-state-alice", name: "Alice", email: "media-state-alice@example.test", plan: "PRO" },
      { id: "media-state-bob", name: "Bob", email: "media-state-bob@example.test", plan: "PRO" },
    ],
  });
  await prisma.editorProject.create({
    data: {
      id: "media-state-project",
      userId: "media-state-alice",
      title: "Media state",
      activeJobId: "media-state-preview",
      activeExportJobId: "media-state-export",
    },
  });
  await prisma.videoJob.createMany({
    data: [
      {
        id: "media-state-preview",
        userId: "media-state-alice",
        projectId: "media-state-project",
        type: "create",
        status: "done",
        progress: 100,
        inputJson: "{}",
        outputJson: JSON.stringify({ videoUrl: "/api/renders/missing.mp4" }),
        mediaExpiresAt: FUTURE,
      },
      {
        id: "media-state-export",
        userId: "media-state-alice",
        projectId: "media-state-project",
        type: "export",
        status: "done",
        progress: 100,
        inputJson: "{}",
        outputJson: JSON.stringify({ videoUrl: "https://media.example.test/export.mp4" }),
        mediaExpiresAt: FUTURE,
      },
    ],
  });

  const owned = await getEditorProjectWithMediaState("media-state-alice", "media-state-project", {
    now: NOW,
    rendersRoot,
  });
  assert.deepEqual(
    owned?.previewMediaState,
    { status: "available", expiresAt: FUTURE.toISOString() },
    "project detail prefers activeExportJobId over activeJobId",
  );
  assert.equal(
    await getEditorProjectWithMediaState("media-state-bob", "media-state-project", {
      now: NOW,
      rendersRoot,
    }),
    null,
    "project detail preserves owner isolation",
  );

  await prisma.$disconnect();
  console.log("PASS project media state");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
