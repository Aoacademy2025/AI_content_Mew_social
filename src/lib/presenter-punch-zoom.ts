export const PUNCH_ZOOM_SCALE = 1.15;
export const PUNCH_ZOOM_ORIGIN = "50% 38%";
export const PUNCH_ZOOM_BEAT_SEC = 4.0;
export const PUNCH_ZOOM_MIN_SEGMENT_SEC = 1.4;

export type PunchZoomInterval = {
  start: number;
  end: number;
};

export function effectivePunchZoom(value: unknown): boolean {
  return value === true;
}

function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Plan deterministic 1.15x punch-in zoom intervals across presenter windows.
 *
 * - Always opens the first presenter appearance at 1.00x so the hook frame is natural.
 * - Alternates 1.00x <-> 1.15x on jump-cut / sentence cues (`cueTimesSec`) inside presenter
 *   windows, subdividing long uninterrupted presenter spans into ~4s beats, and alternating
 *   across cutaway presenter returns when individual windows are short.
 */
export function planPunchZoomIntervals(
  personRangesSec: readonly { start: number; end: number }[],
  cueTimesSec: readonly number[] = [],
): PunchZoomInterval[] {
  const validRanges = personRangesSec
    .filter(
      (r) =>
        Number.isFinite(r.start) &&
        Number.isFinite(r.end) &&
        r.end > r.start &&
        r.end > 0,
    )
    .map((r) => ({
      start: Math.max(0, r.start),
      end: Math.max(0, r.end),
    }))
    .filter((r) => r.end - r.start >= 0.2)
    .sort((a, b) => a.start - b.start);

  if (validRanges.length === 0) return [];

  const sortedCues = [...cueTimesSec]
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);

  const zoomedIntervals: PunchZoomInterval[] = [];
  let nextSubSpanZoomed = false;

  for (const range of validRanges) {
    const cutPoints: number[] = [range.start];
    for (const cue of sortedCues) {
      const lastPoint = cutPoints[cutPoints.length - 1]!;
      if (
        cue >= lastPoint + PUNCH_ZOOM_MIN_SEGMENT_SEC &&
        range.end - cue >= PUNCH_ZOOM_MIN_SEGMENT_SEC
      ) {
        cutPoints.push(cue);
      }
    }
    cutPoints.push(range.end);

    const refinedPoints: number[] = [cutPoints[0]!];
    for (let i = 0; i < cutPoints.length - 1; i += 1) {
      const segStart = cutPoints[i]!;
      const segEnd = cutPoints[i + 1]!;
      const segDur = segEnd - segStart;
      if (segDur >= PUNCH_ZOOM_BEAT_SEC * 1.35) {
        const beatCount = Math.max(2, Math.round(segDur / PUNCH_ZOOM_BEAT_SEC));
        const step = segDur / beatCount;
        for (let b = 1; b < beatCount; b += 1) {
          refinedPoints.push(segStart + step * b);
        }
      } else if (
        validRanges.length === 1 &&
        cutPoints.length === 2 &&
        segDur >= PUNCH_ZOOM_MIN_SEGMENT_SEC * 2
      ) {
        // Single presenter window with no cues: split at midpoint so punchZoom visibly punches in.
        refinedPoints.push(segStart + segDur / 2);
      }
      refinedPoints.push(segEnd);
    }

    for (let i = 0; i < refinedPoints.length - 1; i += 1) {
      const start = roundSec(refinedPoints[i]!);
      const end = roundSec(refinedPoints[i + 1]!);
      if (end <= start) continue;
      if (nextSubSpanZoomed) {
        zoomedIntervals.push({ start, end });
      }
      nextSubSpanZoomed = !nextSubSpanZoomed;
    }
  }

  return zoomedIntervals;
}

export function isPunchZoomActiveAtTime(
  intervals: readonly PunchZoomInterval[],
  timeSec: number,
): boolean {
  if (!Number.isFinite(timeSec) || timeSec < 0) return false;
  for (const interval of intervals) {
    if (timeSec >= interval.start && timeSec <= interval.end) {
      return true;
    }
  }
  return false;
}
