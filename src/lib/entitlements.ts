import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { limitsForPlan, minutesPerMonthForPlan } from "@/lib/plan-limits";
import { resetMonthlyGranted } from "@/lib/credits";

const PAID_PLANS = ["PRO", "BUSINESS"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

type PaidPlan = (typeof PAID_PLANS)[number];

type EntitlementUser = {
  id: string;
  email: string;
  role: string;
  plan: string;
  usageCount: number;
  usageLimit: number;
  usagePeriodStartedAt: Date | null;
  planExpiresAt: Date | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  subStatus: string | null;
  stripeSubscriptionId: string | null;
};

export type EntitlementDecision = {
  effectivePlan: string;
  source:
    | "FREE"
    | "TRIAL"
    | "SUBSCRIPTION"
    | "TIMED_PLAN"
    | "PERMANENT_OR_MANUAL"
    | "EXPIRED_TRIAL"
    | "EXPIRED_PLAN";
  action: "KEEP" | "DOWNGRADE" | "REVIEW";
  reason: string;
  expiresAt: Date | null;
};

function isPaidPlan(plan: string): plan is PaidPlan {
  return PAID_PLANS.includes(plan as PaidPlan);
}

function hasActiveSubscription(user: Pick<EntitlementUser, "subStatus">): boolean {
  return user.subStatus === "active";
}

function usageWindowForPlanValue(plan: string, from: Date) {
  const clips = limitsForPlan(plan).clips;
  // Reset clip AND minute windows together (see usageWindowForPlan) — a downgrade that
  // reset only clips left minutesUsed stranded above the new (lower) limit.
  return {
    usageCount: 0,
    usageLimit: Number.isFinite(clips) ? Number(clips) : 100,
    usagePeriodStartedAt: from,
    minutesUsed: 0,
    minutesLimit: minutesPerMonthForPlan(plan),
  };
}

/**
 * Force a fresh monthly credit grant on PAID plan activation, IGNORING the 30-day grant
 * window. The symmetric counterpart to the downgrade-reset inside syncUserEntitlement.
 *
 * Why force (NOT ensureMonthlyGrant): a trial-expiry downgrade calls
 * `resetMonthlyGranted(userId, "FREE")`, which stamps `grantedResetAt = now` even though
 * the FREE allowance is 0. If the user then SUBSCRIBES within 30 days, ensureMonthlyGrant
 * sees `withinWindow === true` and SKIPS the grant → the paying subscriber gets 0 credits
 * for ~the first month (bug H4). resetMonthlyGranted hard-sets `granted` to the new plan's
 * allowance and re-stamps the window from now, so the credits land immediately.
 *
 * Flag-gated on CREDITS_LIVE (no-op when off → byte-identical). No-op for non-paid plans
 * (FREE/unknown — nothing to grant; avoids a spurious monthly-reset:FREE ledger row).
 * `purchased` (paid) credits are never touched (resetMonthlyGranted only sets `granted`).
 */
export async function grantOnPaidActivation(userId: string, plan: string): Promise<void> {
  if (process.env.CREDITS_LIVE !== "1") return;
  if (!isPaidPlan(plan)) return; // FREE / unknown — no monthly allowance to grant
  await resetMonthlyGranted(userId, plan);
}

export function classifyEntitlement(user: EntitlementUser, now: Date = new Date()): EntitlementDecision {
  if (!isPaidPlan(user.plan)) {
    return { effectivePlan: "FREE", source: "FREE", action: "KEEP", reason: "free_plan", expiresAt: null };
  }

  if (hasActiveSubscription(user)) {
    return {
      effectivePlan: user.plan,
      source: "SUBSCRIPTION",
      action: "KEEP",
      reason: "active_subscription",
      expiresAt: user.planExpiresAt,
    };
  }

  if (user.trialEndsAt) {
    if (user.trialEndsAt <= now) {
      return {
        effectivePlan: "FREE",
        source: "EXPIRED_TRIAL",
        action: "DOWNGRADE",
        reason: "trial_expired",
        expiresAt: user.trialEndsAt,
      };
    }
    return {
      effectivePlan: user.plan,
      source: "TRIAL",
      action: "KEEP",
      reason: "active_trial",
      expiresAt: user.trialEndsAt,
    };
  }

  if (user.planExpiresAt) {
    if (user.planExpiresAt <= now) {
      return {
        effectivePlan: "FREE",
        source: "EXPIRED_PLAN",
        action: "DOWNGRADE",
        reason: "plan_expired",
        expiresAt: user.planExpiresAt,
      };
    }
    return {
      effectivePlan: user.plan,
      source: "TIMED_PLAN",
      action: "KEEP",
      reason: "timed_plan_active",
      expiresAt: user.planExpiresAt,
    };
  }

  return {
    effectivePlan: user.plan,
    source: "PERMANENT_OR_MANUAL",
    action: "REVIEW",
    reason: "paid_plan_without_expiry_or_active_subscription",
    expiresAt: null,
  };
}

export async function syncUserEntitlement(userId: string, now: Date = new Date()) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      plan: true,
      usageCount: true,
      usageLimit: true,
      usagePeriodStartedAt: true,
      planExpiresAt: true,
      trialStartedAt: true,
      trialEndsAt: true,
      subStatus: true,
      stripeSubscriptionId: true,
    },
  });
  if (!user) return null;

  const decision = classifyEntitlement(user, now);
  if (decision.action !== "DOWNGRADE") return { user, decision, changed: false };

  const expiryGuard =
    decision.reason === "trial_expired"
      ? { trialEndsAt: { not: null, lte: now } }
      : { planExpiresAt: { not: null, lte: now } };

  const res = await prisma.user.updateMany({
    where: {
      id: userId,
      plan: { in: [...PAID_PLANS] },
      OR: [{ subStatus: null }, { subStatus: { not: "active" } }],
      ...expiryGuard,
    },
    data: {
      plan: "FREE",
      planExpiresAt: null,
      trialEndsAt: null,
      ...usageWindowForPlanValue("FREE", now),
    },
  });

  if (res.count === 1) {
    // Plan actually transitioned to FREE on THIS call (updateMany matched the
    // PAID→expired guard exactly once). Reset the monthly `granted` bucket to the
    // new plan's allowance (FREE→0) so leftover PRO/BUSINESS credits don't persist
    // through a downgrade. CREDITS_LIVE-gated inside resetMonthlyGranted's callers,
    // so we gate the call here too — flag-off makes this a no-op (byte-identical path).
    // Lives inside `res.count === 1` so it fires ONCE per transition, never on a
    // steady-state sync (which returns early at `action !== "DOWNGRADE"` above).
    if (process.env.CREDITS_LIVE === "1") {
      await resetMonthlyGranted(userId, "FREE").catch(() => {});
    }
    const minuteImpact = process.env.MINUTE_QUOTA === "1" ? " (เหลือ 5 นาที/เดือน)" : "";
    await createNotification({
      userId,
      type: "LIMIT_REACHED",
      title: decision.reason === "trial_expired" ? "ทดลอง PRO หมดอายุแล้ว" : "แพ็กเกจหมดอายุแล้ว",
      body: `บัญชีของคุณกลับเป็น Free แล้ว${minuteImpact} อัปเกรดเพื่อใช้ฟีเจอร์ PRO ต่อ`,
    }).catch(() => {});
  }

  const updated = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      plan: true,
      usageCount: true,
      usageLimit: true,
      usagePeriodStartedAt: true,
      planExpiresAt: true,
      trialStartedAt: true,
      trialEndsAt: true,
      subStatus: true,
      stripeSubscriptionId: true,
    },
  });
  return { user: updated ?? user, decision, changed: res.count === 1 };
}

export async function revertExpiredEntitlements(now: Date = new Date()) {
  const due = await prisma.user.findMany({
    where: {
      plan: { in: [...PAID_PLANS] },
      OR: [{ subStatus: null }, { subStatus: { not: "active" } }],
      AND: [
        {
          OR: [
            { trialEndsAt: { not: null, lte: now } },
            { planExpiresAt: { not: null, lte: now } },
          ],
        },
      ],
    },
    select: { id: true },
  });

  let reverted = 0;
  for (const user of due) {
    const result = await syncUserEntitlement(user.id, now);
    if (result?.changed) reverted++;
  }

  return { checked: due.length, reverted };
}

export async function getEntitlementAuditReport(now: Date = new Date()) {
  const paidNoExpiryUsers = await prisma.user.findMany({
    where: {
      plan: { in: [...PAID_PLANS] },
      planExpiresAt: null,
      OR: [{ subStatus: null }, { subStatus: { not: "active" } }],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      role: true,
      plan: true,
      usageCount: true,
      usageLimit: true,
      planExpiresAt: true,
      trialEndsAt: true,
      subStatus: true,
      stripeSubscriptionId: true,
      couponRedemptions: {
        orderBy: { redeemedAt: "desc" },
        select: {
          redeemedAt: true,
          coupon: { select: { code: true, plan: true, durationDays: true } },
        },
      },
    },
  });

  const paidNoExpiryReview = paidNoExpiryUsers.map((user) => {
    const expiredCoupon = user.couponRedemptions.find((r) => {
      const durationDays = r.coupon.durationDays;
      if (!durationDays || durationDays <= 0) return false;
      return r.redeemedAt.getTime() + durationDays * DAY_MS <= now.getTime();
    });
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      plan: user.plan,
      usageCount: user.usageCount,
      usageLimit: user.usageLimit,
      subStatus: user.subStatus,
      stripeSubscriptionId: user.stripeSubscriptionId,
      reviewReason: expiredCoupon
        ? "EXPIRED_COUPON_WITHOUT_PLAN_EXPIRY"
        : "PAID_PLAN_WITHOUT_EXPIRY_OR_ACTIVE_SUBSCRIPTION",
      latestCoupon: expiredCoupon
        ? {
            code: expiredCoupon.coupon.code,
            plan: expiredCoupon.coupon.plan,
            durationDays: expiredCoupon.coupon.durationDays,
            redeemedAt: expiredCoupon.redeemedAt,
            computedExpiresAt: new Date(expiredCoupon.redeemedAt.getTime() + expiredCoupon.coupon.durationDays * DAY_MS),
          }
        : null,
    };
  });

  const [
    activeTrials,
    expiredTrialsNotReverted,
    expiredPlansNotReverted,
    freeUsers,
    proUsers,
    businessUsers,
  ] = await Promise.all([
    prisma.user.count({ where: { trialEndsAt: { not: null, gt: now } } }),
    prisma.user.count({
      where: {
        trialEndsAt: { not: null, lte: now },
        OR: [{ subStatus: null }, { subStatus: { not: "active" } }],
      },
    }),
    prisma.user.count({
      where: {
        plan: { in: [...PAID_PLANS] },
        planExpiresAt: { not: null, lte: now },
        OR: [{ subStatus: null }, { subStatus: { not: "active" } }],
      },
    }),
    prisma.user.count({ where: { plan: "FREE" } }),
    prisma.user.count({ where: { plan: "PRO" } }),
    prisma.user.count({ where: { plan: "BUSINESS" } }),
  ]);

  return {
    generatedAt: now,
    counts: {
      freeUsers,
      proUsers,
      businessUsers,
      activeTrials,
      expiredTrialsNotReverted,
      expiredPlansNotReverted,
      paidPlanNoExpiryNoActiveSubscription: paidNoExpiryReview.length,
      expiredCouponWithoutPlanExpiry: paidNoExpiryReview.filter((u) => u.reviewReason === "EXPIRED_COUPON_WITHOUT_PLAN_EXPIRY").length,
    },
    paidNoExpiryReview,
  };
}
