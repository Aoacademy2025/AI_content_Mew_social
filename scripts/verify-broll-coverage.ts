import assert from "node:assert/strict";
import fs from "node:fs";

import {
  BROLL_SEQUENCE_GUARD_FRAMES,
  assignBrollWindows,
  coverBrollTimeline,
  selectRepresentativeItems,
} from "../src/lib/broll-coverage";

const durationSec = 278.439;
const fps = 30;
const windows = Array.from({ length: 53 }, (_, index) => ({
  startMs: (durationSec * 1000 * index) / 53,
  endMs: (durationSec * 1000 * (index + 1)) / 53,
}));
const pool = Array.from({ length: 36 }, (_, index) => ({
  src: `/asset-${index}.mp4`,
  start: 0,
  end: 0,
  clipOffset: 0,
  clipDuration: index === 35 ? 17.3 : 4.5,
  sourceIndex: index,
}));

const assigned = assignBrollWindows(windows, pool, durationSec, fps);
assert.equal(assigned.complete, true);
assert.ok(assigned.segments.length >= windows.length);
assert.ok(Math.abs(assigned.metrics.effectiveEndSec - durationSec) <= 1 / fps);
assert.equal(assigned.metrics.gapCount, 0);

const guardSec = BROLL_SEQUENCE_GUARD_FRAMES / fps;
for (const segment of assigned.segments) {
  assert.ok(
    segment.end - segment.start <=
      (segment.clipDuration ?? 10) - (segment.clipOffset ?? 0) - guardSec + 1e-6,
  );
}

const one = coverBrollTimeline(
  [{ src: "/one.mp4", start: 0, end: 30, clipOffset: 0, clipDuration: 5 }],
  [{ src: "/one.mp4", start: 0, end: 0, clipOffset: 0, clipDuration: 5 }],
  30,
  fps,
);
assert.equal(one.complete, true);
assert.ok(one.segments.length > 1);

const exhaustedOffset = coverBrollTimeline(
  [{ src: "/offset.mp4", start: 0, end: 12, clipOffset: 4.9, clipDuration: 5 }],
  [{ src: "/offset.mp4", start: 0, end: 0, clipOffset: 4.9, clipDuration: 5 }],
  12,
  fps,
);
assert.equal(exhaustedOffset.complete, true);
assert.ok(exhaustedOffset.segments.some((segment) => segment.clipOffset === 0));

const selected = selectRepresentativeItems(
  Array.from({ length: 53 }, (_, index) => index),
  36,
);
assert.equal(selected.length, 36);
assert.ok(selected[0] <= 1);
assert.ok(selected[selected.length - 1] >= 51);

const empty = coverBrollTimeline([], [], 30, fps);
assert.equal(empty.complete, false);
assert.ok(empty.metrics.uncoveredTailSec >= 30 - 1 / fps);

const configSource = fs.readFileSync(
  "src/app/api/videos/generate-config/route.ts",
  "utf8",
);
assert.ok(!configSource.includes("Math.min(brollWindows.length, pool.length)"));
assert.ok(configSource.includes("assignBrollWindows("));
assert.ok(configSource.includes("coverBrollTimeline("));

const stockSource = fs.readFileSync(
  "src/app/api/videos/fetch-stock/route.ts",
  "utf8",
);
assert.ok(stockSource.includes("sourceIndex"));
assert.ok(stockSource.includes("selectRepresentativeItems"));

console.log("All broll-coverage checks passed.");
