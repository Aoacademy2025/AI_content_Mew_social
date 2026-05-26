import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!authUser || authUser.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);
    weekStart.setHours(0, 0, 0, 0);

    const [
      totalUsers,
      paidUsers,
      suspendedUsers,
      totalContents,
      totalVideos,
      totalImages,
      newToday,
      newThisWeek,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { plan: "PRO" } }),
      prisma.user.count({ where: { suspended: true } }),
      prisma.content.count(),
      prisma.video.count(),
      prisma.generatedImage.count(),
      prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.user.count({ where: { createdAt: { gte: weekStart } } }),
    ]);

    return NextResponse.json({
      totalUsers,
      freeUsers: totalUsers - paidUsers,
      paidUsers,
      suspendedUsers,
      totalContents,
      totalVideos,
      totalImages,
      newToday,
      newThisWeek,
    });
  } catch (error) {
    return apiError({ route: "admin/stats", error });
  }
}
