export type FirstClipPathDecision = {
  onPath: boolean;
  reason:
    | "on_path"
    | "conversion_trial"
    | "internal"
    | "not_paid_equivalent"
    | "has_completed_video";
};

/** Only the no-payment Conversion Trial stays on the guided script sample.
 * Paid-equivalent users (subscription, paid term, bundle, coupon or admin
 * grant) keep the First-Clip onboarding but retain their paid upload feature. */
export function requiresFirstClipScript(
  decision: Pick<FirstClipPathDecision, "onPath" | "reason">,
): boolean {
  return decision.onPath && decision.reason === "conversion_trial";
}

/** Paid-Equivalent and Conversion Trial accounts with no completed video stay
 * on the First-Clip Path. Trial never inherits Paid-Equivalent image/script access. */
export function decideFirstClipPath(input: {
  isInternal: boolean;
  paidEquivalent: boolean;
  conversionTrial?: boolean;
  hasCompletedVideo: boolean;
}): FirstClipPathDecision {
  if (input.isInternal) return { onPath: false, reason: "internal" };
  if (input.hasCompletedVideo) return { onPath: false, reason: "has_completed_video" };
  if (input.paidEquivalent) return { onPath: true, reason: "on_path" };
  if (input.conversionTrial) return { onPath: true, reason: "conversion_trial" };
  return { onPath: false, reason: "not_paid_equivalent" };
}
