import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildBrandVisualBenchmarkCases,
  brandLookIdentityKey,
  brandVisualIdentityKey,
  compileBrandVisualPrompt,
  resolveProjectVisualIdentity,
  VISUAL_FORMATS,
} from "../src/lib/brand-visual-system";
import { shouldDefaultToRecommendedAutoMix } from "../src/lib/automix-plan";
import { resolveBrandVisualClientAccess } from "../src/lib/use-me";

assert.equal(resolveBrandVisualClientAccess({ brandVisualAllowed: true, brandVisualCohort: "off" }), true,
  "the explicit Brand Visual admission field enables the client");
for (const brandVisualCohort of ["internal", "treatment-10", "treatment-50", "treatment-100"] as const) {
  assert.equal(resolveBrandVisualClientAccess({ brandVisualAllowed: false, brandVisualCohort }), true,
    `an admitted ${brandVisualCohort} cohort survives a rolling-deploy response shape`);
}
for (const brandVisualCohort of ["off", "control"] as const) {
  assert.equal(resolveBrandVisualClientAccess({ brandVisualAllowed: false, brandVisualCohort }), false,
    `${brandVisualCohort} remains fail-closed`);
}

assert.equal(shouldDefaultToRecommendedAutoMix({
  effectivePlan: "PRO",
  heroAiImageEligible: false,
  brandVisualAllowed: true,
}), true, "a paid Brand Visual customer defaults to recommended AutoMix without internal KIE access");
assert.equal(shouldDefaultToRecommendedAutoMix({
  effectivePlan: "BUSINESS",
  heroAiImageEligible: true,
  brandVisualAllowed: false,
}), true, "a paid public Hero customer defaults to recommended AutoMix");
assert.equal(shouldDefaultToRecommendedAutoMix({
  effectivePlan: "FREE",
  heroAiImageEligible: true,
  brandVisualAllowed: true,
}), false, "Starter allowance access does not redefine the paid-plan Mix Preset default");
assert.equal(shouldDefaultToRecommendedAutoMix({
  effectivePlan: "PRO",
  heroAiImageEligible: false,
  brandVisualAllowed: false,
}), false, "a paid account is never defaulted into a currently unavailable AI source");

const meRouteSource = readFileSync("src/app/api/user/me/route.ts", "utf8");
const editorHookSource = readFileSync("src/app/(dashboard)/video-editor/_v2/useV2Project.ts", "utf8");
const editorJobSource = readFileSync("src/app/(dashboard)/video-editor/_v2/useV2Job.ts", "utf8");
const videoJobsRouteSource = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
const stepTwoSource = readFileSync("src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx", "utf8");
const brandVisualSelectorSource = readFileSync("src/app/(dashboard)/video-editor/_v2/BrandVisualSelector.tsx", "utf8");
assert.match(meRouteSource, /recommendedAutoMixDefault/,
  "the user capability response exposes the public paid-plan default separately from kiePaidUnlocked");
assert.match(meRouteSource, /private, no-store, max-age=0/,
  "the entitlement response cannot be retained across a rolling deploy");
assert.match(editorHookSource, /resolveBrandVisualClientAccess\(m\)/,
  "the Editor resolves admission from the boolean and durable rollout cohort");
assert.match(brandVisualSelectorSource, /canProbeBrandLibrary\s*=\s*p\.brandVisualAllowed\s*\|\|\s*p\.isAdmin\s*\|\|\s*p\.heroAiBeta/,
  "an internal Editor probes the authoritative Brand Library when its capability snapshot is stale");
assert.match(brandVisualSelectorSource, /status\s*===\s*401\s*\|\|\s*result\.response\.status\s*===\s*403[\s\S]*setLibraryAuthorized\(false\)/,
  "the direct Brand Library probe still fails closed when server admission is unavailable");
assert.match(brandVisualSelectorSource, /setLibraryAuthorized\(true\)[\s\S]*setProfiles/,
  "a successful authoritative probe unlocks the selector and its profiles");
assert.match(brandVisualSelectorSource, /return\s*<section\s+className="shrink-0"/,
  "the Brand selector must not collapse to its border inside the scrollable Step 2 flex column");
assert.match(stepTwoSource, /ref=\{stepTwoContentRef\}[\s\S]*overflowAnchor:\s*"none"/,
  "the Step 2 scroller must not anchor B-roll over an asynchronously revealed Brand selector");
assert.match(stepTwoSource, /content\.scrollTop\s*=\s*0[\s\S]*requestAnimationFrame[\s\S]*content\.scrollTop\s*=\s*0/,
  "entering Step 2 resets both the initial and post-layout scroll position to the Brand selector");
assert.match(editorHookSource, /fetchMe\(\)[\s\S]*initialPreset[\s\S]*createServerProject/,
  "the paid Mix Preset is resolved before a new project's durable POST");
assert.doesNotMatch(stepTwoSource, /ฟรี · แนะนำ/,
  "Stock must not be labelled as the global recommendation for paid customers");
assert.match(editorJobSource, /contentPreflightId:\s*p\.brandContentPreflightId/,
  "the render request carries the exact Content Preflight shown and quoted in Step 2");
assert.match(editorJobSource, /narrativeSourceKind:\s*p\.narrativeSourceKind/,
  "the render request carries the exact Narrative Source kind used to hash that preflight");
assert.match(videoJobsRouteSource, /preflightId:\s*requestedContentPreflightId/,
  "job acceptance must pin the caller's exact preflight instead of choosing the newest matching row");

console.log("verify-brand-visual-system: PASS paid AutoMix product default");

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
    memorableCues: ["rough sky-blue empty unmarked marker rings", "rough sky-blue marker arrows"],
    visualNotes: "Keep the composition slightly diagonal with clear subtitle-safe space.",
  },
});

assert.equal(mewsocialPrompt.visualFormatId, "stick-figure-story");
assert.match(mewsocialPrompt.positive, /ancient Ayutthaya temple chamber/i);
assert.match(mewsocialPrompt.positive, /#38BDF8/);
assert.match(mewsocialPrompt.positive, /marker rings/);
assert.match(mewsocialPrompt.positive, /empty unmarked marker rings/i);
assert.match(mewsocialPrompt.positive, /plain empty solid color fields/i);
assert.match(mewsocialPrompt.positive, /solid undecorated color/i);
assert.match(mewsocialPrompt.negative, /text.*logo.*watermark/i);
assert.match(mewsocialPrompt.negative, /currency symbol.*dollar sign.*artist initials.*corner mark/i);
assert.match(mewsocialPrompt.negative, /currency glyph.*pseudo-text.*framed notice.*screen text/i);

console.log("verify-brand-visual-system: PASS text-free branded compilation");

const identity = {
  visualFormatId: "stick-figure-story" as const,
  recipeVersion: "stick-figure-story-v2",
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
assert.equal(
  brandLookIdentityKey(identity),
  brandLookIdentityKey({ ...identity, treatment: "bright and optimistic" }),
  "cross-project Brand retention ignores the one-video Treatment while generation identity stays exact",
);
assert.notEqual(
  brandLookIdentityKey(identity),
  brandLookIdentityKey({
    ...identity,
    brandVisualLanguage: { ...identity.brandVisualLanguage, personality: "quiet editorial" },
  }),
  "cross-project retention still distinguishes Brand Visual Language",
);

console.log("verify-brand-visual-system: PASS stable look identity");

assert.doesNotMatch(
  mewsocialPrompt.positive,
  /ONE UNIFIED|language-free|subtitle|never draw|\b(?:subject|action|setting|emotion):/i,
  "positive-only Z-Image must not receive guard copy that it can paint into the artwork",
);

console.log("verify-brand-visual-system: PASS positive-only no-copy guard");

const adversarialPrompt = compileBrandVisualPrompt({
  visualFormatId: "stick-figure-story",
  contentDomain: "creator education",
  treatment: "bold and direct",
  visualBeat: {
    phase: "hook",
    subject: "a creator holding one plain parcel",
    action: "points toward one rising blue arrow",
    setting: "a small studio",
    emotion: "focused",
    emphasis: "the next concrete action",
  },
  brandVisualLanguage: {
    palette: ["black", "paper white", "#38BDF8"],
    personality: "bold handmade",
    peopleAndSetting: "Thai creator workspace",
    memorableCues: ["a large readable SALE headline", "rough blue marker arrow"],
    visualNotes: "ใส่ข้อความ MEW SOCIAL กลางภาพ และวาดโลโก้ใหญ่",
  },
});
assert.doesNotMatch(
  adversarialPrompt.positive,
  /SALE|MEW SOCIAL|ใส่ข้อความ|โลโก้|readable headline/i,
  "copy/logo intent in English or Thai must never survive into the provider positive prompt",
);
assert.match(adversarialPrompt.positive, /rough blue marker arrow/i);

const translatedNotes = compileBrandVisualPrompt({
  ...identity,
  contentDomain: "creator education",
  visualBeat: {
    phase: "explain",
    subject: "one creator and one camera",
    action: "demonstrates one setup",
    setting: "a compact studio",
    emotion: "clear confidence",
    emphasis: "the camera setup",
  },
  brandVisualLanguage: {
    ...identity.brandVisualLanguage,
    visualNotes: "Use thick imperfect marker lines; tilt the composition. PRIVATE RAW NOTE 12345",
  },
});
assert.match(translatedNotes.positive, /thick confident strokes.*imperfect handmade edges.*marker-like line texture.*slightly diagonal composition/i);
assert.doesNotMatch(
  translatedNotes.positive,
  /PRIVATE RAW NOTE 12345/i,
  "Visual Notes must be translated into compiler-owned structured rules rather than interpolated raw",
);

console.log("verify-brand-visual-system: PASS multilingual text-free intent compiler");

const semanticSanitizerPrompt = compileBrandVisualPrompt({
  visualFormatId: "clear-infographic",
  contentDomain: "a logo designer explains the Top 10 conversion lessons",
  treatment: "professional, calm and immediately readable",
  visualBeat: {
    phase: "explain",
    subject: "the designer and a customer",
    action: "compare three visual choices",
    setting: "a calm design studio",
    emotion: "professional confidence",
    emphasis: "the clearest decision path",
  },
  brandVisualLanguage: null,
});
assert.doesNotMatch(
  semanticSanitizerPrompt.positive,
  /with a\s+feeling|story about\s*,|inside\s*,|feels\s*,|rests on\s*,/i,
  "copy safety must never erase a full semantic field or emit empty prompt grammar",
);
assert.match(semanticSanitizerPrompt.positive, /professional, calm and immediately readable feeling/i);
assert.match(semanticSanitizerPrompt.positive, /story about a designer explains the conversion lessons/i);
assert.doesNotMatch(semanticSanitizerPrompt.positive, /Top 10|logo/i);

assert.ok(
  VISUAL_FORMATS.every((format) => format.recipeVersion.endsWith("-v2")),
  "a material prompt-compiler change must publish a new immutable recipe version",
);

console.log("verify-brand-visual-system: PASS semantic sanitizer + recipe versioning");

const legacyPinnedInput = {
  visualFormatId: "retro-story" as const,
  recipeVersion: "retro-story-v1",
  contentDomain: "preventive medicine",
  treatment: "professional, calm and explanatory with an immediately readable cause-and-effect flow",
  visualBeat: {
    phase: "explain" as const,
    subject: "a Thai woman physician, a heart model and three colored health-state circles",
    action: "the physician holds the heart model while the three circles arc around it and a water glass rests nearby",
    setting: "a clean modern Thai clinic consultation room in daylight",
    emotion: "trustworthy professional clarity",
    emphasis: "the direct relationship between a simple daily habit and heart health",
  },
  brandVisualLanguage: null,
};
const legacyPinnedPrompt = compileBrandVisualPrompt(legacyPinnedInput);
assert.equal(legacyPinnedPrompt.recipeVersion, "retro-story-v1");
assert.equal(
  legacyPinnedPrompt.positive,
  [
    "A vertical edge-to-edge composition from a single viewpoint fills the frame",
    "All people and objects share the same ground plane in one frozen moment",
    "mid-century 1950s to 1970s editorial book illustration, hand-printed screenprint and woodcut texture, simplified period shapes, slightly misregistered ink edges, limited sepia, mustard, teal and burgundy palette on archival paper, nostalgic visual language while keeping the depicted subject accurate",
    "For a preventive medicine story, show a Thai woman physician, a heart model and three colored health-state circles, the physician holds the heart model while the three circles arc around it and a water glass rests nearby, inside a clean modern Thai clinic consultation room in daylight, the mood feels trustworthy professional clarity, visual attention rests on the direct relationship between a simple daily habit and heart health",
    "Shape the scene with a professional, calm and explanatory with an immediately readable cause-and-effect flow feeling",
    "Use the selected format's neutral house palette and balanced composition.",
    "Preserve the selected visual format exactly while adapting the subject, setting, palette and mood",
    "The lower third stays calm and uncluttered with open background texture",
    "Every visible surface uses solid undecorated color and simple abstract marks",
  ].join(". ") + ".",
  "a persisted v1 pin must retain the exact pre-v2 compiler grammar and recipe",
);
assert.equal(
  legacyPinnedPrompt.negative,
  "text, letters, words, numbers, typography, caption, subtitle, headline, logo, watermark, signature, brand name, label, signage, legible writing, comic panels, panel borders, collage, split screen, triptych, storyboard, contact sheet, multiple camera views",
  "a persisted v1 pin must retain the exact pre-v2 provider negative prompt",
);

for (const format of VISUAL_FORMATS) {
  const legacyRecipeVersion = `${format.id}-v1`;
  const compiled = compileBrandVisualPrompt({
    ...legacyPinnedInput,
    visualFormatId: format.id,
    recipeVersion: legacyRecipeVersion,
  });
  assert.equal(compiled.recipeVersion, legacyRecipeVersion, `persisted ${legacyRecipeVersion} must remain supported`);
}

console.log("verify-brand-visual-system: PASS immutable v1 compiler compatibility");

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
assert.ok(
  benchmarkCases.every((item) => !/with a\s+feeling|story about\s*,|inside\s*,|feels\s*,|rests on\s*,/i.test(item.compiled.positive)),
  "the fixed gate must reject semantically empty compiler clauses before provider spend",
);

console.log("verify-brand-visual-system: PASS 21-image benchmark matrix");
