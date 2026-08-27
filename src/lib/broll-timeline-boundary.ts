/**
 * Move one shared boundary between adjacent B-roll Timeline windows.
 *
 * The interface deliberately returns both affected window changes together so callers cannot
 * move only one edge and accidentally create a gap or overlap.
 */

export type BrollTimelineWindow = {
  index: number;
  startMs: number;
  endMs: number;
};

export type BrollBoundaryMove = {
  boundaryMs: number;
  changes: [
    { index: number; endMs: number },
    { index: number; startMs: number },
  ];
};

export const MIN_BROLL_TIMELINE_WINDOW_MS = 1_000;
// A shared boundary is one value written to both adjacent windows, so any difference is a gap or
// overlap rather than harmless rounding. Keep the policy exact on client and server.
export const BROLL_TIMELINE_TOLERANCE_MS = 0;
export const MIN_BROLL_TIMELINE_WINDOW_SECONDS = MIN_BROLL_TIMELINE_WINDOW_MS / 1_000;
export const BROLL_TIMELINE_TOLERANCE_SECONDS = BROLL_TIMELINE_TOLERANCE_MS / 1_000;

export function moveBrollBoundary(
  windows: readonly BrollTimelineWindow[],
  leftIndex: number,
  targetMs: number,
): BrollBoundaryMove | null {
  if (!Number.isInteger(leftIndex) || !Number.isFinite(targetMs)) return null;
  const seenIndices = new Set<number>();
  for (const window of windows) {
    if (
      !Number.isInteger(window.index)
      || seenIndices.has(window.index)
      || !Number.isFinite(window.startMs)
      || !Number.isFinite(window.endMs)
      || window.endMs <= window.startMs
    ) return null;
    seenIndices.add(window.index);
  }
  const ordered = [...windows].sort((left, right) => left.startMs - right.startMs);
  const position = ordered.findIndex((window) => window.index === leftIndex);
  const left = ordered[position];
  const right = ordered[position + 1];
  if (!left || !right) return null;
  if (right.index !== left.index + 1) return null;
  if (Math.abs(left.endMs - right.startMs) > BROLL_TIMELINE_TOLERANCE_MS) return null;

  const earliest = left.startMs + MIN_BROLL_TIMELINE_WINDOW_MS;
  const latest = right.endMs - MIN_BROLL_TIMELINE_WINDOW_MS;
  if (latest < earliest) return null;
  const boundaryMs = Math.round(Math.min(latest, Math.max(earliest, targetMs)));
  return {
    boundaryMs,
    changes: [
      { index: left.index, endMs: boundaryMs },
      { index: right.index, startMs: boundaryMs },
    ],
  };
}

/** Whether a labelled nudge can be applied in full instead of being clamped at the minimum. */
export function canMoveBrollBoundaryExactly(
  windows: readonly BrollTimelineWindow[],
  leftIndex: number,
  targetMs: number,
): boolean {
  const move = moveBrollBoundary(windows, leftIndex, targetMs);
  return move !== null
    && Math.abs(move.boundaryMs - targetMs) <= BROLL_TIMELINE_TOLERANCE_MS;
}
