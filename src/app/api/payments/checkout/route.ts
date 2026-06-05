import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { stripe, PLANS, PlanKey, BillingPeriod, resolvePrice } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { ensureStripeConfig } from "@/lib/load-stripe-config";

export async function POST(req: Request) {
  try {
    await ensureStripeConfig();
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const userId = authUser.id;

    // period: "monthly" | "annual" (default annual) · method: "card" | "promptpay" (default card)
    const { plan, period = "annual", method = "card" } =
      await req.json() as { plan: PlanKey; period?: BillingPeriod; method?: "card" | "promptpay" };

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

    const origin = req.headers.get("origin") ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000";

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: isSub ? "subscription" : "payment",
      customer: customerId,
      payment_method_types: method === "promptpay" ? ["promptpay"] : ["card"],
      line_items: [{ price: priceCfg.priceId, quantity: 1 }],
      metadata: { userId, plan, period, periodDays: String(priceCfg.periodDays), method },
      ...(isSub
        ? { subscription_data: { metadata: { userId, plan, period } } }
        : { expires_at: Math.floor(Date.now() / 1000) + 30 * 60 }), // one-time session expires in 30 min
      success_url: `${origin}/settings?tab=billing&payment=success`,
      cancel_url: `${origin}/pricing?payment=cancelled`,
    });

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
