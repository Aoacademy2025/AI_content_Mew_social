import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { code } = await req.json();
    if (!code?.trim()) return NextResponse.json({ error: "กรุณากรอกรหัสคูปอง" }, { status: 400 });

    const coupon = await prisma.coupon.findUnique({
      where: { code: code.trim().toUpperCase() },
      include: { redemptions: { where: { userId: session.user.id } } },
    });

    if (!coupon) return NextResponse.json({ error: "รหัสคูปองไม่ถูกต้อง" }, { status: 404 });
    if (coupon.expiresAt && coupon.expiresAt < new Date())
      return NextResponse.json({ error: "คูปองหมดอายุแล้ว" }, { status: 400 });
    if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses)
      return NextResponse.json({ error: "คูปองถูกใช้ครบจำนวนแล้ว" }, { status: 400 });
    if (coupon.redemptions.length > 0)
      return NextResponse.json({ error: "คุณเคยใช้คูปองนี้แล้ว" }, { status: 400 });

    // Calculate plan expiry
    const planExpiresAt = coupon.durationDays > 0
      ? new Date(Date.now() + coupon.durationDays * 24 * 60 * 60 * 1000)
      : null;

    await prisma.$transaction([
      prisma.couponRedemption.create({
        data: { couponId: coupon.id, userId: session.user.id },
      }),
      prisma.coupon.update({
        where: { id: coupon.id },
        data: { usedCount: { increment: 1 } },
      }),
      prisma.user.update({
        where: { id: session.user.id },
        data: {
          plan: coupon.plan,
          ...(planExpiresAt ? {} : {}), // permanent if durationDays=0
        },
      }),
    ]);

    const msg = coupon.durationDays > 0
      ? `อัปเกรดเป็น ${coupon.plan} สำเร็จ! (${coupon.durationDays} วัน)`
      : `อัปเกรดเป็น ${coupon.plan} สำเร็จ! (ถาวร)`;

    return NextResponse.json({ ok: true, plan: coupon.plan, message: msg });
  } catch (error) {
    return apiError({ route: "POST /api/coupons/redeem", error });
  }
}
