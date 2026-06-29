import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { extendVideoExpiryForPlan } from "@/lib/plan-helpers";
import { FOUNDING_CODE } from "@/lib/founding";
import { usageWindowForPlan } from "@/lib/usage-limits";

export const runtime = "nodejs";

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
      include: { redemptions: { where: { userId: authUser.id } } },
    });

    if (!coupon) return NextResponse.json({ error: "รหัสคูปองไม่ถูกต้อง" }, { status: 404 });
    if (coupon.expiresAt && coupon.expiresAt < new Date())
      return NextResponse.json({ error: "คูปองหมดอายุแล้ว" }, { status: 400 });
    if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses)
      return NextResponse.json({ error: "คูปองถูกใช้ครบจำนวนแล้ว" }, { status: 400 });
    if (coupon.redemptions.length > 0)
      return NextResponse.json({ error: "คุณเคยใช้คูปองนี้แล้ว" }, { status: 400 });

    // Calculate plan expiry
    const now = new Date();
    const planExpiresAt = coupon.durationDays > 0
      ? new Date(now.getTime() + coupon.durationDays * 24 * 60 * 60 * 1000)
      : null;

    // Atomic cap claim FIRST (race-safe — mirrors founding claimSeat). The check above is a
    // fast-path; this conditional updateMany is the real guard so two concurrent redeemers at
    // usedCount === maxUses-1 can't both pass and push usedCount past maxUses.
    if (coupon.maxUses > 0) {
      const claim = await prisma.coupon.updateMany({
        where: { id: coupon.id, usedCount: { lt: coupon.maxUses } },
        data: { usedCount: { increment: 1 } },
      });
      if (claim.count !== 1)
        return NextResponse.json({ error: "คูปองถูกใช้ครบจำนวนแล้ว" }, { status: 400 });
    } else {
      await prisma.coupon.update({ where: { id: coupon.id }, data: { usedCount: { increment: 1 } } });
    }

    // Record the redemption (unique-guarded on [couponId,userId]) + grant the plan. If a
    // concurrent same-user request already inserted the redemption, roll back the seat we claimed.
    try {
      await prisma.$transaction([
        prisma.couponRedemption.create({
          data: { couponId: coupon.id, userId: authUser.id },
        }),
        prisma.user.update({
          where: { id: authUser.id },
          data: {
            plan: coupon.plan,
            planExpiresAt,
            trialEndsAt: null, // redeeming supersedes any running trial
            ...usageWindowForPlan(coupon.plan, now),
          },
        }),
      ]);
    } catch {
      await prisma.coupon.update({ where: { id: coupon.id }, data: { usedCount: { decrement: 1 } } }).catch(() => {});
      return NextResponse.json({ error: "คุณเคยใช้คูปองนี้แล้ว" }, { status: 400 });
    }

    // Extend retention of existing (non-expired) videos to match new plan
    const extended = await extendVideoExpiryForPlan(authUser.id, coupon.plan);

    const msg = coupon.durationDays > 0
      ? `อัปเกรดเป็น ${coupon.plan} สำเร็จ! (${coupon.durationDays} วัน)`
      : `อัปเกรดเป็น ${coupon.plan} สำเร็จ! (ถาวร)`;

    return NextResponse.json({ ok: true, plan: coupon.plan, message: msg, videosExtended: extended });
  } catch (error) {
    return apiError({ route: "POST /api/coupons/redeem", error });
  }
}
