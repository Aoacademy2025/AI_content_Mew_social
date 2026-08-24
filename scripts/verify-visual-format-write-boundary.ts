import assert from "node:assert/strict";
import { createCatalogTreatmentPin } from "../src/lib/brand-treatment-catalog";

async function main() {
  const {
    brandProfilePayloadSchema,
    storedBrandProfilePayloadSchema,
  } = await import("../src/lib/brand-profile-library.server");
  const {
    parseProjectLook,
    parseProjectVisualContext,
    parseRevision,
    projectLookInputSchema,
    recipeFor,
  } = await import("../src/lib/project-visual-context");

  const profilePayload = {
    schemaVersion: 1 as const,
    name: "Editorial Brand",
    niche: "",
    audience: "",
    script: {
      styleId: null,
      tone: "",
      bannedWords: [],
      ctaStyle: "soft",
      language: "th",
    },
    voice: { provider: "gemini", voiceId: null },
    subtitle: { presetId: null, config: {} },
    brandMark: { assetId: null, enabled: false, position: "top-right", sizePct: 10, opacity: 1 },
    visual: {
      primaryVisualFormatId: "simple-editorial-story",
      treatmentPolicy: "adaptive" as const,
      lockedTreatmentPresetId: null,
      palette: ["#F8F5EE", "#111111"],
      personality: "clear",
      peopleAndSetting: "",
      memorableCues: [],
      visualNotes: "",
      defaultTreatment: "",
    },
  };
  assert.equal(brandProfilePayloadSchema.safeParse(profilePayload).success, true,
    "a new Brand Profile can select Simple Editorial Story");
  assert.equal(brandProfilePayloadSchema.safeParse({
    ...profilePayload,
    visual: { ...profilePayload.visual, primaryVisualFormatId: "stick-figure-story" },
  }).success, false, "a new Brand Profile cannot select the retired Stick Figure format");
  assert.equal(storedBrandProfilePayloadSchema.safeParse({
    ...profilePayload,
    visual: { ...profilePayload.visual, primaryVisualFormatId: "stick-figure-story" },
  }).success, true, "an immutable historical Brand Profile payload remains readable");

  const newLook = {
    visualFormatId: "simple-editorial-story",
    treatmentPresetId: "expert-clarity",
    brandVisualLanguage: null,
  } as const;
  assert.equal(projectLookInputSchema.safeParse(newLook).success, true);
  assert.equal(projectLookInputSchema.safeParse({
    ...newLook,
    visualFormatId: "stick-figure-story",
  }).success, false, "a new project override cannot select the retired format");
  assert.equal(recipeFor("simple-editorial-story"), "simple-editorial-story-v11");
  assert.equal(recipeFor("stick-figure-story"), "stick-figure-story-v6",
    "legacy recovery can resolve the final historical Stick Figure recipe");

  const treatmentPin = createCatalogTreatmentPin("expert-clarity", "adaptive");
  const legacyRevision = JSON.stringify({
    visualFormatId: "stick-figure-story",
    recipeVersion: "stick-figure-story-v6",
    brandVisualLanguage: null,
    defaultTreatment: "legacy",
    treatmentPolicy: "adaptive",
    lockedTreatmentPin: null,
  });
  assert.equal(parseRevision(legacyRevision)?.recipeVersion, "stick-figure-story-v6");

  const legacyLook = JSON.stringify({
    schemaVersion: 2,
    visualFormatId: "stick-figure-story",
    recipeVersion: "stick-figure-story-v6",
    treatment: "ผู้เชี่ยวชาญอธิบายชัด",
    treatmentPin,
    brandVisualLanguage: null,
  });
  assert.equal(parseProjectLook(legacyLook)?.visualFormatId, "stick-figure-story");

  const legacyContext = JSON.stringify({
    schemaVersion: 2,
    source: "project-look",
    visualFormatId: "stick-figure-story",
    recipeVersion: "stick-figure-story-v6",
    treatment: "ผู้เชี่ยวชาญอธิบายชัด",
    treatmentPin,
    brandVisualLanguage: null,
  });
  assert.equal(parseProjectVisualContext(legacyContext)?.visualFormatId, "stick-figure-story",
    "an existing render and Scene Reroll retain their pinned legacy format");

  console.log("verify-visual-format-write-boundary: PASS active writes and legacy reads");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
