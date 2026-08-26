// Unit tests for the ordinary monthly → annual switch (#302).
// Run: npx tsx scripts/verify-standard-annual-switch.ts
//
// A paying customer wrote in: "เข้าลิงก์แล้วไม่ให้อัปเกรด อยากซื้อรายปี ทำอะไรไม่ได้เลย".
// /api/payments/checkout correctly refuses a SECOND subscription (`active_sub`), and the only
// in-place switch that existed claimed a Founding seat — so every ordinary subscriber was
// dead-ended. On prod that was all six active monthly subscribers, none of them Founding.
//
// The line these tests defend: the standard switch shares the Founding path's eligibility
// checks exactly, and shares NONE of its seat lifecycle — switching billing period must never
// hand out the Founding forever-discount to someone who did not earn it.
import assert from "node:assert/strict";

import {
  createFoundingAnnualPortalSession,
  createStandardAnnualPortalSession,
  FoundingAnnualConversionError,
  type FoundingAnnualConversionUser,
  type FoundingAnnualPortalSessionParams,
} from "../src/lib/founding-annual-conversion";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const activeMonthlyPro: FoundingAnnualConversionUser = {
  id: "user-monthly-pro",
  plan: "PRO",
  billingPeriod: "monthly",
  subStatus: "active",
  stripeCustomerId: "cus_existing",
  stripeSubscriptionId: "sub_existing",
};

const liveSubscription = {
  id: "sub_existing",
  customerId: "cus_existing",
  status: "active",
  items: [{ id: "si_existing", priceId: "price_pro_monthly", quantity: 1 }],
};

function standardRun(overrides: {
  user?: Partial<FoundingAnnualConversionUser>;
  subscription?: typeof liveSubscription;
} = {}) {
  let params: FoundingAnnualPortalSessionParams | null = null;
  const promise = createStandardAnnualPortalSession({
    user: { ...activeMonthlyPro, ...overrides.user },
    requestedPlan: "PRO",
    currentMonthlyPriceId: "price_pro_monthly",
    annualPriceId: "price_pro_annual",
    portalConfigurationId: "bpc_switch",
    origin: "https://studio.example.com",
    deps: {
      retrieveSubscription: async () => overrides.subscription ?? liveSubscription,
      createPortalSession: async (received) => {
        params = received;
        return { id: "bps_standard", url: "https://billing.stripe.test/standard" };
      },
    },
  });
  return { promise, read: () => params as FoundingAnnualPortalSessionParams | null };
}

async function main() {
  // ── A. The happy path a monthly subscriber never had ──
  const run = standardRun();
  const result = await run.promise;
  const params = run.read();
  check("A1: an active monthly subscriber gets a portal URL", result.url === "https://billing.stripe.test/standard");
  check("A2: the update targets their existing subscription", params?.subscription === "sub_existing");
  check("A3: it swaps the existing item, not adding a second one", params?.items.length === 1 && params?.items[0].id === "si_existing");
  check("A4: onto the annual price", params?.items[0].price === "price_pro_annual");
  check("A5: quantity is preserved", params?.items[0].quantity === 1);
  check("A6: it uses the plan-switch portal configuration", params?.configuration === "bpc_switch");
  check("A7: it returns the customer to billing settings", params?.returnUrl.endsWith("/settings?tab=billing") === true);

  // ── B. The seat boundary — the whole reason this is a separate function ──
  check("B1: NO promotion code is attached", params?.discounts.length === 0, JSON.stringify(params?.discounts));
  const source = (await import("node:fs")).readFileSync("src/app/api/payments/switch-annual/route.ts", "utf8");
  check("B2: the route never claims a Founding seat", !source.includes("claimSeat"));
  check("B3: the route never attaches a Founding reservation", !source.includes("attachReservation"));

  // ── C. Eligibility is the Founding path's, unchanged ──
  const cases: Array<[string, Partial<FoundingAnnualConversionUser>, string]> = [
    ["an annual subscriber", { billingPeriod: "annual" }, "NOT_ACTIVE_MONTHLY"],
    ["a cancelled subscriber", { subStatus: "canceled" }, "NOT_ACTIVE_MONTHLY"],
    ["a trial user with no subscription", { subStatus: "trialing" }, "NOT_ACTIVE_MONTHLY"],
    ["an account with no Stripe subscription", { stripeSubscriptionId: null }, "MISSING_STRIPE_SUBSCRIPTION"],
    ["an account with no Stripe customer", { stripeCustomerId: null }, "MISSING_STRIPE_SUBSCRIPTION"],
    ["a FREE account", { plan: "FREE" }, "INVALID_PLAN_CHANGE"],
  ];
  for (const [label, override, expected] of cases) {
    let code = "none";
    try { await standardRun({ user: override }).promise; } catch (error) {
      code = error instanceof FoundingAnnualConversionError ? error.code : "other";
    }
    check(`C: ${label} is refused with ${expected}`, code === expected, `got ${code}`);
  }

  // A subscription carrying more than the one known item must not be rewritten blindly.
  let multiItemCode = "none";
  try {
    await standardRun({
      subscription: {
        ...liveSubscription,
        items: [
          { id: "si_existing", priceId: "price_pro_monthly", quantity: 1 },
          { id: "si_addon", priceId: "price_addon", quantity: 1 },
        ],
      },
    }).promise;
  } catch (error) {
    multiItemCode = error instanceof FoundingAnnualConversionError ? error.code : "other";
  }
  check("C: a multi-item subscription is refused, not rewritten", multiItemCode === "UNSUPPORTED_SUBSCRIPTION", multiItemCode);

  // ── D. The Founding path still claims its seat and its promotion code ──
  let foundingParams: FoundingAnnualPortalSessionParams | null = null;
  let claimed = 0;
  const founding = await createFoundingAnnualPortalSession({
    user: activeMonthlyPro,
    requestedPlan: "PRO",
    currentMonthlyPriceId: "price_pro_monthly",
    annualPriceId: "price_pro_annual",
    portalConfigurationId: "bpc_switch",
    origin: "https://studio.example.com",
    deps: {
      retrieveSubscription: async () => liveSubscription,
      claimSeat: async () => { claimed += 1; return { couponId: "coupon_db", stripePromotionCodeId: "promo_founding_50" }; },
      createPortalSession: async (received) => { foundingParams = received; return { id: "bps_founding", url: "https://billing.stripe.test/founding" }; },
      attachReservation: async () => {},
      releaseUnattachedSeat: async () => {},
    },
  });
  check("D1: the Founding path still returns its URL", founding.url === "https://billing.stripe.test/founding");
  check("D2: the Founding path still claims a seat", claimed === 1);
  check(
    "D3: the Founding path still attaches its promotion code",
    (foundingParams as FoundingAnnualPortalSessionParams | null)?.discounts[0]?.promotion_code === "promo_founding_50",
  );

  assert.ok(true);
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
