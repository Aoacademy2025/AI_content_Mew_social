// Proof for docs/plans/2026-10-04-promptpay-monthly.md, Task 1: the server
// purchase path for the PromptPay 30-day prepaid term (ADR 0066).
//
// A. the flag, "offered" (flag + price), and the cancel-return whitelist
// B. resolvePrice is method-aware for monthly only
// C. buildCheckoutSessionParams against a FROZEN copy of the pre-change route
//    logic: flag off → every request builds byte-for-byte today's params
// D. checkoutAllowed lets a past_due user and an active-cash-term user buy it
// E. a 30-day term activates through the existing one-time path
//    (throwaway SQLite DB, real activatePaidCheckout)
// F. wiring: admin settings, config preload, route, CI step
//
// Stripe is NEVER called. There is no STRIPE_SECRET_KEY in this process, and
// every Stripe object is a plain literal shaped like what the webhook reads.
//
// Run: node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-promptpay-monthly.ts
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PrismaClient } from "@prisma/client";

const dir = mkdtempSync(join(tmpdir(), "promptpay-monthly-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.CREDITS_LIVE = "0";
process.env.MINUTE_QUOTA = "0";
delete process.env.PROMPTPAY_MONTHLY;
delete process.env.PRESERVE_TRIAL_ON_CONVERT;
delete process.env.STRIPE_SECRET_KEY;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

// Fake price ids — only ever compared, never sent anywhere.
const PRICE_ENV: Record<string, string> = {
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_monthly",
  STRIPE_PRICE_PRO_ANNUAL: "price_pro_annual",
  STRIPE_PRICE_PRO_ANNUAL_ONETIME: "price_pro_annual_onetime",
  STRIPE_PRICE_BUSINESS_MONTHLY: "price_business_monthly",
  STRIPE_PRICE_BUSINESS_ANNUAL: "price_business_annual",
  STRIPE_PRICE_BUSINESS_ANNUAL_ONETIME: "price_business_annual_onetime",
};
const MONTHLY_ONETIME_ENV = {
  PRO: "STRIPE_PRICE_PRO_MONTHLY_ONETIME",
  BUSINESS: "STRIPE_PRICE_BUSINESS_MONTHLY_ONETIME",
} as const;
const MONTHLY_ONETIME_PRICE = {
  PRO: "price_pro_monthly_onetime",
  BUSINESS: "price_business_monthly_onetime",
} as const;
Object.assign(process.env, PRICE_ENV);
delete process.env[MONTHLY_ONETIME_ENV.PRO];
delete process.env[MONTHLY_ONETIME_ENV.BUSINESS];

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-04T09:00:00.000Z");
const NOW_MS = NOW.getTime();
const ORIGIN = "https://studio.example.com";

function setMonthlyOnetimePrices(prices: { PRO?: string; BUSINESS?: string }) {
  for (const tier of ["PRO", "BUSINESS"] as const) {
    const value = prices[tier];
    if (value === undefined) delete process.env[MONTHLY_ONETIME_ENV[tier]];
    else process.env[MONTHLY_ONETIME_ENV[tier]] = value;
  }
}

function src(path: string): string {
  return readFileSync(path, "utf8");
}

type Plan = "PRO" | "BUSINESS";
type Period = "monthly" | "annual";

type ParamsCase = {
  plan: Plan;
  period: Period;
  rawMethod: unknown;
  userId: string;
  customerId: string;
  origin: string;
  appliedPromotionCode: string | null;
  appliedCouponId: string | null;
  isFounding: boolean;
  isFoundingMemberUpgrade: boolean;
  refCode: string | null;
  stripeTrialEnd: number | null;
  nowMs: number;
};

async function main() {
  const countingClient = new PrismaClient({ log: [{ level: "query", emit: "event" }] });
  (globalThis as unknown as { prisma?: PrismaClient }).prisma = countingClient;
  let queryCount = 0;
  (countingClient as unknown as { $on: (ev: "query", cb: () => void) => void }).$on("query", () => {
    queryCount += 1;
  });

  const { PLANS, resolvePrice } = await import("../src/lib/stripe");
  const { studioProductSlug } = await import("../src/lib/affiliate-ref");
  const promptpayMonthly = await import("../src/lib/promptpay-monthly");
  const { promptpayMonthlyEnabled, promptpayMonthlyOffered, parseCancelReturnParams } = promptpayMonthly;
  const { buildCheckoutSessionParams, resolveCheckoutSelection } = await import("../src/lib/checkout-session-params");

  // ── A · flag, offered, cancel-return whitelist ────────────────────────────
  console.log("\nA. flag, offered, cancel-return whitelist");
  check("flag reads PROMPTPAY_MONTHLY and defaults to off", promptpayMonthlyEnabled({}) === false);
  check("PROMPTPAY_MONTHLY=1 turns it on", promptpayMonthlyEnabled({ PROMPTPAY_MONTHLY: "1" }) === true);
  check("only the exact value 1 counts",
    !promptpayMonthlyEnabled({ PROMPTPAY_MONTHLY: "true" })
    && !promptpayMonthlyEnabled({ PROMPTPAY_MONTHLY: "0" })
    && !promptpayMonthlyEnabled({ PROMPTPAY_MONTHLY: " 1" }));
  check("no NEXT_PUBLIC twin is read",
    !promptpayMonthlyEnabled({ NEXT_PUBLIC_PROMPTPAY_MONTHLY: "1" }));
  check("default argument reads process.env (off here)", promptpayMonthlyEnabled() === false);

  {
    let ensureCalls = 0;
    const ensureConfig = async () => { ensureCalls += 1; };
    const priced = { [MONTHLY_ONETIME_ENV.PRO]: "price_x", [MONTHLY_ONETIME_ENV.BUSINESS]: "price_y" };
    const offPro = await promptpayMonthlyOffered("PRO", { env: { ...priced }, ensureConfig });
    const offBiz = await promptpayMonthlyOffered("BUSINESS", { env: { ...priced }, ensureConfig });
    check("flag off: not offered even with both prices set", !offPro && !offBiz);
    check("flag off: the config loader (DB) is never touched", ensureCalls === 0, `ensureConfig calls=${ensureCalls}`);

    const on = { PROMPTPAY_MONTHLY: "1" };
    ensureCalls = 0;
    check("flag on + PRO price set → PRO offered",
      await promptpayMonthlyOffered("PRO", { env: { ...on, [MONTHLY_ONETIME_ENV.PRO]: "price_x" }, ensureConfig }));
    check("flag on: the config is loaded before the price is read", ensureCalls === 1, `calls=${ensureCalls}`);
    check("flag on + only PRO price → BUSINESS not offered",
      !(await promptpayMonthlyOffered("BUSINESS", { env: { ...on, [MONTHLY_ONETIME_ENV.PRO]: "price_x" }, ensureConfig })));
    check("flag on + BUSINESS price set → BUSINESS offered",
      await promptpayMonthlyOffered("BUSINESS", { env: { ...on, [MONTHLY_ONETIME_ENV.BUSINESS]: "price_y" }, ensureConfig }));
    check("flag on + empty price → not offered",
      !(await promptpayMonthlyOffered("PRO", { env: { ...on, [MONTHLY_ONETIME_ENV.PRO]: "" }, ensureConfig })));
    check("flag on + no price → not offered", !(await promptpayMonthlyOffered("PRO", { env: { ...on }, ensureConfig })));
    check("FREE and unknown tiers are never offered",
      !(await promptpayMonthlyOffered("FREE", { env: { ...on, ...priced }, ensureConfig }))
      && !(await promptpayMonthlyOffered("constructor", { env: { ...on, ...priced }, ensureConfig })));
  }

  // Real defaults: process.env + ensureStripeConfig() against the throwaway DB.
  {
    await countingClient.siteConfig.create({
      data: { key: "stripe_price_pro_monthly_onetime", value: "price_db_pro_monthly_onetime" },
    });
    await countingClient.siteConfig.create({
      data: { key: "stripe_price_business_monthly_onetime", value: "price_db_business_monthly_onetime" },
    });
    setMonthlyOnetimePrices({});
    delete process.env.PROMPTPAY_MONTHLY;
    queryCount = 0;
    const off = (await promptpayMonthlyOffered("PRO")) || (await promptpayMonthlyOffered("BUSINESS"));
    check("default deps, flag off: not offered and ZERO database queries", !off && queryCount === 0, `queries=${queryCount}`);

    process.env.PROMPTPAY_MONTHLY = "1";
    queryCount = 0;
    const pro = await promptpayMonthlyOffered("PRO");
    check("default deps, flag on: SiteConfig stripe_price_pro_monthly_onetime is loaded (DB_KEYS)",
      pro && process.env[MONTHLY_ONETIME_ENV.PRO] === "price_db_pro_monthly_onetime" && queryCount >= 1,
      `offered=${pro} env=${process.env[MONTHLY_ONETIME_ENV.PRO]} queries=${queryCount}`);
    const biz = await promptpayMonthlyOffered("BUSINESS");
    check("default deps, flag on: SiteConfig stripe_price_business_monthly_onetime is loaded (DB_KEYS)",
      biz && process.env[MONTHLY_ONETIME_ENV.BUSINESS] === "price_db_business_monthly_onetime");
    check("PLANS reads the loaded monthly one-time price",
      PLANS.PRO.monthlyOnetime.priceId === "price_db_pro_monthly_onetime"
      && PLANS.BUSINESS.monthlyOnetime.priceId === "price_db_business_monthly_onetime");
    delete process.env.PROMPTPAY_MONTHLY;
    setMonthlyOnetimePrices({});
  }

  {
    const { resolveSettingValue } = await import("../src/lib/site-config");
    setMonthlyOnetimePrices({ PRO: "price_env_pro", BUSINESS: "price_env_biz" });
    check("admin GET falls back to STRIPE_PRICE_PRO_MONTHLY_ONETIME",
      resolveSettingValue("stripe_price_pro_monthly_onetime", null) === "price_env_pro");
    check("admin GET falls back to STRIPE_PRICE_BUSINESS_MONTHLY_ONETIME",
      resolveSettingValue("stripe_price_business_monthly_onetime", null) === "price_env_biz");
    check("admin GET: a DB value still wins",
      resolveSettingValue("stripe_price_pro_monthly_onetime", "price_db") === "price_db");
    setMonthlyOnetimePrices({});
  }

  {
    const full = parseCancelReturnParams({ plan: "PRO", period: "monthly", method: "promptpay", payment: "cancelled" });
    check("whitelisted values pass through",
      isDeepStrictEqual(full, { plan: "PRO", period: "monthly", method: "promptpay" }), JSON.stringify(full));
    const biz = parseCancelReturnParams(new URLSearchParams("payment=cancelled&plan=BUSINESS&period=annual&method=card"));
    check("URLSearchParams input works the same",
      isDeepStrictEqual(biz, { plan: "BUSINESS", period: "annual", method: "card" }), JSON.stringify(biz));
    const junk = parseCancelReturnParams({
      plan: "FREE", period: "weekly", method: "bitcoin",
    });
    check("non-whitelisted values are dropped",
      junk.plan === undefined && junk.period === undefined && junk.method === undefined, JSON.stringify(junk));
    const nearMiss = parseCancelReturnParams({ plan: "pro", period: "Monthly", method: "PromptPay " });
    check("whitelist is exact (no case folding, no trimming)",
      nearMiss.plan === undefined && nearMiss.period === undefined && nearMiss.method === undefined, JSON.stringify(nearMiss));
    const injected = parseCancelReturnParams({
      plan: "PRO\"><script>", period: "monthly&method=promptpay", method: ["promptpay", "card"],
    });
    check("injection-shaped and repeated params are dropped",
      injected.plan === undefined && injected.period === undefined && injected.method === undefined, JSON.stringify(injected));
    const proto = parseCancelReturnParams({ plan: "constructor", period: "toString", method: "__proto__" });
    check("prototype keys are not whitelisted values",
      proto.plan === undefined && proto.period === undefined && proto.method === undefined);
    const mixed = parseCancelReturnParams({ plan: "BUSINESS", period: "daily", method: "promptpay" });
    check("each param is judged on its own",
      isDeepStrictEqual(mixed, { plan: "BUSINESS", period: undefined, method: "promptpay" }), JSON.stringify(mixed));
    const empty = parseCancelReturnParams({});
    check("missing params stay undefined", empty.plan === undefined && empty.period === undefined && empty.method === undefined);
  }

  // ── B · resolvePrice ──────────────────────────────────────────────────────
  console.log("\nB. resolvePrice is method-aware for monthly");
  setMonthlyOnetimePrices({ PRO: MONTHLY_ONETIME_PRICE.PRO, BUSINESS: MONTHLY_ONETIME_PRICE.BUSINESS });
  for (const plan of ["PRO", "BUSINESS"] as const) {
    const p = PLANS[plan];
    check(`${plan} monthly card → the recurring monthly price (unchanged)`,
      resolvePrice(plan, "monthly", "card") === p.monthly && p.monthly.recurring === true);
    const pp = resolvePrice(plan, "monthly", "promptpay");
    check(`${plan} monthly promptpay → monthlyOnetime: one-time, 30 days, ${MONTHLY_ONETIME_ENV[plan]}`,
      pp === p.monthlyOnetime && pp.recurring === false && pp.periodDays === 30 && pp.priceId === MONTHLY_ONETIME_PRICE[plan],
      JSON.stringify({ recurring: pp.recurring, periodDays: pp.periodDays, priceId: pp.priceId }));
    check(`${plan} annual card / promptpay are unchanged`,
      resolvePrice(plan, "annual", "card") === p.annual && resolvePrice(plan, "annual", "promptpay") === p.annualOnetime);
  }
  check("one-time monthly prices follow the card monthly THB price",
    PLANS.PRO.thb === 599 && PLANS.BUSINESS.thb === 990);

  // ── C · session params vs the frozen pre-change route ─────────────────────
  console.log("\nC. buildCheckoutSessionParams vs the frozen pre-change route");

  // FROZEN copy of src/app/api/payments/checkout/route.ts at be714d93 (before
  // this task): the method coercion, resolvePrice, affiliateMeta and the
  // stripe.checkout.sessions.create argument, verbatim except that
  // `Date.now()` is the injected `nowMs` so the comparison is deterministic.
  function legacyResolvePrice(plan: Plan, period: Period, method: "card" | "promptpay") {
    const p = PLANS[plan];
    if (period === "monthly") return p.monthly;
    return method === "promptpay" ? p.annualOnetime : p.annual;
  }
  function legacyParams(c: ParamsCase) {
    const { plan, period, rawMethod, userId, origin } = c;
    const method: "card" | "promptpay" = period === "monthly" ? "card" : (rawMethod === "promptpay" ? "promptpay" : "card");
    const priceCfg = legacyResolvePrice(plan, period, method);
    const isSub = priceCfg.recurring;
    const refCode = c.refCode;
    const affiliateMeta: Record<string, string> = refCode
      ? { ref_code: refCode, product_id: studioProductSlug(plan, period), ha_brand: "hero-ai" }
      : {};
    const customerId = c.customerId;
    const appliedPromotionCode = c.appliedPromotionCode;
    const appliedCouponId = c.appliedCouponId;
    const isFounding = c.isFounding;
    const isFoundingMemberUpgrade = c.isFoundingMemberUpgrade;
    const preservation = { stripeTrialEnd: c.stripeTrialEnd };
    return {
      mode: isSub ? "subscription" : "payment",
      customer: customerId,
      payment_method_types: method === "promptpay" ? ["promptpay"] : ["card"],
      line_items: [{ price: priceCfg.priceId, quantity: 1 }],
      ...(appliedPromotionCode ? { discounts: [{ promotion_code: appliedPromotionCode }] } : {}),
      metadata: {
        userId, plan, period, periodDays: String(priceCfg.periodDays), method,
        ...(appliedCouponId ? { couponId: appliedCouponId } : {}),
        ...(isFounding ? { founding: "1" } : {}),
        ...(isFoundingMemberUpgrade ? { founding: "member" } : {}),
        ...affiliateMeta,
      },
      ...(isSub
        ? {
            subscription_data: {
              metadata: { userId, plan, period, ...affiliateMeta },
              ...(preservation.stripeTrialEnd ? { trial_end: preservation.stripeTrialEnd } : {}),
            },
            ...(isFounding ? { expires_at: Math.floor(c.nowMs / 1000) + 30 * 60 } : {}),
          }
        : { expires_at: Math.floor(c.nowMs / 1000) + 30 * 60 }),
      success_url: `${origin}/settings?tab=billing&payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pricing?payment=cancelled`,
    };
  }

  const discounts = [
    { appliedPromotionCode: null, appliedCouponId: null, isFounding: false, isFoundingMemberUpgrade: false },
    { appliedPromotionCode: "promo_manual", appliedCouponId: "coupon_manual", isFounding: false, isFoundingMemberUpgrade: false },
    { appliedPromotionCode: "promo_founding", appliedCouponId: "coupon_founding", isFounding: true, isFoundingMemberUpgrade: false },
    { appliedPromotionCode: "promo_founding", appliedCouponId: "coupon_founding", isFounding: false, isFoundingMemberUpgrade: true },
  ];
  const cases: ParamsCase[] = [];
  for (const plan of ["PRO", "BUSINESS"] as const) {
    for (const period of ["monthly", "annual"] as const) {
      for (const rawMethod of ["card", "promptpay", undefined, "bitcoin"]) {
        for (const d of discounts) {
          for (const refCode of [null, "AFF_123"]) {
            for (const stripeTrialEnd of [null, Math.floor((NOW_MS + 5 * DAY_MS) / 1000)]) {
              cases.push({
                plan, period, rawMethod, userId: "user_1", customerId: "cus_1", origin: ORIGIN,
                ...d, refCode, stripeTrialEnd, nowMs: NOW_MS,
              });
            }
          }
        }
      }
    }
  }

  type Scenario = { name: string; enabled: boolean; prices: { PRO?: string; BUSINESS?: string } };
  const scenarios: Scenario[] = [
    { name: "flag off, no monthly one-time prices", enabled: false, prices: {} },
    { name: "flag off, both monthly one-time prices set", enabled: false, prices: { ...MONTHLY_ONETIME_PRICE } },
    { name: "flag on, no monthly one-time prices", enabled: true, prices: {} },
    { name: "flag on, only PRO price set", enabled: true, prices: { PRO: MONTHLY_ONETIME_PRICE.PRO } },
    { name: "flag on, both prices set", enabled: true, prices: { ...MONTHLY_ONETIME_PRICE } },
  ];

  const builderFor = async (c: ParamsCase, enabled: boolean) => {
    const env = enabled ? { ...process.env, PROMPTPAY_MONTHLY: "1" } : { ...process.env, PROMPTPAY_MONTHLY: undefined };
    const offered = await promptpayMonthlyOffered(c.plan, { env, ensureConfig: async () => {} });
    return {
      offered,
      params: buildCheckoutSessionParams({
        plan: c.plan,
        period: c.period,
        requestedMethod: c.rawMethod,
        monthlyPromptpayOffered: offered,
        promptpayMonthlyEnabled: promptpayMonthlyEnabled(env),
        userId: c.userId,
        customerId: c.customerId,
        origin: c.origin,
        appliedPromotionCode: c.appliedPromotionCode,
        appliedCouponId: c.appliedCouponId,
        isFounding: c.isFounding,
        isFoundingMemberUpgrade: c.isFoundingMemberUpgrade,
        refCode: c.refCode,
        stripeTrialEnd: c.stripeTrialEnd,
        nowMs: c.nowMs,
      }),
    };
  };
  const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b) && JSON.stringify(a) === JSON.stringify(b);
  const describe = (c: ParamsCase) =>
    `${c.plan}/${c.period}/${String(c.rawMethod)}/promo=${c.appliedPromotionCode}/founding=${c.isFounding ? "seat" : c.isFoundingMemberUpgrade ? "member" : "no"}/ref=${c.refCode}/trialEnd=${c.stripeTrialEnd}`;

  for (const scenario of scenarios) {
    setMonthlyOnetimePrices(scenario.prices);
    let identical = 0;
    let cancelOnly = 0;
    let promptpayMonthlyShape = 0;
    let mismatches: string[] = [];
    for (const c of cases) {
      const legacy = legacyParams(c);
      const { offered, params } = await builderFor(c, scenario.enabled);
      const isMonthlyPromptpay = c.period === "monthly" && c.rawMethod === "promptpay";
      if (!scenario.enabled || (c.period === "monthly" && !offered)) {
        // Flag off, or this tier's monthly one-time price is missing: exactly today.
        if (same(params, legacy)) identical += 1;
        else mismatches.push(`${describe(c)} expected legacy\n          got ${JSON.stringify(params)}\n          want ${JSON.stringify(legacy)}`);
      } else if (isMonthlyPromptpay) {
        promptpayMonthlyShape += 1; // asserted in detail below
      } else {
        // Flag on, any other purchase: only cancel_url changes, and it names the session.
        const method = legacy.metadata.method;
        const expected = {
          ...legacy,
          cancel_url: `${ORIGIN}/pricing?payment=cancelled&plan=${c.plan}&period=${c.period}&method=${method}`,
        };
        if (same(params, expected)) cancelOnly += 1;
        else mismatches.push(`${describe(c)} expected legacy+cancel_url\n          got ${JSON.stringify(params)}\n          want ${JSON.stringify(expected)}`);
      }
    }
    if (mismatches.length > 3) mismatches = [...mismatches.slice(0, 3), `… and ${mismatches.length - 3} more`];
    check(`${scenario.name}: ${cases.length} requests, legacy-identical=${identical}, cancel_url-only=${cancelOnly}, promptpay-monthly=${promptpayMonthlyShape}`,
      mismatches.length === 0, mismatches.join("\n        "));
    if (!scenario.enabled) {
      check(`${scenario.name}: EVERY request builds today's params byte-for-byte`, identical === cases.length);
    }
  }

  // Checklist 1 — flag off or price missing: monthly+promptpay → today's card subscription.
  for (const scenario of [scenarios[0], scenarios[1], scenarios[2]]) {
    setMonthlyOnetimePrices(scenario.prices);
    for (const plan of ["PRO", "BUSINESS"] as const) {
      const c = cases.find((x) => x.plan === plan && x.period === "monthly" && x.rawMethod === "promptpay"
        && !x.appliedPromotionCode && !x.refCode && !x.stripeTrialEnd)!;
      const { params } = await builderFor(c, scenario.enabled);
      check(`${scenario.name}: ${plan} monthly+promptpay → card subscription, cancel_url unchanged`,
        params.mode === "subscription"
        && isDeepStrictEqual(params.payment_method_types, ["card"])
        && params.line_items?.[0]?.price === PRICE_ENV[`STRIPE_PRICE_${plan}_MONTHLY`]
        && params.metadata?.method === "card"
        && params.cancel_url === `${ORIGIN}/pricing?payment=cancelled`,
        JSON.stringify(params));
    }
  }
  {
    // Flag on, BUSINESS price missing while PRO is set: BUSINESS behaves as flag off.
    setMonthlyOnetimePrices({ PRO: MONTHLY_ONETIME_PRICE.PRO });
    const c = cases.find((x) => x.plan === "BUSINESS" && x.period === "monthly" && x.rawMethod === "promptpay"
      && !x.appliedPromotionCode && !x.refCode && !x.stripeTrialEnd)!;
    const { params } = await builderFor(c, true);
    check("flag on, BUSINESS price missing: BUSINESS monthly+promptpay is today's card subscription",
      same(params, legacyParams(c)), JSON.stringify(params));
  }

  // Checklist 2 — flag on + price set: the PromptPay 30-day one-time session.
  setMonthlyOnetimePrices({ ...MONTHLY_ONETIME_PRICE });
  for (const plan of ["PRO", "BUSINESS"] as const) {
    const base = cases.find((x) => x.plan === plan && x.period === "monthly" && x.rawMethod === "promptpay"
      && !x.appliedPromotionCode && !x.isFounding && !x.isFoundingMemberUpgrade && x.refCode === "AFF_123" && !x.stripeTrialEnd)!;
    const { params } = await builderFor(base, true);
    const expected = {
      mode: "payment",
      customer: "cus_1",
      payment_method_types: ["promptpay"],
      line_items: [{ price: MONTHLY_ONETIME_PRICE[plan], quantity: 1 }],
      metadata: {
        userId: "user_1", plan, period: "monthly", periodDays: "30", method: "promptpay",
        ref_code: "AFF_123", product_id: `hero-studio-${plan.toLowerCase()}-monthly`, ha_brand: "hero-ai",
      },
      expires_at: Math.floor(NOW_MS / 1000) + 30 * 60,
      success_url: `${ORIGIN}/settings?tab=billing&payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${ORIGIN}/pricing?payment=cancelled&plan=${plan}&period=monthly&method=promptpay`,
    };
    check(`${plan} monthly+promptpay (offered): exact one-time PromptPay session`,
      same(params, expected), `got  ${JSON.stringify(params)}\n        want ${JSON.stringify(expected)}`);

    // Affiliate metadata must equal what a card monthly session gets.
    const cardCase = { ...base, rawMethod: "card" };
    const { params: card } = await builderFor(cardCase, true);
    const affiliate = (m: Record<string, string> | undefined | null) =>
      ({ ref_code: m?.ref_code, product_id: m?.product_id, ha_brand: m?.ha_brand });
    check(`${plan}: PromptPay monthly affiliate metadata === card monthly session metadata`,
      isDeepStrictEqual(affiliate(params.metadata as Record<string, string>), affiliate(card.metadata as Record<string, string>))
      && (params.metadata as Record<string, string>).product_id === studioProductSlug(plan, "monthly"),
      `pp=${JSON.stringify(affiliate(params.metadata as Record<string, string>))} card=${JSON.stringify(affiliate(card.metadata as Record<string, string>))}`);
    check(`${plan}: PromptPay monthly affiliate metadata === card monthly subscription metadata`,
      isDeepStrictEqual(
        affiliate(params.metadata as Record<string, string>),
        affiliate(card.subscription_data?.metadata as Record<string, string>),
      ));
    check(`${plan}: card monthly stays a card subscription when PromptPay is offered`,
      card.mode === "subscription" && isDeepStrictEqual(card.payment_method_types, ["card"])
      && card.line_items?.[0]?.price === PRICE_ENV[`STRIPE_PRICE_${plan}_MONTHLY`]);
  }
  {
    // Every monthly+promptpay variant in the matrix (coupons, trial end, no ref).
    let bad: string[] = [];
    for (const c of cases.filter((x) => x.period === "monthly" && x.rawMethod === "promptpay")) {
      const { params } = await builderFor(c, true);
      const m = params.metadata as Record<string, string>;
      const ok = params.mode === "payment"
        && isDeepStrictEqual(params.payment_method_types, ["promptpay"])
        && params.line_items?.[0]?.price === MONTHLY_ONETIME_PRICE[c.plan]
        && m.period === "monthly" && m.periodDays === "30" && m.method === "promptpay"
        && params.subscription_data === undefined
        && params.expires_at === Math.floor(NOW_MS / 1000) + 30 * 60
        && (c.appliedPromotionCode ? params.discounts?.[0]?.promotion_code === c.appliedPromotionCode : params.discounts === undefined)
        && (c.appliedCouponId ? m.couponId === c.appliedCouponId : m.couponId === undefined)
        && (c.refCode ? m.product_id === studioProductSlug(c.plan, "monthly") : m.ref_code === undefined && m.product_id === undefined);
      if (!ok) bad.push(`${describe(c)} → ${JSON.stringify(params)}`);
    }
    if (bad.length > 3) bad = [...bad.slice(0, 3), `… and ${bad.length - 3} more`];
    check("every monthly+promptpay variant: payment mode, PromptPay only, 30 days, no subscription_data, coupons kept",
      bad.length === 0, bad.join("\n        "));
  }
  {
    const sel = resolveCheckoutSelection({ plan: "PRO", period: "monthly", requestedMethod: "promptpay", monthlyPromptpayOffered: true });
    check("selection (offered): method promptpay, one-time, 30-day price",
      sel.method === "promptpay" && sel.isSub === false && sel.priceCfg === PLANS.PRO.monthlyOnetime);
    const notOffered = resolveCheckoutSelection({ plan: "PRO", period: "monthly", requestedMethod: "promptpay", monthlyPromptpayOffered: false });
    check("selection (not offered): coerced to card, recurring monthly",
      notOffered.method === "card" && notOffered.isSub === true && notOffered.priceCfg === PLANS.PRO.monthly);
    const annual = resolveCheckoutSelection({ plan: "BUSINESS", period: "annual", requestedMethod: "promptpay", monthlyPromptpayOffered: false });
    check("selection: annual PromptPay is unaffected by the monthly offer",
      annual.method === "promptpay" && annual.isSub === false && annual.priceCfg === PLANS.BUSINESS.annualOnetime);
  }

  // ── D · plan-change guard ────────────────────────────────────────────────
  console.log("\nD. checkoutAllowed: past_due and active-cash-term users can buy PromptPay monthly");
  {
    const { checkoutAllowed } = await import("../src/lib/plan-change");
    const pp = resolveCheckoutSelection({ plan: "PRO", period: "monthly", requestedMethod: "promptpay", monthlyPromptpayOffered: true });
    const card = resolveCheckoutSelection({ plan: "PRO", period: "monthly", requestedMethod: "card", monthlyPromptpayOffered: true });
    const states = {
      pastDueEntitled: {
        plan: "PRO", subStatus: "past_due", stripeSubscriptionId: "sub_pd",
        trialEndsAt: null, planExpiresAt: new Date(NOW_MS + 3 * DAY_MS), hasQualifyingCashPayment: true,
      },
      pastDueDowngraded: {
        plan: "FREE", subStatus: "past_due", stripeSubscriptionId: "sub_pd2",
        trialEndsAt: null, planExpiresAt: null, hasQualifyingCashPayment: true,
      },
      pastDueBusiness: {
        plan: "BUSINESS", subStatus: "past_due", stripeSubscriptionId: "sub_pd3",
        trialEndsAt: null, planExpiresAt: new Date(NOW_MS + 3 * DAY_MS), hasQualifyingCashPayment: true,
      },
      activeCashTerm: {
        plan: "PRO", subStatus: null, stripeSubscriptionId: null,
        trialEndsAt: null, planExpiresAt: new Date(NOW_MS + 12 * DAY_MS), hasQualifyingCashPayment: true,
      },
    };
    for (const preserve of [false, true]) {
      const opts = (recurring: boolean) => ({ recurring, preserveTrialOnConvert: preserve });
      const tag = `(PRESERVE_TRIAL ${preserve ? "on" : "off"})`;
      check(`past_due user still on PRO can buy PRO monthly PromptPay ${tag}`,
        checkoutAllowed(states.pastDueEntitled, "PRO", NOW, opts(pp.isSub)).allowed);
      check(`past_due user downgraded to FREE can buy PRO monthly PromptPay ${tag}`,
        checkoutAllowed(states.pastDueDowngraded, "PRO", NOW, opts(pp.isSub)).allowed);
      check(`past_due BUSINESS user can buy BUSINESS monthly PromptPay ${tag}`,
        checkoutAllowed(states.pastDueBusiness, "BUSINESS", NOW, opts(false)).allowed);
      check(`active-cash-term user can buy PRO monthly PromptPay (term stacks) ${tag}`,
        checkoutAllowed(states.activeCashTerm, "PRO", NOW, opts(pp.isSub)).allowed);
      const blocked = checkoutAllowed(states.activeCashTerm, "PRO", NOW, opts(card.isSub));
      check(`unchanged: the same user is still refused a CARD monthly subscription ${tag}`,
        !blocked.allowed && blocked.reason === "active_timed_plan", JSON.stringify(blocked));
      const active = checkoutAllowed({ plan: "PRO", subStatus: "active", stripeSubscriptionId: "sub_a" }, "PRO", NOW, opts(pp.isSub));
      check(`unchanged: an active subscriber is still refused (active_sub) ${tag}`,
        !active.allowed && active.reason === "active_sub");
      const down = checkoutAllowed(states.activeCashTerm, "FREE", NOW, opts(pp.isSub));
      check(`unchanged: a downgrade-by-pay is still refused ${tag}`, !down.allowed && down.reason === "downgrade");
    }
  }

  // ── E · activation of a 30-day term (throwaway SQLite) ────────────────────
  console.log("\nE. a 30-day PromptPay term activates through the existing one-time path");
  {
    const { prisma } = await import("../src/lib/prisma");
    const { activatePaidCheckout } = await import("../src/lib/checkout-plan-activation");
    setMonthlyOnetimePrices({ ...MONTHLY_ONETIME_PRICE });

    // The webhook routes a mode=payment plan session by its own metadata; feed the
    // builder's output in exactly as handleCheckoutSession does.
    const sessionFor = async (plan: Plan, userId: string) => {
      const c = cases.find((x) => x.plan === plan && x.period === "monthly" && x.rawMethod === "promptpay"
        && !x.appliedPromotionCode && !x.isFounding && !x.isFoundingMemberUpgrade && !x.refCode && !x.stripeTrialEnd)!;
      const { params } = await builderFor({ ...c, userId }, true);
      return params;
    };
    const activate = async (plan: Plan, userId: string, sessionId: string) => {
      const params = await sessionFor(plan, userId);
      const m = params.metadata as Record<string, string>;
      return activatePaidCheckout({
        sessionId, userId: m.userId, plan: m.plan, billingPeriod: m.period, periodDays: Number(m.periodDays),
        mode: params.mode, paymentIntentId: `pi_${sessionId}`,
        amountTotal: PLANS[plan].thb * 100, currency: "thb",
      }, NOW);
    };
    const verifyTerm = async (label: string, userId: string, sessionId: string, plan: Plan, expected: Date) => {
      const u = await prisma.user.findUnique({ where: { id: userId } });
      const pay = await prisma.payment.findUnique({ where: { stripeSessionId: sessionId } });
      check(`${label}: planExpiresAt = ${expected.toISOString()}`,
        u?.planExpiresAt?.getTime() === expected.getTime(), `got ${u?.planExpiresAt?.toISOString()}`);
      check(`${label}: plan ${plan}, billingPeriod monthly, no subscription written`,
        u?.plan === plan && u?.billingPeriod === "monthly" && u?.stripeSubscriptionId === null,
        `plan=${u?.plan} billingPeriod=${u?.billingPeriod} sub=${u?.stripeSubscriptionId}`);
      check(`${label}: Payment PAID, periodDays 30, ฿${PLANS[plan].thb}`,
        pay?.status === "PAID" && pay?.periodDays === 30 && pay?.amount === PLANS[plan].thb * 100 && pay?.currency === "thb",
        `status=${pay?.status} periodDays=${pay?.periodDays} amount=${pay?.amount}`);
    };

    // (i) no trial → now + 30
    delete process.env.PRESERVE_TRIAL_ON_CONVERT;
    await prisma.user.create({ data: { id: "u-free", name: "u-free", email: "u-free@example.com", plan: "FREE" } });
    const r1 = await activate("PRO", "u-free", "cs_pp_m_free");
    check("(i) activated", r1.activated);
    await verifyTerm("(i) no trial", "u-free", "cs_pp_m_free", "PRO", new Date(NOW_MS + 30 * DAY_MS));

    await prisma.user.create({ data: { id: "u-free-biz", name: "u-free-biz", email: "u-free-biz@example.com", plan: "FREE" } });
    await activate("BUSINESS", "u-free-biz", "cs_pp_m_free_biz");
    await verifyTerm("(i) no trial, BUSINESS", "u-free-biz", "cs_pp_m_free_biz", "BUSINESS", new Date(NOW_MS + 30 * DAY_MS));

    // (ii) unconverted trial + PRESERVE_TRIAL_ON_CONVERT=1 → trial end + 30
    process.env.PRESERVE_TRIAL_ON_CONVERT = "1";
    const trialEnd = new Date(NOW_MS + 5 * DAY_MS);
    await prisma.user.create({
      data: {
        id: "u-trial", name: "u-trial", email: "u-trial@example.com", plan: "PRO",
        trialStartedAt: new Date(NOW_MS - 2 * DAY_MS), trialEndsAt: trialEnd, planExpiresAt: trialEnd,
      },
    });
    await activate("PRO", "u-trial", "cs_pp_m_trial");
    await verifyTerm("(ii) unconverted trial, PRESERVE_TRIAL_ON_CONVERT=1", "u-trial", "cs_pp_m_trial", "PRO",
      new Date(trialEnd.getTime() + 30 * DAY_MS));
    const tu = await prisma.user.findUnique({ where: { id: "u-trial" } });
    check("(ii) the trial is superseded (trialEndsAt cleared)", tu?.trialEndsAt === null);

    // (ii-b) same purchase with the trial flag OFF: documents that the base is now.
    delete process.env.PRESERVE_TRIAL_ON_CONVERT;
    const trialEnd2 = new Date(NOW_MS + 5 * DAY_MS);
    await prisma.user.create({
      data: {
        id: "u-trial-off", name: "u-trial-off", email: "u-trial-off@example.com", plan: "PRO",
        trialStartedAt: new Date(NOW_MS - 2 * DAY_MS), trialEndsAt: trialEnd2, planExpiresAt: trialEnd2,
      },
    });
    await activate("PRO", "u-trial-off", "cs_pp_m_trial_off");
    await verifyTerm("(ii-b) unconverted trial, PRESERVE_TRIAL_ON_CONVERT off", "u-trial-off", "cs_pp_m_trial_off", "PRO",
      new Date(NOW_MS + 30 * DAY_MS));

    // (iii) running cash term → planExpiresAt + 30 (flag on and off: the rule does not depend on it)
    for (const preserve of [true, false]) {
      if (preserve) process.env.PRESERVE_TRIAL_ON_CONVERT = "1";
      else delete process.env.PRESERVE_TRIAL_ON_CONVERT;
      const id = `u-term-${preserve ? "on" : "off"}`;
      const termEnd = new Date(NOW_MS + 12 * DAY_MS);
      await prisma.user.create({
        data: { id, name: id, email: `${id}@example.com`, plan: "PRO", planExpiresAt: termEnd, billingPeriod: "annual" },
      });
      await prisma.payment.create({
        data: {
          userId: id, stripeSessionId: `cs_prev_${id}`, plan: "PRO", amount: 59900, currency: "thb",
          status: "PAID", periodDays: 30, paidAt: new Date(NOW_MS - 18 * DAY_MS),
        },
      });
      await activate("PRO", id, `cs_pp_m_${id}`);
      await verifyTerm(`(iii) running cash term (PRESERVE_TRIAL ${preserve ? "on" : "off"})`, id, `cs_pp_m_${id}`, "PRO",
        new Date(termEnd.getTime() + 30 * DAY_MS));
    }

    // Idempotency: the sibling completed / async_payment_succeeded event must not extend twice.
    const again = await activate("PRO", "u-free", "cs_pp_m_free");
    const u = await prisma.user.findUnique({ where: { id: "u-free" } });
    check("a retried settlement is a no-op (already_paid, no second 30 days)",
      !again.activated && u?.planExpiresAt?.getTime() === NOW_MS + 30 * DAY_MS);
    delete process.env.PRESERVE_TRIAL_ON_CONVERT;
  }

  // ── F · wiring (source text, the repo's route-check pattern) ──────────────
  console.log("\nF. wiring");
  {
    const route = src("src/app/api/payments/checkout/route.ts");
    check("route builds the Stripe session through buildCheckoutSessionParams",
      /stripe\.checkout\.sessions\.create\(\s*buildCheckoutSessionParams\(/.test(route));
    check("route resolves method + price through resolveCheckoutSelection (no inline monthly→card coercion)",
      route.includes("resolveCheckoutSelection(") && !route.includes('period === "monthly" ? "card"'));
    check("route asks promptpayMonthlyOffered(plan) and passes the flag for cancel_url",
      route.includes("promptpayMonthlyOffered(plan)") && route.includes("promptpayMonthlyEnabled()"));
    check("route keeps the plan-change guard keyed on the resolved one-time/recurring kind",
      route.includes("{ recurring: isSub, preserveTrialOnConvert: preserveTrial }"));
    check("route keeps the Payment row periodDays from the resolved price",
      route.includes("periodDays: priceCfg.periodDays"));
    const builder = src("src/lib/checkout-session-params.ts");
    check("builder keeps the confirmation-carrying success_url",
      builder.includes("session_id={CHECKOUT_SESSION_ID}"));

    const adminRoute = src("src/app/api/admin/settings/route.ts");
    const adminPage = src("src/app/(dashboard)/admin/settings/page.tsx");
    const instrumentation = src("src/instrumentation.ts");
    const loader = src("src/lib/load-stripe-config.ts");
    for (const tier of ["pro", "business"] as const) {
      const key = `stripe_price_${tier}_monthly_onetime`;
      const env = `STRIPE_PRICE_${tier.toUpperCase()}_MONTHLY_ONETIME`;
      const pair = new RegExp(`\\{\\s*db:\\s*"${key}",\\s*env:\\s*"${env}"\\s*\\}`);
      check(`load-stripe-config DB_KEYS maps ${key} → ${env}`, pair.test(loader));
      check(`instrumentation preloads ${key} → ${env}`, pair.test(instrumentation));
      check(`admin settings KEYS lists ${key}`, adminRoute.includes(`"${key}",`));
      check(`admin settings PATCH patches process.env.${env}`,
        new RegExp(`${key}:\\s*"${env}"`).test(adminRoute));
      check(`admin page saves ${key}`, new RegExp(`${key}:\\s*\\w+\\.trim\\(\\)`).test(adminPage));
      check(`admin page loads ${key}`, adminPage.includes(`d.${key}`));
    }
    check("admin page label (PRO) is exact",
      adminPage.includes("Stripe Price — PRO รายเดือน PromptPay (one-time)"));
    check("admin page label (BUSINESS) is exact",
      adminPage.includes("Stripe Price — BUSINESS รายเดือน PromptPay (one-time)"));

    const pkg = JSON.parse(src("package.json")) as { scripts: Record<string, string> };
    check("npm script verify:promptpay-monthly runs this file",
      (pkg.scripts["verify:promptpay-monthly"] ?? "").includes("scripts/verify-promptpay-monthly.ts"));
    const ci = src(".github/workflows/ci.yml");
    check("CI runs npm run verify:promptpay-monthly exactly once",
      ci.split("npm run verify:promptpay-monthly").length === 2);
  }

  await countingClient.$disconnect();
}

main()
  .then(() => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log("\nverify-promptpay-monthly: PASS");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
