// Proof of the long-audio chunk planner (2026-06): split long clips at silence into
// ~2.5-min chunks so each Gemini transcribe stays in its in-sync zone. Pure logic — run:
//   npx tsx scripts/verify-transcribe-chunking.ts
import assert from "node:assert/strict";

const CHUNK_THRESHOLD_MS = 240_000;
const CHUNK_TARGET_MS = 150_000;
const CHUNK_MAX_MS = 210_000;

// Replicates planChunkBoundaries() in transcribe/route.ts.
function planChunkBoundaries(totalMs: number, silences: number[]): number[] {
  const cuts: number[] = [];
  let lastCut = 0;
  while (totalMs - lastCut > CHUNK_MAX_MS) {
    const target = lastCut + CHUNK_TARGET_MS;
    const lo = lastCut + 60_000;
    const hi = lastCut + CHUNK_MAX_MS;
    let best = -1, bestDist = Infinity;
    for (const s of silences) {
      if (s < lo || s > hi) continue;
      const dist = Math.abs(s - target);
      if (dist < bestDist) { bestDist = dist; best = s; }
    }
    cuts.push(best >= 0 ? best : hi);
    lastCut = cuts[cuts.length - 1];
  }
  return cuts;
}

function chunks(totalMs: number, silences: number[]): number[] {
  const cuts = planChunkBoundaries(totalMs, silences);
  const bounds = [0, ...cuts, totalMs];
  return bounds.slice(1).map((b, i) => b - bounds[i]);
}

let passed = 0;
function check(name: string, cond: boolean) { assert.ok(cond, name); console.log("✓ " + name); passed++; }

const everyN = (step: number, total: number) => Array.from({ length: Math.floor(total / step) }, (_, i) => (i + 1) * step);

// ── invariant: every chunk ≤ CHUNK_MAX (the whole point — stay in-sync zone) ──
for (const total of [371_000, 357_000, 329_000, 500_000, 600_000]) {
  const cs = chunks(total, everyN(30_000, total)); // silence every 30s
  check(`${(total/1000).toFixed(0)}s w/silence → all chunks ≤ 210s (${cs.map(c=>(c/1000).toFixed(0)).join("/")})`, cs.every(c => c <= CHUNK_MAX_MS));
}

// ── 6.18-min clip (Mew's) with silences → 2-3 chunks, each in safe zone ──
const mew = chunks(371_000, everyN(20_000, 371_000));
check("371s (6.18min) → ≥2 chunks", mew.length >= 2);
check("371s → every chunk ≤ 3.5min", mew.every(c => c <= CHUNK_MAX_MS));

// ── no detectable silence → hard-cuts, still all ≤ MAX ──
const noSil = chunks(360_000, []);
check("360s no-silence → hard-cut chunks all ≤ 210s", noSil.every(c => c <= CHUNK_MAX_MS));
check("360s no-silence → [210s, 150s]", noSil.length === 2 && noSil[0] === 210_000);

// ── short clip would yield no cuts (≤ MAX) → caller does single call ──
check("200s → no cuts (single call)", planChunkBoundaries(200_000, everyN(30_000, 200_000)).length === 0);
check("threshold 240s → exactly 1 cut (then 2 chunks)", planChunkBoundaries(240_000, everyN(30_000, 240_000)).length === 1);

// ── non-final chunks respect the 60s minimum (no silence picked closer than +60s) ──
const dense = chunks(400_000, everyN(5_000, 400_000)); // silence every 5s
check("dense silence → no chunk < 60s except possibly last", dense.slice(0, -1).every(c => c >= 60_000));

console.log(`\n✅ ALL ${passed} CHUNK-PLANNER CHECKS PASSED`);
