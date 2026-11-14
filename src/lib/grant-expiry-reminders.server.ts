import "server-only";

import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { sendGrantExpiryReminderEmail } from "@/lib/send-email";
import { recordTelemetryEvent } from "@/lib/telemetry";
import {
  GRANT_EXPIRY_REMINDER_KINDS,
  grantDeliveryFailureCode,
  grantDeliveryStatus,
  grantExpiryReminderCopy,
  grantExpiryReminderDecision,
  isInternalGrantAccount,
  resolveExpiringGrantBanner,
  resolveGrantExpiryEligibility,
  type ExpiringGrantBannerInfo,
  type GrantExpiryReminderKind,
} from "@/lib/grant-expiry-reminders";

const DAY_MS = 24 * 60 * 60 * 1_000;

export type GrantExpiryDeliveryDeps = {
  createNotification?: typeof createNotification;
  sendEmail?: typeof sendGrantExpiryReminderEmail;
  recordTelemetry?: typeof recordTelemetryEvent;
  onClaimed?: (claimId: string) => Promise<void> | void;
};

export type GrantExpiryReminderRun = {
  checked: number;
  eligible: number;
  suppressed: number;
  claimed: number;
  duplicateClaimsSkipped: number;
  remindersSent: number;
  notificationDelivered: number;
  emailAttempted: number;
  emailDelivered: number;
  deliveryFailed: number;
  byKind: Record<GrantExpiryReminderKind, number>;
};

function emptyRun(checked = 0): GrantExpiryReminderRun {
  return {
    checked,
    eligible: 0,
    suppressed: 0,
    claimed: 0,
    duplicateClaimsSkipped: 0,
    remindersSent: 0,
    notificationDelivered: 0,
    emailAttempted: 0,
    emailDelivered: 0,
    deliveryFailed: 0,
    byKind: { d7: 0, d3: 0, d1: 0 },
  };
}

function isUniqueClaimError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "P2002";
}

function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase() ?? "";
  return trimmed ? trimmed : null;
}

const candidateSelect = {
  id: true,
  email: true,
  role: true,
  plan: true,
  suspended: true,
  planExpiresAt: true,
  stripeSubscriptionId: true,
  subStatus: true,
  cancelAtPeriodEnd: true,
  bundleStatus: true,
  bundleAccessExpiresAt: true,
  couponRedemptions: {
    where: { coupon: { type: "GRANT" } },
    select: {
      id: true,
      outcome: true,
      redeemedAt: true,
      entitlementPlan: true,
      entitlementStartsAt: true,
      entitlementExpiresAt: true,
      coupon: {
        select: {
          type: true,
          plan: true,
          durationDays: true,
        },
      },
    },
  },
  payments: {
    where: {
      status: "PAID" as const,
      amount: { gt: 0 },
      periodDays: { gt: 0 },
    },
    orderBy: { createdAt: "desc" as const },
    select: {
      plan: true,
      status: true,
      amount: true,
      periodDays: true,
      note: true,
      paidAt: true,
      createdAt: true,
    },
  },
  administratorGrants: {
    where: { revokedAt: null },
    select: {
      plan: true,
      startsAt: true,
      expiresAt: true,
      permanent: true,
      revokedAt: true,
    },
  },
  _count: {
    select: {
      brandProfiles: true,
      editorProjects: true,
      videos: true,
    },
  },
} as const;

/**
 * Deliver d7 / d3 / d1 expiry reminders for unpaid GRANT coupon holders.
 * Claims a unique `GrantExpiryReminderLog` row (`userId, couponRedemptionId, kind`)
 * before touching either channel so retries and concurrent cron workers are at-most-once.
 */
export async function sendDueGrantExpiryReminders(
  now: Date = new Date(),
  deps: GrantExpiryDeliveryDeps = {},
): Promise<GrantExpiryReminderRun> {
  const horizon = new Date(now.getTime() + 9 * DAY_MS);
  const legacyCutoff = new Date(now.getTime() - 400 * DAY_MS);

  const candidates = await prisma.user.findMany({
    where: {
      suspended: false,
      role: { not: "ADMIN" },
      couponRedemptions: {
        some: {
          coupon: { type: "GRANT" },
          OR: [
            { entitlementExpiresAt: { gt: now, lte: horizon } },
            { outcome: "LEGACY", redeemedAt: { gte: legacyCutoff } },
          ],
        },
      },
    },
    select: candidateSelect,
  });

  const run = emptyRun(candidates.length);
  if (candidates.length === 0) return run;

  const emails = candidates
    .map((c) => normalizeEmail(c.email))
    .filter((e): e is string => Boolean(e));
  const bundleRows = emails.length > 0
    ? await prisma.bundleEntitlement.findMany({
        where: {
          email: { in: emails },
          status: "ACTIVE",
          accessEndsAt: { gt: now },
        },
        select: { email: true, accessEndsAt: true },
      })
    : [];
  const externalBundleByEmail = new Map<string, Date>(
    bundleRows.map((row) => [row.email.trim().toLowerCase(), row.accessEndsAt]),
  );

  const notify = deps.createNotification ?? createNotification;
  const email = deps.sendEmail ?? sendGrantExpiryReminderEmail;
  const telemetry = deps.recordTelemetry ?? recordTelemetryEvent;
  const origin = (process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");

  for (const candidate of candidates) {
    const normalizedEmail = normalizeEmail(candidate.email);
    const eligibility = resolveGrantExpiryEligibility(
      {
        user: candidate,
        couponRedemptions: candidate.couponRedemptions,
        payments: candidate.payments,
        administratorGrants: candidate.administratorGrants,
        externalBundleExpiresAt: normalizedEmail ? (externalBundleByEmail.get(normalizedEmail) ?? null) : null,
      },
      now,
    );

    if (!eligibility.eligible) {
      run.suppressed += 1;
      continue;
    }
    run.eligible += 1;

    const decision = grantExpiryReminderDecision(eligibility.daysLeft);
    if (!decision.send) continue;
    const { kind } = decision;

    let claim: { id: string };
    try {
      claim = await prisma.grantExpiryReminderLog.create({
        data: {
          userId: candidate.id,
          couponRedemptionId: eligibility.couponRedemptionId,
          entitlementExpiresAt: eligibility.maxGrantExpiresAt,
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
    if (deps.onClaimed) {
      await deps.onClaimed(claim.id);
    }

    const copy = grantExpiryReminderCopy({
      kind,
      plan: eligibility.plan,
      assets: {
        brandProfiles: candidate._count.brandProfiles,
        editorProjects: candidate._count.editorProjects,
        videos: candidate._count.videos,
      },
    });

    let notificationDelivered = false;
    let emailAttempted = false;
    let emailDelivered = false;

    try {
      await notify({
        userId: candidate.id,
        type: "LIMIT_WARNING",
        title: copy.title,
        body: copy.body,
        link: copy.link,
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
        subject: copy.subject,
        title: copy.title,
        body: copy.body,
        assetsSummary: copy.assetsSummary,
        cta: copy.cta,
        pricingUrl: `${origin}${copy.link}`,
      }).catch(() => false);
      if (emailDelivered) run.emailDelivered += 1;
    }

    const deliveryState = { notificationDelivered, emailAttempted, emailDelivered };
    const status = grantDeliveryStatus(deliveryState);
    const failureCode = grantDeliveryFailureCode(deliveryState);

    await prisma.grantExpiryReminderLog.update({
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

    if (status === "FAILED") {
      run.deliveryFailed += 1;
    } else {
      run.remindersSent += 1;
      run.byKind[kind] += 1;
    }

    for (const [channel, attempted, delivered] of [
      ["notification", true, notificationDelivered],
      ["email", emailAttempted, emailDelivered],
    ] as const) {
      if (!attempted) continue;
      await telemetry(candidate.id, {
        name: "grant_expiry_reminder_delivery",
        category: delivered ? "product" : "error",
        source: "server",
        status: delivered ? "done" : "error",
        properties: { kind, channel, plan: eligibility.plan },
      }).catch(() => {});
    }
  }

  return run;
}

/**
 * Resolve the in-app expiring GRANT banner (`<= 7` days left, unpaid, unsuppressed)
 * for `/dashboard` (via `/api/user/stats`) and `/pricing` (SSR).
 */
export async function resolveUserExpiringGrantBanner(
  userId: string,
  now: Date = new Date(),
): Promise<ExpiringGrantBannerInfo | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      plan: true,
      suspended: true,
      planExpiresAt: true,
      stripeSubscriptionId: true,
      subStatus: true,
      cancelAtPeriodEnd: true,
      bundleStatus: true,
      bundleAccessExpiresAt: true,
      couponRedemptions: candidateSelect.couponRedemptions,
      payments: candidateSelect.payments,
      administratorGrants: candidateSelect.administratorGrants,
    },
  });
  if (!user || user.suspended || isInternalGrantAccount(user)) return null;
  if (user.couponRedemptions.length === 0) return null;

  const normalizedEmail = normalizeEmail(user.email);
  const externalBundle = normalizedEmail
    ? await prisma.bundleEntitlement.findUnique({
        where: { email: normalizedEmail },
        select: { status: true, accessEndsAt: true },
      })
    : null;
  const externalBundleExpiresAt =
    externalBundle && externalBundle.status === "ACTIVE" && externalBundle.accessEndsAt > now
      ? externalBundle.accessEndsAt
      : null;

  return resolveExpiringGrantBanner(
    {
      user,
      couponRedemptions: user.couponRedemptions,
      payments: user.payments,
      administratorGrants: user.administratorGrants,
      externalBundleExpiresAt,
    },
    now,
  );
}

export { GRANT_EXPIRY_REMINDER_KINDS };
