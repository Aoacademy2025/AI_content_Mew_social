import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { FOUNDING_CODE } from "@/lib/founding";
import { previewGrantCoupon } from "@/lib/grant-coupon-redemption";

export const runtime = "nodejs";

// Validates a coupon WITHOUT redeeming/granting. Used to preview a DISCOUNT before checkout.
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { code } = await req.json();
    if (!code?.trim()) return NextResponse.json({ error: "กรุณากรอกรหัสคูปอง" }, { status: 400 });
    if (code.trim().toUpperCase() === FOUNDING_CODE)
      return NextResponse.json({ error: "โค้ดนี้ใช้อัตโนมัติที่หน้าราคา — ไม่ต้องกรอก" }, { status: 400 });

    const coupon = await prisma.coupon.findUnique({
      where: { code: code.trim().toUpperCase() },
    });
    if (!coupon) return NextResponse.json({ error: "รหัสคูปองไม่ถูกต้อง" }, { status: 404 });
    if (!coupon.isActive) return NextResponse.json({ error: "คูปองนี้ถูกปิดใช้งานแล้ว" }, { status: 400 });
    if (coupon.expiresAt && coupon.expiresAt < new Date())
      return NextResponse.json({ error: "คูปองหมดอายุแล้ว" }, { status: 400 });
    if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses)
      return NextResponse.json({ error: "คูปองถูกใช้ครบจำนวนแล้ว" }, { status: 400 });
    if (coupon.type === "GRANT") {
      const preview = await previewGrantCoupon({ userId: authUser.id, code: coupon.code });
      if (!preview.ok) {
        return NextResponse.json(
          { error: preview.message, code: preview.code },
          { status: preview.code === "NOT_FOUND" ? 404 : 400 },
        );
      }
      return NextResponse.json({
        code: coupon.code,
        type: coupon.type,
        plan: coupon.plan,
        durationDays: coupon.durationDays,
        outcome: preview.outcome,
        entitlementStartsAt: preview.entitlementStartsAt,
        entitlementExpiresAt: preview.entitlementExpiresAt,
        minutesLimit: preview.minutesLimit,
        monthlyCredits: preview.monthlyCredits,
        promoCredits: preview.promoCredits,
        billingChanged: false,
        message: preview.message,
      });
    }

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
