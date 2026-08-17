import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildBrandVisualBenchmarkCases,
  brandLookIdentityKey,
  brandVisualIdentityKey,
  compileBrandVisualPrompt,
  resolveProjectVisualIdentity,
  SUPPORTED_VISUAL_FORMATS,
  VISUAL_FORMATS,
} from "../src/lib/brand-visual-system";
import { shouldDefaultToRecommendedAutoMix } from "../src/lib/automix-plan";
import { resolveBrandVisualClientAccess } from "../src/lib/use-me";
import { AI_IMAGE_MODELS } from "../src/lib/ai-image-policy";

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
    { id: "simple-editorial-story", label: "ภาพวาดเล่าเรื่องเรียบง่าย" },
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
  visualFormatId: "simple-editorial-story",
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

assert.equal(mewsocialPrompt.visualFormatId, "simple-editorial-story");
assert.equal(mewsocialPrompt.recipeVersion, "simple-editorial-story-v11",
  "an unpinned compile publishes on the current story-first recipe");
assert.match(mewsocialPrompt.positive, /ancient Ayutthaya temple chamber/i);
assert.doesNotMatch(mewsocialPrompt.positive, /#/,
  "Z-Image renders a raw hex code as a colored object, so a palette must reach it as words");
assert.match(
  mewsocialPrompt.positive,
  /The overall color grade favors high-contrast black, warm white and sky blue/,
  "a palette entry that is already words passes through, minus the code, as a color grade",
);
assert.doesNotMatch(
  mewsocialPrompt.positive,
  /marker rings|Repeat the visual cues|People and places follow/i,
  "v3 drops the memorable-cue and people/setting clauses that outranked the Visual Beat",
);
assert.doesNotMatch(
  mewsocialPrompt.positive,
  /plain empty solid color fields|circular motif|solid unmarked disc/i,
  "the anti-text guardrails that painted walls and discs are negative-prompt work only",
);
assert.match(mewsocialPrompt.positive, /solid undecorated color/i);

/** ADR 0007 rewrote what the v3 negative may say. It no longer bans text as
 * such — English is permitted, including full sentences, and characters
 * intrinsic to a depicted object (a banknote denomination, a coin face, a price
 * tag, a control's own label) belong to the object. Three families remain: a
 * mark that impersonates a deterministically-ours layer, a frame that is not one
 * frame, and script the model cannot spell. */
assert.match(
  mewsocialPrompt.negative,
  /caption, subtitle, headline, logo, watermark, signature, brand name/,
  "the v3 negative still refuses every mark that impersonates a deterministic overlay layer",
);
assert.match(
  mewsocialPrompt.negative,
  /pseudo-text, gibberish text, Thai writing, Chinese writing, Japanese writing/,
  "ADR 0007: Thai script stays out, and the garbling it produces is still named",
);
assert.match(
  mewsocialPrompt.negative,
  /comic panels, panel borders, collage, split screen, triptych, storyboard, contact sheet, multiple camera views/,
  "the v3 negative still refuses a frame that is not one frame",
);
assert.doesNotMatch(
  mewsocialPrompt.negative,
  /(?:^|, )(?:text|letters|words|numbers|typography|label|signage|legible writing|screen text|written interface)(?:,|$)/,
  "ADR 0007: English and object-intrinsic characters are permitted, so none of these may be banned",
);
assert.doesNotMatch(
  mewsocialPrompt.negative,
  /currency symbol|dollar sign|baht sign|currency glyph|monetary icon|symbol inside circle/,
  "ADR 0007 decision 1: a denomination, a coin face and a price tag are part of the object",
);
assert.doesNotMatch(
  mewsocialPrompt.negative,
  /framed notice|wall chart|\bdocument\b|certificate/,
  "banning an object is scene control, which ADR 0006 gives to the Visual Beat, not to a rendering recipe",
);

console.log("verify-brand-visual-system: PASS ADR 0007 branded compilation");

/** Every encoding a color code can arrive in, restated here on purpose: the
 * library's own token list must not be able to narrow what this suite accepts. */
const ANY_COLOR_CODE = /[#＃]|%23|0x[0-9a-fA-F]{3}|(?:rgba?|hsla?)\s*\(/i;

/** ADR 0006: a Brand Profile controls how the frame is rendered, never what is
 * in it. The storm beat is the exact production failure Mew reported. */
const STORM_BEAT = {
  phase: "hook" as const,
  subject: "a towering cyclone wall",
  action: "the cyclone advances over the water toward the shore",
  setting: "an open coastal town",
  emotion: "awe mixed with dread",
  emphasis: "the scale of the approaching storm",
};
const STORM_BRAND = {
  palette: ["#111111", "#F8F5EE", "#38BDF8"],
  personality: "bold, raw, energetic and direct",
  peopleAndSetting: "ทีมงานในออฟฟิศ",
  memorableCues: ["วงกลมฟ้า", "ลูกศร marker"],
  visualNotes: "Use thick imperfect marker lines and tilt the composition slightly.",
};
for (const format of VISUAL_FORMATS) {
  const storm = compileBrandVisualPrompt({
    visualFormatId: format.id,
    contentDomain: "extreme weather",
    treatment: "urgent and cinematic",
    visualBeat: STORM_BEAT,
    brandVisualLanguage: STORM_BRAND,
  });
  const expectedRecipe = format.id === "simple-editorial-story"
    ? `${format.id}-v11`
    : `${format.id}-v9`;
  assert.equal(storm.recipeVersion, expectedRecipe, `${format.id} must compile on its current pinned recipe`);
  assert.match(storm.positive, /a towering cyclone wall/, "the beat's subject survives the brand");
  assert.match(storm.positive, /set in an open coastal town/, "the beat's setting survives the brand");
  assert.doesNotMatch(storm.positive, /ออฟฟิศ|office|ทีมงาน/i,
    "a brand's habitual people and place can never replace the beat's own setting");
  assert.doesNotMatch(storm.positive, /วงกลม|circular motif|unmarked ring|unmarked disc|visual cues/i,
    "no brand cue may re-introduce a circle prop");
  assert.doesNotMatch(storm.positive, ANY_COLOR_CODE, "no color code may reach the provider on any format");
  assert.doesNotMatch(storm.positive, /plain empty solid color fields/i);
  assert.match(storm.positive, /The overall color grade favors black, warm off-white and cool sky blue/,
    "every format grades from the same brand palette words");
}

const stormCinematic = compileBrandVisualPrompt({
  visualFormatId: "cinematic-realism",
  contentDomain: "extreme weather",
  treatment: "urgent and cinematic",
  visualBeat: STORM_BEAT,
  brandVisualLanguage: null,
});
assert.doesNotMatch(stormCinematic.positive, /one nuanced human moment/i,
  "cinematic realism must not force a human into a weather beat");
assert.match(stormCinematic.positive, /35mm documentary lens language/,
  "the brand-safe lens, contrast and lighting language stays");

const stormInfographic = compileBrandVisualPrompt({
  visualFormatId: "clear-infographic",
  contentDomain: "extreme weather",
  treatment: "urgent and cinematic",
  visualBeat: STORM_BEAT,
  brandVisualLanguage: null,
});
assert.doesNotMatch(stormInfographic.positive, /circles, arrows and recognizable pictograms/i,
  "the default format must not name shapes that the model then draws as props");
assert.match(stormInfographic.positive, /physical placement, object scale and restrained color show the relationships/,
  "the infographic format is expressed through an object-only composition and negative space");

/** The flat-surface guardrail is the third sibling of the two clauses ADR 0006
 * removed: all three were written to suppress gibberish text and all three
 * became art direction. It is honest direction for a flat drawn format and a
 * direct contradiction of `cinematic-realism`'s own photorealism and tactile
 * natural materials, so v3 judges it per format instead of appending it to
 * everything.
 *
 * Removing it from the photoreal path left nothing behind it: the negative
 * prompt does NOT pick up its anti-text job, because the only model this system
 * renders on has no negative-prompt channel. See the negative-prompt reality
 * block further down. */
const FLAT_SURFACE_CLAUSE = /every visible surface uses solid undecorated color and simple abstract marks/i;
for (const format of VISUAL_FORMATS) {
  const compiled = compileBrandVisualPrompt({
    visualFormatId: format.id,
    contentDomain: "extreme weather",
    treatment: "urgent and cinematic",
    visualBeat: STORM_BEAT,
    brandVisualLanguage: null,
  });
  if (format.id === "cinematic-realism") {
    assert.doesNotMatch(compiled.positive, FLAT_SURFACE_CLAUSE,
      "a photoreal format must never be told that every surface is solid undecorated color");
    assert.doesNotMatch(compiled.positive, /undecorated|abstract marks/i,
      "no rephrasing of the flat-surface guardrail may survive on the photoreal path");
    assert.match(compiled.positive, /tactile natural materials/,
      "the photoreal path keeps the material language that guardrail contradicted");
  } else {
    assert.match(compiled.positive, FLAT_SURFACE_CLAUSE,
      `${format.id} is a flat illustrated format, where the surface direction is honest art direction`);
    assert.ok(
      compiled.positive.indexOf("every visible surface uses solid undecorated")
        > compiled.positive.indexOf("Visual format direction:"),
      `${format.id} must carry the surface direction inside its format recipe, not as a universal trailing line`,
    );
    assert.ok(
      compiled.positive.indexOf("every visible surface uses solid undecorated")
        < compiled.positive.indexOf("Brand rendering direction:"),
      `${format.id} must finish its format recipe before brand rendering direction begins`,
    );
  }
}
assert.match(stormCinematic.negative, /pseudo-text, gibberish text, Thai writing/,
  "the compiled negative keeps naming the marks a frame must never invent, so it is ready for an engine that reads one");
assert.doesNotMatch(stormCinematic.negative, /screen text|legible writing|written interface/,
  "ADR 0007: readable English is permitted, including on a screen, so the negative no longer bans it");

const retroHouse = compileBrandVisualPrompt({
  visualFormatId: "retro-story",
  contentDomain: "extreme weather",
  treatment: "urgent and cinematic",
  visualBeat: STORM_BEAT,
  brandVisualLanguage: null,
});
assert.match(retroHouse.positive, /limited sepia, mustard, teal and burgundy palette/,
  "the retro house palette still applies when the brand supplies none");
const retroBranded = compileBrandVisualPrompt({
  visualFormatId: "retro-story",
  contentDomain: "extreme weather",
  treatment: "urgent and cinematic",
  visualBeat: STORM_BEAT,
  brandVisualLanguage: STORM_BRAND,
});
assert.doesNotMatch(retroBranded.positive, /limited sepia, mustard, teal and burgundy palette/,
  "a brand palette always wins over a format's hardcoded palette");

const boundedBrandInput = compileBrandVisualPrompt({
  visualFormatId: "simple-editorial-story",
  contentDomain: "creator education",
  treatment: "clear and direct",
  visualBeat: STORM_BEAT,
  brandVisualLanguage: {
    palette: ["#111111"],
    personality: "ทีมงานนั่งประชุมในออฟฟิศ ถ่ายที่โต๊ะทำงาน",
    peopleAndSetting: "",
    memorableCues: [],
    visualNotes: "ตัดปะกระดาษฉีก thick imperfect marker lines. PRIVATE RAW NOTE 12345",
  },
});
assert.doesNotMatch(boundedBrandInput.positive, /ออฟฟิศ|ประชุม|โต๊ะทำงาน/,
  "brand personality is matched against a bounded rendering vocabulary, never interpolated",
);
assert.doesNotMatch(boundedBrandInput.positive, /PRIVATE RAW NOTE 12345/);
assert.doesNotMatch(boundedBrandInput.positive, /cut-paper shapes/i,
  "the audited v3 Visual Notes allowlist drops the rule that introduced objects into the frame");
assert.match(boundedBrandInput.positive, /Surfaces and framing carry .*thick confident strokes/);
assert.match(boundedBrandInput.positive, /The overall color grade favors black/);

console.log("verify-brand-visual-system: PASS story-first v3 brand rendering direction");

/** The palette is free creator text, so it is the same injection surface as
 * personality and Visual Notes. An entry contributes a color or nothing. */
const paletteOnly = (palette: string[]) => compileBrandVisualPrompt({
  visualFormatId: "cinematic-realism",
  contentDomain: "extreme weather",
  treatment: "urgent and cinematic",
  visualBeat: STORM_BEAT,
  brandVisualLanguage: {
    palette,
    personality: "",
    peopleAndSetting: "",
    memorableCues: [],
    visualNotes: "",
  },
});

const SCENE_PALETTE_ENTRIES: ReadonlyArray<{ entry: string; leaks: RegExp }> = [
  {
    entry: "a small golden retriever sitting on a wooden dock at sunset",
    leaks: /retriever|wooden dock|sunset|sitting/i,
  },
  {
    entry: "a large blue circular motif mounted on the office wall",
    leaks: /circular motif|office wall|mounted/i,
  },
  {
    entry: "an unmarked ring floating beside the presenter",
    leaks: /unmarked ring|floating|presenter/i,
  },
  {
    entry: "ทีมงานนั่งประชุมในออฟฟิศ สีฟ้า",
    leaks: /ทีมงาน|ประชุม|ออฟฟิศ/,
  },
];
for (const { entry, leaks } of SCENE_PALETTE_ENTRIES) {
  const injected = paletteOnly([entry]);
  assert.doesNotMatch(injected.positive, leaks,
    `a palette entry that is not color vocabulary must contribute nothing: ${entry}`);
  assert.doesNotMatch(injected.positive, /circular motif|solid unmarked disc|plain empty solid color fields|Repeat the visual cues|People and places follow|#/i,
    "an unrecognized palette entry must not reintroduce any forbidden clause");
  assert.doesNotMatch(injected.positive, /The overall color grade favors/,
    "a palette that resolves to zero colors omits the color-grade clause entirely");
  assert.doesNotMatch(injected.positive, /favors\s*\.|favors\s+and|carry\s*\.|is\s*\./i,
    "an omitted brand clause must never leave an empty or dangling sentence");
  assert.match(injected.positive, /set in an open coastal town/,
    "the Visual Beat still owns the frame when the brand contributes nothing");
}

const retroSceneryPalette = compileBrandVisualPrompt({
  visualFormatId: "retro-story",
  contentDomain: "extreme weather",
  treatment: "urgent and cinematic",
  visualBeat: STORM_BEAT,
  brandVisualLanguage: {
    palette: ["a large blue circular motif mounted on the office wall"],
    personality: "",
    peopleAndSetting: "",
    memorableCues: [],
    visualNotes: "",
  },
});
assert.match(retroSceneryPalette.positive, /limited sepia, mustard, teal and burgundy palette/,
  "a palette that resolves to zero colors leaves the format's own direction standing");
assert.doesNotMatch(retroSceneryPalette.positive, /circular motif|office wall/i);

const mixedPalette = paletteOnly([
  "a large blue circular motif mounted on the office wall",
  "deep charcoal",
  "#38BDF8",
]);
assert.match(mixedPalette.positive, /The overall color grade favors deep charcoal and cool sky blue\./,
  "recognized entries still grade the frame while the unrecognized one is dropped whole");
assert.doesNotMatch(mixedPalette.positive, /circular motif|office wall/i);

const glued = paletteOnly(["brand#38BDF8"]);
assert.match(glued.positive, /The overall color grade favors cool sky blue\./,
  "a hex code glued to a word is still a hex code and still resolves to a color word");
assert.doesNotMatch(glued.positive, /#38bdf8|brand#/i,
  "hex detection may not depend on the code being a whitespace-delimited leading token");

const shorthandHex = paletteOnly(["#0f0"]);
assert.match(shorthandHex.positive, /The overall color grade favors fresh green\./,
  "three-digit shorthand resolves like a full code");

/** The bounded-palette check is two independent rules and each one closes a
 * different hole, so each is pinned from both sides: relaxing either must fail
 * this file rather than quietly widening what a Brand can say. */
const fourTokenPalette = paletteOnly(["deep muted dusty blue"]);
assert.match(fourTokenPalette.positive, /The overall color grade favors deep muted dusty blue\./,
  "four color words is the widest entry the bound admits, and it still grades the frame");
const fiveTokenPalette = paletteOnly(["deep muted dusty faded blue"]);
assert.doesNotMatch(fiveTokenPalette.positive, /deep muted dusty faded/i,
  "a phrase long enough to describe a scene is not a color, whatever words it uses");
assert.doesNotMatch(fiveTokenPalette.positive, /The overall color grade favors/,
  "an entry past the token bound is dropped whole, never truncated into a partial grade");

/** At least one true hue word. Without it, an entry built purely from evocative
 * qualifiers becomes a color grade — the exact free-text foothold ADR 0006
 * closes, since "midnight forest" reads to the model as a place. */
for (const qualifiersOnly of ["midnight forest", "carbon ink", "bone slate", "deep faded matte"]) {
  const compiled = paletteOnly([qualifiersOnly]);
  assert.doesNotMatch(compiled.positive, new RegExp(qualifiersOnly, "i"),
    `a palette entry that names no hue is not a color: ${qualifiersOnly}`);
  assert.doesNotMatch(compiled.positive, /The overall color grade favors/,
    `a qualifier-only entry must not open a color-grade clause: ${qualifiersOnly}`);
  assert.match(compiled.positive, /set in an open coastal town/,
    `the Visual Beat still owns the frame: ${qualifiersOnly}`);
}
const hueWithQualifiers = paletteOnly(["midnight blue"]);
assert.match(hueWithQualifiers.positive, /The overall color grade favors midnight blue\./,
  "the same qualifier is welcome once a hue word carries it");

const bareSkyPalette = paletteOnly(["sky"]);
assert.match(bareSkyPalette.positive, /The overall color grade favors sky blue\./,
  "`sky` alone is a place before it is a color, so it compiles as the color it means");
assert.doesNotMatch(bareSkyPalette.positive, /favors sky\./,
  "a color grade may never end on a bare place noun");

/** Hex is creator-reachable outside the palette: `treatment` is a free
 * `z.string()` on the Project Look override API, and Visual Beat fields come
 * from Gemini extraction over the creator's own script. */
const HEX_EVERYWHERE_INPUT = {
  visualFormatId: "cinematic-realism" as const,
  contentDomain: "brand #38BDF8 identity",
  treatment: "moody #38BDF8 tone",
  visualBeat: {
    phase: "hook" as const,
    subject: "a presenter holding a #38BDF8 card",
    action: "gestures toward the #F8F5EE surface",
    setting: "a room painted #38BDF8",
    emotion: "calm #111111 focus",
    emphasis: "the #38BDF8 accent",
  },
  brandVisualLanguage: null,
};
const hexEverywhere = compileBrandVisualPrompt(HEX_EVERYWHERE_INPUT);
assert.doesNotMatch(hexEverywhere.positive, /#/,
  "no hex may reach the provider through treatment, content domain or any Visual Beat field");
assert.match(hexEverywhere.positive, /Treatment direction: moody tone/,
  "stripping a code must leave the surrounding art direction intact");
assert.match(hexEverywhere.positive, /story about brand identity/);
assert.match(hexEverywhere.positive, /set in a room painted/);
assert.match(hexEverywhere.positive, /the mood feels calm focus/);

/** A literal `#` is not the only way to write a color code, and the sanitizer
 * cannot short-circuit on one. `treatment` is a free `z.string()` on the Project
 * Look override API, so every encoding below is live creator-typed input. */
const ENCODED_CODE_INPUT = {
  visualFormatId: "cinematic-realism" as const,
  contentDomain: "brand 0x38BDF8 identity",
  treatment: "moody rgb(56, 189, 248) tone",
  visualBeat: {
    phase: "hook" as const,
    subject: "a presenter holding a ＃38BDF8 card",
    action: "gestures toward the %23F8F5EE surface",
    setting: "a room painted hsl(199, 89%, 64%)",
    emotion: "calm rgba(17, 17, 17, 0.5) focus",
    emphasis: "the 0xF8F5EE accent",
  },
  brandVisualLanguage: null,
};
const encodedCodes = compileBrandVisualPrompt(ENCODED_CODE_INPUT);
assert.doesNotMatch(encodedCodes.positive, ANY_COLOR_CODE,
  "no color code may reach the provider in any encoding");
assert.doesNotMatch(encodedCodes.positive, /38BDF8|F8F5EE/i,
  "an alternate encoding must be removed whole, not reduced to its bare digits");
assert.match(encodedCodes.positive, /Treatment direction: moody tone/,
  "stripping a CSS color function must leave the surrounding art direction intact");
assert.match(encodedCodes.positive, /story about brand identity/);
assert.match(encodedCodes.positive, /show a presenter holding a card/);
assert.match(encodedCodes.positive, /gestures toward the surface/);
assert.match(encodedCodes.positive, /set in a room painted/);
assert.match(encodedCodes.positive, /the mood feels calm focus/);
assert.match(encodedCodes.positive, /rests on the accent/);

/** The palette mapper reaches these encodings by a different route: an entry
 * that is not compiler color vocabulary contributes nothing, so an encoded code
 * fails closed there instead of being named. Pinned so the two v3 paths cannot
 * silently disagree about what a color code is. */
for (const encoded of ["0x38BDF8", "rgb(56, 189, 248)", "＃38BDF8", "%2338BDF8", "hsl(199, 89%, 64%)"]) {
  const encodedPalette = paletteOnly([encoded]);
  assert.doesNotMatch(encodedPalette.positive, ANY_COLOR_CODE,
    `an encoded palette entry may not reach the provider: ${encoded}`);
  assert.doesNotMatch(encodedPalette.positive, /The overall color grade favors/,
    `an encoded palette entry resolves to no color at all rather than a guess: ${encoded}`);
}

/** The hex sanitizer is a v3-only layer. A `-v1`/`-v2` pin must keep emitting
 * the exact string it was published with, code and all (ADR 0005). */
for (const pinned of ["cinematic-realism-v1", "cinematic-realism-v2"] as const) {
  const frozen = compileBrandVisualPrompt({ ...HEX_EVERYWHERE_INPUT, recipeVersion: pinned });
  assert.match(frozen.positive, /a presenter holding a #38BDF8 card/,
    `${pinned} must not inherit the v3 hex sanitizer`);
  assert.match(frozen.positive, /inside a room painted #38BDF8/,
    `${pinned} must keep its own scene grammar and its raw code`);
  const frozenEncoded = compileBrandVisualPrompt({ ...ENCODED_CODE_INPUT, recipeVersion: pinned });
  assert.match(frozenEncoded.positive, /a presenter holding a ＃38BDF8 card/,
    `${pinned} must not inherit the widened v3 color-code sanitizer either`);
  assert.match(frozenEncoded.positive, /a moody rgb\(56, 189, 248\) tone feeling/,
    `${pinned} keeps every encoding exactly as it was published`);
}

const outdoorBeat = compileBrandVisualPrompt({
  visualFormatId: "cinematic-realism",
  contentDomain: "extreme weather",
  treatment: "urgent and cinematic",
  visualBeat: {
    phase: "hook",
    subject: "a wall of storm cloud over open water",
    action: "the storm front advances toward the shoreline",
    setting: "a wide open outdoor landscape with no structures in the foreground",
    emotion: "awe mixed with dread",
    emphasis: "the scale of the weather",
  },
  brandVisualLanguage: null,
});
assert.match(outdoorBeat.positive, /set in a wide open outdoor landscape with no structures in the foreground/,
  "the v3 setting connector must read for an exterior establishing frame");
assert.doesNotMatch(outdoorBeat.positive, /inside a wide open outdoor landscape/i,
  "`inside` fights the wide outdoor frame the Hook archetype needs");

const overlappingBrand = compileBrandVisualPrompt({
  visualFormatId: "cinematic-realism",
  contentDomain: "extreme weather",
  treatment: "urgent and cinematic",
  visualBeat: STORM_BEAT,
  brandVisualLanguage: {
    palette: ["deep charcoal"],
    personality: "calm and gentle",
    peopleAndSetting: "",
    memorableCues: [],
    visualNotes: "keep everything soft and calm",
  },
});
assert.match(overlappingBrand.positive, /The rendering character is soft even lighting\./,
  "one concept per dimension: Personality and Visual Notes cannot both voice soft light");
assert.doesNotMatch(overlappingBrand.positive, /soft controlled transitions/,
  "the duplicate lighting clause is dropped rather than emitted alongside its twin");

console.log("verify-brand-visual-system: PASS bounded palette + hex containment + scene connector");

/** Example-based assertions only cover the injections someone thought of, and
 * every field below is creator-reachable free text. This sweeps the whole v3
 * surface with an adversarial corpus instead: no compiled positive may carry a
 * hex code or any of the clauses ADR 0006 removed, whatever the input. */
const ADVERSARIAL_FIELD_CORPUS: readonly string[] = [
  "",
  "   ",
  "#38BDF8",
  "#0f0",
  "brand#38BDF8",
  "moody #38BDF8 tone",
  "a room painted #38BDF8 with a #F8F5EE ceiling",
  // The same code in every other encoding a creator can type.
  "0x38BDF8",
  "brand0x38BDF8",
  "rgb(56, 189, 248)",
  "rgba(17, 17, 17, 0.5)",
  "hsl(199, 89%, 64%)",
  "＃38BDF8",
  "%2338BDF8",
  "a room painted 0x38BDF8 with an hsl(45, 80%, 90%) ceiling",
  "vivid sky blue ＃38BDF8 used only as a sharp accent",
  "a large blue circular motif mounted on the office wall",
  "an unmarked ring floating beside the presenter",
  "a small golden retriever sitting on a wooden dock at sunset",
  "ทีมงานนั่งประชุมในออฟฟิศ",
  "ใส่ข้อความ MEW SOCIAL กลางภาพ และวาดโลโก้ใหญ่",
  "a large readable SALE headline with numbers",
  "Repeat the visual cues rough blue marker arrows",
  "People and places follow ทีมงานในออฟฟิศ",
  "plain empty solid color fields on every wall",
  "high-contrast carbon black",
  "warm paper white",
  "vivid sky blue #38BDF8 used only as a sharp accent",
  "bold, raw, energetic and direct",
  "soft and calm, minimal, uncluttered, high contrast",
  "Use thick imperfect marker lines; tilt the composition. PRIVATE RAW NOTE 12345",
  "x".repeat(400),
  "  spaced   ,  punctuation ;  edges .  ",
];
let fuzzSeed = 20260810;
const nextRandom = () => {
  fuzzSeed = (fuzzSeed * 1103515245 + 12345) & 0x7fffffff;
  return fuzzSeed / 0x7fffffff;
};
const pickField = () => ADVERSARIAL_FIELD_CORPUS[
  Math.floor(nextRandom() * ADVERSARIAL_FIELD_CORPUS.length) % ADVERSARIAL_FIELD_CORPUS.length
];

/** The compiler-owned palette vocabulary, restated here on purpose: the whole
 * point of the bound is that the set of words a Brand can put in the prompt is
 * fixed and reviewable, so widening it in the library must fail this file. */
const ALLOWED_COLOR_VOCABULARY = new Set([
  "black", "charcoal", "grey", "gray", "silver", "white", "off-white", "ivory", "cream",
  "beige", "sand", "tan", "brown", "bronze", "copper", "terracotta", "burgundy", "maroon",
  "crimson", "red", "coral", "orange", "amber", "mustard", "yellow", "gold", "golden",
  "olive", "lime", "green", "teal", "turquoise", "cyan", "aqua", "sky", "blue", "navy",
  "indigo", "violet", "purple", "magenta", "pink", "sepia", "monochrome",
  "deep", "dark", "light", "pale", "muted", "bright", "vivid", "warm", "cool", "soft",
  "rich", "dusty", "faded", "washed", "matte", "saturated", "desaturated", "neutral",
  "pastel", "clean", "high", "low", "mid", "off", "contrast", "high-contrast",
  "low-contrast", "carbon", "paper", "ink", "bone", "jet", "midnight", "forest",
  "slate", "fresh", "and",
]);
/** The only three sentence shapes a Brand may contribute in v3. */
const BRAND_SENTENCE = /^(?:The overall color grade favors [a-z0-9 ,-]+|The rendering character is [a-z0-9 ,-]+|Surfaces and framing carry [a-z0-9 ,-]+|Use the selected format's neutral house palette and balanced composition)$/;

const SWEEP_BEAT = {
  phase: "hook" as const,
  subject: "a towering cyclone wall",
  action: "the cyclone advances over the water toward the shore",
  setting: "an open coastal town",
  emotion: "awe mixed with dread",
  emphasis: "the scale of the approaching storm",
};
const HEAD_MARK = "feeling. ";
const TAIL_MARK = "Preserve the selected visual format";
function splitBrandFragment(positive: string): { head: string; fragment: string; tail: string } {
  const headIndex = positive.indexOf(HEAD_MARK);
  const headEnd = headIndex + HEAD_MARK.length;
  const tailStart = positive.indexOf(TAIL_MARK);
  // A Brand that contributes nothing leaves tailStart exactly at headEnd.
  assert.ok(headIndex >= 0 && tailStart >= headEnd, "the compiled prompt kept its fixed skeleton");
  return {
    head: positive.slice(0, headEnd),
    fragment: positive.slice(headEnd, tailStart).replace(/\.\s*$/, "").trim(),
    tail: positive.slice(tailStart),
  };
}

/** Sweep 1 — Brand fields. Beat, domain and treatment are held fixed, so every
 * byte outside the Brand fragment must be identical to the unbranded compile
 * and the fragment itself must be pure compiler vocabulary. */
const V3_VISUAL_FORMATS = SUPPORTED_VISUAL_FORMATS.filter(
  (format) => format.id !== "simple-editorial-story",
);
for (let index = 0; index < 4000; index += 1) {
  const format = V3_VISUAL_FORMATS[index % V3_VISUAL_FORMATS.length];
  const base = {
    visualFormatId: format.id,
    recipeVersion: `${format.id}-v3`,
    contentDomain: "extreme weather",
    treatment: "urgent and cinematic",
    visualBeat: SWEEP_BEAT,
  };
  const neutral = splitBrandFragment(compileBrandVisualPrompt({ ...base, brandVisualLanguage: null }).positive);
  const branded = splitBrandFragment(compileBrandVisualPrompt({
    ...base,
    brandVisualLanguage: {
      palette: Array.from({ length: Math.floor(nextRandom() * 5) }, pickField),
      personality: pickField(),
      peopleAndSetting: pickField(),
      memorableCues: Array.from({ length: Math.floor(nextRandom() * 4) }, pickField),
      visualNotes: pickField(),
    },
  }).positive);

  // The one permitted head difference is the documented house-palette
  // suppression: a brand palette outranks a format's hardcoded colors.
  const gradesTheFrame = branded.fragment.includes("The overall color grade favors");
  const expectedHead = gradesTheFrame
    ? neutral.head.replace(", limited sepia, mustard, teal and burgundy palette", "")
    : neutral.head;
  assert.equal(branded.head, expectedHead, `a Brand may not touch the scene half of the prompt (case ${index})`);
  assert.equal(branded.tail, neutral.tail, `a Brand may not touch the craft guardrails (case ${index})`);
  if (!branded.fragment) continue;
  for (const sentence of branded.fragment.split(". ")) {
    assert.match(sentence, BRAND_SENTENCE,
      `a Brand may only speak in the fixed clause builders (case ${index})`);
    const colors = /^The overall color grade favors (.+)$/.exec(sentence)?.[1];
    if (!colors) continue;
    for (const word of colors.split(/[\s,]+/).filter(Boolean)) {
      assert.ok(ALLOWED_COLOR_VOCABULARY.has(word),
        `a palette may only emit compiler color vocabulary, got "${word}" (case ${index})`);
    }
  }
}

/** Sweep 2 — scene fields. These legitimately carry whatever the script is
 * about, so the invariant is narrower: never a raw code, never empty grammar. */
for (let index = 0; index < 4000; index += 1) {
  const format = V3_VISUAL_FORMATS[index % V3_VISUAL_FORMATS.length];
  const fuzzed = compileBrandVisualPrompt({
    visualFormatId: format.id,
    recipeVersion: `${format.id}-v3`,
    contentDomain: pickField(),
    treatment: pickField(),
    visualBeat: {
      phase: "hook",
      subject: pickField(),
      action: pickField(),
      setting: pickField(),
      emotion: pickField(),
      emphasis: pickField(),
    },
    // Sentinels the corpus can never supply, so a hit proves the Brand field
    // itself reached the provider rather than the Visual Beat's own words.
    brandVisualLanguage: nextRandom() < 0.5 ? null : {
      palette: ["#38BDF8", "0x38BDF8", "＃38BDF8", "rgb(56, 189, 248)", "deep charcoal", "zzpalettezz วงกลมฟ้า"],
      personality: "bold and calm zzpersonalityzz",
      peopleAndSetting: "zzpeoplezz ทีมงานในออฟฟิศ",
      memorableCues: ["zzcuezz วงกลมฟ้า"],
      visualNotes: "thick imperfect marker lines zznoteszz",
    },
  });
  assert.doesNotMatch(fuzzed.positive, ANY_COLOR_CODE,
    `no field may carry a color code into a v3 positive, in any encoding (case ${index})`);
  assert.doesNotMatch(
    fuzzed.positive,
    /with a\s+feeling|story about\s*,|set in\s*,|feels\s*,|rests on\s*,|favors\s*\.|carry\s*\.|character is\s*\./i,
    `a v3 positive must never emit an empty or dangling clause (case ${index})`,
  );
  assert.doesNotMatch(
    fuzzed.positive,
    /zzpalettezz|zzpersonalityzz|zzpeoplezz|zzcuezz|zznoteszz/i,
    `no Brand field may reach the provider as raw text (case ${index})`,
  );
}

console.log("verify-brand-visual-system: PASS adversarial v3 field sweep");

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
  visualFormatId: "simple-editorial-story",
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
assert.doesNotMatch(
  adversarialPrompt.positive,
  /rough blue marker arrow/i,
  "a memorable cue is a graphic motif a photoreal model can only render as a prop, so v3 drops it",
);
assert.match(adversarialPrompt.positive, /Surfaces and framing carry .*handmade material texture/,
  "brand personality still reaches the provider, as a bounded surface/framing clause");

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
  /with a\s+feeling|story about\s*,|inside\s*,|set in\s*,|feels\s*,|rests on\s*,/i,
  "copy safety must never erase a full semantic field or emit empty prompt grammar",
);
assert.match(semanticSanitizerPrompt.positive, /Treatment direction: professional, calm and immediately readable/i);
/** `logo` names a layer the renderer owns, so v3 still removes it. `Top 10` is
 * not a layer — it is what the story is about, and under ADR 0007 a number the
 * scene genuinely contains may render. Removing it was `-v4` behaviour, kept
 * only while lettering was banned outright. */
assert.match(semanticSanitizerPrompt.positive, /story about a designer explains the Top 10 conversion lessons/i);
assert.doesNotMatch(semanticSanitizerPrompt.positive, /logo/i);

assert.ok(
  VISUAL_FORMATS.every((format) => (
    format.id === "simple-editorial-story"
      ? format.recipeVersion === "simple-editorial-story-v11"
      : format.recipeVersion.endsWith("-v9")
  )),
  "a material prompt-compiler change must publish a new immutable recipe version",
);

console.log("verify-brand-visual-system: PASS semantic sanitizer + recipe versioning");

/** ── Negative-prompt reality ───────────────────────────────────────────────
 * `CompiledBrandVisualPrompt.negative` is not enforcement and never has been.
 * The only model this system renders on is `z-image-turbo`, which is
 * positive-only on both of its routes: its public endpoint accepts a
 * negative-prompt field under either candidate name and returns byte-identical
 * images (`artifacts/runpod-negative-prompt-probe-2026-08-10/`), and its custom
 * workflow zeroes the negative conditioning. The terms are kept — they are the
 * honest statement of what a Brand Visual frame must not contain, and they go
 * live the moment a revision compiles for an engine that reads one — but no
 * comment, doc or feature may claim they keep marks out of an image today. */
assert.equal(
  AI_IMAGE_MODELS.find((model) => model.id === "z-image-turbo")!.negativePromptDelivery,
  "ignored",
  "the model behind every Brand Visual render has no negative-prompt channel",
);
const brandVisualSource = readFileSync("src/lib/brand-visual-system.ts", "utf8");
assert.match(brandVisualSource, /It is NOT enforcement/,
  "the negative-prompt block states plainly that it reaches nothing today");
assert.doesNotMatch(brandVisualSource, /load-bearing for the no-legible-marks guarantee/,
  "the superseded claim that these terms enforce the text-free contract must not return");
assert.doesNotMatch(brandVisualSource, /which already covers every legible mark/,
  "nor the weaker version of the same claim on the flat-surface guardrail");

/** ADR 0005 turned the shared negative list into two. `-v2` keeps the frozen
 * pre-ADR-0007 array so a pinned revision compiles to the exact provider input
 * it was published with; `-v3` gets its own. Duplication is the point, so the
 * v3 compiler must never be able to reach the frozen one again. */
const v3CompilerSource = brandVisualSource.slice(
  brandVisualSource.indexOf("function compileBrandVisualPromptV3"),
  brandVisualSource.indexOf("export function compileBrandVisualPrompt("),
);
assert.ok(v3CompilerSource.length > 0, "the v3 compiler must be locatable in source");
assert.ok(
  v3CompilerSource.includes("V3_NEGATIVE_PROMPT_TERMS"),
  "the v3 compiler must build its negative from the ADR 0007 list",
);
assert.ok(
  !v3CompilerSource.includes("TEXT_FREE_NEGATIVE_PROMPT_TERMS"),
  "the v3 compiler must never read the frozen v2 negative list again",
);
const v2CompilerSource = brandVisualSource.slice(
  brandVisualSource.indexOf("function compileBrandVisualPromptV2"),
  brandVisualSource.indexOf("/** Compact named-color table"),
);
assert.ok(
  v2CompilerSource.includes("TEXT_FREE_NEGATIVE_PROMPT_TERMS")
    && !v2CompilerSource.includes("V3_NEGATIVE_PROMPT_TERMS"),
  "the frozen v2 compiler must keep reading only the frozen v2 negative list",
);

console.log("verify-brand-visual-system: PASS negative prompt is recorded as inert, not enforcing");

/** ── Locale neutrality ─────────────────────────────────────────────────────
 * A generated image must follow the story's own context — an American script
 * gets an American frame. The frozen `-v1`/`-v2` recipes hardcode "believable
 * Thai environments"; v3 dropped it and must never regain a locale word through
 * any path, so the only locale in a compiled frame is the one the Visual Beat
 * asked for. */
const LOCALE_WORD =
  /\b(?:thai|thailand|bangkok|asian|asia|southeast|oriental|western|american|america|european|europe|japanese|chinese|korean|indian|african|latin)\b|ไทย/i;
const LOCALE_FREE_BEAT = {
  phase: "hook" as const,
  subject: "a towering cyclone wall",
  action: "the cyclone advances over the water toward the shore",
  setting: "an open coastal town",
  emotion: "awe mixed with dread",
  emphasis: "the scale of the approaching storm",
};
for (const format of VISUAL_FORMATS) {
  for (const brandVisualLanguage of [null, STORM_BRAND, {
    palette: ["deep charcoal", "warm off-white"],
    personality: "bold, cinematic, premium and handmade",
    peopleAndSetting: "ทีมงานในออฟฟิศที่กรุงเทพ",
    memorableCues: ["Thai street signage"],
    visualNotes: "thick imperfect marker lines, high contrast, tilt the composition",
  }]) {
    const compiled = compileBrandVisualPrompt({
      visualFormatId: format.id,
      contentDomain: "extreme weather",
      treatment: "urgent and cinematic",
      visualBeat: LOCALE_FREE_BEAT,
      brandVisualLanguage,
    });
    assert.doesNotMatch(compiled.positive, LOCALE_WORD,
      `${format.id}-v3 must add no locale of its own; the story owns where a scene is set`);
  }
}
// The other half of the rule: when the story is about a place, that place must
// survive intact. Locale is the Visual Beat's to give, not the compiler's.
const americanBeat = compileBrandVisualPrompt({
  visualFormatId: "cinematic-realism",
  contentDomain: "American small-business lending",
  treatment: "warm and direct",
  visualBeat: {
    phase: "explain",
    subject: "a hardware store owner and a stack of unopened envelopes",
    action: "the owner sorts the envelopes across the counter",
    setting: "a small-town American main-street hardware store",
    emotion: "quiet determination",
    emphasis: "the weight of the backlog",
  },
  brandVisualLanguage: null,
});
assert.match(americanBeat.positive, /set in a small-town American main-street hardware store/,
  "a story set in America compiles to an American frame");
assert.match(americanBeat.positive, /story about American small-business lending/);
// v1/v2 are frozen with their locale clause (ADR 0005) and must keep it.
for (const pinned of ["cinematic-realism-v1", "cinematic-realism-v2"] as const) {
  const frozen = compileBrandVisualPrompt({
    visualFormatId: "cinematic-realism",
    recipeVersion: pinned,
    contentDomain: "extreme weather",
    treatment: "urgent and cinematic",
    visualBeat: LOCALE_FREE_BEAT,
    brandVisualLanguage: null,
  });
  assert.match(frozen.positive, /real human anatomy and believable Thai environments/,
    `${pinned} keeps the locale clause it was published with`);
}

console.log("verify-brand-visual-system: PASS locale follows the story, never the recipe");

/** ── v3 positive prompt is unchanged ───────────────────────────────────────
 * The image text policy is expressed at the Visual Beat layer, not here: a
 * positive-prompt clause written to suppress lettering is the exact class of
 * change that produced the storytelling bug ADR 0006 fixed. These goldens pin
 * the v3 output byte for byte, so any future anti-text clause has to be a
 * deliberate `-v4` rather than a quiet edit to a shipped recipe. */
assert.equal(
  compileBrandVisualPrompt({
    visualFormatId: "cinematic-realism",
    recipeVersion: "cinematic-realism-v3",
    contentDomain: "extreme weather",
    treatment: "urgent and cinematic",
    visualBeat: LOCALE_FREE_BEAT,
    brandVisualLanguage: null,
  }).positive,
  "A vertical edge-to-edge composition from a single viewpoint fills the frame. All people and objects share the same ground plane in one frozen moment. photorealistic cinematic film still, correct anatomy and physically plausible surroundings wherever they appear, tactile natural materials, layered foreground, midground and background, 35mm documentary lens language, controlled filmic contrast and motivated practical lighting, the entire canvas uses photographic rendering. For a story about extreme weather, show a towering cyclone wall, the cyclone advances over the water toward the shore, set in an open coastal town, the mood feels awe mixed with dread, visual attention rests on the scale of the approaching storm. Shape the scene with a urgent and cinematic feeling. Use the selected format's neutral house palette and balanced composition. Preserve the selected visual format exactly while keeping the described subject, action and setting. The lower third stays calm and uncluttered with open background texture.",
  "cinematic-realism-v3 must stay byte-identical: the text policy did not touch the compiler",
);
assert.equal(
  compileBrandVisualPrompt({
    visualFormatId: "clear-infographic",
    recipeVersion: "clear-infographic-v3",
    contentDomain: "extreme weather",
    treatment: "urgent and cinematic",
    visualBeat: LOCALE_FREE_BEAT,
    brandVisualLanguage: null,
  }).positive,
  "A vertical edge-to-edge composition from a single viewpoint fills the frame. All people and objects share the same ground plane in one frozen moment. diagrammatic editorial illustration on one continuous vertical canvas, clear top-to-bottom visual hierarchy, whatever appears is simplified to its clearest recognizable form, grouping, scale and alignment carry the explanation, generous negative space and a restrained palette, the idea is expressed entirely through visual relationships, every visible surface uses solid undecorated color and simple abstract marks. For a story about extreme weather, show a towering cyclone wall, the cyclone advances over the water toward the shore, set in an open coastal town, the mood feels awe mixed with dread, visual attention rests on the scale of the approaching storm. Shape the scene with a urgent and cinematic feeling. Use the selected format's neutral house palette and balanced composition. Preserve the selected visual format exactly while keeping the described subject, action and setting. The lower third stays calm and uncluttered with open background texture.",
  "clear-infographic-v3 must stay byte-identical for the same reason",
);
assert.ok(
  VISUAL_FORMATS.every((format) => format.recipeVersion === (
    format.id === "simple-editorial-story" ? `${format.id}-v11` : `${format.id}-v9`
  )),
  "the count-safe compiler publishes new recipes while frozen v6/v7 prompts remain replayable",
);

console.log("verify-brand-visual-system: PASS v3 positive prompt unchanged by the text policy");

/** ADR 0005: a published revision keeps compiling to the exact provider input
 * it was published with. These goldens are the pre-v3 output, captured byte for
 * byte — a diff here means a pinned revision silently changed look. */
const pinnedV2Prompt = compileBrandVisualPrompt({
  visualFormatId: "stick-figure-story",
  recipeVersion: "stick-figure-story-v2",
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
assert.equal(pinnedV2Prompt.recipeVersion, "stick-figure-story-v2");
assert.equal(
  pinnedV2Prompt.positive,
  [
    "A vertical edge-to-edge composition from a single viewpoint fills the frame",
    "All people and objects share the same ground plane in one frozen moment",
    "an expressive hand-drawn stick-figure story across the entire canvas, unmistakable simple round heads and line bodies, every person, object, building and background uses bold imperfect marker strokes, warm fibrous paper remains visible throughout the environment, visual cause and effect communicated through poses, props and directional composition, clever editorial simplicity, flat handmade marks and simple paper shapes",
    "For a story about history, show a Thai archaeologist and a sealed stone doorway, the archaeologist reaches toward the newly uncovered doorway, inside an ancient Ayutthaya temple chamber at night, the mood feels curiosity mixed with danger, visual attention rests on the discovery behind the doorway",
    "Shape the scene with a mysterious and suspenseful feeling",
    "Use the recurring palette high-contrast black, warm white, sky blue #38BDF8. The recurring personality feels bold, raw and energetic. People and places follow simple expressive stick figures in Thai contexts. Repeat the visual cues rough sky-blue empty unmarked marker rings, rough sky-blue marker arrows. a slightly diagonal composition",
    "Preserve the selected visual format exactly while adapting the subject, setting, palette and mood",
    "The lower third stays calm and uncluttered with open background texture",
    "Background walls, device screens and framed areas use plain empty solid color fields",
    "Every circular motif is either an empty unmarked ring or a solid unmarked disc",
    "Every visible surface uses solid undecorated color and simple abstract marks",
  ].join(". ") + ".",
  "a persisted v2 pin must retain the exact pre-v3 compiler grammar and recipe",
);
assert.equal(
  pinnedV2Prompt.negative,
  "text, letters, words, numbers, typography, caption, subtitle, headline, logo, watermark, signature, brand name, label, signage, currency symbol, dollar sign, baht sign, artist initials, corner mark, date stamp, currency glyph, monetary icon, symbol inside circle, pseudo-text, gibberish text, framed notice, wall chart, written interface, screen text, document, certificate, legible writing, comic panels, panel borders, collage, split screen, triptych, storyboard, contact sheet, multiple camera views",
  "a persisted v2 pin must retain the exact pre-v3 provider negative prompt",
);

const pinnedV2BaseInput = {
  visualFormatId: "retro-story" as const,
  recipeVersion: "retro-story-v2",
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
const pinnedV2RetroPrompt = compileBrandVisualPrompt(pinnedV2BaseInput);
assert.equal(
  pinnedV2RetroPrompt.positive,
  [
    "A vertical edge-to-edge composition from a single viewpoint fills the frame",
    "All people and objects share the same ground plane in one frozen moment",
    "mid-century 1950s to 1970s flat gouache animation-cel scene, subtle screenprinted color texture within the depicted environment, simplified period shapes, slightly misregistered ink edges, limited sepia, mustard, teal and burgundy palette, nostalgic visual language while keeping the depicted subject accurate, the camera crops through the illustrated environment at every canvas edge, large foreground floor and wall color shapes continue beyond the bottom edge and both lower corners, the image is one lived-in scene rather than a displayed print or page",
    "For a story about preventive medicine, show a Thai woman physician, a heart model and three colored health-state circles, the physician holds the heart model while the three circles arc around it and a water glass rests nearby, inside a clean modern Thai clinic consultation room in daylight, the mood feels trustworthy professional clarity, visual attention rests on the direct relationship between a simple daily habit and heart health",
    "Shape the scene with a professional, calm and explanatory with an immediately readable cause-and-effect flow feeling",
    "Use the selected format's neutral house palette and balanced composition.",
    "Preserve the selected visual format exactly while adapting the subject, setting, palette and mood",
    "The lower third stays calm and uncluttered with open background texture",
    "Background walls, device screens and framed areas use plain empty solid color fields",
    "Every circular motif is either an empty unmarked ring or a solid unmarked disc",
    "Every visible surface uses solid undecorated color and simple abstract marks",
  ].join(". ") + ".",
  "an unbranded v2 pin keeps its exact neutral house grammar",
);
assert.equal(
  pinnedV2RetroPrompt.negative,
  "text, letters, words, numbers, typography, caption, subtitle, headline, logo, watermark, signature, brand name, label, signage, currency symbol, dollar sign, baht sign, artist initials, corner mark, date stamp, currency glyph, monetary icon, symbol inside circle, pseudo-text, gibberish text, framed notice, wall chart, written interface, screen text, document, certificate, legible writing, comic panels, panel borders, collage, split screen, triptych, storyboard, contact sheet, multiple camera views, artist credit, printer's mark, edition mark, handwritten mark, footer, border, frame, mat, paper margin, print margin, blank margin, artwork reproduction, book page, magazine page, poster",
  "the retro v2 pin keeps its extra print-artifact negatives",
);

for (const format of SUPPORTED_VISUAL_FORMATS.filter((candidate) => candidate.id !== "simple-editorial-story")) {
  const pinnedRecipeVersion = `${format.id}-v2`;
  const compiled = compileBrandVisualPrompt({
    ...pinnedV2BaseInput,
    visualFormatId: format.id,
    recipeVersion: pinnedRecipeVersion,
  });
  assert.equal(compiled.recipeVersion, pinnedRecipeVersion, `persisted ${pinnedRecipeVersion} must remain supported`);
}
assert.throws(
  () => compileBrandVisualPrompt({
    ...pinnedV2BaseInput,
    recipeVersion: "retro-story-v99",
  }),
  /Unsupported Visual Format recipe version/,
  "an unknown recipe version must fail closed instead of silently compiling on the current one",
);

console.log("verify-brand-visual-system: PASS immutable v2 compiler compatibility");

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

for (const format of SUPPORTED_VISUAL_FORMATS.filter((candidate) => candidate.id !== "simple-editorial-story")) {
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
  "Mewsocial and control must each receive the same three Simple Editorial Story scenes",
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
  benchmarkCases.every((item) => !/with a\s+feeling|story about\s*,|inside\s*,|set in\s*,|feels\s*,|rests on\s*,/i.test(item.compiled.positive)),
  "the fixed gate must reject semantically empty compiler clauses before provider spend",
);

console.log("verify-brand-visual-system: PASS 21-image benchmark matrix");

/** ── ADR 0007 writing-system backstop ──────────────────────────────────────
 * The rule that keeps Thai out of a frame lives in the content-preflight
 * instruction, which asks Gemini for English beat fields. That is a request,
 * and `z-image-turbo` is positive-only, so nothing downstream can veto a beat
 * that comes back in Thai anyway. `v3PositiveArtDirectionValue` is the veto:
 * it strips non-Latin writing at the last point before the provider.
 *
 * English is deliberately NOT stripped — ADR 0007 permits it, and the whole
 * point of relaxing the `-v4` signage ban was that a story genuinely about a
 * sign should get one. */
const THAI_CHARACTER = /[฀-๿]/;
const signageBeat = {
  phase: "hook" as const,
  subject: 'a hand-lettered wooden shop sign reading "OPEN LATE"',
  action: "the owner hangs the sign as the last daylight goes",
  setting: "a narrow street of small shopfronts",
  emotion: "stubborn hope",
  emphasis: 'the words "OPEN LATE" against the closing street',
};
const signageCompiled = compileBrandVisualPrompt({
  visualFormatId: "cinematic-realism",
  contentDomain: "small shops trading after hours",
  treatment: "warm and direct",
  visualBeat: signageBeat,
  brandVisualLanguage: null,
});
assert.match(signageCompiled.positive, /a hand-lettered wooden shop sign reading "OPEN LATE"/,
  "ADR 0007: a sign the story is about survives into the prompt, wording and all");
assert.match(signageCompiled.positive, /visual attention rests on the words "OPEN LATE"/,
  "English lettering may even be the emphasis of a beat");

const thaiBeat = compileBrandVisualPrompt({
  visualFormatId: "cinematic-realism",
  contentDomain: "การตลาดออนไลน์",
  treatment: "สดใส สนุก และเป็นกันเอง",
  visualBeat: {
    phase: "hook",
    subject: 'ป้ายร้านเขียนว่า "ลดราคา" a hand-painted shop sign',
    action: "the owner ties the sign to the shutter",
    setting: "ตลาดเช้า a covered morning market",
    emotion: "ความหวัง quiet hope",
    emphasis: "the sign above the shutter",
  },
  brandVisualLanguage: {
    palette: ["deep charcoal"],
    personality: "โทนอบอุ่น",
    peopleAndSetting: null,
    memorableCues: [],
    visualNotes: "สีสด",
  },
});
assert.doesNotMatch(thaiBeat.positive, THAI_CHARACTER,
  "no Thai character may reach a positive-only provider through any compiled field");
assert.match(thaiBeat.positive, /a hand-painted shop sign/,
  "stripping a writing system must keep the English the beat also carried");
assert.match(thaiBeat.positive, /set in a covered morning market/,
  "a mixed-script setting keeps its Latin half rather than being dropped whole");
assert.doesNotMatch(thaiBeat.positive, /story about\s*,|inside\s*,|set in\s*,|feels\s*,|rests on\s*,|favors\s*\./,
  "a field emptied by stripping must not leave a dangling connector for the encoder to render");
/** A field with nothing Latin left contributes nothing rather than a fragment of
 * stray punctuation, and the compiler's own English default carries the clause. */
assert.match(thaiBeat.positive, /for a story about a visually led subject/i,
  "an all-Thai contentDomain falls back to the compiler default, not to empty text");
assert.doesNotMatch(thaiBeat.positive, /Shape the scene with a\s+feeling/,
  "an all-Thai treatment is dropped as a whole clause, not left half-written");

console.log("verify-brand-visual-system: PASS ADR 0007 writing-system backstop");
