// Regression contract for desktop Timeline wheel navigation.
// Run: npx tsx scripts/verify-timeline-wheel-scroll.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nextTimelineScrollLeft } from "../src/app/(dashboard)/video-editor/_v2/timeline-wheel-scroll";

const base = {
  scrollLeft: 200,
  scrollWidth: 2000,
  clientWidth: 800,
  deltaX: 0,
  deltaY: 120,
  deltaMode: 0,
  ctrlKey: false,
};

assert.equal(
  nextTimelineScrollLeft(base),
  320,
  "a vertical mouse wheel moves the Timeline horizontally",
);
assert.equal(
  nextTimelineScrollLeft({ ...base, deltaX: -80, deltaY: 12 }),
  120,
  "a horizontal trackpad gesture keeps its dominant axis and direction",
);
assert.equal(
  nextTimelineScrollLeft({ ...base, scrollLeft: 1180 }),
  1200,
  "wheel navigation clamps at the right edge",
);
assert.equal(
  nextTimelineScrollLeft({ ...base, scrollLeft: 1200 }),
  null,
  "an outward gesture at the right edge is not consumed",
);
assert.equal(
  nextTimelineScrollLeft({ ...base, scrollLeft: 0, deltaY: -120 }),
  null,
  "an outward gesture at the left edge is not consumed",
);
assert.equal(
  nextTimelineScrollLeft({ ...base, scrollWidth: 800 }),
  null,
  "the gesture is not consumed when the Timeline does not overflow",
);
assert.equal(
  nextTimelineScrollLeft({ ...base, ctrlKey: true }),
  null,
  "browser pinch-to-zoom is not hijacked",
);
assert.equal(
  nextTimelineScrollLeft({ ...base, deltaY: 3, deltaMode: 1 }),
  248,
  "line-based wheel deltas are normalized to pixels",
);
assert.equal(
  nextTimelineScrollLeft({ ...base, deltaY: 1, deltaMode: 2 }),
  1000,
  "page-based wheel deltas use the visible Timeline width",
);

const timelineSource = readFileSync(
  "src/app/(dashboard)/video-editor/_v2/TimelinePanel.tsx",
  "utf8",
);

assert.match(
  timelineSource,
  /addEventListener\("wheel", onTimelineWheel, \{ passive: false \}\)/,
  "the horizontal track scroller uses a non-passive wheel listener",
);
assert.match(
  timelineSource,
  /if \(nextScrollLeft == null\) return;[\s\S]*preventDefault\(\)/,
  "the Timeline prevents page scroll only when it consumes the wheel movement",
);
assert.match(
  timelineSource,
  /removeEventListener\("wheel", onTimelineWheel\)/,
  "the wheel listener is removed when the Timeline unmounts",
);

console.log("Timeline wheel-scroll wiring verified.");
