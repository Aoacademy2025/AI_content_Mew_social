// Run with: npm run verify:story-film-render
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFfmpegPath } from "../src/lib/ffmpeg-path";

const fixtureRoot = mkdtempSync(join(tmpdir(), "story-film-render-"));
const rendersDir = join(fixtureRoot, "public", "renders");
const musicDir = join(fixtureRoot, "public", "music");
mkdirSync(rendersDir, { recursive: true });
mkdirSync(musicDir, { recursive: true });
process.env.DATABASE_URL = `file:${join(fixtureRoot, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
function ok(condition: unknown, message: string) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`ok: ${message}`);
}

function ffmpeg(args: string[]) {
  execFileSync(getFfmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: "inherit",
    timeout: 120_000,
  });
}

async function main() {
  const presenterPath = join(rendersDir, "presenter.mp4");
  const brollPath = join(rendersDir, "scene-01.png");
  const musicPath = join(musicDir, "story-bed.wav");
  ffmpeg([
    "-f", "lavfi", "-i", "color=c=0x26375a:s=270x480:r=30:d=3",
    "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100:duration=3",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    presenterPath,
  ]);
  ffmpeg(["-f", "lavfi", "-i", "color=c=0xb86836:s=270x480", "-frames:v", "1", brollPath]);
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=110:sample_rate=44100:duration=3", "-c:a", "pcm_s16le", musicPath]);

  const { prisma } = await import("../src/lib/prisma");
  const renderer = await import("../src/lib/story-film-render.server");
  try {
    const user = await prisma.user.create({
      data: { id: "render-mew", name: "Mew", email: "render-mew@example.com", plan: "BUSINESS" },
    });
    const presenter = await prisma.storyFilmPresenterAsset.create({
      data: {
        userId: user.id,
        storageUrl: "/api/renders/presenter.mp4",
        originalName: "presenter.mp4",
        mimeType: "video/mp4",
        sizeBytes: 10_000,
        width: 270,
        height: 480,
        durationMs: 3_000,
      },
    });
    const project = await prisma.storyFilmProject.create({
      data: {
        userId: user.id,
        title: "Final render fixture",
        idempotencyKey: "render:fixture:001",
        presentationMode: "presenter_led",
        narrativeSource: "A visual beat leads back to the presenter.",
        narrationMasterUrl: "/api/renders/presenter.mp4",
        narrationDurationMs: 3_000,
        presenterAssetId: presenter.id,
        musicSource: "user",
        musicTrackId: "fixture-track",
        musicUrl: "/api/music/story-bed.wav",
        stage: "final_render",
        status: "waiting_generation",
        awaitingApproval: false,
      },
    });
    await prisma.storyFilmScene.createMany({ data: [
      {
        projectId: project.id,
        generationEpoch: 1,
        sceneKey: "scene-01",
        sequence: 0,
        startMs: 0,
        endMs: 1_500,
        sourceExcerpt: "The visual beat begins.",
        grokPrompt: "Vertical cinematic establishing frame.",
        mediaPlan: "image_with_motion",
        visualOwner: "broll",
      },
      {
        projectId: project.id,
        generationEpoch: 1,
        sceneKey: "scene-02",
        sequence: 1,
        startMs: 1_500,
        endMs: 3_000,
        sourceExcerpt: "The presenter completes the thought.",
        grokPrompt: "Presenter beat.",
        mediaPlan: "image_with_motion",
        visualOwner: "presenter",
      },
    ] });
    await prisma.storyFilmArtifact.create({
      data: {
        projectId: project.id,
        stage: "keyframes",
        projectRevision: 1,
        generationEpoch: 1,
        kind: "keyframe_image",
        sceneKey: "scene-01",
        storageUrl: "/api/renders/scene-01.png",
        mimeType: "image/png",
        sizeBytes: 1_000,
        width: 270,
        height: 480,
      },
    });
    const job = await prisma.storyFilmGenerationJob.create({
      data: {
        projectId: project.id,
        stage: "final_render",
        projectRevision: 1,
        generationEpoch: 1,
        kind: "final_render",
        providerBackend: "hero_render",
        sceneKey: "master",
        payloadJson: "{}",
        idempotencyKey: "render:fixture:job:001",
      },
    });

    const plan = await renderer.buildStoryFilmRenderPlan(job.id, { workspaceRoot: fixtureRoot });
    ok(
      plan.segments.length === 2
        && plan.segments[0].sourceKind === "image"
        && plan.segments[1].sourceKind === "presenter",
      "the render plan alternates approved B-roll with exact presenter timeline slices",
    );
    const output = await renderer.renderStoryFilmFinal(job.id, { workspaceRoot: fixtureRoot });
    ok(
      output.mimeType === "video/mp4"
        && output.width === 1080
        && output.height === 1920
        && Math.abs(output.durationMs - 3_000) <= 750,
      "Hero render produces one validated 9:16 MP4 on the Narration Master duration",
    );
    ok(
      output.metadata.presenterSegments === 1 && output.metadata.brollSegments === 1,
      "final-render metadata preserves presenter and B-roll coverage for QA",
    );
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => console.log(`\n${passed} Story Film render checks passed`))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(fixtureRoot, { recursive: true, force: true }));
