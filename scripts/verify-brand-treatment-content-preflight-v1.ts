import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "brand-treatment-preflight-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const {
    ContentPreflightError,
    createGeminiContentPreflightAnalyzer,
    resolveContentPreflight,
  } = await import("../src/lib/content-preflight.server");

  const user = await prisma.user.create({
    data: {
      name: "Preflight V1",
      email: "brand-treatment-preflight@example.test",
      plan: "PRO",
      geminiKey: "test-key",
    },
  });
  const project = await prisma.editorProject.create({
    data: { userId: user.id, title: "Kong funeral" },
  });

  const analysis = {
    contentDomain: "Thai supernatural family story",
    dominantNarrativeMode: "a continuing supernatural funeral narrative",
    suggestedVisualFormatId: "cinematic-realism",
    rankedTreatmentPresetIds: [
      "thai-supernatural-horror",
      "thai-human-drama",
      "thai-history-period-storytelling",
    ],
    treatmentRecommendationRationale: "The supernatural event continues across the whole narrative.",
    formatRecommendation: {
      visualFormatId: "dramatic-comic",
      reason: "ภาพคอมิกช่วยขับจังหวะความกลัวได้ชัดขึ้น แต่รูปแบบเดิมยังใช้ได้",
    },
    storyEntities: [{
      entityId: "entity-kong",
      properName: "Kong",
      entityType: "person",
      durableAttributes: ["adult", "Thai", "man", "short black hair"],
      renderingDescription: "an adult Thai human man with short black hair",
      recurringCharacterDescription: null,
      isRealPerson: false,
    }],
    beats: [{
      beatKey: "window-0",
      sourceExcerpt: "ก้องยืนอยู่ในงานศพตอนกลางคืน",
      subject: "the recurring adult Thai human man",
      action: "stands beside the coffin",
      setting: "a rural Thai funeral pavilion at night",
      emotion: "growing supernatural dread",
      emphasis: "the human mourner sensing a presence behind him",
      hardSceneFacts: {
        entityTypes: ["adult Thai human man"],
        ages: ["adult"],
        genders: ["man"],
        actions: ["stands beside the coffin"],
        locationTypes: ["rural Thai funeral pavilion"],
        timeOfDay: "night",
        historicalPeriod: null,
        count: 1,
        essentialObjects: ["coffin"],
      },
      entityRefs: ["entity-kong"],
      sceneIntensity: "escalating tension",
      safetyBoundary: "none",
    }],
  } as const;

  let capturedPrompt = "";
  const productionAdapter = createGeminiContentPreflightAnalyzer(
    user.id,
    async (_key, prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify(analysis);
    },
  );
  await productionAdapter.analyze({
    kind: "creator-script",
    text: "ก้องยืนอยู่ในงานศพตอนกลางคืน",
    windows: [{ text: "ก้องยืนอยู่ในงานศพตอนกลางคืน" }],
  });
  assert.match(capturedPrompt, /Dominant Narrative Mode governing the whole Narrative Source/);
  assert.match(capturedPrompt, /Never choose from one keyword, quotation, example or isolated metaphor/);
  assert.match(
    capturedPrompt,
    /When Hard Scene Facts specify an exact count, every flexible field must describe that same counted set/i,
  );
  assert.match(
    capturedPrompt,
    /State visible quantities inside each essentialObjects value when the source establishes them/i,
  );
  assert.match(
    capturedPrompt,
    /Use hardSceneFacts\.count only for one homogeneous counted entity set/i,
  );
  assert.match(
    capturedPrompt,
    /objects with different quantities in essentialObjects/i,
  );
  assert.match(
    capturedPrompt,
    /Preserve the complete source-to-target action relationship inside Hard Scene Facts/i,
  );
  assert.match(
    capturedPrompt,
    /shared ownership, physical contact, direction and destination/i,
  );
  assert.match(
    capturedPrompt,
    /stage the subject after verification with hands resting away from the mechanism/i,
  );
  assert.match(
    capturedPrompt,
    /When the source does not explicitly require readable wording, express choices, workflow and evidence through blank physical objects and spatial relationships/i,
  );
  assert.match(capturedPrompt, /properName is an internal linkage key only/);
  assert.match(capturedPrompt, /never rely on negation such as 'not a gorilla'/);
  assert.match(capturedPrompt, /Hard Scene Facts/);
  assert.match(capturedPrompt, /medical-illustration/);
  assert.match(capturedPrompt, /real-person-context-only/);
  assert.match(capturedPrompt, /simple-editorial-story/);
  assert.doesNotMatch(capturedPrompt, /stick-figure-story/,
    "Content Preflight cannot recommend the retired legacy format for new work");

  const preflight = await resolveContentPreflight({
    userId: user.id,
    projectId: project.id,
    narrativeSource: {
      kind: "creator-script",
      text: "ก้องยืนอยู่ในงานศพตอนกลางคืน",
      windowCount: 1,
    },
    analyzer: { analyze: async () => analysis as never },
  });

  assert.equal(preflight.dominantNarrativeMode, analysis.dominantNarrativeMode);
  assert.deepEqual(preflight.rankedTreatmentPresetIds, analysis.rankedTreatmentPresetIds);
  assert.equal(preflight.suggestedTreatment.presetId, "thai-supernatural-horror");
  assert.match(preflight.suggestedTreatment.version, /^v1\./);
  assert.equal(preflight.suggestedTreatment.label, "หนังผีไทย");
  assert.deepEqual(preflight.storyEntities, analysis.storyEntities);
  assert.deepEqual(preflight.visualBeats[0].entityRefs, ["entity-kong"]);
  assert.equal(preflight.visualBeats[0].hardSceneFacts.timeOfDay, "night");
  assert.equal(preflight.visualBeats[0].sceneIntensity, "escalating tension");
  assert.equal(preflight.formatRecommendation?.visualFormatId, "dramatic-comic");

  const unsafeProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Unsafe real-person depiction" },
  });
  await assert.rejects(
    () => resolveContentPreflight({
      userId: user.id,
      projectId: unsafeProject.id,
      narrativeSource: { kind: "creator-script", text: "ข่าวกล่าวหาบุคคลจริง", windowCount: 1 },
      analyzer: {
        analyze: async () => ({
          ...analysis,
          storyEntities: [{ ...analysis.storyEntities[0], entityId: "real-1", isRealPerson: true }],
          beats: [{ ...analysis.beats[0], entityRefs: ["real-1"], safetyBoundary: "real-person-context-only" }],
        }) as never,
      },
    }),
    (error: unknown) => error instanceof ContentPreflightError && error.code === "INVALID_ANALYSIS",
    "a real person cannot be linked into generated criminal/victim conduct imagery",
  );

  const leakedNameProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Provider prompt proper-name leak" },
  });
  await assert.rejects(
    () => resolveContentPreflight({
      userId: user.id,
      projectId: leakedNameProject.id,
      narrativeSource: { kind: "creator-script", text: "ก้องกลับมาที่งานศพ", windowCount: 1 },
      analyzer: {
        analyze: async () => ({
          ...analysis,
          beats: [{
            ...analysis.beats[0],
            subject: "the adult Thai human man stands beside the coffin",
            hardSceneFacts: {
              ...analysis.beats[0].hardSceneFacts,
              entityTypes: ["Kong"],
            },
            entityRefs: [],
          }],
        }) as never,
      },
    }),
    (error: unknown) => error instanceof ContentPreflightError && error.code === "INVALID_ANALYSIS",
    "a proper name must not leak through provider-facing hard facts even when the model omitted entityRefs",
  );

  const blockingFormatProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Non-blocking format guidance" },
  });
  await assert.rejects(
    () => resolveContentPreflight({
      userId: user.id,
      projectId: blockingFormatProject.id,
      narrativeSource: { kind: "creator-script", text: "คำแนะนำรูปแบบภาพ", windowCount: 1 },
      analyzer: {
        analyze: async () => ({
          ...analysis,
          formatRecommendation: {
            visualFormatId: "dramatic-comic",
            reason: "The inherited format conflicts with this story.",
          },
        }) as never,
      },
    }),
    (error: unknown) => error instanceof ContentPreflightError && error.code === "INVALID_ANALYSIS",
    "format guidance must never carry blocking conflict language",
  );

  await prisma.$disconnect();
  console.log("verify-brand-treatment-content-preflight-v1: PASS one structured plan, entities, hard facts, safety boundaries");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
