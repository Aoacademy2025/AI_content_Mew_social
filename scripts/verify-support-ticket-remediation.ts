import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  generateContentWithRelevanceRetry,
  type GeneratedContentPayload,
} from "../src/lib/content-generation-quality";
import { buildContentGenerationPrompt } from "../src/lib/prompts/content-generator";
import { audioDurationLimitViolation } from "../src/lib/plan-limits";
import { resolveSceneRerollCapability } from "../src/lib/scene-reroll-capability";

const read = (path: string) => readFileSync(path, "utf8");

const editorShell = read("src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx");
const videoJobRoute = read("src/app/api/videos/jobs/[id]/route.ts");
assert.doesNotMatch(
  editorShell,
  /sceneRerollEnabled=\{p\.heroAiImageEligible\s*\|\|/,
  "account eligibility alone must not expose Scene Reroll on a legacy job",
);
assert.match(
  editorShell,
  /sceneRerollCapability\?\.available === true/,
  "the editor must use the job-specific Scene Reroll capability",
);
assert.match(
  videoJobRoute,
  /sceneRerollCapability:/,
  "the job poll must expose an authoritative Scene Reroll capability",
);

const stepOne = read("src/app/(dashboard)/video-editor/_v2/Step1Script.tsx");
assert.match(
  stepOne,
  /clipDurationViolation/,
  "uploaded clips must be checked against the account plan before Step 2",
);
assert.match(
  stepOne,
  /ctaDisabled[\s\S]+clipDurationViolation/,
  "an over-plan clip must disable the primary CTA",
);

const transcribeRoute = read("src/app/api/videos/transcribe/route.ts");
assert.match(
  transcribeRoute,
  /planTranscriptionRecoveryBoundaries/,
  "a persistently incomplete long-audio chunk must be adaptively re-sliced",
);

const legacyBrandRoute = read("src/app/api/brand-profiles/[id]/route.ts");
assert.match(
  legacyBrandRoute,
  /archiveBrandProfile/,
  "Hero Script deletion must use the shared recoverable Brand archive seam",
);
assert.doesNotMatch(
  legacyBrandRoute,
  /prisma\.brandProfile\.deleteMany/,
  "Hero Script must not hard-delete a legacy Brand while Brand Library archives it",
);

const contentPage = read("src/app/(dashboard)/content/page.tsx");
const contentRoute = read("src/app/api/contents/generate/route.ts");
assert.match(contentPage, /inputMode/, "Content UI must distinguish a topic/brief from source material");
assert.match(
  contentRoute,
  /generateContentWithRelevanceRetry/,
  "Content generation must reject and retry a structurally valid but off-topic result",
);

const legacyCapability = resolveSceneRerollCapability({
  projectId: "project-1",
  contentPreflightId: null,
  hasProjectVisualContext: false,
});
assert.equal(legacyCapability.available, false, "a paid legacy job remains unavailable without its visual pin");
assert.equal(resolveSceneRerollCapability({
  projectId: "project-1",
  contentPreflightId: "preflight-1",
  hasProjectVisualContext: true,
}).available, true, "a fully pinned job exposes Scene Reroll");

assert.equal(audioDurationLimitViolation(360_000, "PRO"), null, "a six-minute Pro clip is accepted");
assert.equal(
  audioDurationLimitViolation(361_000, "PRO")?.neededPlan,
  "BUSINESS",
  "an over-six-minute Pro clip is blocked with the correct next action",
);

function providerJson(content: GeneratedContentPayload): string {
  return JSON.stringify(content);
}

async function verifyContentRetry(): Promise<void> {
  const topic = "วิธีปลูกมะเขือเทศให้ออกผลดีในพื้นที่เล็ก";
  const topicPrompt = buildContentGenerationPrompt({
    language: "TH",
    imageModel: "nanobanana",
    videoDuration: 60,
    inputText: topic,
    inputMode: "topic",
  });
  assert.match(topicPrompt, /Topic \/ Creative Brief/, "the topic path has an explicit prompt contract");

  const responses = [
    providerJson({
      headline: "เริ่มลงทุนคริปโตวันนี้",
      subHeadline: "ทำความเข้าใจกราฟราคาและความเสี่ยงก่อนซื้อเหรียญ",
      content: "คริปโตเป็นสินทรัพย์ดิจิทัลที่มีความผันผวนสูง ควรวางแผนการลงทุน",
      hashtags: "#คริปโต #ลงทุน #Bitcoin #การเงิน #สินทรัพย์ #มือใหม่",
      imagePrompt: "A cryptocurrency trading screen",
      visualNotes: "Show trading charts and digital coins.",
    }),
    providerJson({
      headline: "ปลูกมะเขือเทศในพื้นที่เล็กให้ออกผลดี",
      subHeadline: "เลือกกระถาง แสง และน้ำให้เหมาะเพื่อเก็บมะเขือเทศสดได้ที่บ้าน",
      content: "วิธีปลูกมะเขือเทศเริ่มจากกระถางระบายน้ำดี วางในพื้นที่เล็กที่ได้รับแสง และรดน้ำสม่ำเสมอเพื่อให้ออกผลดี",
      hashtags: "#ปลูกมะเขือเทศ #สวนครัว #พื้นที่เล็ก #ปลูกผัก #มะเขือเทศ #เกษตร",
      imagePrompt: "Tomato plants growing in containers on a small balcony",
      visualNotes: "Show the pot, sunlight, watering, and ripe tomatoes.",
    }),
  ];
  let calls = 0;
  const result = await generateContentWithRelevanceRetry({
    basePrompt: topicPrompt,
    inputText: topic,
    inputMode: "topic",
    generate: async () => responses[calls++],
  });
  assert.equal(result.ok, true, "an off-topic first answer is recovered instead of returned");
  assert.equal(calls, 2, "semantic drift triggers exactly one bounded retry");
  if (result.ok) assert.match(result.content.headline, /มะเขือเทศ/);
}

verifyContentRetry()
  .then(() => console.log("verify-support-ticket-remediation: PASS all four support-ticket contracts"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
