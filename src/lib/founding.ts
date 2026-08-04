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

/** Public status.
 *
 * MON-12 (2026-07-07): this used to call `releaseStaleReservations()` (a write) on every read —
 * GET /api/founding/status is public/unauthenticated and can be hit often, so that was a
 * write-on-read. The `founding-sweep` PM2 cron (src/app/api/cron/founding-sweep/route.ts) already
 * calls `releaseStaleReservations()` every ~15 min, well inside the 35-minute stale-hold window
 * (HOLD_MINUTES), so the counter here is never more than one sweep cycle behind honest — reads no
 * longer need to self-heal inline. */
export async function foundingStatus(): Promise<FoundingStatus> {
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

  // MON-10 (2026-07-07): steps 2+3 run in ONE transaction. SQLite serializes concurrent
  // transactions, so if this same user calls claimSeat twice at once (double-click / two open
  // tabs), the second call's transaction only starts once the first has fully committed — closing
  // the narrow race where both could read "not yet a CONFIRMED member" before either write landed.
  // NOTE this does not make double-founding fully airtight: attachReservation (a separate Stripe
  // session id per call) still happens OUTSIDE this function/transaction, so two concurrent calls
  // can still each walk away with a RESERVED hold on two DIFFERENT Stripe sessions. A per-user
  // "one CONFIRMED seat" DB constraint would close that too, but needs a partial/filtered unique
  // index (`WHERE status='CONFIRMED'`), which SQLite/Prisma doesn't support (a plain
  // `@@unique([userId])` on FoundingReservation would wrongly block the normal
  // RESERVED→RELEASED→RESERVED retry churn) — see the schema comment on FoundingReservation.
  return prisma.$transaction(async (tx) => {
    // 2) one seat per user — a confirmed member doesn't get a second
    const member = await tx.foundingReservation.findFirst({ where: { userId, status: "CONFIRMED" } });
    if (member) return null;

    // 3) the race-safe gate: a single UPDATE that only succeeds while seats remain
    const claim = await tx.coupon.updateMany({
      where: { id: c.id, usedCount: { lt: c.maxUses } },
      data: { usedCount: { increment: 1 } },
    });
    if (claim.count !== 1) return null; // sold out

    return { couponId: c.id, stripePromotionCodeId: c.stripePromotionCodeId };
  });
}

/** Record the reservation once the Stripe session id exists (called right after claimSeat succeeds). */
export async function attachReservation(userId: string, stripeSessionId: string): Promise<void> {
  await prisma.foundingReservation.create({ data: { userId, stripeSessionId, status: "RESERVED" } });
}

/**
 * Confirm a seat after payment. Idempotent (a webhook retry is a no-op once CONFIRMED).
 * - RESERVED → CONFIRMED: the seat is already counted, so usedCount is untouched.
 * - RELEASED → CONFIRMED: the user paid on a session we had self-healed/released (its count was
 *   returned to the pool), so we re-increment to honor the paid customer. This can briefly push
 *   usedCount to maxUses+1 in a rare race; that's intentional — a real paid founding customer is
 *   never refused their counted seat.
 */
export async function confirmSeat(stripeSessionId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const r = await tx.foundingReservation.findUnique({
      where: { stripeSessionId }, select: { id: true, status: true },
    });
    if (!r || r.status === "CONFIRMED") return; // unknown session / already confirmed → no-op
    const flipped = await tx.foundingReservation.updateMany({
      where: { id: r.id, status: { in: ["RESERVED", "RELEASED"] } },
      data: { status: "CONFIRMED", confirmedAt: new Date() },
    });
    if (flipped.count === 1 && r.status === "RELEASED") {
      await tx.coupon.updateMany({ where: { code: FOUNDING_CODE }, data: { usedCount: { increment: 1 } } });
    }
  });
}

/**
 * Confirm the latest Founding attempt for a user after a paid subscription
 * invoice. Billing Portal update webhooks identify the subscription owner but
 * do not carry the Portal session id that was used for the reservation.
 *
 * The newest row is considered even when already CONFIRMED. That detail keeps
 * webhook retries from falling through to an older RELEASED attempt and
 * accidentally confirming/counting two seats for the same user.
 */
export async function confirmLatestSeatForUser(userId: string): Promise<void> {
  const reservation = await prisma.foundingReservation.findFirst({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { stripeSessionId: true },
  });
  if (!reservation) return;
  await confirmSeat(reservation.stripeSessionId);
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
 * Release only the user's newest Portal conversion attempt after its invoice
 * fails. Looking at the newest row regardless of status makes repeated failure
 * webhooks a no-op instead of walking backwards and releasing older attempts.
 */
export async function releasePendingSeatForUser(userId: string): Promise<boolean> {
  const reservation = await prisma.foundingReservation.findFirst({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { stripeSessionId: true, status: true },
  });
  if (!reservation || reservation.status !== "RESERVED") return false;
  return releaseSeat(reservation.stripeSessionId);
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
