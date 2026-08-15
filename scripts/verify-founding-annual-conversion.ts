import assert from "node:assert/strict";

import {
  createFoundingAnnualPortalSession,
  type FoundingAnnualPortalSessionParams,
} from "../src/lib/founding-annual-conversion";

async function main() {
  let portalParams: FoundingAnnualPortalSessionParams | null = null;
  const attached: Array<[string, string]> = [];

  const result = await createFoundingAnnualPortalSession({
    user: {
      id: "user-monthly-pro",
      plan: "PRO",
      billingPeriod: "monthly",
      subStatus: "active",
      stripeCustomerId: "cus_existing",
      stripeSubscriptionId: "sub_existing",
    },
    requestedPlan: "PRO",
    currentMonthlyPriceId: "price_pro_monthly",
    annualPriceId: "price_pro_annual",
    portalConfigurationId: "bpc_founding",
    origin: "https://studio.example.com",
    deps: {
      retrieveSubscription: async () => ({
        id: "sub_existing",
        customerId: "cus_existing",
        status: "active",
        items: [{ id: "si_existing", priceId: "price_pro_monthly", quantity: 1 }],
      }),
      claimSeat: async () => ({
        couponId: "coupon_db",
        stripePromotionCodeId: "promo_founding_50",
      }),
      createPortalSession: async (params) => {
        portalParams = params;
        return { id: "bps_conversion", url: "https://billing.stripe.test/session" };
      },
      attachReservation: async (userId, sessionId) => { attached.push([userId, sessionId]); },
      releaseUnattachedSeat: async () => { throw new Error("must not release a successful claim"); },
    },
  });

  assert.equal(result.url, "https://billing.stripe.test/session");
  assert.deepEqual(attached, [["user-monthly-pro", "bps_conversion"]]);
  assert.deepEqual(portalParams, {
    customer: "cus_existing",
    configuration: "bpc_founding",
    returnUrl: "https://studio.example.com/pricing",
    afterCompletionUrl: "https://studio.example.com/settings?tab=billing&founding=success",
    subscription: "sub_existing",
    items: [{ id: "si_existing", price: "price_pro_annual", quantity: 1 }],
    discounts: [{ promotion_code: "promo_founding_50" }],
  });

  const released: string[] = [];
  await assert.rejects(
    createFoundingAnnualPortalSession({
      user: {
        id: "user-failed-portal",
        plan: "PRO",
        billingPeriod: "monthly",
        subStatus: "active",
        stripeCustomerId: "cus_failed",
        stripeSubscriptionId: "sub_failed",
      },
      requestedPlan: "PRO",
      currentMonthlyPriceId: "price_pro_monthly",
      annualPriceId: "price_pro_annual",
      portalConfigurationId: "bpc_founding",
      origin: "https://studio.example.com",
      deps: {
        retrieveSubscription: async () => ({
          id: "sub_failed",
          customerId: "cus_failed",
          status: "active",
          items: [{ id: "si_failed", priceId: "price_pro_monthly", quantity: 1 }],
        }),
        claimSeat: async () => ({ couponId: "coupon_failed", stripePromotionCodeId: "promo_founding_50" }),
        createPortalSession: async () => { throw new Error("Stripe unavailable"); },
        attachReservation: async () => { throw new Error("must not attach a failed session"); },
        releaseUnattachedSeat: async (couponId) => { released.push(couponId); },
      },
    }),
    /Stripe unavailable/,
  );
  assert.deepEqual(released, ["coupon_failed"]);

  let mismatchClaimed = false;
  await assert.rejects(
    createFoundingAnnualPortalSession({
      user: {
        id: "user-stale-db",
        plan: "PRO",
        billingPeriod: "monthly",
        subStatus: "active",
        stripeCustomerId: "cus_stale",
        stripeSubscriptionId: "sub_stale",
      },
      requestedPlan: "PRO",
      currentMonthlyPriceId: "price_pro_monthly",
      annualPriceId: "price_pro_annual",
      portalConfigurationId: "bpc_founding",
      origin: "https://studio.example.com",
      deps: {
        retrieveSubscription: async () => ({
          id: "sub_stale",
          customerId: "cus_stale",
          status: "active",
          items: [{ id: "si_stale", priceId: "price_pro_annual", quantity: 1 }],
        }),
        claimSeat: async () => { mismatchClaimed = true; return null; },
        createPortalSession: async () => { throw new Error("must not create portal"); },
        attachReservation: async () => { throw new Error("must not attach"); },
        releaseUnattachedSeat: async () => { throw new Error("must not release"); },
      },
    }),
    (error: unknown) => error instanceof Error && error.message.includes("cannot be converted"),
  );
  assert.equal(mismatchClaimed, false, "an already-annual or mismatched Stripe price cannot consume a Founding seat");

  console.log("founding-annual-conversion: portal payload + rollback checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
