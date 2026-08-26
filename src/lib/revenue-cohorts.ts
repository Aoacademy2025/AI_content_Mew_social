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
  bundleAccessExpiresAt?: Date | null;
  bundleStatus?: string | null;
  bundlePrimary?: boolean;
  bundleBillingPeriod?: string | null;
  bundleAmountThb?: number | null;
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
    bundleMonthly: number; // active paid Hero AI Bundle, monthly
    bundleAnnual: number; // active paid Hero AI Bundle, annual/founding annual
  };
  /** Direct Studio payers only; excludes Bundle buyers. */
  directPayingTotal: number;
  /** Active Hero AI Bundle buyers with Studio access. */
  bundleActive: number;
  payingByTier: { pro: number; business: number };
  /** Monthly run-rate over active paying customers, annual normalized. List-price based. */
  mrr: number;
  /** Studio-native MRR and Bundle MRR, both included in `mrr`. */
  directMrr: number;
  bundleMrr: number;
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
  /** `recurringMrr × 12`. Deliberately excludes prepaid — see `prepaidMrr`. */
  arr: number;
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
};

function isAnnual(billingPeriod: string | null): boolean {
  return billingPeriod === "annual";
}
function monthlyEquiv(tierMonthlyPrice: number, billingPeriod: string | null): number {
  return isAnnual(billingPeriod) ? (tierMonthlyPrice * ANNUAL_PRICE_MONTHS) / 12 : tierMonthlyPrice;
}
function bundleMonthlyEquiv(amountThb: number | null | undefined, billingPeriod: string | null | undefined): number {
  const amount = typeof amountThb === "number" && Number.isFinite(amountThb) ? amountThb : 0;
  return billingPeriod === "annual" ? amount / 12 : amount;
}
function tierPrice(prices: TierPrices, plan: string): number {
  if (plan === "BUSINESS") return prices.business;
  if (plan === "PRO") return prices.pro;
  return 0;
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
  /** Users with real PLAN cash — the ground truth for "is a paying customer". */
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
    paidUserIds.add(row.userId);
    if (row.amount <= 0) continue;
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
 * @param paidUserIds  Set of user ids that have ≥1 PAID Payment (the cash ground truth).
 * @param prices       Monthly tier prices (฿).
 * @param now          Reference time.
 */
export function computeRevenueCohorts(
  users: CohortUser[],
  paidUserIds: Set<string>,
  prices: TierPrices,
  now: Date = new Date(),
  opts: {
    couponUserIds?: Set<string>;
    internalEmailPattern?: string;
    /**
     * userId → the monthly-equivalent of what this customer ACTUALLY paid for their plan (฿).
     *
     * Without it MRR is priced off the tier list price, which overstates every discounted
     * customer: a Founding annual buyer pays 2,995฿/year (250฿/month) but was counted at
     * 599 × 10 / 12 = 499฿. On prod that inflated Studio MRR by ~3,565฿/month across
     * thirteen payers. A user absent from the map falls back to the list price, so callers
     * that cannot compute it keep the previous behaviour.
     */
    monthlyRevenueByUser?: Map<string, number>;
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

  for (const u of users) {
    const cashPaid = paidUserIds.has(u.id);
    const bundleCashEvidence = typeof u.bundleAmountThb === "number" && u.bundleAmountThb > 0;
    const isTeam = !!u.email && u.email.toLowerCase().includes(internalPattern);
    if (isTeam) internalTeam++;
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
        const actual = monthlyRevenueByUser?.get(u.id);
        const add = typeof actual === "number" && Number.isFinite(actual) && actual >= 0
          ? actual
          : monthlyEquiv(tierPrice(prices, plan), u.billingPeriod);
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
    recurringMrr,
    prepaidMrr,
    // ARR is recurring revenue annualised. Blending prepaid in would claim a yearly run rate
    // from customers who already paid once and will simply stop when their term ends.
    arr: recurringMrr * 12,
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
        bundleBillingPeriod: true, bundleAmountThb: true,
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
    { couponUserIds, monthlyRevenueByUser: planCash.monthlyRevenueByUser },
  );
}
