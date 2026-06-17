// Unit tests for buildMinHoldSegments in src/lib/broll-even-split.ts
// (run: npx tsx scripts/verify-broll-min-hold.ts)
//
// The point of these tests is the FREEZE-SAFE invariant Mew flagged: if a b-roll
// segment outlives its clip, the renderer (OffthreadVideo, no loop) freezes the
// last frame. Every emitted segment span MUST be ≤ its clip duration.
import { buildMinHoldSegments, type MinHoldCaption, type MinHoldPoolClip } from "../src/lib/broll-even-split";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const EPS = 1e-6;

// helper: N back-to-back captions of `each` seconds starting at 0
const denseCaps = (n: number, each: number): MinHoldCaption[] =>
  Array.from({ length: n }, (_, i) => ({ startSec: i * each, endSec: (i + 1) * each }));
const pool = (n: number, dur: number): MinHoldPoolClip[] =>
  Array.from({ length: n }, (_, i) => ({ src: `clip-${i}.mp4`, duration: dur }));

// ── env gate: minHold<=0 → null (legacy path untouched) ──
check("gate: minHold=0 → null", buildMinHoldSegments(denseCaps(10, 1), pool(5, 10), 0) === null);
check("gate: negative → null", buildMinHoldSegments(denseCaps(10, 1), pool(5, 10), -2) === null);
check("gate: minHold>0 → array", Array.isArray(buildMinHoldSegments(denseCaps(10, 1), pool(5, 10), 3)));

// ── empty inputs ──
check("empty captions → []", (buildMinHoldSegments([], pool(5, 10), 3) as unknown[]).length === 0);
check("empty pool → []", (buildMinHoldSegments(denseCaps(5, 1), [], 3) as unknown[]).length === 0);

// ── THE FREEZE GUARD: every segment span ≤ its clip duration ──
{
  // dense 1s captions, generous 10s clips, minHold 3s
  const segs = buildMinHoldSegments(denseCaps(90, 1), pool(36, 10), 3)!;
  const freezes = segs.filter((s) => (s.end - s.start) - (s.clipDuration ?? 0) > EPS);
  check("freeze-guard: no segment outlives its clip (90×1s / 10s clips)", freezes.length === 0,
    `${segs.length} segs, ${freezes.length} would freeze`);
  check("cadence: 90 captions → far fewer cuts", segs.length <= 35 && segs.length >= 25,
    `${segs.length} cuts (was 90)`);
  check("offset always 0 (full clip available)", segs.every((s) => s.clipOffset === 0));
  const avg = segs.reduce((a, s) => a + (s.end - s.start), 0) / segs.length;
  check("min-hold: avg span ≈ 3s", avg >= 2.9 && avg <= 3.2, `avg ${avg.toFixed(2)}s`);
  check("coverage: contiguous, no gaps/overlap (back-to-back caps)",
    segs.every((s, i) => i === 0 || Math.abs(s.start - segs[i - 1].end) < EPS));
  check("coverage: spans full 0→90s", Math.abs(segs[0].start) < EPS && Math.abs(segs[segs.length - 1].end - 90) < EPS);
}

// ── EDGE: a single caption LONGER than the clip → must split, never freeze ──
{
  const segs = buildMinHoldSegments([{ startSec: 0, endSec: 12 }], pool(1, 5), 3)!;
  const freezes = segs.filter((s) => (s.end - s.start) - s.clipDuration > EPS);
  check("edge: 12s caption / 5s clip → split, zero freeze", freezes.length === 0, `${segs.length} segs`);
  check("edge: split covers full 12s", Math.abs(segs[0].start) < EPS && Math.abs(segs[segs.length - 1].end - 12) < EPS);
  check("edge: ≥3 sub-segments (12/5)", segs.length >= 3, `${segs.length}`);
}

// ── EDGE: minHold larger than clip duration → guard caps bucket at clip, not minHold ──
{
  // 1s captions, 5s clips, ask for 8s hold → buckets must stay ≤5s (freeze guard wins)
  const segs = buildMinHoldSegments(denseCaps(40, 1), pool(10, 5), 8)!;
  const tooLong = segs.filter((s) => (s.end - s.start) - s.clipDuration > EPS);
  check("edge: minHold(8s) > clip(5s) → no freeze (guard caps bucket)", tooLong.length === 0);
  check("edge: buckets capped near clip length (≤5s)", segs.every((s) => s.end - s.start <= 5 + EPS));
}

// ── pool cycling: distinct clips used, then repeat ──
{
  const segs = buildMinHoldSegments(denseCaps(30, 1), pool(3, 10), 3)!; // ~10 buckets, pool of 3
  const srcs = segs.map((s) => s.src);
  check("cycling: uses all pool clips", new Set(srcs).size === 3, `${new Set(srcs).size} distinct`);
  check("cycling: adjacent segments differ", srcs.every((s, i) => i === 0 || s !== srcs[i - 1]));
}

// ── mixed clip durations: guard uses the RIGHT clip's duration per bucket ──
{
  const mixed: MinHoldPoolClip[] = [
    { src: "long.mp4", duration: 10 },
    { src: "short.mp4", duration: 2 },
  ];
  const segs = buildMinHoldSegments(denseCaps(20, 1), mixed, 4)!;
  const freezes = segs.filter((s) => (s.end - s.start) - s.clipDuration > EPS);
  check("mixed-dur: no freeze when a short clip is in the pool", freezes.length === 0,
    `${segs.length} segs`);
  // the 2s clip's buckets must be ≤2s; the 10s clip's buckets ≈4s
  const shortSegs = segs.filter((s) => s.src === "short.mp4");
  check("mixed-dur: short(2s) clip buckets ≤ 2s", shortSegs.every((s) => s.end - s.start <= 2 + EPS),
    `${shortSegs.length} short segs`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
