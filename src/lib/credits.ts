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
import { USAGE_PERIOD_DAYS } from "@/lib/usage-limits";

// ── Cost table + pure price helpers ───────────────────────────────────────────
// Moved to a prisma-free module (credit-costs.ts) so the client (Editor v2 Render
// Receipt) derives prices from the SAME source; re-exported here so every existing
// server import (`@/lib/credits`) keeps working unchanged.
export { CREDIT_COST, creditCostFor, costKeyForKieModel } from "@/lib/credit-costs";

// ── Credit packs (purchasable one-time) ──────────────────────────────────────

/**
 * Available credit packs purchasable via Stripe one-time payment.
 * `baht` is the THB price; `credits` is the amount granted to `purchased` bucket.
 */
export const CREDIT_PACKS: Record<
  "starter" | "popular" | "pro",
  { baht: number; credits: number }
> = {
  starter: { baht: 199, credits: 200 },
  popular: { baht: 499, credits: 540 },
  pro:     { baht: 999, credits: 1150 },
};

/**
 * Looks up a credit pack by id. Returns `null` if the id is not valid.
 */
export function creditPack(
  id: string
): { baht: number; credits: number } | null {
  return (CREDIT_PACKS as Record<string, { baht: number; credits: number }>)[id] ?? null;
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

  // Balance mutation + ledger row in ONE transaction so a crash between them can
  // never diverge the balance from its audit ledger (MON-4).
  await prisma.$transaction(async (tx) => {
    // Upsert row so it exists, then increment the correct bucket
    const updated = await tx.creditBalance.upsert({
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

    await tx.creditLedger.create({
      data: {
        userId,
        delta: amount,
        kind,
        action: action ?? null,
        balanceAfter,
      },
    });
  });
}

// ── Idempotent grant (dedup by ref) ──────────────────────────────────────────

/**
 * Grant credits at most once per `ref` (e.g. a Stripe session id).
 * Returns {granted:false} if a ledger row with action===ref already exists.
 *
 * Stripe retries are spaced seconds-to-hours apart, never truly concurrent,
 * so the findFirst-then-grant check is sufficient here.
 */
export async function grantCreditsOnce(
  userId: string,
  amount: number,
  kind: "grant" | "purchase",
  ref: string
): Promise<{ granted: boolean }> {
  const existing = await prisma.creditLedger.findFirst({ where: { userId, action: ref } });
  if (existing) return { granted: false };
  await grantCredits(userId, amount, kind, ref); // action === ref is the dedup marker
  return { granted: true };
}

// ── Spend credits ─────────────────────────────────────────────────────────────

/**
 * Atomically spend `amount` credits (granted-first, then purchased).
 *
 * On success: returns `{ ok: true, balanceAfter, fromGranted, fromPurchased }` and writes one ledger row.
 * On failure (insufficient or lost race): returns `{ ok: false, reason: "insufficient", balanceAfter }`.
 * Does NOT write a ledger row on failure.
 *
 * Ledger `delta` sign convention: positive = credit (balance up), negative = debit
 * (balance down). A spend writes a NEGATIVE delta.
 */
export async function spendCredits(
  userId: string,
  amount: number,
  action: string
): Promise<
  | { ok: true; balanceAfter: number; fromGranted: number; fromPurchased: number }
  | { ok: false; reason: "insufficient"; balanceAfter: number }
> {
  if (amount <= 0) throw new Error("spendCredits: amount must be positive");

  // Whole spend runs in ONE transaction so the guarded debit and its ledger row
  // commit atomically (MON-4). Inside, on a lost split-bucket race (the guarded
  // updateMany matches 0 rows because a concurrent spend shifted the granted/
  // purchased split under our read), RE-READ + recompute the split and re-issue
  // the guarded update ONCE (MON-3). Still fail-closed: a genuinely insufficient
  // total (granted+purchased < amount) returns insufficient without writing a
  // ledger row, and the retry is capped at one extra attempt (no loops, never
  // over-spends). ALL reads/writes use `tx` — never the global client — so the
  // single SQLite connection isn't dead-locked mid-transaction.
  return prisma.$transaction(
    async (
      tx
    ): Promise<
      | { ok: true; balanceAfter: number; fromGranted: number; fromPurchased: number }
      | { ok: false; reason: "insufficient"; balanceAfter: number }
    > => {
      // Up to 2 attempts: initial + one retry after a split-shift race.
      for (let attempt = 0; attempt < 2; attempt++) {
        // Read current balance (upserts empty row if missing)
        const row = await tx.creditBalance.upsert({
          where: { userId },
          create: { userId, granted: 0, purchased: 0 },
          update: {},
        });
        const total = row.granted + row.purchased;

        if (total < amount) {
          // Genuinely insufficient — total can't cover it (fail-closed, no ledger row)
          return { ok: false, reason: "insufficient", balanceAfter: total };
        }

        // Compute debit from each bucket (granted first)
        const fromGranted = Math.min(row.granted, amount);
        const fromPurchased = amount - fromGranted;

        // Atomic conditional update — guard both fields
        const result = await tx.creditBalance.updateMany({
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

        if (result.count === 1) {
          const balanceAfter = total - amount;
          await tx.creditLedger.create({
            data: {
              userId,
              delta: -amount,
              kind: "spend",
              action: action ?? null,
              balanceAfter,
            },
          });
          return { ok: true, balanceAfter, fromGranted, fromPurchased };
        }
        // count !== 1 → the split shifted between our read and update; loop once
        // more to re-read the current buckets and recompute the split.
      }

      // Both attempts lost the split race — re-read for an authoritative balance
      const latest = await tx.creditBalance.upsert({
        where: { userId },
        create: { userId, granted: 0, purchased: 0 },
        update: {},
      });
      return {
        ok: false,
        reason: "insufficient",
        balanceAfter: latest.granted + latest.purchased,
      };
    }
  );
}

// ── Refund credits ────────────────────────────────────────────────────────────

/**
 * Refund credits back to the exact buckets they were spent from.
 *
 * Increments `granted` by `fromGranted` and `purchased` by `fromPurchased` in
 * one atomic upsert, then writes one `kind:"refund"` ledger row.
 *
 * Throws if either bucket amount is negative (would silently corrupt the balance).
 * No-op (returns without writing any ledger row) if fromGranted+fromPurchased <= 0.
 *
 * Ledger `delta` sign convention: positive = credit (balance up), negative = debit
 * (balance down). A refund writes a POSITIVE delta.
 *
 * Intended to be called with the fromGranted/fromPurchased values returned by a
 * prior successful spendCredits call, so that balance is restored exactly.
 */
export async function refundCredits(
  userId: string,
  fromGranted: number,
  fromPurchased: number,
  action: string
): Promise<void> {
  if (fromGranted < 0 || fromPurchased < 0)
    throw new Error("refundCredits: bucket amounts must be non-negative");

  const total = fromGranted + fromPurchased;
  if (total <= 0) return;

  // Balance restore + ledger row in ONE transaction so a crash between them can
  // never diverge the balance from its audit ledger (MON-4).
  await prisma.$transaction(async (tx) => {
    // Atomically restore both buckets (upsert so row is guaranteed to exist)
    const updated = await tx.creditBalance.upsert({
      where: { userId },
      create: {
        userId,
        granted: fromGranted,
        purchased: fromPurchased,
      },
      update: {
        granted: { increment: fromGranted },
        purchased: { increment: fromPurchased },
      },
    });

    const balanceAfter = updated.granted + updated.purchased;

    await tx.creditLedger.create({
      data: {
        userId,
        delta: total,
        kind: "refund",
        action: action ?? null,
        balanceAfter,
      },
    });
  });
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

  // Prior-read + hard-set + ledger row in ONE transaction so a crash between them
  // can never diverge the balance from its audit ledger (MON-4). Reading the prior
  // value inside the transaction also makes the recorded delta consistent with the
  // value we overwrite.
  await prisma.$transaction(async (tx) => {
    // Read prior granted so we can record the true delta (upsert with granted:0 so a
    // brand-new user's reset logs the full grant as the delta — matches getBalance).
    const prior = await tx.creditBalance.upsert({
      where: { userId },
      create: { userId, granted: 0, purchased: 0 },
      update: {},
    });
    const priorGranted = prior.granted;

    // Hard-set granted and reset timestamp (row is guaranteed to exist now)
    const updated = await tx.creditBalance.update({
      where: { userId },
      data: {
        granted: newGranted,
        grantedResetAt: now,
      },
    });

    const balanceAfter = updated.granted + updated.purchased;

    await tx.creditLedger.create({
      data: {
        userId,
        delta: newGranted - priorGranted,
        kind: "grant",
        action: `monthly-reset:${plan}`,
        balanceAfter,
      },
    });
  });
}

// ── Lazy monthly grant ────────────────────────────────────────────────────────

/**
 * Ensure the user has received their current-period monthly credit allowance.
 * No-op when:
 *   - CREDITS_LIVE env is not "1" (flag-gated)
 *   - user is FREE (allowance 0)
 *   - a grant was already made within the current 30-day window
 *     (grantedResetAt is set AND less than USAGE_PERIOD_DAYS old)
 *
 * When the window has expired (or no grant was ever made), calls
 * `resetMonthlyGranted` which hard-sets `granted` to the plan allowance
 * (use-it-or-lose-it — leftover is overwritten, not rolled over).
 *
 * Idempotent: safe to call multiple times per request.
 */
export async function ensureMonthlyGrant(userId: string): Promise<void> {
  if (process.env.CREDITS_LIVE !== "1") return;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, trialEndsAt: true },
  });
  if (!user) return;

  // Trial users carry plan=PRO but credits are a PAID benefit (closes the trial-farm
  // hole). ensureMonthlyGrant is also called from /api/credits/balance for ANY user,
  // so guard here, not just on the paid webhook path.
  if (user.trialEndsAt && user.trialEndsAt.getTime() > Date.now()) return;

  const allowance = MONTHLY_GRANT[user.plan] ?? 0;
  if (allowance <= 0) return; // FREE or unknown plan — no allowance

  const balance = await prisma.creditBalance.findUnique({ where: { userId } });
  const now = Date.now();
  const windowMs = USAGE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

  const withinWindow =
    balance?.grantedResetAt !== null &&
    balance?.grantedResetAt !== undefined &&
    now - balance.grantedResetAt.getTime() < windowMs;

  if (withinWindow) return; // already granted this period

  await resetMonthlyGranted(userId, user.plan);
}
