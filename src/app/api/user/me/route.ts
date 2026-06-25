import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { limitsForPlan } from "@/lib/plan-limits";
import { syncUsageWindow } from "@/lib/usage-limits";
import { classifyEntitlement } from "@/lib/entitlements";

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
      } as any,
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const limits = limitsForPlan((user as any).plan ?? "FREE");
    const usage = await syncUsageWindow(authUser.id);
    return NextResponse.json({
      ...user,
      effectivePlan: classifyEntitlement(authUser).effectivePlan,
      usageCount: usage?.usageCount ?? user.usageCount,
      usageLimit: usage?.usageLimit ?? limits.clips,
      usagePeriodStartedAt: usage?.usagePeriodStartedAt ?? (user as any).usagePeriodStartedAt,
      usageResetAt: usage?.resetAt ?? null,
      ...(process.env.MINUTE_QUOTA === "1" ? { minuteQuota: true } : {}),
    });
  } catch (error) {
    return apiError({ route: "user/me", error });
  }
}
