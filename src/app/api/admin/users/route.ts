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

    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        plan: true,
        planExpiresAt: true,
        suspended: true,
        createdAt: true,
        _count: {
          select: { styles: true, contents: true, videos: true, images: true, supportTickets: true },
        },
        couponRedemptions: {
          select: { coupon: { select: { code: true, durationDays: true, plan: true, type: true } }, redeemedAt: true },
          orderBy: { redeemedAt: "desc" },
          take: 3,
        },
        administratorGrants: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
      },
    });

    return NextResponse.json(users);
  } catch (error) {
    return apiError({ route: "admin/users", error });
  }
}
