export type BrollPlaybackPlan = {
  safeStart: number;
  endAt: number;
  /** Repeat this many source frames when the replacement is shorter than its window. */
  loopDurationInFrames: number | null;
};

/**
 * Build the decoder-safe source range for one B-roll window.
 *
 * Remotion keeps a two-frame guard at the end of uploaded/stock files because some codecs do
 * not expose their final decoded frames reliably. When that usable source range is shorter than
 * the locked subtitle window, loop only the usable range so another B-roll layer is never
 * exposed early.
 */
export function resolveBrollPlaybackPlan(input: {
  startFrom: number;
  totalFrames: number;
  clipDurFrames: number | null;
}): BrollPlaybackPlan {
  const requestedStart = Number.isFinite(input.startFrom)
    ? Math.max(0, Math.floor(input.startFrom))
    : 0;
  const totalFrames = Number.isFinite(input.totalFrames)
    ? Math.max(1, Math.floor(input.totalFrames))
    : 1;
  const clipDurFrames = input.clipDurFrames && Number.isFinite(input.clipDurFrames)
    ? Math.max(1, Math.floor(input.clipDurFrames))
    : null;

  if (!clipDurFrames) {
    return {
      safeStart: requestedStart,
      endAt: requestedStart + totalFrames,
      loopDurationInFrames: null,
    };
  }

  const guardedEnd = Math.max(1, clipDurFrames - 2);
  const safeStart = requestedStart >= guardedEnd ? 0 : requestedStart;
  const usableFrames = Math.max(1, guardedEnd - safeStart);
  const mustLoop = totalFrames > usableFrames;
  return {
    safeStart,
    endAt: safeStart + Math.min(totalFrames, usableFrames),
    loopDurationInFrames: mustLoop ? usableFrames : null,
  };
}
