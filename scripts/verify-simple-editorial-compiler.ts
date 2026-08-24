import assert from "node:assert/strict";
import {
  TREATMENT_PRESET_IDS,
  createCatalogTreatmentPin,
} from "../src/lib/brand-treatment-catalog";
import { compileBrandVisualPrompt } from "../src/lib/brand-visual-system";

const expectedMoodByTreatment = {
  "expert-clarity": /calm authority and ordered visual hierarchy/i,
  "practical-documentary": /grounded everyday action and direct visual sequence/i,
  "thai-human-drama": /intimate human emotion and warm relational spacing/i,
  "modern-business-technology": /confident momentum and clean organized composition/i,
  "premium-product-lifestyle": /refined restraint, selective highlights and generous negative space/i,
  "investigative-news-crime": /sober tension and evidence-led visual focus/i,
  "thai-history-period-storytelling": /dignified period atmosphere and clearly staged historical detail/i,
  "thai-supernatural-horror": /nocturnal dread and escalating shadow shapes/i,
} as const;

for (const treatmentPresetId of TREATMENT_PRESET_IDS) {
  const compiled = compileBrandVisualPrompt({
    visualFormatId: "simple-editorial-story",
    treatmentPin: createCatalogTreatmentPin(treatmentPresetId, "adaptive"),
    contentDomain: "a general narrative",
    visualBeat: {
      phase: "explain",
      subject: "an adult Thai shop owner and three parcels",
      action: "the shop owner arranges the parcels into three stages",
      setting: "a compact home-business studio in daylight",
      emotion: "focused confidence",
      emphasis: "the visible sequence from first parcel to third parcel",
      hardSceneFacts: {
        entityTypes: ["adult Thai shop owner"],
        ages: ["adult"],
        genders: [],
        actions: ["arranges parcels into three stages"],
        locationTypes: ["home-business studio"],
        timeOfDay: "day",
        historicalPeriod: null,
        count: 1,
        essentialObjects: ["exactly three parcels"],
      },
      entityRenderingDescriptions: ["an adult Thai human shop owner in plain work clothes"],
      sceneIntensity: "measured explanation",
      safetyBoundary: "none",
    },
    brandVisualLanguage: null,
  });

  assert.equal(compiled.recipeVersion, "simple-editorial-story-v11");
  assert.match(compiled.positive, /full-frame flat editorial story illustration/i);
  assert.match(compiled.positive, /filled simplified shapes with clean drawn contours/i);
  assert.match(compiled.positive, /scene action and object relationships carry the meaning/i);
  assert.match(compiled.positive, expectedMoodByTreatment[treatmentPresetId]);
  assert.match(compiled.positive, /exactly 1 adult Thai shop owner appears/i);
  assert.match(compiled.positive, /an adult Thai human shop owner in plain work clothes/i);
  assert.doesNotMatch(compiled.positive, /circular-head|line-body|stick-figure|documentary storytelling|tactile desirability|photorealistic|35mm|real human anatomy/i,
    "the replacement format must not inherit the brittle stick geometry or photographic treatment vocabulary");
  assert.ok(
    compiled.positive.indexOf("Hard scene facts:")
      < compiled.positive.indexOf("Visual format direction:"),
    "hard facts remain ahead of the replacement art direction",
  );
}

const countSafeHistory = compileBrandVisualPrompt({
  visualFormatId: "simple-editorial-story",
  contentDomain: "Thai history education",
  treatmentPin: createCatalogTreatmentPin("thai-history-period-storytelling", "adaptive"),
  visualBeat: {
    phase: "hook",
    subject: "a wooden trading boat and an ancient riverside city",
    action: "approaches a busy river gate",
    setting: "the Chao Phraya river near Ayutthaya",
    emotion: "awe and curiosity",
    emphasis: "the scale of river trade",
    hardSceneFacts: {
      entityTypes: ["wooden trading boat"],
      ages: [], genders: [], actions: ["approaches a river gate"],
      locationTypes: ["Ayutthaya riverside"], timeOfDay: "morning",
      historicalPeriod: "Ayutthaya period", count: 1,
      essentialObjects: ["wooden boat", "river gate"],
    },
    entityRenderingDescriptions: [],
    sceneIntensity: "grand reveal",
    safetyBoundary: "none",
  },
});
assert.match(
  countSafeHistory.positive,
  /Count-safe flexible scene direction: one compact story group contains the complete visible counted set of exactly 1 wooden trading boat/i,
);
assert.doesNotMatch(countSafeHistory.positive, /busy river gate|scale of river trade/i,
  "current prompts derive counted scenes from Hard Scene Facts instead of contradictory flexible wording");

const frozenEditorialV7 = compileBrandVisualPrompt({
  visualFormatId: "simple-editorial-story",
  recipeVersion: "simple-editorial-story-v7",
  contentDomain: "Thai history education",
  treatmentPin: createCatalogTreatmentPin("thai-history-period-storytelling", "adaptive"),
  visualBeat: {
    phase: "hook",
    subject: "a wooden trading boat and an ancient riverside city",
    action: "approaches a busy river gate",
    setting: "the Chao Phraya river near Ayutthaya",
    emotion: "awe and curiosity",
    emphasis: "the scale of river trade",
    hardSceneFacts: {
      entityTypes: ["wooden trading boat"], ages: [], genders: [],
      actions: ["approaches a river gate"], locationTypes: ["Ayutthaya riverside"],
      timeOfDay: "morning", historicalPeriod: "Ayutthaya period", count: 1,
      essentialObjects: ["wooden boat", "river gate"],
    },
    entityRenderingDescriptions: [], sceneIntensity: "grand reveal", safetyBoundary: "none",
  },
});
assert.equal(frozenEditorialV7.recipeVersion, "simple-editorial-story-v7");
assert.match(frozenEditorialV7.positive, /busy river gate|scale of river trade/i,
  "the paid v7 evidence remains reproducible after v8 becomes active");

const dryRepairBeat = {
  phase: "close" as const,
  subject: "an adult Thai renter and a dry kitchen sink",
  action: "checks that the repaired tap has stopped dripping",
  setting: "the same compact kitchen",
  emotion: "relieved",
  emphasis: "the verified everyday result",
  hardSceneFacts: {
    entityTypes: ["adult Thai renter"], ages: ["adult"], genders: [],
    actions: ["checks that the repaired tap has stopped dripping"],
    locationTypes: ["home kitchen"], timeOfDay: "day", historicalPeriod: null,
    count: 1, essentialObjects: ["dry repaired tap"],
  },
  entityRenderingDescriptions: ["an adult Thai human renter wearing practical casual clothing"],
  sceneIntensity: "satisfying close",
  safetyBoundary: "none" as const,
};
const dryRepair = compileBrandVisualPrompt({
  visualFormatId: "simple-editorial-story",
  contentDomain: "practical home skills",
  treatmentPin: createCatalogTreatmentPin("practical-documentary", "adaptive"),
  visualBeat: dryRepairBeat,
});
assert.match(dryRepair.positive, /stands upright beside the completed kitchen sink with both hands relaxed at their sides/i);
assert.match(dryRepair.positive, /matte dry repaired tap above a matte dry sink basin/i);
assert.doesNotMatch(dryRepair.positive, /dripping|drops?|water|flowing|\bchecks\b|inspection|controls?/i,
  "the current tableau describes only the completed result and keeps hands away from the mechanism");

const frozenEditorialV9DryRepair = compileBrandVisualPrompt({
  visualFormatId: "simple-editorial-story",
  recipeVersion: "simple-editorial-story-v9",
  contentDomain: "practical home skills",
  treatmentPin: createCatalogTreatmentPin("practical-documentary", "adaptive"),
  visualBeat: dryRepairBeat,
});
assert.match(frozenEditorialV9DryRepair.positive, /checks the dry and motionless repaired tap/i,
  "the paid v9 prompt remains immutable after the completed-tableau compiler advances");

const frozenEditorialV8DryRepair = compileBrandVisualPrompt({
  visualFormatId: "simple-editorial-story",
  recipeVersion: "simple-editorial-story-v8",
  contentDomain: "practical home skills",
  treatmentPin: createCatalogTreatmentPin("practical-documentary", "adaptive"),
  visualBeat: dryRepairBeat,
});
assert.match(frozenEditorialV8DryRepair.positive, /has stopped dripping/i,
  "the paid v8 prompt remains immutable after the positive-only state compiler advances");

const letteringSafeBusiness = compileBrandVisualPrompt({
  visualFormatId: "simple-editorial-story",
  contentDomain: "small business technology",
  treatmentPin: createCatalogTreatmentPin("modern-business-technology", "adaptive"),
  visualBeat: {
    phase: "explain",
    subject: "an adult Thai shop owner and an abstract inventory dashboard",
    action: "organizes orders into three clear stages",
    setting: "a compact home-business studio",
    emotion: "focused confidence",
    emphasis: "the orderly workflow",
    hardSceneFacts: {
      entityTypes: ["adult Thai shop owner"], ages: ["adult"], genders: [],
      actions: ["organizes orders into three stages"], locationTypes: ["home-business studio"],
      timeOfDay: "day", historicalPeriod: null, count: 1,
      essentialObjects: ["laptop", "three unlabeled workflow cards"],
    },
    entityRenderingDescriptions: ["an adult Thai human online shop owner in contemporary casual workwear"],
    sceneIntensity: "precise explanation", safetyBoundary: "none",
  },
});
assert.match(letteringSafeBusiness.positive, /Lettering-safe visual plan:/i);
assert.match(
  letteringSafeBusiness.positive,
  /exactly three blank solid-color workflow tiles distinguished by color and simple object silhouettes/i,
);
assert.doesNotMatch(letteringSafeBusiness.positive, /dashboard|workflow cards/i,
  "text-inviting abstract UI language is replaced by blank physical visual relationships");

const letteringSafeNews = compileBrandVisualPrompt({
  visualFormatId: "simple-editorial-story",
  contentDomain: "public-interest investigative report",
  treatmentPin: createCatalogTreatmentPin("investigative-news-crime", "adaptive"),
  visualBeat: {
    phase: "explain",
    subject: "two fictional analyst silhouettes and a wall of abstract evidence shapes",
    action: "compare a timeline with public records",
    setting: "an anonymous newsroom research room",
    emotion: "methodical concern",
    emphasis: "verification rather than accusation",
    hardSceneFacts: {
      entityTypes: ["fictional analyst silhouettes"], ages: ["adult"], genders: [],
      actions: ["compare a timeline with records"], locationTypes: ["newsroom research room"],
      timeOfDay: "night", historicalPeriod: null, count: 2,
      essentialObjects: ["timeline", "public-record shapes"],
    },
    entityRenderingDescriptions: ["two non-identifying fictional adult human analyst silhouettes shown from behind"],
    sceneIntensity: "methodical investigation", safetyBoundary: "real-person-context-only",
  },
});
assert.match(letteringSafeNews.positive, /unlettered horizontal sequence of solid circular markers/i);
assert.match(letteringSafeNews.positive, /blank evidence tiles using simple object silhouettes/i);
assert.doesNotMatch(letteringSafeNews.positive, /\btimeline\b|public[- ]records?/i,
  "evidence relationships stay contextual without prompting generated document lettering");

console.log("verify-simple-editorial-compiler: PASS coherent format-specific treatment translation");
