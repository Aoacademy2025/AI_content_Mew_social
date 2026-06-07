import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { extendVideoExpiryForPlan } from "@/lib/plan-helpers";
import { usageWindowForPlan } from "@/lib/usage-limits";

// POST /api/user/upgrade - Upgrade user from FREE to PRO plan
export async function POST() {
  try {
    const authUser = await getCurrentUser();

    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get current user
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { plan: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Check if already on PRO plan
    if (user.plan === "PRO") {
      return NextResponse.json(
        { message: "Already on Pro plan" },
        { status: 200 }
      );
    }

    // Update user plan to PRO + extend retention of existing videos
    await prisma.user.update({
      where: { id: authUser.id },
      data: { plan: "PRO", ...usageWindowForPlan("PRO") },
    });
    const extended = await extendVideoExpiryForPlan(authUser.id, "PRO");

    return NextResponse.json(
      { message: "Successfully upgraded to Pro plan", videosExtended: extended },
      { status: 200 }
    );
  } catch (error) {
    return apiError({ route: "user/upgrade", error });
  }
}
