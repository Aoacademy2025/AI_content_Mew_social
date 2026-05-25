import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const payments = await prisma.payment.findMany({
      where: { userId: session.user.id },
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
