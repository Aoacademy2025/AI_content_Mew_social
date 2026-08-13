import {
  decidePaidEquivalentEntitlement,
  type PaidEquivalentEvidence,
} from "../src/lib/paid-equivalent-entitlement.server";

const now = new Date("2026-08-13T05:00:00.000Z");
const day = 24 * 60 * 60 * 1_000;
const inDays = (days: number) => new Date(now.getTime() + days * day);

function evidence(overrides: Partial<PaidEquivalentEvidence> = {}): PaidEquivalentEvidence {
  return {
    user: {
      plan: "FREE",
      suspended: false,
      planExpiresAt: null,
      stripeSubscriptionId: null,
      subStatus: null,
      bundleGrantId: null,
      bundleSubscriptionId: null,
      bundleAccessExpiresAt: null,
      bundleStatus: null,
      bundleAmountThb: null,
      ...(overrides.user ?? {}),
    },
    payments: overrides.payments ?? [],
    couponRedemptions: overrides.couponRedemptions ?? [],
    administratorGrants: overrides.administratorGrants ?? [],
  };
}

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string) {
  if (condition) {
    passed += 1;
    console.log(`ok: ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${label}`);
  }
}

const paid = [{ plan: "PRO", status: "PAID", periodDays: 30, paidAt: inDays(-5) }];
const subscription = decidePaidEquivalentEntitlement(evidence({
  user: {
    plan: "PRO", planExpiresAt: inDays(20), stripeSubscriptionId: "sub_1", subStatus: "active",
  } as PaidEquivalentEvidence["user"],
  payments: paid,
}), now);
check(subscription.source === "subscription" && subscription.recurring && subscription.cashBacked,
  "active paid subscription qualifies as recurring cash-backed access");

const cancelAtPeriodEnd = decidePaidEquivalentEntitlement(evidence({
  user: {
    plan: "PRO", planExpiresAt: inDays(5), stripeSubscriptionId: "sub_canceling", subStatus: "active",
  } as PaidEquivalentEvidence["user"],
  payments: paid,
}), now);
check(cancelAtPeriodEnd.canUsePaidFeatures && cancelAtPeriodEnd.expiresAt?.getTime() === inDays(5).getTime(),
  "cancel-at-period-end remains entitled through its paid period");

const rawPlan = decidePaidEquivalentEntitlement(evidence({
  user: { plan: "BUSINESS", planExpiresAt: inDays(30) } as PaidEquivalentEvidence["user"],
}), now);
check(!rawPlan.canUsePaidFeatures && rawPlan.source === "none",
  "bare paid plan label and expiry never manufacture entitlement");

const mismatch = decidePaidEquivalentEntitlement(evidence({
  user: { plan: "BUSINESS", planExpiresAt: inDays(30) } as PaidEquivalentEvidence["user"],
  payments: paid,
}), now);
check(mismatch.source === "paid_term" && mismatch.effectivePlan === "PRO",
  "payment evidence sets the paid tier instead of a stronger raw plan label");

const manualTerm = decidePaidEquivalentEntitlement(evidence({
  user: { plan: "PRO", planExpiresAt: inDays(30) } as PaidEquivalentEvidence["user"],
  payments: paid,
}), now);
check(manualTerm.source === "paid_term" && !manualTerm.recurring && manualTerm.cashBacked,
  "current manual/one-time paid term qualifies without becoming recurring");

const renewedAtLowerTier = decidePaidEquivalentEntitlement(evidence({
  user: { plan: "PRO", planExpiresAt: inDays(30) } as PaidEquivalentEvidence["user"],
  payments: [
    { plan: "BUSINESS", status: "PAID", periodDays: 365, paidAt: inDays(-400) },
    { plan: "PRO", status: "PAID", periodDays: 30, paidAt: inDays(-2) },
  ],
}), now);
check(renewedAtLowerTier.effectivePlan === "PRO",
  "an older BUSINESS purchase cannot upgrade the latest PRO paid term");

const bundle = decidePaidEquivalentEntitlement(evidence({
  user: {
    plan: "PRO", bundleGrantId: "bundle_1", bundleSubscriptionId: "bundle_sub_1",
    bundleAccessExpiresAt: inDays(30), bundleStatus: "ACTIVE", bundleAmountThb: 990,
  } as PaidEquivalentEvidence["user"],
}), now);
check(bundle.source === "bundle" && bundle.recurring && bundle.cashBacked,
  "active paid Bundle qualifies and preserves recurring source truth");

const freeBundle = decidePaidEquivalentEntitlement(evidence({
  user: {
    plan: "PRO", bundleGrantId: "bundle_free", bundleAccessExpiresAt: inDays(30),
    bundleStatus: "ACTIVE", bundleAmountThb: 0,
  } as PaidEquivalentEvidence["user"],
}), now);
check(!freeBundle.canUsePaidFeatures, "zero-value Bundle state does not masquerade as paid Bundle");

const grantCoupon = decidePaidEquivalentEntitlement(evidence({
  couponRedemptions: [{
    redeemedAt: inDays(-2),
    coupon: { type: "GRANT", plan: "PRO", durationDays: 30 },
  }],
}), now);
check(grantCoupon.source === "grant_coupon" && !grantCoupon.cashBacked,
  "active course GRANT coupon receives full access without being revenue");

const discountCoupon = decidePaidEquivalentEntitlement(evidence({
  couponRedemptions: [{
    redeemedAt: inDays(-2),
    coupon: { type: "DISCOUNT", plan: "PRO", durationDays: 30 },
  }],
}), now);
check(!discountCoupon.canUsePaidFeatures, "DISCOUNT coupon alone never grants product access");

const expiredCoupon = decidePaidEquivalentEntitlement(evidence({
  couponRedemptions: [{
    redeemedAt: inDays(-31),
    coupon: { type: "GRANT", plan: "PRO", durationDays: 30 },
  }],
}), now);
check(!expiredCoupon.canUsePaidFeatures, "expired GRANT coupon fails closed");

const timedGrant = decidePaidEquivalentEntitlement(evidence({
  administratorGrants: [{
    plan: "BUSINESS", reason: "course support", startsAt: inDays(-1), expiresAt: inDays(10),
    permanent: false, revokedAt: null,
  }],
}), now);
check(timedGrant.source === "administrator_grant" && timedGrant.effectivePlan === "BUSINESS",
  "audited timed Administrator Grant qualifies at its target tier");

const malformedPermanent = decidePaidEquivalentEntitlement(evidence({
  administratorGrants: [{
    plan: "PRO", reason: "legacy", startsAt: inDays(-1), expiresAt: inDays(10),
    permanent: true, revokedAt: null,
  }],
}), now);
check(!malformedPermanent.canUsePaidFeatures, "malformed permanent grant fails closed");

const overlap = decidePaidEquivalentEntitlement(evidence({
  user: {
    plan: "PRO", planExpiresAt: inDays(25), stripeSubscriptionId: "sub_overlap", subStatus: "active",
  } as PaidEquivalentEvidence["user"],
  payments: paid,
  administratorGrants: [{
    plan: "BUSINESS", reason: "business pilot", startsAt: inDays(-1), expiresAt: inDays(7),
    permanent: false, revokedAt: null,
  }],
}), now);
check(overlap.effectivePlan === "BUSINESS" && overlap.source === "administrator_grant"
  && overlap.recurring && overlap.cashBacked,
"stronger grant wins capability while valid subscription remains visible as recurring cash");

const suspended = decidePaidEquivalentEntitlement(evidence({
  user: {
    plan: "PRO", suspended: true, planExpiresAt: inDays(20), stripeSubscriptionId: "sub_suspended",
    subStatus: "active",
  } as PaidEquivalentEvidence["user"],
  payments: paid,
}), now);
check(!suspended.canUsePaidFeatures && suspended.reason === "suspended",
  "suspension fails closed before every evidence source");

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
