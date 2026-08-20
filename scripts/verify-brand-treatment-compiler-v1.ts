import assert from "node:assert/strict";
import { createCatalogTreatmentPin } from "../src/lib/brand-treatment-catalog";
import {
  VISUAL_FORMATS,
  compileBrandVisualPrompt,
} from "../src/lib/brand-visual-system";

const realism = VISUAL_FORMATS.find((format) => format.id === "cinematic-realism")!;
assert.deepEqual(
  Object.fromEntries(VISUAL_FORMATS.map((format) => [format.id, format.recipeVersion])),
  {
    "cinematic-realism": "cinematic-realism-v10",
    "simple-editorial-story": "simple-editorial-story-v11",
    "dramatic-comic": "dramatic-comic-v9",
    "clear-infographic": "clear-infographic-v9",
    "retro-story": "retro-story-v9",
  },
  "new projects use the relational hard-fact compiler while historical recipe pins remain addressable",
);

const treatmentPin = createCatalogTreatmentPin("thai-supernatural-horror", "adaptive");
const compiled = compileBrandVisualPrompt({
  visualFormatId: realism.id,
  recipeVersion: realism.recipeVersion,
  contentDomain: "Thai supernatural family story",
  treatmentPin,
  visualBeat: {
    phase: "hook",
    subject: "the recurring mourner",
    action: "stands beside the coffin",
    setting: "a rural Thai funeral pavilion at night",
    emotion: "growing dread",
    emphasis: "a human mourner sensing a presence",
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
    entityRenderingDescriptions: ["an adult Thai human man with short black hair and a plain black funeral shirt"],
    sceneIntensity: "escalating tension",
    safetyBoundary: "none",
  },
  brandVisualLanguage: {
    palette: ["deep charcoal", "warm off-white"],
    personality: "bold, raw and direct",
    memorableCues: [],
    visualNotes: "high contrast and a documentary lens",
  },
});

assert.equal(compiled.treatmentPin?.presetId, "thai-supernatural-horror");
assert.equal(compiled.treatmentPin?.version, treatmentPin.version);
assert.doesNotMatch(compiled.positive, /\bKong\b/i, "proper names never become provider subjects");
assert.match(compiled.positive, /an adult Thai human man with short black hair/);
assert.match(compiled.positive, /night/);
assert.match(compiled.positive, /rural Thai funeral pavilion/);
assert.match(compiled.positive, /frightening Thai supernatural horror/);
assert.match(compiled.positive, /escalating tension/);
assert.match(compiled.positive, /exactly 1 adult Thai human man appears in the complete frame/i);
assert.match(compiled.positive, /each stated essential object and quantity is clearly visible: coffin/i);

const frozenV4 = compileBrandVisualPrompt({
  visualFormatId: realism.id,
  recipeVersion: "cinematic-realism-v4",
  contentDomain: "Thai supernatural family story",
  treatmentPin,
  visualBeat: {
    phase: "hook",
    subject: "an adult Thai mourner",
    action: "stands beside a coffin",
    setting: "a rural funeral pavilion at night",
    emotion: "dread",
    emphasis: "the moving shadow",
    hardSceneFacts: {
      entityTypes: ["adult Thai human man"], ages: ["adult"], genders: ["man"],
      actions: ["stands beside the coffin"], locationTypes: ["funeral pavilion"],
      timeOfDay: "night", historicalPeriod: null, count: 1, essentialObjects: ["coffin"],
    },
    entityRenderingDescriptions: ["an adult Thai human man in plain black funeral clothing"],
    sceneIntensity: "escalating tension",
    safetyBoundary: "none",
  },
});
assert.equal(frozenV4.recipeVersion, "cinematic-realism-v4");
assert.doesNotMatch(frozenV4.positive, /Final hard-fact check:/,
  "an already-pinned v4 recipe remains byte-behavior compatible after v5 publishes");

const hardFactsAt = compiled.positive.indexOf("Hard scene facts:");
const entityAt = compiled.positive.indexOf("Entity rendering descriptions:");
const flexibleAt = compiled.positive.indexOf("Count-safe flexible scene direction:");
const treatmentAt = compiled.positive.indexOf("Treatment direction:");
const formatAt = compiled.positive.indexOf("Visual format direction:");
const brandAt = compiled.positive.indexOf("Brand rendering direction:");
assert.ok(hardFactsAt >= 0 && hardFactsAt < entityAt);
assert.ok(entityAt < formatAt && formatAt < flexibleAt,
  "the current compiler locks the visual medium after semantic entities and before count-safe direction");
assert.ok(flexibleAt < treatmentAt && treatmentAt < brandAt);

const medical = compileBrandVisualPrompt({
  visualFormatId: "clear-infographic",
  contentDomain: "preventive medicine",
  treatmentPin: createCatalogTreatmentPin("expert-clarity", "adaptive"),
  visualBeat: {
    phase: "explain",
    subject: "an adult patient and a clinician",
    action: "discuss a general daily health habit",
    setting: "a clinic consultation room",
    emotion: "calm",
    emphasis: "conceptual explanation",
    hardSceneFacts: {
      entityTypes: ["adult patient", "clinician"], ages: ["adult"], genders: [],
      actions: ["discuss a health habit"], locationTypes: ["clinic"], timeOfDay: null,
      historicalPeriod: null, count: 2, essentialObjects: [],
    },
    entityRenderingDescriptions: [],
    sceneIntensity: "restrained explanation",
    safetyBoundary: "medical-illustration",
  },
});
assert.match(medical.positive, /illustrative editorial concept/i);
assert.match(medical.positive, /deterministic copy/i);
assert.match(medical.positive, /wide uninterrupted background color surrounds every pictogram/i);

const realPerson = compileBrandVisualPrompt({
  visualFormatId: "dramatic-comic",
  contentDomain: "investigative news",
  treatmentPin: createCatalogTreatmentPin("investigative-news-crime", "adaptive"),
  visualBeat: {
    phase: "hook",
    subject: "an empty interview room and sealed evidence folders",
    action: "a desk lamp illuminates the folders",
    setting: "an unoccupied investigative office",
    emotion: "sober tension",
    emphasis: "context rather than alleged conduct",
    hardSceneFacts: {
      entityTypes: ["empty chair"], ages: [], genders: [], actions: [], locationTypes: ["investigative office"],
      timeOfDay: null, historicalPeriod: null, count: null, essentialObjects: ["sealed evidence folders"],
    },
    entityRenderingDescriptions: [],
    sceneIntensity: "restrained tension",
    safetyBoundary: "real-person-context-only",
  },
});
assert.match(realPerson.positive, /non-identifying contextual imagery/i);
assert.match(realPerson.positive, /investigative context is carried entirely by the unoccupied room and evidence objects/i);
assert.doesNotMatch(realPerson.positive, /fictional silhouettes/i);
assert.match(realPerson.positive, /empty chair is visibly unoccupied and the investigative room is carried by objects/i);

const stickFigure = compileBrandVisualPrompt({
  visualFormatId: "stick-figure-story",
  contentDomain: "practical repair",
  treatmentPin: createCatalogTreatmentPin("practical-documentary", "adaptive"),
  visualBeat: {
    phase: "explain",
    subject: "two adult hands and a tap valve",
    action: "tighten a fitting",
    setting: "a kitchen sink",
    emotion: "focused",
    emphasis: "the hand movement",
    hardSceneFacts: {
      entityTypes: ["adult human hands"], ages: ["adult"], genders: [],
      actions: ["tighten a fitting"], locationTypes: ["kitchen sink"], timeOfDay: "day",
      historicalPeriod: null, count: 2, essentialObjects: ["small wrench", "tap valve"],
    },
    entityRenderingDescriptions: [],
    sceneIntensity: "clear demonstration",
    safetyBoundary: "none",
  },
});
assert.match(stickFigure.positive, /full-frame stick-figure marker doodle on warm fibrous paper/i);
assert.match(stickFigure.positive, /every story entity appears as a circular head joined to one straight-line torso and single-line limbs/i);
assert.doesNotMatch(stickFigure.positive, /no photographic|not realistic|without photographic/i,
  "v6 describes only the medium to render instead of naming a medium to suppress");

const semanticStickFigure = compileBrandVisualPrompt({
  visualFormatId: "stick-figure-story",
  contentDomain: "Thai supernatural story",
  treatmentPin,
  visualBeat: {
    phase: "explain",
    subject: "an adult Thai human man",
    action: "stands beside a coffin",
    setting: "a funeral pavilion at night",
    emotion: "dread",
    emphasis: "the moving shadow",
    hardSceneFacts: {
      entityTypes: ["adult Thai human man"], ages: ["adult"], genders: ["man"],
      actions: ["stands beside a coffin"], locationTypes: ["funeral pavilion"],
      timeOfDay: "night", historicalPeriod: null, count: 1, essentialObjects: ["closed coffin"],
    },
    entityRenderingDescriptions: ["an adult Thai human man with short black hair wearing plain black funeral clothing"],
    sceneIntensity: "escalating tension",
    safetyBoundary: "none",
  },
});
assert.match(semanticStickFigure.positive, /a circular-head line-body figure representing an adult Thai human man/i);

for (const format of VISUAL_FORMATS.filter((candidate) => candidate.id !== "simple-editorial-story")) {
  const currentCountSafe = compileBrandVisualPrompt({
    visualFormatId: format.id,
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
  assert.equal(currentCountSafe.recipeVersion, format.recipeVersion,
    `${format.id} must pin the count-safe compiler for new projects`);
  assert.match(currentCountSafe.positive, /Count-safe flexible scene direction:/i);
  assert.match(
    currentCountSafe.positive,
    /all foreground, midground and background appearances of wooden trading boat belong to this same closed counted set/i,
    `${format.id} must close the counted cast across the whole frame`,
  );
  assert.match(
    currentCountSafe.positive,
    /all remaining image areas continue the stated location through open negative space, broad material surfaces and light/i,
  );
  assert.doesNotMatch(currentCountSafe.positive, /busy river gate|scale of river trade/i);
}

const frozenCinematicV6 = compileBrandVisualPrompt({
  visualFormatId: "cinematic-realism",
  recipeVersion: "cinematic-realism-v6",
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
assert.match(frozenCinematicV6.positive, /busy river gate|scale of river trade/i,
  "paid v6 evidence remains reproducible after the count-safe recipe bump");

console.log("verify-brand-treatment-compiler-v1: PASS hard facts first, semantic entities, pinned treatment and safety boundaries");
