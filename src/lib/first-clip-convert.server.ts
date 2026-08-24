import "server-only";

import { prisma } from "@/lib/prisma";
import { foundingStatus } from "@/lib/founding";
import { getPlanConfig } from "@/lib/plan-config";
import { decideFirstClipConvertPrompt, type FirstClipConvertDecision } from "@/lib/first-clip-convert";
import {
  isInternalNorthStarAccount,
  recurringBillingCohort,
  type NorthStarUserEvidence,
} from "@/lib/subscription-north-star.server";

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
      payments: {
        where: { status: "PAID", amount: { gt: 0 }, periodDays: { gt: 0 } },
        select: { plan: true, status: true, amount: true, periodDays: true },
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
  const [plans, founding] = await Promise.all([getPlanConfig(), foundingStatus()]);

  return decideFirstClipConvertPrompt({
    isInternal: isInternalNorthStarAccount(evidence),
    isRecurringPayer: recurringBillingCohort(evidence, now) != null,
    hasCompletedVideo,
    monthlyPriceThb: plans.pro.price,
    founding,
  });
}
