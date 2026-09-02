import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  appendBrollPreferenceToDirection,
  applyBrollPreferenceToSearchQuery,
  augmentRelevanceSpecWithBrollPreference,
  brollPreferenceCacheVariant,
  brollPreferenceInstruction,
  stockMoodForProject,
  PEOPLE_WORD_TEST_RE,
  type ResolvedStockMood,
} from "../src/lib/broll-preferences";
import { parseStockMoodRequest } from "../src/lib/style-pack-snapshot";
import { stylePack } from "../src/lib/style-pack-catalog";
import { parseRevision, parseProjectVisualContext } from "../src/lib/project-visual-context";
import type { RelevanceSpec } from "../src/lib/relevance-spec";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures++;
}

// 1. Opposite-region avoid terms exist (the leak fix)
const asianSpec = augmentRelevanceSpecWithBrollPreference(null, { brollRegionPreference: "asian" });
check("asian avoid includes western", (asianSpec?.avoidConcepts ?? []).some((t) => /caucasian|western|european/.test(t)));
const thaiSpec = augmentRelevanceSpecWithBrollPreference(null, { brollRegionPreference: "thai" });
check("thai avoid includes western", (thaiSpec?.avoidConcepts ?? []).some((t) => /caucasian|western|european/.test(t)));
const euroSpec = augmentRelevanceSpecWithBrollPreference(null, { brollRegionPreference: "european" });
check("european avoid includes asian", (euroSpec?.avoidConcepts ?? []).some((t) => /asian/.test(t)));

// 2. thai degrades to asian in fallback queries (never western)
check("thai fallback contains asian queries", (thaiSpec?.safeFallbackQueries ?? []).some((q) => q.includes("asian")));
check("thai fallback has no european", !(thaiSpec?.safeFallbackQueries ?? []).some((q) => /european|western/.test(q)));
// (regression fix) fallbacks used to be people-ONLY ("asian business people"); now the
// asian degrade must be region-correct but NOT people-only — a SETTING query must survive.
check(
  "thai fallback keeps an asian SETTING query (region-correct, not people-only)",
  (thaiSpec?.safeFallbackQueries ?? []).some((q) => q.includes("asian") && !/people|worker|workers|person|team/.test(q)),
);
check(
  "thai fallback still keeps at least one people option for genuinely-people scenes",
  (thaiSpec?.safeFallbackQueries ?? []).some((q) => /people|worker|workers|person|team/.test(q)),
);

// 3. Truncation: long base direction must NOT swallow the preference suffix
const longBase = "x".repeat(300);
const appended = appendBrollPreferenceToDirection(longBase, { brollRegionPreference: "thai" });
check("suffix survives long base", /Thai|Southeast Asian/.test(appended));

// 3b. Combined region+style: base direction must survive AND suffix must stay whole
const combinedBase = "office worker typing on laptop at sunrise, warm tones, city skyline in background";
const combinedAppended = appendBrollPreferenceToDirection(combinedBase, {
  brollRegionPreference: "thai",
  brollVisualStyle: "documentary",
});
check("combined: base direction preserved", combinedAppended.includes("office worker"));
check("combined: suffix stays whole", combinedAppended.includes("never Western/European-looking people"));

// 4. Instruction helper
check("instruction non-empty for thai", brollPreferenceInstruction({ brollRegionPreference: "thai" }).length > 0);
check("instruction empty for auto", brollPreferenceInstruction({}) === "");

// ---------------------------------------------------------------------------
// REGRESSION FIX: region must qualify people/place queries, NOT people-force
// every object/abstract query (was: "growth chart" -> "asian growth chart").
// ---------------------------------------------------------------------------

// (a) pure object/abstract query -> UNCHANGED (no region prefix)
check(
  "object query 'growth chart' (asian) stays unchanged",
  applyBrollPreferenceToSearchQuery("growth chart", { brollRegionPreference: "asian" }) === "growth chart",
);
check(
  "object query 'rising bar graph' (asian) stays unchanged",
  applyBrollPreferenceToSearchQuery("rising bar graph", { brollRegionPreference: "asian" }) === "rising bar graph",
);
check(
  "nature query 'ocean waves' (thai) stays unchanged",
  applyBrollPreferenceToSearchQuery("ocean waves", { brollRegionPreference: "thai" }) === "ocean waves",
);

// (b) people query -> gets the region qualifier
check(
  "people query 'office workers' (asian) gets asian qualifier",
  applyBrollPreferenceToSearchQuery("office workers", { brollRegionPreference: "asian" }) === "asian office workers",
);

// (c) place/setting query -> gets the region qualifier
check(
  "place query 'city street' (asian) gets asian qualifier",
  applyBrollPreferenceToSearchQuery("city street", { brollRegionPreference: "asian" }) === "asian city street",
);
check(
  "place query 'coffee shop' (thai) gets thai qualifier",
  applyBrollPreferenceToSearchQuery("coffee shop", { brollRegionPreference: "thai" }).startsWith("thai "),
);

// (d) instruction strings carry the conditional "do not add" phrasing
for (const region of ["asian", "thai", "european"] as const) {
  const instr = brollPreferenceInstruction({ brollRegionPreference: region });
  check(`${region} instruction has conditional 'do not add' phrasing`, /do not add/i.test(instr));
  check(`${region} instruction is content-first (not "prefer <region> people")`, !/^Prefer\s+\w+\s+people/i.test(instr));
}

// (e) augmented positiveConcepts for asian include SETTING terms and are NOT
//     people-dominated (used as the ranker's "prefer footage of" list).
const asianPos = asianSpec?.positiveConcepts ?? [];
const asianSetting = asianPos.filter((t) => /\b(city|street|office|market|architecture|scene|lifestyle|home|shop|building)\b/.test(t));
check("asian positiveConcepts include setting terms", asianSetting.length > 0);
// Real guard (previously trivially true: asianPeople was always 0 because
// REGION_HINTS.asian.positive never had people terms in the first place, so
// `0 <= asianSetting.length` always passed regardless of what changed).
// This asserts directly against PEOPLE_WORD_TEST_RE — the single source of
// truth for "is this a person/role word" — so if a future edit reintroduces
// people terms into REGION_HINTS.*.positive, this check actually fails.
check(
  "asian positiveConcepts contain NO people/role term (setting-only)",
  !asianPos.some((t) => PEOPLE_WORD_TEST_RE.test(t)),
);

// (f) auto / unset -> byte-identical passthrough behavior
check(
  "unset region leaves object query unchanged",
  applyBrollPreferenceToSearchQuery("growth chart", {}) === "growth chart",
);
check("unset augment returns null spec unchanged", augmentRelevanceSpecWithBrollPreference(null, {}) === null);
const passthroughSpec: RelevanceSpec = {
  visualDomain: "finance",
  positiveConcepts: ["chart"],
  avoidConcepts: [],
  safeFallbackQueries: [],
};
check(
  "unset augment returns the same spec reference",
  augmentRelevanceSpecWithBrollPreference(passthroughSpec, {}) === passthroughSpec,
);

// ---------------------------------------------------------------------------
// FIX 1 REGRESSION COVERAGE: the people-word list was too narrow — genuine
// people/role queries (meetings, family scenes, professions, etc.) were
// slipping through unqualified. Broadened PEOPLE_WORD_RE must now catch them,
// while pure object/nature/abstract queries must stay unchanged (no
// over-broadening regression).
// ---------------------------------------------------------------------------

for (const q of ["business meeting", "family dinner", "chef cooking", "athlete running", "teacher explaining"]) {
  check(
    `people/role query '${q}' (asian) gets asian qualifier`,
    applyBrollPreferenceToSearchQuery(q, { brollRegionPreference: "asian" }) === `asian ${q}`,
  );
}

for (const q of ["growth chart", "circuit board", "sunset over ocean", "mountain landscape"]) {
  check(
    `object/nature query '${q}' (asian) stays unchanged`,
    applyBrollPreferenceToSearchQuery(q, { brollRegionPreference: "asian" }) === q,
  );
}

// ---------------------------------------------------------------------------
// FIX 2 (round-2 review) REGRESSION COVERAGE: PEOPLE_WORD_RE overshot with 6
// polysemous object/device nouns (player, speaker, driver, coach, vendor,
// runner) that collide with people/role senses. They were removed. Lock in:
// (a) object/device queries no longer get the region prefix, and
// (b) the no-people path no longer strips the actual subject out of them.
// ---------------------------------------------------------------------------

for (const q of [
  "video player interface",
  "bluetooth speaker on desk",
  "usb driver install",
  "coach bus",
  "software vendor logo",
  "carpet runner rug",
]) {
  check(
    `object/device query '${q}' (asian) stays unchanged`,
    applyBrollPreferenceToSearchQuery(q, { brollRegionPreference: "asian" }) === q,
  );
}

check(
  "no-people 'bluetooth speaker on desk' keeps 'speaker' (not stripped)",
  applyBrollPreferenceToSearchQuery("bluetooth speaker on desk", { brollRegionPreference: "no-people" }).includes(
    "speaker",
  ),
);

check(
  "no-people 'chef cooking' still strips the genuine people word",
  applyBrollPreferenceToSearchQuery("chef cooking", { brollRegionPreference: "no-people" }) === "cooking no people",
);

// ---------------------------------------------------------------------------
// TASK 4 (F7): the Step-2 preferences must actually CHANGE results — style has
// to reach the search query (primary queries only, never the widen/fallback
// ladder), region + style must compose, the managed-stock cache must be keyed
// by the preference, and the preference hints must survive the ranker's slice.
// Uses node:assert so a regression names the exact broken contract.
// ---------------------------------------------------------------------------
{
  // style token reaches PRIMARY queries, never FALLBACK queries
  assert.equal(applyBrollPreferenceToSearchQuery("growth chart", { brollVisualStyle: "cinematic" }, { role: "primary" }), "growth chart cinematic");
  assert.equal(applyBrollPreferenceToSearchQuery("growth chart", { brollVisualStyle: "cinematic" }, { role: "fallback" }), "growth chart");
  assert.equal(applyBrollPreferenceToSearchQuery("cinematic city", { brollVisualStyle: "cinematic" }, { role: "primary" }), "cinematic city", "no duplicate token");
  // region + style compose
  assert.equal(applyBrollPreferenceToSearchQuery("office workers", { brollRegionPreference: "thai", brollVisualStyle: "documentary" }, { role: "primary" }), "thai office workers documentary");
  // cache variant
  assert.equal(brollPreferenceCacheVariant({}), "");
  assert.equal(brollPreferenceCacheVariant({ brollRegionPreference: "thai", brollVisualStyle: "cinematic" }), "r=thai;s=cinematic");
  // preference avoid terms survive the ranker slice(0, 8)
  const spec = augmentRelevanceSpecWithBrollPreference(
    { visualDomain: "x", positiveConcepts: Array.from({ length: 20 }, (_, i) => `p${i}`), avoidConcepts: Array.from({ length: 20 }, (_, i) => `a${i}`), safeFallbackQueries: [] },
    { brollRegionPreference: "thai" },
  );
  assert.ok(spec!.avoidConcepts.slice(0, 8).includes("caucasian people"), "avoid hints must come first");
  assert.ok(spec!.positiveConcepts.slice(0, 12).includes("thailand"), "at least the first 4 positive hints must come first");
  console.log("PASS task-4 preference query/cache/ranker contract (node:assert)");
}

// ---------------------------------------------------------------------------
// WAVE 1 TASK 4 (ADR 0057): the pinned Style Pack's Stock Mood rides the SAME
// pipe the legacy Step-2 style used, and REPLACES it wherever both could speak
// (query token, hints, direction, cache). Region guardrails are untouched: a
// mood may never turn an object query into a people/place query.
// ---------------------------------------------------------------------------
{
  const ghost = stylePack("thai-ghost");
  const ghostMood: ResolvedStockMood = { packId: "thai-ghost", ...ghost.stockMood };
  const historyMood: ResolvedStockMood = { packId: "thai-history", ...stylePack("thai-history").stockMood };

  // (1) mood token reaches PRIMARY queries, never the widen/fallback ladder
  assert.equal(
    applyBrollPreferenceToSearchQuery("old house", { stockMood: ghostMood }, { role: "primary" }),
    "old house night",
  );
  assert.equal(
    applyBrollPreferenceToSearchQuery("old house", { stockMood: ghostMood }, { role: "fallback" }),
    "old house",
  );
  assert.equal(
    applyBrollPreferenceToSearchQuery("night market", { stockMood: ghostMood }, { role: "primary" }),
    "night market",
    "no duplicate mood token",
  );

  // (2) the mood REPLACES the legacy style everywhere both could speak
  assert.equal(
    applyBrollPreferenceToSearchQuery(
      "old house",
      { stockMood: ghostMood, brollVisualStyle: "cinematic" },
      { role: "primary" },
    ),
    "old house night",
    "legacy style must not survive next to a mood",
  );
  assert.equal(brollPreferenceCacheVariant({ stockMood: ghostMood, brollRegionPreference: "thai" }), "r=thai;m=thai-ghost");
  assert.equal(brollPreferenceCacheVariant({ stockMood: ghostMood, brollVisualStyle: "cinematic" }), "m=thai-ghost");
  assert.equal(brollPreferenceCacheVariant({ stockMood: null, brollVisualStyle: "cinematic" }), "s=cinematic");
  assert.notEqual(
    brollPreferenceCacheVariant({ stockMood: ghostMood }),
    brollPreferenceCacheVariant({ stockMood: historyMood }),
    "two packs must never share a managed-stock cache entry",
  );
  assert.equal(brollPreferenceInstruction({ stockMood: ghostMood, brollVisualStyle: "cinematic" }), ghost.stockMood.direction);

  // (3) region still composes and still qualifies people/place queries ONLY
  assert.equal(
    applyBrollPreferenceToSearchQuery(
      "office workers",
      { stockMood: ghostMood, brollRegionPreference: "thai" },
      { role: "primary" },
    ),
    "thai office workers night",
  );
  assert.equal(
    applyBrollPreferenceToSearchQuery(
      "growth chart",
      { stockMood: ghostMood, brollRegionPreference: "thai" },
      { role: "primary" },
    ),
    "growth chart night",
    "a mood must never add the region qualifier to an object query",
  );
  assert.equal(
    applyBrollPreferenceToSearchQuery(
      "chef cooking",
      { stockMood: ghostMood, brollRegionPreference: "no-people" },
      { role: "primary" },
    ),
    "cooking no people night",
    "no-people still strips the people word with a mood present",
  );

  // (4) hints: the mood's own vocabulary reaches the ranker and the direction
  const moodSpec = augmentRelevanceSpecWithBrollPreference(null, { stockMood: ghostMood });
  assert.ok(moodSpec, "a mood alone is a preference");
  assert.ok(moodSpec!.positiveConcepts.includes("moonlight"), "mood positives reach the ranker");
  assert.ok(moodSpec!.avoidConcepts.includes("bright daylight"), "mood avoids reach the ranker");
  assert.ok(moodSpec!.safeFallbackQueries.includes("dark forest night"), "mood fallbacks reach the widen ladder");
  const moodDirection = appendBrollPreferenceToDirection("x".repeat(300), { stockMood: ghostMood });
  assert.ok(moodDirection.endsWith(ghost.stockMood.direction), "mood direction survives a long base");

  // (5) no mood, no change: byte-identical passthrough
  assert.equal(applyBrollPreferenceToSearchQuery("growth chart", { stockMood: null }), "growth chart");
  assert.equal(brollPreferenceCacheVariant({ stockMood: null }), "");
  assert.equal(augmentRelevanceSpecWithBrollPreference(passthroughSpec, { stockMood: null }), passthroughSpec);

  console.log("PASS wave-1 task-4 stock mood pipe (node:assert)");
}

// ---------------------------------------------------------------------------
// stockMoodForProject: the per-clip pinned context wins over the Brand
// Revision's recipe; a recipe with no pack (a custom look) yields no mood.
// ---------------------------------------------------------------------------
{
  const packSnapshot = (id: "thai-ghost" | "thai-history") => {
    const pack = stylePack(id);
    return {
      id: pack.id,
      version: pack.version,
      stockMood: {
        queryToken: pack.stockMood.queryToken,
        positive: [...pack.stockMood.positive],
        avoid: [...pack.stockMood.avoid],
        direction: pack.stockMood.direction,
        fallbackQueries: [...pack.stockMood.fallbackQueries],
      },
      pacing: pack.pacing,
      musicMood: pack.musicMood,
    };
  };
  const recipe = (stylePackValue: unknown) => JSON.stringify({
    schemaVersion: 1,
    visualFormatId: "cinematic-realism",
    recipeVersion: "cinematic-realism@1",
    brandVisualLanguage: null,
    defaultTreatment: "clear",
    treatmentPolicy: "adaptive",
    lockedTreatmentPin: null,
    ...(stylePackValue === undefined ? {} : { stylePack: stylePackValue }),
  });
  const context = (stylePackValue: unknown) => JSON.stringify({
    schemaVersion: 2,
    source: "brand-revision",
    visualFormatId: "cinematic-realism",
    recipeVersion: "cinematic-realism@1",
    treatment: "สารคดีสืบสวน",
    treatmentPin: { presetId: "investigative-news-crime", version: "v1.0.0", source: "adaptive" },
    brandVisualLanguage: null,
    ...(stylePackValue === undefined ? {} : { stylePack: stylePackValue }),
  });

  assert.equal(
    stockMoodForProject({ projectVisualContextJson: null, brandRevisionRecipeJson: recipe(packSnapshot("thai-ghost")) })?.packId,
    "thai-ghost",
    "the Brand Revision's pack supplies the mood",
  );
  assert.equal(
    stockMoodForProject({
      projectVisualContextJson: context(packSnapshot("thai-history")),
      brandRevisionRecipeJson: recipe(packSnapshot("thai-ghost")),
    })?.packId,
    "thai-history",
    "the per-clip pinned context wins over the Brand Revision",
  );
  assert.equal(
    stockMoodForProject({ projectVisualContextJson: context(undefined), brandRevisionRecipeJson: recipe(packSnapshot("thai-ghost")) })?.packId,
    "thai-ghost",
    "a context with no pack falls through to the Revision",
  );
  assert.equal(
    stockMoodForProject({ projectVisualContextJson: null, brandRevisionRecipeJson: recipe(null) }),
    null,
    "a custom (no-pack) Revision has no mood",
  );
  assert.equal(
    stockMoodForProject({ projectVisualContextJson: null, brandRevisionRecipeJson: recipe(undefined) }),
    null,
    "a pre-Style-Pack Revision has no mood",
  );
  assert.equal(
    stockMoodForProject({ projectVisualContextJson: null, brandRevisionRecipeJson: "{not json" }),
    null,
    "unreadable JSON fails open to no mood",
  );
  assert.equal(
    stockMoodForProject({ projectVisualContextJson: null, brandRevisionRecipeJson: null }),
    null,
  );
  assert.deepEqual(
    stockMoodForProject({ projectVisualContextJson: null, brandRevisionRecipeJson: recipe(packSnapshot("thai-ghost")) }),
    { packId: "thai-ghost", ...stylePack("thai-ghost").stockMood },
    "the mood is the SNAPSHOT, read out of the stored recipe",
  );

  // the schemas must carry the snapshot through (they are non-strict objects,
  // so an unknown key would be stripped silently) and must still parse old JSON
  assert.equal(parseRevision(recipe(packSnapshot("thai-ghost")))?.stylePack?.id, "thai-ghost");
  assert.ok(parseRevision(recipe(undefined)), "a recipe with no stylePack still parses");
  assert.equal(parseRevision(recipe(undefined))?.stylePack ?? null, null);
  assert.equal(parseProjectVisualContext(context(packSnapshot("thai-ghost")))?.stylePack?.id, "thai-ghost");
  assert.ok(parseProjectVisualContext(context(undefined)), "a context with no stylePack still parses");

  console.log("PASS wave-1 task-4 stockMoodForProject precedence + schema passthrough (node:assert)");
}

// ---------------------------------------------------------------------------
// Request validation: a Stock Mood arriving in a request body is never trusted
// raw. Absent/null is a legitimate "no mood"; anything oversized is rejected.
// ---------------------------------------------------------------------------
{
  const valid = { packId: "thai-ghost", ...stylePack("thai-ghost").stockMood };
  assert.deepEqual(parseStockMoodRequest(valid), { ok: true, stockMood: valid });
  assert.deepEqual(parseStockMoodRequest(undefined), { ok: true, stockMood: null });
  assert.deepEqual(parseStockMoodRequest(null), { ok: true, stockMood: null });
  assert.equal(parseStockMoodRequest({ ...valid, queryToken: "x".repeat(25) }).ok, false, "over-long token rejected");
  assert.equal(parseStockMoodRequest({ ...valid, direction: "x".repeat(161) }).ok, false, "over-long direction rejected");
  assert.equal(
    parseStockMoodRequest({ ...valid, positive: Array.from({ length: 13 }, (_, i) => `p${i}`) }).ok,
    false,
    "too many positives rejected",
  );
  assert.equal(
    parseStockMoodRequest({ ...valid, avoid: Array.from({ length: 9 }, (_, i) => `a${i}`) }).ok,
    false,
    "too many avoids rejected",
  );
  assert.equal(parseStockMoodRequest({ ...valid, fallbackQueries: ["a", "b"] }).ok, false, "wrong fallback count rejected");
  assert.equal(parseStockMoodRequest({ ...valid, packId: "not-a-pack" }).ok, false, "unknown pack rejected");
  assert.equal(parseStockMoodRequest("thai-ghost").ok, false, "a bare string is not a mood");

  console.log("PASS wave-1 task-4 stock mood request validation (node:assert)");
}

// ---------------------------------------------------------------------------
// The three routes that accept a Stock Mood must validate it before use and
// answer 400 — never pass a raw body object into the preference pipe.
// ---------------------------------------------------------------------------
{
  const routes = [
    "src/app/api/videos/extract-keywords/route.ts",
    "src/app/api/videos/fetch-stock/route.ts",
    "src/app/api/videos/broll-window/search/route.ts",
  ];
  for (const route of routes) {
    const source = readFileSync(new URL(`../${route}`, import.meta.url), "utf8");
    check(`${route} validates stockMood with the shared parser`, source.includes("parseStockMoodRequest("));
    check(`${route} answers 400 on an invalid stockMood`, /invalid_stock_mood/.test(source));
    // ADR 0057: one style system. A pinned pack retires the legacy style for
    // the WHOLE request — including the image-prompt paths that read the field
    // directly instead of going through the preference pipe.
    check(
      `${route} retires the legacy style when a mood is present`,
      /stockMoodResult\.stockMood \? undefined :/.test(source),
    );
  }
}

// ---------------------------------------------------------------------------
// The Step-2 legacy style menu is gone: the editor no longer offers it and no
// longer sends it. The server still ACCEPTS it for drafts saved before wave 1.
// ---------------------------------------------------------------------------
{
  const step2 = readFileSync(new URL("../src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx", import.meta.url), "utf8");
  check("Step 2 no longer renders the style menu", !step2.includes("BROLL_STYLE_OPTIONS"));
  check("Step 2 keeps the region control", step2.includes("BROLL_REGION_OPTIONS"));
  check("Step 2 shows the pinned pack read-only", step2.includes("สไตล์ฟุตเทจ:"));
  check("Step 2 falls back to content-led copy", step2.includes("ตามเนื้อหา"));
  const useJob = readFileSync(new URL("../src/app/(dashboard)/video-editor/_v2/useV2Job.ts", import.meta.url), "utf8");
  check("useV2Job stops sending brollVisualStyle", !useJob.includes("brollVisualStyle"));

  // The per-window search must reach the SAME pack Step 2 showed. Every hop is
  // an OPTIONAL prop, so a missing link type-checks silently — assert the chain.
  for (const [file, needle] of [
    ["src/app/(dashboard)/video-editor/_v2/BrandVisualSelector.tsx", "p.setProjectStylePack("],
    ["src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx", "projectStylePack: p.projectStylePack"],
    ["src/app/(dashboard)/video-editor/_v2/PostPhase.tsx", "projectStylePack={projectStylePack}"],
    ["src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx", "projectStylePack={projectStylePack}"],
    ["src/app/(dashboard)/video-editor/_v2/BrollWindowInspector.tsx", "stockMood: projectStylePack.stockMood"],
  ] as const) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    check(`${file} passes the pinned pack along`, source.includes(needle));
  }
}


process.exit(failures ? 1 : 0);
