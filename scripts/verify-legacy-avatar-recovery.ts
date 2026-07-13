import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prisma } from "../src/lib/prisma";
import {
  applyLegacyAvatarRecovery,
  formatLegacyAvatarRecoveryResult,
  inspectLegacyAvatarRecovery,
  type LegacyAvatarRecoveryDeps,
} from "../src/lib/mcp/legacy-avatar-recovery";

const ROOT = mkdtempSync(join(tmpdir(), "legacy-avatar-recovery-"));
const RENDERS = join(ROOT, "public", "renders");
const USER_ID = "legacy-recovery-user";
const OTHER_USER_ID = "legacy-recovery-other";
const SIGNED_URL = "https://files2.heygen.ai/secret-avatar.mp4?X-Amz-Signature=do-not-log";
const SECRET_KEY = "heygen-secret-must-not-log";

mkdirSync(RENDERS, { recursive: true });

function at(day: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 6, day, 8, minute, 0));
}

function writeRender(name: string) {
  writeFileSync(join(RENDERS, name), name);
  return `/api/renders/${name}`;
}

const input = {
  script: "ทดสอบ legacy recovery",
  previewMode: true,
  voiceProvider: "gemini",
  avatarMode: "full",
  avatarId: "avatar-legacy",
  avatarIntroSecs: 5,
  avatarTailSecs: 5,
  avatarScale: 1,
  avatarOffsetX: 0,
  avatarOffsetY: 0,
};

async function createProject(id: string) {
  return prisma.editorProject.create({ data: { id, userId: USER_ID, title: id, status: "draft" } });
}

async function createFailedJob(id: string, projectId: string, day: number, overrides: Record<string, unknown> = {}) {
  return prisma.videoJob.create({
    data: {
      id,
      userId: USER_ID,
      projectId,
      status: "failed",
      currentStep: "avatar",
      progress: 84,
      inputJson: JSON.stringify(input),
      errorMessage: "avatar generation timed out",
      createdAt: at(day),
      startedAt: at(day, 1),
      finishedAt: at(day, 20),
      ...(overrides as never),
    },
  });
}

async function createBaseRender(
  id: string,
  day: number,
  baseUrl: string,
  voiceUrl: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.renderJob.create({
    data: {
      id,
      userId: USER_ID,
      type: "RENDER",
      status: "DONE",
      payload: JSON.stringify({
        resolvedShortConfig: { voiceFile: voiceUrl, durationInFrames: 900, bgVideos: [] },
        captionsData: [{ text: "ทดสอบ", startMs: 0, endMs: 900, tag: "hook" }],
        fps: 30,
      }),
      videoUrl: baseUrl,
      createdAt: at(day, 5),
      startedAt: at(day, 6),
      finishedAt: at(day, 10),
      ...(overrides as never),
    },
  });
}

async function main() {
  await prisma.renderJob.deleteMany({ where: { id: { startsWith: "legacy-render-" } } });
  await prisma.user.deleteMany({ where: { id: { in: [USER_ID, OTHER_USER_ID] } } });
  try {
    await prisma.user.createMany({
      data: [
        { id: USER_ID, name: "Legacy", email: "legacy@example.test", plan: "PRO", heygenKey: SECRET_KEY },
        { id: OTHER_USER_ID, name: "Other", email: "legacy-other@example.test", plan: "PRO" },
      ],
    });

    let providerCalls = 0;
    const deps: LegacyAvatarRecoveryDeps = {
      workspaceRoot: ROOT,
      now: () => at(20),
      pollProvider: async (_userId, providerVideoId) => {
        providerCalls++;
        if (providerVideoId === "hg-not-found") return { status: "failed", videoUrl: null, errorMsg: "not_found" };
        if (providerVideoId === "hg-pending") return { status: "processing", videoUrl: null, errorMsg: null };
        return { status: "completed", videoUrl: SIGNED_URL, errorMsg: null };
      },
    };

    // Superseded detection happens before provider/media work and writes nothing.
    const supersededProject = await createProject("legacy-project-superseded");
    const superseded = await createFailedJob("legacy-job-superseded", supersededProject.id, 1);
    await prisma.videoJob.create({
      data: {
        id: "legacy-job-newer-done",
        userId: USER_ID,
        projectId: supersededProject.id,
        status: "done",
        currentStep: "avatar",
        progress: 100,
        inputJson: JSON.stringify({ avatarId: "avatar-legacy", script: "ทดสอบ legacy recovery", previewMode: true, avatarMode: "full", voiceProvider: "gemini", avatarIntroSecs: 5, avatarTailSecs: 5, avatarScale: 1, avatarOffsetX: 0, avatarOffsetY: 0 }),
        outputJson: JSON.stringify({ videoUrl: "/api/renders/newer.mp4" }),
        createdAt: at(1, 30),
      },
    });
    const supersededResult = await inspectLegacyAvatarRecovery(
      { jobId: superseded.id, heygenVideoId: "hg-superseded" },
      deps,
    );
    assert.equal(supersededResult.status, "superseded");
    assert.equal(providerCalls, 0, "superseded check does not call HeyGen");
    assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: superseded.id } })).status, "failed");

    // A complete, non-superseded fixture is dry-run recoverable with zero writes.
    const recoverProject = await createProject("legacy-project-recover");
    const recoverJob = await createFailedJob("legacy-job-recover", recoverProject.id, 2);
    await createBaseRender("legacy-render-recover", 2, writeRender("legacy-base.mp4"), writeRender("legacy-voice.mp3"));
    const recoverable = await inspectLegacyAvatarRecovery(
      { jobId: recoverJob.id, heygenVideoId: "hg-completed" },
      deps,
    );
    assert.equal(recoverable.status, "recoverable");
    assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: recoverJob.id } })).status, "failed", "dry-run makes zero writes");
    const safeOutput = formatLegacyAvatarRecoveryResult(recoverable);
    assert.ok(!safeOutput.includes(SECRET_KEY));
    assert.ok(!safeOutput.includes("X-Amz-Signature"));
    assert.ok(!safeOutput.includes(SIGNED_URL));
    assert.ok(!JSON.stringify(recoverable).includes("X-Amz-Signature"), "inspection receipt is safe to log accidentally");

    // Apply is guarded and idempotent; project pointers remain untouched.
    const firstApply = await applyLegacyAvatarRecovery(recoverable);
    const secondApply = await applyLegacyAvatarRecovery(recoverable);
    assert.equal(firstApply.applied, true);
    assert.equal(secondApply.applied, false);
    assert.equal(secondApply.idempotent, true);
    const recovered = await prisma.videoJob.findUniqueOrThrow({ where: { id: recoverJob.id } });
    assert.equal(recovered.status, "waiting_provider");
    assert.ok(recovered.providerCheckpointJson);
    assert.ok(recovered.providerNextPollAt);
    assert.equal((await prisma.editorProject.findUniqueOrThrow({ where: { id: recoverProject.id } })).activeJobId, null);

    // Pending provider work may be parked, but never regenerated.
    const pendingProject = await createProject("legacy-project-pending");
    const pendingJob = await createFailedJob("legacy-job-pending", pendingProject.id, 3);
    await createBaseRender("legacy-render-pending", 3, writeRender("pending-base.mp4"), writeRender("pending-voice.mp3"));
    const pending = await inspectLegacyAvatarRecovery({ jobId: pendingJob.id, heygenVideoId: "hg-pending" }, deps);
    assert.equal(pending.status, "pending");

    // A successful retry that lands after inspection but before apply still wins.
    const racedProject = await createProject("legacy-project-raced-supersede");
    const racedJob = await createFailedJob("legacy-job-raced-supersede", racedProject.id, 10);
    await createBaseRender("legacy-render-raced-supersede", 10, writeRender("raced-base.mp4"), writeRender("raced-voice.mp3"));
    const racedInspection = await inspectLegacyAvatarRecovery(
      { jobId: racedJob.id, heygenVideoId: "hg-completed" },
      deps,
    );
    assert.equal(racedInspection.status, "recoverable");
    await prisma.videoJob.create({
      data: {
        id: "legacy-job-raced-newer-done",
        userId: USER_ID,
        projectId: racedProject.id,
        status: "done",
        inputJson: JSON.stringify(input),
        outputJson: JSON.stringify({ videoUrl: "/api/renders/raced-newer.mp4" }),
        createdAt: at(10, 30),
      },
    });
    const racedApply = await applyLegacyAvatarRecovery(racedInspection);
    assert.deepEqual(racedApply, { applied: false, idempotent: false, jobId: racedJob.id });
    const racedRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: racedJob.id } });
    assert.equal(racedRow.status, "failed", "late successful retry blocks recovery apply");
    assert.equal(racedRow.providerCheckpointJson, null, "late successful retry receives zero recovery writes");

    // Wrong status/error/provider ID fail closed.
    const badProject = await createProject("legacy-project-bad");
    const wrongStatus = await createFailedJob("legacy-job-wrong-status", badProject.id, 4, { status: "done" });
    assert.equal((await inspectLegacyAvatarRecovery({ jobId: wrongStatus.id, heygenVideoId: "hg-completed" }, deps)).status, "rejected");
    const wrongError = await createFailedJob("legacy-job-wrong-error", badProject.id, 5, { errorMessage: "different failure" });
    assert.equal((await inspectLegacyAvatarRecovery({ jobId: wrongError.id, heygenVideoId: "hg-completed" }, deps)).status, "rejected");
    const wrongProviderProject = await createProject("legacy-project-provider");
    const wrongProvider = await createFailedJob("legacy-job-provider", wrongProviderProject.id, 6);
    await createBaseRender("legacy-render-provider", 6, writeRender("provider-base.mp4"), writeRender("provider-voice.mp3"));
    assert.equal((await inspectLegacyAvatarRecovery({ jobId: wrongProvider.id, heygenVideoId: "hg-not-found" }, deps)).status, "rejected");

    // Missing media and incomplete render payload are rejected instead of guessed.
    const missingProject = await createProject("legacy-project-missing");
    const missingMedia = await createFailedJob("legacy-job-missing-media", missingProject.id, 7);
    await createBaseRender("legacy-render-missing-media", 7, "/api/renders/does-not-exist.mp4", writeRender("missing-voice.mp3"));
    assert.equal((await inspectLegacyAvatarRecovery({ jobId: missingMedia.id, heygenVideoId: "hg-completed" }, deps)).status, "rejected");

    const payloadProject = await createProject("legacy-project-payload");
    const missingPayload = await createFailedJob("legacy-job-missing-payload", payloadProject.id, 8);
    await createBaseRender("legacy-render-missing-payload", 8, writeRender("payload-base.mp4"), writeRender("payload-voice.mp3"), {
      payload: JSON.stringify({ resolvedShortConfig: { voiceFile: "/api/renders/payload-voice.mp3", durationInFrames: 900 }, captionsData: [] }),
    });
    assert.equal((await inspectLegacyAvatarRecovery({ jobId: missingPayload.id, heygenVideoId: "hg-completed" }, deps)).status, "rejected");

    const ownershipProject = await createProject("legacy-project-ownership");
    const ownershipJob = await createFailedJob("legacy-job-ownership", ownershipProject.id, 9);
    const ownershipBase = writeRender("ownership-base.mp4");
    const ownershipVoice = writeRender("ownership-voice.mp3");
    await prisma.renderJob.create({
      data: {
        id: "legacy-render-wrong-owner",
        userId: OTHER_USER_ID,
        type: "RENDER",
        status: "DONE",
        payload: JSON.stringify({
          resolvedShortConfig: { voiceFile: ownershipVoice, durationInFrames: 900 },
          captionsData: [{ text: "wrong owner", startMs: 0, endMs: 900 }],
          fps: 30,
        }),
        videoUrl: ownershipBase,
        createdAt: at(9, 5),
      },
    });
    assert.equal((await inspectLegacyAvatarRecovery({ jobId: ownershipJob.id, heygenVideoId: "hg-completed" }, deps)).status, "rejected");

    console.log("ALL PASS");
  } finally {
    await prisma.renderJob.deleteMany({ where: { id: { startsWith: "legacy-render-" } } });
    await prisma.user.deleteMany({ where: { id: { in: [USER_ID, OTHER_USER_ID] } } });
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
