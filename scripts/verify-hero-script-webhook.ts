// Signed-route integration proof for the asynchronous PromptPay path.
// Exercises the real webhook POST handler with Stripe-generated signatures and
// event ordering against a throwaway DB; it makes no network call to Stripe.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Stripe from "stripe";

const dir = mkdtempSync(join(tmpdir(), "hero-script-webhook-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.STRIPE_SECRET_KEY = "sk_test_hero_script_route_verification";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_hero_script_route_verification";
process.env.STRIPE_PRICE_PRO_MONTHLY = "price_test_pro_month";
process.env.STRIPE_PRICE_PRO_ANNUAL = "price_test_pro_year";
process.env.STRIPE_PRICE_PRO_ANNUAL_ONETIME = "price_test_pro_promptpay";
process.env.STRIPE_PRICE_BUSINESS_MONTHLY = "price_test_business_month";
process.env.STRIPE_PRICE_BUSINESS_ANNUAL = "price_test_business_year";
process.env.STRIPE_PRICE_BUSINESS_ANNUAL_ONETIME = "price_test_business_promptpay";
process.env.STRIPE_PORTAL_FOUNDING_ANNUAL_CONFIG_ID = "bpc_test";
process.env.CREDITS_LIVE = "0";
execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
  stdio: "ignore",
  env: process.env,
});

let passed = 0;
function check(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  passed++;
  console.log(`ok: ${message}`);
}

const signer = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-04-22.dahlia" });

async function postEvent(event: Record<string, unknown>, validSignature = true) {
  const body = JSON.stringify(event);
  const signature = validSignature
    ? signer.webhooks.generateTestHeaderString({ payload: body, secret: process.env.STRIPE_WEBHOOK_SECRET! })
    : "t=1,v1=invalid";
  const { POST } = await import("../src/app/api/payments/webhook/route");
  return POST(new Request("http://localhost/api/payments/webhook", {
    method: "POST",
    headers: { "stripe-signature": signature, "content-type": "application/json" },
    body,
  }));
}

function checkoutEvent(id: string, type: string, paymentStatus: "unpaid" | "paid" | "no_payment_required") {
  return {
    id,
    object: "event",
    api_version: "2026-04-22.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
    data: {
      object: {
        id: "cs_promptpay_route",
        object: "checkout.session",
        mode: "payment",
        payment_status: paymentStatus,
        payment_intent: paymentStatus === "paid" ? "pi_promptpay_route" : null,
        amount_total: 299500,
        currency: "thb",
        metadata: {
          userId: "promptpay-route-user",
          plan: "PRO",
          period: "annual",
          periodDays: "365",
          method: "promptpay",
        },
      },
    },
  };
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const now = new Date();
  await prisma.user.create({
    data: { id: "promptpay-route-user", name: "PromptPay Route", email: "promptpay-route@example.com" },
  });
  await prisma.payment.create({
    data: {
      userId: "promptpay-route-user",
      stripeSessionId: "cs_promptpay_route",
      plan: "PRO",
      amount: 399500,
      status: "PENDING",
      periodDays: 365,
    },
  });

  const badSignature = await postEvent(checkoutEvent("evt_bad_signature", "checkout.session.completed", "paid"), false);
  check(badSignature.status === 400, "webhook rejects an invalid Stripe signature");
  check(await prisma.stripeWebhookEvent.count() === 0, "invalid signature cannot claim an event id");

  const pendingResponse = await postEvent(checkoutEvent("evt_promptpay_pending", "checkout.session.completed", "unpaid"));
  const pendingPayment = await prisma.payment.findUnique({ where: { stripeSessionId: "cs_promptpay_route" } });
  const pendingUser = await prisma.user.findUnique({ where: { id: "promptpay-route-user" } });
  check(pendingResponse.status === 200 && pendingPayment?.status === "PENDING" && pendingUser?.plan === "FREE",
    "checkout.session.completed while unpaid does not grant PromptPay access");

  const paidEvent = checkoutEvent("evt_promptpay_paid", "checkout.session.async_payment_succeeded", "paid");
  const paidResponse = await postEvent(paidEvent);
  const paidPayment = await prisma.payment.findUnique({ where: { stripeSessionId: "cs_promptpay_route" } });
  const paidUser = await prisma.user.findUnique({ where: { id: "promptpay-route-user" } });
  check(paidResponse.status === 200 && paidPayment?.status === "PAID" && paidUser?.plan === "PRO",
    "signed async payment success commits Payment and entitlement");
  check(paidPayment?.amount === 299500,
    "webhook replaces estimated list price with Stripe's verified charged amount");
  check(!!paidUser?.planExpiresAt && paidUser.planExpiresAt.getTime() >= now.getTime() + 364 * 24 * 60 * 60 * 1000,
    "PromptPay success grants the annual timed entitlement");

  const expiry = paidUser?.planExpiresAt?.getTime();
  const replay = await postEvent(paidEvent);
  const afterReplay = await prisma.user.findUnique({ where: { id: "promptpay-route-user" } });
  check(replay.status === 200 && (await replay.json()).duplicate === true,
    "replayed Stripe event is detected as a duplicate");
  check(afterReplay?.planExpiresAt?.getTime() === expiry,
    "replayed event cannot extend the paid term twice");

  await prisma.user.create({
    data: { id: "coupon-route-user", name: "Coupon Route", email: "coupon-route@example.com" },
  });
  await prisma.payment.create({
    data: {
      userId: "coupon-route-user",
      stripeSessionId: "cs_coupon_route",
      plan: "PRO",
      amount: 299500,
      status: "PENDING",
      periodDays: 365,
    },
  });
  const couponEvent = checkoutEvent("evt_coupon_free", "checkout.session.completed", "no_payment_required") as any;
  couponEvent.data.object.id = "cs_coupon_route";
  couponEvent.data.object.amount_total = 0;
  couponEvent.data.object.payment_intent = null;
  couponEvent.data.object.metadata.userId = "coupon-route-user";
  const couponResponse = await postEvent(couponEvent);
  const couponPayment = await prisma.payment.findUnique({ where: { stripeSessionId: "cs_coupon_route" } });
  const couponUser = await prisma.user.findUnique({ where: { id: "coupon-route-user" } });
  check(couponResponse.status === 200 && couponPayment?.status === "PAID" && couponPayment.amount === 0
      && couponUser?.plan === "PRO",
    "a Stripe-confirmed 100% discount activates its zero-total plan without payment/access mismatch");

  // Studio and Hero AI Bundle subscriptions may share one Stripe Customer.
  // A Bundle update must stay on the Bundle entitlement path instead of
  // mutating the user's separate Studio subscription through customer-id
  // fallback.
  await prisma.user.create({
    data: {
      id: "bundle-update-route-user",
      name: "Bundle Update Route",
      email: "bundle-update-route@example.com",
      plan: "PRO",
      stripeCustomerId: "cus_shared_studio_bundle",
      stripeSubscriptionId: "sub_studio_owned",
      subStatus: "active",
    },
  });
  await prisma.bundleEntitlement.create({
    data: {
      email: "bundle-update-route@example.com",
      grantId: "in_bundle_update_route",
      subscriptionId: "sub_bundle_owned",
      status: "ACTIVE",
      accessEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      billingPeriod: "monthly",
      amountThb: 899,
      lastEventId: "bundle-grant:in_bundle_update_route",
      eventOccurredAt: new Date(),
    },
  });
  const bundleUpdateResponse = await postEvent({
    id: "evt_bundle_subscription_updated",
    object: "event",
    api_version: "2026-04-22.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_bundle_owned",
        object: "subscription",
        customer: "cus_shared_studio_bundle",
        status: "past_due",
        cancel_at_period_end: true,
        cancel_at: Math.floor(Date.now() / 1000),
      },
    },
  });
  const afterBundleUpdate = await prisma.user.findUnique({ where: { id: "bundle-update-route-user" } });
  check(bundleUpdateResponse.status === 200
      && afterBundleUpdate?.subStatus === "active"
      && afterBundleUpdate.cancelAtPeriodEnd === false
      && afterBundleUpdate.stripeSubscriptionId === "sub_studio_owned",
    "Bundle subscription updates cannot overwrite a Studio subscription sharing the same Stripe customer");

  await new Promise(resolve => setTimeout(resolve, 25));
  await prisma.$disconnect();
  console.log(`\n✅ ${passed} signed-webhook checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
