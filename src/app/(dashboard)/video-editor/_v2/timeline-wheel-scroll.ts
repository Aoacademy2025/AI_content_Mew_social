export type TimelineWheelScrollInput = {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
};

const WHEEL_LINE_PX = 16;

/**
 * Maps the dominant mouse-wheel/trackpad axis onto the Timeline's horizontal scroller.
 * Returning null means the Timeline did not consume the gesture, so page scroll and
 * browser pinch-to-zoom remain available.
 */
export function nextTimelineScrollLeft(input: TimelineWheelScrollInput): number | null {
  if (input.ctrlKey) return null;

  const maxScrollLeft = Math.max(0, input.scrollWidth - input.clientWidth);
  if (maxScrollLeft === 0) return null;

  const dominantDelta = Math.abs(input.deltaX) > Math.abs(input.deltaY)
    ? input.deltaX
    : input.deltaY;
  if (!Number.isFinite(dominantDelta) || dominantDelta === 0) return null;

  const deltaScale = input.deltaMode === 1
    ? WHEEL_LINE_PX
    : input.deltaMode === 2
      ? Math.max(1, input.clientWidth)
      : 1;
  const next = Math.max(
    0,
    Math.min(maxScrollLeft, input.scrollLeft + dominantDelta * deltaScale),
  );

  return next === input.scrollLeft ? null : next;
}
