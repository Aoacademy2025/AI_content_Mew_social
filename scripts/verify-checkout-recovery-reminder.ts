import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HERO-111 — Regression tests for bounded, idempotent failed/abandoned paid checkout recovery.
const testDir = mkdtempSync(join(tmpdir(), "checkout-recovery-"));
process.env.DATABASE_URL = `file:${join(testDir, "test.db")}`;
process.env.NEXTAUTH_URL = "https://studio.example.test";
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

const NOW = new Date("2026-11-22T02:00:00Z"); // 09:00 Bangkok
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

async function main() {
  const [{ prisma }, pure, server, notifLink] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/checkout-recovery-reminder"),
    import("../src/lib/checkout-recovery-reminder.server"),
    import("../src/lib/notification-link"),
  ]);

  // ─── 1. Pure decision, link, dedupe key, and copy tests ─────────────────────
  assert.equal(pure.CHECKOUT_RECOVERY_MIN_AGE_HOURS, 2);
  assert.equal(pure.CHECKOUT_RECOVERY_MAX_AGE_DAYS, 7);
  assert.equal(pure.CHECKOUT_RECOVERY_USER_COOLDOWN_DAYS, 14);
  assert.equal(pure.checkoutRecoveryDedupeKey("pay-abc"), "checkout_recovery:pay-abc");

  const annualProLink = pure.checkoutRecoveryLink("PRO", 365);
  const monthlyBizLink = pure.checkoutRecoveryLink("BUSINESS", 30);
  assert.equal(annualProLink, "/pricing?source=checkout_recovery&plan=PRO&cycle=annual");
  assert.equal(monthlyBizLink, "/pricing?source=checkout_recovery&plan=BUSINESS&cycle=monthly");
  assert.equal(notifLink.isSafeNotificationLink(annualProLink), true);
  assert.equal(notifLink.isSafeNotificationLink(monthlyBizLink), true);

  const annualCopy = pure.checkoutRecoveryCopy({
    plan: "PRO",
    periodDays: 365,
    amountSatang: 599_000,
  });
  assert.equal(annualCopy.cycle, "annual");
  assert.match(annualCopy.title, /PRO/);
  assert.match(annualCopy.title, /รายปี/);
  assert.match(annualCopy.body, /5,990 บาท/);
  assert.match(annualCopy.body, /PromptPay QR/);
  assert.match(annualCopy.body, /บัตรเครดิต/);
  assert.match(annualCopy.emailSubject, /PRO/);
  assert.match(annualCopy.emailSubject, /รายปี/);

  const monthlyCopy = pure.checkoutRecoveryCopy({
    plan: "BUSINESS",
    periodDays: 30,
    amountSatang: 99_000,
  });
  assert.equal(monthlyCopy.cycle, "monthly");
  assert.match(monthlyCopy.title, /BUSINESS/);
  assert.match(monthlyCopy.title, /รายเดือน/);
  assert.match(monthlyCopy.body, /990 บาท/);
  assert.match(monthlyCopy.body, /PromptPay QR/);

  const baseInput = {
    payment: {
      id: "pay-1",
      status: "FAILED",
      plan: "PRO",
      amount: 599_000,
      periodDays: 365,
      note: null,
      createdAt: new Date(NOW.getTime() - 3 * HOUR_MS),
    },
    user: {
      role: "USER",
      email: "creator@example.test",
      suspended: false,
      subStatus: null,
      cancelAtPeriodEnd: false,
    },
    hasSubsequentPaidPayment: false,
    lastRecoverySentAt: null,
    now: NOW,
  };

  // Eligible at 3h, exact 2h boundary, and exact 7d boundary.
  const ok3h = pure.checkoutRecoveryDecision(baseInput);
  assert.equal(ok3h.send, true);
  if (ok3h.send) {
    assert.equal(ok3h.plan, "PRO");
    assert.equal(ok3h.cycle, "annual");
    assert.equal(ok3h.dedupeKey, "checkout_recovery:pay-1");
    assert.equal(ok3h.link, "/pricing?source=checkout_recovery&plan=PRO&cycle=annual");
  }
  assert.equal(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      payment: { ...baseInput.payment, createdAt: new Date(NOW.getTime() - 2 * HOUR_MS) },
    }).send,
    true,
    "exact 2h age is eligible",
  );
  assert.equal(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      payment: { ...baseInput.payment, createdAt: new Date(NOW.getTime() - 7 * DAY_MS) },
    }).send,
    true,
    "exact 7d age is eligible",
  );

  // Suppressions in pure logic
  assert.deepEqual(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      payment: { ...baseInput.payment, createdAt: new Date(NOW.getTime() - (2 * HOUR_MS - 60_000)) },
    }),
    { send: false, reason: "too_recent" },
  );
  assert.deepEqual(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      payment: { ...baseInput.payment, createdAt: new Date(NOW.getTime() - (7 * DAY_MS + 60_000)) },
    }),
    { send: false, reason: "too_old" },
  );
  assert.deepEqual(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      payment: { ...baseInput.payment, status: "PENDING" },
    }),
    { send: false, reason: "not_failed" },
  );
  assert.deepEqual(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      payment: { ...baseInput.payment, amount: 0 },
    }),
    { send: false, reason: "invalid_amount" },
  );
  assert.deepEqual(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      payment: { ...baseInput.payment, plan: "FREE" },
    }),
    { send: false, reason: "unsupported_plan" },
  );
  assert.deepEqual(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      payment: { ...baseInput.payment, note: "credits", periodDays: 0 },
    }),
    { send: false, reason: "not_plan_checkout" },
  );
  assert.deepEqual(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      user: { ...baseInput.user, suspended: true },
    }),
    { send: false, reason: "suspended" },
  );
  assert.deepEqual(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      user: { ...baseInput.user, role: "ADMIN" },
    }),
    { send: false, reason: "internal" },
  );
  assert.deepEqual(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      user: { ...baseInput.user, email: "ops@aoacademy.co" },
    }),
    { send: false, reason: "internal" },
  );
  assert.deepEqual(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      user: { ...baseInput.user, subStatus: "active", cancelAtPeriodEnd: false },
    }),
    { send: false, reason: "active_subscription" },
  );
  assert.deepEqual(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      user: { ...baseInput.user, subStatus: "trialing", cancelAtPeriodEnd: false },
    }),
    { send: false, reason: "active_subscription" },
  );
  assert.equal(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      user: { ...baseInput.user, subStatus: "active", cancelAtPeriodEnd: true },
    }).send,
    true,
    "active sub scheduled to cancel at period end is NOT suppressed",
  );
  assert.deepEqual(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      hasSubsequentPaidPayment: true,
    }),
    { send: false, reason: "later_paid" },
  );
  assert.deepEqual(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      lastRecoverySentAt: new Date(NOW.getTime() - 13 * DAY_MS),
    }),
    { send: false, reason: "cooldown" },
  );
  assert.equal(
    pure.checkoutRecoveryDecision({
      ...baseInput,
      lastRecoverySentAt: new Date(NOW.getTime() - 14 * DAY_MS),
    }).send,
    true,
    "14-day cooldown elapsed -> eligible again",
  );

  // ─── 2. DB-backed sweep tests ───────────────────────────────────────────────
  async function seedUser(input: {
    id: string;
    email?: string;
    role?: "USER" | "ADMIN";
    suspended?: boolean;
    subStatus?: string | null;
    cancelAtPeriodEnd?: boolean;
  }) {
    await prisma.user.create({
      data: {
        id: input.id,
        name: input.id,
        email: input.email ?? `${input.id}@example.test`,
        role: input.role ?? "USER",
        plan: "FREE",
        suspended: input.suspended ?? false,
        stripeSubscriptionId: input.subStatus ? `sub-${input.id}` : null,
        subStatus: input.subStatus ?? null,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
      },
    });
  }

  let seq = 0;
  async function seedPayment(input: {
    id?: string;
    userId: string;
    plan?: "FREE" | "PRO" | "BUSINESS";
    amount?: number;
    periodDays?: number;
    status?: "PENDING" | "PAID" | "FAILED" | "REFUNDED" | "VOIDED";
    note?: string | null;
    createdAt: Date;
    paidAt?: Date | null;
  }) {
    seq += 1;
    const id = input.id ?? `pay-${seq}`;
    await prisma.payment.create({
      data: {
        id,
        userId: input.userId,
        stripeSessionId: `cs-${id}`,
        plan: input.plan ?? "PRO",
        amount: input.amount ?? 599_000,
        periodDays: input.periodDays ?? 365,
        status: input.status ?? "FAILED",
        note: input.note ?? null,
        createdAt: input.createdAt,
        paidAt: input.paidAt ?? null,
      },
    });
    return id;
  }

  // Case A: Eligible failed Annual PRO checkout (6h ago) -> SHOULD SEND
  await seedUser({ id: "u-annual-pro" });
  const payAnnualPro = await seedPayment({
    id: "pay-annual-pro",
    userId: "u-annual-pro",
    plan: "PRO",
    amount: 599_000,
    periodDays: 365,
    status: "FAILED",
    createdAt: new Date(NOW.getTime() - 6 * HOUR_MS),
  });

  // Case B: User with MULTIPLE failed attempts (3d ago Monthly PRO, 5h ago Annual BUSINESS) -> AT MOST 1 NUDGE (newest!)
  await seedUser({ id: "u-multi-fail" });
  await seedPayment({
    id: "pay-multi-old",
    userId: "u-multi-fail",
    plan: "PRO",
    amount: 59_900,
    periodDays: 30,
    status: "FAILED",
    createdAt: new Date(NOW.getTime() - 3 * DAY_MS),
  });
  const payMultiNewest = await seedPayment({
    id: "pay-multi-new",
    userId: "u-multi-fail",
    plan: "BUSINESS",
    amount: 990_000,
    periodDays: 365,
    status: "FAILED",
    createdAt: new Date(NOW.getTime() - 5 * HOUR_MS),
  });

  // Case C: Later paid -> SUPPRESSED
  await seedUser({ id: "u-later-paid" });
  await seedPayment({
    id: "pay-later-fail",
    userId: "u-later-paid",
    plan: "PRO",
    amount: 599_000,
    periodDays: 365,
    status: "FAILED",
    createdAt: new Date(NOW.getTime() - 12 * HOUR_MS),
  });
  await seedPayment({
    id: "pay-later-ok",
    userId: "u-later-paid",
    plan: "PRO",
    amount: 599_000,
    periodDays: 365,
    status: "PAID",
    createdAt: new Date(NOW.getTime() - 4 * HOUR_MS),
    paidAt: new Date(NOW.getTime() - 4 * HOUR_MS),
  });

  // Case D: Active Stripe subscription -> SUPPRESSED
  await seedUser({ id: "u-active-sub", subStatus: "active", cancelAtPeriodEnd: false });
  await seedPayment({
    id: "pay-active-sub",
    userId: "u-active-sub",
    plan: "BUSINESS",
    amount: 990_000,
    periodDays: 365,
    status: "FAILED",
    createdAt: new Date(NOW.getTime() - 10 * HOUR_MS),
  });

  // Case E: Suspended user -> SUPPRESSED
  await seedUser({ id: "u-suspended", suspended: true });
  await seedPayment({
    id: "pay-suspended",
    userId: "u-suspended",
    plan: "PRO",
    amount: 599_000,
    periodDays: 365,
    status: "FAILED",
    createdAt: new Date(NOW.getTime() - 10 * HOUR_MS),
  });

  // Case F: Admin user -> SUPPRESSED
  await seedUser({ id: "u-admin", role: "ADMIN" });
  await seedPayment({
    id: "pay-admin",
    userId: "u-admin",
    plan: "PRO",
    amount: 599_000,
    periodDays: 365,
    status: "FAILED",
    createdAt: new Date(NOW.getTime() - 10 * HOUR_MS),
  });

  // Case G: Internal domain user -> SUPPRESSED
  await seedUser({ id: "u-internal", email: "founder@aoacademy.co" });
  await seedPayment({
    id: "pay-internal",
    userId: "u-internal",
    plan: "PRO",
    amount: 599_000,
    periodDays: 365,
    status: "FAILED",
    createdAt: new Date(NOW.getTime() - 10 * HOUR_MS),
  });

  // Case H: Too recent (<2h) and too old (>7d) -> outside window, not checked
  await seedUser({ id: "u-too-recent" });
  await seedPayment({
    id: "pay-too-recent",
    userId: "u-too-recent",
    createdAt: new Date(NOW.getTime() - 1 * HOUR_MS),
  });
  await seedUser({ id: "u-too-old" });
  await seedPayment({
    id: "pay-too-old",
    userId: "u-too-old",
    createdAt: new Date(NOW.getTime() - 8 * DAY_MS),
  });

  // Case I: Credits-pack failed payment -> SUPPRESSED
  await seedUser({ id: "u-credits" });
  await seedPayment({
    id: "pay-credits",
    userId: "u-credits",
    plan: "PRO",
    amount: 19_900,
    periodDays: 0,
    note: "credits",
    createdAt: new Date(NOW.getTime() - 10 * HOUR_MS),
  });

  const notifications: Array<{ userId: string; type: string; title: string; body: string; link?: string | null }> = [];
  const emails: Array<{ to: string; subject: string; title: string; body: string; cta: string; pricingUrl: string }> = [];
  const telemetryEvents: Array<{ userId: string | null; input: Record<string, unknown> }> = [];

  const deps = {
    createNotification: async (input: { userId: string; type: string; title: string; body: string; link?: string | null }) => {
      notifications.push(input);
      return {} as never;
    },
    sendEmail: async (input: { to: string; subject: string; title: string; body: string; cta: string; pricingUrl: string }) => {
      emails.push(input);
      return true;
    },
    recordTelemetry: async (userId: string | null, input: Record<string, unknown>) => {
      telemetryEvents.push({ userId, input });
      return {} as never;
    },
    emailEnabled: () => true,
  };

  // Run 1: Only u-annual-pro and u-multi-fail should be nudged (1 each = 2 total).
  const run1 = await server.sendDueCheckoutRecoveryReminders(NOW, deps as never);
  assert.equal(run1.checked, 8, "8 users have failed payments in the 2h..7d window");
  assert.equal(run1.eligible, 2);
  assert.equal(run1.suppressed, 6);
  assert.equal(run1.claimed, 2);
  assert.equal(run1.sent, 2);
  assert.equal(run1.failed, 0);

  assert.equal(notifications.length, 2);
  assert.equal(emails.length, 2);

  const proNotif = notifications.find((n) => n.userId === "u-annual-pro");
  assert.ok(proNotif, "u-annual-pro received in-app notification");
  assert.equal(proNotif.link, "/pricing?source=checkout_recovery&plan=PRO&cycle=annual");
  assert.match(proNotif.body, /5,990 บาท/);

  const multiNotif = notifications.find((n) => n.userId === "u-multi-fail");
  assert.ok(multiNotif, "u-multi-fail received exactly one notification");
  assert.equal(
    multiNotif.link,
    "/pricing?source=checkout_recovery&plan=BUSINESS&cycle=annual",
    "newest failed attempt (BUSINESS annual) wins when user had multiple failed attempts",
  );

  const proEmail = emails.find((e) => e.to === "u-annual-pro@example.test");
  assert.ok(proEmail, "u-annual-pro received recovery email");
  assert.equal(
    proEmail.pricingUrl,
    "https://studio.example.test/pricing?source=checkout_recovery&plan=PRO&cycle=annual",
  );

  // Verify claims exist in TelemetryEvent and contain zero customer email/PII.
  const claimRows = await prisma.telemetryEvent.findMany({
    where: { name: pure.CHECKOUT_RECOVERY_CLAIM_EVENT },
  });
  assert.equal(claimRows.length, 2);
  assert.deepEqual(
    claimRows.map((r) => r.dedupeKey).sort(),
    [
      pure.checkoutRecoveryDedupeKey(payAnnualPro),
      pure.checkoutRecoveryDedupeKey(payMultiNewest),
    ].sort(),
  );
  for (const row of claimRows) {
    assert.equal(row.status, "DELIVERED");
    assert.ok(!String(row.properties ?? "").includes("@"), "no email/PII in claim telemetry");
  }
  assert.equal(telemetryEvents.length, 4, "2 users x (notification + email) delivery events");
  for (const ev of telemetryEvents) {
    assert.equal(ev.input.name, pure.CHECKOUT_RECOVERY_DELIVERY_EVENT);
    assert.ok(!JSON.stringify(ev.input).includes("@"), "no email/PII in delivery telemetry");
  }

  // Run 2 (immediate rerun): Strictly idempotent — 0 claimed, 0 sent.
  const run2 = await server.sendDueCheckoutRecoveryReminders(NOW, deps as never);
  assert.equal(run2.claimed, 0);
  assert.equal(run2.sent, 0);
  assert.equal(notifications.length, 2, "no duplicate notification on rerun");
  assert.equal(emails.length, 2, "no duplicate email on rerun");

  // Case J: 14-day user cooldown — u-annual-pro fails AGAIN 5 days later -> SUPPRESSED!
  // Note: u-too-recent (1h old at NOW) has now crossed the 2h threshold and legitimately qualifies on day 5.
  const day5 = new Date(NOW.getTime() + 5 * DAY_MS);
  await seedPayment({
    id: "pay-annual-pro-day5",
    userId: "u-annual-pro",
    plan: "PRO",
    amount: 599_000,
    periodDays: 365,
    status: "FAILED",
    createdAt: new Date(day5.getTime() - 4 * HOUR_MS),
  });
  const runDay5 = await server.sendDueCheckoutRecoveryReminders(day5, deps as never);
  assert.equal(runDay5.sent, 1, "only u-too-recent (now 5d+1h old) qualifies on day 5");
  assert.equal(runDay5.claimed, 1);
  assert.equal(
    notifications.filter((n) => n.userId === "u-too-recent").length,
    1,
    "u-too-recent qualifies once past 2h",
  );
  assert.equal(
    notifications.filter((n) => n.userId === "u-annual-pro").length,
    1,
    "14-day cooldown suppresses u-annual-pro's new failed checkout on day 5",
  );
  assert.equal(
    await prisma.telemetryEvent.findUnique({
      where: { dedupeKey: pure.checkoutRecoveryDedupeKey("pay-annual-pro-day5") },
    }),
    null,
    "no claim row written for cooldown-suppressed payment",
  );

  // Case K: After 14-day cooldown elapses (day 15), a new failed checkout IS eligible!
  const day15 = new Date(NOW.getTime() + 15 * DAY_MS);
  await seedPayment({
    id: "pay-annual-pro-day15",
    userId: "u-annual-pro",
    plan: "PRO",
    amount: 59_900,
    periodDays: 30,
    status: "FAILED",
    createdAt: new Date(day15.getTime() - 4 * HOUR_MS),
  });
  const runDay15 = await server.sendDueCheckoutRecoveryReminders(day15, deps as never);
  assert.equal(runDay15.eligible, 1);
  assert.equal(runDay15.claimed, 1);
  assert.equal(runDay15.sent, 1, "after 14-day cooldown, new failed checkout is recovered");
  const annualProNotifs = notifications.filter((n) => n.userId === "u-annual-pro");
  assert.equal(annualProNotifs.length, 2);
  assert.equal(
    annualProNotifs[1]?.link,
    "/pricing?source=checkout_recovery&plan=PRO&cycle=monthly",
  );

  // Case L: Email switch OFF -> delivers notification only, does not attempt email.
  await seedUser({ id: "u-notif-only" });
  const payNotifOnly = await seedPayment({
    id: "pay-notif-only",
    userId: "u-notif-only",
    plan: "PRO",
    amount: 59_900,
    periodDays: 30,
    status: "FAILED",
    createdAt: new Date(day15.getTime() - 3 * HOUR_MS),
  });
  const emailCountBefore = emails.length;
  const runQuiet = await server.sendDueCheckoutRecoveryReminders(day15, {
    ...deps,
    emailEnabled: () => false,
  } as never);
  assert.equal(runQuiet.sent, 1);
  assert.equal(emails.length, emailCountBefore, "email not sent when email flag is off");
  const quietClaim = await prisma.telemetryEvent.findUniqueOrThrow({
    where: { dedupeKey: pure.checkoutRecoveryDedupeKey(payNotifOnly) },
  });
  assert.equal(quietClaim.status, "DELIVERED");
  assert.match(String(quietClaim.properties), /"emailAttempted":false/);

  // Case M: Duplicate claim race (P2002) handled gracefully without throwing.
  await seedUser({ id: "u-race" });
  const payRace = await seedPayment({
    id: "pay-race",
    userId: "u-race",
    plan: "PRO",
    amount: 599_000,
    periodDays: 365,
    status: "FAILED",
    createdAt: new Date(day15.getTime() - 3 * HOUR_MS),
  });
  // Seed a claim with the exact dedupeKey dated >14d ago so cooldown doesn't fire first, forcing P2002.
  await prisma.telemetryEvent.create({
    data: {
      dedupeKey: pure.checkoutRecoveryDedupeKey(payRace),
      userId: "u-race",
      name: pure.CHECKOUT_RECOVERY_CLAIM_EVENT,
      category: "product",
      source: "server",
      status: "DELIVERED",
      createdAt: new Date(day15.getTime() - 20 * DAY_MS),
    },
  });
  const runRace = await server.sendDueCheckoutRecoveryReminders(day15, deps as never);
  assert.equal(runRace.claimed, 0, "P2002 duplicate claim is skipped gracefully");
  assert.equal(runRace.sent, 0);

  // Case N: Delivery failure accounting when both notification and email fail.
  await seedUser({ id: "u-fail-delivery" });
  const payFailDelivery = await seedPayment({
    id: "pay-fail-delivery",
    userId: "u-fail-delivery",
    plan: "PRO",
    amount: 599_000,
    periodDays: 365,
    status: "FAILED",
    createdAt: new Date(day15.getTime() - 3 * HOUR_MS),
  });
  const runFail = await server.sendDueCheckoutRecoveryReminders(day15, {
    ...deps,
    createNotification: async () => {
      throw new Error("simulated_db_error");
    },
    sendEmail: async () => false,
  } as never);
  assert.equal(runFail.claimed, 1);
  assert.equal(runFail.sent, 0);
  assert.equal(runFail.failed, 1);
  const failClaim = await prisma.telemetryEvent.findUniqueOrThrow({
    where: { dedupeKey: pure.checkoutRecoveryDedupeKey(payFailDelivery) },
  });
  assert.equal(failClaim.status, "FAILED");

  await prisma.$disconnect();
  console.log(
    "verify-checkout-recovery-reminder: PASS pure rules, DB sweep, suppression (later_paid/active_sub/suspended/admin/internal/credits/multi-fail/14d-cooldown), P2002 idempotency, email toggle, failure accounting",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
