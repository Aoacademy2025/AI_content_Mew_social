import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { createNotification, notifyAdmins } from "@/lib/notifications";
import { extendVideoExpiryForPlan } from "@/lib/plan-helpers";
import { ensureStripeConfig } from "@/lib/load-stripe-config";
import {
  confirmLatestSeatForUser,
  confirmSeat,
  getFoundingCoupon,
  releasePendingSeatForUser,
  releaseSeat,
} from "@/lib/founding";
import { usageWindowForPlan } from "@/lib/usage-limits";
import { grantCreditsOnce, ensureMonthlyGrant } from "@/lib/credits";
import { grantOnPaidActivation } from "@/lib/entitlements";
import {
  recurringPriceCatalogFromEnv,
  resolveRecurringEntitlement,
} from "@/lib/stripe-subscription-entitlement";
import { activatePaidCheckout, checkoutPaymentSettled } from "@/lib/checkout-plan-activation";
import {
  preserveTrialOnConvertEnabled,
  TRIAL_PRESERVED_PAYMENT_NOTE,
} from "@/lib/preserve-trial";
import { recordTelemetryEventOnce } from "@/lib/telemetry";

export const config = { api: { bodyParser: false } };

// Stripe moved invoice.subscription under parent.subscription_details in recent API versions — handle both.
/** Tags a Payment row created from a renewal invoice, so billing history and reporting can
 *  tell it apart from the initial checkout row. */
const RENEWAL_PAYMENT_NOTE = "renewal";

function invoiceSubId(inv: any): string | null {
  return inv.subscription ?? inv.parent?.subscription_details?.subscription ?? null;
}

/** Process a finished Checkout session — credit pack OR plan. Shared by `checkout.session.completed`
 *  AND `checkout.session.async_payment_succeeded`: PromptPay / bank (delayed) methods fire `completed`
 *  while still unpaid and confirm later via the async event, so activation is gated on
 *  `payment_status === "paid"` and is idempotent (Payment-PAID belt + unique guards). */
async function handleCheckoutSession(s: any, eventId: string) {
  // ── Credit-pack purchase ──────────────────────────────────────────────
  if (s.metadata?.type === "credits" && s.metadata.userId) {
    if (process.env.CREDITS_LIVE !== "1") { console.log("[webhook] CREDITS_LIVE off — skipping credit grant for", s.id); return; }
    if (s.payment_status !== "paid") { console.warn("[webhook] credit session not yet paid, status:", s.payment_status, s.id); return; }
    const creditUser = await prisma.user.findUnique({ where: { id: s.metadata.userId }, select: { id: true, plan: true } });
    if (!creditUser) { console.error("[webhook] credit grant: user not found", s.metadata.userId, s.id); return; }
    const credits = parseInt(s.metadata.credits ?? "0", 10);
    if (!credits || credits <= 0) { console.error("[webhook] bad credit metadata", s.id); return; }
    await grantCreditsOnce(s.metadata.userId, credits, "purchase", "pack:" + s.id)
      .catch((e) => console.error("[webhook] credit grant:", e));

    // MON-9: also log the cash as a Payment row so a credit-pack purchase shows up in
    // จ่ายจริง/MRR — src/lib/revenue-cohorts.ts treats ANY Payment{status:"PAID"} row for a user
    // as "has paid cash" (paidUserIds), independent of the Payment.plan/periodDays fields, which
    // are purely informational here (a credit pack has no plan/term — periodDays:0, plan:<user's
    // current plan> just for display). Deliberately OUTSIDE the plan-activation $transaction above
    // (this branch returns before ever reaching it) — this is a separate, best-effort side effect
    // and must never cause grantCreditsOnce (already committed above) to be retried. Idempotent
    // via the unique `stripeSessionId`: a webhook retry (MON-1) hits the unique constraint and is
    // swallowed as "already recorded", same pattern as the couponRedemption insert below.
    // KNOWN GAP (left as-is, out of this task's scope): /api/payments/history doesn't special-case
    // note==="credits", so this row will surface in the settings billing list as
    // "{plan} Plan · 0 วัน" rather than something reading "Credits purchase".
    try {
      await prisma.payment.create({
        data: {
          userId: s.metadata.userId,
          stripeSessionId: s.id,
          stripePaymentIntent: s.payment_intent ?? undefined,
          plan: creditUser.plan,
          amount: typeof s.amount_total === "number" ? s.amount_total : 0,
          currency: "thb",
          status: "PAID",
          periodDays: 0,
          paidAt: new Date(),
          note: "credits",
        },
      });
    } catch (e) {
      console.log("[webhook] credit-pack Payment already recorded (retry), skip", s.id, (e as any)?.code ?? e);
    }
    return;
  }

  // ── Plan purchase ─────────────────────────────────────────────────────
  const { userId, plan, period, periodDays } = s.metadata ?? {};
  if (!(userId && plan)) {
    // A completed/paid Checkout Session with no app metadata cannot be activated — it's most
    // likely a Dashboard/CLI-created session against the live webhook secret, not a real in-app
    // purchase (both real call sites always set userId+plan). But if it ever IS a genuine
    // customer payment, this is the only trace: log loudly + alert admins instead of the
    // previous silent no-op (found a zero-Payment-row orphan on prod 2026-07-13 with nothing
    // logged anywhere). Ack to Stripe is unchanged — we still just `return` below.
    const email = s.customer_details?.email ?? s.customer_email ?? null;
    console.error(
      "[stripe-webhook] checkout.session.completed missing userId/plan metadata — cannot activate, no Payment row will be created",
      { eventId, sessionId: s.id, email },
    );
    notifyAdmins({
      type: "ERROR_SYSTEM",
      title: "⚠️ Stripe checkout completed with no app metadata",
      body: `Checkout session ${s.id} (event ${eventId}) completed but had no userId/plan metadata — no Payment row was created. Possible orphaned payment. Email: ${email ?? "unknown"}. Check Stripe Dashboard for this session.`,
    }).catch(() => {});
    return;
  }
  // Activate ONLY when truly paid — a PromptPay/bank one-time session fires `completed` while
  // unpaid/processing; the real confirmation arrives as async_payment_succeeded (payment_status=paid).
  if (!checkoutPaymentSettled(s)) {
    console.warn("[webhook] plan session not yet paid, status:", s.payment_status, s.id);
    return;
  }

  let verifiedPeriodDays = Number(periodDays);
  const subscriptionId = typeof s.subscription === "string" ? s.subscription : s.subscription?.id ?? null;
  let verifiedPlan = plan;
  let verifiedPeriod = period;
  let entitlementExpiresAt: Date | null = null;
  const preserveTrial = preserveTrialOnConvertEnabled();
  let subscriptionStatus: string | null = null;
  let verifiedCurrency: string | null = s.currency ?? null;

  if (s.mode === "subscription") {
    if (!subscriptionId) throw new Error(`Paid subscription checkout ${s.id} has no subscription id`);
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    subscriptionStatus = subscription.status ?? null;
    // A trial-preserving checkout settles as `no_payment_required` with
    // amount_total 0 (checkoutPaymentSettled already accepts that shape). Stripe
    // still stamps the session currency, but fall back to the subscription's so a
    // missing field can never wedge this event into a permanent retry loop.
    verifiedCurrency = s.currency ?? (subscription as { currency?: string | null }).currency ?? null;
    const entitlement = resolveRecurringEntitlement({
      items: subscription.items.data.map((item) => ({
        priceId: item.price.id,
        currentPeriodEnd: item.current_period_end,
      })),
    }, recurringPriceCatalogFromEnv());
    if (!entitlement) {
      const detail = `checkout ${s.id} subscription ${subscriptionId} has an unsupported or unconfigured recurring price`;
      console.error(`[stripe-webhook] ${detail}`);
      notifyAdmins({
        type: "ERROR_SYSTEM",
        title: "⚠️ Stripe checkout paid but entitlement could not be resolved",
        body: `${detail}. Webhook will retry after configuration is corrected.`,
      }).catch(() => {});
      throw new Error(detail);
    }
    // Stripe's purchased Price and exact calendar period are authoritative;
    // session metadata is only routing context created before payment.
    verifiedPlan = entitlement.plan;
    verifiedPeriod = entitlement.billingPeriod;
    verifiedPeriodDays = entitlement.billingPeriod === "annual" ? 365 : 30;
    entitlementExpiresAt = entitlement.periodEnd;
  }

  const trialPreserved = preserveTrial && subscriptionStatus === "trialing";

  // The money/TIME effect (the planExpiresAt extension) commits in ONE
  // transaction with its own Payment-PAID marker + the billing/subscription write. If any step
  // throws, the WHOLE tx rolls back → MON-1 deletes the idempotency claim → Stripe's retry re-runs
  // this and applies the extension EXACTLY once (no double-extend). The Payment-PAID idempotency
  // belt is read INSIDE the tx (SQLite serializes writes) so a genuine duplicate — a retry of THIS
  // event OR the sibling completed/async_payment_succeeded event for the same session — sees PAID
  // and skips without re-extending.
  const activation = await activatePaidCheckout({
    sessionId: s.id,
    userId,
    plan: verifiedPlan,
    billingPeriod: verifiedPeriod,
    periodDays: verifiedPeriodDays,
    mode: s.mode,
    subscriptionId,
    paymentIntentId: typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id ?? null,
    amountTotal: s.amount_total,
    currency: verifiedCurrency,
    entitlementExpiresAt,
    // Stripe's status is authoritative. `trialing` means "converted, card on
    // file, first charge at trial end" — NOT unpaid: the plan is granted and
    // planExpiresAt is Stripe's current_period_end (the trial end) just like any
    // other subscription period.
    subscriptionStatus,
    paymentNote: trialPreserved ? TRIAL_PRESERVED_PAYMENT_NOTE : null,
  });
  if (!activation.activated) {
    console.log("[webhook] session already activated, skip", s.id);
    return;
  }
  const { newExpiry } = activation;

  // Everything below MUST stay fire-and-forget/guarded (never throws): the tx already committed the
  // money/time effect, so a throw here would make MON-1 delete the claim and Stripe's retry would
  // re-enter and double-extend. Kept OUTSIDE the tx — global-client calls (would deadlock SQLite in
  // a tx) whose failure must not roll back the paid activation.
  extendVideoExpiryForPlan(userId, verifiedPlan).catch(err => console.error("[webhook] extendVideoExpiry:", err));
  await createNotification({
    userId, type: "VIDEO_COMPLETED",
    // A trial-preserving conversion has NOT charged the card yet — saying
    // "ชำระเงินสำเร็จ" there would be untrue. Say what actually happened.
    title: trialPreserved
      ? `สมัคร ${verifiedPlan} Plan สำเร็จ`
      : `ชำระเงินสำเร็จ — ${verifiedPlan} Plan`,
    body: trialPreserved
      ? `วันทดลองที่เหลือของคุณยังอยู่ครบ — ระบบจะเริ่มเก็บเงินรอบแรกวันที่ ${newExpiry.toLocaleDateString("th-TH")}`
      : `แพ็กเกจ ${verifiedPlan} ของคุณใช้งานได้ถึง ${newExpiry.toLocaleDateString("th-TH")}`,
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
  // Initial paid grant — FORCE a fresh grant ignoring the 30-day window (NOT
  // ensureMonthlyGrant): a trial-expiry downgrade stamps grantedResetAt=now with FREE
  // allowance 0, so a within-30-days trial→paid subscriber would be skipped by the window
  // check and get 0 credits (bug H4). grantOnPaidActivation is CREDITS_LIVE-gated internally
  // (flag-off = no-op → byte-identical). Fire-and-forget.
  grantOnPaidActivation(userId, verifiedPlan).catch(() => {});
  // Conversion telemetry — deduped on the session id so a Stripe retry (or the
  // sibling completed/async_payment_succeeded event) records exactly one row.
  await recordTelemetryEventOnce(userId, `checkout_completed:${s.id}`, {
    name: "checkout_completed",
    source: "server",
    status: "done",
    properties: {
      plan: verifiedPlan,
      period: verifiedPeriod ?? null,
      method: s.metadata?.method ?? null,
      recurring: s.mode === "subscription",
      trialPreserved,
    },
  }).catch(() => {});
  console.log(`[stripe-webhook] ${userId} → ${verifiedPlan} until ${newExpiry} (mode=${s.mode}, sub=${subscriptionStatus ?? "n/a"})`);
}

export async function POST(req: Request) {
  await ensureStripeConfig();
  const body = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";

  // Fail CLOSED on a missing/blank signing secret. stripe-node's constructEvent does NOT reject
  // an empty secret — it verifies against HMAC(payload, "") which a forged request can reproduce,
  // so an unset/blank secret would let any unauthenticated POST mint a paid plan. ensureStripeConfig
  // above loads the secret from SiteConfig; if that row is missing/blank we refuse rather than fall open.
  if (!webhookSecret || webhookSecret.length < 10) {
    console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET missing/blank — refusing to process webhook");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  let event: ReturnType<typeof stripe.webhooks.constructEvent>;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (e: any) {
    console.error("[stripe-webhook] Signature verification failed:", e.message);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // ── Idempotency: Stripe delivers events at least once. Claim this event.id atomically
  //    (unique PK) for FAST duplicate-detection — a failed insert means this event was already
  //    fully processed, so short-circuit 200. The claim is only made DURABLE-ON-SUCCESS: if a
  //    handler throws below (e.g. SQLITE_BUSY) we DELETE this row and return 500, so Stripe's
  //    retry of the SAME event.id re-runs the handler instead of being rejected as a duplicate.
  //    Without this, a transient handler failure would permanently drop a paid activation
  //    (customer charged, plan/credits never applied). Goal = exactly-once EFFECT, not attempt. ──
  try {
    await prisma.stripeWebhookEvent.create({ data: { id: event.id, type: event.type } });
  } catch {
    console.log("[stripe-webhook] duplicate event, skip", event.id);
    return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    // ── Checkout finished (sync) OR delayed payment confirmed (PromptPay/bank async) ─────
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      await handleCheckoutSession(event.data.object as any, event.id);
    }

    // ── Delayed payment failed → mark the pending payment failed + free any founding seat ─
    if (event.type === "checkout.session.async_payment_failed") {
      const s = event.data.object as any;
      await prisma.payment.updateMany({ where: { stripeSessionId: s.id }, data: { status: "FAILED" } }).catch(() => {});
      await releaseSeat(s.id).catch(() => {});
    }

    // ── Subscription renewal / paid in-place plan change ──────────────────
    // Skip the first invoice because checkout.session.completed owns initial
    // activation. For later invoices, Stripe's actual recurring Price and item
    // period end are authoritative; DB plan/billingPeriod can be stale during a
    // monthly → annual Portal conversion.
    if (event.type === "invoice.paid") {
      const inv = event.data.object as any;
      const subId = invoiceSubId(inv);
      if (subId && inv.billing_reason !== "subscription_create") {
        const user = await prisma.user.findFirst({
          where: { stripeSubscriptionId: subId },
          select: { id: true, plan: true, billingPeriod: true },
        });
        if (user) {
          const subscription = await stripe.subscriptions.retrieve(subId, { expand: ["discounts"] });
          const entitlement = resolveRecurringEntitlement({
            items: subscription.items.data.map((item) => ({
              priceId: item.price.id,
              currentPeriodEnd: item.current_period_end,
            })),
          }, recurringPriceCatalogFromEnv());
          if (!entitlement) {
            const detail = `subscription ${subId} has an unsupported or unconfigured recurring price`;
            console.error(`[stripe-webhook] ${detail}`);
            notifyAdmins({
              type: "ERROR_SYSTEM",
              title: "⚠️ Stripe invoice paid but entitlement could not be resolved",
              body: `${detail} (invoice ${inv.id}, user ${user.id}). Webhook will retry after configuration is corrected.`,
            }).catch(() => {});
            throw new Error(detail);
          }

          const now = new Date();
          await prisma.user.update({
            where: { id: user.id },
            data: {
              plan: entitlement.plan,
              billingPeriod: entitlement.billingPeriod,
              planExpiresAt: entitlement.periodEnd,
              subStatus: subscription.status,
              trialEndsAt: null,
              cancelAtPeriodEnd: subscription.cancel_at_period_end,
              cancelAt: subscription.cancel_at ? new Date(subscription.cancel_at * 1000) : null,
              ...usageWindowForPlan(entitlement.plan, now),
            },
          });

          // The Founding discount is forever, so future annual renewals still
          // contain it. confirmLatestSeatForUser is deliberately idempotent.
          const foundingCoupon = entitlement.billingPeriod === "annual"
            ? await getFoundingCoupon()
            : null;
          const hasFoundingPromotion = !!foundingCoupon && subscription.discounts.some((discount) => {
            if (typeof discount === "string") return false;
            const promotionCode = discount.promotion_code;
            return (typeof promotionCode === "string" ? promotionCode : promotionCode?.id)
              === foundingCoupon.stripePromotionCodeId;
          });
          if (hasFoundingPromotion) await confirmLatestSeatForUser(user.id);

          // Record the renewal as a Payment row. Until now only the FIRST charge of a
          // subscription produced one (it comes through checkout.session.completed), so a
          // customer's renewals were invisible in Settings → billing history, which reads
          // this table: seven charges worth 7,041.95฿ had no row on prod. Lifetime revenue
          // was never affected — revenue-cash.ts reads Stripe's charge ledger directly.
          //
          // Keyed on the invoice id, which the unique `stripeSessionId` column turns into
          // idempotency for free: a webhook retry hits the constraint and is swallowed,
          // exactly like the credit-pack row above.
          const renewalSatang = typeof inv.amount_paid === "number" ? inv.amount_paid : 0;
          if (renewalSatang > 0 && typeof inv.id === "string") {
            try {
              await prisma.payment.create({
                data: {
                  userId: user.id,
                  stripeSessionId: inv.id,
                  stripePaymentIntent: typeof inv.payment_intent === "string" ? inv.payment_intent : undefined,
                  plan: entitlement.plan,
                  amount: renewalSatang,
                  currency: "thb",
                  status: "PAID",
                  periodDays: entitlement.billingPeriod === "annual" ? 365 : 30,
                  paidAt: new Date(),
                  note: RENEWAL_PAYMENT_NOTE,
                },
              });
            } catch (e) {
              console.log("[webhook] renewal Payment already recorded (retry), skip", inv.id, (e as any)?.code ?? e);
            }
          }

          extendVideoExpiryForPlan(user.id, entitlement.plan).catch(err => console.error("[webhook] extendVideoExpiry:", err));
          // A tier/period conversion starts a new billing cycle now, while a
          // routine renewal uses the ordinary lazy monthly grant guard.
          if (process.env.CREDITS_LIVE === "1") {
            const changedPlanOrPeriod = user.plan !== entitlement.plan
              || user.billingPeriod !== entitlement.billingPeriod;
            (changedPlanOrPeriod
              ? grantOnPaidActivation(user.id, entitlement.plan)
              : ensureMonthlyGrant(user.id)
            ).catch(() => {});
          }
          console.log(
            `[stripe-webhook] synced subscription for ${user.id}: ${entitlement.plan}/${entitlement.billingPeriod} until ${entitlement.periodEnd.toISOString()}`,
          );
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
      // The Stripe account also carries Hero AI Bundle subscriptions. Those
      // are synchronized through BundleEntitlement and must not overwrite a
      // Studio subscription merely because both products share a Customer.
      const bundleEntitlement = await prisma.bundleEntitlement.findFirst({
        where: { subscriptionId: sub.id },
        select: { email: true },
      });
      if (bundleEntitlement) {
        console.log(`[stripe-webhook] subscription.updated: Bundle subscription ${sub.id} is managed by Bundle entitlement sync`);
      } else {
        const user = await prisma.user.findFirst({
          where: { OR: [{ stripeSubscriptionId: sub.id }, { stripeCustomerId: sub.customer }] },
          select: { id: true },
        });
        if (!user) {
          console.warn(`[stripe-webhook] subscription.updated: no Studio user for sub ${sub.id}`);
          return NextResponse.json({ ok: true });
        }
        await prisma.user.update({
          where: { id: user.id },
          data: {
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
            cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
            subStatus: sub.status,
          },
        });
        console.log(`[stripe-webhook] subscription.updated ${user.id} cancelAtPeriodEnd=${!!sub.cancel_at_period_end}`);
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
          await releasePendingSeatForUser(user.id);
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
  } catch (err) {
    // A handler failed AFTER we claimed the event id. Roll back the idempotency claim so Stripe's
    // automatic retry of this SAME event re-runs the handler rather than seeing it as an
    // already-processed duplicate. Returning 500 signals Stripe to retry with backoff. This is
    // what heals a transient failure (e.g. SQLITE_BUSY) instead of silently losing a paid activation.
    console.error("[stripe-webhook] handler failed — rolling back idempotency claim for retry:", event.id, err);
    await prisma.stripeWebhookEvent.delete({ where: { id: event.id } }).catch(() => {});
    return NextResponse.json({ error: "Handler failed, will retry" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
