// Run with: npm run verify:story-film-character-pipeline
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "story-film-character-"));
process.env.DATABASE_URL = `file:${join(testDir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
function ok(condition: unknown, message: string) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`ok: ${message}`);
}

async function completeImage(
  queue: typeof import("../src/lib/story-film-generation-queue.server"),
  job: import("../src/lib/story-film-generation-queue.server").LeasedStoryFilmJob,
  workerId: string,
  storageUrl: string,
) {
  await queue.markStoryFilmGenerationSubmitted({
    jobId: job.id, workerId, leaseToken: job.leaseToken, providerJobId: `provider:${job.id}`,
  });
  return queue.completeStoryFilmGenerationJob({
    jobId: job.id,
    workerId,
    leaseToken: job.leaseToken,
    artifact: { storageUrl, mimeType: "image/png", sizeBytes: 5_000, width: 1080, height: 1920 },
  });
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const story = await import("../src/lib/story-film.server");
  const characters = await import("../src/lib/story-film-character.server");
  const placement = await import("../src/lib/story-film-character-placement");
  const queue = await import("../src/lib/story-film-generation-queue.server");
  try {
    const mew = await prisma.user.create({
      data: { id: "character-mew", name: "Mew", email: "duckyhero@gmail.com", plan: "BUSINESS" },
    });
    const outsider = await prisma.user.create({
      data: { id: "character-outsider", name: "Other", email: "other@example.com", plan: "BUSINESS" },
    });
    const reusableMusic = await prisma.userMusic.create({
      data: {
        userId: mew.id,
        title: "Mew Story Pulse",
        filename: "mew-story-pulse.mp3",
        sizeBytes: 2_000_000,
        mimeType: "audio/mpeg",
        duration: 120,
      },
    });
    const profile = await characters.createStoryFilmCharacterProfile(mew.id, {
      name: "Mew",
      identityNotes: "Keep face shape, eyes and hairstyle stable.",
    });
    const reference = await characters.registerStoryFilmCharacterReference(mew.id, profile.id, {
      url: "/api/renders/mew-identity-front.png",
      originalName: "mew-front.png",
      mimeType: "image/png",
      sizeBytes: 10_000,
      width: 1200,
      height: 1600,
      viewLabel: "front portrait",
    });
    ok(reference.setVersion === 1, "the reusable identity reference is stored in immutable set v1");
    await assert.rejects(
      characters.resolveStoryFilmCharacterPin(outsider.id, profile.id),
      (error: unknown) => (error as { code?: string }).code === "invalid_input",
    );
    passed += 1;
    console.log("ok: another account cannot resolve Mew's private identity set");

    const presenter = await story.registerStoryFilmPresenterAsset(mew.id, {
      url: "/api/renders/character-pipeline-presenter.mp4",
      originalName: "presenter.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100_000,
      width: 1080,
      height: 1920,
      durationMs: 20_000,
    });
    const started = await story.startStoryFilm(mew.id, {
      title: "Character pipeline",
      idempotencyKey: "character:pipeline:001",
      presentationMode: "presenter_led",
      presenterAssetId: presenter.id,
      characterProfileId: profile.id,
      characterLookBrief: "Black field jacket over a white shirt, practical documentary styling.",
      narrativeSource: "Mew enters a workshop and turns on a machine. The final shot holds on the finished object.",
      aspectRatio: "9:16",
    });
    ok(
      started.project.characterProfileId === profile.id
        && started.project.characterReferenceSetVersion === 1,
      "a project pins the exact identity reference-set version",
    );
    const storedLook = await prisma.storyFilmCharacterLook.findUniqueOrThrow({
      where: { projectId_version: { projectId: started.project.id, version: 1 } },
    });
    ok(storedLook.brief.includes("Black field jacket"), "wardrobe is versioned per project instead of mutating identity");

    const narration = await story.decideStoryFilm(mew.id, {
      projectId: started.project.id,
      expectedStage: "setup",
      expectedRevision: 1,
      decision: "approve",
      idempotencyKey: "character:setup:001",
    });
    const storyboardReviewPending = await story.decideStoryFilm(mew.id, {
      projectId: started.project.id,
      expectedStage: "narration",
      expectedRevision: narration.revision,
      decision: "approve",
      idempotencyKey: "character:narration:001",
    });
    await prisma.storyFilmScene.createMany({ data: [
      {
        projectId: started.project.id,
        generationEpoch: storyboardReviewPending.generationEpoch,
        sceneKey: "scene-01",
        sequence: 0,
        startMs: 0,
        endMs: 10_000,
        sourceExcerpt: "Mew enters a workshop and turns on a machine.",
        grokPrompt: "Vertical 9:16 cinematic frame. An adult Thai creator turns on workshop machinery.",
        mediaPlan: "video",
        characterDirectivesJson: JSON.stringify([{
          entityId: placement.STORY_FILM_PROJECT_CHARACTER_ENTITY_ID,
          isRealPerson: true,
          isProjectCharacter: true,
        }]),
      },
      {
        projectId: started.project.id,
        generationEpoch: storyboardReviewPending.generationEpoch,
        sceneKey: "scene-02",
        sequence: 1,
        startMs: 10_000,
        endMs: 20_000,
        sourceExcerpt: "The final shot holds on the finished object.",
        grokPrompt: "Vertical 9:16 cinematic product frame. A finished object rests on a workshop table.",
        mediaPlan: "image_with_motion",
        characterDirectivesJson: JSON.stringify([{ entityId: "tiangong-ultra", isRealPerson: false }]),
      },
    ] });
    const textLease = await queue.leaseStoryFilmGenerationJobs({
      workerId: "hero-storyboard-test",
      providerBackends: ["hero_text"],
      maxJobs: 1,
    });
    await queue.markStoryFilmGenerationSubmitted({
      jobId: textLease[0].id,
      workerId: "hero-storyboard-test",
      leaseToken: textLease[0].leaseToken,
      providerJobId: "hero-text:test-storyboard",
    });
    await queue.completeStoryFilmGenerationJob({
      jobId: textLease[0].id,
      workerId: "hero-storyboard-test",
      leaseToken: textLease[0].leaseToken,
      artifact: { storageUrl: "/api/renders/storyboard-character.json", mimeType: "application/json", sizeBytes: 4_000 },
    });
    const storyboardReview = await story.readStoryFilm(mew.id, { projectId: started.project.id });
    assert.equal(storyboardReview.kind, "project");

    const characterStage = await story.decideStoryFilm(mew.id, {
      projectId: started.project.id,
      expectedStage: "storyboard",
      expectedRevision: storyboardReview.project.revision,
      decision: "approve",
      idempotencyKey: "character:storyboard:001",
    });
    const lookJob = await prisma.storyFilmGenerationJob.findFirstOrThrow({
      where: { projectId: started.project.id, stage: "character_look" },
    });
    const lookPayload = JSON.parse(lookJob.payloadJson) as { prompt: string; referenceUrls: string[] };
    ok(
      characterStage.stage === "character_look"
        && lookPayload.referenceUrls[0] === reference.url
        && lookPayload.prompt.includes("Black field jacket"),
      "storyboard approval queues one Grok look using the pinned identity and this project's wardrobe",
    );
    const lookLease = await queue.leaseStoryFilmGenerationJobs({
      workerId: "mew-grok-character",
      providerBackends: ["grok_subscription"],
      maxJobs: 1,
    });
    await completeImage(queue, lookLease[0], "mew-grok-character", "/api/renders/approved-character-look.png");
    const lookReview = await story.readStoryFilm(mew.id, { projectId: started.project.id });
    assert.equal(lookReview.kind, "project");

    const keyframeStage = await story.decideStoryFilm(mew.id, {
      projectId: started.project.id,
      expectedStage: "character_look",
      expectedRevision: lookReview.project.revision,
      decision: "approve",
      idempotencyKey: "character:look:approve:001",
    });
    const keyframeJobs = await prisma.storyFilmGenerationJob.findMany({
      where: { projectId: started.project.id, stage: "keyframes" },
      orderBy: { sceneKey: "asc" },
    });
    const firstPayload = JSON.parse(keyframeJobs[0].payloadJson) as { referenceUrls: string[] };
    const secondPayload = JSON.parse(keyframeJobs[1].payloadJson) as { referenceUrls: string[] };
    ok(
      keyframeStage.stage === "keyframes"
        && keyframeJobs.length === 2
        && firstPayload.referenceUrls[0] === reference.url
        && firstPayload.referenceUrls[1] === "/api/renders/approved-character-look.png",
      "character scenes put the immutable identity anchor before the approved wardrobe look",
    );
    ok(
      secondPayload.referenceUrls.length === 0,
      "a scene assigned to another story entity does not accidentally inject Mew from a reference image",
    );

    const keyframeLease = await queue.leaseStoryFilmGenerationJobs({
      workerId: "mew-grok-keyframes",
      providerBackends: ["grok_subscription"],
      maxJobs: 2,
    });
    for (const leased of keyframeLease) {
      await completeImage(queue, leased, "mew-grok-keyframes", `/api/renders/${leased.sceneKey}.png`);
    }
    const keyframeReview = await story.readStoryFilm(mew.id, { projectId: started.project.id });
    assert.equal(keyframeReview.kind, "project");
    const selectiveKeyframeRevision = await story.decideStoryFilm(mew.id, {
      projectId: started.project.id,
      expectedStage: "keyframes",
      expectedRevision: keyframeReview.project.revision,
      decision: "revise",
      instruction: "Make the finished object warmer and more tactile without adding a person.",
      target: { sceneKey: "scene-02" },
      idempotencyKey: "character:keyframe:revise:001",
    });
    const replacementKeyframeJob = await prisma.storyFilmGenerationJob.findFirstOrThrow({
      where: {
        projectId: started.project.id,
        stage: "keyframes",
        generationEpoch: selectiveKeyframeRevision.generationEpoch,
      },
    });
    const replacementKeyframePayload = JSON.parse(replacementKeyframeJob.payloadJson) as { prompt: string; referenceUrls: string[] };
    ok(
      replacementKeyframeJob.sceneKey === "scene-02"
        && replacementKeyframePayload.prompt.includes("warmer and more tactile")
        && replacementKeyframePayload.referenceUrls.length === 0,
      "a keyframe revision queues only the selected scene and preserves its no-person reference boundary",
    );
    const replacementKeyframeLease = await queue.leaseStoryFilmGenerationJobs({
      workerId: "mew-grok-keyframe-revision",
      providerBackends: ["grok_subscription"],
      maxJobs: 1,
    });
    await completeImage(
      queue,
      replacementKeyframeLease[0],
      "mew-grok-keyframe-revision",
      "/api/renders/scene-02-revised.png",
    );
    const revisedKeyframeReview = await story.readStoryFilm(mew.id, { projectId: started.project.id });
    assert.equal(revisedKeyframeReview.kind, "project");
    const videoStage = await story.decideStoryFilm(mew.id, {
      projectId: started.project.id,
      expectedStage: "keyframes",
      expectedRevision: revisedKeyframeReview.project.revision,
      decision: "approve",
      idempotencyKey: "character:keyframes:approve:001",
    });
    const videoJobs = await prisma.storyFilmGenerationJob.findMany({
      where: { projectId: started.project.id, stage: "videos" },
    });
    const videoPayload = JSON.parse(videoJobs[0].payloadJson) as { sourceImageUrl: string };
    ok(
      videoStage.stage === "videos"
        && videoJobs.length === 1
        && videoJobs[0].sceneKey === "scene-01"
        && videoPayload.sourceImageUrl === "/api/renders/scene-01.png",
      "only motion-worthy scenes become Grok videos and each starts from its approved keyframe",
    );
    const videoLease = await queue.leaseStoryFilmGenerationJobs({
      workerId: "mew-grok-videos",
      providerBackends: ["grok_subscription"],
      maxJobs: 1,
    });
    await queue.markStoryFilmGenerationSubmitted({
      jobId: videoLease[0].id,
      workerId: "mew-grok-videos",
      leaseToken: videoLease[0].leaseToken,
      providerJobId: "grok:scene-01:video",
    });
    await queue.completeStoryFilmGenerationJob({
      jobId: videoLease[0].id,
      workerId: "mew-grok-videos",
      leaseToken: videoLease[0].leaseToken,
      artifact: {
        storageUrl: "/api/renders/scene-01.mp4",
        mimeType: "video/mp4",
        sizeBytes: 20_000,
        width: 720,
        height: 1280,
        durationMs: 10_000,
      },
    });
    const videoReview = await story.readStoryFilm(mew.id, { projectId: started.project.id });
    assert.equal(videoReview.kind, "project");
    const selectiveVideoRevision = await story.decideStoryFilm(mew.id, {
      projectId: started.project.id,
      expectedStage: "videos",
      expectedRevision: videoReview.project.revision,
      decision: "reroll",
      instruction: "Use slower machine movement and a calmer camera push.",
      target: { sceneKey: "scene-01" },
      idempotencyKey: "character:video:reroll:001",
    });
    const replacementVideoJob = await prisma.storyFilmGenerationJob.findFirstOrThrow({
      where: {
        projectId: started.project.id,
        stage: "videos",
        generationEpoch: selectiveVideoRevision.generationEpoch,
      },
    });
    const replacementVideoPayload = JSON.parse(replacementVideoJob.payloadJson) as { prompt: string; sourceImageUrl: string };
    ok(
      replacementVideoJob.sceneKey === "scene-01"
        && replacementVideoPayload.prompt.includes("slower machine movement")
        && replacementVideoPayload.sourceImageUrl === "/api/renders/scene-01.png",
      "a video reroll queues only the selected motion scene from its latest approved keyframe",
    );
    const replacementVideoLease = await queue.leaseStoryFilmGenerationJobs({
      workerId: "mew-grok-video-revision",
      providerBackends: ["grok_subscription"],
      maxJobs: 1,
    });
    await queue.markStoryFilmGenerationSubmitted({
      jobId: replacementVideoLease[0].id,
      workerId: "mew-grok-video-revision",
      leaseToken: replacementVideoLease[0].leaseToken,
      providerJobId: "grok:scene-01:video-revised",
    });
    await queue.completeStoryFilmGenerationJob({
      jobId: replacementVideoLease[0].id,
      workerId: "mew-grok-video-revision",
      leaseToken: replacementVideoLease[0].leaseToken,
      artifact: {
        storageUrl: "/api/renders/scene-01-revised.mp4",
        mimeType: "video/mp4",
        sizeBytes: 20_000,
        width: 720,
        height: 1280,
        durationMs: 10_000,
      },
    });
    const revisedVideoReview = await story.readStoryFilm(mew.id, { projectId: started.project.id });
    assert.equal(revisedVideoReview.kind, "project");
    const musicStage = await story.decideStoryFilm(mew.id, {
      projectId: started.project.id,
      expectedStage: "videos",
      expectedRevision: revisedVideoReview.project.revision,
      decision: "approve",
      idempotencyKey: "character:videos:approve:001",
    });
    const candidates = musicStage.stageData.candidates as Array<{ source: string; trackId: string }>;
    ok(
      musicStage.stage === "music"
        && musicStage.awaitingApproval
        && candidates.some((candidate) => candidate.source === "user" && candidate.trackId === reusableMusic.id),
      "Music stage offers reusable library tracks before requesting a new vidIQ generation",
    );
    const finalRender = await story.decideStoryFilm(mew.id, {
      projectId: started.project.id,
      expectedStage: "music",
      expectedRevision: musicStage.revision,
      decision: "approve",
      target: { musicSource: "user", musicTrackId: reusableMusic.id },
      idempotencyKey: "character:music:approve:001",
    });
    ok(
      finalRender.stage === "final_render"
        && finalRender.musicTrackId === reusableMusic.id
        && finalRender.musicUrl === "/api/music/mew-story-pulse.mp3"
        && finalRender.stageData.renderSetup === true,
      "the selected reusable soundtrack is pinned into the editable Final Cut setup",
    );
    ok(
      await prisma.storyFilmGenerationJob.count({ where: { projectId: started.project.id, kind: "final_render" } }) === 0,
      "music approval does not waste a render before editorial setup is approved",
    );
    const finalPreviewPending = await story.decideStoryFilm(mew.id, {
      projectId: started.project.id,
      expectedStage: "final_render",
      expectedRevision: finalRender.revision,
      decision: "approve",
      target: {
        musicSource: "user",
        musicTrackId: reusableMusic.id,
        editorial: {
          subtitlesEnabled: true,
          subtitleMode: "sentence",
          subtitleStylePreset: "box-rounded",
          subtitleTextEffect: "fade",
          subtitlePosition: "bottom",
          subtitleFontFamily: "Kanit",
          headlineHook: {
            enabled: true,
            headline: "ของจริงต้องมีร่องรอย",
            durationMs: 5_000,
            preset: "viral",
            topPercent: 20,
            fontFamily: "Kanit",
          },
          textOverlays: [{ sceneKey: "scene-02", text: "ของจริงต้องมีร่องรอย" }],
        },
      },
      idempotencyKey: "character:final:setup:001",
    });
    const renderJob = await prisma.storyFilmGenerationJob.findFirstOrThrow({
      where: { projectId: started.project.id, kind: "final_render" },
    });
    const renderPayload = JSON.parse(renderJob.payloadJson) as { editorial?: { subtitleStylePreset?: string; headlineHook?: { enabled?: boolean }; textOverlays?: unknown[] } };
    ok(
      renderJob.providerBackend === "hero_render"
        && renderJob.generationEpoch === finalPreviewPending.generationEpoch
        && renderPayload.editorial?.subtitleStylePreset === "box-rounded"
        && renderPayload.editorial.headlineHook?.enabled === true
        && renderPayload.editorial.textOverlays?.length === 1,
      "Final Cut approval queues one Hero render with shared subtitle, Headline, and text inputs",
    );
    const renderLease = await queue.leaseStoryFilmGenerationJobs({
      workerId: "hero-final-render-test",
      providerBackends: ["hero_render"],
      maxJobs: 1,
    });
    await queue.markStoryFilmGenerationSubmitted({
      jobId: renderLease[0].id,
      workerId: "hero-final-render-test",
      leaseToken: renderLease[0].leaseToken,
      providerJobId: `hero-render:${renderLease[0].id}`,
    });
    await queue.completeStoryFilmGenerationJob({
      jobId: renderLease[0].id,
      workerId: "hero-final-render-test",
      leaseToken: renderLease[0].leaseToken,
      artifact: {
        storageUrl: "/api/renders/story-film-final-test.mp4",
        mimeType: "video/mp4",
        sizeBytes: 50_000,
        width: 1080,
        height: 1920,
        durationMs: 20_000,
      },
    });
    const finalReview = await story.readStoryFilm(mew.id, { projectId: started.project.id });
    assert.equal(finalReview.kind, "project");
    ok(
      finalReview.project.awaitingApproval
        && finalReview.project.finalRenderUrl === "/api/renders/story-film-final-test.mp4"
        && Array.isArray(finalReview.project.stageData.scenes)
        && (finalReview.project.stageData.editorial as { subtitleStylePreset?: string }).subtitleStylePreset === "box-rounded",
      "a validated 9:16 preview opens Final Review without losing its editable context",
    );
    const repairPending = await story.decideStoryFilm(mew.id, {
      projectId: started.project.id,
      expectedStage: "final_render",
      expectedRevision: finalReview.project.revision,
      decision: "revise",
      instruction: "Remove the extra hand and preserve the object composition.",
      target: {
        sceneKeys: ["scene-02"],
        repairLayer: "keyframe",
        musicSource: "user",
        musicTrackId: reusableMusic.id,
        editorial: renderPayload.editorial,
      },
      idempotencyKey: "character:final:repair:001",
    });
    const repairJobs = await prisma.storyFilmGenerationJob.findMany({
      where: { projectId: started.project.id, generationEpoch: repairPending.generationEpoch },
    });
    const repairPayload = JSON.parse(repairJobs[0].payloadJson) as {
      sourceImageUrl?: string;
      referenceMode?: string;
      referenceUrls?: string[];
      prompt?: string;
    };
    ok(
      repairPending.stage === "keyframes"
        && repairJobs.length === 1
        && repairJobs[0].sceneKey === "scene-02"
        && repairPayload.sourceImageUrl === "/api/renders/scene-02-revised.png"
        && repairPayload.referenceMode === "image_edit",
      "Final Review repairs only the selected keyframe and anchors it to the current approved image",
    );
    ok(
      repairPayload.referenceUrls?.length === 1
        && !repairPayload.referenceUrls.includes(reference.url)
        && !repairPayload.referenceUrls.includes("/api/renders/approved-character-look.png"),
      "Final Review repair keeps Mew identity references out of another entity's scene",
    );
    const repairLease = await queue.leaseStoryFilmGenerationJobs({
      workerId: "mew-grok-final-repair",
      providerBackends: ["grok_subscription"],
      maxJobs: 1,
    });
    await completeImage(queue, repairLease[0], "mew-grok-final-repair", "/api/renders/scene-02-final-repair.png");
    const repairedFrameReview = await story.readStoryFilm(mew.id, { projectId: started.project.id });
    assert.equal(repairedFrameReview.kind, "project");
    const revisedRenderPending = await story.decideStoryFilm(mew.id, {
      projectId: started.project.id,
      expectedStage: "keyframes",
      expectedRevision: repairedFrameReview.project.revision,
      decision: "approve",
      target: { visualQa: { anatomy: true, spatialDirection: true, continuity: true, generatedText: true } },
      idempotencyKey: "character:final:repair-frame:approve:001",
    });
    ok(
      revisedRenderPending.stage === "final_render" && !revisedRenderPending.awaitingApproval,
      "an image-only repair bypasses videos and music and queues a new Final Preview",
    );
    const revisedRenderLease = await queue.leaseStoryFilmGenerationJobs({
      workerId: "hero-final-render-revision",
      providerBackends: ["hero_render"],
      maxJobs: 1,
    });
    await queue.markStoryFilmGenerationSubmitted({
      jobId: revisedRenderLease[0].id,
      workerId: "hero-final-render-revision",
      leaseToken: revisedRenderLease[0].leaseToken,
      providerJobId: `hero-render:${revisedRenderLease[0].id}`,
    });
    await queue.completeStoryFilmGenerationJob({
      jobId: revisedRenderLease[0].id,
      workerId: "hero-final-render-revision",
      leaseToken: revisedRenderLease[0].leaseToken,
      artifact: {
        storageUrl: "/api/renders/story-film-final-revised.mp4",
        mimeType: "video/mp4",
        sizeBytes: 55_000,
        width: 1080,
        height: 1920,
        durationMs: 20_000,
      },
    });
    const revisedFinalReview = await story.readStoryFilm(mew.id, { projectId: started.project.id });
    assert.equal(revisedFinalReview.kind, "project");
    await assert.rejects(
      story.decideStoryFilm(mew.id, {
        projectId: started.project.id,
        expectedStage: "final_render",
        expectedRevision: revisedFinalReview.project.revision,
        decision: "render",
        idempotencyKey: "character:final:qa-missing:001",
      }),
      (error: unknown) => (error as { code?: string }).code === "gate_not_ready",
    );
    passed += 1;
    console.log("ok: Final Render cannot be approved until every Visual QA check is explicit");
    const completed = await story.decideStoryFilm(mew.id, {
      projectId: started.project.id,
      expectedStage: "final_render",
      expectedRevision: revisedFinalReview.project.revision,
      decision: "render",
      target: { visualQa: { anatomy: true, spatialDirection: true, continuity: true, generatedText: true } },
      idempotencyKey: "character:final:approve:001",
    });
    ok(
      completed.stage === "completed"
        && completed.status === "completed"
        && completed.finalRenderUrl === "/api/renders/story-film-final-revised.mp4",
      "approving the repaired Final Preview completes the one-project workflow",
    );
    const completedRepair = await story.decideStoryFilm(mew.id, {
      projectId: started.project.id,
      expectedStage: "completed",
      expectedRevision: completed.revision,
      decision: "revise",
      instruction: "Restore Mew's exact face from the Character Profile and realign subtitles to the spoken audio.",
      target: {
        sceneKeys: ["scene-01"],
        repairLayer: "keyframe",
        realignCaptions: true,
      },
      idempotencyKey: "character:completed:identity-caption-repair:001",
    });
    const completedRepairJobs = await prisma.storyFilmGenerationJob.findMany({
      where: { projectId: started.project.id, generationEpoch: completedRepair.generationEpoch },
      orderBy: { kind: "asc" },
    });
    const completedKeyframeJob = completedRepairJobs.find((job) => job.kind === "keyframe_image");
    const completedCaptionJob = completedRepairJobs.find((job) => job.kind === "caption_alignment");
    assert.ok(completedKeyframeJob);
    const completedKeyframePayload = JSON.parse(completedKeyframeJob.payloadJson) as {
      prompt: string;
      referenceUrls: string[];
    };
    ok(
      completedRepair.stage === "keyframes"
        && completedRepair.status === "waiting_generation"
        && Boolean(completedCaptionJob)
        && completedKeyframePayload.referenceUrls[0] === reference.url
        && completedKeyframePayload.referenceUrls[1] === "/api/renders/approved-character-look.png"
        && completedKeyframePayload.referenceUrls[2] === "/api/renders/scene-01.png"
        && completedKeyframePayload.prompt.includes("identity authority"),
      "a completed film can selectively repair identity and captions with raw identity first",
    );
    const completedRepairLease = await queue.leaseStoryFilmGenerationJobs({
      workerId: "mew-grok-completed-repair",
      providerBackends: ["grok_subscription"],
      maxJobs: 1,
    });
    await completeImage(
      queue,
      completedRepairLease[0],
      "mew-grok-completed-repair",
      "/api/renders/scene-01-completed-repair.png",
    );
    const completedRepairReview = await story.readStoryFilm(mew.id, { projectId: started.project.id });
    assert.equal(completedRepairReview.kind, "project");
    const identityOnlyRepair = await story.decideStoryFilm(mew.id, {
      projectId: started.project.id,
      expectedStage: "keyframes",
      expectedRevision: completedRepairReview.project.revision,
      decision: "revise",
      instruction: "The face still failed identity QA. Generate a fresh frame with exactly one Mew and use only the Character Profile for his face.",
      target: { sceneKey: "scene-01", identityReferenceOnly: true },
      idempotencyKey: "character:keyframe:identity-only:001",
    });
    const identityOnlyJob = await prisma.storyFilmGenerationJob.findFirstOrThrow({
      where: {
        projectId: started.project.id,
        generationEpoch: identityOnlyRepair.generationEpoch,
        kind: "keyframe_image",
      },
    });
    const identityOnlyPayload = JSON.parse(identityOnlyJob.payloadJson) as {
      prompt: string;
      referenceUrls: string[];
    };
    ok(
      (identityOnlyRepair.stageData.repair as { origin?: string } | undefined)?.origin === "final_render"
        && identityOnlyPayload.referenceUrls.length === 1
        && identityOnlyPayload.referenceUrls[0] === reference.url
        && identityOnlyPayload.prompt.includes("only facial identity source"),
      "identity-only reroll preserves Final Review context and excludes conflicting generated looks",
    );
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => console.log(`\n${passed} Story Film character-pipeline checks passed`))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(testDir, { recursive: true, force: true }));
