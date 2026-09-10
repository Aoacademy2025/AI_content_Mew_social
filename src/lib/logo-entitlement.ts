/**
 * HERO-16: the Logo Overlay panel used to answer a single boolean, so a plan it
 * had not managed to load yet was indistinguishable from a plan that genuinely
 * lacks the feature. A paying PRO account whose `/api/user/me` request failed
 * once was therefore shown the upgrade lock for a feature it already owns.
 *
 * Eligibility now has three states. `resolving` is NOT permission: it disables
 * every control exactly as `locked` does, and the server-side
 * `canManageBrandMark` check remains the only thing that actually protects the
 * upload. The single difference is what the customer is told — an unresolved
 * entitlement must never be presented as a denial with an upsell attached.
 */
export type LogoEntitlementState = "eligible" | "locked" | "resolving";

export interface LogoEntitlementInput {
  /** True once a `/api/user/me` response has actually delivered a plan. */
  planResolved: boolean;
  /** The account plan as delivered by the server; null while unknown. */
  plan: string | null;
  brandVisualAllowed: boolean;
  hasAdmittedVisualPin: boolean;
}

export function resolveLogoEntitlement(input: LogoEntitlementInput): LogoEntitlementState {
  // An affirmative capability stands on its own: both of these arrive with the
  // project or the me-response and neither one needs the plan to be known.
  if (input.brandVisualAllowed || input.hasAdmittedVisualPin) return "eligible";
  if (input.plan === "PRO" || input.plan === "BUSINESS") return "eligible";
  // Only a plan we have actually seen may deny the feature.
  if (!input.planResolved || input.plan === null) return "resolving";
  return "locked";
}

/** Controls are inert unless the account is known to be entitled. */
export function logoControlsEnabled(state: LogoEntitlementState): boolean {
  return state === "eligible";
}
