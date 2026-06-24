/**
 * Credit balance + ledger library (Task P3-1).
 *
 * 1 credit = ฿1.
 * Two buckets: `granted` (monthly allowance, non-rollover) and `purchased`
 * (paid credits, permanent until spent). Spend drains `granted` first, then
 * `purchased`.
 *
 * Atomic pattern mirrors `reserveMinutes` in minute-limits.ts:
 * - compute expected debit from each bucket
 * - `updateMany` with a `where` that guards both fields
 * - if `count !== 1` → lost race / insufficient → re-read and return error
 */

import { prisma } from "@/lib/prisma";

// ── Cost table ────────────────────────────────────────────────────────────────

/**
 * Cost in credits per action. Extend this map as new AI-gen features launch.
 * Unknown actions → 0 (safe default; callers should validate before spending).
 */
export const CREDIT_COST: Record<string, number> = {
  // Image generation
  "image-nano-1k": 4,
  "image-nano-4k": 8,
  "image-nano-8k": 12,
  // Video generation
  "video-seedance-5s": 10,
  "video-seedance-10s": 18,
  "video-seedance-15s": 25,
};

export function creditCostFor(action: string): number {
  return CREDIT_COST[action] ?? 0;
}

// ── Monthly grant amounts per plan ────────────────────────────────────────────

export const MONTHLY_GRANT: Record<string, number> = {
  FREE: 0,
  PRO: 50,
  BUSINESS: 150,
};

// ── Balance helpers ───────────────────────────────────────────────────────────

/**
 * Returns the current credit balance for a user, upserting an empty row if one
 * doesn't exist yet (so callers never have to worry about null).
 */
export async function getBalance(
  userId: string
): Promise<{ granted: number; purchased: number; total: number }> {
  const row = await prisma.creditBalance.upsert({
    where: { userId },
    create: { userId, granted: 0, purchased: 0 },
    update: {},
  });
  return {
    granted: row.granted,
    purchased: row.purchased,
    total: row.granted + row.purchased,
  };
}

// ── Grant credits ─────────────────────────────────────────────────────────────

/**
 * Add credits to the appropriate bucket and write a ledger row.
 *
 * @param kind "grant" → credited to the `granted` (monthly) bucket
 *             "purchase" → credited to the `purchased` (paid) bucket
 */
export async function grantCredits(
  userId: string,
  amount: number,
  kind: "grant" | "purchase",
  action?: string
): Promise<void> {
  if (amount <= 0) throw new Error("grantCredits: amount must be positive");

  // Upsert row so it exists, then increment the correct bucket
  const updated = await prisma.creditBalance.upsert({
    where: { userId },
    create: {
      userId,
      granted: kind === "grant" ? amount : 0,
      purchased: kind === "purchase" ? amount : 0,
    },
    update:
      kind === "grant"
        ? { granted: { increment: amount } }
        : { purchased: { increment: amount } },
  });

  const balanceAfter = updated.granted + updated.purchased;

  await prisma.creditLedger.create({
    data: {
      userId,
      delta: amount,
      kind,
      action: action ?? null,
      balanceAfter,
    },
  });
}

// ── Spend credits ─────────────────────────────────────────────────────────────

/**
 * Atomically spend `amount` credits (granted-first, then purchased).
 *
 * On success: returns `{ ok: true, balanceAfter }` and writes one ledger row.
 * On failure (insufficient or lost race): returns `{ ok: false, reason: "insufficient", balanceAfter }`.
 * Does NOT write a ledger row on failure.
 */
export async function spendCredits(
  userId: string,
  amount: number,
  action: string
): Promise<
  | { ok: true; balanceAfter: number }
  | { ok: false; reason: "insufficient"; balanceAfter: number }
> {
  if (amount <= 0) throw new Error("spendCredits: amount must be positive");

  // Read current balance (upserts empty row if missing)
  const bal = await getBalance(userId);

  if (bal.total < amount) {
    return { ok: false, reason: "insufficient", balanceAfter: bal.total };
  }

  // Compute debit from each bucket (granted first)
  const fromGranted = Math.min(bal.granted, amount);
  const fromPurchased = amount - fromGranted;

  // Atomic conditional update — guard both fields
  const result = await prisma.creditBalance.updateMany({
    where: {
      userId,
      granted: { gte: fromGranted },
      purchased: { gte: fromPurchased },
    },
    data: {
      granted: { decrement: fromGranted },
      purchased: { decrement: fromPurchased },
    },
  });

  if (result.count !== 1) {
    // Lost the race or balance changed between read and update → re-read
    const latest = await getBalance(userId);
    return { ok: false, reason: "insufficient", balanceAfter: latest.total };
  }

  const balanceAfter = bal.granted - fromGranted + (bal.purchased - fromPurchased);

  await prisma.creditLedger.create({
    data: {
      userId,
      delta: -amount,
      kind: "spend",
      action: action ?? null,
      balanceAfter,
    },
  });

  return { ok: true, balanceAfter };
}

// ── Monthly reset ─────────────────────────────────────────────────────────────

/**
 * Set `granted` to the plan's monthly allowance, regardless of prior value,
 * and record the reset timestamp + a ledger row.
 *
 * This does NOT touch the `purchased` bucket.
 */
export async function resetMonthlyGranted(
  userId: string,
  plan: string
): Promise<void> {
  const newGranted = MONTHLY_GRANT[plan] ?? 0;
  const now = new Date();

  // Upsert so row exists, then hard-set granted and reset timestamp
  const updated = await prisma.creditBalance.upsert({
    where: { userId },
    create: {
      userId,
      granted: newGranted,
      purchased: 0,
      grantedResetAt: now,
    },
    update: {
      granted: newGranted,
      grantedResetAt: now,
    },
  });

  const balanceAfter = updated.granted + updated.purchased;

  await prisma.creditLedger.create({
    data: {
      userId,
      delta: newGranted,
      kind: "grant",
      action: `monthly-reset:${plan}`,
      balanceAfter,
    },
  });
}
