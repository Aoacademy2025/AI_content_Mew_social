import { prisma } from "@/lib/prisma";
import { limitsForPlan, minutesPerMonthForPlan, TRIAL_MINUTES } from "@/lib/plan-limits";
import { syncUserEntitlement } from "@/lib/entitlements";

export const USAGE_PERIOD_DAYS = 30;

const USAGE_PERIOD_MS = USAGE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

export function usageLimitForPlan(plan: string): number {
  const clips = limitsForPlan(plan).clips;
  return Number.isFinite(clips) ? Number(clips) : 100;
}

export function usageWindowForPlan(plan: string, from: Date = new Date()) {
  // Reset BOTH the clip window and the minute window together. usagePeriodStartedAt is the
  // single shared cycle anchor for both counters; resetting clips alone left `minutesUsed`
  // stranded across plan transitions, so e.g. a trial→FREE downgrade kept minutesUsed at the
  // trial total (>FREE limit) → 0 render minutes for 30 days once MINUTE_QUOTA is on.
  return {
    usageCount: 0,
    usageLimit: usageLimitForPlan(plan),
    usagePeriodStartedAt: from,
    minutesUsed: 0,
    minutesLimit: minutesPerMonthForPlan(plan),
    aiAudioMinutesUsed: 0,
    aiTextCallsUsed: 0,
  };
}

export function usageResetAt(startedAt: Date): Date {
  return new Date(startedAt.getTime() + USAGE_PERIOD_MS);
}

export type SyncedUsageCycle = {
  plan: string;
  usageCount: number;
  usageLimit: number;
  minutesUsed: number;
  minutesLimit: number;
  aiAudioMinutesUsed: number;
  aiTextCallsUsed: number;
  usagePeriodStartedAt: Date;
};

/**
 * Synchronize the single 30-day cycle shared by clip, render-minute and managed-AI
 * counters. Every caller must cross this seam before reading one of those meters.
 *
 * The rollover is a conditional update so two first requests in a new cycle cannot
 * both reset it and wipe usage reserved between their writes.
 */
export async function syncSharedUsageCycle(
  userId: string,
  now: Date = new Date(),
): Promise<SyncedUsageCycle | null> {
  await syncUserEntitlement(userId, now);

  const select = {
    plan: true,
    usageCount: true,
    usageLimit: true,
    minutesUsed: true,
    minutesLimit: true,
    aiAudioMinutesUsed: true,
    aiTextCallsUsed: true,
    usagePeriodStartedAt: true,
    trialEndsAt: true,
  } as const;
  const user = await prisma.user.findUnique({ where: { id: userId }, select });
  if (!user) return null;

  const usageLimit = usageLimitForPlan(user.plan);
  const isActiveTrial = !!user.trialEndsAt && user.trialEndsAt > now;
  const minutesLimit = isActiveTrial
    ? Math.min(minutesPerMonthForPlan(user.plan), TRIAL_MINUTES)
    : minutesPerMonthForPlan(user.plan);
  const expiredBefore = new Date(now.getTime() - USAGE_PERIOD_MS);

  await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [
        { usagePeriodStartedAt: null },
        { usagePeriodStartedAt: { lte: expiredBefore } },
      ],
    },
    data: {
      usageCount: 0,
      usageLimit,
      minutesUsed: 0,
      minutesLimit,
      aiAudioMinutesUsed: 0,
      aiTextCallsUsed: 0,
      usagePeriodStartedAt: now,
    },
  });

  // Re-read after the conditional rollover. If another request won the reset race,
  // this preserves any usage it reserved in the new cycle instead of returning stale data.
  let current = await prisma.user.findUnique({ where: { id: userId }, select });
  if (!current?.usagePeriodStartedAt) return null;

  const currentUsageLimit = usageLimitForPlan(current.plan);
  const currentIsActiveTrial = !!current.trialEndsAt && current.trialEndsAt > now;
  const currentMinutesLimit = currentIsActiveTrial
    ? Math.min(minutesPerMonthForPlan(current.plan), TRIAL_MINUTES)
    : minutesPerMonthForPlan(current.plan);

  if (current.usageLimit !== currentUsageLimit || current.minutesLimit !== currentMinutesLimit) {
    current = await prisma.user.update({
      where: { id: userId },
      data: { usageLimit: currentUsageLimit, minutesLimit: currentMinutesLimit },
      select,
    });
  }

  return {
    plan: current.plan,
    usageCount: current.usageCount,
    usageLimit: currentUsageLimit,
    minutesUsed: current.minutesUsed,
    minutesLimit: currentMinutesLimit,
    aiAudioMinutesUsed: current.aiAudioMinutesUsed,
    aiTextCallsUsed: current.aiTextCallsUsed,
    usagePeriodStartedAt: current.usagePeriodStartedAt!,
  };
}

export type SyncedUsage = {
  plan: string;
  usageCount: number;
  usageLimit: number;
  usagePeriodStartedAt: Date;
  resetAt: Date;
};

export async function syncUsageWindow(userId: string): Promise<SyncedUsage | null> {
  const user = await syncSharedUsageCycle(userId);
  if (!user) return null;

  return {
    plan: user.plan,
    usageCount: user.usageCount,
    usageLimit: user.usageLimit,
    usagePeriodStartedAt: user.usagePeriodStartedAt,
    resetAt: usageResetAt(user.usagePeriodStartedAt),
  };
}

type UsageReservation =
  | (SyncedUsage & { allowed: true })
  | (SyncedUsage & { allowed: false; message: string });

function quotaMessage(plan: string, usageLimit: number, resetAt: Date): string {
  const name = plan === "BUSINESS" ? "Business" : plan === "PRO" ? "Pro" : "Free";
  const resetDate = resetAt.toLocaleDateString("th-TH");
  return `แพ็กเกจ ${name} จำกัด ${usageLimit} คลิปต่อ 30 วัน รอบนี้ใช้ครบแล้ว (รีเซ็ต ${resetDate})`;
}

export async function reserveClipUsage(userId: string): Promise<UsageReservation | null> {
  const usage = await syncUsageWindow(userId);
  if (!usage) return null;

  if (usage.usageCount >= usage.usageLimit) {
    return { ...usage, allowed: false, message: quotaMessage(usage.plan, usage.usageLimit, usage.resetAt) };
  }

  const reserved = await prisma.user.updateMany({
    where: { id: userId, usageCount: { lt: usage.usageLimit } },
    data: { usageCount: { increment: 1 }, usageLimit: usage.usageLimit },
  });

  if (reserved.count !== 1) {
    const latest = await syncUsageWindow(userId);
    if (!latest) return null;
    return { ...latest, allowed: false, message: quotaMessage(latest.plan, latest.usageLimit, latest.resetAt) };
  }

  return { ...usage, usageCount: usage.usageCount + 1, allowed: true };
}

/** Read-only quota peek — does NOT reserve. Use for fail-fast prechecks before heavy
 *  work; reserveClipUsage above remains the single atomic source of truth. */
export async function checkClipQuota(userId: string): Promise<UsageReservation | null> {
  const usage = await syncUsageWindow(userId);
  if (!usage) return null;

  if (usage.usageCount >= usage.usageLimit) {
    return { ...usage, allowed: false, message: quotaMessage(usage.plan, usage.usageLimit, usage.resetAt) };
  }

  return { ...usage, allowed: true };
}

export async function refundClipUsage(userId: string): Promise<void> {
  await prisma.user.updateMany({
    where: { id: userId, usageCount: { gt: 0 } },
    data: { usageCount: { decrement: 1 } },
  });
}
