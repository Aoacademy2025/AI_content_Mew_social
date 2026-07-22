import assert from "node:assert/strict";

import { kenBurnsZoomStepForFrames } from "../src/lib/broll-asset-lib";
import { assignBrollWindows } from "../src/lib/broll-coverage";
import { buildFixedCountBrollWindows } from "../src/lib/broll-windows";
import { planHeroAiWindowGeneration } from "../src/lib/hero-ai-broll";

// Regression fixture minimized from duckyhero's 124.37s / 23-window Auto render.
// Auto means one generated image per semantic window. The old route silently
// clamped this plan to HERO_AI_IMAGE_MAX_PER_VIDEO=20 and coverage later cycled
// those 20 assets across 32 timeline segments.
const keywords = Array.from({ length: 23 }, (_, index) => `scene ${index + 1}`);
const windowDurationsSec = Array.from({ length: 23 }, () => 124.37 / 23);

const plan = planHeroAiWindowGeneration(keywords, windowDurationsSec);

assert.equal(plan.length, 23, "Auto preserves all 23 semantic windows");
assert.deepEqual(
  plan.map((item) => item.sourceIndex),
  Array.from({ length: 23 }, (_, index) => index),
  "Auto keeps a one-to-one scene-to-image mapping",
);
assert.equal(
  new Set(plan.map((item) => item.sourceIndex)).size,
  23,
  "Auto never plans a repeated source index",
);
for (const item of plan) {
  assert.ok(
    item.kenBurnsDurationSec >= windowDurationsSec[item.sourceIndex] + 1,
    `scene ${item.sourceIndex} motion clip covers its whole window plus render safety`,
  );
}

const windows = windowDurationsSec.map((duration, index) => ({
  startMs: windowDurationsSec.slice(0, index).reduce((sum, value) => sum + value, 0) * 1000,
  endMs: windowDurationsSec.slice(0, index + 1).reduce((sum, value) => sum + value, 0) * 1000,
}));
const coverage = assignBrollWindows(
  windows,
  plan.map((item) => ({
    src: `/hero-${item.sourceIndex}.mp4`,
    sourceIndex: item.sourceIndex,
    start: 0,
    end: 0,
    clipOffset: 0,
    clipDuration: item.kenBurnsDurationSec,
  })),
  124.37,
  30,
);
assert.equal(coverage.complete, true, "Hero AI assets cover the whole Auto timeline");
assert.equal(coverage.segments.length, 23, "coverage keeps exactly one visual per semantic window");
assert.equal(
  new Set(coverage.segments.map((segment) => segment.src)).size,
  23,
  "coverage does not cycle a Hero AI asset into another semantic window",
);
assert.equal(
  planHeroAiWindowGeneration(["bounded"], [9_999])[0].kenBurnsDurationSec,
  601,
  "untrusted window duration cannot create an unbounded ffmpeg job",
);

// Manual Hero AI is pure AI and exact-count: five selected images means five
// chapters, five provider jobs, five unique assets — never stock/video padding.
const manualWindows = buildFixedCountBrollWindows(
  Array.from({ length: 20 }, (_, index) => ({
    startMs: index * 6_000,
    endMs: (index + 1) * 6_000,
    text: `manual subject ${index + 1}`,
  })),
  5,
  120_000,
);
const manualPlan = planHeroAiWindowGeneration(
  manualWindows.map((window) => window.text),
  manualWindows.map((window) => (window.endMs - window.startMs) / 1000),
);
assert.equal(manualWindows.length, 5, "manual Hero timeline contains exactly five chapters");
assert.equal(manualPlan.length, 5, "manual Hero submits exactly five RunPod image jobs");
assert.equal(new Set(manualPlan.map((item) => item.sourceIndex)).size, 5, "manual Hero never reuses a planned image");

const fiveSecondZoomStep = kenBurnsZoomStepForFrames(5 * 30);
const twentyFiveSecondZoomStep = kenBurnsZoomStepForFrames(25 * 30);
assert.ok(
  twentyFiveSecondZoomStep < fiveSecondZoomStep,
  "long manual chapters slow the Ken Burns motion instead of hitting the zoom ceiling early",
);
assert.ok(
  Math.abs(twentyFiveSecondZoomStep * 25 * 30 - 0.15) < 1e-9,
  "Ken Burns motion remains active across the entire manual chapter",
);

console.log("Hero AI Auto B-roll planning checks passed.");
