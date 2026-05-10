import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { FREE_LIMITS } from "@/lib/plan-limits";
import { apiError } from "@/lib/api-error";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;

    const [user, styleCount, contentCount, videoCount, recentContents, recentVideos] =
      await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: {
            plan: true,
            couponRedemptions: {
              orderBy: { redeemedAt: "desc" },
              take: 1,
              select: { redeemedAt: true, coupon: { select: { durationDays: true } } },
            },
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
          select: { id: true, status: true, createdAt: true, avatarModel: true, content: { select: { headline: true } } },
        }),
      ]);

    const plan = user?.plan ?? "FREE";
    const isPaid = plan === "PRO";

    let proExpiresAt: string | null = null;
    if (isPaid && user?.couponRedemptions?.length) {
      const r = user.couponRedemptions[0];
      if (r.coupon.durationDays > 0) {
        const exp = new Date(r.redeemedAt);
        exp.setDate(exp.getDate() + r.coupon.durationDays);
        proExpiresAt = exp.toISOString();
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
