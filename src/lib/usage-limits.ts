import { prisma } from "@/lib/prisma";
import { limitsForPlan } from "@/lib/plan-limits";
import { syncUserEntitlement } from "@/lib/entitlements";

export const USAGE_PERIOD_DAYS = 30;

const USAGE_PERIOD_MS = USAGE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

export function usageLimitForPlan(plan: string): number {
  const clips = limitsForPlan(plan).clips;
  return Number.isFinite(clips) ? Number(clips) : 100;
}

export function usageWindowForPlan(plan: string, from: Date = new Date()) {
  return {
    usageCount: 0,
    usageLimit: usageLimitForPlan(plan),
    usagePeriodStartedAt: from,
  };
}

export function usageResetAt(startedAt: Date): Date {
  return new Date(startedAt.getTime() + USAGE_PERIOD_MS);
}

function isWindowExpired(startedAt: Date | null, now: Date): boolean {
  return !startedAt || startedAt.getTime() + USAGE_PERIOD_MS <= now.getTime();
}

export type SyncedUsage = {
  plan: string;
  usageCount: number;
  usageLimit: number;
  usagePeriodStartedAt: Date;
  resetAt: Date;
};

export async function syncUsageWindow(userId: string): Promise<SyncedUsage | null> {
  const now = new Date();
  await syncUserEntitlement(userId, now);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      plan: true,
      usageCount: true,
      usageLimit: true,
      usagePeriodStartedAt: true,
    },
  });

  if (!user) return null;

  const usageLimit = usageLimitForPlan(user.plan);
  const shouldReset = isWindowExpired(user.usagePeriodStartedAt, now);
  const usagePeriodStartedAt = shouldReset ? now : user.usagePeriodStartedAt!;
  const usageCount = shouldReset ? 0 : user.usageCount;

  if (shouldReset || user.usageLimit !== usageLimit) {
    await prisma.user.update({
      where: { id: userId },
      data: { usageCount, usageLimit, usagePeriodStartedAt },
    });
  }

  return {
    plan: user.plan,
    usageCount,
    usageLimit,
    usagePeriodStartedAt,
    resetAt: usageResetAt(usagePeriodStartedAt),
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
