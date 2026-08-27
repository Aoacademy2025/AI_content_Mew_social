import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "renewal-reminders-"));
process.env.DATABASE_URL = `file:${join(testDir, "test.db")}`;
process.env.NEXTAUTH_URL = "https://studio.example.test";
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

const NOW = new Date("2026-08-27T09:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

async function main() {
  const [{ prisma }, { sendDueRenewalReminders }] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/renewal-reminders.server"),
  ]);

  async function createCandidate(input: {
    id: string;
    now: Date;
    daysLeft: number;
    plan?: "PRO" | "BUSINESS";
    email?: string;
    role?: "USER" | "ADMIN";
    stripeSubscriptionId?: string | null;
    payment?: "plan" | "credits" | "stale" | "none";
  }) {
    const plan = input.plan ?? "PRO";
    const expiresAt = new Date(input.now.getTime() + input.daysLeft * DAY_MS);
    await prisma.user.create({
      data: {
        id: input.id,
        name: input.id,
        email: input.email ?? `${input.id}@example.test`,
        role: input.role ?? "USER",
        plan,
        billingPeriod: "annual",
        planExpiresAt: expiresAt,
        stripeSubscriptionId: input.stripeSubscriptionId ?? null,
      },
    });
    if (input.payment !== "none") {
      const paidAt = input.payment === "stale"
        ? new Date("2024-01-01T00:00:00Z")
        : new Date(expiresAt.getTime() - 365 * DAY_MS);
      await prisma.payment.create({
        data: {
          id: `payment-${input.id}`,
          userId: input.id,
          stripeSessionId: `session-${input.id}`,
          plan,
          amount: input.payment === "credits" ? 19_900 : 299_500,
          periodDays: 365,
          note: input.payment === "credits" ? "credits" : "annual",
          status: "PAID",
          paidAt,
          createdAt: paidAt,
        },
      });
    }
    return expiresAt;
  }

  await prisma.renewalReminderLog.deleteMany();
  await prisma.payment.deleteMany({ where: { id: { startsWith: "payment-renewal-test-" } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: "renewal-test-" } } });

  const paidExpiry = await createCandidate({ id: "renewal-test-paid", now: NOW, daysLeft: 14, payment: "plan" });
  await createCandidate({ id: "renewal-test-credit", now: NOW, daysLeft: 14, payment: "credits" });
  await createCandidate({ id: "renewal-test-stale", now: NOW, daysLeft: 14, payment: "stale" });
  await createCandidate({ id: "renewal-test-no-cash", now: NOW, daysLeft: 14, payment: "none" });
  await createCandidate({
    id: "renewal-test-recurring",
    now: NOW,
    daysLeft: 14,
    payment: "plan",
    stripeSubscriptionId: "sub-renewal-test",
  });
  await createCandidate({
    id: "renewal-test-internal",
    now: NOW,
    daysLeft: 14,
    payment: "plan",
    email: "renewal-test@aoacademy.co",
  });

  const notifications: Array<Record<string, unknown>> = [];
  const emails: Array<Record<string, unknown>> = [];
  const telemetry: Array<Record<string, unknown>> = [];
  const deps = {
    createNotification: async (input: Record<string, unknown>) => {
      notifications.push(input);
      return {} as never;
    },
    sendEmail: async (input: Record<string, unknown>) => {
      emails.push(input);
      return true;
    },
    recordTelemetry: async (_userId: string | null, input: Record<string, unknown>) => {
      telemetry.push(input);
      return {} as never;
    },
  };

  const first = await sendDueRenewalReminders(NOW, deps as never);
  assert.equal(first.cashBacked, 1, "only the current cash-backed manual term is eligible");
  assert.equal(first.claimed, 1);
  assert.equal(first.remindersSent, 1);
  assert.equal(first.notificationDelivered, 1);
  assert.equal(first.emailAttempted, 1);
  assert.equal(first.emailDelivered, 1);
  assert.equal(first.deliveryFailed, 0);
  assert.deepEqual(first.byKind, { d30: 0, d14: 1, d3: 0, d1: 0 });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].link, "/pricing?source=renewal_d14&period=annual#plan-pro");
  assert.equal(emails.length, 1);
  assert.match(String(emails[0].pricingUrl), /source=renewal_d14/);
  assert.equal(telemetry.length, 2, "both delivered channels have an observable result");

  const log = await prisma.renewalReminderLog.findUniqueOrThrow({
    where: { userId_termExpiresAt_kind: { userId: "renewal-test-paid", termExpiresAt: paidExpiry, kind: "d14" } },
  });
  assert.equal(log.status, "DELIVERED");
  assert.equal(log.notificationDelivered, true);
  assert.equal(log.emailAttempted, true);
  assert.equal(log.emailDelivered, true);

  const second = await sendDueRenewalReminders(NOW, deps as never);
  assert.equal(second.claimed, 0, "a retry cannot reclaim the same reminder");
  assert.equal(second.duplicateClaimsSkipped, 1);
  assert.equal(notifications.length, 1, "a retry creates no duplicate notification");
  assert.equal(emails.length, 1, "a retry makes no duplicate email attempt");

  const NOW2 = new Date(NOW.getTime() + 3 * DAY_MS);
  await createCandidate({ id: "renewal-test-failure", now: NOW2, daysLeft: 3, payment: "plan" });
  const failed = await sendDueRenewalReminders(NOW2, {
    createNotification: async () => { throw new Error("notification unavailable"); },
    sendEmail: async () => false,
    recordTelemetry: async () => ({} as never),
  } as never);
  assert.equal(failed.remindersSent, 0, "failed channels are never counted as sent");
  assert.equal(failed.emailAttempted, 1);
  assert.equal(failed.emailDelivered, 0);
  assert.equal(failed.deliveryFailed, 1);
  const failedLog = await prisma.renewalReminderLog.findFirstOrThrow({ where: { userId: "renewal-test-failure" } });
  assert.equal(failedLog.status, "FAILED");
  assert.equal(failedLog.failureCode, "notification_and_email_failed");

  const NOW3 = new Date(NOW.getTime() + 4 * DAY_MS);
  await createCandidate({ id: "renewal-test-concurrent", now: NOW3, daysLeft: 1, payment: "plan" });
  let concurrentNotifications = 0;
  let concurrentEmails = 0;
  const concurrentDeps = {
    createNotification: async () => { concurrentNotifications += 1; return {} as never; },
    sendEmail: async () => { concurrentEmails += 1; return true; },
    recordTelemetry: async () => ({} as never),
  };
  await Promise.all([
    sendDueRenewalReminders(NOW3, concurrentDeps as never),
    sendDueRenewalReminders(NOW3, concurrentDeps as never),
  ]);
  assert.equal(concurrentNotifications, 1, "concurrent cron workers create one notification");
  assert.equal(concurrentEmails, 1, "concurrent cron workers attempt one email");
  assert.equal(
    await prisma.renewalReminderLog.count({ where: { userId: "renewal-test-concurrent", kind: "d1" } }),
    1,
  );

  await prisma.$disconnect();
  console.log("verify-renewal-reminder-server: PASS real DB dedupe, cash cohort and delivery counters");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
