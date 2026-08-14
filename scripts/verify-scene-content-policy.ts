import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileBrandVisualPrompt } from "../src/lib/brand-visual-system";
import {
  applySceneContentPolicy,
  sceneContentPolicyFromPreference,
  sceneContentPolicyPromptBlock,
} from "../src/lib/scene-content-policy";

const baseBeat = {
  beatKey: "window-0",
  sourceExcerpt: "A founder explains a better workflow in a coffee shop.",
  subject: "a founder and a laptop",
  action: "the founder points to one clear workflow on the laptop",
  setting: "a neighborhood coffee shop",
  emotion: "focused optimism",
  emphasis: "the practical workflow",
};

const thai = applySceneContentPolicy([baseBeat], "thai");
assert.equal(thai.warnings.length, 0);
assert.match(thai.beats[0].subject, /Thai or Southeast Asian/);
assert.match(thai.beats[0].setting, /Thai local context/);

const compiledThai = compileBrandVisualPrompt({
  visualFormatId: "stick-figure-story",
  contentDomain: "creator workflow",
  treatment: "clear and encouraging",
  visualBeat: { ...thai.beats[0], phase: "hook" },
});
assert.match(compiledThai.positive, /Thai or Southeast Asian/);
assert.match(compiledThai.positive, /Thai local context/);
assert.match(compiledThai.positive, /stick-figure/i);

const objectOnly = applySceneContentPolicy([{
  ...baseBeat,
  subject: "a red savings jar and three coins",
  action: "one coin rests beside the jar",
  setting: "a clean tabletop",
  emphasis: "the first saved coin",
  policyApplicability: "not-applicable" as const,
}], "thai");
assert.equal(objectOnly.beats[0].subject, "a red savings jar and three coins");
assert.equal(objectOnly.beats[0].setting, "a clean tabletop");
assert.doesNotMatch(objectOnly.beats[0].subject, /person|people|Thai/i);

const conflict = applySceneContentPolicy([{
  ...baseBeat,
  sourceExcerpt: "The story begins at Shibuya Crossing in Tokyo.",
  setting: "Shibuya Crossing in Tokyo at night",
  policyApplicability: "story-conflict" as const,
  policyConflict: "The source explicitly names Tokyo.",
}], "thai");
assert.equal(conflict.beats[0].setting, "Shibuya Crossing in Tokyo at night");
assert.equal(conflict.warnings.length, 1);
assert.match(conflict.warnings[0].message, /คงตามเนื้อหาเดิม/);

const noPeople = applySceneContentPolicy([baseBeat], "no-people");
assert.equal(noPeople.beats[0].policyFallbackApplied, true);
assert.doesNotMatch(
  [noPeople.beats[0].subject, noPeople.beats[0].action, noPeople.beats[0].setting, noPeople.beats[0].emphasis].join(" "),
  /\b(?:founder|person|people|man|woman|crowd|team)\b/i,
);
assert.match(noPeople.beats[0].subject, /objects|hands/);

assert.deepEqual(sceneContentPolicyFromPreference("auto"), {
  locale: "narrative",
  people: "narrative",
});
assert.deepEqual(sceneContentPolicyFromPreference("no-people"), {
  locale: "narrative",
  people: "avoid-visible-people",
});
assert.match(sceneContentPolicyPromptBlock(sceneContentPolicyFromPreference("thai")), /WHO and WHERE/);
assert.doesNotMatch(sceneContentPolicyPromptBlock(sceneContentPolicyFromPreference("thai")), /cinematic|documentary/i);

async function verifyWiring() {
  const directory = mkdtempSync(join(tmpdir(), "scene-content-policy-"));
  process.env.DATABASE_URL ||= `file:${join(directory, "test.db")}`;
  const { contentPreflightSourceHash } = await import("../src/lib/content-preflight.server");
  const narrative = "A founder explains one practical workflow.";
  const defaultHash = contentPreflightSourceHash("creator-script", narrative, { windowCount: 2 });
  const thaiHash = contentPreflightSourceHash("creator-script", narrative, {
    windowCount: 2,
    sceneContentPolicy: sceneContentPolicyFromPreference("thai"),
  });
  const noPeopleHash = contentPreflightSourceHash("creator-script", narrative, {
    windowCount: 2,
    sceneContentPolicy: sceneContentPolicyFromPreference("no-people"),
  });
  assert.notEqual(thaiHash, defaultHash, "changing people/location intent must invalidate the preflight identity");
  assert.notEqual(noPeopleHash, thaiHash, "different scene policies must never share generated assets");

  const selectorSource = readFileSync("src/app/(dashboard)/video-editor/_v2/BrandVisualSelector.tsx", "utf8");
  assert.match(selectorSource, /sceneContentPolicy:\s*sceneContentPolicyFromPreference\(p\.brollRegionPreference\)/);
  assert.match(selectorSource, /p\.brollRegionPreference, onPreflightStatusChange/);

  const jobsRouteSource = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
  assert.match(jobsRouteSource, /contentPreflightSourceHash\(kind, script,[\s\S]*?sceneContentPolicy/);
  assert.match(jobsRouteSource, /sceneContentPolicy,\s*\n\s*\.\.\.\(kieModel/);

  const stepTwoSource = readFileSync("src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx", "utf8");
  assert.match(stepTwoSource, />คนและสถานที่</);
  assert.match(stepTwoSource, /ใช้ Brand Visual ที่เลือกด้านบนเพียงจุดเดียว/);
  assert.doesNotMatch(stepTwoSource, />แนวภาพ \/ โซนภาพ</);

  console.log("verify-scene-content-policy: PASS policy → preflight → Brand Visual contract and UI clarity");
}

void verifyWiring().catch((error) => {
  console.error(error);
  process.exit(1);
});
