// Integration proof for the paid launch path:
// verified checkout → atomic entitlement + PAID plan evidence → Hero Script access.
// Runs against a throwaway SQLite DB and never calls Stripe.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hero-script-payment-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.HERO_SCRIPT_ALLOWED_EMAILS = "";
process.env.HERO_SCRIPT_PAID_ENABLED = "1";
process.env.HERO_SCRIPT_PUBLIC_PREVIEW = "1";
process.env.HERO_SCRIPT_TRIAL_PERCENT = "0";
process.env.HERO_SCRIPT_FREE_PERCENT = "0";
process.env.CREDITS_LIVE = "0";
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failed = 0;
function check(condition: boolean, message: string) {
  if (condition) { passed++; console.log(`ok: ${message}`); }
  else { failed++; console.error(`FAIL: ${message}`); }
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { activatePaidCheckout } = await import("../src/lib/checkout-plan-activation");
  const { findPlanPaymentConfirmation } = await import("../src/lib/payment-confirmation");
  const { resolveHeroScriptAccess } = await import("../src/lib/hero-script-rollout.server");
  const now = new Date("2026-08-07T04:00:00.000Z");
  const dayMs = 24 * 60 * 60 * 1000;
  const cardPeriodEnd = new Date("2026-09-07T04:00:00.000Z");

  // Card subscription: the same transaction must activate the plan and mark
  // the reservation PAID, which is the evidence Hero Script consumes.
  const cardUser = await prisma.user.create({
    data: { id: "pay-card", name: "Card", email: "pay-card@example.com", plan: "FREE" },
  });
  await prisma.payment.create({
    data: {
      userId: cardUser.id, stripeSessionId: "cs_card", plan: "PRO", amount: 59900,
      status: "PENDING", periodDays: 30,
    },
  });
  const pendingConfirmation = await findPlanPaymentConfirmation(cardUser.id, "cs_card");
  check(pendingConfirmation?.status === "PENDING" && !pendingConfirmation.confirmed,
    "checkout result stays unconfirmed until the paid webhook commits");
  const card = await activatePaidCheckout({
    sessionId: "cs_card", userId: cardUser.id, plan: "PRO", billingPeriod: "monthly",
    periodDays: 30, mode: "subscription", subscriptionId: "sub_card",
    paymentIntentId: "pi_card", amountTotal: 49900, currency: "thb",
    entitlementExpiresAt: cardPeriodEnd,
  }, now);
  check(card.activated, "card checkout activates once");
  const cardAfter = await prisma.user.findUnique({ where: { id: cardUser.id } });
  const cardPayment = await prisma.payment.findUnique({ where: { stripeSessionId: "cs_card" } });
  check(cardAfter?.plan === "PRO" && cardAfter.subStatus === "active" && cardAfter.stripeSubscriptionId === "sub_card",
    "card checkout commits the subscription entitlement");
  check(cardPayment?.status === "PAID" && cardPayment.periodDays === 30 && cardPayment.amount === 49900,
    "card checkout commits the discounted Stripe amount as durable paid-plan evidence");
  check(cardAfter?.planExpiresAt?.getTime() === cardPeriodEnd.getTime(),
    "card checkout uses Stripe's exact calendar period end");
  const cardConfirmation = await findPlanPaymentConfirmation(cardUser.id, "cs_card");
  check(cardConfirmation?.confirmed === true && cardConfirmation.status === "PAID" && cardConfirmation.plan === "PRO",
    "checkout result confirms only after the owned plan payment is PAID");
  const cardAccess = await resolveHeroScriptAccess(cardAfter!);
  check(cardAccess.canUse && cardAccess.cohort === "paid",
    "new card subscriber immediately resolves to Hero Script paid access");

  const expiryAfterFirst = cardAfter?.planExpiresAt?.getTime();
  const duplicate = await activatePaidCheckout({
    sessionId: "cs_card", userId: cardUser.id, plan: "PRO", billingPeriod: "monthly",
    periodDays: 30, mode: "subscription", subscriptionId: "sub_card", amountTotal: 49900,
    currency: "thb", entitlementExpiresAt: cardPeriodEnd,
  }, new Date(now.getTime() + dayMs));
  const afterDuplicate = await prisma.user.findUnique({ where: { id: cardUser.id } });
  check(!duplicate.activated && duplicate.reason === "already_paid",
    "duplicate/sibling webhook is skipped by the PAID belt");
  check(afterDuplicate?.planExpiresAt?.getTime() === expiryAfterFirst,
    "duplicate webhook cannot extend paid time twice");

  const otherUser = await prisma.user.create({
    data: { id: "pay-other", name: "Other", email: "pay-other@example.com", plan: "FREE" },
  });
  check((await findPlanPaymentConfirmation(otherUser.id, "cs_card")) === null,
    "payment confirmation never reveals or confirms another user's checkout");
  await prisma.payment.create({
    data: {
      userId: otherUser.id, stripeSessionId: "cs_credit_pack", plan: "PRO", amount: 4900,
      status: "PAID", periodDays: 0, note: "credits:100", paidAt: now,
    },
  });
  check((await findPlanPaymentConfirmation(otherUser.id, "cs_credit_pack")) === null,
    "credit-pack purchases cannot masquerade as confirmed plan upgrades");

  await prisma.payment.create({
    data: {
      userId: otherUser.id, stripeSessionId: "cs_owner_mismatch", plan: "PRO", amount: 299500,
      status: "PENDING", periodDays: 365,
    },
  });
  let ownerMismatchRejected = false;
  try {
    await activatePaidCheckout({
      sessionId: "cs_owner_mismatch", userId: cardUser.id, plan: "PRO", billingPeriod: "annual",
      periodDays: 365, mode: "payment", amountTotal: 299500, currency: "thb",
    }, now);
  } catch {
    ownerMismatchRejected = true;
  }
  const mismatchedPayment = await prisma.payment.findUnique({ where: { stripeSessionId: "cs_owner_mismatch" } });
  check(ownerMismatchRejected, "activation rejects a checkout reservation owned by another user");
  check(mismatchedPayment?.userId === otherUser.id && mismatchedPayment.status === "PENDING",
    "owner mismatch cannot move the other user's Payment to PAID");

  // PromptPay async success can heal a missing local reservation row. This is
  // important for paid access: an active plan without a plan Payment would be
  // invisible to the money-backed feature gate.
  const promptPayUser = await prisma.user.create({
    data: { id: "pay-promptpay", name: "PromptPay", email: "pay-promptpay@example.com", plan: "FREE" },
  });
  const promptPay = await activatePaidCheckout({
    sessionId: "cs_promptpay", userId: promptPayUser.id, plan: "BUSINESS", billingPeriod: "annual",
    periodDays: 365, mode: "payment", paymentIntentId: "pi_promptpay",
    amountTotal: 990000, currency: "thb",
  }, now);
  const recoveredPayment = await prisma.payment.findUnique({ where: { stripeSessionId: "cs_promptpay" } });
  const promptPayAfter = await prisma.user.findUnique({ where: { id: promptPayUser.id } });
  check(promptPay.activated && recoveredPayment?.status === "PAID" && recoveredPayment.periodDays === 365,
    "paid PromptPay heals a missing reservation with a PAID plan row");
  check(promptPayAfter?.subStatus === null && promptPayAfter.planExpiresAt?.getTime() === now.getTime() + 365 * dayMs,
    "PromptPay grants a timed plan without inventing a recurring subscription");
  const promptPayAccess = await resolveHeroScriptAccess(promptPayAfter!);
  check(promptPayAccess.canUse && promptPayAccess.cohort === "paid",
    "PromptPay annual payer receives the same Hero Script paid access");

  // Converting during a free trial must start the bought term from payment
  // time—not gift the remaining trial days on top.
  const trialUser = await prisma.user.create({
    data: {
      id: "pay-trial", name: "Trial", email: "pay-trial@example.com", plan: "PRO",
      trialStartedAt: new Date(now.getTime() - 2 * dayMs),
      trialEndsAt: new Date(now.getTime() + 5 * dayMs),
    },
  });
  await prisma.payment.create({
    data: {
      userId: trialUser.id, stripeSessionId: "cs_trial", plan: "PRO", amount: 59900,
      status: "PENDING", periodDays: 30,
    },
  });
  await activatePaidCheckout({
    sessionId: "cs_trial", userId: trialUser.id, plan: "PRO", billingPeriod: "monthly",
    periodDays: 30, mode: "subscription", subscriptionId: "sub_trial", amountTotal: 59900,
    currency: "thb", entitlementExpiresAt: cardPeriodEnd,
  }, now);
  const converted = await prisma.user.findUnique({ where: { id: trialUser.id } });
  check(converted?.trialEndsAt === null, "paid conversion clears the active trial marker");
  check(converted?.planExpiresAt?.getTime() === cardPeriodEnd.getTime(),
    "paid conversion uses Stripe's exact purchased period end rather than adding trial time");
  check((await resolveHeroScriptAccess(converted!)).cohort === "paid",
    "converted trial moves from trial to paid Hero Script cohort");

  let invalidRejected = false;
  try {
    await activatePaidCheckout({
      sessionId: "cs_invalid", userId: cardUser.id, plan: "FREE", billingPeriod: "monthly",
      periodDays: 30, mode: "subscription", amountTotal: 0,
    }, now);
  } catch {
    invalidRejected = true;
  }
  check(invalidRejected, "invalid paid-plan metadata fails closed");
  check((await prisma.payment.findUnique({ where: { stripeSessionId: "cs_invalid" } })) === null,
    "invalid payment metadata writes no Payment row");

  let missingPeriodEndRejected = false;
  try {
    await activatePaidCheckout({
      sessionId: "cs_missing_period", userId: cardUser.id, plan: "PRO", billingPeriod: "monthly",
      periodDays: 30, mode: "subscription", subscriptionId: "sub_missing_period",
      amountTotal: 59900, currency: "thb",
    }, now);
  } catch {
    missingPeriodEndRejected = true;
  }
  check(missingPeriodEndRejected, "subscription activation fails closed without Stripe's period end");
  check((await prisma.payment.findUnique({ where: { stripeSessionId: "cs_missing_period" } })) === null,
    "missing subscription period end commits no Payment row");

  await prisma.$disconnect();
  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
