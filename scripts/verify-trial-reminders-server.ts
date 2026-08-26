/**
 * DB-backed proof for the trial-expiry moment (issue #299), against a throwaway SQLite.
 * The pure rules live in scripts/verify-trial-reminders.ts; this covers the parts that
 * only exist against a database: the TrialReminderLog idempotency claim, the candidate
 * query, and the entitlement evidence that keeps a trial out of renewal-reminders.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "trial-reminders-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.TRIAL_REMINDERS = "1";
delete process.env.TRIAL_REMINDERS_EMAIL; // email stays off — notifications only
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

const NOW = new Date("2026-09-10T10:00:00+07:00");
const TWO_DAYS_OUT = new Date("2026-09-12T09:00:00+07:00");
const ENDED_TODAY = new Date("2026-09-10T08:00:00+07:00");
const ENDED_THREE_DAYS_AGO = new Date("2026-09-07T09:00:00+07:00");
const TRIAL_START = new Date("2026-09-05T09:00:00+07:00");

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { sendDueTrialReminders } = await import("../src/lib/trial-reminders.server");
  const { resolvePaidEquivalentEntitlement } = await import("../src/lib/paid-equivalent-entitlement.server");
  const { isTrialSourcedPlan, TRIAL_REMINDER_SOURCE } = await import("../src/lib/trial-reminders");

  async function mkUser(id: string, data: Record<string, unknown>) {
    return prisma.user.create({
      data: { id, name: id, email: `${id}@example.invalid`, ...data },
    });
  }
  async function mkClip(userId: string, expiresAt: Date | null) {
    return prisma.video.create({
      data: {
        userId,
        avatarModel: "none",
        voiceModel: "gemini",
        sceneCount: 1,
        status: "COMPLETED",
        videoUrl: `/renders/${userId}-${Math.random().toString(36).slice(2)}.mp4`,
        expiresAt,
      },
    });
  }

  // Two days left, two clips still in the library.
  await mkUser("u-d5", { plan: "PRO", planExpiresAt: TWO_DAYS_OUT, trialStartedAt: TRIAL_START, trialEndsAt: TWO_DAYS_OUT });
  await mkClip("u-d5", new Date("2026-09-14T09:00:00+07:00"));
  await mkClip("u-d5", new Date("2026-09-15T09:00:00+07:00"));

  // Expiry day — already reverted by the 08:00 trial-expiry cron, so the end date is
  // only readable through trialEndedAt.
  await mkUser("u-expiry", { plan: "FREE", trialStartedAt: TRIAL_START, trialEndsAt: null, trialEndedAt: ENDED_TODAY });

  // Day +3 with an export, and day +3 without one (must stay silent).
  await mkUser("u-d3", { plan: "FREE", trialStartedAt: new Date("2026-09-01T09:00:00+07:00"), trialEndedAt: ENDED_THREE_DAYS_AGO });
  await mkClip("u-d3", new Date("2026-09-08T09:00:00+07:00"));
  await mkUser("u-d3-noexport", { plan: "FREE", trialStartedAt: new Date("2026-09-01T09:00:00+07:00"), trialEndedAt: ENDED_THREE_DAYS_AGO });

  // Trial user who converted to a paid term — never a lead.
  const paid = await mkUser("u-paid", {
    plan: "PRO",
    planExpiresAt: TWO_DAYS_OUT,
    trialStartedAt: TRIAL_START,
    trialEndsAt: TWO_DAYS_OUT,
  });
  await prisma.payment.create({
    data: { userId: paid.id, stripeSessionId: "cs_trial_paid", plan: "PRO", amount: 59900, status: "PAID", periodDays: 30, paidAt: TRIAL_START },
  });

  // Internal account and a suspended account.
  await mkUser("u-admin", { role: "ADMIN", plan: "PRO", trialStartedAt: TRIAL_START, trialEndsAt: TWO_DAYS_OUT });
  await mkUser("u-suspended", { plan: "PRO", suspended: true, trialStartedAt: TRIAL_START, trialEndsAt: TWO_DAYS_OUT });

  // ── run 1 ──────────────────────────────────────────────────────────────────
  const first = await sendDueTrialReminders(NOW);
  assert.equal(first.sent, 3, `exactly the three due moments are sent (got ${first.sent})`);
  assert.deepEqual(first.byKind, { d5: 1, expiry: 1, d3after: 1 });

  const notified = await prisma.notification.findMany({ select: { userId: true, body: true, link: true, type: true } });
  assert.deepEqual(
    notified.map((n) => n.userId).sort(),
    ["u-d3", "u-d5", "u-expiry"],
    "paid, internal, suspended and export-less accounts are excluded",
  );

  const d5 = notified.find((n) => n.userId === "u-d5")!;
  assert.match(d5.body, /2 ชิ้น/, "day-5 copy quotes the customer's real live clip count");
  assert.equal(d5.link, `/pricing?source=${TRIAL_REMINDER_SOURCE.d5}`);
  assert.equal(d5.type, "LIMIT_WARNING");
  assert.equal(notified.find((n) => n.userId === "u-expiry")!.link, `/pricing?source=${TRIAL_REMINDER_SOURCE.expiry}`);
  assert.equal(notified.find((n) => n.userId === "u-d3")!.link, `/pricing?source=${TRIAL_REMINDER_SOURCE.d3after}`);

  const sentEvents = await prisma.telemetryEvent.findMany({ where: { name: "trial_reminder_sent" }, select: { properties: true } });
  assert.equal(sentEvents.length, 3, "one trial_reminder_sent per delivered notification");
  assert.equal(
    sentEvents.every((e) => (e.properties ?? "").includes('"channel":"notification"')),
    true,
    "email channel is not reported while TRIAL_REMINDERS_EMAIL is off",
  );

  // ── run 2 (same day retry) ────────────────────────────────────────────────
  const second = await sendDueTrialReminders(NOW);
  assert.equal(second.sent, 0, "a re-run sends nothing");
  assert.equal(await prisma.notification.count(), 3, "no duplicate notifications");
  assert.equal(await prisma.trialReminderLog.count(), 3, "one dedupe row per (user, kind)");

  // ── the same user reaching a LATER moment still gets it ───────────────────
  await prisma.user.update({ where: { id: "u-d5" }, data: { plan: "FREE", planExpiresAt: null, trialEndsAt: null, trialEndedAt: ENDED_TODAY } });
  const third = await sendDueTrialReminders(NOW);
  assert.equal(third.sent, 1, "a different kind for the same user is still deliverable");
  assert.deepEqual(third.byKind, { d5: 0, expiry: 1, d3after: 0 });

  // ── renewal-reminders exclusion, on real entitlement evidence ─────────────
  const trialOnly = await prisma.user.findUniqueOrThrow({ where: { id: "u-expiry" }, select: { trialStartedAt: true } });
  const trialEntitlement = await resolvePaidEquivalentEntitlement("u-paid", NOW);
  assert.equal(trialEntitlement.canUsePaidFeatures, true, "a paid term is real entitlement evidence");
  assert.equal(
    isTrialSourcedPlan({ trialStartedAt: TRIAL_START, trialEndsAt: TWO_DAYS_OUT, paidEquivalent: trialEntitlement.canUsePaidFeatures }),
    false,
    "a trial user who paid still receives renewal reminders",
  );

  const bareTrial = await mkUser("u-trial-only", { plan: "PRO", planExpiresAt: TWO_DAYS_OUT, trialStartedAt: TRIAL_START, trialEndsAt: TWO_DAYS_OUT });
  const bareEntitlement = await resolvePaidEquivalentEntitlement(bareTrial.id, NOW);
  assert.equal(bareEntitlement.canUsePaidFeatures, false, "a trial alone is never paid-equivalent evidence");
  assert.equal(
    isTrialSourcedPlan({ trialStartedAt: TRIAL_START, trialEndsAt: TWO_DAYS_OUT, paidEquivalent: bareEntitlement.canUsePaidFeatures }),
    true,
    "an unconverted trial is excluded from renewal reminders",
  );
  assert.ok(trialOnly.trialStartedAt, "trial evidence survives the revert");

  // ── the revert preserves the date and emits trial_expired ─────────────────
  const expiring = await mkUser("u-revert", {
    plan: "PRO",
    planExpiresAt: new Date("2026-09-09T09:00:00+07:00"),
    trialStartedAt: new Date("2026-09-02T09:00:00+07:00"),
    trialEndsAt: new Date("2026-09-09T09:00:00+07:00"),
    minutesUsed: 12.5,
  });
  await mkClip(expiring.id, new Date("2026-09-16T09:00:00+07:00"));
  const { revertExpiredEntitlements } = await import("../src/lib/entitlements");
  await revertExpiredEntitlements(NOW);
  const reverted = await prisma.user.findUniqueOrThrow({ where: { id: expiring.id } });
  assert.equal(reverted.plan, "FREE");
  assert.equal(reverted.trialEndsAt, null, "trialEndsAt clearing semantics are unchanged");
  assert.equal(reverted.trialEndedAt?.toISOString(), new Date("2026-09-09T09:00:00+07:00").toISOString(), "the expiry date is preserved");

  const expired = await prisma.telemetryEvent.findMany({ where: { name: "trial_expired" }, select: { properties: true, userId: true } });
  assert.equal(expired.length, 1, "one trial_expired event");
  assert.equal(expired[0].userId, expiring.id);
  const props = JSON.parse(expired[0].properties ?? "{}");
  assert.equal(props.hadFirstExport, true);
  assert.equal(props.exportsCount, 1);
  assert.equal(props.minutesUsed, 12.5, "minutesUsed is captured BEFORE the FREE window reset");

  await revertExpiredEntitlements(NOW);
  assert.equal(await prisma.telemetryEvent.count({ where: { name: "trial_expired" } }), 1, "trial_expired is emitted once per user");

  await prisma.$disconnect();
  console.log("verify-trial-reminders-server: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
