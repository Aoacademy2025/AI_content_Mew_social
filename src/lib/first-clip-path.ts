export type FirstClipPathDecision = {
  onPath: boolean;
  reason: "on_path" | "internal" | "not_paid_equivalent" | "has_completed_video";
};

/** Paid-Equivalent users with no completed video stay on the First-Clip Path.
 * Conversion Trial (not paid-equivalent) is a separate ticket. */
export function decideFirstClipPath(input: {
  isInternal: boolean;
  paidEquivalent: boolean;
  hasCompletedVideo: boolean;
}): FirstClipPathDecision {
  if (input.isInternal) return { onPath: false, reason: "internal" };
  if (!input.paidEquivalent) return { onPath: false, reason: "not_paid_equivalent" };
  if (input.hasCompletedVideo) return { onPath: false, reason: "has_completed_video" };
  return { onPath: true, reason: "on_path" };
}
