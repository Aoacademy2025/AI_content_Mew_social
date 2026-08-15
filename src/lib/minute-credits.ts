import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { syncMinuteWindow } from "@/lib/minute-limits";
import {
  spendCreditsInTransaction,
  refundCreditsInTransaction,
  creditCostFor,
} from "@/lib/credits";
import { refundClipUsage } from "@/lib/usage-limits";

export type ReserveResult =
  | {
      allowed: true;
      via: "minutes";
      reservedMinutes: number;
      minutesReserved: number;
      remaining: number;
    }
  | {
      allowed: true;
      via: "credits";
      reservedMinutes: number;
      minutesReserved: 0;
      creditsSpent: number;
      // The bucket split spendCredits actually drained (granted-first, then purchased).
      // MUST be threaded to refundReservation so a refund restores the EXACT buckets —
      // refunding the lump to `purchased` permanently inflates it (granted is hard-reset
      // monthly, purchased persists). fromGranted + fromPurchased === creditsSpent.
      fromGranted: number;
      fromPurchased: number;
      balanceAfter: number;
    }
  | {
      allowed: true;
      via: "mixed";
      reservedMinutes: number;
      minutesReserved: number;
      creditsSpent: number;
      fromGranted: number;
      fromPurchased: number;
      balanceAfter: number;
      remaining: number;
    }
  | { allowed: false; via: "none"; remaining: number; message?: string };

function quotaMessage(plan: string, limit: number): string {
  const name = plan === "BUSINESS" ? "Business" : plan === "PRO" ? "Pro" : "Free";
  return `แพ็กเกจ ${name} จำกัด ${limit} นาทีต่อ 30 วัน รอบนี้ใช้ครบแล้ว`;
}

class MinuteReservationRaceError extends Error {}

/**
 * Transaction-aware reservation primitive. The caller must run syncMinuteWindow
 * before opening `tx`; this function re-reads the authoritative counters inside
 * the transaction and atomically reserves included minutes plus only the credit-
 * funded overflow.
 */
export async function reserveMinutesOrCreditsInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  minutes: number,
  opts: { creditsLive: boolean; ref?: string },
): Promise<ReserveResult> {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error("reserveMinutesOrCredits: minutes must be a positive integer");
  }

  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { plan: true, minutesUsed: true, minutesLimit: true },
  });
  if (!user) return { allowed: false, via: "none", remaining: 0, message: "ไม่พบผู้ใช้" };

  const availableMinutes = Math.max(0, user.minutesLimit - user.minutesUsed);
  const minutesReserved = Math.min(minutes, availableMinutes);
  const creditMinutes = minutes - minutesReserved;
  const remaining = availableMinutes - minutesReserved;

  // Flag-off keeps the historical all-or-nothing minute behaviour: never consume
  // a partial allowance when credits are not available to fund the rest.
  if (creditMinutes > 0 && !opts.creditsLive) {
    return {
      allowed: false,
      via: "none",
      remaining: availableMinutes,
      message: quotaMessage(user.plan, user.minutesLimit),
    };
  }

  let spend:
    | { ok: true; balanceAfter: number; fromGranted: number; fromPurchased: number }
    | null = null;
  const creditsSpent = creditMinutes * creditCostFor("minute");
  if (creditsSpent > 0) {
    const action = opts.ref ? `render-overflow:${opts.ref}` : "render-overflow";
    const result = await spendCreditsInTransaction(tx, userId, creditsSpent, action);
    if (!result.ok) {
      return {
        allowed: false,
        via: "none",
        remaining: availableMinutes,
        message: quotaMessage(user.plan, user.minutesLimit),
      };
    }
    spend = result;
  }

  if (minutesReserved > 0) {
    const updated = await tx.user.updateMany({
      where: {
        id: userId,
        minutesUsed: user.minutesUsed,
        minutesLimit: user.minutesLimit,
      },
      data: { minutesUsed: { increment: minutesReserved } },
    });
    // Throwing rolls the credit spend + ledger back with the same transaction.
    if (updated.count !== 1) throw new MinuteReservationRaceError();
  }

  if (!spend) {
    return {
      allowed: true,
      via: "minutes",
      reservedMinutes: minutes,
      minutesReserved,
      remaining,
    };
  }
  if (minutesReserved === 0) {
    return {
      allowed: true,
      via: "credits",
      reservedMinutes: minutes,
      minutesReserved: 0,
      creditsSpent,
      fromGranted: spend.fromGranted,
      fromPurchased: spend.fromPurchased,
      balanceAfter: spend.balanceAfter,
    };
  }
  return {
    allowed: true,
    via: "mixed",
    reservedMinutes: minutes,
    minutesReserved,
    creditsSpent,
    fromGranted: spend.fromGranted,
    fromPurchased: spend.fromPurchased,
    balanceAfter: spend.balanceAfter,
    remaining,
  };
}

/**
 * Reserve render capacity by minutes, falling back to credits when the monthly
 * minute quota is exhausted. User-facing callers must confirm a Render Receipt
 * before invoking a reservation that can spend credits.
 *
 * - within quota → reserve minutes (via:"minutes")
 * - partly within quota + enough credits → consume remaining included minutes,
 *   then spend only overflowMinutes×2 credits (via:"mixed")
 * - no included minutes + enough credits → spend minutes×2 credits (via:"credits")
 * - out of minutes + (creditsLive off OR insufficient credits) → via:"none"
 *   (caller walls). No meter is changed on failure.
 */
export async function reserveMinutesOrCredits(
  userId: string,
  minutes: number,
  opts: { creditsLive: boolean; ref?: string }
): Promise<ReserveResult> {
  const synced = await syncMinuteWindow(userId);
  if (!synced) return { allowed: false, via: "none", remaining: 0, message: "ไม่พบผู้ใช้" };

  // Retry once if another request changes the counters between the shared-window
  // sync and our guarded transactional update.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await prisma.$transaction((tx) =>
        reserveMinutesOrCreditsInTransaction(tx, userId, minutes, opts),
      );
    } catch (error) {
      if (!(error instanceof MinuteReservationRaceError) || attempt === 1) throw error;
    }
  }
  throw new Error("reserveMinutesOrCredits: unreachable retry state");
}

/**
 * Refund a reservation, choosing the correct bucket:
 *  - mixed-funded → refund BOTH the included minutes and the exact credit buckets
 *  - credit-funded → refund the exact credit buckets
 *  - minute-funded → refund minutes
 *  - legacy clip-funded → refundClipUsage
 */
export async function refundReservation(
  userId: string,
  res: {
    reservedMinutes: number | null;
    creditsSpent: number | null;
    // The granted-bucket portion of creditsSpent (the rest came from purchased). Threaded
    // from reserveMinutesOrCredits → persisted on RenderJob.creditsFromGranted. Optional/
    // nullable for backward-compat: an in-flight job enqueued BEFORE this field existed has
    // no split, so we fall back to all-purchased (the pre-fix behavior) instead of crashing.
    creditsFromGranted?: number | null;
  },
  action: string
): Promise<void> {
  if (res.reservedMinutes == null && !(res.creditsSpent && res.creditsSpent > 0)) {
    await refundClipUsage(userId);
    return;
  }

  await prisma.$transaction((tx) =>
    refundReservationInTransaction(tx, userId, res, action),
  );
}

/** Transaction-aware inverse of reserveMinutesOrCreditsInTransaction. This is
 * exported so an owning VideoJob can change its funding state and restore the
 * exact meter buckets in the same commit. */
export async function refundReservationInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  res: {
    reservedMinutes: number | null;
    creditsSpent: number | null;
    creditsFromGranted?: number | null;
  },
  action: string,
): Promise<void> {

  const creditsSpent = Math.max(0, res.creditsSpent ?? 0);
  const rate = creditCostFor("minute");
  if (creditsSpent > 0 && (rate <= 0 || creditsSpent % rate !== 0)) {
    throw new Error("refundReservation: invalid render credit amount");
  }
  const creditMinutes = rate > 0 ? creditsSpent / rate : 0;
  const totalReservedMinutes = Math.max(0, res.reservedMinutes ?? creditMinutes);
  const includedMinutes = Math.max(0, totalReservedMinutes - creditMinutes);
  const fromGranted = Math.max(0, Math.min(res.creditsFromGranted ?? 0, creditsSpent));
  const fromPurchased = creditsSpent - fromGranted;

  if (includedMinutes > 0) {
    await tx.$executeRaw`UPDATE "User" SET "minutesUsed" = MAX(0, "minutesUsed" - ${includedMinutes}) WHERE "id" = ${userId}`;
  }
  if (creditsSpent > 0) {
    await refundCreditsInTransaction(
      tx,
      userId,
      fromGranted,
      fromPurchased,
      action,
    );
  }
}
