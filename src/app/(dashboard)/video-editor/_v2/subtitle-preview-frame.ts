export function subtitlePreviewEffectFrame({
  elapsedMs,
  fps,
}: {
  elapsedMs: number;
  fps: number;
}): number {
  // Pausing must freeze frame-based effects at the playhead. Passing the
  // renderer's -1 "resting" sentinel here makes typewriter captions jump to
  // their fully-visible state even though the exported frame is still partial.
  return Math.max(0, Math.round((elapsedMs / 1000) * fps));
}
