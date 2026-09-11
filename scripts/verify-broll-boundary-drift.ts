/**
 * HERO-21 — a boundary that differs only by floating-point representation error is the
 * SAME boundary, and must not make every timing edit on a video impossible.
 *
 * Production, 2026-09-11. A creator dragged the boundary between B-roll window 0 and
 * window 1. The editor accepted the drag and sent a correct shared-boundary move:
 * window 0 end = 4.267, window 1 start = 4.267, byte-identical. The render failed four
 * times in 101 seconds with "เส้นแบ่ง B-roll ต้องต่อเนื่องและห้ามซ้อนกัน", and the creator
 * gave up.
 *
 * The moved boundary was never the problem. `mergeWindowEdits` validates EVERY adjacent
 * pair, and one untouched pair in the source preview differed by ~3.6e-15 seconds:
 *
 *     window 8 end   42.23333333333333
 *     window 9 start 42.233333333333334
 *
 * With a zero tolerance that is a gap, so the merge was refused however the creator
 * edited. The editor could not warn them: it validates only the boundary being dragged.
 *
 * The boundary list below is the real one from that failure, reproduced digit for digit.
 *
 * Pure: no DB, no network, no React. Run with `npx tsx scripts/verify-broll-boundary-drift.ts`.
 */

import assert from "node:assert/strict";
import { mergeWindowEdits, type WindowEdit } from "../src/lib/broll-rerender";
import { brollWindowSpans } from "../src/lib/broll-spans";
import { moveBrollBoundary } from "../src/lib/broll-timeline-boundary";

/** The 27 windows of the failing preview, exactly as production stored them. */
const BOUNDARIES: [number, number][] = [
  [0, 4.266666666666667],
  [4.266666666666667, 8.466666666666667],
  [8.466666666666667, 13.133333333333333],
  [13.133333333333333, 18.933333333333334],
  [18.933333333333334, 23.03333333333333],
  [23.03333333333333, 27.4],
  [27.4, 32.9],
  [32.9, 37.56666666666666],
  [37.56666666666666, 42.23333333333333],
  // ── the drifted pair: this start is NOT the previous end, by ~3.6e-15 s ──
  [42.233333333333334, 51.4],
  [51.4, 56.06666666666666],
  [56.06666666666666, 62.8],
  [62.8, 67.23333333333333],
  [67.23333333333333, 73.86666666666666],
  [73.86666666666666, 77.9],
  [77.9, 82.73333333333333],
  [82.73333333333333, 87.2],
  [87.2, 93.03333333333333],
  [93.03333333333333, 97.63333333333333],
  [97.63333333333333, 102.1],
  [102.1, 108.56666666666666],
  [108.56666666666666, 114.53333333333333],
  [114.53333333333333, 118.86666666666666],
  [118.86666666666666, 124.93333333333334],
  [124.93333333333334, 129.6],
  [129.6, 134.26666666666665],
  [134.26666666666665, 138.506],
];

const sourceWindows = () =>
  BOUNDARIES.map(([start, end], index) => ({ start, end, src: `/stock/${index}.mp4`, provider: "pexels" }));

// The premise: the drift is real, and it is smaller than a microsecond.
const drift = Math.abs(BOUNDARIES[9][0] - BOUNDARIES[8][1]);
assert.ok(drift > 0, "the fixture must keep the real drift — a reformat that collapses it destroys this test");
assert.ok(drift < 1e-9, "the drift is representation error, not a real gap");

// ── The exact edit the creator sent ───────────────────────────────────────────

const creatorEdit: WindowEdit[] = [{ index: 0, end: 4.267 }, { index: 1, start: 4.267 }];
const merged = mergeWindowEdits(sourceWindows(), creatorEdit);
assert.ok(
  !("error" in merged),
  `moving an exactly aligned boundary must succeed; an untouched pair 3.6e-15 s apart must not veto it (got: ${"error" in merged ? merged.error : ""})`,
);
assert.equal((merged as { bgVideos: Record<string, unknown>[] }).bgVideos[0].end, 4.267, "the edited end must be applied");
assert.equal((merged as { bgVideos: Record<string, unknown>[] }).bgVideos[1].start, 4.267, "the edited start must be applied");
assert.equal(
  (merged as { bgVideos: Record<string, unknown>[] }).bgVideos.length,
  BOUNDARIES.length,
  "every window must survive the merge",
);

// Dragging the drifted boundary itself must work too, not just the ones away from it.
const acrossDrift = mergeWindowEdits(sourceWindows(), [{ index: 8, end: 43 }, { index: 9, start: 43 }]);
assert.ok(!("error" in acrossDrift), "the drifted boundary must itself be draggable");

// ── A real gap or overlap must STILL be refused ───────────────────────────────

const withGap = sourceWindows();
withGap[9].start = withGap[8].end + 0.5;
const gapRes = mergeWindowEdits(withGap, creatorEdit);
assert.ok("error" in gapRes && gapRes.error.includes("ต่อเนื่อง"), "a half-second gap must still be refused");

const withOverlap = sourceWindows();
withOverlap[9].start = withOverlap[8].end - 0.05;
const overlapRes = mergeWindowEdits(withOverlap, creatorEdit);
assert.ok("error" in overlapRes && overlapRes.error.includes("ต่อเนื่อง"), "a 50 ms overlap must still be refused");

// A window shorter than the one-second minimum must still be refused.
const tooShort = mergeWindowEdits(sourceWindows(), [{ index: 0, end: 0.5 }, { index: 1, start: 0.5 }]);
assert.ok("error" in tooShort && tooShort.error.includes("1 วินาที"), "the minimum window length must still hold");

// ── The editor must not inherit the same drift in its own units ───────────────

const spans = brollWindowSpans({ bgVideos: sourceWindows() }, 138_506);
assert.equal(spans.length, BOUNDARIES.length, "every window must reach the editor timeline");
for (let i = 1; i < spans.length; i++) {
  assert.equal(
    spans[i].startMs,
    spans[i - 1].endMs,
    `editor spans must share one boundary value at index ${i}; a drifted pair makes that boundary undraggable`,
  );
  assert.ok(Number.isInteger(spans[i].startMs), "editor spans must be whole milliseconds");
}
assert.ok(
  moveBrollBoundary(spans.map(s => ({ index: s.index, startMs: s.startMs, endMs: s.endMs })), 8, 43_000) !== null,
  "the editor must allow dragging the boundary that carried the drift",
);

console.log("verify-broll-boundary-drift: OK");
