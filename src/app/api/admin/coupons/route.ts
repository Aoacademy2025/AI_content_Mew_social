import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

function isAdmin(u: { role?: string } | null) {
  return u?.role === "ADMIN";
}

// GET — list all coupons
export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isAdmin(authUser)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const coupons = await prisma.coupon.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { redemptions: true } } },
    });
    return NextResponse.json(coupons);
  } catch (error) {
    return apiError({ route: "GET /api/admin/coupons", error });
  }
}

// POST — create coupon
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isAdmin(authUser)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { code, plan = "PRO", durationDays = 30, maxUses = 1, expiresAt,
      type = "GRANT", percentOff, discountDuration } = await req.json();
    if (!code?.trim()) return NextResponse.json({ error: "กรุณากรอกรหัสคูปอง" }, { status: 400 });
    if (!["GRANT", "DISCOUNT"].includes(type)) return NextResponse.json({ error: "type ไม่ถูกต้อง" }, { status: 400 });

    const normCode = code.trim().toUpperCase();
    let stripeCouponId: string | null = null;
    let stripePromotionCodeId: string | null = null;

    if (type === "DISCOUNT") {
      const pct = Number(percentOff);
      if (!Number.isInteger(pct) || pct < 1 || pct > 100)
        return NextResponse.json({ error: "percentOff ต้องเป็น 1-100" }, { status: 400 });
      if (!["once", "forever"].includes(discountDuration))
        return NextResponse.json({ error: "discountDuration ต้องเป็น once หรือ forever" }, { status: 400 });

      const { ensureStripeConfig } = await import("@/lib/load-stripe-config");
      const { stripe } = await import("@/lib/stripe");
      await ensureStripeConfig();
      const sc = await stripe.coupons.create({ percent_off: pct, duration: discountDuration as "once" | "forever", name: normCode });
      const promo = await stripe.promotionCodes.create({
        promotion: { type: "coupon", coupon: sc.id },
        code: normCode,
        ...(Number(maxUses) > 0 ? { max_redemptions: Number(maxUses) } : {}),
        ...(expiresAt ? { expires_at: Math.floor(new Date(expiresAt).getTime() / 1000) } : {}),
      });
      stripeCouponId = sc.id;
      stripePromotionCodeId = promo.id;
    } else if (!["FREE", "PRO", "BUSINESS"].includes(plan)) {
      return NextResponse.json({ error: `Invalid plan: ${plan}` }, { status: 400 });
    }

    const coupon = await prisma.coupon.create({
      data: {
        code: normCode,
        plan: type === "DISCOUNT" ? "PRO" : plan,
        durationDays: Number(durationDays),
        maxUses: Number(maxUses),
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        type,
        percentOff: type === "DISCOUNT" ? Number(percentOff) : null,
        discountDuration: type === "DISCOUNT" ? discountDuration : null,
        stripeCouponId,
        stripePromotionCodeId,
      },
    });
    return NextResponse.json(coupon);
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "P2002")
      return NextResponse.json({ error: "รหัสคูปองนี้มีอยู่แล้ว" }, { status: 400 });
    return apiError({ route: "POST /api/admin/coupons", error });
  }
}

// DELETE — delete coupon by id
export async function DELETE(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isAdmin(authUser)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    await prisma.coupon.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError({ route: "DELETE /api/admin/coupons", error });
  }
}
