import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const STARTER_AI_IMAGE_ALLOWANCE_LIMIT = 8;
export const STARTER_AI_IMAGE_WINDOW_DAYS = 30;
const WINDOW_MS = STARTER_AI_IMAGE_WINDOW_DAYS * 24 * 60 * 60 * 1_000;

export type StarterAiImageAllowanceStatus = {
  eligible: boolean;
  fundingSource: "starter_allowance" | "credits";
  windowStartedAt: Date;
  windowEndsAt: Date;
  limitImages: number;
  reservedImages: number;
  usedImages: number;
  remainingImages: number;
};

type DbClient = Prisma.TransactionClient;

function anchoredWindowStart(origin: Date, now: Date): Date {
  const elapsed = Math.max(0, now.getTime() - origin.getTime());
  return new Date(origin.getTime() + Math.floor(elapsed / WINDOW_MS) * WINDOW_MS);
}

async function eligibility(tx: DbClient, userId: string) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      createdAt: true,
      trialStartedAt: true,
      subStatus: true,
      payments: {
        where: { status: "PAID" },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!user) throw new Error("Starter allowance user not found");
  const hasPaid = user.subStatus === "active" || user.payments.length > 0;
  return {
    eligible: !hasPaid,
    origin: user.trialStartedAt ?? user.createdAt,
  };
}

function toStatus(row: {
  windowStartedAt: Date;
  limitImages: number;
  reservedImages: number;
  usedImages: number;
}): StarterAiImageAllowanceStatus {
  return {
    eligible: true,
    fundingSource: "starter_allowance",
    windowStartedAt: row.windowStartedAt,
    windowEndsAt: new Date(row.windowStartedAt.getTime() + WINDOW_MS),
    limitImages: row.limitImages,
    reservedImages: row.reservedImages,
    usedImages: row.usedImages,
    remainingImages: Math.max(0, row.limitImages - row.reservedImages - row.usedImages),
  };
}

/** Lazily creates and advances the signup-anchored window. An old window with
 * live reservations is kept until reconciliation settles it, preventing a
 * cross-boundary failure from refunding into a newly reset counter. */
export async function starterAllowanceStatusInTransaction(
  tx: DbClient,
  userId: string,
  now = new Date(),
): Promise<StarterAiImageAllowanceStatus> {
  const access = await eligibility(tx, userId);
  const desiredStart = anchoredWindowStart(access.origin, now);
  if (!access.eligible) {
    return {
      eligible: false,
      fundingSource: "credits",
      windowStartedAt: desiredStart,
      windowEndsAt: new Date(desiredStart.getTime() + WINDOW_MS),
      limitImages: 0,
      reservedImages: 0,
      usedImages: 0,
      remainingImages: 0,
    };
  }

  let row = await tx.starterAiImageAllowance.findUnique({ where: { userId } });
  if (!row) {
    row = await tx.starterAiImageAllowance.create({
      data: {
        userId,
        windowStartedAt: desiredStart,
        limitImages: STARTER_AI_IMAGE_ALLOWANCE_LIMIT,
      },
    });
  } else if (
    desiredStart.getTime() > row.windowStartedAt.getTime()
    && row.reservedImages === 0
  ) {
    row = await tx.starterAiImageAllowance.update({
      where: { userId },
      data: {
        windowStartedAt: desiredStart,
        limitImages: STARTER_AI_IMAGE_ALLOWANCE_LIMIT,
        reservedImages: 0,
        usedImages: 0,
      },
    });
  }
  return toStatus(row);
}

export async function getStarterAiImageAllowanceStatus(
  userId: string,
  now = new Date(),
): Promise<StarterAiImageAllowanceStatus> {
  return prisma.$transaction((tx) => starterAllowanceStatusInTransaction(tx, userId, now));
}

export async function reserveStarterAiImageAllowance(
  tx: DbClient,
  userId: string,
): Promise<
  | { kind: "credits" }
  | { kind: "allowance_exhausted"; status: StarterAiImageAllowanceStatus }
  | { kind: "reserved"; status: StarterAiImageAllowanceStatus }
> {
  const status = await starterAllowanceStatusInTransaction(tx, userId);
  if (!status.eligible) return { kind: "credits" };
  if (status.remainingImages < 1) return { kind: "allowance_exhausted", status };

  const updated = await tx.starterAiImageAllowance.updateMany({
    where: {
      userId,
      windowStartedAt: status.windowStartedAt,
      limitImages: status.limitImages,
      reservedImages: status.reservedImages,
      usedImages: status.usedImages,
    },
    data: { reservedImages: { increment: 1 } },
  });
  if (updated.count !== 1) {
    throw new Error("Starter allowance reservation lost a concurrent update");
  }
  return {
    kind: "reserved",
    status: {
      ...status,
      reservedImages: status.reservedImages + 1,
      remainingImages: status.remainingImages - 1,
    },
  };
}

export async function settleStarterAiImageAllowance(
  tx: DbClient,
  input: { userId: string; units: number; outcome: "completed" | "refunded" },
): Promise<void> {
  if (input.units <= 0) return;
  const updated = await tx.starterAiImageAllowance.updateMany({
    where: {
      userId: input.userId,
      reservedImages: { gte: input.units },
    },
    data: input.outcome === "completed"
      ? {
          reservedImages: { decrement: input.units },
          usedImages: { increment: input.units },
        }
      : { reservedImages: { decrement: input.units } },
  });
  if (updated.count !== 1) {
    throw new Error(`Starter allowance ${input.outcome} invariant failed`);
  }
}

/** Compensate an image that settled successfully but could not be delivered to
 * the creator (for example Ken Burns post-processing failed). */
export async function restoreSettledStarterAiImageAllowance(
  tx: DbClient,
  input: { userId: string; units: number },
): Promise<void> {
  if (input.units <= 0) return;
  const updated = await tx.starterAiImageAllowance.updateMany({
    where: { userId: input.userId, usedImages: { gte: input.units } },
    data: { usedImages: { decrement: input.units } },
  });
  if (updated.count !== 1) throw new Error("Starter allowance compensation invariant failed");
}
