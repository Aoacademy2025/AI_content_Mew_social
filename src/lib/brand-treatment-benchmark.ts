import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  TREATMENT_PRESET_IDS,
  createCatalogTreatmentPin,
} from "@/lib/brand-treatment-catalog";
import {
  LEGACY_VISUAL_FORMATS,
  VISUAL_FORMATS,
  compileBrandVisualPrompt,
  type CompiledBrandVisualPrompt,
  type VisualFormatId,
} from "@/lib/brand-visual-system";

const hardSceneFactsSchema = z.object({
  entityTypes: z.array(z.string().min(1)),
  ages: z.array(z.string().min(1)),
  genders: z.array(z.string().min(1)),
  actions: z.array(z.string().min(1)),
  locationTypes: z.array(z.string().min(1)),
  timeOfDay: z.string().min(1).nullable(),
  historicalPeriod: z.string().min(1).nullable(),
  count: z.number().int().positive().nullable(),
  essentialObjects: z.array(z.string().min(1)),
});

const fixtureSceneSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** Internal linkage-only ambiguity token retained by ADR 0010. It is never
   * copied into the provider-facing Visual Beat. */
  internalProperName: z.string().min(1).max(160).optional(),
  phase: z.enum(["hook", "explain", "close"]),
  subject: z.string().min(1),
  action: z.string().min(1),
  setting: z.string().min(1),
  emotion: z.string().min(1),
  emphasis: z.string().min(1),
  hardSceneFacts: hardSceneFactsSchema,
  entityRenderingDescriptions: z.array(z.string().min(1)),
  sceneIntensity: z.string().min(1),
  safetyBoundary: z.enum(["none", "medical-illustration", "real-person-context-only"]),
});

const fixtureSchema = z.object({
  treatmentPresetId: z.enum(TREATMENT_PRESET_IDS),
  contentDomain: z.string().min(1),
  scenes: z.array(fixtureSceneSchema).length(3),
});

const fixtureSetSchema = z.array(fixtureSchema).length(8).superRefine((fixtures, context) => {
  const ids = fixtures.map((fixture) => fixture.treatmentPresetId);
  if (new Set(ids).size !== TREATMENT_PRESET_IDS.length) {
    context.addIssue({ code: "custom", message: "Benchmark must contain each treatment exactly once" });
  }
  fixtures.forEach((fixture, index) => {
    if (new Set(fixture.scenes.map((scene) => scene.phase)).size !== 3) {
      context.addIssue({ code: "custom", path: [index, "scenes"], message: "Fixture needs hook, explain and close" });
    }
  });
});

export type BrandTreatmentBenchmarkFixture = z.infer<typeof fixtureSchema>;

export function loadBrandTreatmentBenchmarkFixtures(
  path = join(process.cwd(), "benchmarks", "brand-treatment-v1.json"),
): BrandTreatmentBenchmarkFixture[] {
  return fixtureSetSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export type BrandTreatmentBenchmarkCase = {
  id: string;
  fixtureSceneId: string;
  treatmentPresetId: BrandTreatmentBenchmarkFixture["treatmentPresetId"];
  visualFormatId: VisualFormatId;
  compiled: CompiledBrandVisualPrompt;
};

export function buildBrandTreatmentBenchmarkCases(
  fixtures = loadBrandTreatmentBenchmarkFixtures(),
): BrandTreatmentBenchmarkCase[] {
  return buildBenchmarkCasesForFormats(fixtures, VISUAL_FORMATS);
}

type BenchmarkFormatPin = Readonly<{
  id: VisualFormatId;
  recipeVersion: string;
}>;

function buildBenchmarkCasesForFormats(
  fixtures: BrandTreatmentBenchmarkFixture[],
  formats: readonly BenchmarkFormatPin[],
): BrandTreatmentBenchmarkCase[] {
  return fixtures.flatMap((fixture) => {
    const treatmentPin = createCatalogTreatmentPin(fixture.treatmentPresetId, "adaptive");
    return formats.flatMap((format) => fixture.scenes.map((scene) => ({
      id: `${fixture.treatmentPresetId}__${format.id}__${scene.id}`,
      fixtureSceneId: scene.id,
      treatmentPresetId: fixture.treatmentPresetId,
      visualFormatId: format.id,
      compiled: compileBrandVisualPrompt({
        visualFormatId: format.id,
        recipeVersion: format.recipeVersion,
        contentDomain: fixture.contentDomain,
        treatmentPin,
        visualBeat: scene,
        brandVisualLanguage: null,
      }),
    })));
  });
}

const FROZEN_V6_FORMATS: readonly BenchmarkFormatPin[] = [
  { id: "cinematic-realism", recipeVersion: "cinematic-realism-v6" },
  { id: "stick-figure-story", recipeVersion: "stick-figure-story-v6" },
  { id: "dramatic-comic", recipeVersion: "dramatic-comic-v6" },
  { id: "clear-infographic", recipeVersion: "clear-infographic-v6" },
  { id: "retro-story", recipeVersion: "retro-story-v6" },
];

const FROZEN_EDITORIAL_V7_FORMATS: readonly BenchmarkFormatPin[] = [
  { id: "cinematic-realism", recipeVersion: "cinematic-realism-v6" },
  { id: "simple-editorial-story", recipeVersion: "simple-editorial-story-v7" },
  { id: "dramatic-comic", recipeVersion: "dramatic-comic-v6" },
  { id: "clear-infographic", recipeVersion: "clear-infographic-v6" },
  { id: "retro-story", recipeVersion: "retro-story-v6" },
];

const FROZEN_V8_FORMATS: readonly BenchmarkFormatPin[] = [
  { id: "cinematic-realism", recipeVersion: "cinematic-realism-v7" },
  { id: "simple-editorial-story", recipeVersion: "simple-editorial-story-v8" },
  { id: "dramatic-comic", recipeVersion: "dramatic-comic-v7" },
  { id: "clear-infographic", recipeVersion: "clear-infographic-v7" },
  { id: "retro-story", recipeVersion: "retro-story-v7" },
];

const FROZEN_V9_FORMATS: readonly BenchmarkFormatPin[] = [
  { id: "cinematic-realism", recipeVersion: "cinematic-realism-v8" },
  { id: "simple-editorial-story", recipeVersion: "simple-editorial-story-v9" },
  { id: "dramatic-comic", recipeVersion: "dramatic-comic-v8" },
  { id: "clear-infographic", recipeVersion: "clear-infographic-v8" },
  { id: "retro-story", recipeVersion: "retro-story-v8" },
];

const FROZEN_V10_FORMATS: readonly BenchmarkFormatPin[] = [
  { id: "cinematic-realism", recipeVersion: "cinematic-realism-v8" },
  { id: "simple-editorial-story", recipeVersion: "simple-editorial-story-v10" },
  { id: "dramatic-comic", recipeVersion: "dramatic-comic-v8" },
  { id: "clear-infographic", recipeVersion: "clear-infographic-v8" },
  { id: "retro-story", recipeVersion: "retro-story-v8" },
];

/** Reconstruct the source semantics used by every paid suite before the V11
 * relational repair. Current fixtures retain more source meaning, while these
 * exact earlier projections keep historical prompts replayable. */
function freezeRelationalHardFactsBeforeV11(
  scene: BrandTreatmentBenchmarkFixture["scenes"][number],
): BrandTreatmentBenchmarkFixture["scenes"][number] {
  if (scene.id === "drama-bus-close") {
    return {
      ...scene,
      hardSceneFacts: {
        ...scene.hardSceneFacts,
        actions: ["walk home together"],
        essentialObjects: ["cloth bag"],
      },
    };
  }
  if (scene.id === "premium-serum-explain") {
    return {
      ...scene,
      hardSceneFacts: {
        ...scene.hardSceneFacts,
        entityTypes: ["adult human hands", "skincare bottle"],
        actions: ["dispense one clear drop"],
        essentialObjects: ["amber bottle", "clear drop"],
      },
    };
  }
  if (scene.id === "news-files-hook") {
    return {
      ...scene,
      hardSceneFacts: {
        ...scene.hardSceneFacts,
        entityTypes: ["case folders", "empty chair"],
        actions: ["sit beneath a desk lamp"],
        essentialObjects: ["sealed folders", "desk lamp"],
      },
    };
  }
  if (scene.id === "horror-house-close") {
    return {
      ...scene,
      hardSceneFacts: {
        ...scene.hardSceneFacts,
        actions: ["closes the wooden door"],
        essentialObjects: ["oil lamp", "wooden door"],
      },
    };
  }
  return scene;
}

function loadFrozenPreV11BenchmarkFixtures(): BrandTreatmentBenchmarkFixture[] {
  return loadBrandTreatmentBenchmarkFixtures().map((fixture) => ({
    ...fixture,
    scenes: fixture.scenes.map(freezeRelationalHardFactsBeforeV11),
  }));
}

function freezeWaterGlassBeforeV9(
  scene: BrandTreatmentBenchmarkFixture["scenes"][number],
): BrandTreatmentBenchmarkFixture["scenes"][number] {
  return scene.id === "expert-clinic-explain"
    ? {
        ...scene,
        subject: "an adult Thai clinician, a water glass and three abstract health-state circles",
        hardSceneFacts: {
          ...scene.hardSceneFacts,
          essentialObjects: ["water glass", "three abstract circles"],
        },
      }
    : scene;
}

/** The v8 fixture moved the completed dry-tap result into Hard Scene Facts.
 * Historical paid suites must retain the exact earlier fixture semantics so
 * their stored provider prompts remain reproducible. */
function loadFrozenPreV8BenchmarkFixtures(): BrandTreatmentBenchmarkFixture[] {
  return loadFrozenPreV11BenchmarkFixtures().map((fixture) => ({
    ...fixture,
    scenes: fixture.scenes.map((sourceScene) => {
      const scene = freezeWaterGlassBeforeV9(sourceScene);
      return scene.id === "documentary-repair-close"
      ? {
          ...scene,
          hardSceneFacts: {
            ...scene.hardSceneFacts,
            actions: ["checks the repaired tap"],
            essentialObjects: ["repaired tap"],
          },
        }
      : scene;
    }),
  }));
}

function loadFrozenV8BenchmarkFixtures(): BrandTreatmentBenchmarkFixture[] {
  return loadFrozenPreV11BenchmarkFixtures().map((fixture) => ({
    ...fixture,
    scenes: fixture.scenes.map(freezeWaterGlassBeforeV9),
  }));
}

function buildBrandTreatmentV6BenchmarkCases(
  fixtures = loadFrozenPreV8BenchmarkFixtures(),
): BrandTreatmentBenchmarkCase[] {
  const legacyStickFigureAvailable = LEGACY_VISUAL_FORMATS.some((format) => format.id === "stick-figure-story");
  if (!legacyStickFigureAvailable) throw new Error("Frozen Stick Figure format is unavailable");
  return buildBenchmarkCasesForFormats(fixtures, FROZEN_V6_FORMATS);
}

function buildBrandTreatmentEditorialV7BenchmarkCases(
  fixtures = loadFrozenPreV8BenchmarkFixtures(),
): BrandTreatmentBenchmarkCase[] {
  return buildBenchmarkCasesForFormats(fixtures, FROZEN_EDITORIAL_V7_FORMATS);
}

function buildBrandTreatmentV8BenchmarkCases(
  fixtures = loadFrozenV8BenchmarkFixtures(),
): BrandTreatmentBenchmarkCase[] {
  return buildBenchmarkCasesForFormats(fixtures, FROZEN_V8_FORMATS);
}

function buildBrandTreatmentV9BenchmarkCases(
  fixtures = loadFrozenPreV11BenchmarkFixtures(),
): BrandTreatmentBenchmarkCase[] {
  return buildBenchmarkCasesForFormats(fixtures, FROZEN_V9_FORMATS);
}

export function buildBrandTreatmentV10BenchmarkCases(
  fixtures = loadFrozenPreV11BenchmarkFixtures(),
): BrandTreatmentBenchmarkCase[] {
  return buildBenchmarkCasesForFormats(fixtures, FROZEN_V10_FORMATS);
}

const V6_SMOKE_REGRESSION_CASE_IDS = new Set([
  "expert-clarity__cinematic-realism__expert-clinic-explain",
  "expert-clarity__dramatic-comic__expert-clinic-hook",
  "practical-documentary__clear-infographic__documentary-repair-hook",
  "modern-business-technology__clear-infographic__business-orders-hook",
]);

/** Curated paid smoke gate for the exact v4/v5 qualification failures. It covers
 * all three scenes for every Stick Figure pairing, the one-boat count stress
 * case in each other History format, and four focused hard-fact/lettering
 * regressions. Passing this 32-case gate is necessary but not sufficient; the
 * accepted ADR still requires the complete 120-case matrix before release. */
export function buildBrandTreatmentV6SmokeCases(
  cases = buildBrandTreatmentV6BenchmarkCases(),
): BrandTreatmentBenchmarkCase[] {
  const selected = cases.filter((entry) => (
    entry.visualFormatId === "stick-figure-story"
    || (
      entry.treatmentPresetId === "thai-history-period-storytelling"
      && entry.fixtureSceneId === "history-river-hook"
    )
    || V6_SMOKE_REGRESSION_CASE_IDS.has(entry.id)
  ));
  if (selected.length !== 32 || selected.some((entry) => !entry.compiled.recipeVersion.endsWith("-v6"))) {
    throw new Error("V6 smoke matrix must contain exactly 32 current-recipe cases");
  }
  return selected;
}

/** Paid smoke gate for the approved Simple Editorial Story replacement. The
 * matrix retains the exact v6 regression coverage while substituting all 24
 * treatment/scene Stick Figure cases with the active editorial format. */
export function buildBrandTreatmentEditorialV7SmokeCases(
  cases = buildBrandTreatmentEditorialV7BenchmarkCases(),
): BrandTreatmentBenchmarkCase[] {
  const selected = cases.filter((entry) => (
    entry.visualFormatId === "simple-editorial-story"
    || (
      entry.treatmentPresetId === "thai-history-period-storytelling"
      && entry.fixtureSceneId === "history-river-hook"
    )
    || V6_SMOKE_REGRESSION_CASE_IDS.has(entry.id)
  ));
  const editorialCases = selected.filter((entry) => entry.visualFormatId === "simple-editorial-story");
  if (
    selected.length !== 32
    || editorialCases.length !== 24
    || editorialCases.some((entry) => entry.compiled.recipeVersion !== "simple-editorial-story-v7")
  ) {
    throw new Error("Editorial v7 smoke matrix must contain 24 editorial and 8 focused current-recipe cases");
  }
  return selected;
}

const HARD_FACTS_LETTERING_V8_PROBE_CASE_IDS = new Set([
  "thai-history-period-storytelling__cinematic-realism__history-river-hook",
  "thai-history-period-storytelling__simple-editorial-story__history-river-hook",
  "thai-history-period-storytelling__dramatic-comic__history-river-hook",
  "thai-history-period-storytelling__clear-infographic__history-river-hook",
  "thai-history-period-storytelling__retro-story__history-river-hook",
  "expert-clarity__simple-editorial-story__expert-clinic-explain",
  "practical-documentary__simple-editorial-story__documentary-repair-close",
  "expert-clarity__simple-editorial-story__expert-clinic-close",
  "modern-business-technology__simple-editorial-story__business-orders-explain",
  "investigative-news-crime__simple-editorial-story__news-files-explain",
  "modern-business-technology__clear-infographic__business-orders-hook",
  "practical-documentary__clear-infographic__documentary-repair-hook",
]);

/** Focused paid qualification after the editorial-v7 visual review. This is a
 * current-recipe probe, not an automatic retry: it exercises the exact-count,
 * lettering and completed-action regressions that failed the prior gate. */
export function buildBrandTreatmentHardFactsLetteringV8ProbeCases(
  cases = buildBrandTreatmentV8BenchmarkCases(),
): BrandTreatmentBenchmarkCase[] {
  const selected = cases.filter((entry) => HARD_FACTS_LETTERING_V8_PROBE_CASE_IDS.has(entry.id));
  if (
    selected.length !== HARD_FACTS_LETTERING_V8_PROBE_CASE_IDS.size
    || selected.some((entry) => !(
      entry.compiled.recipeVersion.endsWith("-v7")
      || entry.compiled.recipeVersion === "simple-editorial-story-v8"
    ))
  ) {
    throw new Error("Hard-facts and lettering v8 probe must contain exactly 12 current-recipe cases");
  }
  return selected;
}


const POSITIVE_ONLY_V9_PROBE_CASE_IDS = new Set([
  "thai-history-period-storytelling__cinematic-realism__history-river-hook",
  "thai-history-period-storytelling__simple-editorial-story__history-river-hook",
  "thai-history-period-storytelling__dramatic-comic__history-river-hook",
  "thai-history-period-storytelling__clear-infographic__history-river-hook",
  "thai-history-period-storytelling__retro-story__history-river-hook",
  "expert-clarity__simple-editorial-story__expert-clinic-explain",
  "practical-documentary__simple-editorial-story__documentary-repair-close",
  "modern-business-technology__clear-infographic__business-orders-hook",
]);

/** Approved focused qualification for the three v8 visual-review failures,
 * plus the exact-one-boat regression across every newly published recipe. */
export function buildBrandTreatmentPositiveOnlyV9ProbeCases(
  cases = buildBrandTreatmentV9BenchmarkCases(),
): BrandTreatmentBenchmarkCase[] {
  const selected = cases.filter((entry) => POSITIVE_ONLY_V9_PROBE_CASE_IDS.has(entry.id));
  if (
    selected.length !== POSITIVE_ONLY_V9_PROBE_CASE_IDS.size
    || selected.some((entry) => !(
      entry.compiled.recipeVersion.endsWith("-v8")
      || entry.compiled.recipeVersion === "simple-editorial-story-v9"
    ))
  ) {
    throw new Error("Positive-only v9 probe must contain exactly 8 current-recipe cases");
  }
  return selected;
}

const COMPLETED_STATE_V10_PROBE_CASE_ID =
  "practical-documentary__simple-editorial-story__documentary-repair-close";

/** Single-case paid qualification for the only remaining v9 strict failure. */
export function buildBrandTreatmentCompletedStateV10ProbeCases(
  cases = buildBrandTreatmentV10BenchmarkCases(),
): BrandTreatmentBenchmarkCase[] {
  const selected = cases.filter((entry) => entry.id === COMPLETED_STATE_V10_PROBE_CASE_ID);
  if (
    selected.length !== 1
    || selected[0]?.compiled.recipeVersion !== "simple-editorial-story-v10"
  ) {
    throw new Error("Completed-state v10 probe must contain the one current editorial repair-close case");
  }
  return selected;
}

const RELATIONAL_V11_PROBE_CASE_IDS = new Set([
  "expert-clarity__cinematic-realism__expert-clinic-close",
  "expert-clarity__cinematic-realism__expert-clinic-explain",
  "expert-clarity__clear-infographic__expert-clinic-hook",
  "practical-documentary__dramatic-comic__documentary-repair-close",
  "thai-human-drama__cinematic-realism__drama-bus-close",
  "thai-human-drama__simple-editorial-story__drama-bus-close",
  "thai-human-drama__dramatic-comic__drama-bus-close",
  "thai-human-drama__clear-infographic__drama-bus-close",
  "thai-human-drama__retro-story__drama-bus-close",
  "premium-product-lifestyle__cinematic-realism__premium-serum-explain",
  "premium-product-lifestyle__simple-editorial-story__premium-serum-explain",
  "premium-product-lifestyle__dramatic-comic__premium-serum-explain",
  "premium-product-lifestyle__clear-infographic__premium-serum-explain",
  "premium-product-lifestyle__retro-story__premium-serum-explain",
  "investigative-news-crime__dramatic-comic__news-files-hook",
  "thai-history-period-storytelling__cinematic-realism__history-river-close",
  "thai-supernatural-horror__cinematic-realism__horror-house-close",
  "thai-supernatural-horror__retro-story__horror-house-close",
]);

/** Proposed focused paid probe after the strict V10 matrix review. It contains
 * only the 18 confirmed failed frames and remains a dry compiler suite unless
 * the paid runner's separate execution lock is explicitly opened. */
export function buildBrandTreatmentRelationalV11ProbeCases(
  cases = buildBrandTreatmentBenchmarkCases(),
): BrandTreatmentBenchmarkCase[] {
  const selected = cases.filter((entry) => RELATIONAL_V11_PROBE_CASE_IDS.has(entry.id));
  if (
    selected.length !== RELATIONAL_V11_PROBE_CASE_IDS.size
    || selected.some((entry) => !(
      entry.compiled.recipeVersion.endsWith("-v9")
      || entry.compiled.recipeVersion === "simple-editorial-story-v11"
    ))
  ) {
    throw new Error("Relational v11 probe must contain exactly the 18 confirmed V10 strict failures");
  }
  return selected;
}
