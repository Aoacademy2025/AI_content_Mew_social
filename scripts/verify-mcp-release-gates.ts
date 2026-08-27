import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "mcp-release-gates-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.RENDER_VIA_QUEUE = "1";
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { runOrchestrator } = await import("../src/lib/mcp/orchestrator");
  const { claimNextRunnableJob, parseVideoJobOutput } = await import("../src/lib/mcp/video-job");

  const user = await prisma.user.create({
    data: {
      id: "release-user",
      name: "Release Gate",
      email: "release@example.com",
      plan: "PRO",
      geminiKey: "g",
      pexelsKey: "p",
      minutesUsed: 1,
      minutesLimit: 80,
      usagePeriodStartedAt: new Date(),
    },
  });
  const job = await prisma.videoJob.create({
    data: {
      id: "release-video-job",
      userId: user.id,
      status: "processing",
      inputJson: JSON.stringify({ script: "สร้างเงินเก็บทุกเดือน", voiceProvider: "gemini" }),
    },
  });

  let renderCount = 0;
  let forcedAlignmentCount = 0;
  const caller = {
    post: async (path: string, body?: unknown) => {
      const key = path.split("?")[0];
      if (key === "/api/videos/transcribe") {
        forcedAlignmentCount += 1;
        return {
          captions: [{ text: "สร้างเงินเก็บทุกเดือน", startMs: 120, endMs: 2_800 }],
          words: [{ word: "สร้างเงินเก็บทุกเดือน", startMs: 120, endMs: 2_800 }],
          audioDurationMs: 3_000,
        } as never;
      }
      if (key === "/api/videos/render") {
        renderCount += 1;
        const type = renderCount === 1 ? "RENDER" : "BURN";
        const renderId = `release-${type.toLowerCase()}`;
        await prisma.renderJob.create({
          data: {
            id: renderId,
            userId: user.id,
            parentJobId: job.id,
            type,
            status: "DONE",
            payload: JSON.stringify(body ?? {}),
            videoUrl: `/api/renders/${renderId}.mp4`,
            reservedQuota: type === "RENDER",
            reservedMinutes: type === "RENDER" ? 1 : null,
          },
        });
        return { jobId: renderId } as never;
      }
      const responses: Record<string, unknown> = {
        "/api/videos/tts-gemini": {
          voiceUrl: "/api/renders/release.wav",
          audioDurationMs: 3000,
          timing: {
            provider: "gemini",
            segments: [{ text: "สร้างเงินเก็บทุกเดือน", startMs: 0, durationMs: 3000 }],
            chars: null,
          },
        },
        "/api/videos/extract-keywords": { keywords: ["saving"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [3] },
        "/api/videos/fetch-stock": { results: [{ src: "clip.mp4" }] },
        "/api/videos/generate-config": { config: { durationInFrames: 90, voiceFile: "/api/renders/release.wav", bgVideos: [] } },
        "/api/videos": { id: "release-video" },
      };
      return (responses[key] ?? {}) as never;
    },
    patch: async () => ({} as never),
    get: async (path: string) => {
      const id = new URL(path, "http://local").searchParams.get("jobId");
      return {
        progress: 100,
        stage: "done",
        videoUrl: `/api/renders/${id}.mp4`,
        error: null,
      } as never;
    },
  };

  await runOrchestrator(job.id, user.id, { caller: caller as never, sleep: async () => {} });
  const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
  const output = parseVideoJobOutput(completed.outputJson);
  assert.equal(completed.status, "done");
  assert.equal(output?.subtitleQa?.status, "passed");
  assert.equal(output?.subtitleQa?.timingSource, "forced_alignment");
  assert.equal(forcedAlignmentCount, 1, "Gemini timing is verified from generated audio even when segment timing exists");
  assert.equal(output?.subtitleEvidence?.timingSource, "forced_alignment");
  assert.equal(output?.subtitleEvidence?.fullText, "สร้างเงินเก็บทุกเดือน");
  assert.ok((output?.subtitleEvidence?.words.length ?? 0) > 0, "completed full renders keep replayable word timing evidence");
  assert.deepEqual(output?.billingReceipt, {
    status: "settled",
    funding: "minutes",
    renderMinutes: 1,
    chargedMinutes: 1,
    chargedCredits: 0,
  });
  console.log("✓ successful MCP job exposes passed subtitle QA and one settled charge");

  const avatarJob = await prisma.videoJob.create({
    data: {
      id: "release-avatar-job",
      userId: user.id,
      status: "processing",
      inputJson: JSON.stringify({
        script: "ออมเงินให้เป็นนิสัย",
        voiceProvider: "gemini",
        avatarMode: "full",
        avatarId: "release-avatar",
      }),
    },
  });
  let avatarRenderCount = 0;
  let avatarRefunds = 0;
  const avatarCaller = {
    post: async (path: string, body?: unknown) => {
      const key = path.split("?")[0];
      if (key === "/api/videos/transcribe") {
        return {
          captions: [{ text: "ออมเงินให้เป็นนิสัย", startMs: 100, endMs: 2_800 }],
          words: [{ word: "ออมเงินให้เป็นนิสัย", startMs: 100, endMs: 2_800 }],
          audioDurationMs: 3_000,
        } as never;
      }
      if (key === "/api/videos/render") {
        avatarRenderCount += 1;
        const type = avatarRenderCount === 1 ? "RENDER" : "BURN";
        const renderId = `release-avatar-${type.toLowerCase()}`;
        await prisma.renderJob.create({
          data: {
            id: renderId,
            userId: user.id,
            parentJobId: avatarJob.id,
            type,
            status: "DONE",
            payload: JSON.stringify(body ?? {}),
            videoUrl: `/api/renders/${renderId}.mp4`,
            reservedQuota: type === "RENDER",
            reservedMinutes: type === "RENDER" ? 1 : null,
          },
        });
        return { jobId: renderId } as never;
      }
      const responses: Record<string, unknown> = {
        "/api/videos/tts-gemini": {
          voiceUrl: "/api/renders/release-avatar.wav",
          audioDurationMs: 3000,
          timing: {
            provider: "gemini",
            segments: [{ text: "ออมเงินให้เป็นนิสัย", startMs: 0, durationMs: 3000 }],
            chars: null,
          },
        },
        "/api/videos/extract-keywords": { keywords: ["saving"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [3] },
        "/api/videos/fetch-stock": { results: [{ src: "clip.mp4" }] },
        "/api/videos/generate-config": { config: { durationInFrames: 90, voiceFile: "/api/renders/release-avatar.wav", bgVideos: [] } },
        "/api/videos/trim-audio": { audioUrl: "/api/renders/release-avatar-intro.wav" },
        "/api/heygen/generate-with-bg": { videoId: "release-heygen" },
        "/api/videos/poll-avatar": { status: "completed", videoUrl: "https://avatar.example/video.mp4", thumbnailUrl: null, errorMsg: null },
        "/api/heygen/composite": { videoUrl: "/api/renders/release-avatar-composite.mp4", usedMode: "chromakey" },
        "/api/videos": { id: "release-avatar-video" },
      };
      return (responses[key] ?? {}) as never;
    },
    patch: async () => ({} as never),
    get: async (path: string) => {
      const id = new URL(path, "http://local").searchParams.get("jobId");
      return { progress: 100, stage: "done", videoUrl: `/api/renders/${id}.mp4`, error: null } as never;
    },
  };

  await runOrchestrator(avatarJob.id, user.id, {
    caller: avatarCaller as never,
    sleep: async () => {},
    refundOneClip: async () => { avatarRefunds += 1; },
  });
  const parkedAvatar = await prisma.videoJob.findUniqueOrThrow({ where: { id: avatarJob.id } });
  assert.equal(parkedAvatar.status, "waiting_provider");
  assert.equal((await claimNextRunnableJob(new Date(Date.now() + 3 * 60 * 60_000)))?.id, avatarJob.id);
  await runOrchestrator(avatarJob.id, user.id, {
    caller: avatarCaller as never,
    sleep: async () => {},
    refundOneClip: async () => { avatarRefunds += 1; },
  });
  const completedAvatar = await prisma.videoJob.findUniqueOrThrow({ where: { id: avatarJob.id } });
  const avatarOutput = parseVideoJobOutput(completedAvatar.outputJson);
  assert.equal(completedAvatar.status, "done");
  assert.equal(avatarOutput?.subtitleQa?.status, "passed");
  assert.deepEqual(avatarOutput?.billingReceipt, {
    status: "settled",
    funding: "minutes",
    renderMinutes: 1,
    chargedMinutes: 1,
    chargedCredits: 0,
  });
  assert.equal(await prisma.renderJob.count({ where: { parentJobId: avatarJob.id, reservedQuota: true } }), 1);
  assert.equal(avatarRefunds, 0);
  console.log("✓ resumed avatar job retains exactly one charge and exposes both release receipts");

  await prisma.$disconnect();
  console.log("\n✅ MCP RELEASE GATE CHECK PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
