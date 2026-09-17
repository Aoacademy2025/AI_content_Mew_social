import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HERO-33 — past_due dunning against a throwaway SQLite: at-most-once per invoice,
// entitled-vs-lapsed copy, the +3-day follow-up, recovery, and the admin cohort count.
const testDir = mkdtempSync(join(tmpdir(), "past-due-dunning-"));
process.env.DATABASE_URL = `file:${join(testDir, "test.db")}`;
process.env.NEXTAUTH_URL = "https://studio.example.test";
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

const NOW = new Date("2026-09-17T02:00:00Z"); // 09:00 Bangkok
const DAY_MS = 24 * 60 * 60 * 1_000;

async function main() {
  const [{ prisma }, dunning, cohorts] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/past-due-dunning.server"),
    import("../src/lib/revenue-cohorts"),
  ]);
  const { deliverPastDueReminder, sendDuePastDueFollowUps } = dunning;

  async function createUser(input: {
    id: string;
    plan?: "PRO" | "BUSINESS" | "FREE";
    planExpiresAt: Date | null;
    subStatus?: string;
    email?: string;
    role?: "USER" | "ADMIN";
    suspended?: boolean;
  }) {
    await prisma.user.create({
      data: {
        id: input.id,
        name: input.id,
        email: input.email ?? `${input.id}@example.test`,
        role: input.role ?? "USER",
        plan: input.plan ?? "PRO",
        billingPeriod: "monthly",
        planExpiresAt: input.planExpiresAt,
        stripeSubscriptionId: `sub-${input.id}`,
        stripeCustomerId: `cus-${input.id}`,
        subStatus: input.subStatus ?? "past_due",
        suspended: input.suspended ?? false,
      },
    });
  }

  const notifications: Array<Record<string, unknown>> = [];
  const emails: Array<Record<string, unknown>> = [];
  const telemetry: Array<Record<string, unknown>> = [];
  const deps = {
    createNotification: async (input: Record<string, unknown>) => { notifications.push(input); return {} as never; },
    sendEmail: async (input: Record<string, unknown>) => { emails.push(input); return true; },
    recordTelemetry: async (_userId: string | null, input: Record<string, unknown>) => { telemetry.push(input); return {} as never; },
    emailEnabled: () => true,
  };

  // 1. Renewal failed mid-cycle → still entitled copy, both channels, one log row.
  await createUser({ id: "pd-entitled", planExpiresAt: new Date(NOW.getTime() + 20 * DAY_MS) });
  const first = await deliverPastDueReminder({ userId: "pd-entitled", stripeInvoiceId: "in_1", kind: "failed" }, NOW, deps as never);
  assert.equal(first.outcome, "delivered");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "LIMIT_WARNING");
  assert.equal(notifications[0].link, "/settings?tab=billing&source=past_due");
  assert.match(String(notifications[0].body), /ใช้งานต่อไม่สะดุด/, "entitled copy: tier is intact");
  assert.equal(emails.length, 1);
  assert.equal(emails[0].billingUrl, "https://studio.example.test/settings?tab=billing&source=past_due");
  assert.equal(emails[0].cta, "อัปเดตบัตร");
  assert.equal(telemetry.length, 2);

  // 2. Stripe retries the same invoice → same event shape again → no second message.
  const dup = await deliverPastDueReminder({ userId: "pd-entitled", stripeInvoiceId: "in_1", kind: "failed" }, NOW, deps as never);
  assert.equal(dup.outcome, "duplicate");
  assert.equal(notifications.length, 1, "retry of the same invoice sends nothing");
  assert.equal(emails.length, 1);
  assert.equal(await prisma.pastDueReminderLog.count({ where: { userId: "pd-entitled" } }), 1);

  // 3. Committed Trial whose first charge failed → already FREE → lapsed copy.
  await createUser({ id: "pd-lapsed", plan: "FREE", planExpiresAt: new Date(NOW.getTime() - 1 * DAY_MS) });
  await deliverPastDueReminder({ userId: "pd-lapsed", stripeInvoiceId: "in_2", kind: "failed" }, NOW, deps as never);
  assert.match(String(notifications[1].title), /หยุดชั่วคราว/, "lapsed copy: tier already gone");
  assert.match(String(emails[1].cta), /กลับมาใช้ PRO/);

  // 4. Email switch off → notification only, log says email not attempted.
  await createUser({ id: "pd-noemail", planExpiresAt: new Date(NOW.getTime() + 5 * DAY_MS) });
  const quiet = await deliverPastDueReminder(
    { userId: "pd-noemail", stripeInvoiceId: "in_3", kind: "failed" },
    NOW,
    { ...deps, emailEnabled: () => false } as never,
  );
  assert.equal(quiet.outcome, "delivered");
  assert.equal(emails.length, 2, "no email when PAST_DUE_DUNNING_EMAIL is off");
  const quietLog = await prisma.pastDueReminderLog.findFirstOrThrow({ where: { userId: "pd-noemail" } });
  assert.equal(quietLog.emailAttempted, false);
  assert.equal(quietLog.status, "DELIVERED");

  // 5. Internal / suspended accounts are skipped without a claim.
  await createUser({ id: "pd-internal", planExpiresAt: new Date(NOW.getTime() + 5 * DAY_MS), email: "pd@aoacademy.co" });
  const internal = await deliverPastDueReminder({ userId: "pd-internal", stripeInvoiceId: "in_4", kind: "failed" }, NOW, deps as never);
  assert.equal(internal.outcome, "skipped");
  assert.equal(await prisma.pastDueReminderLog.count({ where: { userId: "pd-internal" } }), 0);

  // 6. Follow-up sweep: too early on day 2, fires once on day 3, never again.
  const day2 = new Date(NOW.getTime() + 2 * DAY_MS);
  const early = await sendDuePastDueFollowUps(day2, deps as never);
  assert.equal(early.sent, 0);
  assert.equal(early.tooEarly, 3, "entitled, lapsed and no-email claims are all too early on day 2");

  // pd-noemail recovers before day 3 (invoice.paid → active): no follow-up for them.
  await prisma.user.update({ where: { id: "pd-noemail" }, data: { subStatus: "active" } });

  const day3 = new Date(NOW.getTime() + 3 * DAY_MS);
  const notificationsBefore = notifications.length;
  const followUp = await sendDuePastDueFollowUps(day3, deps as never);
  assert.equal(followUp.checked, 3);
  assert.equal(followUp.sent, 2, "entitled + lapsed get the d3 nudge");
  assert.equal(followUp.recovered, 1, "the recovered account is left alone");
  assert.equal(notifications.length, notificationsBefore + 2);
  assert.match(String(notifications[notificationsBefore].title), /ยังเก็บเงินไม่ได้|ยังหยุดอยู่/);
  assert.equal(await prisma.pastDueReminderLog.count({ where: { kind: "d3" } }), 2);

  const again = await sendDuePastDueFollowUps(new Date(day3.getTime() + 5 * DAY_MS), deps as never);
  assert.equal(again.sent, 0, "d3 fires once per invoice");
  assert.equal(again.duplicateClaimsSkipped, 2);

  // 7. Failed channels are recorded, never counted as sent.
  await createUser({ id: "pd-broken", planExpiresAt: new Date(NOW.getTime() + 5 * DAY_MS) });
  const broken = await deliverPastDueReminder(
    { userId: "pd-broken", stripeInvoiceId: "in_5", kind: "failed" },
    NOW,
    {
      createNotification: async () => { throw new Error("down"); },
      sendEmail: async () => false,
      recordTelemetry: async () => ({} as never),
      emailEnabled: () => true,
    } as never,
  );
  assert.equal(broken.outcome, "failed");
  const brokenLog = await prisma.pastDueReminderLog.findFirstOrThrow({ where: { userId: "pd-broken" } });
  assert.equal(brokenLog.status, "FAILED");
  assert.equal(brokenLog.failureCode, "notification_and_email_failed");

  // 8. Admin cohort: past_due count splits entitled vs lapsed; never enters payingTotal.
  const users = await prisma.user.findMany();
  const result = cohorts.computeRevenueCohorts(
    users.map((u) => ({ ...u, email: u.email ?? "" })) as never,
    new Set<string>(),
    { pro: 599, business: 990 } as never,
    NOW,
  );
  // pd-entitled, pd-lapsed, pd-broken are past_due (pd-noemail recovered, pd-internal is team).
  assert.equal(result.pastDue.users, 3);
  assert.equal(result.pastDue.stillEntitled, 2);
  assert.equal(result.pastDue.lapsed, 1);
  assert.equal(result.payingTotal, 0, "past_due never counts as cash");

  await prisma.$disconnect();
  console.log("verify-past-due-dunning-server: PASS per-invoice dedupe, copy split, d3 follow-up, recovery, admin cohort");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
