import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/clerk-auth";
import { stripe, PLANS, PlanKey, BillingPeriod } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { ensureStripeConfig } from "@/lib/load-stripe-config";
import { resolveFoundingDiscount, attachReservation, releaseUnattachedSeat } from "@/lib/founding";
import { checkoutAllowed } from "@/lib/plan-change";
import { AFF_COOKIE, sanitizeRefCode } from "@/lib/affiliate-ref";
import { preserveTrialOnConvertEnabled, resolveTrialPreservation } from "@/lib/preserve-trial";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { promptpayMonthlyEnabled, promptpayMonthlyOffered } from "@/lib/promptpay-monthly";
import { buildCheckoutSessionParams, resolveCheckoutSelection } from "@/lib/checkout-session-params";

export async function POST(req: Request) {
  try {
    await ensureStripeConfig();
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const userId = authUser.id;

    // period: "monthly" | "annual" (default annual) · method: "card" | "promptpay" (default card)
    const { plan, period = "annual", method: rawMethod = "card", couponCode } =
      await req.json() as { plan: PlanKey; period?: BillingPeriod; method?: "card" | "promptpay"; couponCode?: string };

    const planConfig = PLANS[plan];
    if (!planConfig) return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
    if (period !== "monthly" && period !== "annual") {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }
    // PromptPay cannot back a recurring subscription. Monthly PromptPay is therefore a one-time
    // 30-day term (ADR 0066), sold only when offered (PROMPTPAY_MONTHLY=1 + that tier's price);
    // otherwise a monthly+promptpay request is coerced to card, exactly as before.
    const promptpayMonthly = promptpayMonthlyEnabled();
    const monthlyPromptpayOffered = await promptpayMonthlyOffered(plan);
    const { method, priceCfg, isSub } = resolveCheckoutSelection({
      plan, period, requestedMethod: rawMethod, monthlyPromptpayOffered,
    });
    if (!process.env.STRIPE_SECRET_KEY || !priceCfg.priceId) {
      return NextResponse.json({
        error: "Payment configuration is unavailable",
        code: "PAYMENT_NOT_CONFIGURED",
        userAction: "ระบบชำระเงินของหน้านี้ยังไม่พร้อม กรุณาแจ้งทีมงานเพื่อเปิดการชำระเงิน",
      }, { status: 503 });
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        name: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        plan: true,
        subStatus: true,
        trialEndsAt: true,
        planExpiresAt: true,
      },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const cashPayment = await prisma.payment.findFirst({
      where: { userId, status: "PAID", amount: { gt: 0 }, periodDays: { gt: 0 } },
      select: { id: true },
    });

    // ── Affiliate attribution (cookie wins, first-sign-in stamp is fallback) ──
    // buildCheckoutSessionParams turns the ref into session (+ subscription) metadata.
    let refCode: string | null = null;
    try {
      const jar = await cookies();
      refCode = sanitizeRefCode(jar.get(AFF_COOKIE)?.value);
    } catch {}
    refCode = refCode ?? authUser.affiliateRefCode ?? null;

    // ── Plan-change guard (defense-in-depth; the pricing UI is gated too) ──
    // Prevents the two ways the old equality-only UI could mis-charge:
    //  1. an active subscriber minting a SECOND Stripe subscription (any tier change → portal);
    //  2. a paid user paying to "upgrade" to a LOWER tier (downgrade-by-pay).
    // FREE users and trial users (no active sub) are unaffected — they upgrade normally.
    // #348: while PRESERVE_TRIAL_ON_CONVERT is on, a converted customer sits at
    // subStatus="trialing" until Stripe charges at trial end. That is still a live
    // subscription, so `active_sub` must block a SECOND one exactly as it does for
    // "active" — otherwise a mid-trial converter could mint a duplicate and be
    // double-billed. Flag off → the guard reads subStatus === "active" only.
    const now = new Date();
    const preserveTrial = preserveTrialOnConvertEnabled();
    const preservation = resolveTrialPreservation({
      trialEndsAt: user.trialEndsAt,
      subStatus: user.subStatus,
      recurring: isSub,
      now,
      enabled: preserveTrial,
    });

    const decision = checkoutAllowed(
      {
        plan: user.plan,
        subStatus: user.subStatus,
        stripeSubscriptionId: user.stripeSubscriptionId,
        trialEndsAt: user.trialEndsAt,
        planExpiresAt: user.planExpiresAt,
        hasQualifyingCashPayment: Boolean(cashPayment),
      },
      plan,
      now,
      { recurring: isSub, preserveTrialOnConvert: preserveTrial },
    );
    if (!decision.allowed) {
      const error = decision.reason === "active_sub"
        ? "คุณมีสมาชิกแบบต่ออัตโนมัติอยู่แล้ว — เปลี่ยนหรืออัปเกรดแผนได้ที่ การตั้งค่า → การเงิน"
        : decision.reason === "active_timed_plan"
          ? `แพ็กเกจปัจจุบันยังใช้ได้ถึง ${user.planExpiresAt?.toLocaleDateString("th-TH")} — เพื่อไม่ให้วันคงเหลือหาย กรุณาเริ่มสมาชิกแบบบัตรหลังวันดังกล่าว หรือต่ออายุแบบ PromptPay`
        : "ไม่สามารถปรับลดแผนทางนี้ได้ — จัดการแผนที่ การตั้งค่า → การเงิน";
      return NextResponse.json({ error, code: decision.reason.toUpperCase() }, { status: 400 });
    }

    // ── Ensure a Stripe Customer (needed for subscriptions + billing portal) ──
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email ?? undefined, metadata: { userId } });
      customerId = customer.id;
      await prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
    }

    // ── Cancel any leftover pending payments for this user ──
    // Expire the prior hosted Stripe sessions too (not just the DB rows) so a user with two open
    // tabs can't complete both and get double-charged / double-granted.
    const stalePending = await prisma.payment.findMany({
      where: { userId, status: "PENDING" },
      select: { stripeSessionId: true },
    });
    for (const p of stalePending) {
      await stripe.checkout.sessions.expire(p.stripeSessionId).catch(() => {}); // may already be expired/completed
    }
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
      const usable = c && c.isActive && c.type === "DISCOUNT" && c.stripePromotionCodeId
        && (!c.expiresAt || c.expiresAt >= new Date())
        && (c.maxUses <= 0 || c.usedCount < c.maxUses)
        && c.redemptions.length === 0;
      if (usable && c?.stripePromotionCodeId) discountCoupon = { id: c.id, stripePromotionCodeId: c.stripePromotionCodeId };
    }

    // ── Founding-100 auto-apply: annual only, only when no manual discount was applied ──
    // A confirmed member upgrading PRO → BUSINESS reuses their seat (HERO-61); everyone else claims one.
    const founding = await resolveFoundingDiscount({
      userId, currentPlan: user.plan, targetPlan: plan, period, hasManualDiscount: !!discountCoupon,
    });
    const foundingClaim = founding?.kind === "seat" ? founding : null;

    // The promotion code + coupon id actually applied (manual discount takes precedence over founding)
    const appliedPromotionCode = discountCoupon?.stripePromotionCodeId ?? founding?.stripePromotionCodeId ?? null;
    const appliedCouponId = discountCoupon?.id ?? founding?.couponId ?? null;
    const isFounding = !!foundingClaim;
    const isFoundingMemberUpgrade = founding?.kind === "member";

    // Never trust the caller-controlled Origin header for Stripe redirects.
    // Prefer the configured canonical app URL, then the server request URL.
    const origin = process.env.NEXTAUTH_URL?.replace(/\/$/, "") || new URL(req.url).origin;

    let checkoutSession;
    try {
      checkoutSession = await stripe.checkout.sessions.create(buildCheckoutSessionParams({
        plan,
        period,
        requestedMethod: rawMethod,
        monthlyPromptpayOffered,
        promptpayMonthlyEnabled: promptpayMonthly,
        userId,
        customerId,
        origin,
        appliedPromotionCode,
        appliedCouponId,
        isFounding,
        isFoundingMemberUpgrade,
        refCode,
        stripeTrialEnd: preservation.stripeTrialEnd,
        nowMs: Date.now(),
      }));
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
        plan,
        // satang: monthly = thb*100, annual ≈ thb*1000 (10 months). Informational only — real charge is the Stripe price.
        amount: planConfig.thb * (period === "annual" ? 1000 : 100),
        currency: "thb",
        status: "PENDING",
        periodDays: priceCfg.periodDays,
      },
    });

    // Telemetry item 12: the checkout funnel needs to know whether the customer
    // was mid-trial and whether those days actually survived. Fire-and-forget —
    // a telemetry failure must never lose a created checkout session.
    await recordTelemetryEvent(userId, {
      name: "checkout_started",
      source: "server",
      status: "started",
      properties: {
        plan,
        period,
        method,
        onTrial: preservation.onTrial,
        trialDaysLeft: preservation.trialDaysLeft,
        preserveTrial: preservation.preserved,
      },
    }).catch(() => {});

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    return apiError({ route: "POST /api/payments/checkout", error });
  }
}
