// Proof of the editor playbackTime store + binary-search caption lookup.
// Pure logic — no DB, no React rendering. Run:
//   npx tsx scripts/verify-editor-playback.ts
import { playbackTime } from "../src/app/(dashboard)/video-editor/_lib/playback-time";
import { findActiveCaptionIdx } from "../src/app/(dashboard)/video-editor/_lib/find-active-caption";
import type { Caption } from "../src/app/(dashboard)/video-editor/_components/types";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

// ── playbackTime store ──────────────────────────────────────────────────────
assert(playbackTime.getMs() === 0, "store starts at 0");
playbackTime.setMs(1234.5);
assert(playbackTime.getMs() === 1234.5, "setMs/getMs round-trip");

let calls = 0;
const unsub = playbackTime.subscribe(() => { calls++; });
playbackTime.setMs(2000);
assert(calls === 1, "subscriber notified on change");
playbackTime.setMs(2000);
assert(calls === 1, "NO notification when value unchanged");
let calls2 = 0;
const unsub2 = playbackTime.subscribe(() => { calls2++; });
playbackTime.setMs(3000);
assert(calls === 2 && calls2 === 1, "multiple subscribers each notified once");
unsub();
playbackTime.setMs(4000);
assert(calls === 2 && calls2 === 2, "unsubscribed listener no longer notified");
unsub2();
playbackTime.setMs(0); // reset for repeat runs

// ── findActiveCaptionIdx — must be EXACTLY equivalent to the old per-frame
//    captions.findIndex(c => ms >= c.startMs && ms < c.endMs) on the sorted,
//    non-overlapping captions normalizeCaptionsForTimeline produces ──────────
const caps: Caption[] = [
  { text: "a", startMs: 0,    endMs: 1000 },
  { text: "b", startMs: 1000, endMs: 2500 },
  // gap 2500–3000
  { text: "c", startMs: 3000, endMs: 4000 },
];
assert(findActiveCaptionIdx([], 500) === -1, "empty captions → -1");
assert(findActiveCaptionIdx(caps, -10) === -1, "before first start → -1");
assert(findActiveCaptionIdx(caps, 0) === 0, "exact startMs is inclusive");
assert(findActiveCaptionIdx(caps, 999.9) === 0, "just before endMs → same caption");
assert(findActiveCaptionIdx(caps, 1000) === 1, "endMs exclusive / next startMs inclusive");
assert(findActiveCaptionIdx(caps, 2700) === -1, "gap between captions → -1");
assert(findActiveCaptionIdx(caps, 3500) === 2, "inside last caption");
assert(findActiveCaptionIdx(caps, 4000) === -1, "exact last endMs → -1 (exclusive)");
assert(findActiveCaptionIdx(caps, 99999) === -1, "after last caption → -1");

// Randomized equivalence vs the old findIndex
for (let trial = 0; trial < 50; trial++) {
  const n = 1 + Math.floor(Math.random() * 40);
  const fixture: Caption[] = [];
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const gap = Math.random() < 0.3 ? Math.floor(Math.random() * 500) : 0;
    const start = cursor + gap;
    const end = start + 100 + Math.floor(Math.random() * 3000);
    fixture.push({ text: `c${i}`, startMs: start, endMs: end });
    cursor = end;
  }
  const totalEnd = fixture[fixture.length - 1].endMs;
  for (let probe = 0; probe < 20; probe++) {
    const t = Math.random() * (totalEnd + 1000) - 200;
    const expected = fixture.findIndex(c => t >= c.startMs && t < c.endMs);
    const actual = findActiveCaptionIdx(fixture, t);
    if (actual !== expected) {
      console.error(`❌ mismatch at t=${t}: expected ${expected}, got ${actual}`, JSON.stringify(fixture));
      process.exit(1);
    }
  }
}
console.log("✓ binary search ≡ findIndex on 50 random non-overlapping fixtures × 20 probes");
passed++;

console.log(`\nAll ${passed} checks passed ✅`);
