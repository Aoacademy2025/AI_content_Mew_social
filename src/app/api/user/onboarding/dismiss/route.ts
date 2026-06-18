import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export async function POST() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await prisma.user.update({ where: { id: authUser.id }, data: { onboardingDismissedAt: new Date() } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError({ route: "user/onboarding/dismiss", error });
  }
}
