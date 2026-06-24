import { prisma } from "@/lib/prisma";
import { USAGE_PERIOD_DAYS } from "@/lib/usage-limits";
import { syncUserEntitlement } from "@/lib/entitlements";
import { minutesPerMonthForPlan } from "@/lib/plan-limits";

const USAGE_PERIOD_MS = USAGE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

export function minutesLimitForPlan(plan: string): number {
  return minutesPerMonthForPlan(plan);
}

function isWindowExpired(startedAt: Date | null, now: Date): boolean {
  return !startedAt || startedAt.getTime() + USAGE_PERIOD_MS <= now.getTime();
}

function minuteQuotaMessage(plan: string, limit: number): string {
  const name = plan === "BUSINESS" ? "Business" : plan === "PRO" ? "Pro" : "Free";
  return `แพ็กเกจ ${name} จำกัด ${limit} นาทีต่อ 30 วัน รอบนี้ใช้ครบแล้ว`;
}

async function syncMinuteWindow(userId: string): Promise<{
  plan: string;
  minutesUsed: number;
  minutesLimit: number;
  usagePeriodStartedAt: Date;
} | null> {
  const now = new Date();
  await syncUserEntitlement(userId, now);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, minutesUsed: true, minutesLimit: true, usagePeriodStartedAt: true },
  });
  if (!user) return null;

  const minutesLimit = minutesLimitForPlan(user.plan);
  const shouldReset = isWindowExpired(user.usagePeriodStartedAt, now);
  const usagePeriodStartedAt = shouldReset ? now : user.usagePeriodStartedAt!;
  const minutesUsed = shouldReset ? 0 : user.minutesUsed;

  if (shouldReset || user.minutesLimit !== minutesLimit) {
    await prisma.user.update({
      where: { id: userId },
      data: { minutesUsed, minutesLimit, usagePeriodStartedAt },
    });
  }

  return { plan: user.plan, minutesUsed, minutesLimit, usagePeriodStartedAt };
}

export async function checkMinuteQuota(
  userId: string
): Promise<{ allowed: boolean; remaining: number; used: number; message?: string }> {
  const s = await syncMinuteWindow(userId);
  if (!s) return { allowed: false, remaining: 0, used: 0, message: "ไม่พบผู้ใช้" };
  const remaining = Math.max(0, s.minutesLimit - s.minutesUsed);
  if (remaining <= 0) {
    return { allowed: false, remaining: 0, used: s.minutesUsed, message: minuteQuotaMessage(s.plan, s.minutesLimit) };
  }
  return { allowed: true, remaining, used: s.minutesUsed };
}

export async function reserveMinutes(
  userId: string,
  minutes: number
): Promise<{ allowed: boolean; remaining: number; message?: string }> {
  const s = await syncMinuteWindow(userId);
  if (!s) return { allowed: false, remaining: 0, message: "ไม่พบผู้ใช้" };

  const remaining = Math.max(0, s.minutesLimit - s.minutesUsed);
  if (s.minutesUsed + minutes > s.minutesLimit) {
    return { allowed: false, remaining, message: minuteQuotaMessage(s.plan, s.minutesLimit) };
  }

  // Atomic conditional update — same pattern as reserveClipUsage
  const reserved = await prisma.user.updateMany({
    where: { id: userId, minutesUsed: { lte: s.minutesLimit - minutes } },
    data: { minutesUsed: { increment: minutes }, minutesLimit: s.minutesLimit },
  });

  if (reserved.count !== 1) {
    // Lost the race — re-read and report current state
    const latest = await syncMinuteWindow(userId);
    if (!latest) return { allowed: false, remaining: 0, message: "ไม่พบผู้ใช้" };
    const latestRemaining = Math.max(0, latest.minutesLimit - latest.minutesUsed);
    return { allowed: false, remaining: latestRemaining, message: minuteQuotaMessage(latest.plan, latest.minutesLimit) };
  }

  const newRemaining = Math.max(0, s.minutesLimit - (s.minutesUsed + minutes));
  return { allowed: true, remaining: newRemaining };
}

export async function refundMinutes(userId: string, minutes: number): Promise<void> {
  await prisma.$executeRaw`UPDATE "User" SET "minutesUsed" = MAX(0, "minutesUsed" - ${minutes}) WHERE "id" = ${userId}`;
}
