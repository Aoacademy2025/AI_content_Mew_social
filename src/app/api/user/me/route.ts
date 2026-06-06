import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { limitsForPlan } from "@/lib/plan-limits";

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
        avatar: true,
        cancelAtPeriodEnd: true,
        cancelAt: true,
      } as any,
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const limits = limitsForPlan((user as any).plan ?? "FREE");
    return NextResponse.json({ ...user, usageLimit: limits.clips });
  } catch (error) {
    return apiError({ route: "user/me", error });
  }
}
