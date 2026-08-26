// Proof for #348 — converting mid-trial must not forfeit the remaining trial days.
//
// Part A is pure arithmetic (resolveTrialPreservation + the webhook-shape helpers).
// Part B runs the real activation/entitlement code against a throwaway SQLite DB.
// Stripe is NEVER called: the Stripe objects are represented by the exact fields
// the webhook reads (status, current_period_end, payment_status, amount_total).
//
// Run: node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-preserve-trial-on-convert.ts
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "preserve-trial-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.CREDITS_LIVE = "0";
process.env.MINUTE_QUOTA = "0";
delete process.env.PRESERVE_TRIAL_ON_CONVERT;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-08-26T09:00:00.000Z");

function flagOn() { process.env.PRESERVE_TRIAL_ON_CONVERT = "1"; }
function flagOff() { delete process.env.PRESERVE_TRIAL_ON_CONVERT; }

async function main() {
  const {
    resolveTrialPreservation,
    storedSubscriptionStatus,
    hasLiveStripeSubscription,
    preserveTrialOnConvertEnabled,
    trialConvertPromiseLine,
    PRESERVE_TRIAL_CONVERT_LINE,
    FORFEIT_TRIAL_CONVERT_LINE,
    TRIAL_PRESERVED_PAYMENT_NOTE,
    STRIPE_MIN_TRIAL_END_LEAD_MS,
  } = await import("../src/lib/preserve-trial");

  // ── Part A · pure activation math ─────────────────────────────────────────
  console.log("\nA. trial-preservation decision (pure)");

  const trialEndsAt = new Date(NOW.getTime() + 5 * DAY_MS);

  {
    const d = resolveTrialPreservation({ trialEndsAt, subStatus: null, recurring: true, now: NOW, enabled: true });
    check("trial → monthly card: Stripe gets trial_end at the trial's end",
      d.preserved && d.stripeTrialEnd === Math.floor(trialEndsAt.getTime() / 1000),
      `got preserved=${d.preserved} trial_end=${d.stripeTrialEnd}`);
    check("trial → monthly card: trialDaysLeft is reported for telemetry", d.trialDaysLeft === 5, `got ${d.trialDaysLeft}`);
    check("trial_end is Unix SECONDS, not milliseconds",
      String(d.stripeTrialEnd).length === 10, `got ${d.stripeTrialEnd}`);
  }

  {
    // Stripe rejects a trial_end under 48h out — fall back to today's behaviour.
    const closeTrial = new Date(NOW.getTime() + 30 * HOUR_MS);
    const d = resolveTrialPreservation({ trialEndsAt: closeTrial, subStatus: null, recurring: true, now: NOW, enabled: true });
    check("trial ending in <48h: no trial_end is sent (Stripe's floor)",
      !d.preserved && d.stripeTrialEnd === null && d.reason === "trial_end_too_close", `reason=${d.reason}`);
    check("trial ending in <48h still falls back to base = now", d.termBase.getTime() === NOW.getTime());
    check("the 48h floor is the documented Stripe constraint", STRIPE_MIN_TRIAL_END_LEAD_MS === 48 * HOUR_MS);
    const justOver = new Date(NOW.getTime() + 48 * HOUR_MS);
    const ok = resolveTrialPreservation({ trialEndsAt: justOver, subStatus: null, recurring: true, now: NOW, enabled: true });
    check("exactly 48h out is accepted", ok.preserved && ok.stripeTrialEnd !== null);
  }

  {
    const d = resolveTrialPreservation({ trialEndsAt, subStatus: null, recurring: false, now: NOW, enabled: true });
    check("trial → annual PromptPay: term extends from the trial end, no trial_end",
      d.preserved && d.stripeTrialEnd === null && d.termBase.getTime() === trialEndsAt.getTime(),
      `termBase=${d.termBase.toISOString()}`);
  }

  {
    const d = resolveTrialPreservation({ trialEndsAt, subStatus: null, recurring: true, now: NOW, enabled: false });
    check("flag off: nothing is preserved and the base is now",
      !d.preserved && d.stripeTrialEnd === null && d.termBase.getTime() === NOW.getTime() && d.reason === "flag_off");
  }

  {
    const converted = resolveTrialPreservation({ trialEndsAt, subStatus: "active", recurring: true, now: NOW, enabled: true });
    check("an ALREADY-converted subscriber is not on an unconverted trial",
      !converted.onTrial && !converted.preserved && converted.reason === "not_on_trial");
    const past = resolveTrialPreservation({
      trialEndsAt: new Date(NOW.getTime() - DAY_MS), subStatus: null, recurring: true, now: NOW, enabled: true,
    });
    check("an expired trial is not preserved", !past.onTrial && !past.preserved);
    const none = resolveTrialPreservation({ trialEndsAt: null, subStatus: null, recurring: false, now: NOW, enabled: true });
    check("a user who never trialed is unaffected", !none.onTrial && !none.preserved && none.termBase.getTime() === NOW.getTime());
  }

  // ── Part A2 · webhook shape ───────────────────────────────────────────────
  console.log("\nA2. webhook must not treat a `trialing` subscription as unpaid");
  const { checkoutPaymentSettled } = await import("../src/lib/checkout-plan-activation");
  check("a ฿0 `no_payment_required` trialing session counts as settled",
    checkoutPaymentSettled({ payment_status: "no_payment_required", amount_total: 0 }));
  check("an ordinary paid session still counts as settled",
    checkoutPaymentSettled({ payment_status: "paid", amount_total: 59900 }));
  check("an unpaid PromptPay session is still rejected",
    !checkoutPaymentSettled({ payment_status: "unpaid", amount_total: 59900 }));
  check("`no_payment_required` with a non-zero total is still rejected",
    !checkoutPaymentSettled({ payment_status: "no_payment_required", amount_total: 59900 }));

  check("Stripe `trialing` is stored as trialing when the flag is on",
    storedSubscriptionStatus("trialing", true) === "trialing");
  check("Stripe `trialing` still stores active when the flag is off",
    storedSubscriptionStatus("trialing", false) === "active");
  check("every other Stripe status keeps storing active (unchanged)",
    storedSubscriptionStatus("active", true) === "active"
    && storedSubscriptionStatus("past_due", true) === "active"
    && storedSubscriptionStatus(null, true) === "active");

  check("a trialing subscription with an id is a live subscription (flag on)",
    hasLiveStripeSubscription({ subStatus: "trialing", stripeSubscriptionId: "sub_1" }, true));
  check("trialing WITHOUT a subscription id is not treated as live",
    !hasLiveStripeSubscription({ subStatus: "trialing", stripeSubscriptionId: null }, true));
  check("flag off: only `active` is a live subscription",
    !hasLiveStripeSubscription({ subStatus: "trialing", stripeSubscriptionId: "sub_1" }, false)
    && hasLiveStripeSubscription({ subStatus: "active", stripeSubscriptionId: "sub_1" }, false));

  // ── Part A3 · copy is bound to the behaviour ──────────────────────────────
  console.log("\nA3. copy and behaviour share one source");
  check("flag on promises that no trial days are lost",
    trialConvertPromiseLine(true) === PRESERVE_TRIAL_CONVERT_LINE
    && PRESERVE_TRIAL_CONVERT_LINE.includes("ไม่เสียวันทดลอง"));
  check("flag off keeps the honest wording",
    trialConvertPromiseLine(false) === FORFEIT_TRIAL_CONVERT_LINE
    && FORFEIT_TRIAL_CONVERT_LINE.includes("วันทดลองที่เหลือจะสิ้นสุด"));
  flagOff();
  check("the flag helper reads the env var, and defaults to off", preserveTrialOnConvertEnabled() === false);
  flagOn();
  check("PRESERVE_TRIAL_ON_CONVERT=1 turns it on", preserveTrialOnConvertEnabled() === true);
  flagOff();

  // ── Part B · real activation against a throwaway SQLite DB ────────────────
  console.log("\nB. activatePaidCheckout (throwaway SQLite, no Stripe calls)");
  const { prisma } = await import("../src/lib/prisma");
  const { activatePaidCheckout } = await import("../src/lib/checkout-plan-activation");
  const { checkoutAllowed } = await import("../src/lib/plan-change");

  async function makeTrialUser(id: string, daysLeft: number) {
    const endsAt = new Date(NOW.getTime() + daysLeft * DAY_MS);
    await prisma.user.create({
      data: {
        id, name: id, email: `${id}@example.com`, plan: "PRO",
        trialStartedAt: new Date(NOW.getTime() - (7 - daysLeft) * DAY_MS),
        trialEndsAt: endsAt, planExpiresAt: endsAt,
      },
    });
    return endsAt;
  }

  // B1 · trial → monthly card, ≥48h left, flag ON
  flagOn();
  {
    const endsAt = await makeTrialUser("u-card", 5);
    // Stripe reports current_period_end === trial_end while the subscription trials.
    const r = await activatePaidCheckout({
      sessionId: "cs_card_trial", userId: "u-card", plan: "PRO", billingPeriod: "monthly",
      periodDays: 30, mode: "subscription", subscriptionId: "sub_card_trial",
      amountTotal: 0, currency: "thb", entitlementExpiresAt: endsAt,
      subscriptionStatus: "trialing", paymentNote: TRIAL_PRESERVED_PAYMENT_NOTE,
    }, NOW);
    const u = await prisma.user.findUnique({ where: { id: "u-card" } });
    const pay = await prisma.payment.findUnique({ where: { stripeSessionId: "cs_card_trial" } });
    check("B1 trial→card: activated", r.activated);
    check("B1 trial→card: access still runs to the ORIGINAL trial end (no days lost)",
      u?.planExpiresAt?.getTime() === endsAt.getTime(),
      `planExpiresAt=${u?.planExpiresAt?.toISOString()} expected=${endsAt.toISOString()}`);
    check("B1 trial→card: stored as trialing with the Stripe subscription id",
      u?.subStatus === "trialing" && u?.stripeSubscriptionId === "sub_card_trial", `subStatus=${u?.subStatus}`);
    check("B1 trial→card: plan is PRO — a trialing subscription is NOT unpaid", u?.plan === "PRO");
    check("B1 trial→card: the ฿0 row is PAID evidence, tagged as not-yet-charged",
      pay?.status === "PAID" && pay?.amount === 0 && pay?.note === TRIAL_PRESERVED_PAYMENT_NOTE,
      `amount=${pay?.amount} note=${pay?.note}`);
    check("B1 trial→card: the DB trial is superseded (Stripe owns the remaining days now)",
      u?.trialEndsAt === null);
  }

  // B2 · trial → monthly card with <48h left (fallback to today's behaviour)
  {
    await makeTrialUser("u-card-late", 1);
    const periodEnd = new Date(NOW.getTime() + 30 * DAY_MS);
    await activatePaidCheckout({
      sessionId: "cs_card_late", userId: "u-card-late", plan: "PRO", billingPeriod: "monthly",
      periodDays: 30, mode: "subscription", subscriptionId: "sub_card_late",
      amountTotal: 59900, currency: "thb", entitlementExpiresAt: periodEnd,
      subscriptionStatus: "active",
    }, NOW);
    const u = await prisma.user.findUnique({ where: { id: "u-card-late" } });
    check("B2 <48h left: charged now, period end is Stripe's — today's behaviour",
      u?.planExpiresAt?.getTime() === periodEnd.getTime() && u?.subStatus === "active",
      `planExpiresAt=${u?.planExpiresAt?.toISOString()} subStatus=${u?.subStatus}`);
  }

  // B3 · trial → annual PromptPay (one-time), flag ON
  {
    const endsAt = await makeTrialUser("u-promptpay", 5);
    await activatePaidCheckout({
      sessionId: "cs_pp_trial", userId: "u-promptpay", plan: "PRO", billingPeriod: "annual",
      periodDays: 365, mode: "payment", paymentIntentId: "pi_pp",
      amountTotal: 599000, currency: "thb",
    }, NOW);
    const u = await prisma.user.findUnique({ where: { id: "u-promptpay" } });
    const expected = new Date(endsAt.getTime() + 365 * DAY_MS);
    check("B3 trial→PromptPay annual: term = trialEndsAt + 365d (unused days kept)",
      u?.planExpiresAt?.getTime() === expected.getTime(),
      `planExpiresAt=${u?.planExpiresAt?.toISOString()} expected=${expected.toISOString()}`);
    check("B3 trial→PromptPay annual: one-time purchase has no subscription", u?.subStatus === null);
  }

  // B4 · the SAME PromptPay purchase with the flag OFF must reproduce the old numbers
  flagOff();
  {
    const endsAt = await makeTrialUser("u-promptpay-off", 5);
    await activatePaidCheckout({
      sessionId: "cs_pp_off", userId: "u-promptpay-off", plan: "PRO", billingPeriod: "annual",
      periodDays: 365, mode: "payment", paymentIntentId: "pi_pp_off",
      amountTotal: 599000, currency: "thb",
    }, NOW);
    const u = await prisma.user.findUnique({ where: { id: "u-promptpay-off" } });
    const oldExpected = new Date(NOW.getTime() + 365 * DAY_MS);
    check("B4 flag OFF: term still starts at now — the 5 unused trial days are lost (today)",
      u?.planExpiresAt?.getTime() === oldExpected.getTime()
      && u.planExpiresAt.getTime() !== endsAt.getTime() + 365 * DAY_MS,
      `planExpiresAt=${u?.planExpiresAt?.toISOString()} expected=${oldExpected.toISOString()}`);
    check("B4 flag OFF: a card subscription is still stored as active",
      storedSubscriptionStatus("trialing", preserveTrialOnConvertEnabled()) === "active");
  }

  // B5 · non-trial paths are untouched either way
  for (const enabled of [false, true]) {
    enabled ? flagOn() : flagOff();
    const id = `u-free-${enabled}`;
    await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, plan: "FREE" } });
    await activatePaidCheckout({
      sessionId: `cs_free_${enabled}`, userId: id, plan: "PRO", billingPeriod: "annual",
      periodDays: 365, mode: "payment", paymentIntentId: `pi_free_${enabled}`,
      amountTotal: 599000, currency: "thb",
    }, NOW);
    const u = await prisma.user.findUnique({ where: { id } });
    check(`B5 FREE user (flag ${enabled ? "on" : "off"}): term = now + 365d, unchanged`,
      u?.planExpiresAt?.getTime() === NOW.getTime() + 365 * DAY_MS);

    // An existing PAID one-time term still extends additively from its own expiry.
    const idTimed = `u-timed-${enabled}`;
    const existing = new Date(NOW.getTime() + 100 * DAY_MS);
    await prisma.user.create({
      data: { id: idTimed, name: idTimed, email: `${idTimed}@example.com`, plan: "PRO", planExpiresAt: existing },
    });
    await activatePaidCheckout({
      sessionId: `cs_timed_${enabled}`, userId: idTimed, plan: "PRO", billingPeriod: "annual",
      periodDays: 365, mode: "payment", paymentIntentId: `pi_timed_${enabled}`,
      amountTotal: 599000, currency: "thb",
    }, NOW);
    const t = await prisma.user.findUnique({ where: { id: idTimed } });
    check(`B5 paid timed plan (flag ${enabled ? "on" : "off"}): renewal still stacks on the existing expiry`,
      t?.planExpiresAt?.getTime() === existing.getTime() + 365 * DAY_MS);
  }

  // ── Part C · guards that must survive ─────────────────────────────────────
  console.log("\nC. existing guards are intact");
  {
    const paidTimedState = {
      plan: "PRO", subStatus: null, trialEndsAt: null,
      planExpiresAt: new Date(NOW.getTime() + 100 * DAY_MS), hasQualifyingCashPayment: true,
    };
    for (const enabled of [false, true]) {
      const d = checkoutAllowed(paidTimedState, "PRO", NOW, { recurring: true, preserveTrialOnConvert: enabled });
      check(`C1 paid timed plan still blocks a new card subscription (flag ${enabled ? "on" : "off"})`,
        !d.allowed && d.reason === "active_timed_plan");
      const pp = checkoutAllowed(paidTimedState, "PRO", NOW, { recurring: false, preserveTrialOnConvert: enabled });
      check(`C1b PromptPay renewal stays allowed (flag ${enabled ? "on" : "off"})`, pp.allowed);
    }

    const trialingSub = {
      plan: "PRO", subStatus: "trialing", stripeSubscriptionId: "sub_card_trial",
      trialEndsAt: null, planExpiresAt: new Date(NOW.getTime() + 5 * DAY_MS),
    };
    const blocked = checkoutAllowed(trialingSub, "PRO", NOW, { recurring: true, preserveTrialOnConvert: true });
    check("C2 a converted trialing subscriber cannot mint a SECOND subscription",
      !blocked.allowed && blocked.reason === "active_sub", `got ${JSON.stringify(blocked)}`);

    const activeSub = { plan: "PRO", subStatus: "active", trialEndsAt: null };
    check("C3 the original active-subscriber block is unchanged",
      !checkoutAllowed(activeSub, "BUSINESS", NOW, { recurring: true }).allowed);

    const onTrial = { plan: "PRO", subStatus: null, trialEndsAt: new Date(NOW.getTime() + 5 * DAY_MS), planExpiresAt: new Date(NOW.getTime() + 5 * DAY_MS) };
    check("C4 an unconverted trial can still upgrade (the whole funnel)",
      checkoutAllowed(onTrial, "PRO", NOW, { recurring: true, preserveTrialOnConvert: true }).allowed);
  }

  // ── Part D · the revert crons must not downgrade a trialing subscription ──
  console.log("\nD. trial-end webhook lag must not downgrade a paying customer");
  const { syncUserEntitlement } = await import("../src/lib/entitlements");
  const { revertExpiredTrials } = await import("../src/lib/trial");
  const AFTER_TRIAL = new Date(NOW.getTime() + 6 * DAY_MS); // trial ended, invoice.paid not in yet

  async function makeTrialingSubscriber(id: string) {
    await prisma.user.create({
      data: {
        id, name: id, email: `${id}@example.com`, plan: "PRO",
        subStatus: "trialing", stripeSubscriptionId: `sub_${id}`,
        billingPeriod: "monthly",
        planExpiresAt: new Date(NOW.getTime() + 5 * DAY_MS),
      },
    });
    await prisma.payment.create({
      data: {
        userId: id, stripeSessionId: `cs_${id}`, plan: "PRO", amount: 0, currency: "thb",
        status: "PAID", periodDays: 30, paidAt: NOW, note: TRIAL_PRESERVED_PAYMENT_NOTE,
      },
    });
  }

  flagOn();
  await makeTrialingSubscriber("u-lag-on");
  const onResult = await syncUserEntitlement("u-lag-on", AFTER_TRIAL);
  const onUser = await prisma.user.findUnique({ where: { id: "u-lag-on" } });
  check("D1 flag ON: a trialing subscription is KEPT past its trial end",
    onResult?.changed === false && onUser?.plan === "PRO" && onUser?.subStatus === "trialing",
    `changed=${onResult?.changed} plan=${onUser?.plan} reason=${onResult?.decision.reason}`);
  check("D1b the decision names the real reason", onResult?.decision.reason === "stripe_trialing_subscription");

  flagOff();
  await makeTrialingSubscriber("u-lag-off");
  const offResult = await syncUserEntitlement("u-lag-off", AFTER_TRIAL);
  const offUser = await prisma.user.findUnique({ where: { id: "u-lag-off" } });
  check("D2 flag OFF: the guard is inert (nothing can write `trialing` without the flag)",
    offResult?.changed === true && offUser?.plan === "FREE",
    `changed=${offResult?.changed} plan=${offUser?.plan}`);

  // revertExpiredTrials sweeps on trialEndsAt — cover the window where the trial row
  // still exists (subscription.updated can land before checkout.session.completed).
  flagOn();
  await prisma.user.create({
    data: {
      id: "u-sweep-on", name: "sweep", email: "sweep-on@example.com", plan: "PRO",
      subStatus: "trialing", stripeSubscriptionId: "sub_sweep_on",
      trialStartedAt: new Date(NOW.getTime() - 7 * DAY_MS), trialEndsAt: new Date(NOW.getTime() - DAY_MS),
    },
  });
  await prisma.user.create({
    data: {
      id: "u-sweep-plain", name: "sweep2", email: "sweep-plain@example.com", plan: "PRO",
      trialStartedAt: new Date(NOW.getTime() - 7 * DAY_MS), trialEndsAt: new Date(NOW.getTime() - DAY_MS),
    },
  });
  const reverted = await revertExpiredTrials();
  const sweptSub = await prisma.user.findUnique({ where: { id: "u-sweep-on" } });
  const sweptPlain = await prisma.user.findUnique({ where: { id: "u-sweep-plain" } });
  check("D3 revertExpiredTrials skips a trialing Stripe subscription",
    sweptSub?.plan === "PRO" && sweptSub?.trialEndsAt !== null, `plan=${sweptSub?.plan}`);
  check("D3b revertExpiredTrials still reverts an ordinary expired trial",
    sweptPlain?.plan === "FREE" && reverted === 1, `plan=${sweptPlain?.plan} reverted=${reverted}`);

  flagOff();
  await prisma.$disconnect();
}

main()
  .then(() => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log("\nverify-preserve-trial-on-convert: PASS");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
