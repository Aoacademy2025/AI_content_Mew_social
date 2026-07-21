import { durationCapSecFor } from "@/lib/plan-limits";

// Same conservative Thai speaking-rate estimate used by ai-spend-limits.
export const OMNIVOICE_ESTIMATE_CHARS_PER_SECOND = 14;

/** Input ceiling derived from the package's maximum clip duration, not a fixed
 * worker/render ceiling. Exact generated duration is still checked afterward. */
export function omnivoiceScriptCharCapForPlan(plan: string): number {
  return durationCapSecFor(plan) * OMNIVOICE_ESTIMATE_CHARS_PER_SECOND;
}

export function omnivoiceEstimatedDurationSec(text: string): number {
  const spokenChars = text.replace(/\s+/g, "").length;
  return spokenChars / OMNIVOICE_ESTIMATE_CHARS_PER_SECOND;
}
