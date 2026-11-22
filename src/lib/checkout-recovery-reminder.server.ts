import "server-only";

import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { sendCheckoutRecoveryEmail } from "@/lib/send-email";
import { recordTelemetryEvent } from "@/lib/telemetry";
import {
  CHECKOUT_RECOVERY_CLAIM_EVENT,
  CHECKOUT_RECOVERY_DELIVERY_EVENT,
  CHECKOUT_RECOVERY_MAX_AGE_DAYS,
  CHECKOUT_RECOVERY_MIN_AGE_HOURS,
  CHECKOUT_RECOVERY_USER_COOLDOWN_DAYS,
  checkoutRecoveryCopy,
  checkoutRecoveryDecision,
  checkoutRecoveryDeliveryStatus,
  isCheckoutRecoveryPlan,
} from "@/lib/checkout-recovery-reminder";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export function checkoutRecoveryEmailEnabled(): boolean {
  return process.env.PAID_ACTIVATION_EMAIL === "1";
}

export type CheckoutRecoveryDeps = {
  createNotification?: typeof createNotification;
  sendEmail?: typeof sendCheckoutRecoveryEmail;
  recordTelemetry?: typeof recordTelemetryEvent;
  emailEnabled?: () => boolean;
};

export type CheckoutRecoveryRun = {
  checked: number;
  eligible: number;
  suppressed: number;
  claimed: number;
  sent: number;
  failed: number;
};

function isUniqueClaimError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "P2002";
}

function appOrigin(): string {
  return (process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
}

/**
 * HERO-111 — Daily sweep (rides `/api/cron/renewal-reminders`) for abandoned/failed paid
 * checkouts (Annual & Monthly) aged between 2 hours and 7 days.
 *
 * Guarantees:
 * - Deduplicates multiple failed attempts per user (evaluates newest failed plan attempt first).
 * - Suppresses users who subsequently paid, have an active paid Stripe subscription, are
 *   suspended/admin/internal, or already received a recovery nudge within 14 days.
 * - Claims atomically via `TelemetryEvent.dedupeKey` (`checkout_recovery:${paymentId}`)
 *   before touching either delivery channel so retries and concurrent workers are at-most-once.
 * - Never stores customer email or PII in telemetry events.
 */
export async function sendDueCheckoutRecoveryReminders(
  now: Date = new Date(),
  deps: CheckoutRecoveryDeps = {},
): Promise<CheckoutRecoveryRun> {
  const minCreatedAt = new Date(now.getTime() - CHECKOUT_RECOVERY_MAX_AGE_DAYS * DAY_MS);
  const maxCreatedAt = new Date(now.getTime() - CHECKOUT_RECOVERY_MIN_AGE_HOURS * HOUR_MS);

  const failedPayments = await prisma.payment.findMany({
    where: {
      status: "FAILED",
      amount: { gt: 0 },
      createdAt: { gte: minCreatedAt, lte: maxCreatedAt },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      userId: true,
      plan: true,
      status: true,
      amount: true,
      periodDays: true,
      note: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          email: true,
          role: true,
          suspended: true,
          subStatus: true,
          cancelAtPeriodEnd: true,
        },
      },
    },
  });

  // Deduplicate multiple failed attempts by the same user, preferring the newest
  // qualifying plan checkout so a user receives at most 1 nudge.
  const candidateByUser = new Map<string, (typeof failedPayments)[number]>();
  for (const payment of failedPayments) {
    const existing = candidateByUser.get(payment.userId);
    const isPlanCheckout =
      isCheckoutRecoveryPlan(payment.plan)
      && payment.periodDays > 0
      && payment.note?.trim().toLowerCase() !== "credits";
    if (!existing) {
      candidateByUser.set(payment.userId, payment);
    } else if (isPlanCheckout) {
      const existingIsPlan =
        isCheckoutRecoveryPlan(existing.plan)
        && existing.periodDays > 0
        && existing.note?.trim().toLowerCase() !== "credits";
      if (!existingIsPlan) {
        candidateByUser.set(payment.userId, payment);
      }
    }
  }

  const candidates = [...candidateByUser.values()];
  const run: CheckoutRecoveryRun = {
    checked: candidates.length,
    eligible: 0,
    suppressed: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
  };
  if (candidates.length === 0) return run;

  const userIds = candidates.map((c) => c.userId);
  const cooldownSince = new Date(now.getTime() - CHECKOUT_RECOVERY_USER_COOLDOWN_DAYS * DAY_MS);

  const [paidRows, recentClaims] = await Promise.all([
    prisma.payment.findMany({
      where: {
        userId: { in: userIds },
        status: "PAID",
        amount: { gt: 0 },
        OR: [{ createdAt: { gte: minCreatedAt } }, { paidAt: { gte: minCreatedAt } }],
      },
      select: {
        userId: true,
        createdAt: true,
        paidAt: true,
      },
    }),
    prisma.telemetryEvent.groupBy({
      by: ["userId"],
      where: {
        userId: { in: userIds },
        name: CHECKOUT_RECOVERY_CLAIM_EVENT,
        createdAt: { gte: cooldownSince },
      },
      _max: { createdAt: true },
    }),
  ]);

  const latestPaidAtByUser = new Map<string, Date>();
  for (const row of paidRows) {
    const effectivePaidAt = row.paidAt ?? row.createdAt;
    const prev = latestPaidAtByUser.get(row.userId);
    if (!prev || effectivePaidAt.getTime() > prev.getTime()) {
      latestPaidAtByUser.set(row.userId, effectivePaidAt);
    }
  }

  const lastClaimAtByUser = new Map<string, Date>();
  for (const row of recentClaims) {
    if (row.userId && row._max.createdAt) {
      lastClaimAtByUser.set(row.userId, row._max.createdAt);
    }
  }

  const notify = deps.createNotification ?? createNotification;
  const email = deps.sendEmail ?? sendCheckoutRecoveryEmail;
  const telemetry = deps.recordTelemetry ?? recordTelemetryEvent;
  const emailOn = (deps.emailEnabled ?? checkoutRecoveryEmailEnabled)();
  const origin = appOrigin();

  for (const payment of candidates) {
    const latestPaidAt = latestPaidAtByUser.get(payment.userId) ?? null;
    const hasSubsequentPaidPayment = Boolean(
      latestPaidAt && latestPaidAt.getTime() > payment.createdAt.getTime(),
    );
    const lastRecoverySentAt = lastClaimAtByUser.get(payment.userId) ?? null;

    const decision = checkoutRecoveryDecision({
      payment: {
        id: payment.id,
        status: payment.status,
        plan: payment.plan,
        amount: payment.amount,
        periodDays: payment.periodDays,
        note: payment.note,
        createdAt: payment.createdAt,
      },
      user: payment.user,
      hasSubsequentPaidPayment,
      lastRecoverySentAt,
      now,
    });

    if (!decision.send) {
      run.suppressed += 1;
      continue;
    }

    run.eligible += 1;

    let claimId: string;
    try {
      const claim = await prisma.telemetryEvent.create({
        data: {
          dedupeKey: decision.dedupeKey,
          userId: payment.user.id,
          name: CHECKOUT_RECOVERY_CLAIM_EVENT,
          category: "product",
          source: "server",
          status: "CLAIMED",
          properties: JSON.stringify({
            paymentId: payment.id,
            plan: decision.plan,
            cycle: decision.cycle,
          }),
          createdAt: now,
        },
        select: { id: true },
      });
      claimId = claim.id;
    } catch (error) {
      if (isUniqueClaimError(error)) {
        run.suppressed += 1;
        continue;
      }
      throw error;
    }

    run.claimed += 1;

    const copy = checkoutRecoveryCopy({
      plan: decision.plan,
      periodDays: payment.periodDays,
      amountSatang: payment.amount,
    });

    let notificationDelivered = false;
    let emailAttempted = false;
    let emailDelivered = false;

    try {
      await notify({
        userId: payment.user.id,
        type: "LIMIT_WARNING",
        title: copy.title,
        body: copy.body,
        link: copy.link,
      });
      notificationDelivered = true;
    } catch {
      notificationDelivered = false;
    }

    if (emailOn && payment.user.email) {
      emailAttempted = true;
      emailDelivered = await email({
        to: payment.user.email,
        subject: copy.emailSubject,
        title: copy.title,
        body: copy.body,
        cta: copy.cta,
        pricingUrl: `${origin}${copy.link}`,
      }).catch(() => false);
    }

    const status = checkoutRecoveryDeliveryStatus({
      notificationDelivered,
      emailAttempted,
      emailDelivered,
    });

    await prisma.telemetryEvent.update({
      where: { id: claimId },
      data: {
        status,
        properties: JSON.stringify({
          paymentId: payment.id,
          plan: decision.plan,
          cycle: decision.cycle,
          notificationDelivered,
          emailAttempted,
          emailDelivered,
        }),
      },
    });

    if (status === "FAILED") {
      run.failed += 1;
    } else {
      run.sent += 1;
    }

    for (const [channel, attempted, delivered] of [
      ["notification", true, notificationDelivered],
      ["email", emailAttempted, emailDelivered],
    ] as const) {
      if (!attempted) continue;
      await telemetry(payment.user.id, {
        name: CHECKOUT_RECOVERY_DELIVERY_EVENT,
        category: delivered ? "product" : "error",
        source: "server",
        status: delivered ? "done" : "error",
        properties: {
          channel,
          paymentId: payment.id,
          plan: decision.plan,
          cycle: decision.cycle,
        },
      }).catch(() => {});
    }
  }

  return run;
}
