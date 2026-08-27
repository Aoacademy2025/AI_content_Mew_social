import "server-only";

import { prisma } from "@/lib/prisma";
import { foundingStatus } from "@/lib/founding";
import { getPlanConfig } from "@/lib/plan-config";
import { MONTHLY_GRANT } from "@/lib/credit-costs";
import { minutesPerMonthForPlan, storageDaysForPlan } from "@/lib/plan-limits";
import { decideFirstClipConvertPrompt, type FirstClipConvertDecision } from "@/lib/first-clip-convert";
import { resolvePaidEquivalentEntitlement } from "@/lib/paid-equivalent-entitlement.server";
import {
  isInternalNorthStarAccount,
  recurringBillingCohort,
  type NorthStarUserEvidence,
} from "@/lib/subscription-north-star.server";

const CONVERT_TARGET_PLAN = "PRO";

export async function getFirstClipConvertPrompt(
  userId: string,
  now: Date = new Date(),
): Promise<FirstClipConvertDecision> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      plan: true,
      suspended: true,
      stripeSubscriptionId: true,
      subStatus: true,
      billingPeriod: true,
      planExpiresAt: true,
      bundleSubscriptionId: true,
      bundleStatus: true,
      bundleBillingPeriod: true,
      bundleAccessExpiresAt: true,
      bundleAmountThb: true,
      firstClipConvertDismissedAt: true,
      payments: {
        where: { status: "PAID", amount: { gt: 0 }, periodDays: { gt: 0 } },
        select: { plan: true, status: true, amount: true, periodDays: true, note: true },
      },
    },
  });
  if (!user) return { show: false, reason: "no_completed_video" };

  const evidence: NorthStarUserEvidence = user;
  const completed = await prisma.video.findFirst({
    where: {
      userId,
      status: "COMPLETED",
      OR: [{ videoUrl: { not: null } }, { avatarVideoUrl: { not: null } }],
    },
    select: { id: true, videoUrl: true, avatarVideoUrl: true },
  });
  const hasCompletedVideo = Boolean(completed?.videoUrl?.trim() || completed?.avatarVideoUrl?.trim());
  const [plans, founding, paidEquivalent] = await Promise.all([
    getPlanConfig(),
    foundingStatus(),
    // Anyone who already holds paid-equivalent access — a card subscription, a
    // one-time/PromptPay term, a Bundle, a GRANT coupon or an administrator
    // grant — has nothing to buy here. Only the Trial/FREE cohort is asked.
    resolvePaidEquivalentEntitlement(userId, now),
  ]);

  return decideFirstClipConvertPrompt({
    isInternal: isInternalNorthStarAccount(evidence),
    isRecurringPayer: recurringBillingCohort(evidence, now) != null,
    isPaidEquivalent: paidEquivalent.canUsePaidFeatures,
    hasCompletedVideo,
    dismissedAt: user.firstClipConvertDismissedAt,
    now,
    monthlyPriceThb: plans.pro.price,
    benefits: {
      storageDays: storageDaysForPlan(CONVERT_TARGET_PLAN),
      minutesPerMonth: minutesPerMonthForPlan(CONVERT_TARGET_PLAN),
      monthlyCredits: MONTHLY_GRANT[CONVERT_TARGET_PLAN] ?? 0,
    },
    founding,
  });
}

/** Persist "not now" for this user. The 30-day cooldown is enforced on read. */
export async function dismissFirstClipConvertPrompt(userId: string, now: Date = new Date()): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { firstClipConvertDismissedAt: now },
  });
}
