import assert from "node:assert/strict";
import {
  buildBrandVisualBenchmarkCases,
  brandVisualIdentityKey,
  compileBrandVisualPrompt,
  resolveProjectVisualIdentity,
  VISUAL_FORMATS,
} from "../src/lib/brand-visual-system";

assert.deepEqual(
  VISUAL_FORMATS.map(({ id, label }) => ({ id, label })),
  [
    { id: "cinematic-realism", label: "ภาพสมจริงแบบหนัง" },
    { id: "stick-figure-story", label: "ก้างปลาเล่าเรื่อง" },
    { id: "dramatic-comic", label: "คอมิกเข้มข้น" },
    { id: "clear-infographic", label: "อินโฟกราฟิกเข้าใจง่าย" },
    { id: "retro-story", label: "เล่าเรื่องย้อนยุค" },
  ],
  "the public catalog must expose exactly the five approved V1 looks",
);

console.log("verify-brand-visual-system: PASS catalog");

assert.equal(
  resolveProjectVisualIdentity({
    projectLook: { visualFormatId: "dramatic-comic", recipeVersion: "comic-v1" },
    brandRevision: { visualFormatId: "stick-figure-story", recipeVersion: "stick-v1" },
    suggested: { visualFormatId: "cinematic-realism", recipeVersion: "cinematic-v1" },
  }).visualFormatId,
  "dramatic-comic",
  "an explicit Project Look must outrank both the Brand Profile Revision and AI suggestion",
);

console.log("verify-brand-visual-system: PASS creator precedence");

const mewsocialPrompt = compileBrandVisualPrompt({
  visualFormatId: "stick-figure-story",
  contentDomain: "history",
  treatment: "mysterious and suspenseful",
  visualBeat: {
    phase: "hook",
    subject: "a Thai archaeologist and a sealed stone doorway",
    action: "the archaeologist reaches toward the newly uncovered doorway",
    setting: "an ancient Ayutthaya temple chamber at night",
    emotion: "curiosity mixed with danger",
    emphasis: "the discovery behind the doorway",
  },
  brandVisualLanguage: {
    palette: ["high-contrast black", "warm white", "sky blue #38BDF8"],
    personality: "bold, raw and energetic",
    peopleAndSetting: "simple expressive stick figures in Thai contexts",
    memorableCues: ["rough sky-blue marker circles", "rough sky-blue marker arrows"],
    visualNotes: "Keep the composition slightly diagonal with clear subtitle-safe space.",
  },
});

assert.equal(mewsocialPrompt.visualFormatId, "stick-figure-story");
assert.match(mewsocialPrompt.positive, /ancient Ayutthaya temple chamber/i);
assert.match(mewsocialPrompt.positive, /#38BDF8/);
assert.match(mewsocialPrompt.positive, /marker circles/);
assert.match(mewsocialPrompt.positive, /solid undecorated color/i);
assert.match(mewsocialPrompt.negative, /text.*logo.*watermark/i);

console.log("verify-brand-visual-system: PASS text-free branded compilation");

const identity = {
  visualFormatId: "stick-figure-story" as const,
  recipeVersion: "stick-figure-story-v1",
  treatment: "mysterious and suspenseful",
  brandVisualLanguage: {
    palette: ["black", "white", "#38BDF8"],
    personality: "bold",
    peopleAndSetting: "Thai creator contexts",
    memorableCues: ["blue arrow"],
    visualNotes: "rough marker",
  },
};
assert.equal(
  brandVisualIdentityKey(identity),
  brandVisualIdentityKey({ ...identity, brandVisualLanguage: { ...identity.brandVisualLanguage } }),
  "the same resolved look must keep one analytics identity across projects",
);
assert.notEqual(
  brandVisualIdentityKey(identity),
  brandVisualIdentityKey({ ...identity, treatment: "bright and optimistic" }),
  "a materially different look must not count as reuse",
);

console.log("verify-brand-visual-system: PASS stable look identity");

assert.doesNotMatch(
  mewsocialPrompt.positive,
  /ONE UNIFIED|language-free|subtitle|never draw|\b(?:subject|action|setting|emotion):/i,
  "positive-only Z-Image must not receive guard copy that it can paint into the artwork",
);

console.log("verify-brand-visual-system: PASS positive-only no-copy guard");

const benchmarkCases = buildBrandVisualBenchmarkCases();
assert.equal(benchmarkCases.length, 21, "the pre-UI gate must contain exactly 21 images");
assert.equal(
  benchmarkCases.filter((item) => item.benchmark === "visual-format").length,
  15,
  "five Visual Formats must receive the same three scenes",
);
assert.equal(
  benchmarkCases.filter((item) => item.benchmark === "brand-differentiation").length,
  6,
  "Mewsocial and control must each receive the same three stick-figure scenes",
);
assert.deepEqual(
  [...new Set(benchmarkCases.map((item) => item.sceneId))].sort(),
  ["close", "explain", "hook"],
);
assert.ok(
  benchmarkCases.every((item) => /same ground plane in one frozen moment/i.test(item.compiled.positive)),
  "every benchmark prompt must keep its subjects in one spatially continuous moment",
);

console.log("verify-brand-visual-system: PASS 21-image benchmark matrix");
