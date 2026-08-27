// Behaviour checks for the public B-roll Timeline boundary interface.
// Run: npx tsx scripts/verify-broll-timeline-boundary.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canMoveBrollBoundaryExactly,
  moveBrollBoundary,
} from "../src/lib/broll-timeline-boundary";

const source = [
  { index: 0, startMs: 0, endMs: 4_000 },
  { index: 1, startMs: 4_000, endMs: 8_000 },
  { index: 2, startMs: 8_000, endMs: 12_000 },
] as const;

const moved = moveBrollBoundary(source, 0, 5_000);

assert.deepEqual(moved, {
  boundaryMs: 5_000,
  changes: [
    { index: 0, endMs: 5_000 },
    { index: 1, startMs: 5_000 },
  ],
});
assert.deepEqual(source, [
  { index: 0, startMs: 0, endMs: 4_000 },
  { index: 1, startMs: 4_000, endMs: 8_000 },
  { index: 2, startMs: 8_000, endMs: 12_000 },
]);

assert.equal(moveBrollBoundary(source, 0, 100)?.boundaryMs, 1_000);
assert.equal(moveBrollBoundary(source, 0, 7_900)?.boundaryMs, 7_000);
assert.equal(canMoveBrollBoundaryExactly(source, 0, 3_500), true);
assert.equal(canMoveBrollBoundaryExactly(source, 0, 500), false);
assert.equal(canMoveBrollBoundaryExactly([
  { index: 0, startMs: 0, endMs: 1_200 },
  { index: 1, startMs: 1_200, endMs: 8_000 },
], 0, 700), false);

assert.equal(moveBrollBoundary([
  { index: 0, startMs: 0, endMs: 3_900 },
  { index: 1, startMs: 4_000, endMs: 8_000 },
], 0, 5_000), null);
assert.equal(moveBrollBoundary([
  { index: 0, startMs: 0, endMs: 4_100 },
  { index: 1, startMs: 4_000, endMs: 8_000 },
], 0, 5_000), null);
assert.equal(moveBrollBoundary(source, 0, Number.NaN), null);
assert.equal(moveBrollBoundary([
  { index: 1, startMs: 0, endMs: 4_000 },
  { index: 0, startMs: 4_000, endMs: 8_000 },
], 1, 5_000), null);

const timelineSource = readFileSync(
  "src/app/(dashboard)/video-editor/_v2/TimelinePanel.tsx",
  "utf8",
);
assert.match(timelineSource, /onBrollBoundaryChange/);
assert.match(timelineSource, /onBrollBoundaryDown/);
assert.match(timelineSource, /แต่ละช่วงอย่างน้อย 1 วินาที/u);

console.log("B-roll Timeline shared-boundary move passed");
