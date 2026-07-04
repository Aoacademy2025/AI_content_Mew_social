import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { FREE_LIMITS, isPaid as isPaidPlan } from "@/lib/plan-limits";
import { apiError } from "@/lib/api-error";

export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = authUser.id;

    const [user, styleCount, contentCount, videoCount, recentContents, recentVideos] =
      await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: {
            plan: true,
            planExpiresAt: true,
          },
        }),
        prisma.style.count({ where: { userId } }),
        prisma.content.count({ where: { userId } }),
        prisma.video.count({ where: { userId } }),
        prisma.content.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, headline: true, createdAt: true, language: true },
        }),
        prisma.video.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, status: true, createdAt: true, avatarModel: true, script: true, content: { select: { headline: true } } },
        }),
      ]);

    const plan = user?.plan ?? "FREE";
    const isPaid = isPaidPlan(plan);

    let proExpiresAt: string | null = null;
    if (isPaid) {
      // Prefer authoritative planExpiresAt (set by Stripe webhook or admin)
      if (user?.planExpiresAt) {
        proExpiresAt = user.planExpiresAt.toISOString();
      }
    }

    return NextResponse.json({
      plan,
      proExpiresAt,
      styleCount,
      contentCount,
      videoCount,
      limits: isPaid
        ? { styles: null, contents: null, images: null }
        : { styles: FREE_LIMITS.styles, contents: FREE_LIMITS.contents, images: null },
      recentContents,
      recentVideos,
    });
  } catch (error) {
    return apiError({ route: "user/stats", error });
  }
}
