// Unit tests for the Mix Preset credit estimator + weights validator (D5.1).
// Run: npx tsx scripts/verify-preset-credits.ts
//
// estimatePresetCredits is PURE and consumed by the Render Receipt (Task 5) + the
// preset labels, so its math is load-bearing: windows = ceil(estSec/4); aiShare =
// ai/(video+photo+ai) (0 when the total weight is 0 — div-by-zero guard); credits =
// ceil(windows × aiShare) × perImageCredits.
import { estimatePresetCredits } from "../src/app/(dashboard)/video-editor/_v2/estimate";
import { parseAutoMixWeights } from "../src/lib/automix-weights";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// Preset weights (must match _v2/mix-presets PRESET_WEIGHTS)
const FREE = { video: 3, photo: 2, ai: 0 };
const RECO = { video: 3, photo: 2, ai: 1 };
const FULL = { video: 0, photo: 0, ai: 1 };
const ZERO = { video: 0, photo: 0, ai: 0 };

// ── ฟรีล้วน: ai=0 → 0 credits regardless of length/price ──
check("ฟรีล้วน (ai=0) → 0 credits @30s,3cr", estimatePresetCredits(30, FREE, 3) === 0,
  String(estimatePresetCredits(30, FREE, 3)));
check("ฟรีล้วน (ai=0) → 0 credits @120s,4cr", estimatePresetCredits(120, FREE, 4) === 0);

// ── ผสม AI แนะนำ {3,2,1}: aiShare = 1/6 ──
// 30s → windows=ceil(30/4)=8; ceil(8·1/6)=ceil(1.333)=2; ×3 = 6
check("ผสม AI @30s,3cr → 6", estimatePresetCredits(30, RECO, 3) === 6, String(estimatePresetCredits(30, RECO, 3)));
// 60s → windows=15; ceil(15·1/6)=ceil(2.5)=3; ×3 = 9
check("ผสม AI @60s,3cr → 9", estimatePresetCredits(60, RECO, 3) === 9, String(estimatePresetCredits(60, RECO, 3)));
// nano-2 price 4cr: 30s → ceil(1.333)=2 × 4 = 8
check("ผสม AI @30s,4cr → 8", estimatePresetCredits(30, RECO, 4) === 8, String(estimatePresetCredits(30, RECO, 4)));

// ── AI เต็มที่ {0,0,1}: aiShare = 1 → windows × perImage ──
// 30s → windows=8 × 3 = 24
check("AI เต็มที่ @30s,3cr → 24", estimatePresetCredits(30, FULL, 3) === 24, String(estimatePresetCredits(30, FULL, 3)));
// 40s → windows=10 × 3 = 30
check("AI เต็มที่ @40s,3cr → 30", estimatePresetCredits(40, FULL, 3) === 30, String(estimatePresetCredits(40, FULL, 3)));

// ── div-by-zero guard: total weight 0 → share 0 → 0 credits (no NaN/Infinity) ──
const z = estimatePresetCredits(30, ZERO, 3);
check("all-zero weights → 0 credits (no NaN)", z === 0 && Number.isFinite(z), String(z));

// ── edge: estSec 0 → windows 0 → 0 credits ──
check("estSec 0 → 0 credits", estimatePresetCredits(0, RECO, 3) === 0);

// ── purity: same inputs → same output, input object untouched ──
const frozen = Object.freeze({ video: 3, photo: 2, ai: 1 });
check("pure: repeatable", estimatePresetCredits(30, frozen, 3) === estimatePresetCredits(30, frozen, 3));

// ── parseAutoMixWeights (server-side request validator) ──
check("valid {3,2,1}", JSON.stringify(parseAutoMixWeights({ video: 3, photo: 2, ai: 1 })) === JSON.stringify({ video: 3, photo: 2, ai: 1 }));
check("valid {0,0,0}", JSON.stringify(parseAutoMixWeights({ video: 0, photo: 0, ai: 0 })) === JSON.stringify({ video: 0, photo: 0, ai: 0 }));
check("ai out of range 10 → null", parseAutoMixWeights({ video: 0, photo: 0, ai: 10 }) === null);
check("negative → null", parseAutoMixWeights({ video: -1, photo: 2, ai: 1 }) === null);
check("non-int 1.5 → null", parseAutoMixWeights({ video: 3, photo: 2, ai: 1.5 }) === null);
check("missing field → null", parseAutoMixWeights({ video: 3, photo: 2 }) === null);
check("extra field ignored, still valid", parseAutoMixWeights({ video: 3, photo: 2, ai: 1, bogus: 9 }) !== null);
check("non-object null → null", parseAutoMixWeights(null) === null);
check("array → null", parseAutoMixWeights([3, 2, 1]) === null);
check("string values → null", parseAutoMixWeights({ video: "3", photo: "2", ai: "1" }) === null);

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll preset-credits checks passed.");
