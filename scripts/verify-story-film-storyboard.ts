// Run with: npm run verify:story-film-storyboard
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentPreflightAnalyzer } from "../src/lib/content-preflight.server";

const testDir = mkdtempSync(join(tmpdir(), "story-film-storyboard-"));
process.env.DATABASE_URL = `file:${join(testDir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
function ok(condition: unknown, message: string) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`ok: ${message}`);
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const story = await import("../src/lib/story-film.server");
  const storyboard = await import("../src/lib/story-film-storyboard.server");
  try {
    const windows = storyboard.planStoryFilmTimedWindows({
      narrativeSource: "มิวเปิดประตูเข้าสู่ห้องทดลอง แล้วพบเครื่องจักรที่กำลังหมุน ก่อนเดินเข้าไปตรวจสอบแสงประหลาด",
      narrationDurationMs: 21_000,
      targetSceneDurationSec: 7,
    });
    ok(windows.length === 3, "Narration Master duration determines the storyboard scene count");
    ok(
      windows[0].startMs === 0
        && windows.at(-1)?.endMs === 21_000
        && windows.every((window, index) => index === 0 || window.startMs === windows[index - 1].endMs),
      "storyboard windows are contiguous and end exactly with the Narration Master",
    );
    ok(
      storyboard.planStoryFilmVisualOwners("faceless", 8).every((owner) => owner === "broll")
        && storyboard.planStoryFilmVisualOwners("presenter_led", 8).filter((owner) => owner === "presenter").length === 2,
      "Faceless stays all B-roll while Presenter-led reserves a deterministic 25 percent presenter rhythm",
    );

    const user = await prisma.user.create({
      data: { id: "storyboard-user", name: "Mew", email: "duckyhero@gmail.com", plan: "BUSINESS" },
    });
    const presenter = await story.registerStoryFilmPresenterAsset(user.id, {
      url: "/api/renders/story-film-storyboard-presenter.mp4",
      originalName: "presenter.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100_000,
      width: 1080,
      height: 1920,
      durationMs: 21_000,
    });
    const started = await story.startStoryFilm(user.id, {
      title: "Storyboard planner",
      idempotencyKey: "storyboard:planner:project:001",
      presentationMode: "presenter_led",
      presenterAssetId: presenter.id,
      narrativeSource: "Mew opens a laboratory door. Machinery rotates inside. Mew walks toward a mysterious light.",
      aspectRatio: "9:16",
    });
    const narration = await story.decideStoryFilm(user.id, {
      projectId: started.project.id,
      expectedStage: "setup",
      expectedRevision: 1,
      decision: "approve",
      idempotencyKey: "storyboard:planner:setup:001",
    });
    const review = await story.decideStoryFilm(user.id, {
      projectId: started.project.id,
      expectedStage: "narration",
      expectedRevision: narration.revision,
      decision: "approve",
      idempotencyKey: "storyboard:planner:narration:001",
    });
    const job = await prisma.storyFilmGenerationJob.findFirstOrThrow({
      where: { projectId: started.project.id, kind: "storyboard_plan" },
    });
    ok(
      review.stage === "storyboard" && job.providerBackend === "hero_text",
      "Narration approval creates one durable Hero text planner job",
    );
    await prisma.storyFilmGenerationJob.update({
      where: { id: job.id },
      data: {
        payloadJson: JSON.stringify({
          ...JSON.parse(job.payloadJson),
          videoSceneKeys: ["scene-01", "scene-03"],
        }),
      },
    });

    const fakeAnalyzer: ContentPreflightAnalyzer = {
      async analyze(input) {
        return {
          contentDomain: "cinematic technology mystery",
          dominantNarrativeMode: "a continuous discovery story",
          suggestedVisualFormatId: "cinematic-realism",
          rankedTreatmentPresetIds: ["practical-documentary", "modern-business-technology", "thai-human-drama"],
          treatmentRecommendationRationale: "Grounded cinematic discovery keeps the sequence coherent.",
          formatRecommendation: null,
          storyEntities: [{
            entityId: "mew",
            properName: "มิว",
            entityType: "person",
            durableAttributes: ["adult Thai creator", "recognizable face"],
            renderingDescription: "Mew, an adult Thai creator with a recognizable oval face and dark eyes",
            recurringCharacterDescription: "Mew, the same adult Thai creator with a recognizable oval face and dark eyes",
            isRealPerson: true,
          }],
          beats: input.windows.map((window, index) => ({
            beatKey: `window-${index}`,
            sourceExcerpt: window.text,
            startMs: window.startMs,
            endMs: window.endMs,
            subject: "Mew",
            action: index === 1 ? "Mew walks past rotating machinery" : "Mew studies a mysterious laboratory",
            setting: "a cinematic near-future laboratory",
            emotion: "focused curiosity",
            emphasis: "one readable discovery moment",
            hardSceneFacts: {
              entityTypes: ["person"], ages: ["adult"], genders: [],
              actions: ["investigates the laboratory"], locationTypes: ["laboratory"],
              timeOfDay: null, historicalPeriod: null, count: 1, essentialObjects: ["laboratory machinery"],
            },
            entityRefs: ["mew"],
            sceneIntensity: index === 1 ? "visible walking motion" : "quiet observation",
            safetyBoundary: "none" as const,
          })),
        };
      },
    };
    const document = await storyboard.planStoryFilmStoryboardJob(job.id, fakeAnalyzer);
    await storyboard.persistStoryFilmStoryboardScenes(document);
    ok(document.aspectRatio === "9:16" && document.narrationDurationMs === 21_000, "storyboard document pins the vertical master timeline");
    ok(
      document.scenes.filter((scene) => scene.visualOwner === "presenter").length === 1
        && document.scenes.filter((scene) => scene.visualOwner === "broll").length === 2,
      "presenter-led planning reserves about one quarter of the story for the uploaded presenter",
    );
    ok(document.scenes.some((scene) => scene.mediaPlan === "video"), "meaningful visible movement selects a video scene");
    ok(document.scenes.some((scene) => scene.mediaPlan === "image_with_motion"), "a strong static beat can remain an image with editorial motion");
    ok(
      document.scenes.filter((scene) => scene.mediaPlan === "video").map((scene) => scene.sceneKey).join(",")
        === "scene-01,scene-03",
      "an explicit reviewed video-scene plan overrides the heuristic without changing scene content",
    );
    ok(
      document.scenes.every((scene) => (
        !scene.grokPrompt.includes("Mew")
          && !scene.grokPrompt.includes("มิว")
          && scene.grokPrompt.includes("Vertical 9:16")
      )),
      "provider prompts use a safe actor description even when a real person's name crosses writing systems",
    );
    ok(
      document.scenes.every((scene) => scene.characterDirectives[0]?.entityId === "mew"),
      "internal entity links survive for the later character-reference adapter",
    );
    const storedScenes = await prisma.storyFilmScene.findMany({
      where: { projectId: started.project.id, generationEpoch: review.generationEpoch },
      orderBy: { sequence: "asc" },
    });
    ok(
      storedScenes.length === document.scenes.length
        && storedScenes.at(-1)?.endMs === 21_000
        && storedScenes.filter((scene) => scene.visualOwner === "presenter").length === 1,
      "the provider-neutral scene plan is stored durably for keyframe and video adapters",
    );
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => console.log(`\n${passed} Story Film storyboard checks passed`))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(testDir, { recursive: true, force: true }));
