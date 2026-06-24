// Unit tests for the Auto Mix source plan (run: npx tsx scripts/verify-automix-plan.ts)
//
// ROOT CAUSE this fixes: Automix was video-FIRST-fallback — images/AI appeared only for
// keywords that found ZERO video, so with the default providers it collapsed to 100%
// video. These pure helpers pre-assign each piece a source by weight so the result is a
// real, interleaved mix (default video:photo:ai = 3:2:1) at a cadence-capped piece count.
import { planAutoMixSources, pickEvenIndices, type AutoMixWeights } from "../src/lib/automix-plan";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const tally = (a: string[]) => a.reduce<Record<string, number>>((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {});

// ── planAutoMixSources ──
const w321: AutoMixWeights = { video: 3, photo: 2, ai: 1 };
const p6 = planAutoMixSources(6, w321);
const t6 = tally(p6);
check("6 pieces @ 3:2:1 → 3 video", t6.video === 3, JSON.stringify(t6));
check("6 pieces @ 3:2:1 → 2 photo", t6.photo === 2, JSON.stringify(t6));
check("6 pieces @ 3:2:1 → 1 ai", t6.ai === 1, JSON.stringify(t6));
check("interleaved, not blocked (not vvvppa)", p6.join("") !== "videovideovideo" + "photophoto" + "ai");
check("ai is not first (cost source spread, not front-loaded)", p6[0] !== "ai");

// length always == n
check("length == n (10)", planAutoMixSources(10, w321).length === 10);
check("length == n (0)", planAutoMixSources(0, w321).length === 0);

// a zero-weight source never appears
const noAi = planAutoMixSources(8, { video: 3, photo: 2, ai: 0 });
check("ai weight 0 → no ai pieces", !noAi.includes("ai"));
check("ai weight 0 → still full length", noAi.length === 8);

// all-zero weights degrade to video (never empty/undefined)
const allZero = planAutoMixSources(4, { video: 0, photo: 0, ai: 0 });
check("all-zero weights → all video", allZero.every((s) => s === "video") && allZero.length === 4);

// only AI checked → all ai
const onlyAi = planAutoMixSources(3, { video: 0, photo: 0, ai: 1 });
check("only ai weight → all ai", onlyAi.every((s) => s === "ai"));

// ── pickEvenIndices ──
const idx = pickEvenIndices(17, 6);
check("pickEven: 17→6 returns 6", idx.length === 6, JSON.stringify(idx));
check("pickEven: indices unique", new Set(idx).size === idx.length);
check("pickEven: ascending + in range", idx.every((v, i) => v >= 0 && v < 17 && (i === 0 || v > idx[i - 1])));
check("pickEven: spread (first<3, last>13)", idx[0] < 3 && idx[idx.length - 1] > 13, JSON.stringify(idx));
check("pickEven: n>=total → all indices", JSON.stringify(pickEvenIndices(4, 9)) === JSON.stringify([0, 1, 2, 3]));
check("pickEven: n=0 → []", pickEvenIndices(10, 0).length === 0);

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll automix-plan checks passed.");
