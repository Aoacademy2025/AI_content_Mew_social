import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { apiError } from "@/lib/api-error";
import { extendVideoExpiryForPlan } from "@/lib/plan-helpers";
import { FOUNDING_CODE } from "@/lib/founding";
import { redeemGrantCoupon } from "@/lib/grant-coupon-redemption";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { code } = await req.json();
    if (!code?.trim()) return NextResponse.json({ error: "กรุณากรอกรหัสคูปอง" }, { status: 400 });
    if (code.trim().toUpperCase() === FOUNDING_CODE)
      return NextResponse.json({ error: "โค้ดนี้ใช้อัตโนมัติที่หน้าราคา — ไม่ต้องกรอก" }, { status: 400 });

    const result = await redeemGrantCoupon({ userId: authUser.id, code });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.message, code: result.code },
        { status: result.code === "NOT_FOUND" ? 404 : 400 },
      );
    }

    const extended = result.outcome === "ACTIVATED"
      ? await extendVideoExpiryForPlan(authUser.id, result.effectivePlan)
      : 0;
    return NextResponse.json({
      ok: true,
      plan: result.effectivePlan,
      outcome: result.outcome,
      entitlementStartsAt: result.entitlementStartsAt,
      entitlementExpiresAt: result.entitlementExpiresAt,
      minutesLimit: result.minutesLimit,
      monthlyCredits: result.monthlyCredits,
      promoCredits: result.promoCredits,
      billingChanged: false,
      message: result.message,
      videosExtended: extended,
    });
  } catch (error) {
    return apiError({ route: "POST /api/coupons/redeem", error });
  }
}
