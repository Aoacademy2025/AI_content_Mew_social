import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

// Validates a coupon WITHOUT redeeming/granting. Used to preview a DISCOUNT before checkout.
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { code } = await req.json();
    if (!code?.trim()) return NextResponse.json({ error: "กรุณากรอกรหัสคูปอง" }, { status: 400 });

    const coupon = await prisma.coupon.findUnique({
      where: { code: code.trim().toUpperCase() },
      include: { redemptions: { where: { userId: authUser.id } } },
    });
    if (!coupon) return NextResponse.json({ error: "รหัสคูปองไม่ถูกต้อง" }, { status: 404 });
    if (coupon.expiresAt && coupon.expiresAt < new Date())
      return NextResponse.json({ error: "คูปองหมดอายุแล้ว" }, { status: 400 });
    if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses)
      return NextResponse.json({ error: "คูปองถูกใช้ครบจำนวนแล้ว" }, { status: 400 });
    if (coupon.redemptions.length > 0)
      return NextResponse.json({ error: "คุณเคยใช้คูปองนี้แล้ว" }, { status: 400 });

    return NextResponse.json({
      code: coupon.code,
      type: coupon.type,
      plan: coupon.plan,
      percentOff: coupon.percentOff,
      discountDuration: coupon.discountDuration,
      durationDays: coupon.durationDays,
    });
  } catch (error) {
    return apiError({ route: "POST /api/coupons/validate", error });
  }
}
