import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const payments = await prisma.payment.findMany({
      where: {
        userId: authUser.id,
        amount: { gt: 0 }, // ไม่แสดง admin-set plan หรือ coupon 100%
        // ซ่อน PENDING เก่าเกิน 24 ชั่วโมง (session หมดอายุ ไม่สามารถชำระได้แล้ว)
        OR: [
          { status: { not: "PENDING" } },
          { createdAt: { gte: oneDayAgo } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        plan: true,
        amount: true,
        currency: true,
        status: true,
        periodDays: true,
        createdAt: true,
        paidAt: true,
      },
    });

    return NextResponse.json(payments);
  } catch (error) {
    return apiError({ route: "GET /api/payments/history", error });
  }
}
