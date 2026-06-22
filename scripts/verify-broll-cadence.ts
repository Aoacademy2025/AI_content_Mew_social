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
