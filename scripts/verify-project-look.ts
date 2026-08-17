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
  const { shouldSendLegacyBrollVisualStyle } = await import("../src/lib/broll-preferences");
  assert.equal(shouldSendLegacyBrollVisualStyle("stock"), true);
  assert.equal(shouldSendLegacyBrollVisualStyle("auto-mix"), true);
  assert.equal(
    shouldSendLegacyBrollVisualStyle("kie-image"),
    false,
    "Hero-only generation must not submit a legacy visual style that conflicts with Project Visual Context",
  );
  assert.equal(shouldLoadBrandVisualContext({
    brollSource: "stock",
    mixPreset: "free",
    hasPersistedVisualPin: false,
    settingsOpen: false,
  }), false, "Stock + closed settings must not trigger Content Preflight");
  assert.equal(shouldLoadBrandVisualContext({
    brollSource: "automix",
    mixPreset: "free",
    hasPersistedVisualPin: false,
    settingsOpen: false,
  }), false, "Stock-only AutoMix must remain lazy");
  for (const trigger of [
    { brollSource: "automix", mixPreset: "recommended", hasPersistedVisualPin: false, settingsOpen: false },
    { brollSource: "kie-image", mixPreset: "free", hasPersistedVisualPin: false, settingsOpen: false },
    { brollSource: "stock", mixPreset: "free", hasPersistedVisualPin: false, settingsOpen: true },
    { brollSource: "stock", mixPreset: "free", hasPersistedVisualPin: true, settingsOpen: false },
  ]) {
    assert.equal(shouldLoadBrandVisualContext(trigger), true,
      "AI selection, explicit settings or an established pin triggers lazy analysis");
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

  await applyProjectLook({
    userId: user.id,
    projectId: applyProject.id,
    preflightId: applyPreflight.id,
    applyMode: "regenerate-all",
    look: { visualFormatId: "retro-story", treatmentPresetId: "thai-history-period-storytelling" },
  });
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

  await clearProjectLook({ userId: user.id, projectId: project.id });
  const clearedProject = await prisma.editorProject.findUniqueOrThrow({ where: { id: project.id } });
  assert.equal(clearedProject.treatmentPresetId, null,
    "clearing Project Look also clears its project-scoped treatment decision");
  assert.equal(clearedProject.treatmentPresetVersion, null);
  assert.equal(clearedProject.treatmentPinSource, null);
  const restored = await resolveProjectVisualContext({
    userId: user.id,
    projectId: project.id,
    suggested: { visualFormatId: "clear-infographic", treatment: "calm" },
  });
  assert.equal(restored.source, "brand-revision");

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
  assert.equal(
    (jobSource.match(/shouldSendLegacyBrollVisualStyle\(p\.brollSource\)/g) ?? []).length,
    2,
    "both upload and script submissions suppress legacy style for Hero-only images",
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
