import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user || (session.user as any).role !== "ADMIN") {
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
        suspended: true,
        createdAt: true,
        _count: {
          select: { styles: true, contents: true, videos: true, images: true, supportTickets: true },
        },
        couponRedemptions: {
          select: { coupon: { select: { code: true, durationDays: true } }, redeemedAt: true },
          orderBy: { redeemedAt: "desc" },
          take: 3,
        },
      },
    });

    return NextResponse.json(users);
  } catch (error) {
    return apiError({ route: "admin/users", error });
  }
}
