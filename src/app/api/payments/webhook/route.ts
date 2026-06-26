import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { extendVideoExpiryForPlan } from "@/lib/plan-helpers";
import { ensureStripeConfig } from "@/lib/load-stripe-config";
import { confirmSeat, releaseSeat } from "@/lib/founding";
import { usageWindowForPlan } from "@/lib/usage-limits";
import { grantCreditsOnce, ensureMonthlyGrant } from "@/lib/credits";

export const config = { api: { bodyParser: false } };

/** Set/extend a user's plan access. planExpiresAt extends from the later of now or current expiry,
 *  EXCEPT when the current expiry is just an unconverted trial end — then we measure from now so a
 *  mid-trial buyer doesn't get the leftover trial days gifted on top of the purchased term. */
async function activatePlan(userId: string, plan: string, periodDays: number) {
  const now = new Date();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { planExpiresAt: true, trialEndsAt: true, subStatus: true },
  });
  const onUnconvertedTrial = !!user?.trialEndsAt && user.trialEndsAt > now && user.subStatus !== "active";
  const base = (!onUnconvertedTrial && user?.planExpiresAt && user.planExpiresAt > now) ? user.planExpiresAt : now;
  const newExpiry = new Date(base.getTime() + periodDays * 24 * 60 * 60 * 1000);
  await prisma.user.update({
    where: { id: userId },
    data: { plan: plan as any, planExpiresAt: newExpiry, ...usageWindowForPlan(plan, now), trialEndsAt: null },
  });
  await extendVideoExpiryForPlan(userId, plan).catch(err => console.error("[webhook] extendVideoExpiry:", err));
  return newExpiry;
}

// Stripe moved invoice.subscription under parent.subscription_details in recent API versions — handle both.
function invoiceSubId(inv: any): string | null {
  return inv.subscription ?? inv.parent?.subscription_details?.subscription ?? null;
}

/** Process a finished Checkout session — credit pack OR plan. Shared by `checkout.session.completed`
 *  AND `checkout.session.async_payment_succeeded`: PromptPay / bank (delayed) methods fire `completed`
 *  while still unpaid and confirm later via the async event, so activation is gated on
 *  `payment_status === "paid"` and is idempotent (Payment-PAID belt + unique guards). */
async function handleCheckoutSession(s: any) {
  // ── Credit-pack purchase ──────────────────────────────────────────────
  if (s.metadata?.type === "credits" && s.metadata.userId) {
    if (process.env.CREDITS_LIVE !== "1") { console.log("[webhook] CREDITS_LIVE off — skipping credit grant for", s.id); return; }
    if (s.payment_status !== "paid") { console.warn("[webhook] credit session not yet paid, status:", s.payment_status, s.id); return; }
    const creditUser = await prisma.user.findUnique({ where: { id: s.metadata.userId }, select: { id: true } });
    if (!creditUser) { console.error("[webhook] credit grant: user not found", s.metadata.userId, s.id); return; }
    const credits = parseInt(s.metadata.credits ?? "0", 10);
    if (!credits || credits <= 0) { console.error("[webhook] bad credit metadata", s.id); return; }
    await grantCreditsOnce(s.metadata.userId, credits, "purchase", "pack:" + s.id)
      .catch((e) => console.error("[webhook] credit grant:", e));
    return;
  }

  // ── Plan purchase ─────────────────────────────────────────────────────
  const { userId, plan, period, periodDays } = s.metadata ?? {};
  if (!(userId && plan)) return;
  // Activate ONLY when truly paid — a PromptPay/bank one-time session fires `completed` while
  // unpaid/processing; the real confirmation arrives as async_payment_succeeded (payment_status=paid).
  if (s.payment_status !== "paid") {
    console.warn("[webhook] plan session not yet paid, status:", s.payment_status, s.id);
    return;
  }
  // Idempotency belt: if this session's Payment is already PAID we activated it before
  // (duplicate delivery / completed+async overlap) — do nothing.
  const existing = await prisma.payment.findUnique({ where: { stripeSessionId: s.id }, select: { status: true } });
  if (existing?.status === "PAID") { console.log("[webhook] session already activated, skip", s.id); return; }

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
  // CREDITS_LIVE-gated initial grant — fire-and-forget, flag-off = no-op
  if (process.env.CREDITS_LIVE === "1") {
    ensureMonthlyGrant(userId).catch(() => {});
  }
  console.log(`[stripe-webhook] ${userId} → ${plan} until ${newExpiry} (mode=${s.mode})`);
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

  // ── Idempotency: Stripe delivers events at least once. Claim this event.id atomically
  //    (unique PK); if the insert fails it's a duplicate/already-processed → skip. ──────
  try {
    await prisma.stripeWebhookEvent.create({ data: { id: event.id, type: event.type } });
  } catch {
    console.log("[stripe-webhook] duplicate event, skip", event.id);
    return NextResponse.json({ ok: true, duplicate: true });
  }

  // ── Checkout finished (sync) OR delayed payment confirmed (PromptPay/bank async) ─────
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    await handleCheckoutSession(event.data.object as any);
  }

  // ── Delayed payment failed → mark the pending payment failed + free any founding seat ─
  if (event.type === "checkout.session.async_payment_failed") {
    const s = event.data.object as any;
    await prisma.payment.updateMany({ where: { stripeSessionId: s.id }, data: { status: "FAILED" } }).catch(() => {});
    await releaseSeat(s.id).catch(() => {});
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
        // Refresh monthly credit grant on renewal (CREDITS_LIVE-gated, fire-and-forget)
        if (process.env.CREDITS_LIVE === "1") {
          ensureMonthlyGrant(user.id).catch(() => {});
        }
        console.log(`[stripe-webhook] renewed subscription for ${user.id} (+${days}d)`);
      }
    }
  }

  // ── Subscription canceled → mark canceled (access lapses at period end) ──
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as any;
    const user = await prisma.user.findFirst({ where: { stripeSubscriptionId: sub.id }, select: { id: true } });
    if (user) {
      // Also clear the scheduled-cancel flags — otherwise ReactivateBanner shows forever with a
      // past date and its "ใช้ PRO ต่อ" button 400s (no stripeSubscriptionId left to reactivate).
      await prisma.user.update({
        where: { id: user.id },
        data: { subStatus: "canceled", stripeSubscriptionId: null, cancelAtPeriodEnd: false, cancelAt: null },
      });
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
