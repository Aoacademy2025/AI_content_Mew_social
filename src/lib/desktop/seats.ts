/** Device Seat caps. Trial accounts resolve to PRO via classifyEntitlement (effectivePlan). */
export const DESKTOP_SEAT_LIMITS = {
  FREE: 1,
  PRO: 2,
  BUSINESS: 5,
} as const;

export function seatLimitForEffectivePlan(effectivePlan: string): number {
  if (effectivePlan === "BUSINESS") return DESKTOP_SEAT_LIMITS.BUSINESS;
  if (effectivePlan === "PRO") return DESKTOP_SEAT_LIMITS.PRO;
  return DESKTOP_SEAT_LIMITS.FREE;
}
