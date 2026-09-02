// Unit tests for targetCadenceSec + aiGenPieceCount (run: npx tsx scripts/verify-broll-cadence.ts)
//
// ROOT CAUSE this fixes: per-subtitle AI-gen generates ONE paid image per caption,
// so a 21s clip with ~17 captions paid for ~17 generic images at ~1.2s each. These
// helpers decouple paid generations from caption count: ~ceil(duration/cadence) images.
import { targetCadenceSec, aiGenPieceCount } from "../src/lib/broll-even-split";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// cadence is always within the marketed 3–5s band
for (const d of [5, 10, 21, 30, 45, 60, 120]) {
  const c = targetCadenceSec(d);
  check(`cadence(${d}s) in [3,5]`, c >= 3 && c <= 5, `${c}`);
}
check("cadence: short clip not slower than long", targetCadenceSec(21) <= targetCadenceSec(120));

// ---------------------------------------------------------------------------
// Task 5 — Pacing: targetCadenceSec(durationSec, multiplier). Task-5-brief
// Step 1: targetCadenceSec(60, 0.7) < targetCadenceSec(60) < targetCadenceSec(60, 1.6).
// ---------------------------------------------------------------------------
check(
  "targetCadenceSec(60, 0.7) < targetCadenceSec(60) < targetCadenceSec(60, 1.6)",
  targetCadenceSec(60, 0.7) < targetCadenceSec(60) && targetCadenceSec(60) < targetCadenceSec(60, 1.6),
  `fast=${targetCadenceSec(60, 0.7)} normal=${targetCadenceSec(60)} slow=${targetCadenceSec(60, 1.6)}`,
);
// omitting the multiplier is byte-identical to multiplier=1 (the pre-wave-1 default)
check("no multiplier === multiplier 1", targetCadenceSec(60) === targetCadenceSec(60, 1));
// a non-positive multiplier falls back to 1, never to 0 or a negative cadence
check("multiplier 0 falls back to 1", targetCadenceSec(60, 0) === targetCadenceSec(60, 1));
check("negative multiplier falls back to 1", targetCadenceSec(60, -2) === targetCadenceSec(60, 1));
// clamp: an extreme multiplier never leaves [2, 10]s
check("extreme slow multiplier clamps to 10s", targetCadenceSec(60, 10) === 10, `${targetCadenceSec(60, 10)}`);
check("extreme fast multiplier clamps to 2s", targetCadenceSec(60, 0.01) === 2, `${targetCadenceSec(60, 0.01)}`);
for (const d of [5, 10, 21, 30, 45, 60, 120]) {
  for (const m of [0.7, 1, 1.6]) {
    const c = targetCadenceSec(d, m);
    check(`cadence(${d}s, ×${m}) within [2,10]`, c >= 2 && c <= 10, `${c}`);
  }
}

// THE headline case: 21s, 17 captions, auto → ~6 images (NOT 17)
const n21 = aiGenPieceCount(21, 17, true, 36);
check("21s/17cap auto → ~6 images", n21 >= 5 && n21 <= 7, `${n21}`);
check("21s auto < caption count", n21 < 17);

// never exceed the keyword count or the hard cap
check("capped by keywordCount", aiGenPieceCount(600, 4, true, 36) === 4);
check("capped by hardCap", aiGenPieceCount(600, 200, true, 36) === 36);

// manual (isAuto=false) bypasses the cadence cap — user chose the number
check("manual bypasses cadence cap", aiGenPieceCount(21, 12, false, 36) === 12);
check("manual still respects hardCap", aiGenPieceCount(21, 99, false, 36) === 36);

// degenerate inputs
check("zero duration auto → keywordCount", aiGenPieceCount(0, 8, true, 36) === 8);
check("never returns < 1 for >=1 keyword", aiGenPieceCount(3, 1, true, 36) >= 1);

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll broll-cadence checks passed.");
