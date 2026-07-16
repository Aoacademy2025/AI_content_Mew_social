import type { BrollVideo } from "../remotion/types";

export const BROLL_SEQUENCE_GUARD_FRAMES = 10;
export const BROLL_PROBE_SAFETY_MARGIN_SEC = 0.5;

export type BrollCoverageAsset = BrollVideo & { sourceIndex?: number };
export type BrollCoverageWindow = { startMs: number; endMs: number };

export type BrollCoverageMetrics = {
  requestedSpanCount: number;
  availableAssetCount: number;
  outputSegmentCount: number;
  repairedSegmentCount: number;
  gapCount: number;
  coveredSec: number;
  effectiveEndSec: number;
  uncoveredTailSec: number;
  coverageRatio: number;
};

export type BrollCoverageResult = {
  segments: BrollCoverageAsset[];
  metrics: BrollCoverageMetrics;
  complete: boolean;
};

export type ProbedBrollAsset = {
  asset: BrollCoverageAsset;
  actualDurationSec: number | null;
  probeRequired: boolean;
};

export type ProbedBrollCoverageResult = BrollCoverageResult & {
  droppedAssetCount: number;
  probedAssetCount: number;
};

export class BrollCoverageError extends Error {
  readonly code = "broll_coverage_incomplete";

  constructor(
    message: string,
    readonly metrics: BrollCoverageMetrics,
  ) {
    super(message);
    this.name = "BrollCoverageError";
  }
}

type TargetSpan = {
  start: number;
  end: number;
  preferred?: BrollCoverageAsset;
};

const DEFAULT_CLIP_DURATION_SEC = 10;
const EPSILON_SEC = 1e-6;

export function selectRepresentativeItems<T>(items: T[], limit: number): T[] {
  const count = Math.max(0, Math.min(items.length, Math.floor(limit)));
  if (count === 0) return [];
  if (count === items.length) return [...items];

  return Array.from(
    { length: count },
    (_, index) => items[Math.floor(((index + 0.5) * items.length) / count)],
  );
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sourceDuration(asset: BrollCoverageAsset): number {
  return finiteOr(asset.clipDuration, DEFAULT_CLIP_DURATION_SEC);
}

function playableDuration(
  asset: BrollCoverageAsset,
  offset: number,
  guardSec: number,
): number {
  return sourceDuration(asset) - offset - guardSec;
}

function normalizePool(
  pool: BrollCoverageAsset[],
  guardSec: number,
  minPlayableSec: number,
): BrollCoverageAsset[] {
  return pool.filter((asset) => {
    if (!asset?.src) return false;
    return playableDuration(asset, 0, guardSec) >= minPlayableSec - EPSILON_SEC;
  });
}

function invalidCoverageResult(
  requestedSpanCount: number,
  availableAssetCount: number,
  durationSec: number,
): BrollCoverageResult {
  const uncoveredTailSec = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  return {
    segments: [],
    metrics: {
      requestedSpanCount,
      availableAssetCount,
      outputSegmentCount: 0,
      repairedSegmentCount: 0,
      gapCount: uncoveredTailSec > 0 ? 1 : 0,
      coveredSec: 0,
      effectiveEndSec: 0,
      uncoveredTailSec,
      coverageRatio: 0,
    },
    complete: false,
  };
}

function makeTargets(
  desired: BrollCoverageAsset[],
  durationSec: number,
  toleranceSec: number,
): TargetSpan[] {
  const normalized = desired
    .filter((span) => span?.src && Number.isFinite(span.start) && Number.isFinite(span.end))
    .map((span) => ({
      ...span,
      start: Math.max(0, Math.min(durationSec, span.start)),
      end: Math.max(0, Math.min(durationSec, span.end)),
    }))
    .filter((span) => span.end - span.start > EPSILON_SEC)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const targets: TargetSpan[] = [];
  let cursor = 0;

  for (const span of normalized) {
    if (span.start > cursor + toleranceSec) {
      targets.push({ start: cursor, end: span.start });
      cursor = span.start;
    }

    const start = Math.max(cursor, span.start);
    if (span.end > start + EPSILON_SEC) {
      targets.push({ start, end: span.end, preferred: span });
      cursor = span.end;
    }
  }

  if (cursor < durationSec - toleranceSec) {
    targets.push({ start: cursor, end: durationSec });
  } else if (cursor < durationSec && targets.length > 0) {
    targets[targets.length - 1].end = durationSec;
  }

  if (targets.length === 0 && durationSec > EPSILON_SEC) {
    targets.push({ start: 0, end: durationSec });
  }

  return targets;
}

function summarizeCoverage(
  segments: BrollCoverageAsset[],
  requestedSpanCount: number,
  availableAssetCount: number,
  durationSec: number,
  toleranceSec: number,
): BrollCoverageResult {
  const spans = segments
    .map((segment) => ({
      start: Math.max(0, Math.min(durationSec, segment.start)),
      end: Math.max(0, Math.min(durationSec, segment.end)),
    }))
    .filter((span) => span.end - span.start > EPSILON_SEC)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  let coveredSec = 0;
  let effectiveEndSec = 0;
  let gapCount = 0;
  let unionStart: number | null = null;
  let unionEnd = 0;
  let contiguous = true;

  for (const span of spans) {
    if (unionStart === null) {
      unionStart = span.start;
      unionEnd = span.end;
      if (span.start > toleranceSec) {
        gapCount += 1;
        contiguous = false;
      } else {
        effectiveEndSec = span.end;
      }
      continue;
    }

    if (span.start > unionEnd + toleranceSec) {
      coveredSec += unionEnd - unionStart;
      gapCount += 1;
      unionStart = span.start;
      unionEnd = span.end;
      contiguous = false;
      continue;
    }

    unionEnd = Math.max(unionEnd, span.end);
    if (contiguous) effectiveEndSec = unionEnd;
  }

  if (unionStart !== null) coveredSec += unionEnd - unionStart;

  if (spans.length === 0) {
    effectiveEndSec = 0;
  } else if (contiguous) {
    effectiveEndSec = unionEnd;
  }

  const uncoveredTailSec = Math.max(0, durationSec - effectiveEndSec);
  const coverageRatio = durationSec > 0 ? Math.min(1, coveredSec / durationSec) : 1;
  const complete =
    durationSec <= 0 ||
    (spans.length > 0 && gapCount === 0 && uncoveredTailSec <= toleranceSec);

  return {
    segments,
    metrics: {
      requestedSpanCount,
      availableAssetCount,
      outputSegmentCount: segments.length,
      repairedSegmentCount: Math.max(0, segments.length - requestedSpanCount),
      gapCount,
      coveredSec,
      effectiveEndSec,
      uncoveredTailSec,
      coverageRatio,
    },
    complete,
  };
}

export function coverBrollTimeline(
  desired: BrollCoverageAsset[],
  pool: BrollCoverageAsset[],
  durationSec: number,
  fps: number,
): BrollCoverageResult {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || !Number.isFinite(fps) || fps <= 0) {
    return invalidCoverageResult(desired.length, pool.filter((asset) => asset?.src).length, durationSec);
  }

  const safeDurationSec = durationSec;
  const safeFps = fps;
  const toleranceSec = 1 / safeFps;
  const guardSec = BROLL_SEQUENCE_GUARD_FRAMES / safeFps;
  const minPlayableSec = 1 / safeFps;
  const assets = normalizePool(pool, guardSec, minPlayableSec);
  const targets = makeTargets(desired, safeDurationSec, toleranceSec);
  const segments: BrollCoverageAsset[] = [];
  const maxSegmentCount = Math.max(
    1,
    Math.ceil(safeDurationSec * safeFps) + targets.length + assets.length,
  );
  let poolCursor = 0;
  let segmentLimitExceeded = false;

  targetLoop: for (const target of targets) {
    let cursor = target.start;
    let preferred = target.preferred;
    let attemptsWithoutProgress = 0;

    while (cursor < target.end - EPSILON_SEC) {
      const isPreferredAttempt = preferred !== undefined;
      const asset = preferred ?? assets[poolCursor % Math.max(assets.length, 1)];
      const offset = preferred
        ? Math.max(0, finiteOr(asset?.clipOffset, 0))
        : 0;
      preferred = undefined;

      if (
        !asset?.src ||
        playableDuration(asset, offset, guardSec) < minPlayableSec - EPSILON_SEC
      ) {
        if (isPreferredAttempt) continue;
        attemptsWithoutProgress += 1;
        if (assets.length === 0 || attemptsWithoutProgress >= assets.length) break;
        poolCursor = (poolCursor + 1) % assets.length;
        continue;
      }

      const spanSec = Math.min(
        target.end - cursor,
        playableDuration(asset, offset, guardSec),
      );
      if (spanSec <= EPSILON_SEC) break;

      if (segments.length >= maxSegmentCount) {
        segmentLimitExceeded = true;
        break targetLoop;
      }

      segments.push({
        ...asset,
        start: cursor,
        end: cursor + spanSec,
        clipOffset: offset,
        clipDuration: sourceDuration(asset),
      });
      cursor += spanSec;
      attemptsWithoutProgress = 0;

      if (assets.length > 0) {
        const matchedIndex = assets.findIndex((candidate) => candidate.src === asset.src);
        poolCursor = ((matchedIndex >= 0 ? matchedIndex : poolCursor) + 1) % assets.length;
      }
    }
  }

  const result = summarizeCoverage(
    segments,
    desired.length,
    assets.length,
    safeDurationSec,
    toleranceSec,
  );
  return segmentLimitExceeded ? { ...result, complete: false } : result;
}

export function coverProbedBrollTimeline(
  probedAssets: ProbedBrollAsset[],
  durationSec: number,
  fps: number,
): ProbedBrollCoverageResult {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || !Number.isFinite(fps) || fps <= 0) {
    return {
      ...invalidCoverageResult(
        probedAssets.length,
        probedAssets.filter((entry) => entry.asset?.src).length,
        durationSec,
      ),
      droppedAssetCount: probedAssets.length,
      probedAssetCount: probedAssets.filter((entry) => entry.probeRequired).length,
    };
  }

  const guardSec = BROLL_SEQUENCE_GUARD_FRAMES / fps;
  const minimumSafeDurationSec = guardSec + 1 / fps;
  const usable: BrollCoverageAsset[] = [];
  let droppedAssetCount = 0;
  let probedAssetCount = 0;

  for (const entry of probedAssets) {
    if (!entry.asset?.src) {
      droppedAssetCount += 1;
      continue;
    }
    if (!entry.probeRequired) {
      usable.push(entry.asset);
      continue;
    }

    probedAssetCount += 1;
    const actualDurationSec = entry.actualDurationSec;
    const safeDurationSec =
      typeof actualDurationSec === "number" && Number.isFinite(actualDurationSec)
        ? actualDurationSec - BROLL_PROBE_SAFETY_MARGIN_SEC
        : Number.NaN;
    if (!Number.isFinite(safeDurationSec) || safeDurationSec < minimumSafeDurationSec) {
      droppedAssetCount += 1;
      continue;
    }

    const rawOffset = Math.max(0, finiteOr(entry.asset.clipOffset, 0));
    usable.push({
      ...entry.asset,
      clipDuration: safeDurationSec,
      clipOffset: rawOffset >= safeDurationSec ? rawOffset % safeDurationSec : rawOffset,
    });
  }

  const coverage = coverBrollTimeline(usable, usable, durationSec, fps);
  return {
    ...coverage,
    droppedAssetCount,
    probedAssetCount,
  };
}

export function assignBrollWindows(
  windows: BrollCoverageWindow[],
  pool: BrollCoverageAsset[],
  durationSec: number,
  fps: number,
): BrollCoverageResult {
  const usable = pool.filter((asset) => asset?.src);
  const indexed = usable.filter((asset) => Number.isFinite(asset.sourceIndex));

  const desired = windows
    .map((window, windowIndex) => {
      let asset = indexed.find((candidate) => candidate.sourceIndex === windowIndex);
      if (!asset && indexed.length > 0) {
        asset = indexed.reduce((nearest, candidate) => {
          const nearestDistance = Math.abs((nearest.sourceIndex ?? 0) - windowIndex);
          const candidateDistance = Math.abs((candidate.sourceIndex ?? 0) - windowIndex);
          return candidateDistance < nearestDistance ? candidate : nearest;
        });
      }
      asset ??= usable[windowIndex % Math.max(usable.length, 1)];
      if (!asset) return null;

      return {
        ...asset,
        start: window.startMs / 1000,
        end: window.endMs / 1000,
      };
    })
    .filter((segment): segment is BrollCoverageAsset => segment !== null);

  return coverBrollTimeline(desired, usable, durationSec, fps);
}
