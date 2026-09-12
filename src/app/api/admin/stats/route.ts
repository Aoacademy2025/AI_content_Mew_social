import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { getRevenueCohorts } from "@/lib/revenue-cohorts";
import { bangkokWindowStart, startOfBangkokDay } from "@/lib/bangkok-day";

export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!authUser || authUser.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Business days are Asia/Bangkok days, not the server's. `TZ` is unset on the VPS, so
    // a server-clock midnight started "today" at 07:00 Bangkok — between Bangkok midnight and 07:00
    // this card reported yesterday's signups (audit A4 rows #8/#9). `bangkokWindowStart(now, 7)`
    // is also a TRUE seven days: the old `now − 7d` then floor spanned eight calendar days.
    const now = new Date();
    const todayStart = startOfBangkokDay(now);
    const weekStart = bangkokWindowStart(now, 7);

    const [
      totalUsers,
      paidUsers,
      suspendedUsers,
      totalContents,
      totalVideos,
      totalImages,
      newToday,
      newThisWeek,
      cohorts,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { plan: { in: ["PRO", "BUSINESS"] } } }),
      prisma.user.count({ where: { suspended: true } }),
      prisma.content.count(),
      prisma.video.count(),
      prisma.generatedImage.count(),
      prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.user.count({ where: { createdAt: { gte: weekStart } } }),
      // Honest revenue split: cash-paying vs trial vs comped (see src/lib/revenue-cohorts.ts).
      // `paidUsers` (plan ∈ PRO/BUSINESS) conflates all three, so we surface them separately.
      getRevenueCohorts(),
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
      // Honest revenue cohorts — added alongside (not replacing) the legacy fields above.
      payingTotal: cohorts.payingTotal,
      directPayingTotal: cohorts.directPayingTotal,
      bundleActive: cohorts.bundleActive,
      trialActive: cohorts.trialActive,
      compedPaid: cohorts.compedPaid,
      mrr: cohorts.mrr,
      directMrr: cohorts.directMrr,
      bundleMrr: cohorts.bundleMrr,
      lapsedPayers: cohorts.lapsedPayers,
      payingCanceling: cohorts.payingCanceling,
      mrrAtRisk: cohorts.mrrAtRisk,
    });
  } catch (error) {
    return apiError({ route: "admin/stats", error });
  }
}
