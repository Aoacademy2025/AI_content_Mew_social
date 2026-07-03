import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { limitsForPlan } from "@/lib/plan-limits";
import { syncUsageWindow } from "@/lib/usage-limits";
import { classifyEntitlement } from "@/lib/entitlements";
import { checkMinuteQuota } from "@/lib/minute-limits";

export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        plan: true,
        usageCount: true,
        usageLimit: true,
        usagePeriodStartedAt: true,
        avatar: true,
        cancelAtPeriodEnd: true,
        cancelAt: true,
        trialStartedAt: true,
        trialEndsAt: true,
        subStatus: true,
      } as any,
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const limits = limitsForPlan((user as any).plan ?? "FREE");
    const usage = await syncUsageWindow(authUser.id);
    let minuteFields: { minuteQuota: true; minutesUsed: number; minutesLimit: number } | Record<string, never> = {};
    if (process.env.MINUTE_QUOTA === "1") {
      const mq = await checkMinuteQuota(authUser.id);
      minuteFields = {
        minuteQuota: true,
        minutesUsed: mq.used,
        minutesLimit: mq.used + mq.remaining,
      };
    }
    // Managed-kie: is AI image generation un-gated for THIS user? True for paid
    // (PRO/BUSINESS) plans only when both flags are on. Admins always have access
    // (client mirrors already OR this with an isAdmin check), so this is the
    // paid-user signal specifically. Mirrors the server gate in fetch-stock.
    const kiePaidUnlocked =
      process.env.MANAGED_KIE === "1" &&
      process.env.CREDITS_LIVE === "1" &&
      ((user as any).plan === "PRO" || (user as any).plan === "BUSINESS");

    return NextResponse.json({
      ...user,
      effectivePlan: classifyEntitlement(authUser).effectivePlan,
      usageCount: usage?.usageCount ?? user.usageCount,
      usageLimit: usage?.usageLimit ?? limits.clips,
      usagePeriodStartedAt: usage?.usagePeriodStartedAt ?? (user as any).usagePeriodStartedAt,
      usageResetAt: usage?.resetAt ?? null,
      kiePaidUnlocked,
      ...minuteFields,
    });
  } catch (error) {
    return apiError({ route: "user/me", error });
  }
}
