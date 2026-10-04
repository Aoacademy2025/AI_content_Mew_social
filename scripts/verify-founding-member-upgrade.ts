// HERO-61: a confirmed Founding member upgrading PRO → BUSINESS annual gets the founding 50%,
// reusing their seat (no new seat, no FoundingReservation, no usedCount change). Everyone else
// keeps today's claimSeat path. Run against a throwaway SQLite DB:
//   DATABASE_URL="file:$PWD/prisma/test-founding-member.db?connection_limit=1" npx prisma db push --skip-generate
//   DATABASE_URL="file:$PWD/prisma/test-founding-member.db?connection_limit=1" npm run verify:founding-member-upgrade
import { prisma } from "../src/lib/prisma";
import {
  FOUNDING_CODE, getFoundingCoupon, claimSeat, attachReservation, confirmSeat,
  resolveFoundingDiscount, settleCheckoutCoupon,
} from "../src/lib/founding";
import { computeDisplayPrice, foundingMemberUpgradeEligible } from "../src/lib/pricing-display";

let passed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("❌ " + msg); process.exit(1); }
  console.log("✓ " + msg); passed++;
}

async function reset() {
  await prisma.couponRedemption.deleteMany();
  await prisma.foundingReservation.deleteMany();
  await prisma.coupon.deleteMany({ where: { code: { in: [FOUNDING_CODE, "MANUAL10"] } } });
  await prisma.user.deleteMany({ where: { id: { in: ["member", "outsider"] } } });
}
async function seed(maxUses: number, usedCount: number) {
  await prisma.coupon.create({
    data: {
      code: FOUNDING_CODE, type: "DISCOUNT", plan: "PRO",
      percentOff: 50, discountDuration: "forever",
      maxUses, usedCount, durationDays: 0,
      stripeCouponId: "co_test", stripePromotionCodeId: "promo_founding",
    },
  });
  for (const id of ["member", "outsider"]) {
    await prisma.user.create({ data: { id, name: id, email: `${id}@test.local` } });
  }
}
async function makeMember() {
  await claimSeat("member");
  await attachReservation("member", "sess_member_first");
  await confirmSeat("sess_member_first");
}
const counters = async () => ({
  used: (await getFoundingCoupon())!.usedCount,
  rows: await prisma.foundingReservation.count(),
  confirmed: await prisma.foundingReservation.count({ where: { status: "CONFIRMED" } }),
});

async function main() {
  // ── pure eligibility rule (shared by checkout + /pricing) ──
  assert(foundingMemberUpgradeEligible({ currentPlan: "PRO", targetPlan: "BUSINESS", period: "annual" }), "rule: PRO → BUSINESS annual is an upgrade");
  assert(!foundingMemberUpgradeEligible({ currentPlan: "PRO", targetPlan: "BUSINESS", period: "monthly" }), "rule: monthly never qualifies");
  assert(!foundingMemberUpgradeEligible({ currentPlan: "PRO", targetPlan: "PRO", period: "annual" }), "rule: same-tier renewal is not an upgrade (renewal price undecided)");
  assert(!foundingMemberUpgradeEligible({ currentPlan: "FREE", targetPlan: "BUSINESS", period: "annual" }), "rule: an expired member (FREE) is not upgrading");
  assert(!foundingMemberUpgradeEligible({ currentPlan: "BUSINESS", targetPlan: "PRO", period: "annual" }), "rule: downgrade never qualifies");

  // ── member annual upgrade → founding applied, counters unchanged ──
  await reset(); await seed(100, 0); await makeMember();
  const before = await counters();
  assert(before.used === 1 && before.confirmed === 1, "setup: member holds one confirmed seat");
  let d = await resolveFoundingDiscount({ userId: "member", currentPlan: "PRO", targetPlan: "BUSINESS", period: "annual", hasManualDiscount: false });
  assert(d?.kind === "member" && d.stripePromotionCodeId === "promo_founding", "member upgrade → founding promo, kind=member");
  let after = await counters();
  assert(after.used === before.used && after.rows === before.rows, "member upgrade: no claimSeat, no new reservation, usedCount unchanged");

  // webhook settles the member session without touching the seat counters
  await settleCheckoutCoupon({ sessionId: "sess_member_upgrade", userId: "member", couponId: d!.couponId, founding: "member" });
  await settleCheckoutCoupon({ sessionId: "sess_member_upgrade", userId: "member", couponId: d!.couponId, founding: "member" }); // retry
  after = await counters();
  assert(after.used === before.used && after.confirmed === 1 && after.rows === before.rows, "webhook: no second CONFIRMED row, no usedCount increment (incl. retry)");

  // ── member monthly → no discount ──
  d = await resolveFoundingDiscount({ userId: "member", currentPlan: "PRO", targetPlan: "BUSINESS", period: "monthly", hasManualDiscount: false });
  assert(d === null, "member monthly → no founding discount");

  // ── member same-tier renewal → today's path (claimSeat returns null for a member) ──
  d = await resolveFoundingDiscount({ userId: "member", currentPlan: "PRO", targetPlan: "PRO", period: "annual", hasManualDiscount: false });
  assert(d === null && (await counters()).used === before.used, "member PRO annual renewal → unchanged (full price, no seat)");

  // ── non-member with seats → claimSeat path as today ──
  d = await resolveFoundingDiscount({ userId: "outsider", currentPlan: "PRO", targetPlan: "BUSINESS", period: "annual", hasManualDiscount: false });
  assert(d?.kind === "seat" && d.stripePromotionCodeId === "promo_founding", "non-member → claimSeat path (kind=seat)");
  assert((await counters()).used === before.used + 1, "non-member claim increments usedCount like today");

  // ── sold out + member → still applied ──
  await reset(); await seed(1, 0); await makeMember();
  assert((await getFoundingCoupon())!.usedCount === 1, "setup: campaign sold out (1/1)");
  d = await resolveFoundingDiscount({ userId: "member", currentPlan: "PRO", targetPlan: "BUSINESS", period: "annual", hasManualDiscount: false });
  assert(d?.kind === "member", "sold out + member upgrade → founding still applied");
  d = await resolveFoundingDiscount({ userId: "outsider", currentPlan: "PRO", targetPlan: "BUSINESS", period: "annual", hasManualDiscount: false });
  assert(d === null, "sold out + non-member → no founding (unchanged)");

  // ── a manual discount code still takes precedence ──
  d = await resolveFoundingDiscount({ userId: "member", currentPlan: "PRO", targetPlan: "BUSINESS", period: "annual", hasManualDiscount: true });
  assert(d === null, "manual discount present → founding not resolved");

  // ── non-founding webhook paths unchanged ──
  await reset(); await seed(5, 0);
  const seat = await resolveFoundingDiscount({ userId: "outsider", currentPlan: "FREE", targetPlan: "PRO", period: "annual", hasManualDiscount: false });
  await attachReservation("outsider", "sess_outsider");
  await settleCheckoutCoupon({ sessionId: "sess_outsider", userId: "outsider", couponId: seat!.couponId, founding: "1" });
  const c = await counters();
  assert(c.confirmed === 1 && c.used === 1, "webhook founding=1: confirms the reserved seat, no re-increment");
  const manual = await prisma.coupon.create({
    data: { code: "MANUAL10", type: "DISCOUNT", plan: "PRO", percentOff: 10, maxUses: 10, usedCount: 0, durationDays: 0, stripePromotionCodeId: "promo_manual" },
  });
  await settleCheckoutCoupon({ sessionId: "sess_manual", userId: "member", couponId: manual.id, founding: undefined });
  await settleCheckoutCoupon({ sessionId: "sess_manual", userId: "member", couponId: manual.id, founding: undefined }); // retry
  const m = await prisma.coupon.findUnique({ where: { id: manual.id } });
  assert(m!.usedCount === 1, "webhook manual coupon: redeemed + counted once");

  // ── /pricing shows what Stripe charges: BUSINESS annual for a member = 4,950฿ ──
  const memberBusiness = computeDisplayPrice({
    monthlyPrice: 990, period: "annual", coupon: null,
    founding: { active: foundingMemberUpgradeEligible({ currentPlan: "PRO", targetPlan: "BUSINESS", period: "annual" }), percentOff: 50 },
  });
  assert(memberBusiness.final === 4950 && memberBusiness.isFounding, "/pricing: member BUSINESS annual shows 4,950฿");

  await reset();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} FOUNDING MEMBER UPGRADE CHECKS PASSED`);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
