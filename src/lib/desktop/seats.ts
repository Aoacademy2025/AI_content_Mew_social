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

/**
 * When effectivePlan drops (e.g. PRO → FREE, limit 2 → 1), keep the oldest
 * active Device Seat only (createdAt ASC) and revoke the rest. Never prefer
 * the currently-calling device or lastSeenAt. Register and heartbeat call this
 * so a downgrade takes effect at the next check-in.
 */
export async function enforceSeatLimit(userId: string, limit: number): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const active = await prisma.deviceSeat.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (active.length <= limit) return;
  const extraIds = active.slice(limit).map((seat) => seat.id);
  await prisma.deviceSeat.updateMany({
    where: { id: { in: extraIds } },
    data: { revokedAt: new Date() },
  });
}
