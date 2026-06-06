import { prisma } from "@/lib/prisma";

/** The designated founding coupon's code. Looked up by the system; never entered by a user. */
export const FOUNDING_CODE = "FOUNDING100";

/** Release RESERVED seats older than this (Stripe sessions are set to expire at 30 min). */
const HOLD_MINUTES = 35;

export type FoundingCoupon = {
  id: string;
  percentOff: number;
  stripePromotionCodeId: string;
  usedCount: number;
  maxUses: number;
};

/** Load the founding coupon, or null if it isn't configured / is incomplete. */
export async function getFoundingCoupon(): Promise<FoundingCoupon | null> {
  const c = await prisma.coupon.findUnique({ where: { code: FOUNDING_CODE } });
  if (!c || c.type !== "DISCOUNT" || c.percentOff == null || !c.stripePromotionCodeId) return null;
  return {
    id: c.id,
    percentOff: c.percentOff,
    stripePromotionCodeId: c.stripePromotionCodeId,
    usedCount: c.usedCount,
    maxUses: c.maxUses,
  };
}

export type FoundingStatus = { active: boolean; remaining: number; total: number; percentOff: number };

/** Public status. Self-heals stale reservations first so the counter is honest. */
export async function foundingStatus(): Promise<FoundingStatus> {
  await releaseStaleReservations();
  const c = await getFoundingCoupon();
  if (!c) return { active: false, remaining: 0, total: 0, percentOff: 0 };
  const remaining = Math.max(0, c.maxUses - c.usedCount);
  return { active: remaining > 0, remaining, total: c.maxUses, percentOff: c.percentOff };
}

export type ClaimResult = { couponId: string; stripePromotionCodeId: string } | null;

/**
 * Atomically claim one founding seat for a user.
 * Returns the promo to attach, or null if sold out / the user is already a founding member.
 */
export async function claimSeat(userId: string): Promise<ClaimResult> {
  const c = await getFoundingCoupon();
  if (!c) return null;

  // 1) free this user's own abandoned holds first, so a prior dropped attempt can't block them
  const ownStale = await prisma.foundingReservation.findMany({
    where: { userId, status: "RESERVED" }, select: { stripeSessionId: true },
  });
  for (const r of ownStale) await releaseSeat(r.stripeSessionId);

  // 2) one seat per user — a confirmed member doesn't get a second
  const member = await prisma.foundingReservation.findFirst({ where: { userId, status: "CONFIRMED" } });
  if (member) return null;

  // 3) the race-safe gate: a single UPDATE that only succeeds while seats remain
  const claim = await prisma.coupon.updateMany({
    where: { id: c.id, usedCount: { lt: c.maxUses } },
    data: { usedCount: { increment: 1 } },
  });
  if (claim.count !== 1) return null; // sold out

  return { couponId: c.id, stripePromotionCodeId: c.stripePromotionCodeId };
}

/** Record the reservation once the Stripe session id exists (called right after claimSeat succeeds). */
export async function attachReservation(userId: string, stripeSessionId: string): Promise<void> {
  await prisma.foundingReservation.create({ data: { userId, stripeSessionId, status: "RESERVED" } });
}

/** Confirm a reserved seat after payment. Does NOT touch usedCount (already counted at claim). Idempotent. */
export async function confirmSeat(stripeSessionId: string): Promise<void> {
  await prisma.foundingReservation.updateMany({
    where: { stripeSessionId, status: "RESERVED" },
    data: { status: "CONFIRMED", confirmedAt: new Date() },
  });
}

/**
 * Release a held seat (expiry / failure). Atomic + idempotent: only the flip RESERVED→RELEASED decrements.
 * Returns true iff THIS call performed the release (so callers can count real releases).
 */
export async function releaseSeat(stripeSessionId: string): Promise<boolean> {
  // Fast path only — NOT the idempotency guard. The updateMany below is the real guard;
  // do not remove its `status: "RESERVED"` filter on the assumption this read made it redundant.
  const r = await prisma.foundingReservation.findUnique({
    where: { stripeSessionId }, select: { id: true, status: true },
  });
  if (!r || r.status !== "RESERVED") return false;
  return prisma.$transaction(async (tx) => {
    const flipped = await tx.foundingReservation.updateMany({
      where: { id: r.id, status: "RESERVED" },
      data: { status: "RELEASED", releasedAt: new Date() },
    });
    if (flipped.count !== 1) return false;
    await tx.coupon.updateMany({ where: { code: FOUNDING_CODE }, data: { usedCount: { decrement: 1 } } });
    return true;
  });
}

/**
 * Roll back a seat that was claimed but whose Stripe session was never created (no reservation row yet).
 * Guarded so a stray/double call can never drive usedCount below zero.
 */
export async function releaseUnattachedSeat(couponId: string): Promise<void> {
  await prisma.coupon.updateMany({
    where: { id: couponId, usedCount: { gt: 0 } },
    data: { usedCount: { decrement: 1 } },
  });
}

/** Backstop for a missed `checkout.session.expired`: release RESERVED seats older than HOLD_MINUTES.
 *  Returns the number of seats ACTUALLY released (not merely the count that looked stale at query time). */
export async function releaseStaleReservations(): Promise<number> {
  const threshold = new Date(Date.now() - HOLD_MINUTES * 60 * 1000);
  const stale = await prisma.foundingReservation.findMany({
    where: { status: "RESERVED", createdAt: { lt: threshold } },
    select: { stripeSessionId: true },
  });
  let released = 0;
  for (const r of stale) {
    if (await releaseSeat(r.stripeSessionId)) released++;
  }
  return released;
}
