import { prisma } from "@/lib/prisma";
import { classifyEntitlement } from "@/lib/entitlements";
import { getPlanConfig } from "@/lib/plan-config";

/**
 * Revenue cohorts — the single honest answer to "who actually pays us cash, and how much".
 *
 * TWO independent facts get conflated in a naive count, and this module keeps them apart:
 *   1. ENTITLEMENT (does this user have PRO/BUSINESS access right now?) — from classifyEntitlement.
 *      A 7-day free trial ALSO sets plan=PRO, and coupons/admin-grants set a paid plan with an
 *      expiry but NO payment. So "plan=PRO" ≠ "paying".
 *   2. CASH (has this user ever completed a PAID Payment?) — the real revenue signal.
 *
 * "Paying" here means BOTH: currently entitled AND has paid cash. Comped/admin/coupon users
 * (entitled, never paid) are surfaced separately as `compedPaid` (a cost, not revenue), and
 * users who paid before but have since lapsed are `lapsedPayers` (churn). Trials are never paying.
 *
 * Verified against prod 2026-07-04: 5 distinct cash payers (4 active + 1 lapsed), 134 active
 * trials, 34 comped PRO/BUSINESS — exactly the split the old dashboards blurred together.
 */

// Annual plans are billed at 10 months (2 months free) — see src/app/api/payments/checkout/route.ts
// ("annual ≈ thb*1000 (10 months)"). Monthly-equivalent revenue (MRR) for an annual term is
// therefore monthlyPrice × ANNUAL_PRICE_MONTHS / 12, NOT the full monthly price.
export const ANNUAL_PRICE_MONTHS = 10;

/** Minimal user shape needed to classify entitlement + split monthly/annual. */
export type CohortUser = {
  id: string;
  plan: string;
  role: string;
  subStatus: string | null;
  billingPeriod: string | null;
  planExpiresAt: Date | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  stripeSubscriptionId: string | null;
  usageCount?: number;
  usageLimit?: number;
  usagePeriodStartedAt?: Date | null;
  email?: string;
};

export type TierPrices = { pro: number; business: number };

export type RevenueCohorts = {
  /** Currently-active customers who have paid cash (entitled AND ≥1 PAID payment). */
  payingTotal: number;
  paying: {
    subMonthly: number; // active card subscription, monthly
    subAnnual: number; // active card subscription, annual
    oneTimeMonthly: number; // paid, timed monthly term still valid
    oneTimeAnnual: number; // paid, timed/PromptPay annual term still valid
  };
  payingByTier: { pro: number; business: number };
  /** Monthly run-rate over active paying customers, annual normalized. List-price based. */
  mrr: number;
  mrrByTier: { pro: number; business: number };
  /** Paid cash before but access has now lapsed (expired/reverted) — churn signal. */
  lapsedPayers: number;
  /** Active, unconverted free trials — NOT paying. */
  trialActive: number;
  /** PRO/BUSINESS access with NO cash payment (admin / coupon / comp) — a cost, not revenue. */
  compedPaid: number;
  compedByTier: { pro: number; business: number };
  /** Breakdown of compedPaid by why they're comped (intentional grants, not anomalies). */
  comped: { team: number; coupon: number; other: number };
  /** Internal team accounts (email domain match), across ALL plans — inflate signups/trials/funnel. */
  internalTeam: number;
  /** Trials that ended but the user still sits on PRO (cron hasn't reverted) — drift/blind-spot. */
  expiredTrial: number;
  /** Comped timed plans past expiry still on a paid plan — drift/blind-spot. */
  expiredPlan: number;
  free: number;
  /** Active paying customers — the honest break-even numerator (was: subStatus="active" only). */
  breakEvenSubs: number;
};

function isAnnual(billingPeriod: string | null): boolean {
  return billingPeriod === "annual";
}
function monthlyEquiv(tierMonthlyPrice: number, billingPeriod: string | null): number {
  return isAnnual(billingPeriod) ? (tierMonthlyPrice * ANNUAL_PRICE_MONTHS) / 12 : tierMonthlyPrice;
}
function tierPrice(prices: TierPrices, plan: string): number {
  if (plan === "BUSINESS") return prices.business;
  if (plan === "PRO") return prices.pro;
  return 0;
}

/**
 * Pure cohort computation — no DB access, fully testable.
 * @param users        Every user row (minimal fields, incl. id).
 * @param paidUserIds  Set of user ids that have ≥1 PAID Payment (the cash ground truth).
 * @param prices       Monthly tier prices (฿).
 * @param now          Reference time.
 */
export function computeRevenueCohorts(
  users: CohortUser[],
  paidUserIds: Set<string>,
  prices: TierPrices,
  now: Date = new Date(),
  opts: { couponUserIds?: Set<string>; internalEmailPattern?: string } = {},
): RevenueCohorts {
  const couponUserIds = opts.couponUserIds ?? new Set<string>();
  const internalPattern = (opts.internalEmailPattern ?? "@aoacademy").toLowerCase();
  const paying = { subMonthly: 0, subAnnual: 0, oneTimeMonthly: 0, oneTimeAnnual: 0 };
  const payingByTier = { pro: 0, business: 0 };
  const mrrByTier = { pro: 0, business: 0 };
  const compedByTier = { pro: 0, business: 0 };
  const comped = { team: 0, coupon: 0, other: 0 };
  let mrr = 0;
  let lapsedPayers = 0;
  let trialActive = 0;
  let compedPaid = 0;
  let expiredTrial = 0;
  let expiredPlan = 0;
  let free = 0;
  let internalTeam = 0;

  for (const u of users) {
    const cashPaid = paidUserIds.has(u.id);
    const isTeam = !!u.email && u.email.toLowerCase().includes(internalPattern);
    if (isTeam) internalTeam++;
    const source = classifyEntitlement(
      {
        id: u.id, email: u.email ?? "", role: u.role, plan: u.plan,
        usageCount: u.usageCount ?? 0, usageLimit: u.usageLimit ?? 0, usagePeriodStartedAt: u.usagePeriodStartedAt ?? null,
        planExpiresAt: u.planExpiresAt, trialStartedAt: u.trialStartedAt, trialEndsAt: u.trialEndsAt,
        subStatus: u.subStatus, stripeSubscriptionId: u.stripeSubscriptionId,
      },
      now,
    ).source;

    const entitledPaid = source === "SUBSCRIPTION" || source === "TIMED_PLAN" || source === "PERMANENT_OR_MANUAL";

    if (entitledPaid && cashPaid) {
      // Active, real, money-backed customer.
      const plan = u.plan;
      if (source === "SUBSCRIPTION") {
        if (isAnnual(u.billingPeriod)) paying.subAnnual++;
        else paying.subMonthly++;
      } else {
        if (isAnnual(u.billingPeriod)) paying.oneTimeAnnual++;
        else paying.oneTimeMonthly++;
      }
      const add = monthlyEquiv(tierPrice(prices, plan), u.billingPeriod);
      if (plan === "BUSINESS") { payingByTier.business++; mrrByTier.business += add; }
      else if (plan === "PRO") { payingByTier.pro++; mrrByTier.pro += add; }
      mrr += add;
    } else if (entitledPaid && !cashPaid) {
      // Has paid-plan access but never paid cash: admin / coupon / comp — a cost, not revenue.
      compedPaid++;
      if (u.plan === "BUSINESS") compedByTier.business++;
      else if (u.plan === "PRO") compedByTier.pro++;
      if (isTeam) comped.team++;
      else if (couponUserIds.has(u.id)) comped.coupon++;
      else comped.other++;
    } else if (source === "TRIAL") {
      trialActive++;
    } else if (source === "EXPIRED_TRIAL") {
      expiredTrial++;
      if (cashPaid) lapsedPayers++; // paid once, trial-derived expiry lapsed
    } else if (source === "EXPIRED_PLAN") {
      expiredPlan++;
      if (cashPaid) lapsedPayers++;
    } else {
      // FREE
      if (cashPaid) lapsedPayers++; // paid before, fully reverted to FREE
      else free++;
    }
  }

  const payingTotal = paying.subMonthly + paying.subAnnual + paying.oneTimeMonthly + paying.oneTimeAnnual;

  return {
    payingTotal,
    paying,
    payingByTier,
    mrr,
    mrrByTier,
    lapsedPayers,
    trialActive,
    compedPaid,
    compedByTier,
    comped,
    internalTeam,
    expiredTrial,
    expiredPlan,
    free,
    breakEvenSubs: payingTotal,
  };
}

/** DB wrapper — fetches every user's billing fields, cash-payer ids, coupon ids, and plan prices. */
export async function getRevenueCohorts(now: Date = new Date()): Promise<RevenueCohorts> {
  const [users, paidRows, couponRows, planConfig] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true, email: true, plan: true, role: true, subStatus: true, billingPeriod: true,
        planExpiresAt: true, trialStartedAt: true, trialEndsAt: true, stripeSubscriptionId: true,
      },
    }),
    // Distinct users who have EVER completed a PAID payment — the cash ground truth (all-time).
    prisma.payment.findMany({ where: { status: "PAID" }, select: { userId: true }, distinct: ["userId"] }),
    // Distinct users who redeemed a coupon — to split comped access (workshop/promo) from admin/other.
    prisma.couponRedemption.findMany({ select: { userId: true }, distinct: ["userId"] }),
    getPlanConfig(),
  ]);

  const paidUserIds = new Set(paidRows.map((r) => r.userId));
  const couponUserIds = new Set(couponRows.map((r) => r.userId));
  return computeRevenueCohorts(
    users,
    paidUserIds,
    { pro: planConfig.pro.price, business: planConfig.business.price },
    now,
    { couponUserIds },
  );
}
