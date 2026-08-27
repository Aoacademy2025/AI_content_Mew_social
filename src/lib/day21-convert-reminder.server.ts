import "server-only";

import { prisma } from "@/lib/prisma";
import { sendDay21ConvertEmail } from "@/lib/send-email";
import {
  isInternalNorthStarAccount,
  recurringBillingCohort,
  type NorthStarUserEvidence,
} from "@/lib/subscription-north-star.server";
import {
  DAY21_CONVERT_BODY,
  DAY21_CONVERT_TITLE,
  decideDay21ConvertReminder,
} from "@/lib/day21-convert-reminder";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEDUPE_MS = 36 * 60 * 60 * 1_000;

const userEvidenceSelect = {
  id: true,
  email: true,
  role: true,
  plan: true,
  suspended: true,
  stripeSubscriptionId: true,
  subStatus: true,
  billingPeriod: true,
  planExpiresAt: true,
  bundleSubscriptionId: true,
  bundleStatus: true,
  bundleBillingPeriod: true,
  bundleAccessExpiresAt: true,
  bundleAmountThb: true,
  payments: {
    where: { status: "PAID", amount: { gt: 0 }, periodDays: { gt: 0 } },
    select: { plan: true, status: true, amount: true, periodDays: true, note: true },
  },
} as const;

type Candidate = {
  user: NorthStarUserEvidence;
  entitlementStartedAt: Date;
  entitlementExpiresAt: Date | null;
};

export async function collectDay21ConvertCandidates(now: Date): Promise<Candidate[]> {
  const windowStart = new Date(now.getTime() - 23 * DAY_MS);
  const windowEnd = new Date(now.getTime() - 20 * DAY_MS);
  const [redemptions, grants] = await Promise.all([
    prisma.couponRedemption.findMany({
      where: {
        coupon: { type: "GRANT" },
        OR: [
          { entitlementStartsAt: { gte: windowStart, lte: windowEnd } },
          { entitlementStartsAt: null, redeemedAt: { gte: windowStart, lte: windowEnd } },
        ],
      },
      select: {
        redeemedAt: true,
        entitlementStartsAt: true,
        entitlementExpiresAt: true,
        user: { select: userEvidenceSelect },
      },
    }),
    prisma.administratorGrant.findMany({
      where: {
        revokedAt: null,
        permanent: false,
        startsAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        startsAt: true,
        expiresAt: true,
        user: { select: userEvidenceSelect },
      },
    }),
  ]);

  const byUser = new Map<string, Candidate>();
  for (const row of redemptions) {
    byUser.set(row.user.id, {
      user: row.user,
      entitlementStartedAt: row.entitlementStartsAt ?? row.redeemedAt,
      entitlementExpiresAt: row.entitlementExpiresAt,
    });
  }
  for (const row of grants) {
    if (byUser.has(row.user.id)) continue;
    byUser.set(row.user.id, {
      user: row.user,
      entitlementStartedAt: row.startsAt,
      entitlementExpiresAt: row.expiresAt,
    });
  }
  return [...byUser.values()];
}

export async function sendDueDay21ConvertReminders(now: Date = new Date()): Promise<{
  checked: number;
  sent: number;
}> {
  const origin = (process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const pricingUrl = `${origin}/pricing`;
  const candidates = await collectDay21ConvertCandidates(now);
  let sent = 0;
  for (const candidate of candidates) {
    const decision = decideDay21ConvertReminder({
      isInternal: isInternalNorthStarAccount(candidate.user),
      isRecurringPayer: recurringBillingCohort(candidate.user, now) != null,
      entitlementStartedAt: candidate.entitlementStartedAt,
      entitlementExpiresAt: candidate.entitlementExpiresAt,
      now,
    });
    if (!decision.send) continue;

    const already = await prisma.notification.findFirst({
      where: {
        userId: candidate.user.id,
        title: DAY21_CONVERT_TITLE,
        createdAt: { gte: new Date(now.getTime() - DEDUPE_MS) },
      },
      select: { id: true },
    });
    if (already) continue;

    await prisma.notification.create({
      data: {
        userId: candidate.user.id,
        type: "LIMIT_WARNING",
        title: DAY21_CONVERT_TITLE,
        body: DAY21_CONVERT_BODY,
        createdAt: now,
      },
    });
    if (candidate.user.email) {
      await sendDay21ConvertEmail({ to: candidate.user.email, pricingUrl }).catch(() => {});
    }
    sent += 1;
  }
  return { checked: candidates.length, sent };
}
