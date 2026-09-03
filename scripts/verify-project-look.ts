import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "project-look-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const {
    applyProjectLook,
    clearProjectLook,
    pinProjectVisualContextToVideoJob,
    prepareProjectVisualPin,
    prepareUploadProjectVisualSnapshot,
    resolveProjectVisualContext,
    resolveProjectVisualPromptForVideoScene,
    reusableProjectVisualBeatSceneIndices,
    saveProjectLook,
  } = await import(
    "../src/lib/project-look.server"
  );
  const { recordVisualBeatAsset, reusableVisualBeatAssetsForVideoJob } = await import(
    "../src/lib/content-preflight.server"
  );
  const { CONTENT_PREFLIGHT_ANALYZER_VERSION } = await import("../src/lib/content-preflight.server");
  const treatmentPlanFields = {
    analyzerVersion: CONTENT_PREFLIGHT_ANALYZER_VERSION,
    dominantNarrativeMode: "continuous practical explanation",
    suggestedTreatmentPresetId: "expert-clarity",
    suggestedTreatmentPresetVersion: "v1.0.0",
    rankedTreatmentPresetIdsJson: JSON.stringify([
      "expert-clarity", "practical-documentary", "modern-business-technology",
    ]),
    treatmentRecommendationRationale: "The whole source is a practical explanation.",
    storyEntitiesJson: "[]",
  } as const;
  const { brandVisualIdentityKey } = await import("../src/lib/brand-visual-system");
  const { shouldLoadBrandVisualContext } = await import("../src/lib/automix-plan");
  assert.equal(shouldLoadBrandVisualContext({
    brollSource: "stock",
    mixPreset: "free",
    hasPersistedVisualPin: false,
    settingsOpen: false,
    libraryPickerVisible: false,
  }), false, "Stock + closed settings must not trigger Content Preflight");
  assert.equal(shouldLoadBrandVisualContext({
    brollSource: "automix",
    mixPreset: "free",
    hasPersistedVisualPin: false,
    settingsOpen: false,
    libraryPickerVisible: false,
  }), false, "Stock-only AutoMix must remain lazy");
  for (const trigger of [
    { brollSource: "automix", mixPreset: "recommended", hasPersistedVisualPin: false, settingsOpen: false, libraryPickerVisible: false },
    { brollSource: "kie-image", mixPreset: "free", hasPersistedVisualPin: false, settingsOpen: false, libraryPickerVisible: false },
    { brollSource: "stock", mixPreset: "free", hasPersistedVisualPin: false, settingsOpen: true, libraryPickerVisible: false },
    { brollSource: "stock", mixPreset: "free", hasPersistedVisualPin: true, settingsOpen: false, libraryPickerVisible: false },
    // Wave 1b C1 (#430): a library user is already being offered a brand
    // picker that stays disabled until the analysis resolves. Without this
    // trigger a FREE account with a Brand Profile sees a permanently disabled
    // dropdown under "กำลังวิเคราะห์เนื้อหาปัจจุบันก่อนเปิดให้เลือกแบรนด์" that never resolves.
    { brollSource: "stock", mixPreset: "free", hasPersistedVisualPin: false, settingsOpen: false, libraryPickerVisible: true },
  ]) {
    assert.equal(shouldLoadBrandVisualContext(trigger), true,
      "AI selection, explicit settings, an established pin or a library user's visible picker triggers lazy analysis");
  }
  const user = await prisma.user.create({ data: { name: "Look owner", email: "look@example.test" } });
  const profile = await prisma.brandProfile.create({
    data: { userId: user.id, name: "Blue brand", niche: "education", audience: "creators", tone: "bold" },
  });
  const revision = await prisma.brandProfileRevision.create({
    data: {
      brandProfileId: profile.id,
      version: 1,
      payloadJson: "{}",
      visualRecipeJson: JSON.stringify({
        schemaVersion: 1,
        visualFormatId: "stick-figure-story",
        recipeVersion: "stick-figure-story-v2",
        brandVisualLanguage: {
          palette: ["#111111", "#38BDF8"],
          personality: "bold handmade",
          peopleAndSetting: "Thai creator contexts",
          memorableCues: ["blue marker arrow"],
          visualNotes: "rough lines",
        },
        defaultTreatment: "energetic",
      }),
    },
  });
  const project = await prisma.editorProject.create({
    data: { userId: user.id, title: "Override test", brandProfileRevisionId: revision.id },
  });

  const branded = await resolveProjectVisualContext({
    userId: user.id,
    projectId: project.id,
    suggested: { visualFormatId: "clear-infographic", treatment: "calm" },
  });
  assert.equal(branded.source, "brand-revision");
  assert.equal(branded.visualFormatId, "stick-figure-story");
  assert.equal(
    branded.treatment,
    "calm",
    "a Brand Revision keeps its format/language while the current clip supplies the Suggested Treatment",
  );

  const suggestedIdentityProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Suggested treatment identity transition" },
  });
  const oldSuggestedIdentity = brandVisualIdentityKey({
    visualFormatId: "clear-infographic",
    recipeVersion: "clear-infographic-v3",
    treatment: "calm",
    brandVisualLanguage: null,
  });
  const shiftedAssetJob = await prisma.aiGenerationJob.create({
    data: {
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image",
      status: "completed",
      outputUrl: "https://cdn.example/suggested-old.png",
      fundingSource: "credits",
      chargeState: "settled",
      creditCost: 2,
    },
  });
  const shiftedPreflight = await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: suggestedIdentityProject.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "suggested-treatment-shift-v2",
      ...treatmentPlanFields,
      contentDomain: "creator education",
      suggestedVisualFormatId: "retro-story",
      suggestedTreatmentJson: JSON.stringify({ label: "nostalgic", mood: "warm" }),
      visualBeats: {
        create: {
          userId: user.id,
          projectId: suggestedIdentityProject.id,
          beatKey: "window-0",
          sequence: 0,
          sourceExcerptHash: "unchanged-window",
          beatJson: JSON.stringify({ subject: "creator", action: "explains", setting: "studio", emotion: "warm", emphasis: "lesson" }),
          status: "current",
          generationIdentityKey: oldSuggestedIdentity,
          existingAssetUrl: shiftedAssetJob.outputUrl,
          existingImageJobId: shiftedAssetJob.id,
        },
      },
    },
  });
  const shiftedPin = await prepareProjectVisualPin({
    userId: user.id,
    projectId: suggestedIdentityProject.id,
    preflightId: shiftedPreflight.id,
    sourceHashes: [shiftedPreflight.sourceHash],
  });
  const shiftedContext = JSON.parse(shiftedPin.projectVisualContextJson);
  const shiftedIdentity = brandVisualIdentityKey(shiftedContext);
  const shiftedBeat = await prisma.projectVisualBeat.findFirstOrThrow({
    where: { preflightId: shiftedPreflight.id },
  });
  assert.equal(shiftedBeat.generationIdentityKey, shiftedIdentity,
    "acceptance advances a carried beat to the exact current Suggested Treatment identity");
  assert.equal(shiftedBeat.status, "outdated",
    "an image rendered under another Suggested Treatment cannot be silently reused");

  const saved = await saveProjectLook({
    userId: user.id,
    projectId: project.id,
    look: { visualFormatId: "dramatic-comic", treatmentPresetId: "thai-human-drama" },
  });
  assert.equal(saved.visualFormatId, "dramatic-comic");
  assert.equal(saved.recipeVersion, "dramatic-comic-v9", "project stores a resolved recipe snapshot");
  const overridden = await resolveProjectVisualContext({
    userId: user.id,
    projectId: project.id,
    suggested: { visualFormatId: "clear-infographic", treatment: "calm" },
  });
  assert.equal(overridden.source, "project-look");
  assert.equal(overridden.visualFormatId, "dramatic-comic", "creator override wins over AI suggestion and brand");
  assert.deepEqual(overridden.brandVisualLanguage?.palette, ["#111111", "#38BDF8"], "brand language remains beneath the project format override");
  assert.equal((await prisma.editorProject.findUniqueOrThrow({ where: { id: project.id } })).brandProfileRevisionId, revision.id);

  const pinnedPreflight = await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: project.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "pinned-source-v1",
      ...treatmentPlanFields,
      contentDomain: "pinned creator education",
      suggestedVisualFormatId: "retro-story",
      suggestedTreatmentJson: JSON.stringify({ label: "calm", mood: "archival" }),
      createdAt: new Date("2026-08-09T01:00:00.000Z"),
      visualBeats: {
        create: [
          {
            userId: user.id,
            projectId: project.id,
            beatKey: "window-0",
            sequence: 0,
            sourceExcerptHash: "old-0",
            beatJson: JSON.stringify({ subject: "old hook subject", action: "opens", setting: "old studio", emotion: "curious", emphasis: "old hook" }),
          },
          {
            userId: user.id,
            projectId: project.id,
            beatKey: "window-1",
            sequence: 1,
            sourceExcerptHash: "old-1",
            beatJson: JSON.stringify({ subject: "old closing subject", action: "finishes", setting: "old studio", emotion: "confident", emphasis: "old close" }),
          },
        ],
      },
    },
  });
  await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: project.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "unrelated-later-source",
      ...treatmentPlanFields,
      contentDomain: "another tab's newer script",
      suggestedVisualFormatId: "clear-infographic",
      suggestedTreatmentJson: JSON.stringify({ label: "unrelated", mood: "later" }),
      createdAt: new Date("2026-08-09T01:30:00.000Z"),
      visualBeats: {
        create: {
          userId: user.id,
          projectId: project.id,
          beatKey: "window-0",
          sequence: 0,
          sourceExcerptHash: "unrelated-0",
          beatJson: JSON.stringify({ subject: "unrelated subject", action: "waits", setting: "other tab", emotion: "neutral", emphasis: "unrelated" }),
        },
      },
    },
  });
  await assert.rejects(
    prepareProjectVisualPin({
      userId: user.id,
      projectId: project.id,
      preflightId: pinnedPreflight.id,
      sourceHashes: ["another-tab-source"],
    }),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error
      && error.code === "PREFLIGHT_REQUIRED",
    ),
    "an exact preflight id must still match the narrative accepted by this render",
  );
  const pin = await prepareProjectVisualPin({
    userId: user.id,
    projectId: project.id,
    preflightId: pinnedPreflight.id,
    sourceHashes: [pinnedPreflight.sourceHash],
  });
  assert.equal(pin.contentPreflightId, pinnedPreflight.id,
    "job acceptance pins the preflight matching its narrative, not another tab's latest analysis");
  const videoJob = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: project.id,
      contentPreflightId: pin.contentPreflightId,
      projectVisualContextJson: pin.projectVisualContextJson,
      inputJson: "{}",
    },
  });

  await saveProjectLook({
    userId: user.id,
    projectId: project.id,
    look: { visualFormatId: "clear-infographic", treatmentPresetId: "expert-clarity" },
  });
  await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: project.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "newer-source-v2",
      ...treatmentPlanFields,
      contentDomain: "new content that must not leak into the old job",
      suggestedVisualFormatId: "clear-infographic",
      suggestedTreatmentJson: JSON.stringify({ label: "new", mood: "new" }),
      createdAt: new Date("2026-08-09T02:00:00.000Z"),
      visualBeats: {
        create: {
          userId: user.id,
          projectId: project.id,
          beatKey: "window-0",
          sequence: 0,
          sourceExcerptHash: "new-0",
          beatJson: JSON.stringify({ subject: "new leaked subject", action: "changes", setting: "new studio", emotion: "new", emphasis: "new" }),
        },
      },
    },
  });
  await assert.rejects(
    resolveProjectVisualPromptForVideoScene({
      userId: user.id,
      videoJobId: videoJob.id,
      sceneIndex: 9,
    }),
    /ไม่พบข้อมูลภาพสำหรับฉากที่ 10/,
    "a missing window must fail closed instead of repeating the final Close beat",
  );
  const pinnedPrompt = await resolveProjectVisualPromptForVideoScene({
    userId: user.id,
    videoJobId: videoJob.id,
    sceneIndex: 1,
  });
  assert.ok(pinnedPrompt, "a pinned branded job never falls back to the legacy prompt");
  assert.equal(pinnedPrompt?.compiled.recipeVersion, "dramatic-comic-v9");
  assert.match(pinnedPrompt?.compiled.positive ?? "", /thick varied ink contours/);
  assert.match(pinnedPrompt?.compiled.positive ?? "", /old closing subject/,
    "each rendered B-roll window resolves its exact pinned Visual Beat");
  assert.doesNotMatch(pinnedPrompt?.compiled.positive ?? "", /new leaked subject|diagrammatic editorial/,
    "later Project Look and Content Preflight edits cannot alter an existing VideoJob");

  type ResolveWithSceneDirection = (input: {
    userId: string;
    videoJobId: string;
    sceneIndex: number;
    sceneRenderingDirection?: {
      storytellingMode: string;
      camera: string;
      lighting: string;
      palette: string;
    };
  }) => ReturnType<typeof resolveProjectVisualPromptForVideoScene>;
  const resolveWithSceneDirection = resolveProjectVisualPromptForVideoScene as ResolveWithSceneDirection;
  const cinematicV10Job = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: project.id,
      contentPreflightId: pinnedPreflight.id,
      projectVisualContextJson: JSON.stringify({
        schemaVersion: 2,
        source: "project-look",
        visualFormatId: "cinematic-realism",
        recipeVersion: "cinematic-realism-v10",
        treatment: "ผู้เชี่ยวชาญอธิบายชัด",
        treatmentPin: {
          kind: "catalog", presetId: "expert-clarity", version: "v1.0.0", source: "creator",
        },
        brandVisualLanguage: null,
      }),
      inputJson: "{}",
    },
  });
  const wideDirection = {
    storytellingMode: "environmental",
    camera: "wide eye-level view across the lived-in room",
    lighting: "soft morning window light",
    palette: "warm wood, cream paper and muted green",
  };
  const closeDirection = {
    storytellingMode: "macro-process",
    camera: "tight overhead close-up of hands and physical cards",
    lighting: "focused neutral task light",
    palette: "charcoal, off-white and restrained amber",
  };
  const v10WidePrompt = await resolveWithSceneDirection({
    userId: user.id,
    videoJobId: cinematicV10Job.id,
    sceneIndex: 0,
    sceneRenderingDirection: wideDirection,
  });
  const v10ClosePrompt = await resolveWithSceneDirection({
    userId: user.id,
    videoJobId: cinematicV10Job.id,
    sceneIndex: 0,
    sceneRenderingDirection: closeDirection,
  });
  assert.notEqual(
    v10WidePrompt?.compiled.positive,
    v10ClosePrompt?.compiled.positive,
    "the durable Project Visual resolver carries each Hero scene's flexible direction into the provider prompt",
  );
  assert.match(v10WidePrompt?.compiled.positive ?? "", /wide eye-level view across the lived-in room/);
  assert.match(v10WidePrompt?.compiled.positive ?? "", /soft morning window light/);
  assert.match(v10WidePrompt?.compiled.positive ?? "", /warm wood, cream paper and muted green/);

  const frozenV9WithDirection = await resolveWithSceneDirection({
    userId: user.id,
    videoJobId: videoJob.id,
    sceneIndex: 0,
    sceneRenderingDirection: wideDirection,
  });
  assert.doesNotMatch(
    frozenV9WithDirection?.compiled.positive ?? "",
    /wide eye-level view across the lived-in room/,
    "a scene-diversity fix must not rewrite an existing v9 Project Visual pin",
  );

  const uploadProject = await prisma.editorProject.create({
    data: {
      userId: user.id,
      title: "Upload acceptance snapshot",
      brandProfileRevisionId: revision.id,
    },
  });
  const uploadPreflight = await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: uploadProject.id,
      narrativeSourceKind: "upload-transcript",
      sourceHash: "upload-transcript-v1",
      ...treatmentPlanFields,
      contentDomain: "upload creator education",
      suggestedVisualFormatId: "retro-story",
      suggestedTreatmentJson: JSON.stringify({ label: "documentary", mood: "warm" }),
      visualBeats: {
        create: {
          userId: user.id,
          projectId: uploadProject.id,
          beatKey: "window-0",
          sequence: 0,
          sourceExcerptHash: "upload-0",
          beatJson: JSON.stringify({ subject: "upload subject", action: "teaches", setting: "upload studio", emotion: "assured", emphasis: "upload lesson" }),
        },
      },
    },
  });
  const uploadAcceptance = await prepareUploadProjectVisualSnapshot({
    userId: user.id,
    projectId: uploadProject.id,
  });
  const uploadJob = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: uploadProject.id,
      contentPreflightId: uploadAcceptance.contentPreflightId,
      projectVisualContextJson: uploadAcceptance.projectVisualContextJson,
      inputJson: "{}",
    },
  });
  await saveProjectLook({
    userId: user.id,
    projectId: uploadProject.id,
    look: { visualFormatId: "clear-infographic", treatmentPresetId: "expert-clarity" },
  });
  await pinProjectVisualContextToVideoJob({
    userId: user.id,
    projectId: uploadProject.id,
    videoJobId: uploadJob.id,
    preflightId: uploadPreflight.id,
  });
  const uploadPrompt = await resolveProjectVisualPromptForVideoScene({
    userId: user.id,
    videoJobId: uploadJob.id,
    sceneIndex: 0,
  });
  assert.equal(uploadPrompt?.source, "brand-revision");
  assert.equal(uploadPrompt?.compiled.visualFormatId, "stick-figure-story",
    "upload keeps the Brand Revision selected when the job was accepted");
  assert.doesNotMatch(uploadPrompt?.compiled.positive ?? "", /diagrammatic editorial/,
    "a Project Look edit during transcription cannot leak into the accepted upload");
  const racingUploadPreflight = await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: uploadProject.id,
      narrativeSourceKind: "upload-transcript",
      sourceHash: "upload-transcript-racing-tab",
      ...treatmentPlanFields,
      contentDomain: "different transcript",
      suggestedVisualFormatId: "clear-infographic",
      suggestedTreatmentJson: JSON.stringify({ label: "different", mood: "cool" }),
      visualBeats: {
        create: {
          userId: user.id,
          projectId: uploadProject.id,
          beatKey: "window-race-0",
          sequence: 0,
          sourceExcerptHash: "upload-race-0",
          beatJson: JSON.stringify({ subject: "other", action: "changes", setting: "other", emotion: "cool", emphasis: "race" }),
        },
      },
    },
  });
  await assert.rejects(
    pinProjectVisualContextToVideoJob({
      userId: user.id,
      projectId: uploadProject.id,
      videoJobId: uploadJob.id,
      preflightId: racingUploadPreflight.id,
    }),
    /ข้อมูลฉากคนละชุด/,
    "a second upload worker cannot silently adopt a different transcript after the job is pinned",
  );

  const suggestedUploadProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Upload suggested snapshot" },
  });
  const suggestedAcceptance = await prepareUploadProjectVisualSnapshot({
    userId: user.id,
    projectId: suggestedUploadProject.id,
  });
  const suggestedPreflight = await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: suggestedUploadProject.id,
      narrativeSourceKind: "upload-transcript",
      sourceHash: "suggested-upload-transcript-v1",
      ...treatmentPlanFields,
      contentDomain: "suggested upload lesson",
      suggestedVisualFormatId: "retro-story",
      suggestedTreatmentJson: JSON.stringify({ label: "nostalgic", mood: "warm" }),
      visualBeats: {
        create: {
          userId: user.id,
          projectId: suggestedUploadProject.id,
          beatKey: "window-0",
          sequence: 0,
          sourceExcerptHash: "suggested-upload-0",
          beatJson: JSON.stringify({ subject: "suggested subject", action: "remembers", setting: "warm room", emotion: "hopeful", emphasis: "memory" }),
        },
      },
    },
  });
  const suggestedUploadJob = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: suggestedUploadProject.id,
      contentPreflightId: suggestedAcceptance.contentPreflightId,
      projectVisualContextJson: suggestedAcceptance.projectVisualContextJson,
      inputJson: "{}",
    },
  });
  await saveProjectLook({
    userId: user.id,
    projectId: suggestedUploadProject.id,
    look: { visualFormatId: "dramatic-comic", treatmentPresetId: "thai-human-drama" },
  });
  await pinProjectVisualContextToVideoJob({
    userId: user.id,
    projectId: suggestedUploadProject.id,
    videoJobId: suggestedUploadJob.id,
    preflightId: suggestedPreflight.id,
  });
  const suggestedUploadPrompt = await resolveProjectVisualPromptForVideoScene({
    userId: user.id,
    videoJobId: suggestedUploadJob.id,
    sceneIndex: 0,
  });
  assert.equal(suggestedUploadPrompt?.source, "suggested");
  assert.equal(suggestedUploadPrompt?.compiled.visualFormatId, "retro-story",
    "an upload with no explicit Look keeps the transcript suggestion instead of adopting a later edit");

  const rollbackProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Visual pin rollback" },
  });
  const rollbackSnapshot = await prepareUploadProjectVisualSnapshot({
    userId: user.id,
    projectId: rollbackProject.id,
  });
  const rollbackPreflight = await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: rollbackProject.id,
      narrativeSourceKind: "upload-transcript",
      sourceHash: "rollback-upload-transcript-v1",
      ...treatmentPlanFields,
      contentDomain: "rollback lesson",
      suggestedVisualFormatId: "clear-infographic",
      suggestedTreatmentJson: JSON.stringify({ label: "clear", mood: "calm" }),
      visualBeats: {
        create: {
          userId: user.id,
          projectId: rollbackProject.id,
          beatKey: "window-0",
          sequence: 0,
          sourceExcerptHash: "rollback-0",
          beatJson: JSON.stringify({ subject: "rollback", action: "waits", setting: "studio", emotion: "calm", emphasis: "atomicity" }),
          existingAssetUrl: "/api/renders/old-rollback.webp",
          generationIdentityKey: "old-identity",
          status: "current",
        },
      },
    },
    include: { visualBeats: true },
  });
  const rollbackJob = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: rollbackProject.id,
      contentPreflightId: rollbackSnapshot.contentPreflightId,
      projectVisualContextJson: rollbackSnapshot.projectVisualContextJson,
      inputJson: "{}",
    },
  });
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER fail_visual_pin_for_atomicity
    BEFORE UPDATE OF contentPreflightId ON VideoJob
    WHEN NEW.id = '${rollbackJob.id}'
    BEGIN
      SELECT RAISE(ABORT, 'forced visual pin failure');
    END
  `);
  await assert.rejects(
    pinProjectVisualContextToVideoJob({
      userId: user.id,
      projectId: rollbackProject.id,
      videoJobId: rollbackJob.id,
      preflightId: rollbackPreflight.id,
    }),
  );
  await prisma.$executeRawUnsafe("DROP TRIGGER fail_visual_pin_for_atomicity");
  const rolledBackBeat = await prisma.projectVisualBeat.findUniqueOrThrow({
    where: { id: rollbackPreflight.visualBeats[0].id },
  });
  assert.equal(rolledBackBeat.generationIdentityKey, "old-identity");
  assert.equal(rolledBackBeat.status, "current",
    "a failed VideoJob pin rolls back Visual Beat identity/status mutations");
  const rolledBackProject = await prisma.editorProject.findUniqueOrThrow({
    where: { id: rollbackProject.id },
  });
  assert.equal(rolledBackProject.treatmentPresetId, null,
    "a failed VideoJob pin rolls back the project treatment pin");
  assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: rollbackJob.id } })).contentPreflightId, null);

  const applyProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Atomic apply-mode contract" },
  });
  const oldIdentityJobs = await Promise.all([0, 1].map((sceneIndex) => prisma.aiGenerationJob.create({
    data: {
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image",
      status: "completed",
      outputUrl: `https://cdn.example/old-${sceneIndex}.png`,
      inputJson: JSON.stringify({ brandVisualIdentityKey: "old-brand-language" }),
      fundingSource: "credits",
      chargeState: "settled",
      creditCost: 2,
    },
  })));
  const applyPreflight = await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: applyProject.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "atomic-apply-v1",
      ...treatmentPlanFields,
      contentDomain: "atomic selection",
      suggestedVisualFormatId: "clear-infographic",
      suggestedTreatmentJson: JSON.stringify({ label: "clear", mood: "calm" }),
      visualBeats: {
        create: oldIdentityJobs.map((job, sequence) => ({
          userId: user.id,
          projectId: applyProject.id,
          beatKey: `window-${sequence}`,
          sequence,
          sourceExcerptHash: `atomic-${sequence}`,
          beatJson: JSON.stringify({ subject: `subject ${sequence}`, action: "explains", setting: "studio", emotion: "clear", emphasis: "lesson" }),
          existingAssetUrl: job.outputUrl,
          existingImageJobId: job.id,
          status: "current",
        })),
      },
    },
  });
  const beforeConfirmation = await prisma.editorProject.findUniqueOrThrow({ where: { id: applyProject.id } });
  await assert.rejects(
    applyProjectLook({
      userId: user.id,
      projectId: applyProject.id,
      preflightId: applyPreflight.id,
      look: { visualFormatId: "dramatic-comic", treatmentPresetId: "thai-human-drama" },
    }),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error
      && error.code === "LOOK_CHANGE_CONFIRMATION_REQUIRED",
    ),
    "an existing image set requires an explicit apply mode",
  );
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: applyProject.id } })).projectLookJson,
    beforeConfirmation.projectLookJson,
    "a rejected change cannot partially mutate the project selection",
  );

  await assert.rejects(
    applyProjectLook({
      userId: user.id,
      projectId: applyProject.id,
      preflightId: applyPreflight.id,
      applyMode: "new-only" as never,
      look: { visualFormatId: "dramatic-comic", treatmentPresetId: "thai-human-drama" },
    }),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error
      && error.code === "LOOK_CHANGE_CONFIRMATION_REQUIRED"
    ),
    "future-images-only is no longer an accepted partial-change mode",
  );
  const applyVideoJob = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: applyProject.id,
      contentPreflightId: applyPreflight.id,
      projectVisualContextJson: JSON.stringify({
        schemaVersion: 2,
        source: "suggested",
        visualFormatId: "clear-infographic",
        recipeVersion: "clear-infographic-v4",
        treatment: "ผู้เชี่ยวชาญอธิบายชัด",
        treatmentPin: {
          kind: "catalog", presetId: "expert-clarity", version: "v1.0.0", source: "adaptive",
        },
        brandVisualLanguage: null,
      }),
      inputJson: "{}",
    },
  });
  assert.deepEqual(
    await reusableProjectVisualBeatSceneIndices({
      userId: user.id,
      projectId: applyProject.id,
      preflightId: applyPreflight.id,
    }),
    [0, 1],
    "before a confirmed look change every current settled asset remains reusable",
  );
  assert.deepEqual(
    (await reusableVisualBeatAssetsForVideoJob({ userId: user.id, videoJobId: applyVideoJob.id }))
      .map((asset) => asset.sceneIndex),
    [0, 1],
    "quote and accepted-job execution share the same current+settled reuse contract",
  );

  // #430: the look IS a pin, so the write records the owner's image decision
  // beside it. Anything that renders managed AI images off an "existing pin"
  // reads that stamp, never the mere presence of a look.
  await applyProjectLook({
    userId: user.id,
    projectId: applyProject.id,
    preflightId: applyPreflight.id,
    applyMode: "regenerate-all",
    look: { visualFormatId: "retro-story", treatmentPresetId: "thai-history-period-storytelling" },
    admission: { cohort: "treatment-100", at: new Date("2026-09-03T00:00:00.000Z") },
  });
  const admittedLookProject = await prisma.editorProject.findUniqueOrThrow({
    where: { id: applyProject.id },
  });
  assert.equal(admittedLookProject.brandVisualPinAdmittedCohort, "treatment-100",
    "applying a Project Look stamps the image decision taken at pin time");
  assert.equal(
    admittedLookProject.brandVisualPinAdmittedAt?.toISOString(),
    "2026-09-03T00:00:00.000Z",
  );
  assert.deepEqual(
    await reusableProjectVisualBeatSceneIndices({
      userId: user.id,
      projectId: applyProject.id,
      preflightId: applyPreflight.id,
    }),
    [],
  );
  assert.deepEqual(
    await reusableVisualBeatAssetsForVideoJob({ userId: user.id, videoJobId: applyVideoJob.id }),
    [],
    "regenerate-all atomically makes the exact preflight ineligible for quote and execution reuse",
  );
  const applyBeat = await prisma.projectVisualBeat.findFirstOrThrow({
    where: { preflightId: applyPreflight.id, sequence: 0 },
  });
  const lateOldJob = await prisma.aiGenerationJob.create({
    data: {
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image",
      status: "completed",
      outputUrl: "https://cdn.example/late-old.png",
      fundingSource: "credits",
      chargeState: "settled",
      creditCost: 2,
    },
  });
  const lateOldLink = await recordVisualBeatAsset({
    userId: user.id,
    beatId: applyBeat.id,
    outputUrl: lateOldJob.outputUrl!,
    imageJobId: lateOldJob.id,
    identityKey: brandVisualIdentityKey({
      visualFormatId: "dramatic-comic",
      recipeVersion: "dramatic-comic-v3",
      treatment: "new identity",
      brandVisualLanguage: null,
    }),
  });
  assert.equal(lateOldLink.linked, false,
    "an old accepted job may finish its own video but cannot re-current a beat after regenerate-all");
  assert.equal(
    (await prisma.projectVisualBeat.findUniqueOrThrow({ where: { id: applyBeat.id } })).status,
    "outdated",
  );
  const currentIdentity = brandVisualIdentityKey({
    visualFormatId: "retro-story",
    recipeVersion: "retro-story-v9",
    treatment: "ประวัติศาสตร์และตำนานไทย",
    treatmentPin: {
      kind: "catalog",
      presetId: "thai-history-period-storytelling",
      version: "v1.0.0",
      source: "creator",
    },
    brandVisualLanguage: null,
  });
  const currentJob = await prisma.aiGenerationJob.create({
    data: {
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image",
      status: "completed",
      outputUrl: "https://cdn.example/current.png",
      fundingSource: "credits",
      chargeState: "settled",
      creditCost: 2,
    },
  });
  const currentLink = await recordVisualBeatAsset({
    userId: user.id,
    beatId: applyBeat.id,
    outputUrl: currentJob.outputUrl!,
    imageJobId: currentJob.id,
    identityKey: currentIdentity,
  });
  assert.equal(currentLink.linked, true);
  assert.equal(
    (await prisma.projectVisualBeat.findUniqueOrThrow({ where: { id: applyBeat.id } })).status,
    "current",
    "only the currently selected identity can complete regeneration",
  );

  await prisma.editorProject.update({
    where: { id: project.id },
    data: {
      brandVisualPinAdmittedCohort: "treatment-100",
      brandVisualPinAdmittedAt: new Date("2026-09-03T00:00:00.000Z"),
    },
  });
  await clearProjectLook({ userId: user.id, projectId: project.id });
  const clearedProject = await prisma.editorProject.findUniqueOrThrow({ where: { id: project.id } });
  assert.equal(clearedProject.treatmentPresetId, null,
    "clearing Project Look also clears its project-scoped treatment decision");
  assert.equal(clearedProject.treatmentPresetVersion, null);
  assert.equal(clearedProject.treatmentPinSource, null);
  assert.equal(clearedProject.brandVisualPinAdmittedCohort, null,
    "clearing a pin also clears the image admission it was granted (#430)");
  assert.equal(clearedProject.brandVisualPinAdmittedAt, null);
  const restored = await resolveProjectVisualContext({
    userId: user.id,
    projectId: project.id,
    suggested: { visualFormatId: "clear-infographic", treatment: "calm" },
  });
  assert.equal(restored.source, "brand-revision");

  // ── Wave 1 Task 7: one Style Pack chosen for THIS clip ────────────────────
  // A pack is one tap over the axes the Project Look already owns (ADR 0058):
  // it resolves the image format and the narrative treatment, and it SNAPSHOTS
  // itself into the look so the render-time readers (stock mood, pacing, music)
  // read the pack the creator was shown, never the live catalog (ADR 0005).
  const { stockMoodForProject } = await import("../src/lib/broll-preferences");
  const { STYLE_PACK_UNAVAILABLE_MESSAGE } = await import("../src/lib/style-pack-apply");
  const { stylePack: stylePackFromCatalog } = await import("../src/lib/style-pack-catalog");
  const ghostPack = stylePackFromCatalog("thai-ghost");
  const { promoteProjectLookToBrandProfile } = await import("../src/lib/brand-profile-library.server");

  const packUser = await prisma.user.create({
    data: { name: "Pack owner", email: "pack-look@example.test" },
  });
  const packProject = await prisma.editorProject.create({
    data: { userId: packUser.id, title: "Per-clip Style Pack" },
  });
  const packLook = await saveProjectLook({
    userId: packUser.id,
    projectId: packProject.id,
    look: { stylePackId: "thai-ghost" },
  });
  assert.equal(packLook.schemaVersion, 2);
  assert.equal(packLook.visualFormatId, "cinematic-realism",
    "the pack, not the client, decides the clip's image format");
  assert.equal(packLook.schemaVersion === 2 ? packLook.treatmentPin.presetId : null,
    "thai-supernatural-horror",
    "the pack, not the client, decides the clip's narrative treatment");
  assert.equal(packLook.schemaVersion === 2 ? packLook.treatmentPin.source : null, "creator",
    "a per-clip pack is an explicit creator decision, so later analyses cannot overrule it");
  assert.equal(packLook.stylePack?.id, "thai-ghost");
  assert.equal(packLook.stylePack?.version, "v1.0.0");
  assert.equal(packLook.stylePack?.stockMood.queryToken, "night");
  assert.equal(packLook.stylePack?.pacing, "normal");
  assert.equal(packLook.stylePack?.musicMood, "ominous");
  assert.deepEqual(packLook.brandVisualLanguage?.palette, ["#0B0F1A", "#7C1D2B", "#C9A24C"],
    "the pack resolves the clip's palette too, so promoting the clip keeps one look");
  const packProjectRow = await prisma.editorProject.findUniqueOrThrow({ where: { id: packProject.id } });
  assert.equal(packProjectRow.treatmentPresetId, "thai-supernatural-horror");
  assert.equal(packProjectRow.treatmentPinSource, "creator");

  const packContext = await resolveProjectVisualContext({
    userId: packUser.id,
    projectId: packProject.id,
    suggested: { visualFormatId: "clear-infographic", treatment: "calm" },
  });
  assert.equal(packContext.source, "project-look");
  assert.equal(packContext.stylePack?.id, "thai-ghost",
    "the resolved per-clip context carries the pack so Step 2 and the render read the same one");

  const packPreflight = await prisma.contentPreflight.create({
    data: {
      userId: packUser.id,
      projectId: packProject.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "style-pack-clip-v1",
      contentDomain: "thai horror",
      suggestedVisualFormatId: "clear-infographic",
      suggestedTreatmentJson: JSON.stringify({ label: "clear", mood: "direct" }),
      ...treatmentPlanFields,
      visualBeats: {
        create: {
          userId: packUser.id,
          projectId: packProject.id,
          beatKey: "window-0",
          sequence: 0,
          sourceExcerptHash: "style-pack-window-0",
          beatJson: JSON.stringify({ sourceExcerpt: "a dark corridor", subject: "corridor" }),
        },
      },
    },
  });
  const packPin = await prepareProjectVisualPin({
    userId: packUser.id,
    projectId: packProject.id,
    preflightId: packPreflight.id,
  });
  const pinnedMood = stockMoodForProject({
    projectVisualContextJson: packPin.projectVisualContextJson,
    brandRevisionRecipeJson: null,
  });
  assert.equal(pinnedMood?.packId, "thai-ghost",
    "the pinned per-clip context is what the stock search reads, so the pack must survive the pin");
  assert.equal(pinnedMood?.queryToken, "night");

  // Precedence (already contracted in broll-preferences): the per-clip pack
  // outranks the Brand's, because the creator overruled the brand for this clip.
  const brandRecipeWithOtherPack = JSON.stringify({
    schemaVersion: 1,
    visualFormatId: "clear-infographic",
    recipeVersion: "clear-infographic-v4",
    brandVisualLanguage: null,
    defaultTreatment: "clear",
    treatmentPolicy: "adaptive",
    lockedTreatmentPin: null,
    stylePack: {
      id: "finance-clear",
      version: "v1.0.0",
      stockMood: {
        queryToken: "clean",
        positive: ["chart"],
        avoid: ["horror"],
        direction: "clean modern financial clarity",
        fallbackQueries: ["a", "b", "c", "d", "e"],
      },
      pacing: "fast",
      musicMood: "upbeat",
    },
  });
  assert.equal(
    stockMoodForProject({
      projectVisualContextJson: packPin.projectVisualContextJson,
      brandRevisionRecipeJson: brandRecipeWithOtherPack,
    })?.packId,
    "thai-ghost",
    "a pack chosen for this clip outranks the Brand's pack",
  );

  // A pack still awaiting the Treatment Qualification Benchmark is never
  // selectable, and says so in customer Thai (ADR 0058).
  await assert.rejects(
    saveProjectLook({
      userId: packUser.id,
      projectId: packProject.id,
      look: { stylePackId: "dark-story" },
    }),
    (error: unknown) => error instanceof Error
      && error.message === STYLE_PACK_UNAVAILABLE_MESSAGE,
    "a pending-benchmark pack cannot be chosen for a clip",
  );

  // กำหนดเอง: unlink the pack and keep EVERYTHING it resolved — format,
  // treatment AND palette/personality — exactly like `clearStylePack` on
  // /brands (controller ruling R23, amended). Only the snapshot is dropped.
  // The project below is pinned to a Brand with its own blue palette, so a
  // regression that "falls back to the brand" is visible rather than hidden
  // behind a project that has no brand at all.
  const packBrandProject = await prisma.editorProject.create({
    data: { userId: packUser.id, title: "Pack over a brand", brandProfileRevisionId: revision.id },
  });
  await saveProjectLook({
    userId: packUser.id,
    projectId: packBrandProject.id,
    look: { stylePackId: "thai-ghost" },
  });
  const customAfterPack = await saveProjectLook({
    userId: packUser.id,
    projectId: packBrandProject.id,
    look: {
      visualFormatId: "cinematic-realism",
      treatmentPresetId: "thai-supernatural-horror",
      stylePackId: null,
    },
  });
  assert.equal(customAfterPack.stylePack, null,
    "กำหนดเอง unlinks the pack");
  assert.equal(customAfterPack.visualFormatId, "cinematic-realism",
    "unlinking the pack keeps the look it already resolved");
  assert.equal(
    customAfterPack.schemaVersion === 2 ? customAfterPack.treatmentPin.presetId : null,
    "thai-supernatural-horror",
  );
  assert.deepEqual(
    customAfterPack.brandVisualLanguage?.palette,
    ["#0B0F1A", "#7C1D2B", "#C9A24C"],
    "the look the creator is looking at does not change when they unlink the style — the pack's palette stays, it simply becomes their own",
  );
  assert.equal(
    customAfterPack.brandVisualLanguage?.personality,
    ghostPack.personality,
    "personality is a pack-resolved axis too, so unlinking keeps it rather than reverting to the Brand's",
  );
  // A look change on a project that never had a pack still follows the Brand.
  const brandOnlyProject = await prisma.editorProject.create({
    data: { userId: packUser.id, title: "No pack, brand language", brandProfileRevisionId: revision.id },
  });
  const brandOnlyLook = await saveProjectLook({
    userId: packUser.id,
    projectId: brandOnlyProject.id,
    look: { visualFormatId: "cinematic-realism", treatmentPresetId: "thai-supernatural-horror" },
  });
  assert.deepEqual(
    brandOnlyLook.brandVisualLanguage?.palette,
    ["#111111", "#38BDF8"],
    "keeping a pack's language must not change what a pack-less look inherits from its Brand",
  );

  await saveProjectLook({
    userId: packUser.id,
    projectId: packProject.id,
    look: { stylePackId: "thai-ghost" },
  });
  await clearProjectLook({ userId: packUser.id, projectId: packProject.id });
  const clearedPackContext = await resolveProjectVisualContext({
    userId: packUser.id,
    projectId: packProject.id,
    suggested: { visualFormatId: "clear-infographic", treatment: "calm" },
  });
  assert.equal(clearedPackContext.stylePack ?? null, null,
    "clearing the clip's look also removes its pack snapshot");

  // Promotion: "save this clip's look as a brand" must carry the clip's pack
  // into the new Revision's immutable recipe — resolved on the server, never
  // taken from the client body.
  const promotionProject = await prisma.editorProject.create({
    data: { userId: packUser.id, title: "Promote the clip's pack" },
  });
  const promotionPreflight = await prisma.contentPreflight.create({
    data: {
      userId: packUser.id,
      projectId: promotionProject.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "style-pack-promotion-v1",
      contentDomain: "thai horror",
      suggestedVisualFormatId: "clear-infographic",
      suggestedTreatmentJson: JSON.stringify({ label: "clear", mood: "direct" }),
      ...treatmentPlanFields,
      visualBeats: {
        create: {
          userId: packUser.id,
          projectId: promotionProject.id,
          beatKey: "window-0",
          sequence: 0,
          sourceExcerptHash: "style-pack-promotion-window-0",
          beatJson: JSON.stringify({ sourceExcerpt: "a dark corridor", subject: "corridor" }),
        },
      },
    },
  });
  const promotedLook = await saveProjectLook({
    userId: packUser.id,
    projectId: promotionProject.id,
    look: { stylePackId: "thai-ghost" },
  });
  const promotionPayload = {
    schemaVersion: 1 as const,
    name: "แบรนด์หนังผีไทย",
    niche: "thai horror",
    audience: "Thai creators",
    script: {
      styleId: null,
      tone: "เล่าเรื่องแบบของฉันเอง",
      bannedWords: [],
      ctaStyle: "follow",
      language: "th",
      analysisNotes: null,
      sampleText: null,
    },
    voice: { provider: "gemini", voiceId: null },
    subtitle: { presetId: null, config: {} },
    brandMark: { assetId: null, enabled: false, position: "top-right", sizePct: 18, opacity: 0.9 },
    visual: {
      // Exactly what the /brands form seeds from the clip — the look, with NO
      // pack id: the server must recognise the clip's pack on its own instead
      // of trusting the body to carry it.
      primaryVisualFormatId: promotedLook.visualFormatId,
      treatmentPolicy: "adaptive" as const,
      lockedTreatmentPresetId: null,
      stylePackId: null,
      stylePackVersion: null,
      languageMode: "defined" as const,
      palette: promotedLook.brandVisualLanguage?.palette ?? [],
      personality: promotedLook.brandVisualLanguage?.personality ?? "",
      peopleAndSetting: "",
      memorableCues: [],
      visualNotes: "",
      defaultTreatment: promotedLook.treatment,
    },
  };
  const promoted = await promoteProjectLookToBrandProfile({
    userId: packUser.id,
    projectId: promotionProject.id,
    preflightId: promotionPreflight.id,
    payload: promotionPayload,
  });
  const promotedRecipe = JSON.parse(promoted.revision.visualRecipeJson) as {
    visualFormatId: string;
    stylePack: { id: string; version: string; pacing: string; musicMood: string } | null;
  };
  assert.equal(promotedRecipe.stylePack?.id, "thai-ghost",
    "promoting a clip whose look is a pack produces a Revision that keeps that pack");
  assert.equal(promotedRecipe.stylePack?.musicMood, "ominous");
  assert.equal(promotedRecipe.visualFormatId, "cinematic-realism",
    "the promoted Revision keeps the pack's own image format");
  assert.equal(
    (JSON.parse(promoted.revision.payloadJson) as { visual: { stylePackId: string | null } })
      .visual.stylePackId,
    "thai-ghost",
    "the promoted Brand stays linked to the pack, so editing it later unlinks explicitly",
  );
  // Re-linking must never overwrite an actual edit: a body that changed a
  // pack-owned axis still gets the ordinary exact-promotion refusal, in Thai,
  // instead of having the change silently reverted to the pack's values.
  const editedProject = await prisma.editorProject.create({
    data: { userId: packUser.id, title: "Edited pack promotion" },
  });
  const editedPreflight = await prisma.contentPreflight.create({
    data: {
      userId: packUser.id,
      projectId: editedProject.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "style-pack-edited-v1",
      contentDomain: "thai horror",
      suggestedVisualFormatId: "clear-infographic",
      suggestedTreatmentJson: JSON.stringify({ label: "clear", mood: "direct" }),
      ...treatmentPlanFields,
      visualBeats: {
        create: {
          userId: packUser.id,
          projectId: editedProject.id,
          beatKey: "window-0",
          sequence: 0,
          sourceExcerptHash: "style-pack-edited-window-0",
          beatJson: JSON.stringify({ sourceExcerpt: "a dark corridor", subject: "corridor" }),
        },
      },
    },
  });
  await saveProjectLook({
    userId: packUser.id,
    projectId: editedProject.id,
    look: { stylePackId: "thai-ghost" },
  });
  await assert.rejects(
    promoteProjectLookToBrandProfile({
      userId: packUser.id,
      projectId: editedProject.id,
      preflightId: editedPreflight.id,
      payload: {
        ...promotionPayload,
        name: "แบรนด์ที่แก้สีเอง",
        visual: { ...promotionPayload.visual, palette: ["#123456"] },
      },
    }),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error && error.code === "REVISION_CONFLICT",
    ),
    "an edited look is refused, not quietly reverted to the pack's own values",
  );


  // Task 9 (Telemetry): the visual-context PUT route emits style_pack_selected
  // (surface: "project") server-side, next to the existing project_look_changed
  // call, ONLY when the request actually carried a stylePackId — a "กำหนดเอง"
  // (custom, stylePackId: null) look must never emit it.
  const visualContextRouteSource = readFileSync(
    "src/app/api/editor-projects/[id]/visual-context/route.ts",
    "utf8",
  );
  assert.match(
    visualContextRouteSource,
    /parsed\.data\.stylePackId[\s\S]{0,400}name:\s*"style_pack_selected"[\s\S]{0,300}source:\s*"server"[\s\S]{0,300}surface:\s*"project"/,
    "style_pack_selected (surface: project) is gated on the request actually carrying a stylePackId, and is a server-sourced event",
  );
  assert.match(
    visualContextRouteSource,
    /name:\s*"style_pack_selected"[\s\S]{0,200}step:\s*"editor\.step2"/,
    "style_pack_selected on the project surface uses the same step vocabulary as project_look_changed",
  );

  const selectorSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/BrandVisualSelector.tsx",
    "utf8",
  );
  assert.match(selectorSource, /แนวเล่าเรื่องของคลิปนี้/,
    "Step 2 exposes the per-video recommendation in creator-facing language");
  assert.match(selectorSource, /treatmentPresetId[\s\S]+look: \{ visualFormatId: formatId, treatmentPresetId \}/,
    "the catalog selection is persisted through the exact Project Look mutation");
  assert.match(selectorSource, /pending\.formatId, pending\.treatmentPresetId, "regenerate-all"/,
    "the mandatory existing-image confirmation cannot drop the selected catalog option");
  assert.doesNotMatch(selectorSource, /brand-visual-treatment|treatmentDraft/,
    "the retired free-form treatment field is absent");
  assert.match(selectorSource, /const \[expanded, setExpanded\] = useState\(false\)/,
    "Step 2 starts on the low-friction summary instead of opening all five cards");
  assert.match(selectorSource, /!canRenderPersistedVisual \|\| !shouldLoadVisualContext/,
    "Stock + closed settings skips the Content Preflight request, not only the visible cards");
  assert.match(selectorSource, /เปลี่ยนแนวเล่าเรื่อง/,
    "the creator explicitly opens the visual cards after choosing an AI B-roll level");
  assert.ok(
    selectorSource.indexOf("แบรนด์ที่ใช้ (ถ้ามี)")
      < selectorSource.indexOf("{visualSelectionEnabled && expanded &&"),
    "quick Brand selection stays visible before the optional detailed Look controls",
  );
  const jobSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/useV2Job.ts",
    "utf8",
  );
  // ADR 0057 replaced the per-clip legacy style menu with the brand's pinned
  // Style Pack, resolved server-side. The old conditional suppression for
  // Hero-only images is now unconditional: the client submits no style at all.
  assert.equal(
    (jobSource.match(/brollVisualStyle/g) ?? []).length,
    0,
    "neither submission may send a legacy visual style that conflicts with Project Visual Context",
  );
  const step2Source = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx",
    "utf8",
  );
  assert.match(step2Source, /ใช้ Brand Visual ที่เลือกด้านบนเพียงจุดเดียว/,
    "Hero-only UI points to the one authoritative Brand/Project Look control");

  await prisma.$disconnect();
  console.log("verify-project-look: PASS snapshot + creator precedence + clear");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
