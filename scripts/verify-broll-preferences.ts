import {
  appendBrollPreferenceToDirection,
  augmentRelevanceSpecWithBrollPreference,
  brollPreferenceInstruction,
} from "../src/lib/broll-preferences";

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

// 3. Truncation: long base direction must NOT swallow the preference suffix
const longBase = "x".repeat(300);
const appended = appendBrollPreferenceToDirection(longBase, { brollRegionPreference: "thai" });
check("suffix survives long base", /Thai|Southeast Asian/.test(appended));

// 4. Instruction helper
check("instruction non-empty for thai", brollPreferenceInstruction({ brollRegionPreference: "thai" }).length > 0);
check("instruction empty for auto", brollPreferenceInstruction({}) === "");

process.exit(failures ? 1 : 0);
