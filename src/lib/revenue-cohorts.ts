import { prisma } from "@/lib/prisma";
import { classifyEntitlement } from "@/lib/entitlements";
import { getPlanConfig } from "@/lib/plan-config";
import { bangkokDate } from "@/lib/bangkok-day";

/**
 * Revenue cohorts — the single honest answer to "who actually pays us cash, and how much".
 *
 * TWO independent facts get conflated in a naive count, and this module keeps them apart:
 *   1. ENTITLEMENT (does this user have PRO/BUSINESS access right now?) — from classifyEntitlement.
 *      A 7-day free trial ALSO sets plan=PRO, and coupons/admin-grants set a paid plan with an
 *      expiry but NO payment. So "plan=PRO" ≠ "paying".
 *   2. CASH (has this user ever completed a PAID Payment for MORE than ฿0?) — the real revenue
 *      signal. A ฿0 PAID row is a ledger artefact, not money, and never makes someone paying.
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
  bundleAccessExpiresAt?: Date | null;
  bundleStatus?: string | null;
  bundlePrimary?: boolean;
  bundleBillingPeriod?: string | null;
  bundleAmountThb?: number | null;
  usageCount?: number;
  usageLimit?: number;
  usagePeriodStartedAt?: Date | null;
  email?: string;
  /** Task C8: committed-trialing users exclude suspended accounts, same as the
   *  internal-team exclusion already applied via `internalEmailPattern`. */
  suspended?: boolean;
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
    bundleMonthly: number; // active paid Hero AI Bundle, monthly
    bundleAnnual: number; // active paid Hero AI Bundle, annual/founding annual
  };
  /** Direct Studio payers only; excludes Bundle buyers. */
  directPayingTotal: number;
  /** Active Hero AI Bundle buyers with Studio access. */
  bundleActive: number;
  payingByTier: { pro: number; business: number };
  /** Monthly run-rate over active paying customers, annual normalized. Built only from cash
   *  customers actually paid (`monthlyRevenueByUser`) — never from the tier list price. */
  mrr: number;
  /** Studio-native MRR and Bundle MRR, both included in `mrr`. */
  directMrr: number;
  bundleMrr: number;
  /** Credit-pack cash is real one-time revenue, never recurring plan revenue. */
  creditRevenue: number;
  /** Distinct people who have bought at least one credit pack. */
  creditBuyers: number;
  /**
   * Studio MRR that actually recurs — a live Stripe subscription that will bill again on its
   * own. This is the ONLY part `arr` may be built from.
   */
  recurringMrr: number;
  /**
   * Studio MRR contributed by customers who paid ONCE for a fixed term. Real revenue, and
   * real access, but it will not bill again: when the term ends it stops unless somebody
   * sells them another one. Kept out of `arr` for that reason.
   */
  prepaidMrr: number;
  /**
   * Annual run rate of everything that bills again on its own: Studio subscriptions plus
   * Hero AI Bundle. Prepaid one-time terms are deliberately excluded — see `prepaidMrr`.
   */
  arr: number;
  /** The Studio half of `arr` (`recurringMrr × 12`). */
  arrStudio: number;
  /**
   * The Bundle half of `arr` (`bundleMrr × 12`). Bundle is a subscription product: an ACTIVE
   * bundle renews rather than lapsing like a prepaid Studio term, which is why it annualises.
   * If Bundle ever sells a one-time prepaid term, it needs the same recurring/prepaid split
   * Studio has here.
   */
  arrBundle: number;
  /**
   * Cash already collected for prepaid time NOT yet delivered (฿). It is an obligation to
   * serve, not profit — and it is large here because Founding sold annual terms up front.
   *
   * Studio only, like `recurringMrr` / `prepaidMrr`. Hero AI Bundle is a separate product
   * with its own ledger and sells no one-time term today; if it ever does, this figure and
   * `arr` both under-report the business until Bundle is folded in here.
   */
  deferredRevenue: number;
  /** When the prepaid terms run out. Empty when nobody holds one. */
  prepaidExpiry: {
    nextAt: Date | null;
    /** Prepaid customers whose term ends within 90 days, and the monthly revenue at stake. */
    within90Days: number;
    within90DaysMrr: number;
    /** First and last expiry month (`YYYY-MM`) — how concentrated the cliff is. */
    firstMonth: string | null;
    lastMonth: string | null;
    customers: number;
  };
  mrrByTier: { pro: number; business: number };
  /** Of payingTotal, subset with subStatus="canceled" — still entitled/paying this cycle, but
   *  will churn at period end (user clicked cancel, access runs out the clock). Already counted
   *  in payingTotal/mrr above; this is an ADDITIONAL at-risk view, not a separate bucket. */
  payingCanceling: number;
  /** Their contribution to `mrr` — the revenue that will disappear once they churn out. */
  mrrAtRisk: number;
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
  /** Bundle access ended/revoked; no longer active revenue. */
  expiredBundle: number;
  free: number;
  /** Active paying customers — the honest break-even numerator (was: subStatus="active" only). */
  breakEvenSubs: number;
  /**
   * Task C8 — "รอเก็บเงินครั้งแรก": customers who have CONVERTED (a live Stripe
   * subscription, card on file) but whose subscription is still `trialing`, so
   * Stripe has not charged them yet (see `src/lib/preserve-trial.ts` — the ฿0
   * `trial_preserved` Payment row is the ledger marker for exactly this state).
   * They are committed, not paying: never added to `payingTotal`, `mrr`,
   * `prepaidMrr`, `deferredRevenue`, cash, or any other figure above — this is
   * purely an EXPECTATION for Mew to watch, kept in its own bucket.
   */
  committedTrialing: {
    /** subStatus="trialing" AND a live stripeSubscriptionId AND plan PRO/BUSINESS,
     *  excluding suspended/internal-team accounts and anyone who already has a
     *  real (>฿0) plan payment — those are already counted in `payingTotal`. */
    users: number;
    /** Σ monthly-equivalent of each user's CURRENT plan-config list price — an
     *  expectation, priced at what Stripe will charge at trial end, never at
     *  what was actually paid (nothing has been paid yet). Annual uses the same
     *  `× ANNUAL_PRICE_MONTHS / 12` convention as the rest of this file. */
    expectedMonthlyThb: number;
    /** Asia/Bangkok calendar dates (`YYYY-MM-DD`) of the earliest/latest
     *  `planExpiresAt` among committed-trialing users — `planExpiresAt` is the
     *  column the checkout writes with Stripe's `current_period_end`, which for
     *  a trialing subscription IS the trial end / first-charge date (see
     *  `src/lib/checkout-plan-activation.ts` and the webhook's `entitlementExpiresAt`
     *  comment). `null` when there are no committed-trialing users. */
    firstChargeDates: { earliest: string | null; latest: string | null };
  };
};

function isAnnual(billingPeriod: string | null): boolean {
  return billingPeriod === "annual";
}
/**
 * Task C8 ONLY: monthly-equivalent of a tier's list price, for pricing the
 * "รอเก็บเงินครั้งแรก" EXPECTATION of committed-trialing users — nobody in that
 * bucket has paid anything yet, so there is no actual amount to read the way
 * `monthlyRevenueByUser` does for real MRR. Must never be called for anyone
 * with cash evidence; MRR stays priced from `monthlyRevenueByUser` alone
 * (fix 2, 2026-09-12 — a list-price fallback there invented ฿6,389.33/month).
 */
function expectedMonthlyListPrice(listPrices: TierPrices, plan: string, billingPeriod: string | null): number {
  const listPrice = plan === "BUSINESS" ? listPrices.business : listPrices.pro;
  return isAnnual(billingPeriod) ? (listPrice * ANNUAL_PRICE_MONTHS) / 12 : listPrice;
}
function bundleMonthlyEquiv(amountThb: number | null | undefined, billingPeriod: string | null | undefined): number {
  const amount = typeof amountThb === "number" && Number.isFinite(amountThb) ? amountThb : 0;
  return billingPeriod === "annual" ? amount / 12 : amount;
}

/** A PAID Payment row, reduced to what revenue classification needs. */
export type PlanCashRow = {
  userId: string;
  amount: number;      // satang
  note: string | null; // "credits" marks a credit-pack purchase
  periodDays: number;
  createdAt: Date;
};

/** A credit pack buys credits, not a plan term. */
export const CREDIT_PACK_NOTE = "credits";
/** Anything at least this long is a yearly term; used to spread annual cash over 12 months. */
const ANNUAL_PERIOD_DAYS = 300;

export interface PlanCashSummary {
  /** Users with real PLAN cash (a non-credit PAID row above ฿0) — the ground truth for
   *  "is a paying customer". */
  paidUserIds: Set<string>;
  /** userId → monthly-equivalent of what they actually paid for their plan (฿). */
  monthlyRevenueByUser: Map<string, number>;
  /** Credit-pack revenue (฿). Real money, but never recurring plan revenue. */
  creditRevenue: number;
  /** Distinct people who bought a credit pack. */
  creditBuyers: number;
}

/**
 * Split PAID payments into plan cash and credit-pack cash.
 *
 * Two bugs this closes, both confirmed on prod 2026-08-27:
 *  - a 199฿ credit top-up made its buyer a "paying customer" and priced them into MRR at the
 *    full 599฿/month tier, even though they had never bought a plan; and
 *  - MRR was priced off the tier LIST price, so a Founding annual buyer paying 2,995฿/year
 *    (250฿/month) was counted at 599 × 10 / 12 = 499฿. Across thirteen payers that inflated
 *    Studio MRR by ~3,565฿/month.
 *
 * Credit revenue is still cash — the lifetime-revenue card reads Stripe directly and always
 * included it — it simply is not recurring plan revenue.
 */
export function summarizePlanCash(rows: readonly PlanCashRow[]): PlanCashSummary {
  const paidUserIds = new Set<string>();
  const monthlyRevenueByUser = new Map<string, number>();
  const creditBuyerIds = new Set<string>();
  const newestPlanRowAt = new Map<string, number>();
  let creditSatang = 0;

  for (const row of rows) {
    if (row.note === CREDIT_PACK_NOTE) {
      creditSatang += Math.max(0, row.amount);
      creditBuyerIds.add(row.userId);
      continue;
    }
    // Cash evidence is money, not a row. A ฿0 PAID row is a ledger artefact (a grant recorded
    // through the payment path, a zero-amount receipt) whose owner never paid us anything, so it
    // must not make them a paying customer. `subscription-north-star.server.ts:116-121` has
    // always required `amount > 0`; this is the same rule, and applying it here is what closed
    // the 39-vs-28 split between จ่ายจริง and the North Star on the same page (audit A4,
    // 2026-09-12: 11 of the 39 had only ฿0 plan rows).
    if (row.amount <= 0) continue;
    paidUserIds.add(row.userId);
    const baht = row.amount / 100;
    const monthly = row.periodDays >= ANNUAL_PERIOD_DAYS ? baht / 12 : baht;
    // A customer can hold several plan rows — a monthly term, then an annual conversion. The
    // LATEST one is the live term. Picking by size instead would pin a converted customer to
    // their old 599฿ monthly row, since a discounted annual term is smaller per month.
    const at = row.createdAt instanceof Date ? row.createdAt.getTime() : 0;
    const seenAt = newestPlanRowAt.get(row.userId);
    if (seenAt == null || at >= seenAt) {
      newestPlanRowAt.set(row.userId, at);
      monthlyRevenueByUser.set(row.userId, monthly);
    }
  }

  return {
    paidUserIds,
    monthlyRevenueByUser,
    creditRevenue: creditSatang / 100,
    creditBuyers: creditBuyerIds.size,
  };
}

/**
 * Pure cohort computation — no DB access, fully testable.
 * @param users        Every user row (minimal fields, incl. id).
 * @param paidUserIds  Set of user ids that have ≥1 PAID Payment above ฿0 (the cash ground truth).
 * @param listPrices   Monthly tier LIST prices (฿). NEVER used to price MRR — that fallback
 *                     invented ฿6,389.33/month of fiction (fix 2, 2026-09-12) and
 *                     `monthlyRevenueByUser` is the only source of real revenue below. Its one
 *                     legitimate use is Task C8's `committedTrialing.expectedMonthlyThb`, an
 *                     EXPECTATION for customers who have not paid anything yet.
 * @param now          Reference time.
 */
export function computeRevenueCohorts(
  users: CohortUser[],
  paidUserIds: Set<string>,
  listPrices: TierPrices,
  now: Date = new Date(),
  opts: {
    couponUserIds?: Set<string>;
    internalEmailPattern?: string;
    /**
     * userId → the monthly-equivalent of what this customer ACTUALLY paid for their plan (฿).
     *
     * This map is the ONLY source of MRR. A payer absent from it contributes 0 — there is no
     * list-price fallback, because pricing an unknown at list is how ฿6,389.33/month of
     * fiction reached the dashboard (audit A4, 2026-09-12). A caller that cannot build this
     * map will under-report MRR, which is the intended failure direction.
     */
    monthlyRevenueByUser?: Map<string, number>;
    /** One-time credit-pack cash, kept outside every MRR figure. */
    creditRevenue?: number;
    creditBuyers?: number;
  } = {},
): RevenueCohorts {
  const couponUserIds = opts.couponUserIds ?? new Set<string>();
  const monthlyRevenueByUser = opts.monthlyRevenueByUser;
  const internalPattern = (opts.internalEmailPattern ?? "@aoacademy").toLowerCase();
  const paying = {
    subMonthly: 0,
    subAnnual: 0,
    oneTimeMonthly: 0,
    oneTimeAnnual: 0,
    bundleMonthly: 0,
    bundleAnnual: 0,
  };
  const payingByTier = { pro: 0, business: 0 };
  const mrrByTier = { pro: 0, business: 0 };
  const compedByTier = { pro: 0, business: 0 };
  const comped = { team: 0, coupon: 0, other: 0 };
  let mrr = 0;
  let directMrr = 0;
  let bundleMrr = 0;
  let recurringMrr = 0;
  let prepaidMrr = 0;
  let deferredRevenue = 0;
  let prepaidCustomers = 0;
  let prepaidWithin90 = 0;
  let prepaidWithin90Mrr = 0;
  let nextPrepaidExpiry: Date | null = null;
  const prepaidExpiryMonths: string[] = [];
  let payingCanceling = 0;
  let mrrAtRisk = 0;
  let lapsedPayers = 0;
  let trialActive = 0;
  let compedPaid = 0;
  let expiredTrial = 0;
  let expiredPlan = 0;
  let expiredBundle = 0;
  let free = 0;
  let internalTeam = 0;
  let directPayingTotal = 0;
  let bundleActive = 0;
  let payingTotal = 0;
  let committedTrialingUsers = 0;
  let committedTrialingExpectedMonthly = 0;
  let committedTrialingEarliest: string | null = null;
  let committedTrialingLatest: string | null = null;

  for (const u of users) {
    const cashPaid = paidUserIds.has(u.id);
    const bundleCashEvidence = typeof u.bundleAmountThb === "number" && u.bundleAmountThb > 0;
    const isTeam = !!u.email && u.email.toLowerCase().includes(internalPattern);
    if (isTeam) internalTeam++;

    // Task C8 — "รอเก็บเงินครั้งแรก": raw field predicate, independent of the
    // entitlement branches below (a committed-trialing account currently lands
    // in `compedPaid` via `entitledPaid`, and this must not change that — see
    // the module doc on `committedTrialing`). Same suspended/internal-team
    // exclusion as the rest of this cohort; anyone with real cash evidence is
    // already counted in `payingTotal` and must not double-count here.
    if (
      u.subStatus === "trialing"
      && !!u.stripeSubscriptionId
      && (u.plan === "PRO" || u.plan === "BUSINESS")
      && !u.suspended
      && !isTeam
      && !cashPaid
    ) {
      committedTrialingUsers++;
      committedTrialingExpectedMonthly += expectedMonthlyListPrice(listPrices, u.plan, u.billingPeriod);
      if (u.planExpiresAt) {
        const chargeDate = bangkokDate(u.planExpiresAt);
        if (!committedTrialingEarliest || chargeDate < committedTrialingEarliest) committedTrialingEarliest = chargeDate;
        if (!committedTrialingLatest || chargeDate > committedTrialingLatest) committedTrialingLatest = chargeDate;
      }
    }
    const source = classifyEntitlement(
      {
        id: u.id, email: u.email ?? "", role: u.role, plan: u.plan,
        usageCount: u.usageCount ?? 0, usageLimit: u.usageLimit ?? 0, usagePeriodStartedAt: u.usagePeriodStartedAt ?? null,
        planExpiresAt: u.planExpiresAt, trialStartedAt: u.trialStartedAt, trialEndsAt: u.trialEndsAt,
        subStatus: u.subStatus, stripeSubscriptionId: u.stripeSubscriptionId,
        bundleAccessExpiresAt: u.bundleAccessExpiresAt ?? null,
        bundleStatus: u.bundleStatus ?? null,
        bundlePrimary: u.bundlePrimary ?? false,
      },
      now,
    ).source;
    // Evaluate Studio-native entitlement without the Bundle overlay. A customer
    // can pay both sources; count the person once while retaining both revenues.
    const directPlan = u.bundlePrimary && !u.planExpiresAt && u.subStatus !== "active" ? "FREE" : u.plan;
    const directSource = classifyEntitlement(
      {
        id: u.id, email: u.email ?? "", role: u.role, plan: directPlan,
        usageCount: u.usageCount ?? 0, usageLimit: u.usageLimit ?? 0, usagePeriodStartedAt: u.usagePeriodStartedAt ?? null,
        planExpiresAt: u.planExpiresAt, trialStartedAt: u.trialStartedAt, trialEndsAt: u.trialEndsAt,
        subStatus: u.subStatus, stripeSubscriptionId: u.stripeSubscriptionId,
        bundleAccessExpiresAt: null, bundleStatus: null, bundlePrimary: false,
      },
      now,
    ).source;

    const entitledPaid = source === "SUBSCRIPTION" || source === "BUNDLE" || source === "TIMED_PLAN" || source === "PERMANENT_OR_MANUAL";
    const directEntitled = directSource === "SUBSCRIPTION" || directSource === "TIMED_PLAN" || directSource === "PERMANENT_OR_MANUAL";
    const directRevenueBacked = directEntitled && cashPaid;
    const bundleRevenueBacked =
      u.bundleStatus === "ACTIVE" &&
      !!u.bundleAccessExpiresAt &&
      u.bundleAccessExpiresAt > now &&
      bundleCashEvidence;

    if (directRevenueBacked || bundleRevenueBacked) {
      // Active, real, money-backed customer. The person is unique even if both
      // Studio and Bundle are active; MRR retains each independent cash stream.
      const plan = u.plan;
      payingTotal++;
      if (directRevenueBacked) {
        directPayingTotal++;
        if (directSource === "SUBSCRIPTION") {
          if (isAnnual(u.billingPeriod)) paying.subAnnual++;
          else paying.subMonthly++;
        } else {
          if (isAnnual(u.billingPeriod)) paying.oneTimeAnnual++;
          else paying.oneTimeMonthly++;
        }
        // No known amount → no revenue. This used to fall back to the tier LIST price, which
        // invented ฿6,389.33 of the ฿18,052.50 MRR on prod (audit A4, 2026-09-12) and carried
        // the fiction into prepaidMrr, deferredRevenue, gross margin %, AI-cost % and the
        // break-even target. Under-reporting is recoverable; pricing a customer we were never
        // paid by is not.
        const actual = monthlyRevenueByUser?.get(u.id);
        const add = typeof actual === "number" && Number.isFinite(actual) && actual >= 0 ? actual : 0;
        directMrr += add;
        mrr += add;

        // Split the same figure by whether it will bill again on its own. A live Stripe
        // subscription recurs; a one-time term does not, however long it still has to run.
        //
        // Must read `directSource`, never `source`. `source` is the COMBINED entitlement and
        // classifyEntitlement returns "BUNDLE" the moment an active Bundle exists, even for a
        // customer who also holds a live Studio subscription. Using it counted that customer
        // as prepaid: dropped out of ARR, given a fabricated deferred figure, and listed in
        // the "does not auto-renew" cliff banner — telling us a paying auto-renewing customer
        // was about to churn. `directSource` is the Studio-only view the rest of this block
        // already uses for direct-revenue decisions.
        const recurs = directSource === "SUBSCRIPTION"
          && !!u.stripeSubscriptionId
          && u.subStatus === "active";
        if (recurs) {
          recurringMrr += add;
        } else {
          prepaidMrr += add;
          prepaidCustomers++;
          const expiresAt = u.planExpiresAt;
          if (expiresAt && expiresAt > now) {
            const termDays = isAnnual(u.billingPeriod) ? 365 : 30;
            const termValue = isAnnual(u.billingPeriod) ? add * 12 : add;
            const daysLeft = (expiresAt.getTime() - now.getTime()) / 86_400_000;
            // Straight-line: the share of the term still owed to the customer.
            deferredRevenue += termValue * Math.min(1, Math.max(0, daysLeft / termDays));
            if (daysLeft <= 90) {
              prepaidWithin90++;
              prepaidWithin90Mrr += add;
            }
            if (!nextPrepaidExpiry || expiresAt < nextPrepaidExpiry) nextPrepaidExpiry = expiresAt;
            prepaidExpiryMonths.push(
              `${expiresAt.getUTCFullYear()}-${String(expiresAt.getUTCMonth() + 1).padStart(2, "0")}`,
            );
          }
        }
        if (plan === "BUSINESS") mrrByTier.business += add;
        else if (plan === "PRO") mrrByTier.pro += add;
        if (u.subStatus === "canceled") {
          payingCanceling++;
          mrrAtRisk += add;
        }
      }
      if (bundleRevenueBacked) {
        bundleActive++;
        if (isAnnual(u.bundleBillingPeriod ?? null)) paying.bundleAnnual++;
        else paying.bundleMonthly++;
        const add = bundleMonthlyEquiv(u.bundleAmountThb, u.bundleBillingPeriod);
        bundleMrr += add;
        mrr += add;
        if (plan === "BUSINESS") mrrByTier.business += add;
        else if (plan === "PRO") mrrByTier.pro += add;
      }
      if (plan === "BUSINESS") payingByTier.business++;
      else if (plan === "PRO") payingByTier.pro++;
    } else if (entitledPaid) {
      // Has paid-plan access but no cash evidence: admin / coupon / comp.
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
    } else if (source === "EXPIRED_BUNDLE") {
      expiredBundle++;
      lapsedPayers++;
    } else {
      // FREE
      if (cashPaid || bundleCashEvidence) lapsedPayers++; // paid before, fully reverted to FREE
      else free++;
    }
  }

  return {
    payingTotal,
    paying,
    directPayingTotal,
    bundleActive,
    payingByTier,
    mrr,
    directMrr,
    bundleMrr,
    creditRevenue: opts.creditRevenue ?? 0,
    creditBuyers: opts.creditBuyers ?? 0,
    recurringMrr,
    prepaidMrr,
    // ARR is recurring revenue annualised. Blending PREPAID in would claim a yearly run rate
    // from customers who already paid once and will simply stop when their term ends — that
    // is what this split exists to prevent. Bundle is not prepaid: it is a second
    // subscription product that renews, so leaving it out under-reported the business by its
    // whole run rate (1,798฿/month on prod, two live customers).
    arr: (recurringMrr + bundleMrr) * 12,
    arrStudio: recurringMrr * 12,
    arrBundle: bundleMrr * 12,
    deferredRevenue,
    prepaidExpiry: {
      nextAt: nextPrepaidExpiry,
      within90Days: prepaidWithin90,
      within90DaysMrr: prepaidWithin90Mrr,
      firstMonth: prepaidExpiryMonths.length ? prepaidExpiryMonths.slice().sort()[0] : null,
      lastMonth: prepaidExpiryMonths.length ? prepaidExpiryMonths.slice().sort().at(-1)! : null,
      customers: prepaidCustomers,
    },
    mrrByTier,
    payingCanceling,
    mrrAtRisk,
    lapsedPayers,
    trialActive,
    compedPaid,
    compedByTier,
    comped,
    internalTeam,
    expiredTrial,
    expiredPlan,
    expiredBundle,
    free,
    breakEvenSubs: payingTotal,
    committedTrialing: {
      users: committedTrialingUsers,
      expectedMonthlyThb: committedTrialingExpectedMonthly,
      firstChargeDates: { earliest: committedTrialingEarliest, latest: committedTrialingLatest },
    },
  };
}

/** DB wrapper — fetches every user's billing fields, cash-payer ids, coupon ids, and plan prices. */
export async function getRevenueCohorts(now: Date = new Date()): Promise<RevenueCohorts> {
  const [users, paidRows, couponRows, planConfig] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true, email: true, plan: true, role: true, subStatus: true, billingPeriod: true,
        planExpiresAt: true, trialStartedAt: true, trialEndsAt: true, stripeSubscriptionId: true,
        bundleAccessExpiresAt: true, bundleStatus: true, bundlePrimary: true,
        bundleBillingPeriod: true, bundleAmountThb: true, suspended: true,
      },
    }),
    // Every PAID payment — the cash ground truth (all-time). Not `distinct` any more: the
    // amounts and the credit-pack marker are both needed to price MRR honestly.
    prisma.payment.findMany({
      where: { status: "PAID" },
      select: { userId: true, amount: true, note: true, periodDays: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    // Distinct users who redeemed a coupon — to split comped access (workshop/promo) from admin/other.
    prisma.couponRedemption.findMany({ select: { userId: true }, distinct: ["userId"] }),
    getPlanConfig(),
  ]);

  const planCash = summarizePlanCash(paidRows);
  const couponUserIds = new Set(couponRows.map((r) => r.userId));
  return computeRevenueCohorts(
    users,
    planCash.paidUserIds,
    { pro: planConfig.pro.price, business: planConfig.business.price },
    now,
    {
      couponUserIds,
      monthlyRevenueByUser: planCash.monthlyRevenueByUser,
      creditRevenue: planCash.creditRevenue,
      creditBuyers: planCash.creditBuyers,
    },
  );
}
