import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { stripe, PLANS, PlanKey, BillingPeriod, resolvePrice } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { ensureStripeConfig } from "@/lib/load-stripe-config";
import { claimSeat, attachReservation, releaseUnattachedSeat } from "@/lib/founding";

export async function POST(req: Request) {
  try {
    await ensureStripeConfig();
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const userId = authUser.id;

    // period: "monthly" | "annual" (default annual) · method: "card" | "promptpay" (default card)
    const { plan, period = "annual", method = "card", couponCode } =
      await req.json() as { plan: PlanKey; period?: BillingPeriod; method?: "card" | "promptpay"; couponCode?: string };

    const planConfig = PLANS[plan];
    if (!planConfig) return NextResponse.json({ error: "Invalid plan" }, { status: 400 });

    const priceCfg = resolvePrice(plan, period, method);
    if (!priceCfg.priceId) return NextResponse.json({ error: "Stripe price not configured" }, { status: 500 });
    const isSub = priceCfg.recurring; // card monthly/annual → subscription · PromptPay annual → one-time

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true, stripeCustomerId: true },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    // ── Ensure a Stripe Customer (needed for subscriptions + billing portal) ──
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email ?? undefined, metadata: { userId } });
      customerId = customer.id;
      await prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
    }

    // ── Cancel any leftover pending one-time payments for this user ──
    await prisma.payment.updateMany({
      where: { userId, status: "PENDING" },
      data: { status: "FAILED" },
    });

    // Resolve an optional DISCOUNT coupon (ignored if invalid — never block the purchase)
    let discountCoupon: { id: string; stripePromotionCodeId: string } | null = null;
    if (couponCode?.trim()) {
      const c = await prisma.coupon.findUnique({
        where: { code: couponCode.trim().toUpperCase() },
        include: { redemptions: { where: { userId } } },
      });
      const usable = c && c.type === "DISCOUNT" && c.stripePromotionCodeId
        && (!c.expiresAt || c.expiresAt >= new Date())
        && (c.maxUses <= 0 || c.usedCount < c.maxUses)
        && c.redemptions.length === 0;
      if (usable && c?.stripePromotionCodeId) discountCoupon = { id: c.id, stripePromotionCodeId: c.stripePromotionCodeId };
    }

    // ── Founding-100 auto-apply: annual only, only when no manual discount was applied ──
    let foundingClaim: { couponId: string; stripePromotionCodeId: string } | null = null;
    if (!discountCoupon && period === "annual") {
      foundingClaim = await claimSeat(userId); // null if sold out / already a founding member
    }

    // The promotion code + coupon id actually applied (manual discount takes precedence over founding)
    const appliedPromotionCode = discountCoupon?.stripePromotionCodeId ?? foundingClaim?.stripePromotionCodeId ?? null;
    const appliedCouponId = discountCoupon?.id ?? foundingClaim?.couponId ?? null;
    const isFounding = !!foundingClaim;

    const origin = req.headers.get("origin") ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000";

    let checkoutSession;
    try {
      checkoutSession = await stripe.checkout.sessions.create({
        mode: isSub ? "subscription" : "payment",
        customer: customerId,
        payment_method_types: method === "promptpay" ? ["promptpay"] : ["card"],
        line_items: [{ price: priceCfg.priceId, quantity: 1 }],
        ...(appliedPromotionCode ? { discounts: [{ promotion_code: appliedPromotionCode }] } : {}),
        metadata: {
          userId, plan, period, periodDays: String(priceCfg.periodDays), method,
          ...(appliedCouponId ? { couponId: appliedCouponId } : {}),
          ...(isFounding ? { founding: "1" } : {}),
        },
        ...(isSub
          ? {
              subscription_data: { metadata: { userId, plan, period } },
              // bound how long a founding seat is held even for subscription sessions
              ...(isFounding ? { expires_at: Math.floor(Date.now() / 1000) + 30 * 60 } : {}),
            }
          : { expires_at: Math.floor(Date.now() / 1000) + 30 * 60 }), // one-time session expires in 30 min
        success_url: `${origin}/settings?tab=billing&payment=success`,
        cancel_url: `${origin}/pricing?payment=cancelled`,
      });
    } catch (e) {
      // Stripe failed AFTER we claimed a seat but BEFORE a reservation row exists → roll the seat back
      if (foundingClaim) await releaseUnattachedSeat(foundingClaim.couponId).catch(() => {});
      throw e;
    }

    // Record the reservation now that we have the session id (so it can be confirmed/released later).
    // If this write fails the seat would otherwise leak (counted, but no row for the sweep to find) → roll it back.
    if (foundingClaim) {
      try {
        await attachReservation(userId, checkoutSession.id);
      } catch (e) {
        await releaseUnattachedSeat(foundingClaim.couponId).catch(() => {});
        throw e;
      }
    }

    await prisma.payment.create({
      data: {
        userId,
        stripeSessionId: checkoutSession.id,
        plan: plan as any,
        // satang: monthly = thb*100, annual ≈ thb*1000 (10 months). Informational only — real charge is the Stripe price.
        amount: planConfig.thb * (period === "annual" ? 1000 : 100),
        currency: "thb",
        status: "PENDING",
        periodDays: priceCfg.periodDays,
      },
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    return apiError({ route: "POST /api/payments/checkout", error });
  }
}
