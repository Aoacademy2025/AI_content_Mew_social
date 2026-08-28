// Run with: npm run verify:story-film-control
// Exercises the Story Film module through its public interface against a
// throwaway SQLite database. Studio and MCP use this same interface.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "story-film-control-"));
process.env.DATABASE_URL = `file:${join(testDir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
function ok(condition: unknown, message: string) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`ok: ${message}`);
}

function hasCode(code: string) {
  return (error: unknown) => (error as { code?: string })?.code === code;
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const storyFilm = await import("../src/lib/story-film.server");

  try {
    const alice = await prisma.user.create({
      data: {
        id: "alice",
        name: "Alice",
        email: "alice@example.com",
        plan: "BUSINESS",
        elevenlabsKey: "encrypted-test-key",
        elevenlabsVoiceId: "mew-elevenlabs-clone",
      },
    });
    const bob = await prisma.user.create({
      data: { id: "bob", name: "Bob", email: "bob@example.com", plan: "BUSINESS" },
    });
    const presenterAsset = await storyFilm.registerStoryFilmPresenterAsset(alice.id, {
      url: "/api/renders/story-film-presenter-test.mp4",
      originalName: "presenter.mp4",
      mimeType: "video/mp4",
      sizeBytes: 42_000,
      width: 1080,
      height: 1920,
      durationMs: 142_000,
    });
    ok(Boolean(presenterAsset.id), "server-probed presenter metadata becomes an immutable upload handle");

    const input = {
      title: "  หนังสั้นเรื่อง AI Agent  ",
      idempotencyKey: "mewshort:agent-film:001",
      presentationMode: "presenter_led" as const,
      sourcePackage: "content/2026-08-28-ai-agent",
      narrativeSource: "นี่คือเรื่องราวของ AI Agent ที่เริ่มจากงานเล็กและค่อย ๆ เปลี่ยนวิธีทำงานของคนทั้งทีม",
      presenterAssetId: presenterAsset.id,
      aspectRatio: "9:16",
    };
    const started = await storyFilm.startStoryFilm(alice.id, input);
    ok(started.created, "first start creates one project");
    ok(started.project.title === "หนังสั้นเรื่อง AI Agent", "start normalizes the title");
    ok(started.project.stage === "setup" && started.project.revision === 1, "project begins at setup revision 1");
    ok(started.project.awaitingApproval, "setup starts with an explicit review gate");
    ok(started.project.aspectRatio === "9:16" && started.project.durationLimitMs === 180_000, "pilot invariants are public state");
    ok(
      started.project.presenterAssetId === presenterAsset.id
        && started.project.narrationDurationMs === 142_000,
      "project derives its Narration Master from the owner-scoped upload handle",
    );

    const duplicate = await storyFilm.startStoryFilm(alice.id, { ...input, title: "must not replace" });
    ok(!duplicate.created && duplicate.project.id === started.project.id, "start is idempotent per user key");
    ok(duplicate.project.title === started.project.title, "idempotent replay cannot rewrite project input");

    const aliceList = await storyFilm.listStoryFilms(alice.id);
    const bobList = await storyFilm.listStoryFilms(bob.id);
    ok(aliceList.length === 1 && bobList.length === 0, "project lists are owner-scoped");
    const bobRead = await storyFilm.readStoryFilm(bob.id, { projectId: started.project.id });
    ok(bobRead.kind === "not_found", "cross-user reads reveal no project");

    await assert.rejects(
      storyFilm.startStoryFilm(alice.id, { ...input, idempotencyKey: "bad-ratio:001", aspectRatio: "16:9" }),
      hasCode("invalid_input"),
    );
    passed += 1;
    console.log("ok: non-9:16 input fails before persistence");
    await assert.rejects(
      storyFilm.registerStoryFilmPresenterAsset(alice.id, {
        url: "/api/renders/story-film-presenter-too-long.mp4",
        originalName: "too-long.mp4",
        mimeType: "video/mp4",
        sizeBytes: 42_000,
        width: 1080,
        height: 1920,
        durationMs: 180_001,
      }),
      hasCode("invalid_input"),
    );
    passed += 1;
    console.log("ok: server-probed narration over 180 seconds fails before persistence");
    await assert.rejects(
      storyFilm.startStoryFilm(bob.id, { ...input, idempotencyKey: "wrong-owner:001" }),
      hasCode("invalid_input"),
    );
    passed += 1;
    console.log("ok: a presenter upload handle cannot cross account boundaries");

    const faceless = await storyFilm.startStoryFilm(alice.id, {
      title: "Faceless รอเสียงจริง",
      idempotencyKey: "mewshort:faceless-film:001",
      presentationMode: "faceless",
      narrationVoiceId: "voice_01",
      narrationVoiceSpeed: 1,
      sourcePackage: "content/2026-08-28-faceless",
      narrativeSource: "สคริปต์นี้พร้อมแล้วแต่เสียงบรรยายจริงยังไม่ได้ถูกสร้างและตรวจความยาว",
      aspectRatio: "9:16",
    });
    const facelessNarration = await storyFilm.decideStoryFilm(alice.id, {
      projectId: faceless.project.id,
      expectedStage: "setup",
      expectedRevision: 1,
      decision: "approve",
      idempotencyKey: "decision:faceless:setup:001",
    });
    ok(
      facelessNarration.stage === "narration"
        && !facelessNarration.awaitingApproval
        && facelessNarration.status === "waiting_generation",
      "Faceless script waits for a real Narration Master instead of treating text as timed audio",
    );
    const facelessVoiceJob = await prisma.storyFilmGenerationJob.findFirst({
      where: { projectId: faceless.project.id, kind: "narration_voice", providerBackend: "hero_voice" },
    });
    ok(Boolean(facelessVoiceJob), "Faceless setup approval automatically queues durable Hero Voice generation");
    await assert.rejects(
      storyFilm.decideStoryFilm(alice.id, {
        projectId: faceless.project.id,
        expectedStage: "narration",
        expectedRevision: 2,
        decision: "approve",
      }),
      hasCode("gate_not_ready"),
    );
    passed += 1;
    console.log("ok: Faceless Storyboard cannot begin before voice generation commits timing");

    const elevenLabsFaceless = await storyFilm.startStoryFilm(alice.id, {
      title: "Faceless เสียงมิว ElevenLabs v3",
      idempotencyKey: "mewshort:faceless-elevenlabs:001",
      presentationMode: "faceless",
      narrationProvider: "elevenlabs",
      narrationVoiceSpeed: 1,
      sourcePackage: "content/2026-08-28-elevenlabs",
      narrativeSource: "สคริปต์นี้ต้องใช้เสียงโคลนมิวจาก ElevenLabs v3 และรอให้มิวฟังเสียงจริงก่อนสร้างสตอรี่บอร์ด",
      aspectRatio: "9:16",
    });
    ok(
      elevenLabsFaceless.project.narrationProvider === "elevenlabs"
        && elevenLabsFaceless.project.narrationVoiceId === "mew-elevenlabs-clone",
      "ElevenLabs Story Film resolves the account's saved clone without requiring a voice id from chat",
    );
    const elevenLabsNarration = await storyFilm.decideStoryFilm(alice.id, {
      projectId: elevenLabsFaceless.project.id,
      expectedStage: "setup",
      expectedRevision: 1,
      decision: "approve",
      idempotencyKey: "decision:elevenlabs:setup:001",
    });
    const elevenLabsJob = await prisma.storyFilmGenerationJob.findFirst({
      where: { projectId: elevenLabsFaceless.project.id, kind: "narration_voice" },
    });
    const elevenLabsPayload = JSON.parse(elevenLabsJob?.payloadJson ?? "{}") as Record<string, unknown>;
    ok(
      elevenLabsNarration.stage === "narration"
        && !elevenLabsNarration.awaitingApproval
        && elevenLabsJob?.providerBackend === "elevenlabs"
        && elevenLabsPayload.modelId === "eleven_v3",
      "setup approval queues ElevenLabs v3 narration and still stops at the Narration review gate",
    );

    const setupDecision = {
      projectId: started.project.id,
      expectedStage: "setup" as const,
      expectedRevision: 1,
      decision: "approve" as const,
      idempotencyKey: "decision:setup:approve:001",
    };
    const narration = await storyFilm.decideStoryFilm(alice.id, setupDecision);
    ok(narration.stage === "narration" && narration.revision === 2, "setup approval advances exactly one stage");
    ok(narration.awaitingApproval && narration.nextAction === "review_and_decide", "Narrative Source is immediately reviewable");

    const setupReplay = await storyFilm.decideStoryFilm(alice.id, setupDecision);
    ok(setupReplay.stage === "narration" && setupReplay.revision === 2, "decision replay is idempotent before stale validation");
    await assert.rejects(
      storyFilm.decideStoryFilm(alice.id, { ...setupDecision, idempotencyKey: "decision:stale:setup:002" }),
      hasCode("stale_revision"),
    );
    passed += 1;
    console.log("ok: stale approval cannot attach to the next gate");

    const storyboard = await storyFilm.decideStoryFilm(alice.id, {
      projectId: started.project.id,
      expectedStage: "narration",
      expectedRevision: 2,
      decision: "approve",
      idempotencyKey: "decision:narration:approve:001",
    });
    ok(storyboard.stage === "storyboard" && storyboard.revision === 3, "Narration approval advances to Storyboard");
    ok(!storyboard.awaitingApproval && storyboard.status === "waiting_generation", "Storyboard cannot be approved before a draft exists");
    await assert.rejects(
      storyFilm.decideStoryFilm(alice.id, {
        projectId: started.project.id,
        expectedStage: "storyboard",
        expectedRevision: 3,
        decision: "approve",
      }),
      hasCode("gate_not_ready"),
    );
    passed += 1;
    console.log("ok: an empty visual gate cannot be auto-approved");

    await assert.rejects(
      storyFilm.decideStoryFilm(bob.id, {
        projectId: started.project.id,
        expectedStage: "storyboard",
        expectedRevision: 3,
        decision: "pause",
      }),
      hasCode("not_found"),
    );
    passed += 1;
    console.log("ok: cross-user decisions reveal no project");

    const paused = await storyFilm.decideStoryFilm(alice.id, {
      projectId: started.project.id,
      expectedStage: "storyboard",
      expectedRevision: 3,
      decision: "pause",
      idempotencyKey: "decision:pause:storyboard:001",
    });
    ok(paused.status === "paused" && paused.nextAction === "resume", "pause preserves the stage and exposes resume");
    const resumed = await storyFilm.decideStoryFilm(alice.id, {
      projectId: started.project.id,
      expectedStage: "storyboard",
      expectedRevision: 4,
      decision: "resume",
      idempotencyKey: "decision:resume:storyboard:001",
    });
    ok(resumed.status === "waiting_generation" && resumed.revision === 5, "resume restores the pending generation state");

    await prisma.storyFilmProject.update({
      where: { id: started.project.id },
      data: { status: "active", awaitingApproval: true },
    });
    const revisedStoryboard = await storyFilm.decideStoryFilm(alice.id, {
      projectId: started.project.id,
      expectedStage: "storyboard",
      expectedRevision: 5,
      decision: "revise",
      instruction: "ใช้วิดีโอเฉพาะฉากที่ผ่านการตรวจแล้ว",
      target: { videoSceneKeys: ["scene-01", "scene-03"] },
      idempotencyKey: "decision:revise:storyboard:001",
    });
    const revisedStoryboardJob = await prisma.storyFilmGenerationJob.findFirstOrThrow({
      where: { projectId: started.project.id, generationEpoch: revisedStoryboard.generationEpoch },
    });
    const revisedStoryboardPayload = JSON.parse(revisedStoryboardJob.payloadJson) as Record<string, unknown>;
    ok(
      revisedStoryboard.revision === 6
        && JSON.stringify(revisedStoryboardPayload.videoSceneKeys) === JSON.stringify(["scene-01", "scene-03"]),
      "Storyboard revision preserves the reviewed video-scene plan in the durable planner job",
    );

    const attentionProject = await prisma.storyFilmProject.create({
      data: {
        id: "story-film-needs-attention",
        userId: alice.id,
        title: "Final render awaiting an explicit retry",
        idempotencyKey: "story-film:attention:001",
        presentationMode: "faceless",
        narrativeSource: "Retry the same approved final render without regenerating visual assets.",
        stage: "final_render",
        status: "needs_attention",
        revision: 7,
        generationEpoch: 3,
        awaitingApproval: false,
        stageDataJson: JSON.stringify({ gate: "final_render", waitingForGeneration: true }),
      },
    });
    const attentionJob = await prisma.storyFilmGenerationJob.create({
      data: {
        projectId: attentionProject.id,
        stage: "final_render",
        projectRevision: 7,
        generationEpoch: 3,
        kind: "final_render",
        providerBackend: "hero_render",
        sceneKey: "master",
        payloadJson: JSON.stringify({ editorial: { subtitlesEnabled: true } }),
        idempotencyKey: "auto:final-render:epoch:3",
        status: "needs_attention",
        attemptCount: 2,
        technicalFailureCount: 2,
        providerJobId: "hero-render:failed",
        submittedAt: new Date(),
        finishedAt: new Date(),
        errorCode: "final_render_failure",
        errorMessage: "Remotion runtime failed",
      },
    });
    const retriedAttention = await storyFilm.decideStoryFilm(alice.id, {
      projectId: attentionProject.id,
      expectedStage: "final_render",
      expectedRevision: 7,
      decision: "retry",
      instruction: "Retry the same approved Final Preview after the worker runtime fix.",
      idempotencyKey: "decision:retry:final-render:001",
    });
    const [requeuedJob, retryDecision] = await Promise.all([
      prisma.storyFilmGenerationJob.findUniqueOrThrow({ where: { id: attentionJob.id } }),
      prisma.storyFilmDecision.findUniqueOrThrow({
        where: { projectId_revision: { projectId: attentionProject.id, revision: 7 } },
      }),
    ]);
    ok(
      retriedAttention.revision === 8
        && retriedAttention.generationEpoch === 3
        && retriedAttention.status === "waiting_generation"
        && !retriedAttention.awaitingApproval,
      "an explicit retry resumes the same failed generation epoch",
    );
    ok(
      requeuedJob.status === "queued"
        && requeuedJob.attemptCount === 2
        && requeuedJob.technicalFailureCount === 0
        && requeuedJob.providerJobId === null
        && requeuedJob.finishedAt === null
        && requeuedJob.errorCode === null,
      "retry clears only the failed provider attempt while preserving the job audit count",
    );
    ok(
      retryDecision.kind === "retry"
        && retryDecision.revision === 7
        && retryDecision.resultRevision === 8,
      "retry creates one append-only stage-bound decision row",
    );

    const decisions = await prisma.storyFilmDecision.findMany({
      where: { projectId: started.project.id },
      orderBy: { revision: "asc" },
    });
    ok(decisions.length === 5, "every accepted decision has one append-only audit row");
    ok(
      decisions.map((item) => item.revision).join(",") === "1,2,3,4,5",
      "decision audit preserves exact expected revisions",
    );

    await storyFilm.startStoryFilm(alice.id, {
      ...input,
      idempotencyKey: "mewshort:second-film:001",
      title: "โปรเจกต์ที่สอง",
    });
    const latest = await storyFilm.readStoryFilm(alice.id, { latestEligible: true });
    ok(latest.kind === "candidates" && latest.candidates.length === 5, "resume asks Mew when several projects are eligible");
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => {
    console.log(`\n${passed} Story Film control-plane checks passed`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(testDir, { recursive: true, force: true });
  });
