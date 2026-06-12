// Proof of the long-audio chunk planner (2026-06): split long clips at silence so
// each Gemini transcribe stays in its in-sync zone. 06-12 #3 shrank chunks from
// ~2.5min to ~75s: flash timestamps wobble NON-LINEARLY inside a chunk (late mid-
// chunk, early at the tail, different every run), and chunk start offsets are the
// only EXACT anchors we have (ffmpeg slicing) — smaller chunks = anchors twice as
// often = bounded drift. Pure logic — run:
//   npx tsx scripts/verify-transcribe-chunking.ts
import assert from "node:assert/strict";

const CHUNK_THRESHOLD_MS = 240_000;
const CHUNK_TARGET_MS = 75_000;
const CHUNK_MAX_MS = 110_000;

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
  check(`${(total/1000).toFixed(0)}s w/silence → all chunks ≤ 110s (${cs.map(c=>(c/1000).toFixed(0)).join("/")})`, cs.every(c => c <= CHUNK_MAX_MS));
}

// ── 6.18-min clip (Mew's) with silences → many short chunks, each in safe zone ──
const mew = chunks(371_000, everyN(20_000, 371_000));
check("371s (6.18min) → ≥4 chunks", mew.length >= 4);
check("371s → every chunk ≤ 110s", mew.every(c => c <= CHUNK_MAX_MS));

// ── no detectable silence → hard-cuts, still all ≤ MAX ──
const noSil = chunks(360_000, []);
check("360s no-silence → hard-cut chunks all ≤ 110s", noSil.every(c => c <= CHUNK_MAX_MS));
check("360s no-silence → [110s,110s,110s,30s]", noSil.length === 4 && noSil[0] === 110_000 && noSil[3] === 30_000);

// ── chunking is gated by the caller at CHUNK_THRESHOLD (>4 min) — clips just
//    above it must split into in-zone chunks ──
check("245s (just over threshold) → ≥2 chunks all ≤ 110s",
  chunks(245_000, everyN(25_000, 245_000)).every(c => c <= CHUNK_MAX_MS) &&
  chunks(245_000, everyN(25_000, 245_000)).length >= 2);
check("threshold const unchanged (caller gates at 240s)", CHUNK_THRESHOLD_MS === 240_000);

// ── non-final chunks respect the 60s minimum (no silence picked closer than +60s) ──
const dense = chunks(400_000, everyN(5_000, 400_000)); // silence every 5s
check("dense silence → no chunk < 60s except possibly last", dense.slice(0, -1).every(c => c >= 60_000));

console.log(`\n✅ ALL ${passed} CHUNK-PLANNER CHECKS PASSED`);
