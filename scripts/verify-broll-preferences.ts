import {
  appendBrollPreferenceToDirection,
  applyBrollPreferenceToSearchQuery,
  augmentRelevanceSpecWithBrollPreference,
  brollPreferenceInstruction,
  PEOPLE_WORD_TEST_RE,
} from "../src/lib/broll-preferences";
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

process.exit(failures ? 1 : 0);
