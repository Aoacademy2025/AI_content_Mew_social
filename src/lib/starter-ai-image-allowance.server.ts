import "server-only";

import type { ConversionTrialAiImageAllowance, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decidePaidEquivalentEntitlement } from "@/lib/paid-equivalent-entitlement.server";
import { withTransientSqliteRetry } from "@/lib/sqlite-retry";

export const STARTER_AI_IMAGE_ALLOWANCE_LIMIT = 8;
export const STARTER_AI_IMAGE_WINDOW_DAYS = 7;

export type StarterAiImageAllowanceStatus = {
  eligible: boolean;
  fundingSource: "starter_allowance" | "credits";
  windowStartedAt: Date;
  windowEndsAt: Date;
  limitImages: number;
  reservedImages: number;
  usedImages: number;
  remainingImages: number;
  accessMode: "trial" | "paid" | "locked" | "legacy";
};

type DbClient = Prisma.TransactionClient;

const evidenceSelect = {
  createdAt: true,
  trialStartedAt: true,
  trialEndsAt: true,
  plan: true,
  suspended: true,
  planExpiresAt: true,
  stripeSubscriptionId: true,
  subStatus: true,
  bundleGrantId: true,
  bundleSubscriptionId: true,
  bundleAccessExpiresAt: true,
  bundleStatus: true,
  bundleAmountThb: true,
  payments: {
    where: { status: "PAID", periodDays: { gt: 0 } },
    orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
    select: { plan: true, status: true, periodDays: true, paidAt: true, createdAt: true },
  },
  couponRedemptions: {
    where: { coupon: { type: "GRANT" } },
    select: {
      redeemedAt: true,
      coupon: { select: { type: true, plan: true, durationDays: true } },
    },
  },
  administratorGrants: {
    select: {
      plan: true,
      reason: true,
      startsAt: true,
      expiresAt: true,
      permanent: true,
      revokedAt: true,
    },
  },
} satisfies Prisma.UserSelect;

type AllowanceEvidenceUser = Prisma.UserGetPayload<{ select: typeof evidenceSelect }>;

function allowanceAccessState(user: AllowanceEvidenceUser, now: Date) {
  const paidEquivalent = decidePaidEquivalentEntitlement({
    user,
    payments: user.payments,
    couponRedemptions: user.couponRedemptions,
    administratorGrants: user.administratorGrants,
  }, now);
  const activeTrial = !user.suspended
    && Boolean(user.trialStartedAt && user.trialStartedAt <= now && user.trialEndsAt && user.trialEndsAt > now);
  return { paidEquivalent, activeTrial };
}

function statusFromEvidence(
  user: AllowanceEvidenceUser,
  row: ConversionTrialAiImageAllowance | null,
  now: Date,
): StarterAiImageAllowanceStatus {
  const { paidEquivalent, activeTrial } = allowanceAccessState(user, now);
  if (row) {
    const mode = paidEquivalent.canUsePaidFeatures
      ? "paid"
      : activeTrial && row.expiresAt > now ? "trial" : "locked";
    return toStatus(row, mode);
  }
  const origin = user.trialStartedAt ?? user.createdAt;
  return toStatus({
    trialStartedAt: origin,
    expiresAt: user.trialEndsAt ?? origin,
    limitImages: 0,
    reservedImages: 0,
    usedImages: 0,
  }, paidEquivalent.canUsePaidFeatures ? "paid" : "locked");
}

function toStatus(
  row: {
    trialStartedAt: Date;
    expiresAt: Date;
    limitImages: number;
    reservedImages: number;
    usedImages: number;
  },
  mode: StarterAiImageAllowanceStatus["accessMode"],
): StarterAiImageAllowanceStatus {
  return {
    eligible: mode === "trial",
    fundingSource: mode === "trial" ? "starter_allowance" : "credits",
    windowStartedAt: row.trialStartedAt,
    windowEndsAt: row.expiresAt,
    limitImages: row.limitImages,
    reservedImages: row.reservedImages,
    usedImages: row.usedImages,
    remainingImages: Math.max(0, row.limitImages - row.reservedImages - row.usedImages),
    accessMode: mode,
  };
}

async function carriedConsumption(
  tx: DbClient,
  userId: string,
  trialStartedAt: Date,
  trialEndsAt: Date,
): Promise<number> {
  const [legacy, deliveredJobs] = await Promise.all([
    tx.starterAiImageAllowance.aggregate({
      where: { userId },
      _sum: { usedImages: true },
    }),
    tx.aiGenerationJob.count({
      where: {
        userId,
        kind: "image",
        fundingSource: "starter_allowance",
        status: "completed",
        chargeState: "settled",
        outputUrl: { not: null },
        createdAt: { gte: trialStartedAt, lte: trialEndsAt },
      },
    }),
  ]);
  return Math.min(STARTER_AI_IMAGE_ALLOWANCE_LIMIT, Math.max(legacy._sum.usedImages ?? 0, deliveredJobs));
}

/** Materialize one immutable Trial grant. Its start and expiry are the user's
 * actual seven-day Trial timestamps; no rolling-window arithmetic exists. */
export async function starterAllowanceStatusInTransaction(
  tx: DbClient,
  userId: string,
  now = new Date(),
): Promise<StarterAiImageAllowanceStatus> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: evidenceSelect });
  if (!user) throw new Error("Conversion Trial allowance user not found");
  const { paidEquivalent, activeTrial } = allowanceAccessState(user, now);
  let row = await tx.conversionTrialAiImageAllowance.findUnique({ where: { userId } });
  if (activeTrial && !paidEquivalent.canUsePaidFeatures && user.trialStartedAt && user.trialEndsAt && !row) {
    row = await tx.conversionTrialAiImageAllowance.create({
      data: {
        userId,
        trialStartedAt: user.trialStartedAt,
        expiresAt: user.trialEndsAt,
        limitImages: STARTER_AI_IMAGE_ALLOWANCE_LIMIT,
        usedImages: await carriedConsumption(tx, userId, user.trialStartedAt, user.trialEndsAt),
      },
    });
  }
  return statusFromEvidence(user, row, now);
}

export async function starterAllowanceStatusForWindowInTransaction(
  tx: DbClient,
  userId: string,
  windowStartedAt: Date,
  now = new Date(),
): Promise<StarterAiImageAllowanceStatus> {
  const row = await tx.conversionTrialAiImageAllowance.findFirst({
    where: { userId, trialStartedAt: windowStartedAt },
  });
  if (row) return toStatus(row, row.expiresAt > now ? "trial" : "locked");
  const legacy = await tx.starterAiImageAllowance.findUnique({
    where: { userId_windowStartedAt: { userId, windowStartedAt } },
  });
  if (!legacy) throw new Error("Starter allowance window not found");
  return {
    eligible: false,
    fundingSource: "credits",
    windowStartedAt: legacy.windowStartedAt,
    windowEndsAt: legacy.windowStartedAt,
    limitImages: legacy.limitImages,
    reservedImages: legacy.reservedImages,
    usedImages: legacy.usedImages,
    remainingImages: Math.max(0, legacy.limitImages - legacy.reservedImages - legacy.usedImages),
    accessMode: "legacy",
  };
}

export async function getStarterAiImageAllowanceStatus(userId: string, now = new Date()) {
  // This status is included in /api/user/me and normally requires reads only.
  // An interactive Prisma transaction asks SQLite for its single writer lock,
  // so the old implementation could return P1008 while two renders saturated
  // the disk even for paid/free users whose allowance state could not change.
  const [user, row] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: evidenceSelect }),
    prisma.conversionTrialAiImageAllowance.findUnique({ where: { userId } }),
  ]);
  if (!user) throw new Error("Conversion Trial allowance user not found");
  const { paidEquivalent, activeTrial } = allowanceAccessState(user, now);
  const needsMaterialization = activeTrial && !paidEquivalent.canUsePaidFeatures && !row;
  if (!needsMaterialization) return statusFromEvidence(user, row, now);

  // Only the first read of an eligible Conversion Trial needs a write. Recheck
  // all evidence inside the transaction so a concurrent activation or first
  // materializer cannot create a stale/duplicate allowance.
  return withTransientSqliteRetry(
    () => prisma.$transaction((tx) => starterAllowanceStatusInTransaction(tx, userId, now)),
  );
}

export async function getStarterAiImageAllowanceWindowStatus(userId: string, windowStartedAt: Date) {
  return prisma.$transaction((tx) => starterAllowanceStatusForWindowInTransaction(tx, userId, windowStartedAt));
}

export async function reserveStarterAiImageAllowance(
  tx: DbClient,
  userId: string,
  pinnedWindowStartedAt?: Date,
): Promise<
  | { kind: "credits" }
  | { kind: "allowance_exhausted"; status: StarterAiImageAllowanceStatus }
  | { kind: "reserved"; status: StarterAiImageAllowanceStatus }
> {
  const status = pinnedWindowStartedAt
    ? await starterAllowanceStatusForWindowInTransaction(tx, userId, pinnedWindowStartedAt)
    : await starterAllowanceStatusInTransaction(tx, userId);
  if (!status.eligible) {
    return status.accessMode === "paid" ? { kind: "credits" } : { kind: "allowance_exhausted", status };
  }
  if (status.remainingImages < 1) return { kind: "allowance_exhausted", status };
  const updated = await tx.conversionTrialAiImageAllowance.updateMany({
    where: {
      userId,
      trialStartedAt: status.windowStartedAt,
      expiresAt: { gt: new Date() },
      limitImages: status.limitImages,
      reservedImages: status.reservedImages,
      usedImages: status.usedImages,
    },
    data: { reservedImages: { increment: 1 } },
  });
  if (updated.count !== 1) throw new Error("Conversion Trial allowance reservation lost a concurrent update");
  return {
    kind: "reserved",
    status: { ...status, reservedImages: status.reservedImages + 1, remainingImages: status.remainingImages - 1 },
  };
}

export async function settleStarterAiImageAllowance(
  tx: DbClient,
  input: { userId: string; windowStartedAt: Date; units: number; outcome: "completed" | "refunded" },
): Promise<void> {
  if (input.units <= 0) return;
  const data = input.outcome === "completed"
    ? { reservedImages: { decrement: input.units }, usedImages: { increment: input.units } }
    : { reservedImages: { decrement: input.units } };
  const conversion = await tx.conversionTrialAiImageAllowance.updateMany({
    where: { userId: input.userId, trialStartedAt: input.windowStartedAt, reservedImages: { gte: input.units } },
    data,
  });
  if (conversion.count === 1) return;
  const legacy = await tx.starterAiImageAllowance.updateMany({
    where: { userId: input.userId, windowStartedAt: input.windowStartedAt, reservedImages: { gte: input.units } },
    data,
  });
  if (legacy.count !== 1) throw new Error(`Starter allowance ${input.outcome} invariant failed`);
}

export async function restoreSettledStarterAiImageAllowance(
  tx: DbClient,
  input: { userId: string; windowStartedAt: Date; units: number },
): Promise<void> {
  if (input.units <= 0) return;
  const conversion = await tx.conversionTrialAiImageAllowance.updateMany({
    where: { userId: input.userId, trialStartedAt: input.windowStartedAt, usedImages: { gte: input.units } },
    data: { usedImages: { decrement: input.units } },
  });
  if (conversion.count === 1) return;
  const legacy = await tx.starterAiImageAllowance.updateMany({
    where: { userId: input.userId, windowStartedAt: input.windowStartedAt, usedImages: { gte: input.units } },
    data: { usedImages: { decrement: input.units } },
  });
  if (legacy.count !== 1) throw new Error("Starter allowance compensation invariant failed");
}
