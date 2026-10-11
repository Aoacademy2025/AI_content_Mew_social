import assert from "node:assert/strict";
import { BROLL_SEQUENCE_GUARD_FRAMES, coverBrollTimeline, coverProbedBrollTimeline, type BrollCoverageAsset } from "../src/lib/broll-coverage";
import { mergeWindowEdits, validateWindowEdits } from "../src/lib/broll-rerender";

// Sanitized timing/identity only from the 2026-10-07 MCP incident. 22 original
// image imports serve 23 windows; adjacent windows 10 and 11 reuse image 14.
const boundariesMs = [0, 4167, 9700, 15467, 21067, 25767, 30567, 35133, 39933,
  44700, 48800, 53300, 57867, 62900, 67933, 73200, 77600, 82667, 86733,
  91500, 95700, 100100, 105133, 107651];
const imageIds = [5, 1, 2, 3, 4, 6, 7, 8, 9, 11, 14, 14, 15, 16, 18, 19, 12,
  17, 21, 20, 22, 13, 10];
const sources = imageIds.map((id) => `/api/stocks/broll-upload-${id}.mp4`);
assert.equal(new Set(sources).size, 22);
const windows = imageIds.map((_, index) => ({
  src: "/api/stocks/original.mp4",
  start: boundariesMs[index] / 1000,
  end: boundariesMs[index + 1] / 1000,
}));
const edits = validateWindowEdits(sources.map((src, index) => ({ index, src, clipDuration: 5, stillImage: true })));
assert.ok(!("error" in edits));
const merged = mergeWindowEdits(windows, edits);
assert.ok(!("error" in merged));
const requested = merged.bgVideos as BrollCoverageAsset[];
const covered = coverProbedBrollTimeline(requested.map((asset) => ({
  asset, actualDurationSec: 5, probeRequired: true,
})), Math.ceil(107.651 * 30) / 30, 30);
assert.equal(covered.complete, true);
const midpointMismatches = requested.flatMap((window, index) => {
  const midpoint = (window.start + window.end) / 2;
  const actual = covered.segments.find((segment) => segment.start <= midpoint && segment.end > midpoint)?.src;
  return actual === window.src ? [] : [{ index, expected: window.src, actual }];
});
console.log(JSON.stringify({ windows: 23, imports: 22, midpointMismatches }));
assert.deepEqual(midpointMismatches, [], "every selected image survives the import → edit merge → probed render path");
// Every rendered frame, using coverage's existing outward frame quantization.
for (let frame = 0; frame < Math.ceil(107.651 * 30); frame++) {
  const index = boundariesMs.findIndex((end, i) => i > 0 && frame < Math.ceil(end * 30 / 1000)) - 1;
  const time = (frame + 0.5) / 30;
  const segment = covered.segments.find((item) => time >= item.start && time < item.end);
  assert.equal(segment?.src, sources[index], `selected identity at frame ${frame}`);
}
for (const segment of covered.segments) {
  assert.equal(segment.clipDuration, 4.5, "actual 5s source keeps its real probe safety margin");
  assert.ok(segment.end - segment.start + (segment.clipOffset ?? 0)
    <= 4.5 - BROLL_SEQUENCE_GUARD_FRAMES / 30 + 1e-6, "sequence never overruns guarded source");
}
const frames = (segments: BrollCoverageAsset[]) => segments.map((s) => [s.src,
  Math.round(s.start * 30), Math.round(s.end * 30), Math.round((s.clipOffset ?? 0) * 30)]);
assert.deepEqual(frames(coverBrollTimeline(covered.segments, covered.segments,
  Math.ceil(107.651 * 30) / 30, 30).segments), frames(covered.segments), "coverage revalidation is idempotent");

for (const fps of [24, 30, 50, 60]) {
  const image = { src: "/api/stocks/generic-old-image.mp4", stillImage: true, clipOffset: 1, start: 0, end: 8 };
  const video = { src: "/api/stocks/video.mp4", start: 8, end: 12, clipOffset: 1 };
  const result = coverProbedBrollTimeline([image, video].map(asset => ({ asset,
    actualDurationSec: asset.src === image.src ? 5 : 12, probeRequired: true })), 12, fps);
  assert.equal(result.complete, true);
  assert.equal(result.segments[0].clipOffset, 1, "explicit still source offset survives");
  assert.ok(result.segments.filter(s => s.start < 8).every(s => s.src === image.src && s.end <= 8 + 1e-6));
  assert.equal(result.segments.find(s => s.start === 8)?.clipOffset, 1, "ordinary source offset survives");
}
const ordinary = coverProbedBrollTimeline([
  { asset: { src: "video-a", start: 0, end: 5.5 }, actualDurationSec: 5, probeRequired: true },
  { asset: { src: "video-b", start: 5.5, end: 9 }, actualDurationSec: 5, probeRequired: true },
], 9, 30);
assert.deepEqual(ordinary.segments.map(s => [s.src, s.start, s.end]), [
  ["video-a", 0, 25 / 6], ["video-b", 25 / 6, 8], ["video-a", 8, 9],
], "ordinary short videos retain the pre-fix safe fallback exactly");
const hidden = coverProbedBrollTimeline([
  { asset: { src: "hidden", stillImage: true, brollEnabled: false, start: 0, end: 8 }, actualDurationSec: null, probeRequired: false },
  { asset: { src: "visible", start: 8, end: 12 }, actualDurationSec: 10, probeRequired: true },
], 12, 30);
assert.equal(hidden.complete, true);
assert.equal(hidden.segments[0].brollEnabled, false);
assert.equal(hidden.segments[0].end, 8);
for (const actualDurationSec of [null, 0, 0.5, Number.NaN]) {
  const invalid = coverProbedBrollTimeline([{asset: { src: "bad", stillImage: true, start: 0, end: 8 },
    actualDurationSec, probeRequired: true }], 8, 30);
  assert.equal(invalid.complete, false, "still image cannot bypass real probe/guard requirements");
}
const replacement = mergeWindowEdits([{ src: "old", start: 0, end: 4, stillImage: true }],
  [{ index: 0, src: "/api/stocks/video.mp4" }]);
assert.ok(!("error" in replacement));
assert.equal(replacement.bgVideos[0].stillImage, undefined, "video replacement drops stale image semantics");
assert.ok("error" in validateWindowEdits([{ index: 0, enabled: true, stillImage: true }]));
assert.ok("error" in validateWindowEdits([{ index: 0, src: "/api/stocks/a.mp4", stillImage: "true" }]));
console.log("broll image hold: 3230 frames / 23 windows / 22 images, offsets, visibility, all FPS, video fallback and probe rejection passed");
