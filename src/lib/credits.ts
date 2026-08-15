/**
 * Credit balance + ledger library (Task P3-1).
 *
 * 1 credit = ฿1.
 * Three funding classes: `granted` (monthly allowance), individually-expiring
 * promotional grants, and `purchased` (permanent until spent). Spend drains
 * whichever expiring grant lapses first and always preserves purchased last.
 *
 * Atomic pattern mirrors `reserveMinutes` in minute-limits.ts:
 * - compute expected debit from each bucket
 * - `updateMany` with a `where` that guards both fields
 * - if `count !== 1` → lost race / insufficient → re-read and return error
 */

import type { Prisma } from "@prisma/client";
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
export type PromotionalCreditDebit = { grantId: string; amount: number };
export type CreditDebit = {
  bucket: "granted" | "promotional" | "purchased";
  grantId?: string;
  amount: number;
};

export type CreditFunding = {
  fromGranted: number;
  fromPromotional: number;
  promotionalDebits: PromotionalCreditDebit[];
  fromPurchased: number;
  debits: CreditDebit[];
};

export function serializeCreditFunding(funding: CreditFunding): string {
  return JSON.stringify({
    version: 1,
    fromGranted: funding.fromGranted,
    fromPromotional: funding.fromPromotional,
    promotionalDebits: funding.promotionalDebits,
    fromPurchased: funding.fromPurchased,
    debits: funding.debits,
  });
}

export function parseCreditFunding(
  value: string | null | undefined,
  legacy: { fromGranted: number; fromPromotional?: number; fromPurchased: number },
  expectedTotal?: number,
): CreditFunding {
  if (value) {
    try {
      const parsed = JSON.parse(value) as Partial<CreditFunding> & { version?: number };
      const promotionalDebits = Array.isArray(parsed.promotionalDebits)
        ? parsed.promotionalDebits.filter((debit): debit is PromotionalCreditDebit =>
            Boolean(
              debit
              && typeof debit.grantId === "string"
              && Number.isInteger(debit.amount)
              && debit.amount >= 0,
            ),
          )
        : [];
      const fromGranted = Number.isInteger(parsed.fromGranted) && Number(parsed.fromGranted) >= 0
        ? Number(parsed.fromGranted)
        : legacy.fromGranted;
      const fromPurchased = Number.isInteger(parsed.fromPurchased) && Number(parsed.fromPurchased) >= 0
        ? Number(parsed.fromPurchased)
        : legacy.fromPurchased;
      const fromPromotional = promotionalDebits.reduce((sum, debit) => sum + debit.amount, 0);
      const debits = Array.isArray(parsed.debits)
        ? parsed.debits.filter((debit): debit is CreditDebit => Boolean(
            debit
            && ["granted", "promotional", "purchased"].includes(debit.bucket)
            && Number.isInteger(debit.amount)
            && debit.amount >= 0
            && (debit.bucket !== "promotional" || typeof debit.grantId === "string"),
          ))
        : [
            ...(fromGranted > 0 ? [{ bucket: "granted" as const, amount: fromGranted }] : []),
            ...promotionalDebits.map((debit) => ({ bucket: "promotional" as const, ...debit })),
            ...(fromPurchased > 0 ? [{ bucket: "purchased" as const, amount: fromPurchased }] : []),
          ];
      const debitTotal = debits.reduce((sum, debit) => sum + debit.amount, 0);
      if (
        debits.filter((debit) => debit.bucket === "granted").reduce((sum, debit) => sum + debit.amount, 0) !== fromGranted
        || debits.filter((debit) => debit.bucket === "promotional").reduce((sum, debit) => sum + debit.amount, 0) !== fromPromotional
        || debits.filter((debit) => debit.bucket === "purchased").reduce((sum, debit) => sum + debit.amount, 0) !== fromPurchased
        || legacy.fromGranted !== fromGranted
        || (legacy.fromPromotional !== undefined && legacy.fromPromotional !== fromPromotional)
        || legacy.fromPurchased !== fromPurchased
        || (expectedTotal !== undefined && debitTotal !== expectedTotal)
      ) {
        throw new Error("invalid credit funding snapshot totals");
      }
      return { fromGranted, fromPromotional, promotionalDebits, fromPurchased, debits };
    } catch {
      // Pre-migration or malformed rows use the conservative legacy split.
    }
  }
  // A scalar can say promo credits were charged, but only the JSON snapshot
  // identifies the exact PromotionalCreditGrant row. Never turn missing or
  // corrupt promo provenance into permanent purchased credits.
  if ((legacy.fromPromotional ?? 0) > 0) {
    throw new Error("promotional credit funding provenance is missing or invalid");
  }
  const fallbackGranted = Math.max(0, Math.min(legacy.fromGranted, expectedTotal ?? Number.POSITIVE_INFINITY));
  const fallbackPurchased = expectedTotal === undefined
    ? Math.max(0, legacy.fromPurchased)
    : Math.max(0, expectedTotal - fallbackGranted);
  return {
    fromGranted: fallbackGranted,
    fromPromotional: 0,
    promotionalDebits: [],
    fromPurchased: fallbackPurchased,
    debits: [
      ...(fallbackGranted > 0 ? [{ bucket: "granted" as const, amount: fallbackGranted }] : []),
      ...(fallbackPurchased > 0 ? [{ bucket: "purchased" as const, amount: fallbackPurchased }] : []),
    ],
  };
}

async function activePromotionalTotal(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
): Promise<number> {
  const aggregate = await tx.promotionalCreditGrant.aggregate({
    where: { userId, expiresAt: { gt: now }, remainingAmount: { gt: 0 } },
    _sum: { remainingAmount: true },
  });
  return aggregate._sum.remainingAmount ?? 0;
}

async function materializeExpiredPromotionalCredits(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
): Promise<void> {
  const expired = await tx.promotionalCreditGrant.findMany({
    where: { userId, expiresAt: { lte: now }, remainingAmount: { gt: 0 } },
    select: { id: true, remainingAmount: true },
  });
  if (expired.length === 0) return;
  let expiredAmount = 0;
  for (const grant of expired) {
    const cleared = await tx.promotionalCreditGrant.updateMany({
      where: { id: grant.id, userId, remainingAmount: grant.remainingAmount },
      data: { remainingAmount: 0 },
    });
    if (cleared.count === 1) expiredAmount += grant.remainingAmount;
  }
  if (expiredAmount <= 0) return;
  const balance = await tx.creditBalance.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  const promotional = await activePromotionalTotal(tx, userId, now);
  await tx.creditLedger.create({
    data: {
      userId,
      delta: -expiredAmount,
      kind: "expire",
      action: `promo-expire:${now.toISOString()}`,
      balanceAfter: balance.granted + promotional + balance.purchased,
      createdAt: now,
    },
  });
}

export async function getBalance(
  userId: string,
  now: Date = new Date(),
): Promise<{ granted: number; promotional: number; purchased: number; total: number }> {
  return prisma.$transaction(async (tx) => {
    await materializeExpiredPromotionalCredits(tx, userId, now);
    const row = await tx.creditBalance.upsert({
      where: { userId },
      create: { userId, granted: 0, purchased: 0 },
      update: {},
    });
    const promotional = await activePromotionalTotal(tx, userId, now);
    return {
      granted: row.granted,
      promotional,
      purchased: row.purchased,
      total: row.granted + promotional + row.purchased,
    };
  });
}

/**
 * Credits already removed from the available balance while provider/render work
 * is still in flight. Settled successful work is intentionally excluded.
 */
export async function getReservedCredits(userId: string): Promise<number> {
  const [ai, render] = await Promise.all([
    prisma.aiGenerationJob.aggregate({
      where: {
        userId,
        chargeState: "reserved",
        creditCost: { gt: 0 },
      },
      _sum: { creditCost: true },
    }),
    prisma.renderJob.aggregate({
      where: {
        userId,
        status: { in: ["QUEUED", "RUNNING"] },
        reservedQuota: true,
        creditsSpent: { gt: 0 },
      },
      _sum: { creditsSpent: true },
    }),
  ]);
  return (ai._sum.creditCost ?? 0) + (render._sum.creditsSpent ?? 0);
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

    const promotional = await activePromotionalTotal(tx, userId, new Date());
    const balanceAfter = updated.granted + promotional + updated.purchased;

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
 * Atomically spend `amount` credits (earliest-expiring monthly/promo first,
 * purchased last).
 *
 * On success: returns the exact ordered funding provenance and writes one ledger row.
 * On failure (insufficient or lost race): returns `{ ok: false, reason: "insufficient", balanceAfter }`.
 * Does NOT write a ledger row on failure.
 *
 * Ledger `delta` sign convention: positive = credit (balance up), negative = debit
 * (balance down). A spend writes a NEGATIVE delta.
 */
export type CreditSpendResult =
  | ({ ok: true; balanceAfter: number } & CreditFunding)
  | { ok: false; reason: "insufficient"; balanceAfter: number };

/** Transaction-aware credit debit used when a larger operation must reserve
 * plan minutes and credits atomically. The caller owns commit/rollback. */
export async function spendCreditsInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
  action: string,
  now: Date = new Date(),
): Promise<CreditSpendResult> {
  if (amount <= 0) throw new Error("spendCredits: amount must be positive");
  await materializeExpiredPromotionalCredits(tx, userId, now);
  const row = await tx.creditBalance.upsert({
    where: { userId },
    create: { userId, granted: 0, purchased: 0 },
    update: {},
  });
  const promoGrants = await tx.promotionalCreditGrant.findMany({
    where: { userId, expiresAt: { gt: now }, remainingAmount: { gt: 0 } },
    orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, remainingAmount: true, expiresAt: true },
  });
  const promotional = promoGrants.reduce((sum, grant) => sum + grant.remainingAmount, 0);
  const total = row.granted + promotional + row.purchased;
  if (total < amount) return { ok: false, reason: "insufficient", balanceAfter: total };

  const monthlyExpiry = row.grantedResetAt
    ? new Date(row.grantedResetAt.getTime() + USAGE_PERIOD_DAYS * 24 * 60 * 60 * 1_000)
    : now;
  const expiringBuckets: Array<
    | { kind: "monthly"; amount: number; expiresAt: Date; id: string }
    | { kind: "promo"; amount: number; expiresAt: Date; id: string }
  > = row.granted > 0
    ? [{ kind: "monthly", amount: row.granted, expiresAt: monthlyExpiry, id: "monthly" }]
    : [];
  expiringBuckets.push(...promoGrants.map((grant) => ({
    kind: "promo" as const,
    amount: grant.remainingAmount,
    expiresAt: grant.expiresAt,
    id: grant.id,
  })));
  expiringBuckets.sort((left, right) =>
    left.expiresAt.getTime() - right.expiresAt.getTime()
    || (left.kind === right.kind ? 0 : left.kind === "monthly" ? -1 : 1)
    || left.id.localeCompare(right.id),
  );

  let remaining = amount;
  let fromGranted = 0;
  const promotionalDebits: PromotionalCreditDebit[] = [];
  const debits: CreditDebit[] = [];
  for (const bucket of expiringBuckets) {
    if (remaining <= 0) break;
    const debit = Math.min(bucket.amount, remaining);
    remaining -= debit;
    if (bucket.kind === "monthly") {
      fromGranted += debit;
      debits.push({ bucket: "granted", amount: debit });
    } else {
      promotionalDebits.push({ grantId: bucket.id, amount: debit });
      debits.push({ bucket: "promotional", grantId: bucket.id, amount: debit });
    }
  }
  const fromPromotional = promotionalDebits.reduce((sum, debit) => sum + debit.amount, 0);
  const fromPurchased = remaining;
  if (fromPurchased > 0) debits.push({ bucket: "purchased", amount: fromPurchased });

  const balanceDebit = await tx.creditBalance.updateMany({
    where: { userId, granted: { gte: fromGranted }, purchased: { gte: fromPurchased } },
    data: {
      granted: { decrement: fromGranted },
      purchased: { decrement: fromPurchased },
    },
  });
  if (balanceDebit.count !== 1) throw new Error("spendCredits: wallet changed during reservation");
  for (const debit of promotionalDebits) {
    const promoDebit = await tx.promotionalCreditGrant.updateMany({
      where: { id: debit.grantId, userId, remainingAmount: { gte: debit.amount }, expiresAt: { gt: now } },
      data: { remainingAmount: { decrement: debit.amount } },
    });
    if (promoDebit.count !== 1) throw new Error("spendCredits: promo grant changed during reservation");
  }
  const balanceAfter = total - amount;
  await tx.creditLedger.create({
    data: { userId, delta: -amount, kind: "spend", action, balanceAfter, createdAt: now },
  });
  return {
    ok: true,
    balanceAfter,
    fromGranted,
    fromPromotional,
    promotionalDebits,
    fromPurchased,
    debits,
  };
}

export async function spendCredits(
  userId: string,
  amount: number,
  action: string,
  now: Date = new Date(),
): Promise<CreditSpendResult> {
  // Whole spend runs in ONE transaction so the guarded debit and its ledger row
  // commit atomically (MON-4). The transaction-aware primitive is also reused by
  // mixed minute+credit reservations so those two meters cannot split on a crash.
  return prisma.$transaction((tx) => spendCreditsInTransaction(tx, userId, amount, action, now));
}

// ── Refund credits ────────────────────────────────────────────────────────────

/**
 * Refund credits back to the exact buckets they were spent from.
 *
 * Restores monthly, promotional, and purchased funding to the exact original
 * buckets, then writes one `kind:"refund"` ledger row.
 *
 * Throws if either bucket amount is negative (would silently corrupt the balance).
 * No-op (returns without writing any ledger row) if the total refund is zero.
 *
 * Ledger `delta` sign convention: positive = credit (balance up), negative = debit
 * (balance down). A refund writes a POSITIVE delta.
 *
 * Intended to be called with the fromGranted/fromPurchased values returned by a
 * prior successful spendCredits call, so that balance is restored exactly.
 */
export async function refundCreditsInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  fromGranted: number,
  fromPurchased: number,
  action: string,
  promotionalDebits: PromotionalCreditDebit[] = [],
  now: Date = new Date(),
): Promise<void> {
  if (fromGranted < 0 || fromPurchased < 0)
    throw new Error("refundCredits: bucket amounts must be non-negative");

  const fromPromotional = promotionalDebits.reduce((sum, debit) => sum + debit.amount, 0);
  if (promotionalDebits.some((debit) => debit.amount < 0)) {
    throw new Error("refundCredits: promo bucket amounts must be non-negative");
  }
  const total = fromGranted + fromPromotional + fromPurchased;
  if (total <= 0) return;

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

  for (const debit of promotionalDebits) {
    const original = await tx.promotionalCreditGrant.findFirst({
      where: { id: debit.grantId, userId },
      select: { initialAmount: true, remainingAmount: true },
    });
    if (!original || original.remainingAmount + debit.amount > original.initialAmount) {
      throw new Error("refundCredits: promo refund exceeds the original grant");
    }
    const restored = await tx.promotionalCreditGrant.updateMany({
      where: { id: debit.grantId, userId, remainingAmount: original.remainingAmount },
      data: { remainingAmount: { increment: debit.amount } },
    });
    if (restored.count !== 1) throw new Error("refundCredits: original promo grant not found");
  }

  const promotional = await activePromotionalTotal(tx, userId, now);
  const balanceAfter = updated.granted + promotional + updated.purchased;
  await tx.creditLedger.create({
    data: {
      userId,
      delta: total,
      kind: "refund",
      action: action ?? null,
      balanceAfter,
    },
  });
}

export async function refundCredits(
  userId: string,
  fromGranted: number,
  fromPurchased: number,
  action: string,
  promotionalDebits: PromotionalCreditDebit[] = [],
  now: Date = new Date(),
): Promise<void> {
  // Balance restore + ledger row in ONE transaction so a crash between them can
  // never diverge the balance from its audit ledger (MON-4).
  await prisma.$transaction((tx) =>
    refundCreditsInTransaction(
      tx,
      userId,
      fromGranted,
      fromPurchased,
      action,
      promotionalDebits,
      now,
    ),
  );
}

// ── Monthly reset ─────────────────────────────────────────────────────────────

/**
 * Set `granted` to the plan's monthly allowance, regardless of prior value,
 * and record the reset timestamp + a ledger row.
 *
 * This does NOT touch the `purchased` bucket.
 *
 * `guard`, when passed, makes the write CONDITIONAL (MON-7): the reset only commits if
 * `grantedResetAt` in the DB still equals `guard.priorResetAt` — the value the CALLER observed
 * before deciding a reset was due. This is for `ensureMonthlyGrant`'s lazy write-on-read path,
 * where two concurrent callers (e.g. two GET /api/credits/balance requests racing the same
 * expired-window decision) could otherwise both decide a reset is due and both write a
 * monthly-reset ledger row. SQLite serializes their transactions, so the first writer's
 * updateMany matches (its `grantedResetAt` still equals what it observed) and flips the field
 * forward; the second (later) writer's guard condition no longer matches its now-stale captured
 * value, so its updateMany affects 0 rows and it no-ops instead of writing a second row.
 *
 * Force callers (grantOnPaidActivation, trial-expiry downgrade) must keep calling this WITHOUT
 * `guard` — they call it explicitly to override state, not lazily on a read, so they should
 * always win unconditionally.
 */
export async function resetMonthlyGranted(
  userId: string,
  plan: string,
  guard?: { priorResetAt: Date | null }
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

    let updatedGranted: number;
    let updatedPurchased: number;

    if (guard) {
      const flipped = await tx.creditBalance.updateMany({
        where: { userId, grantedResetAt: guard.priorResetAt },
        data: { granted: newGranted, grantedResetAt: now },
      });
      if (flipped.count !== 1) return; // lost the race — another caller already reset this window
      updatedGranted = newGranted;
      updatedPurchased = prior.purchased;
    } else {
      // Hard-set granted and reset timestamp (row is guaranteed to exist now)
      const updated = await tx.creditBalance.update({
        where: { userId },
        data: {
          granted: newGranted,
          grantedResetAt: now,
        },
      });
      updatedGranted = updated.granted;
      updatedPurchased = updated.purchased;
    }

    const promotional = await activePromotionalTotal(tx, userId, now);
    const balanceAfter = updatedGranted + promotional + updatedPurchased;

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

  // MON-7: guard the reset with the grantedResetAt value we just observed, so a concurrent GET
  // racing this same expired-window decision can't ALSO write a monthly-reset ledger row — see
  // resetMonthlyGranted's guarded branch.
  await resetMonthlyGranted(userId, user.plan, { priorResetAt: balance?.grantedResetAt ?? null });
}
