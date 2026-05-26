import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { PLANS, PlanKey } from "@/lib/stripe";
import { createNotification } from "@/lib/notifications";
import { extendVideoExpiryForPlan } from "@/lib/plan-helpers";
import { ensureStripeConfig } from "@/lib/load-stripe-config";

export const config = { api: { bodyParser: false } };

// Stripe requires raw body for signature verification
export async function POST(req: Request) {
  await ensureStripeConfig();
  const body = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";

  let event: ReturnType<typeof stripe.webhooks.constructEvent>;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (e: any) {
    console.error("[stripe-webhook] Signature verification failed:", e.message);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as any;
    const { userId, plan, periodDays } = session.metadata ?? {};

    if (!userId || !plan) {
      console.error("[stripe-webhook] Missing metadata");
      return NextResponse.json({ ok: true });
    }

    const days = parseInt(periodDays ?? "30", 10);
    const planConfig = PLANS[plan as PlanKey];

    // Extend planExpiresAt from now or from current expiry (whichever is later)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { planExpiresAt: true },
    });

    const base = user?.planExpiresAt && user.planExpiresAt > new Date() ? user.planExpiresAt : new Date();
    const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

    await prisma.user.update({
      where: { id: userId },
      data: {
        plan: plan as any,
        planExpiresAt: newExpiry,
        usageCount: 0,
        usageLimit: planConfig?.clips ?? 100,
      },
    });

    // Extend retention of existing videos to match the new plan
    await extendVideoExpiryForPlan(userId, plan).catch(err => {
      console.error("[stripe-webhook] extendVideoExpiryForPlan failed:", err);
    });

    await prisma.payment.update({
      where: { stripeSessionId: session.id },
      data: {
        status: "PAID",
        stripePaymentIntent: session.payment_intent ?? undefined,
        paidAt: new Date(),
      },
    });

    await createNotification({
      userId,
      type: "VIDEO_COMPLETED",
      title: `ชำระเงินสำเร็จ — ${plan} Plan`,
      body: `แพ็กเกจ ${plan} ของคุณใช้งานได้ถึง ${newExpiry.toLocaleDateString("th-TH")}`,
    });

    console.log(`[stripe-webhook] User ${userId} upgraded to ${plan} until ${newExpiry}`);
  }

  if (event.type === "checkout.session.expired") {
    const session = event.data.object as any;
    await prisma.payment.updateMany({
      where: { stripeSessionId: session.id },
      data: { status: "FAILED" },
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
