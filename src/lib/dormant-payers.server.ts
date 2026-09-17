import "server-only";

import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { sendPaidActivationEmail } from "@/lib/send-email";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { getSubscriptionNorthStarEvidence, isInternalNorthStarAccount } from "@/lib/subscription-north-star.server";
import { paidActivationCopy, paidActivationDecision, PAID_ACTIVATION_LINK } from "@/lib/paid-activation-reminder";

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * HERO-34 — a Dormant Payer is a member of the MAPC denominator who is not in the MAPC
 * numerator: still paying, created nothing in the trailing 30 days. Built from the very
 * same evidence as the North Star headline so `dormant.length` always equals
 * `activePayingCustomers − activeCreators` on /admin/revenue.
 */
export type DormantPayer = {
  id: string;
  name: string | null;
  email: string;
  plan: string;
  billingPeriod: string | null;
  subStatus: string | null;
  planExpiresAt: Date | null;
  lastPaidAt: Date | null;
  daysSincePay: number | null;
  lastJobAt: Date | null;
  /** null = has never started a job. */
  daysSinceLastJob: number | null;
  jobsEver: number;
  jobsFailed: number;
  videosEver: number;
};

export async function listDormantPayers(now: Date = new Date()): Promise<DormantPayer[]> {
  const evidence = await getSubscriptionNorthStarEvidence(now);
  const dormantIds = [...evidence.payerIds].filter((id) => !evidence.creatorIds.has(id));
  if (dormantIds.length === 0) return [];

  const [users, lastPayments, jobStats, failedStats, videoStats] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: dormantIds } },
      select: { id: true, name: true, email: true, plan: true, billingPeriod: true, subStatus: true, planExpiresAt: true },
    }),
    prisma.payment.groupBy({
      by: ["userId"],
      where: { userId: { in: dormantIds }, status: "PAID", amount: { gt: 0 }, periodDays: { gt: 0 } },
      _max: { paidAt: true, createdAt: true },
    }),
    prisma.videoJob.groupBy({ by: ["userId"], where: { userId: { in: dormantIds } }, _count: { _all: true }, _max: { createdAt: true } }),
    prisma.videoJob.groupBy({ by: ["userId"], where: { userId: { in: dormantIds }, status: "failed" }, _count: { _all: true } }),
    prisma.video.groupBy({ by: ["userId"], where: { userId: { in: dormantIds } }, _count: { _all: true } }),
  ]);

  const payBy = new Map(lastPayments.map((row) => [row.userId, row._max.paidAt ?? row._max.createdAt ?? null]));
  const jobsBy = new Map(jobStats.map((row) => [row.userId, { count: row._count._all, last: row._max.createdAt ?? null }]));
  const failedBy = new Map(failedStats.map((row) => [row.userId, row._count._all]));
  const videosBy = new Map(videoStats.map((row) => [row.userId, row._count._all]));
  const daysAgo = (date: Date | null) => (date ? Math.floor((now.getTime() - date.getTime()) / DAY_MS) : null);

  return users
    .map((user) => {
      const jobs = jobsBy.get(user.id) ?? { count: 0, last: null };
      const lastPaidAt = payBy.get(user.id) ?? null;
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        plan: user.plan,
        billingPeriod: user.billingPeriod,
        subStatus: user.subStatus,
        planExpiresAt: user.planExpiresAt,
        lastPaidAt,
        daysSincePay: daysAgo(lastPaidAt),
        lastJobAt: jobs.last,
        daysSinceLastJob: daysAgo(jobs.last),
        jobsEver: jobs.count,
        jobsFailed: failedBy.get(user.id) ?? 0,
        videosEver: videosBy.get(user.id) ?? 0,
      } satisfies DormantPayer;
    })
    // Never-created first, then the longest-silent — the order Mew should call them in.
    .sort((a, b) => (b.daysSinceLastJob ?? Number.POSITIVE_INFINITY) - (a.daysSinceLastJob ?? Number.POSITIVE_INFINITY));
}

// ─── Day-3 first-clip nudge ───────────────────────────────────────────────────

export function paidActivationEmailEnabled(): boolean {
  return process.env.PAID_ACTIVATION_EMAIL === "1";
}

type Deps = {
  createNotification?: typeof createNotification;
  sendEmail?: typeof sendPaidActivationEmail;
  recordTelemetry?: typeof recordTelemetryEvent;
  emailEnabled?: () => boolean;
};

export type PaidActivationRun = {
  checked: number;
  sent: number;
  tooEarly: number;
  skipped: number;
  duplicateClaimsSkipped: number;
  deliveryFailed: number;
};

function isUniqueClaimError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "P2002";
}

function deliveryStatus(n: boolean, ea: boolean, ed: boolean): "DELIVERED" | "PARTIAL" | "FAILED" {
  const emailOk = !ea || ed;
  if (n && emailOk) return "DELIVERED";
  if (n || ed) return "PARTIAL";
  return "FAILED";
}

/**
 * Daily (rides the renewal-reminders cron). Candidates are customers with a real plan
 * payment and no VideoJob at all; the unique log row is claimed before either channel.
 */
export async function sendDuePaidActivationReminders(now: Date = new Date(), deps: Deps = {}): Promise<PaidActivationRun> {
  const candidates = await prisma.user.findMany({
    where: {
      suspended: false,
      // "Never created anything" — not just no VideoJob: a Hero Script sent to the editor
      // or a delivered video is a Core Creation Outcome and must silence the nudge too.
      videoJobs: { none: {} },
      videos: { none: {} },
      scripts: { none: { OR: [{ status: "sent" }, { editorProjectId: { not: null } }] } },
      paidActivationReminderLog: null,
      payments: { some: { status: "PAID", amount: { gt: 0 }, periodDays: { gt: 0 }, plan: { in: ["PRO", "BUSINESS"] } } },
    },
    select: {
      id: true, email: true, role: true, plan: true, suspended: true,
      payments: {
        where: { status: "PAID", amount: { gt: 0 }, periodDays: { gt: 0 }, plan: { in: ["PRO", "BUSINESS"] } },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { paidAt: true, createdAt: true, note: true },
      },
    },
  });

  const run: PaidActivationRun = { checked: candidates.length, sent: 0, tooEarly: 0, skipped: 0, duplicateClaimsSkipped: 0, deliveryFailed: 0 };
  const notify = deps.createNotification ?? createNotification;
  const email = deps.sendEmail ?? sendPaidActivationEmail;
  const telemetry = deps.recordTelemetry ?? recordTelemetryEvent;
  const emailOn = (deps.emailEnabled ?? paidActivationEmailEnabled)();
  const origin = (process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");

  for (const user of candidates) {
    const firstPayment = user.payments.find((p) => p.note !== "credits") ?? null;
    const firstPaidAt = firstPayment ? (firstPayment.paidAt ?? firstPayment.createdAt) : null;
    const decision = paidActivationDecision({
      isInternal: isInternalNorthStarAccount(user),
      suspended: user.suspended,
      firstPaidAt,
      hasAnyJob: false,
      now,
    });
    if (!decision.send) {
      if (decision.reason === "too_early") run.tooEarly += 1;
      else run.skipped += 1;
      continue;
    }

    let claim: { id: string };
    try {
      claim = await prisma.paidActivationReminderLog.create({
        data: { userId: user.id, firstPaidAt: firstPaidAt!, attemptedAt: now },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueClaimError(error)) { run.duplicateClaimsSkipped += 1; continue; }
      throw error;
    }

    const copy = paidActivationCopy(user.plan);
    let notificationDelivered = false;
    let emailAttempted = false;
    let emailDelivered = false;
    try {
      await notify({ userId: user.id, type: "LIMIT_WARNING", title: copy.title, body: copy.body, link: PAID_ACTIVATION_LINK });
      notificationDelivered = true;
    } catch {
      notificationDelivered = false;
    }
    if (emailOn && user.email) {
      emailAttempted = true;
      emailDelivered = await email({
        to: user.email,
        subject: copy.emailSubject,
        title: copy.title,
        body: copy.body,
        cta: copy.cta,
        editorUrl: `${origin}${PAID_ACTIVATION_LINK}`,
      }).catch(() => false);
    }

    const status = deliveryStatus(notificationDelivered, emailAttempted, emailDelivered);
    await prisma.paidActivationReminderLog.update({
      where: { id: claim.id },
      data: {
        status,
        notificationDelivered,
        emailAttempted,
        emailDelivered,
        failureCode: status === "DELIVERED" ? null : !notificationDelivered && emailAttempted && !emailDelivered ? "notification_and_email_failed" : !notificationDelivered ? "notification_failed" : "email_failed",
        completedAt: now,
      },
    });
    if (status === "FAILED") run.deliveryFailed += 1;
    else run.sent += 1;

    for (const [channel, attempted, delivered] of [
      ["notification", true, notificationDelivered],
      ["email", emailAttempted, emailDelivered],
    ] as const) {
      if (!attempted) continue;
      await telemetry(user.id, {
        name: "paid_activation_reminder_delivery",
        category: delivered ? "product" : "error",
        source: "server",
        status: delivered ? "done" : "error",
        properties: { channel },
      }).catch(() => {});
    }
  }
  return run;
}
