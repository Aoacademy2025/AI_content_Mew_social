import assert from "node:assert/strict";
import fs from "node:fs";

import {
  BROLL_SEQUENCE_GUARD_FRAMES,
  MAX_BROLL_DURATION_SEC,
  MAX_BROLL_SEGMENTS,
  BrollCoverageError,
  assignBrollWindows,
  buildBrollRenderCoverage,
  coverBrollTimeline,
  coverProbedBrollTimeline,
  prepareBrollRenderAssets,
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

const timelineAlignedPresenter = coverBrollTimeline(
  [{
    src: "/uploaded-presenter.mp4",
    start: 4,
    end: 8,
    clipOffset: 4,
    clipDuration: 12,
    timelineAligned: true,
  }],
  [{
    src: "/uploaded-presenter.mp4",
    start: 0,
    end: 0,
    clipOffset: 0,
    clipDuration: 12,
    timelineAligned: true,
  }],
  12,
  fps,
);
assert.equal(timelineAlignedPresenter.complete, true);
assert.equal(
  timelineAlignedPresenter.segments.every((segment) =>
    segment.timelineAligned !== true || Math.abs((segment.clipOffset ?? -1) - segment.start) <= 1 / fps),
  true,
  "uploaded presenter repair segments resume at their timeline time instead of frame zero",
);

// Minimized from duckyhero's rendered A→B(0.1–0.2s)→A transitions. A preferred
// source that is only slightly too short must not leave a micro fallback at the end
// of each semantic window.
const duckyRepair = assignBrollWindows(
  [
    { startMs: 0, endMs: 4_400 },
    { startMs: 4_400, endMs: 8_800 },
  ],
  [
    { src: "/ducky-a.mp4", start: 0, end: 0, clipOffset: 0, clipDuration: 4.5, sourceIndex: 0 },
    { src: "/ducky-b.mp4", start: 0, end: 0, clipOffset: 0, clipDuration: 8, sourceIndex: 2 },
  ],
  8.8,
  fps,
);
assert.equal(duckyRepair.complete, true);
assert.equal(
  duckyRepair.segments.some((segment) => segment.end - segment.start < 1 - 1e-6),
  false,
  "coverage never creates a sub-second visual repair for normal 4s windows",
);
assert.equal(
  duckyRepair.segments.some((segment, index, all) =>
    index > 0
    && index < all.length - 1
    && all[index - 1].src === all[index + 1].src
    && all[index - 1].src !== segment.src
    && segment.end - segment.start < 1 - 1e-6),
  false,
  "coverage never creates a micro A-B-A flash",
);

const duckyDistinctRepair = assignBrollWindows(
  [
    { startMs: 0, endMs: 4_400 },
    { startMs: 4_400, endMs: 8_800 },
  ],
  [
    { src: "/ducky-a.mp4", start: 0, end: 0, clipOffset: 0, clipDuration: 4.5, sourceIndex: 0 },
    { src: "/ducky-c.mp4", start: 0, end: 0, clipOffset: 0, clipDuration: 4.5, sourceIndex: 1 },
    { src: "/ducky-b.mp4", start: 0, end: 0, clipOffset: 0, clipDuration: 8, sourceIndex: 2 },
  ],
  8.8,
  fps,
);
assert.equal(duckyDistinctRepair.complete, true);
assert.equal(
  duckyDistinctRepair.segments.some((segment) => segment.end - segment.start < 1 - 1e-6),
  false,
  "coverage balances a short repair tail even when adjacent windows use different sources",
);
assert.equal(
  duckyDistinctRepair.segments.some((segment, index, all) => {
    if (index === 0 || all[index - 1].src !== segment.src) return false;
    const previous = all[index - 1];
    const expectedOffset = (previous.clipOffset ?? 0) + (previous.end - previous.start);
    return Math.abs((segment.clipOffset ?? 0) - expectedOffset) > 1 / fps;
  }),
  false,
  "adjacent same-source repairs continue playback instead of restarting at frame zero",
);
assert.equal(
  duckyDistinctRepair.segments.some((segment, index, all) =>
    index > 0 && all[index - 1].src === segment.src),
  false,
  "continuous same-source repairs are compacted before reaching Remotion",
);
const duckySecondCoverage = coverBrollTimeline(
  duckyDistinctRepair.segments,
  duckyDistinctRepair.segments,
  8.8,
  fps,
);

const hiddenCoverage = coverProbedBrollTimeline(
  [
    {
      asset: {
        src: "/api/stocks/hidden-does-not-need-a-file.mp4",
        start: 0,
        end: 4,
        sourceIndex: 0,
        brollEnabled: false,
      },
      actualDurationSec: null,
      probeRequired: false,
    },
    {
      asset: {
        src: "/api/stocks/visible.mp4",
        start: 4,
        end: 8,
        sourceIndex: 1,
      },
      actualDurationSec: 8,
      probeRequired: true,
    },
  ],
  8,
  fps,
);
assert.equal(hiddenCoverage.complete, true, "hidden windows remain valid coverage without probing media");
assert.equal(hiddenCoverage.segments[0].brollEnabled, false, "hidden coverage marker survives normalization");
assert.equal(hiddenCoverage.segments[0].start, 0, "hidden window start is preserved");
assert.equal(hiddenCoverage.segments[0].end, 4, "hidden window end is preserved");
const renderedFrames = (segments: typeof duckyDistinctRepair.segments) => segments.map((segment) => ({
  src: segment.src,
  startFrame: Math.round(segment.start * fps),
  endFrame: Math.round(segment.end * fps),
  offsetFrame: Math.round((segment.clipOffset ?? 0) * fps),
}));
assert.deepEqual(
  renderedFrames(duckySecondCoverage.segments),
  renderedFrames(duckyDistinctRepair.segments),
  "coverage is idempotent when generate-config or render preflight validates an already-safe timeline",
);

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

for (const invalidDuration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  const invalid = coverBrollTimeline(pool, pool, invalidDuration, fps);
  assert.equal(invalid.complete, false);
  assert.equal(invalid.segments.length, 0);
  assert.equal(invalid.metrics.coverageRatio, 0);
}

for (const unsupportedFps of [1, 25, 1000, Number.POSITIVE_INFINITY]) {
  const invalid = coverBrollTimeline(pool, pool, durationSec, unsupportedFps);
  assert.equal(invalid.complete, false);
  assert.equal(invalid.segments.length, 0);
}

const overlong = coverBrollTimeline(pool, pool, MAX_BROLL_DURATION_SEC + 1, fps);
assert.equal(overlong.complete, false);

const attackerSpans = Array.from({ length: 50_000 }, (_, index) => ({
  src: "/attacker.mp4",
  start: index / 50_000,
  end: (index + 1) / 50_000,
  clipDuration: 5,
}));
const bounded = coverBrollTimeline(attackerSpans, attackerSpans, 1, fps);
assert.equal(bounded.complete, false);
assert.ok(bounded.segments.length <= Math.min(MAX_BROLL_SEGMENTS, fps));

const nearGuard = coverBrollTimeline(
  [{ src: "/tiny.mp4", start: 0, end: 1, clipDuration: guardSec + 0.00002 }],
  [{ src: "/tiny.mp4", start: 0, end: 0, clipDuration: guardSec + 0.00002 }],
  1,
  fps,
);
assert.equal(nearGuard.complete, false);
assert.ok(nearGuard.segments.length <= Math.ceil(fps));

const probed = coverProbedBrollTimeline(
  [
    {
      asset: { src: "/missing.mp4", start: 0, end: 10, clipDuration: 10 },
      actualDurationSec: null,
      probeRequired: true,
    },
    {
      asset: { src: "/short.mp4", start: 10, end: 30, clipDuration: 30 },
      actualDurationSec: 5,
      probeRequired: true,
    },
  ],
  30,
  fps,
);
assert.equal(probed.complete, true);
assert.equal(probed.droppedAssetCount, 1);
assert.ok(probed.segments.every((segment) => segment.src === "/short.mp4"));
assert.ok(probed.segments.every((segment) => segment.clipDuration === 4.5));

const allMissing = coverProbedBrollTimeline(
  [{ asset: { src: "/missing.mp4", start: 0, end: 30 }, actualDurationSec: null, probeRequired: true }],
  30,
  fps,
);
assert.equal(allMissing.complete, false);
assert.equal(allMissing.segments.length, 0);

const tooShortProbe = coverProbedBrollTimeline(
  [{ asset: { src: "/tiny.mp4", start: 0, end: 30 }, actualDurationSec: 0.4, probeRequired: true }],
  30,
  fps,
);
assert.equal(tooShortProbe.complete, false);
assert.equal(tooShortProbe.droppedAssetCount, 1);

const externalUnverified = coverProbedBrollTimeline(
  [{ asset: { src: "https://example.invalid/clip.mp4", start: 0, end: 30 }, actualDurationSec: null, probeRequired: false }],
  30,
  fps,
);
assert.equal(externalUnverified.complete, false);
assert.equal(externalUnverified.droppedAssetCount, 1);

const renderCoverage = buildBrollRenderCoverage(
  [
    { asset: { src: "/missing.mp4", start: 0, end: 10, sourceIndex: 0 }, actualDurationSec: null, probeRequired: true },
    { asset: { src: "/short.mp4", start: 10, end: 30, sourceIndex: 1 }, actualDurationSec: 5, probeRequired: true },
  ],
  30,
  fps,
  { requestedWindowCount: "user supplied text", resolutionDroppedAssetCount: 1 },
);
assert.equal(renderCoverage.coverage.complete, true);
assert.deepEqual(Object.keys(renderCoverage.telemetry).sort(), [
  "availableAssetCount",
  "coverageGapCount",
  "coverageRatio",
  "coverageRejected",
  "coverageRepairCount",
  "coverageSegmentCount",
  "distinctAssetCount",
  "requestedWindowCount",
  "uncoveredTailSec",
].sort());
assert.equal(renderCoverage.telemetry.requestedWindowCount, 2);
assert.equal(typeof renderCoverage.telemetry.requestedWindowCount, "number");
assert.equal(renderCoverage.telemetry.coverageRejected, false);

const typedError = new BrollCoverageError("coverage failed", allMissing.metrics);
assert.equal(typedError.code, "broll_coverage_incomplete");
assert.equal(typedError.metrics.uncoveredTailSec, 30);

const configSource = fs.readFileSync(
  "src/app/api/videos/generate-config/route.ts",
  "utf8",
);
assert.ok(!configSource.includes("Math.min(brollWindows.length, pool.length)"));
assert.ok(configSource.includes("assignBrollWindows("));
assert.ok(configSource.includes("coverBrollTimeline("));
assert.ok(configSource.includes("mappingRepairCount + coverage.metrics.repairedSegmentCount"));
assert.ok(configSource.includes("Number.isFinite(audioDurationMs)"));
assert.ok(configSource.includes("Number.isFinite(fps)"));
assert.ok(configSource.includes("requestedBrollWindowCount"));

const stockSource = fs.readFileSync(
  "src/app/api/videos/fetch-stock/route.ts",
  "utf8",
);
assert.ok(stockSource.includes("sourceIndex"));
assert.ok(stockSource.includes("selectRepresentativeItems"));
assert.ok(stockSource.includes("requestedWindowCount"));
assert.ok(configSource.includes("broll_config_coverage"));

const orchestratorSource = fs.readFileSync(
  "src/lib/mcp/orchestrator.ts",
  "utf8",
);
assert.ok(orchestratorSource.includes("broll_stock_inventory"));

const renderSource = fs.readFileSync(
  "src/app/api/videos/render/route.ts",
  "utf8",
);
assert.ok(renderSource.includes("prepareBrollRenderAssets("));
assert.ok(renderSource.includes("broll_coverage_rejected"));
assert.ok(renderSource.includes("error instanceof BrollCoverageError"));
assert.ok(!renderSource.includes("Math.max(0.5, actualDur - 0.5)"));
assert.ok(renderSource.includes("coverageTelemetryProperties"));
assert.ok(renderSource.includes("shortVideoConfig.requestedBrollWindowCount"));

const compositionSource = fs.readFileSync(
  "src/remotion/ShortVideoComposition.tsx",
  "utf8",
);
assert.ok(
  !compositionSource.includes(
    "last.src === v.src && Math.abs(last.endFrame - startFrame) <= 1",
  ),
);

async function verifyRenderPreflight(): Promise<void> {
  const probedPaths: string[] = [];
  const prepared = await prepareBrollRenderAssets(
    [
      { src: "/missing.mp4", start: 0, end: 10, sourceIndex: 0 },
      { src: "/short.mp4", start: 10, end: 20, sourceIndex: 1 },
      { src: "/short.mp4", start: 20, end: 30, sourceIndex: 2 },
    ],
    30,
    fps,
    {
      requestedWindowCount: "not numeric",
      resolveAsset: (src) => ({ src, localPath: src }),
      isUsableLocalFile: (localPath) => localPath !== "/missing.mp4",
      probeDurationSec: async (localPath) => {
        probedPaths.push(localPath);
        return 5;
      },
    },
  );
  assert.deepEqual(probedPaths, ["/short.mp4"]);
  assert.equal(prepared.coverage.complete, true);
  assert.equal(prepared.coverage.droppedAssetCount, 1);
  assert.equal(prepared.telemetry.requestedWindowCount, 3);

  let overCardinalityProbeCount = 0;
  await assert.rejects(
    prepareBrollRenderAssets(
      Array.from({ length: 31 }, (_, index) => ({
        src: `/too-many-${index}.mp4`,
        start: index / 31,
        end: (index + 1) / 31,
      })),
      1,
      fps,
      {
        resolveAsset: (src) => ({ src, localPath: src }),
        isUsableLocalFile: () => true,
        probeDurationSec: async () => {
          overCardinalityProbeCount += 1;
          return 5;
        },
      },
    ),
    (error: unknown) => error instanceof BrollCoverageError,
  );
  assert.equal(overCardinalityProbeCount, 0);

  let enqueueCount = 0;
  await assert.rejects(
    async () => {
      await prepareBrollRenderAssets(
        [{ src: "https://example.invalid/video.mp4", start: 0, end: 30 }],
        30,
        fps,
        {
          resolveAsset: (src) => ({ src, localPath: null }),
          isUsableLocalFile: () => false,
          probeDurationSec: async () => null,
        },
      );
      enqueueCount += 1;
    },
    (error: unknown) => error instanceof BrollCoverageError,
  );
  assert.equal(enqueueCount, 0);
}

verifyRenderPreflight()
  .then(() => console.log("All broll-coverage checks passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
