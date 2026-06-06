import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { PLANS, PlanKey } from "@/lib/stripe";
import { createNotification } from "@/lib/notifications";
import { extendVideoExpiryForPlan } from "@/lib/plan-helpers";
import { ensureStripeConfig } from "@/lib/load-stripe-config";
import { confirmSeat, releaseSeat } from "@/lib/founding";

export const config = { api: { bodyParser: false } };

/** Set/extend a user's plan access. planExpiresAt extends from the later of now or current expiry. */
async function activatePlan(userId: string, plan: string, periodDays: number) {
  const planConfig = PLANS[plan as PlanKey];
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { planExpiresAt: true } });
  const base = user?.planExpiresAt && user.planExpiresAt > new Date() ? user.planExpiresAt : new Date();
  const newExpiry = new Date(base.getTime() + periodDays * 24 * 60 * 60 * 1000);
  await prisma.user.update({
    where: { id: userId },
    data: { plan: plan as any, planExpiresAt: newExpiry, usageCount: 0, usageLimit: planConfig?.clips ?? 100, trialEndsAt: null },
  });
  await extendVideoExpiryForPlan(userId, plan).catch(err => console.error("[webhook] extendVideoExpiry:", err));
  return newExpiry;
}

// Stripe moved invoice.subscription under parent.subscription_details in recent API versions — handle both.
function invoiceSubId(inv: any): string | null {
  return inv.subscription ?? inv.parent?.subscription_details?.subscription ?? null;
}

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

  // ── Checkout completed (one-time OR first subscription payment) ──────────
  if (event.type === "checkout.session.completed") {
    const s = event.data.object as any;
    const { userId, plan, period, periodDays } = s.metadata ?? {};
    if (userId && plan) {
      const newExpiry = await activatePlan(userId, plan, parseInt(periodDays ?? "30", 10));
      await prisma.user.update({
        where: { id: userId },
        data: {
          billingPeriod: period ?? null,
          ...(s.mode === "subscription" && s.subscription
            ? { stripeSubscriptionId: s.subscription, subStatus: "active" }
            : {}),
        },
      });
      await prisma.payment.update({
        where: { stripeSessionId: s.id },
        data: { status: "PAID", stripePaymentIntent: s.payment_intent ?? undefined, paidAt: new Date() },
      }).catch(() => {});
      await createNotification({
        userId, type: "VIDEO_COMPLETED",
        title: `ชำระเงินสำเร็จ — ${plan} Plan`,
        body: `แพ็กเกจ ${plan} ของคุณใช้งานได้ถึง ${newExpiry.toLocaleDateString("th-TH")}`,
      }).catch(() => {});
      const couponId = s.metadata?.couponId;
      if (couponId) {
        if (s.metadata?.founding === "1") {
          // Founding seat was already counted at reservation — just confirm it (no re-increment)
          await confirmSeat(s.id).catch(() => {});
          await prisma.couponRedemption.create({ data: { couponId, userId } }).catch(() => {});
          console.log(`[stripe-webhook] founding seat confirmed: ${userId} (coupon ${couponId})`);
        } else {
          try {
            await prisma.couponRedemption.create({ data: { couponId, userId } });
            await prisma.coupon.update({ where: { id: couponId }, data: { usedCount: { increment: 1 } } });
            console.log(`[stripe-webhook] coupon ${couponId} redeemed by ${userId}`);
          } catch { /* already recorded (unique guard) — webhook retry, ignore */ }
        }
      }
      console.log(`[stripe-webhook] ${userId} → ${plan} until ${newExpiry} (mode=${s.mode})`);
    }
  }

  // ── Subscription renewal (skip the very first invoice — handled above) ───
  if (event.type === "invoice.paid") {
    const inv = event.data.object as any;
    const subId = invoiceSubId(inv);
    if (subId && inv.billing_reason !== "subscription_create") {
      const user = await prisma.user.findFirst({
        where: { stripeSubscriptionId: subId },
        select: { id: true, plan: true, billingPeriod: true },
      });
      if (user) {
        const days = user.billingPeriod === "annual" ? 365 : 30;
        await activatePlan(user.id, user.plan, days);
        await prisma.user.update({ where: { id: user.id }, data: { subStatus: "active" } });
        console.log(`[stripe-webhook] renewed subscription for ${user.id} (+${days}d)`);
      }
    }
  }

  // ── Subscription canceled → mark canceled (access lapses at period end) ──
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as any;
    const user = await prisma.user.findFirst({ where: { stripeSubscriptionId: sub.id }, select: { id: true } });
    if (user) {
      await prisma.user.update({ where: { id: user.id }, data: { subStatus: "canceled", stripeSubscriptionId: null } });
    }
  }

  // ── Subscription updated → sync scheduled-cancel state (covers cancel AND resume) ──
  if (event.type === "customer.subscription.updated") {
    const sub = event.data.object as any;
    const user = await prisma.user.findFirst({
      where: { OR: [{ stripeSubscriptionId: sub.id }, { stripeCustomerId: sub.customer }] },
      select: { id: true },
    });
    if (user) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
          subStatus: sub.status,
        },
      });
      console.log(`[stripe-webhook] subscription.updated ${user.id} cancelAtPeriodEnd=${!!sub.cancel_at_period_end}`);
    } else {
      console.warn(`[stripe-webhook] subscription.updated: no user for sub ${sub.id}`);
    }
  }

  // ── Failed renewal → dunning ─────────────────────────────────────────────
  if (event.type === "invoice.payment_failed") {
    const inv = event.data.object as any;
    const subId = invoiceSubId(inv);
    if (subId) {
      const user = await prisma.user.findFirst({ where: { stripeSubscriptionId: subId }, select: { id: true } });
      if (user) {
        await prisma.user.update({ where: { id: user.id }, data: { subStatus: "past_due" } });
        await createNotification({
          userId: user.id, type: "VIDEO_COMPLETED",
          title: "ชำระเงินไม่สำเร็จ",
          body: "บัตรของคุณถูกปฏิเสธ — อัปเดตวิธีจ่ายเพื่อใช้งานต่อ",
        }).catch(() => {});
      }
    }
  }

  // ── Checkout expired → mark payment failed ───────────────────────────────
  if (event.type === "checkout.session.expired") {
    const s = event.data.object as any;
    await prisma.payment.updateMany({ where: { stripeSessionId: s.id }, data: { status: "FAILED" } }).catch(() => {});
    await releaseSeat(s.id).catch(() => {}); // free the founding seat if this was an unpaid founding checkout
  }

  return NextResponse.json({ ok: true });
}
