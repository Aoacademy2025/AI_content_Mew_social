import "server-only";

import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { sendPastDueEmail } from "@/lib/send-email";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { isInternalNorthStarAccount } from "@/lib/subscription-north-star.server";
import {
  isStillEntitled,
  pastDueDeliveryStatus,
  pastDueFailureCode,
  pastDueFollowUpDecision,
  pastDueReminderCopy,
  PAST_DUE_LINK,
  type PastDueReminderKind,
} from "@/lib/past-due-dunning";

/**
 * HERO-33. The in-app notification always fires (it replaces the one the webhook used
 * to write inline). Email is a separate opt-in so Mew can keep Stripe's own dunning
 * emails as the only sender until she has checked they are off — two senders for one
 * failed charge reads as spam.
 */
export function pastDueEmailEnabled(): boolean {
  return process.env.PAST_DUE_DUNNING_EMAIL === "1";
}

type PastDueDeps = {
  createNotification?: typeof createNotification;
  sendEmail?: typeof sendPastDueEmail;
  recordTelemetry?: typeof recordTelemetryEvent;
  emailEnabled?: () => boolean;
};

export type PastDueDeliveryResult = {
  outcome: "delivered" | "partial" | "failed" | "duplicate" | "skipped";
  reason?: "internal" | "no_user";
};

function isUniqueClaimError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "P2002";
}

function appOrigin(): string {
  return (process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
}

/**
 * Claim-then-deliver for one (user, invoice, kind). The unique log row is written before
 * either channel is touched, so Stripe retrying `invoice.payment_failed` for the same
 * invoice, or two cron workers, can never double-send.
 */
export async function deliverPastDueReminder(
  input: { userId: string; stripeInvoiceId: string; kind: PastDueReminderKind },
  now: Date = new Date(),
  deps: PastDueDeps = {},
): Promise<PastDueDeliveryResult> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true, role: true, plan: true, planExpiresAt: true, suspended: true },
  });
  if (!user) return { outcome: "skipped", reason: "no_user" };
  if (user.suspended || isInternalNorthStarAccount(user)) return { outcome: "skipped", reason: "internal" };

  let claim: { id: string };
  try {
    claim = await prisma.pastDueReminderLog.create({
      data: { userId: user.id, stripeInvoiceId: input.stripeInvoiceId, kind: input.kind, attemptedAt: now },
      select: { id: true },
    });
  } catch (error) {
    if (isUniqueClaimError(error)) return { outcome: "duplicate" };
    throw error;
  }

  const notify = deps.createNotification ?? createNotification;
  const email = deps.sendEmail ?? sendPastDueEmail;
  const telemetry = deps.recordTelemetry ?? recordTelemetryEvent;
  const emailOn = (deps.emailEnabled ?? pastDueEmailEnabled)();

  const stillEntitled = isStillEntitled(user, now);
  const copy = pastDueReminderCopy({ kind: input.kind, plan: user.plan, stillEntitled });

  let notificationDelivered = false;
  let emailAttempted = false;
  let emailDelivered = false;

  try {
    await notify({ userId: user.id, type: "LIMIT_WARNING", title: copy.title, body: copy.body, link: PAST_DUE_LINK });
    notificationDelivered = true;
  } catch {
    notificationDelivered = false;
  }

  if (emailOn && user.email) {
    emailAttempted = true;
    emailDelivered = await email({
      to: user.email,
      title: copy.title,
      body: copy.body,
      cta: copy.cta,
      billingUrl: `${appOrigin()}${PAST_DUE_LINK}`,
    }).catch(() => false);
  }

  const status = pastDueDeliveryStatus({ notificationDelivered, emailAttempted, emailDelivered });
  await prisma.pastDueReminderLog.update({
    where: { id: claim.id },
    data: {
      status,
      notificationDelivered,
      emailAttempted,
      emailDelivered,
      failureCode: pastDueFailureCode({ notificationDelivered, emailAttempted, emailDelivered }),
      completedAt: now,
    },
  });

  for (const [channel, attempted, delivered] of [
    ["notification", true, notificationDelivered],
    ["email", emailAttempted, emailDelivered],
  ] as const) {
    if (!attempted) continue;
    await telemetry(user.id, {
      name: "past_due_reminder_delivery",
      category: delivered ? "product" : "error",
      source: "server",
      status: delivered ? "done" : "error",
      properties: { kind: input.kind, channel, stillEntitled },
    }).catch(() => {});
  }

  return { outcome: status === "DELIVERED" ? "delivered" : status === "PARTIAL" ? "partial" : "failed" };
}

export type PastDueFollowUpRun = {
  checked: number;
  sent: number;
  duplicateClaimsSkipped: number;
  tooEarly: number;
  recovered: number;
  deliveryFailed: number;
};

/**
 * Daily sweep (rides the `renewal-reminders` cron): every `failed` claim whose account is
 * still past_due after 3 Bangkok days gets one `d3` follow-up for the same invoice.
 * An account that recovered (`invoice.paid` set subStatus back to active) or cancelled is
 * counted and left alone — the claim table is what stops a second message, not this filter.
 */
export async function sendDuePastDueFollowUps(
  now: Date = new Date(),
  deps: PastDueDeps = {},
): Promise<PastDueFollowUpRun> {
  const failedClaims = await prisma.pastDueReminderLog.findMany({
    where: { kind: "failed" },
    select: {
      userId: true,
      stripeInvoiceId: true,
      attemptedAt: true,
      user: { select: { subStatus: true } },
    },
    orderBy: { attemptedAt: "asc" },
  });

  const run: PastDueFollowUpRun = { checked: failedClaims.length, sent: 0, duplicateClaimsSkipped: 0, tooEarly: 0, recovered: 0, deliveryFailed: 0 };
  for (const claim of failedClaims) {
    const decision = pastDueFollowUpDecision({ subStatus: claim.user.subStatus, failedAt: claim.attemptedAt, now });
    if (!decision.send) {
      if (decision.reason === "too_early") run.tooEarly += 1;
      else run.recovered += 1;
      continue;
    }
    const result = await deliverPastDueReminder(
      { userId: claim.userId, stripeInvoiceId: claim.stripeInvoiceId, kind: "d3" },
      now,
      deps,
    );
    if (result.outcome === "duplicate") run.duplicateClaimsSkipped += 1;
    else if (result.outcome === "failed") run.deliveryFailed += 1;
    else if (result.outcome !== "skipped") run.sent += 1;
  }
  return run;
}
