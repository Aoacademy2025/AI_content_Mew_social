// Standalone proof of the founding seat counter. Run against a throwaway SQLite DB.
// Use an ABSOLUTE path so the Prisma CLI and the Prisma Client agree on the same file:
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-founding.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-founding.db?connection_limit=1" npx tsx scripts/verify-founding.ts
// connection_limit=1 forces Prisma to serialize on one SQLite connection → deterministic, no "database is locked".
import { prisma } from "../src/lib/prisma";
import {
  FOUNDING_CODE, getFoundingCoupon, foundingStatus,
  claimSeat, attachReservation, releaseSeat, confirmSeat,
  confirmLatestSeatForUser, releasePendingSeatForUser,
  releaseUnattachedSeat, releaseStaleReservations,
} from "../src/lib/founding";

let passed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("❌ " + msg); process.exit(1); }
  console.log("✓ " + msg); passed++;
}

async function reset() {
  await prisma.foundingReservation.deleteMany();
  await prisma.coupon.deleteMany({ where: { code: FOUNDING_CODE } });
}
async function seed(maxUses = 5, usedCount = 0) {
  await prisma.coupon.create({
    data: {
      code: FOUNDING_CODE, type: "DISCOUNT", plan: "PRO",
      percentOff: 50, discountDuration: "forever",
      maxUses, usedCount, durationDays: 0,
      stripeCouponId: "co_test", stripePromotionCodeId: "promo_test",
    },
  });
}

async function main() {
  // ── lifecycle: claim → confirm → already-member ──
  await reset(); await seed(5, 0);
  let st = await foundingStatus();
  assert(st.active && st.remaining === 5 && st.total === 5 && st.percentOff === 50, "status: active 5/5 @50%");

  const a = await claimSeat("userA");
  assert(!!a && a!.stripePromotionCodeId === "promo_test", "claimSeat(userA) returns promo");
  await attachReservation("userA", "sess_A");
  st = await foundingStatus();
  assert(st.remaining === 4, "remaining 4 after one claim");

  await confirmSeat("sess_A");
  const m = await prisma.foundingReservation.findUnique({ where: { stripeSessionId: "sess_A" } });
  assert(m?.status === "CONFIRMED", "sess_A → CONFIRMED");
  let cpn = await getFoundingCoupon();
  assert(cpn!.usedCount === 1, "confirm does NOT re-increment (usedCount still 1)");

  assert((await claimSeat("userA")) === null, "userA already member → null");

  // ── release path ──
  await claimSeat("userB"); await attachReservation("userB", "sess_B");
  cpn = await getFoundingCoupon(); assert(cpn!.usedCount === 2, "usedCount 2 (A confirmed + B reserved)");
  await releaseSeat("sess_B");
  cpn = await getFoundingCoupon(); assert(cpn!.usedCount === 1, "release decremented to 1");
  await releaseSeat("sess_B");
  cpn = await getFoundingCoupon(); assert(cpn!.usedCount === 1, "release is idempotent (no double-decrement)");

  // ── concurrency: 3 seats left, 10 racers → exactly 3 win ──
  await reset(); await seed(5, 2);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claimSeat("racer" + i)));
  const wins = results.filter(Boolean).length;
  assert(wins === 3, `exactly 3 racers win (got ${wins})`);
  cpn = await getFoundingCoupon(); assert(cpn!.usedCount === 5, "usedCount maxed at 5, never over");

  // ── stale sweep releases an abandoned RESERVED seat ──
  await reset(); await seed(5, 1);
  await prisma.foundingReservation.create({
    data: { userId: "old", stripeSessionId: "sess_old", status: "RESERVED",
      createdAt: new Date(Date.now() - 40 * 60 * 1000) },
  });
  const swept = await releaseStaleReservations();
  assert(swept === 1, "sweep released 1 stale reservation");
  cpn = await getFoundingCoupon(); assert(cpn!.usedCount === 0, "stale release decremented usedCount");

  // ── confirmSeat re-counts a seat that was released then actually paid (self-heal edge) ──
  await reset(); await seed(5, 0);
  await claimSeat("userC"); await attachReservation("userC", "sess_C"); // usedCount 1, RESERVED
  await releaseSeat("sess_C");                                          // usedCount 0, RELEASED
  cpn = await getFoundingCoupon(); assert(cpn!.usedCount === 0, "released before pay → usedCount 0");
  await confirmSeat("sess_C");                                          // user paid the old (released) session
  const mc = await prisma.foundingReservation.findUnique({ where: { stripeSessionId: "sess_C" } });
  assert(mc?.status === "CONFIRMED", "paid-after-release → CONFIRMED");
  cpn = await getFoundingCoupon(); assert(cpn!.usedCount === 1, "paid-after-release re-counts the seat");
  await confirmSeat("sess_C");                                          // webhook retry
  cpn = await getFoundingCoupon(); assert(cpn!.usedCount === 1, "confirm idempotent (no double re-count)");

  // ── Billing Portal conversions are confirmed/released by subscription owner ──
  // Stripe's invoice webhook identifies the subscription/user, not the Portal session id.
  await reset(); await seed(5, 0);
  await claimSeat("portal-paid"); await attachReservation("portal-paid", "bps_paid");
  await confirmLatestSeatForUser("portal-paid");
  const portalPaid = await prisma.foundingReservation.findUnique({ where: { stripeSessionId: "bps_paid" } });
  assert(portalPaid?.status === "CONFIRMED", "portal invoice confirms the user's latest reservation");
  cpn = await getFoundingCoupon(); assert(cpn!.usedCount === 1, "portal confirmation keeps the reserved count");
  await confirmLatestSeatForUser("portal-paid");
  cpn = await getFoundingCoupon(); assert(cpn!.usedCount === 1, "portal confirmation is idempotent");

  await reset(); await seed(5, 0);
  await claimSeat("portal-late"); await attachReservation("portal-late", "bps_late");
  await releaseSeat("bps_late");
  await confirmLatestSeatForUser("portal-late");
  const portalLate = await prisma.foundingReservation.findUnique({ where: { stripeSessionId: "bps_late" } });
  assert(portalLate?.status === "CONFIRMED", "late portal payment restores a swept reservation");
  cpn = await getFoundingCoupon(); assert(cpn!.usedCount === 1, "late portal payment re-counts its seat");

  await reset(); await seed(5, 0);
  await claimSeat("portal-failed"); await attachReservation("portal-failed", "bps_failed");
  assert(await releasePendingSeatForUser("portal-failed"), "failed portal invoice releases the pending seat");
  assert(!(await releasePendingSeatForUser("portal-failed")), "portal release is idempotent");
  cpn = await getFoundingCoupon(); assert(cpn!.usedCount === 0, "failed portal payment returns the seat to inventory");

  // ── releaseUnattachedSeat: decrements once, never below zero (claim-then-Stripe-fails rollback) ──
  await reset(); await seed(5, 1);
  await releaseUnattachedSeat((await getFoundingCoupon())!.id);
  cpn = await getFoundingCoupon(); assert(cpn!.usedCount === 0, "releaseUnattachedSeat decremented to 0");
  await releaseUnattachedSeat(cpn!.id);
  cpn = await getFoundingCoupon(); assert(cpn!.usedCount === 0, "releaseUnattachedSeat never goes below 0");

  await reset();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} FOUNDING CHECKS PASSED`);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
