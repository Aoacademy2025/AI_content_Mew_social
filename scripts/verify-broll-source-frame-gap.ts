/** Numeric regression for the October 2026 source gap; no customer media or services. */
import assert from "node:assert/strict";
import { coverBrollTimeline, BROLL_SUPPORTED_FPS } from "../src/lib/broll-coverage";
import { mergeWindowEdits, type WindowEdit } from "../src/lib/broll-rerender";

const boundaries = [
  [0, 6.333333333333333], [6.333333333333333, 9.6], [9.6, 13.6],
  [13.6, 20.766666666666666], [20.766666666666666, 22.333333333333332],
  [22.333333333333332, 31.7], [31.7, 35.4], [35.4, 39.3],
  [39.3, 43.96666666666666], [43.96666666666667, 50.2],
  [50.2, 53.199999999999996], [53.199999999999996, 56.9],
  [56.9, 63.766666666666666], [63.766666666666666, 68.43333333333334],
  [68.43333333333334, 72.46666666666667], [72.46666666666667, 75.76666666666667],
  [75.76666666666667, 80.33333333333333], [80.33333333333333, 83.7],
  [83.7, 87.06666666666666], [87.06666666666666, 88.8],
  [88.83333333333333, 91.246],
];
const source = boundaries.map(([start, end], sourceIndex) => ({
  start, end, sourceIndex, src: `/api/stocks/source-${sourceIndex}.mp4`,
  clipDuration: 100, clipOffset: 0, provider: "pexels" as const,
}));
const original = structuredClone(source);
const edits: WindowEdit[] = [
  { index: 17, start: 79.409, end: 82.663 }, { index: 16, start: 75.696, end: 79.409 },
  { index: 0, end: 3.125 }, { index: 1, start: 3.125 },
  { index: 18, start: 82.663, end: 86.275 }, { index: 19, start: 86.275 },
  { index: 15, end: 75.696 },
];

// Test modes make both independent failures observable before implementation.
if (process.argv[2] !== "generation") {
  const merged = mergeWindowEdits(source, edits);
  assert.ok("bgVideos" in merged, "an untouched generated frame gap must not veto valid shared-boundary edits");
  assert.equal(merged.bgVideos.length, source.length);
  for (let index = 0; index < source.length; index++) {
    assert.deepEqual(merged.bgVideos[index], { ...source[index], ...Object.fromEntries(
      Object.entries(edits.find((edit) => edit.index === index) ?? {}).filter(([key]) => key !== "index"),
    ) }, `only requested edits change window ${index}; identity and source playback survive`);
  }
  assert.deepEqual(source, original, "source config is immutable");
  assert.equal(merged.bgVideos[0].start, 0);
  assert.equal(merged.bgVideos.at(-1)?.end, 91.246);
  assert.equal(merged.bgVideos[19].end, 88.8, "legacy gap geometry is preserved");
  assert.equal(merged.bgVideos[20].start, 88.83333333333333);

  const unrelated: WindowEdit[] = [{ index: 0, end: 3.125 }, { index: 1, start: 3.125 }];
  for (const [label, changed] of [
    ["larger gap", [{ index: 20, start: 88.86666666666666 }]],
    ["smaller gap", [{ index: 20, start: 88.81666666666666 }]],
    ["moved frame gap", [{ index: 19, end: 88.76666666666667 }, { index: 20, start: 88.8 }]],
    ["overlap", [{ index: 20, start: 88.76666666666667 }]],
    ["new frame gap", [{ index: 0, end: 3.1 }, { index: 1, start: 3.1333333333333333 }]],
    ["outer start", [{ index: 0, start: 1 }]],
    ["outer end", [{ index: 20, end: 92 }]],
  ] as [string, WindowEdit[]][]) {
    assert.ok("error" in mergeWindowEdits(source, [...unrelated, ...changed]), `${label} must be rejected`);
  }
  for (const gap of [0.001, 0.02, 0.05, 2 / 30, 0.5, -1 / 30]) {
    const invalid = structuredClone(source);
    invalid[20].start = invalid[19].end + gap;
    assert.ok("error" in mergeWindowEdits(invalid, unrelated), `arbitrary inherited gap/overlap ${gap} is rejected`);
  }
  const offGrid = structuredClone(source);
  offGrid[19].end += 0.01;
  offGrid[20].start += 0.01;
  assert.ok("error" in mergeWindowEdits(offGrid, unrelated), "a non-frame-aligned source gap is not legacy frame rounding");
  assert.ok("bgVideos" in mergeWindowEdits(source, [
    { index: 19, end: 89 }, { index: 20, start: 89 },
  ]), "an explicit shared-boundary repair of the legacy gap is valid");
  const contiguous = structuredClone(source);
  contiguous[20].start = contiguous[19].end;
  for (const edit of [
    { index: 19, end: 88.76666666666667 },
    { index: 20, start: 88.83333333333333 },
  ]) {
    assert.ok("error" in mergeWindowEdits(contiguous, [edit]),
      "moving either edge alone cannot introduce even an exactly one-frame gap");
  }
}

if (process.argv[2] !== "legacy") {
  // The exact generation seam used by generate-config and render coverage used to
  // retain this source gap while returning complete=true and coverageRatio=1.
  const coverage = coverBrollTimeline(source, source, 91.246, 30);
  assert.equal(coverage.complete, true);
  assert.equal(coverage.segments.length, source.length);
  for (let index = 1; index < coverage.segments.length; index++) {
    assert.equal(coverage.segments[index].start, coverage.segments[index - 1].end,
      `generation must emit a shared boundary at ${index}`);
    assert.equal(coverage.segments[index].src, source[index].src);
    assert.equal(coverage.segments[index].sourceIndex, index);
  }
  assert.equal(coverage.segments[0].start, 0);
  assert.equal(coverage.segments.at(-1)?.end, 91.246);
  assert.ok("bgVideos" in mergeWindowEdits(coverage.segments, edits));

  for (const fps of BROLL_SUPPORTED_FPS) {
    const desired = [
      { src: "/a.mp4", start: 0, end: 5, clipDuration: 20 },
      { src: "/b.mp4", start: 5 + 1 / fps, end: 10, clipDuration: 20 },
    ];
    const result = coverBrollTimeline(desired, desired, 10, fps);
    assert.equal(result.complete, true);
    assert.equal(result.segments[1].start, result.segments[0].end, `no generated gap at ${fps} fps`);
    const presenter = desired.map((asset) => ({ ...asset, timelineAligned: true }));
    const aligned = coverBrollTimeline(presenter, presenter, 10, fps);
    assert.ok(aligned.segments.every((asset) => asset.clipOffset === asset.start),
      "presenter playback retains the narration/source clock when a gap is filled");
  }
  assert.deepEqual(source, original, "generation must not mutate the saved source");
}
console.log("verify-broll-source-frame-gap: OK");
