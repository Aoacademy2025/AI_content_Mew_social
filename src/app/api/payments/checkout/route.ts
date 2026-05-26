import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { stripe, PLANS, PlanKey } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { ensureStripeConfig } from "@/lib/load-stripe-config";

// Reuse a pending session if created within this window (Stripe sessions expire after 24h)
const PENDING_REUSE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function POST(req: Request) {
  try {
    await ensureStripeConfig();
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { plan } = await req.json() as { plan: PlanKey };
    const planConfig = PLANS[plan];
    if (!planConfig) return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
    if (!planConfig.priceId) return NextResponse.json({ error: "Stripe price not configured" }, { status: 500 });

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { email: true, name: true },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const userId = authUser.id;
    const now = new Date();
    const reuseAfter = new Date(now.getTime() - PENDING_REUSE_WINDOW_MS);

    // ── Step 1: Try to reuse an existing PENDING for the same plan ─────────
    const existingPending = await prisma.payment.findFirst({
      where: {
        userId,
        plan: plan as any,
        status: "PENDING",
        createdAt: { gte: reuseAfter },
      },
      orderBy: { createdAt: "desc" },
    });

    if (existingPending) {
      try {
        const existingSession = await stripe.checkout.sessions.retrieve(existingPending.stripeSessionId);
        if (existingSession.url && existingSession.status === "open") {
          // ── Step 2: Cancel OTHER pending payments (different plan) ───────
          await prisma.payment.updateMany({
            where: {
              userId,
              status: "PENDING",
              id: { not: existingPending.id },
            },
            data: { status: "FAILED" },
          });
          console.log(`[checkout] Reusing existing PENDING ${existingPending.id} for ${plan}`);
          return NextResponse.json({ url: existingSession.url, reused: true });
        }
        // Session expired/completed on Stripe side — mark our record and create new
        await prisma.payment.update({
          where: { id: existingPending.id },
          data: { status: "FAILED" },
        });
      } catch {
        // Stripe retrieval failed → treat as stale, mark failed and create new
        await prisma.payment.update({
          where: { id: existingPending.id },
          data: { status: "FAILED" },
        });
      }
    }

    // ── Step 3: Cancel ALL other pending payments for this user (different plan) ──
    await prisma.payment.updateMany({
      where: { userId, status: "PENDING" },
      data: { status: "FAILED" },
    });

    // ── Step 4: Create new Stripe session + Payment record ─────────────────
    const origin = req.headers.get("origin") ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000";

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: user.email ?? undefined,
      line_items: [{ price: planConfig.priceId, quantity: 1 }],
      metadata: {
        userId,
        plan,
        periodDays: String(planConfig.periodDays),
      },
      success_url: `${origin}/settings?tab=billing&payment=success`,
      cancel_url: `${origin}/pricing?payment=cancelled`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60, // expire in 30 minutes (Stripe min)
    });

    await prisma.payment.create({
      data: {
        userId,
        stripeSessionId: checkoutSession.id,
        plan: plan as any,
        amount: planConfig.thb * 100,
        currency: "thb",
        status: "PENDING",
        periodDays: planConfig.periodDays,
      },
    });

    return NextResponse.json({ url: checkoutSession.url, reused: false });
  } catch (error) {
    return apiError({ route: "POST /api/payments/checkout", error });
  }
}
