import "server-only";

import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { sendRenewalReminderEmail } from "@/lib/send-email";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { bangkokCalendarDaysBetween } from "@/lib/day21-convert-reminder";
import { isInternalNorthStarAccount } from "@/lib/subscription-north-star.server";
import {
  isCashBackedRenewalTerm,
  renewalDeliveryStatus,
  renewalReminderCopy,
  renewalReminderDecision,
  renewalReminderLink,
  RENEWAL_REMINDER_KINDS,
  type RenewalReminderKind,
} from "@/lib/renewal-reminders";

const DAY_MS = 24 * 60 * 60 * 1_000;

type RenewalDeliveryDeps = {
  createNotification?: typeof createNotification;
  sendEmail?: typeof sendRenewalReminderEmail;
  recordTelemetry?: typeof recordTelemetryEvent;
};

export type RenewalReminderRun = {
  checked: number;
  cashBacked: number;
  claimed: number;
  duplicateClaimsSkipped: number;
  remindersSent: number;
  notificationDelivered: number;
  emailAttempted: number;
  emailDelivered: number;
  deliveryFailed: number;
  byKind: Record<RenewalReminderKind, number>;
};

function emptyRun(checked = 0): RenewalReminderRun {
  return {
    checked,
    cashBacked: 0,
    claimed: 0,
    duplicateClaimsSkipped: 0,
    remindersSent: 0,
    notificationDelivered: 0,
    emailAttempted: 0,
    emailDelivered: 0,
    deliveryFailed: 0,
    byKind: { d30: 0, d14: 0, d3: 0, d1: 0 },
  };
}

function isUniqueClaimError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "P2002";
}

function deliveryFailureCode(input: {
  notificationDelivered: boolean;
  emailAttempted: boolean;
  emailDelivered: boolean;
}): string | null {
  if (!input.notificationDelivered && input.emailAttempted && !input.emailDelivered) return "notification_and_email_failed";
  if (!input.notificationDelivered) return "notification_failed";
  if (input.emailAttempted && !input.emailDelivered) return "email_failed";
  return null;
}

/**
 * Deliver cash-backed, manual-renew reminders. The unique log row is claimed before
 * either channel is touched, making retries and concurrent cron workers at-most-once.
 */
export async function sendDueRenewalReminders(
  now: Date = new Date(),
  deps: RenewalDeliveryDeps = {},
): Promise<RenewalReminderRun> {
  const horizon = new Date(now.getTime() + 31 * DAY_MS);
  const candidates = await prisma.user.findMany({
    where: {
      plan: { in: ["PRO", "BUSINESS"] },
      suspended: false,
      stripeSubscriptionId: null,
      planExpiresAt: { gt: now, lte: horizon },
      payments: {
        some: {
          status: "PAID",
          amount: { gt: 0 },
          periodDays: { gt: 0 },
        },
      },
    },
    select: {
      id: true,
      email: true,
      role: true,
      plan: true,
      billingPeriod: true,
      planExpiresAt: true,
      stripeSubscriptionId: true,
      payments: {
        where: { status: "PAID", amount: { gt: 0 }, periodDays: { gt: 0 } },
        orderBy: { createdAt: "desc" },
        select: {
          plan: true,
          amount: true,
          periodDays: true,
          note: true,
          paidAt: true,
          createdAt: true,
        },
      },
    },
  });

  const run = emptyRun(candidates.length);
  const notify = deps.createNotification ?? createNotification;
  const email = deps.sendEmail ?? sendRenewalReminderEmail;
  const telemetry = deps.recordTelemetry ?? recordTelemetryEvent;
  const origin = (process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");

  for (const candidate of candidates) {
    if (
      !candidate.planExpiresAt
      || isInternalNorthStarAccount(candidate)
      || !isCashBackedRenewalTerm(candidate)
    ) continue;
    run.cashBacked += 1;

    const daysLeft = bangkokCalendarDaysBetween(now, candidate.planExpiresAt);
    const decision = renewalReminderDecision(daysLeft);
    if (!decision.send) continue;
    const { kind } = decision;

    let claim: { id: string };
    try {
      claim = await prisma.renewalReminderLog.create({
        data: {
          userId: candidate.id,
          termExpiresAt: candidate.planExpiresAt,
          kind,
          attemptedAt: now,
        },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueClaimError(error)) {
        run.duplicateClaimsSkipped += 1;
        continue;
      }
      throw error;
    }
    run.claimed += 1;

    const link = renewalReminderLink(kind, candidate.plan, candidate.billingPeriod);
    const copy = renewalReminderCopy(kind, candidate.plan);
    let notificationDelivered = false;
    let emailAttempted = false;
    let emailDelivered = false;

    try {
      await notify({
        userId: candidate.id,
        type: "LIMIT_WARNING",
        title: copy.title,
        body: copy.body,
        link,
      });
      notificationDelivered = true;
      run.notificationDelivered += 1;
    } catch {
      notificationDelivered = false;
    }

    if (candidate.email) {
      emailAttempted = true;
      run.emailAttempted += 1;
      emailDelivered = await email({
        to: candidate.email,
        plan: candidate.plan,
        daysLeft,
        pricingUrl: `${origin}${link}`,
      }).catch(() => false);
      if (emailDelivered) run.emailDelivered += 1;
    }

    const status = renewalDeliveryStatus({ notificationDelivered, emailAttempted, emailDelivered });
    const failureCode = deliveryFailureCode({ notificationDelivered, emailAttempted, emailDelivered });
    await prisma.renewalReminderLog.update({
      where: { id: claim.id },
      data: {
        status,
        notificationDelivered,
        emailAttempted,
        emailDelivered,
        failureCode,
        completedAt: now,
      },
    });

    if (status === "FAILED") run.deliveryFailed += 1;
    else {
      run.remindersSent += 1;
      run.byKind[kind] += 1;
    }

    for (const [channel, attempted, delivered] of [
      ["notification", true, notificationDelivered],
      ["email", emailAttempted, emailDelivered],
    ] as const) {
      if (!attempted) continue;
      await telemetry(candidate.id, {
        name: "renewal_reminder_delivery",
        category: delivered ? "product" : "error",
        source: "server",
        status: delivered ? "done" : "error",
        properties: { kind, channel },
      }).catch(() => {});
    }
  }

  return run;
}

export { RENEWAL_REMINDER_KINDS };
