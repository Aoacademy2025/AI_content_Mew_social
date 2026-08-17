import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "brand-treatment-pin-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { GENERIC_TREATMENT_PLACEHOLDER } = await import("../src/lib/brand-treatment-catalog");
  const {
    ProjectLookError,
    applyProjectLook,
    parseProjectVisualContext,
    prepareProjectVisualPin,
  } = await import("../src/lib/project-look.server");
  const { CONTENT_PREFLIGHT_ANALYZER_VERSION } = await import("../src/lib/content-preflight.server");

  const user = await prisma.user.create({
    data: { name: "Pin owner", email: "brand-treatment-pin@example.test", plan: "PRO" },
  });

  async function createReadyProject(title: string, treatmentPresetId = "thai-supernatural-horror") {
    const project = await prisma.editorProject.create({ data: { userId: user.id, title } });
    const preflight = await prisma.contentPreflight.create({
      data: {
        userId: user.id,
        projectId: project.id,
        narrativeSourceKind: "creator-script",
        sourceHash: `${title}-hash`,
        analyzerVersion: CONTENT_PREFLIGHT_ANALYZER_VERSION,
        contentDomain: "Thai supernatural story",
        dominantNarrativeMode: "continuing supernatural narrative",
        suggestedVisualFormatId: "cinematic-realism",
        suggestedTreatmentJson: JSON.stringify({ label: "หนังผีไทย", mood: "frightening" }),
        suggestedTreatmentPresetId: treatmentPresetId,
        suggestedTreatmentPresetVersion: "v1.0.0",
        rankedTreatmentPresetIdsJson: JSON.stringify([
          treatmentPresetId,
          "thai-human-drama",
          "thai-history-period-storytelling",
        ]),
        treatmentRecommendationRationale: "The supernatural event continues through the story.",
        storyEntitiesJson: JSON.stringify([{
          entityId: "entity-kong",
          properName: "Kong",
          entityType: "person",
          durableAttributes: ["adult", "Thai", "man"],
          renderingDescription: "an adult Thai human man with short black hair",
          recurringCharacterDescription: null,
          isRealPerson: false,
        }]),
        visualBeats: {
          create: {
            userId: user.id,
            projectId: project.id,
            beatKey: "window-0",
            sequence: 0,
            sourceExcerptHash: `${title}-beat-hash`,
            beatJson: JSON.stringify({
              beatKey: "window-0",
              sourceExcerpt: "คืนงานศพ",
              subject: "an adult Thai human man",
              action: "stands beside a coffin",
              setting: "a rural Thai funeral at night",
              emotion: "dread",
              emphasis: "the mourner",
              hardSceneFacts: {
                entityTypes: ["adult Thai human man"], ages: ["adult"], genders: ["man"],
                actions: ["stands beside a coffin"], locationTypes: ["rural Thai funeral"],
                timeOfDay: "night", historicalPeriod: null, count: 1, essentialObjects: ["coffin"],
              },
              entityRefs: ["entity-kong"],
              sceneIntensity: "escalating tension",
              safetyBoundary: "none",
            }),
          },
        },
      },
      include: { visualBeats: true },
    });
    return { project, preflight };
  }

  const ready = await createReadyProject("Adaptive pin");
  const pin = await prepareProjectVisualPin({
    userId: user.id,
    projectId: ready.project.id,
    preflightId: ready.preflight.id,
  });
  const context = parseProjectVisualContext(pin.projectVisualContextJson);
  assert.equal(context?.treatmentPin?.presetId, "thai-supernatural-horror");
  assert.equal(context?.treatmentPin?.version, "v1.0.0");
  const pinnedProject = await prisma.editorProject.findUniqueOrThrow({ where: { id: ready.project.id } });
  assert.equal(pinnedProject.treatmentPresetId, "thai-supernatural-horror");
  assert.equal(pinnedProject.treatmentPresetVersion, "v1.0.0");
  assert.equal(pinnedProject.treatmentPinSource, "adaptive");
  const videoJob = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: ready.project.id,
      contentPreflightId: ready.preflight.id,
      projectVisualContextJson: pin.projectVisualContextJson,
      inputJson: "{}",
    },
  });
  const { resolveProjectVisualPromptForVideoScene } = await import("../src/lib/project-look.server");
  const scenePrompt = await resolveProjectVisualPromptForVideoScene({
    userId: user.id,
    videoJobId: videoJob.id,
    sceneIndex: 0,
  });
  assert.equal(scenePrompt?.compiled.treatmentPin?.presetId, "thai-supernatural-horror");
  assert.doesNotMatch(scenePrompt?.compiled.positive ?? "", /\bKong\b/i);
  assert.match(scenePrompt?.compiled.positive ?? "", /an adult Thai human man with short black hair/);

  await prisma.projectVisualBeat.update({
    where: { id: ready.preflight.visualBeats[0].id },
    data: { existingAssetUrl: "/api/renders/existing.webp" },
  });
  await assert.rejects(
    () => applyProjectLook({
      userId: user.id,
      projectId: ready.project.id,
      preflightId: ready.preflight.id,
      applyMode: "new-only" as never,
      look: {
        visualFormatId: "cinematic-realism",
        treatmentPresetId: "thai-human-drama",
      },
    }),
    (error: unknown) => error instanceof ProjectLookError
      && error.code === "LOOK_CHANGE_CONFIRMATION_REQUIRED",
    "a treatment change can never affect only future images",
  );
  await applyProjectLook({
    userId: user.id,
    projectId: ready.project.id,
    preflightId: ready.preflight.id,
    applyMode: "regenerate-all",
    look: {
      visualFormatId: "cinematic-realism",
      treatmentPresetId: "thai-human-drama",
    },
  });
  const changed = await prisma.editorProject.findUniqueOrThrow({ where: { id: ready.project.id } });
  assert.equal(changed.treatmentPresetId, "thai-human-drama");
  assert.equal((await prisma.projectVisualBeat.findUniqueOrThrow({
    where: { id: ready.preflight.visualBeats[0].id },
  })).status, "outdated");

  const repair = await createReadyProject("Repair placeholder");
  await prisma.editorProject.update({
    where: { id: repair.project.id },
    data: {
      projectLookJson: JSON.stringify({
        schemaVersion: 1,
        visualFormatId: "cinematic-realism",
        recipeVersion: "cinematic-realism-v3",
        treatment: GENERIC_TREATMENT_PLACEHOLDER,
        brandVisualLanguage: null,
      }),
      projectLookUpdatedAt: new Date(repair.preflight.createdAt.getTime() - 1_000),
    },
  });
  const repairJob = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: repair.project.id,
      contentPreflightId: repair.preflight.id,
      projectVisualContextJson: JSON.stringify({
        source: "project-look",
        visualFormatId: "cinematic-realism",
        recipeVersion: "cinematic-realism-v3",
        treatment: GENERIC_TREATMENT_PLACEHOLDER,
        brandVisualLanguage: null,
      }),
      inputJson: "{}",
    },
  });
  const repairedScenePrompt = await resolveProjectVisualPromptForVideoScene({
    userId: user.id,
    videoJobId: repairJob.id,
    sceneIndex: 0,
  });
  assert.equal(repairedScenePrompt?.compiled.treatmentPin?.presetId, "thai-supernatural-horror");
  assert.equal(
    parseProjectVisualContext((await prisma.videoJob.findUniqueOrThrow({ where: { id: repairJob.id } })).projectVisualContextJson)
      ?.treatmentPin?.source,
    "repair",
    "a proven historical race is repaired at the Scene Reroll boundary before compilation",
  );
  await prepareProjectVisualPin({
    userId: user.id,
    projectId: repair.project.id,
    preflightId: repair.preflight.id,
  });
  const repaired = await prisma.editorProject.findUniqueOrThrow({ where: { id: repair.project.id } });
  assert.equal(repaired.treatmentPresetId, "thai-supernatural-horror");
  assert.equal(repaired.treatmentPinSource, "repair");
  assert.equal(JSON.parse(repaired.projectLookJson!).visualFormatId, "cinematic-realism");

  const legacy = await createReadyProject("Legacy custom");
  await prisma.editorProject.update({
    where: { id: legacy.project.id },
    data: {
      projectLookJson: JSON.stringify({
        schemaVersion: 1,
        visualFormatId: "retro-story",
        recipeVersion: "retro-story-v3",
        treatment: "creator-authored sepia family memoir",
        brandVisualLanguage: null,
      }),
      projectLookUpdatedAt: new Date(legacy.preflight.createdAt.getTime() - 1_000),
    },
  });
  const legacyPin = await prepareProjectVisualPin({
    userId: user.id,
    projectId: legacy.project.id,
    preflightId: legacy.preflight.id,
  });
  const legacyContext = parseProjectVisualContext(legacyPin.projectVisualContextJson);
  assert.equal(legacyContext?.legacyCustomTreatment, true);
  assert.equal(legacyContext?.treatment, "creator-authored sepia family memoir");
  assert.equal(legacyContext?.treatmentPin, undefined);

  const stopped = await createReadyProject("Emergency stop unpinned");
  process.env.TREATMENT_EMERGENCY_STOP = "1";
  await assert.rejects(
    () => prepareProjectVisualPin({
      userId: user.id,
      projectId: stopped.project.id,
      preflightId: stopped.preflight.id,
    }),
    (error: unknown) => error instanceof ProjectLookError
      && error.code === "PREFLIGHT_INCOMPLETE",
    "the emergency stop rejects new unpinned AI work without a generic or engine fallback",
  );
  const completedPinRecovery = await prepareProjectVisualPin({
    userId: user.id,
    projectId: ready.project.id,
    preflightId: ready.preflight.id,
  });
  assert.equal(parseProjectVisualContext(completedPinRecovery.projectVisualContextJson)?.treatmentPin?.presetId, "thai-human-drama");
  assert.equal(await prisma.aiGenerationJob.count({ where: { userId: user.id } }), 0);
  delete process.env.TREATMENT_EMERGENCY_STOP;

  await prisma.$disconnect();
  console.log("verify-brand-treatment-project-pin-v1: PASS project pin, all-or-cancel change, targeted repair, legacy replay");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
