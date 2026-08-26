import "server-only";

import { prisma } from "@/lib/prisma";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { resolvePaidEquivalentEntitlement } from "@/lib/paid-equivalent-entitlement.server";
import {
  decideManagedStockEligibility,
  isStockSearchCacheFresh,
  MANAGED_STOCK_PEXELS_PER_HOUR_DEFAULT,
  MANAGED_STOCK_PIXABAY_PER_MIN_DEFAULT,
  stockSearchCacheExpiry,
  stockSearchCacheKey,
  TokenBucket,
  type ManagedStockEligibility,
  type ManagedStockProvider,
} from "@/lib/managed-stock";

/**
 * Server half of the managed stock key (issue #297, ADR 0025).
 *
 * Holds the three things that must never reach the browser or a log line:
 * the key material, the shared token buckets, and the 24h search cache.
 *
 * FLAG-OFF PROOF: `resolveManagedStockAccess` returns a non-eligible decision
 * with null keys and performs ZERO database work when `MANAGED_STOCK !== "1"`.
 */

export type ManagedStockAccess = ManagedStockEligibility & {
  /** Non-null only when `eligible` — never expose or log these. */
  pexelsKey: string | null;
  pixabayKey: string | null;
};

const DENIED = (reason: ManagedStockEligibility["reason"]): ManagedStockAccess => ({
  eligible: false,
  reason,
  pexelsKey: null,
  pixabayKey: null,
});

export function isManagedStockFlagOn(): boolean {
  return process.env.MANAGED_STOCK === "1";
}

function envKey(name: string): string | null {
  const raw = process.env[name];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

/** Managed key material. Server env only — never a DB column, never client state. */
export function managedStockKeys(): { pexelsKey: string | null; pixabayKey: string | null } {
  return {
    pexelsKey: envKey("MANAGED_PEXELS_API_KEY"),
    pixabayKey: envKey("MANAGED_PIXABAY_API_KEY"),
  };
}

export type ManagedStockUserFacts = {
  id: string;
  plan: string;
  suspended?: boolean | null;
  trialStartedAt?: Date | null;
  trialEndsAt?: Date | null;
};

/**
 * Decide whether THIS request may search on the team key, and hand back the key
 * material when it may. `hasOwnPexelsKey` / `hasOwnPixabayKey` are passed in by
 * the caller (which already decrypted them) so this never touches ciphertext.
 */
export async function resolveManagedStockAccess(
  user: ManagedStockUserFacts | null | undefined,
  ownKeys: { hasOwnPexelsKey: boolean; hasOwnPixabayKey: boolean },
  now: Date = new Date(),
): Promise<ManagedStockAccess> {
  if (!isManagedStockFlagOn()) return DENIED("flag_off");
  if (!user) return DENIED("suspended");
  // Cheapest disqualifiers first — BYOK wins before we spend a DB round-trip.
  if (ownKeys.hasOwnPexelsKey || ownKeys.hasOwnPixabayKey) return DENIED("own_key");
  if (user.suspended) return DENIED("suspended");

  const keys = managedStockKeys();
  const hasManagedKey = Boolean(keys.pexelsKey || keys.pixabayKey);
  if (!hasManagedKey) return DENIED("no_managed_key");

  const paidEquivalent = await resolvePaidEquivalentEntitlement(user.id, now);
  // Same shape as resolveFirstClipPath's Conversion Trial test: a live trial that
  // is NOT already covered by a paid-equivalent entitlement.
  const conversionTrial = Boolean(
    !paidEquivalent.canUsePaidFeatures
    && user.trialStartedAt
    && user.trialStartedAt <= now
    && user.trialEndsAt
    && user.trialEndsAt > now,
  );

  const decision = decideManagedStockEligibility({
    flagOn: true,
    hasManagedKey,
    hasOwnPexelsKey: ownKeys.hasOwnPexelsKey,
    hasOwnPixabayKey: ownKeys.hasOwnPixabayKey,
    paidEquivalent: paidEquivalent.canUsePaidFeatures,
    conversionTrial,
    plan: user.plan,
    suspended: Boolean(user.suspended),
  });

  if (!decision.eligible) return DENIED(decision.reason);
  return { ...decision, pexelsKey: keys.pexelsKey, pixabayKey: keys.pixabayKey };
}

// ── Token buckets ───────────────────────────────────────────────────────────
// Process-wide, shared by every managed request. Sized below each provider's
// published ceiling so we throttle ourselves before the provider does.

let buckets: Record<ManagedStockProvider, TokenBucket> | null = null;

function managedStockBuckets(): Record<ManagedStockProvider, TokenBucket> {
  if (!buckets) {
    const now = Date.now();
    buckets = {
      pexels: new TokenBucket(
        readIntEnv("MANAGED_STOCK_PEXELS_PER_HOUR", MANAGED_STOCK_PEXELS_PER_HOUR_DEFAULT, 1, 200),
        60 * 60 * 1_000,
        now,
      ),
      pixabay: new TokenBucket(
        readIntEnv("MANAGED_STOCK_PIXABAY_PER_MIN", MANAGED_STOCK_PIXABAY_PER_MIN_DEFAULT, 1, 100),
        60 * 1_000,
        now,
      ),
    };
  }
  return buckets;
}

/** `false` = provider is throttled right now; skip it, never fail the job. */
export function takeManagedStockToken(provider: ManagedStockProvider, nowMs = Date.now()): boolean {
  return managedStockBuckets()[provider].tryTake(nowMs);
}

// ── 24h search cache ────────────────────────────────────────────────────────
// Required by Pixabay's ToS (results must be cached for 24h) and the reason the
// capacity math in ADR 0025 closes. ONLY successful responses are stored — an
// error path must never be able to poison a whole day of searches.

/** A single cached search response is capped so one 80-result Pexels page can
 *  never turn the cache table into the biggest thing in a SQLite file. Past the
 *  cap we simply do not cache — correctness is unaffected. */
const MAX_CACHED_RESULTS_BYTES = 512 * 1024;

export type StockSearchCacheParams = {
  provider: ManagedStockProvider;
  query: string;
  perPage: number;
  minDuration: number;
  page?: number;
};

export async function readStockSearchCache<T>(
  params: StockSearchCacheParams,
  now: Date = new Date(),
): Promise<T[] | null> {
  const queryKey = stockSearchCacheKey(params);
  try {
    const row = await prisma.stockSearchCache.findUnique({
      where: { provider_queryKey: { provider: params.provider, queryKey } },
      select: { resultsJson: true, expiresAt: true },
    });
    if (!row || !isStockSearchCacheFresh(row.expiresAt, now.getTime())) return null;
    const parsed = JSON.parse(row.resultsJson);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    // A cache miss and a cache failure are the same thing to the caller.
    return null;
  }
}

export async function writeStockSearchCache(
  params: StockSearchCacheParams,
  results: unknown[],
  now: Date = new Date(),
): Promise<void> {
  const queryKey = stockSearchCacheKey(params);
  const expiresAt = stockSearchCacheExpiry(now.getTime());
  try {
    const resultsJson = JSON.stringify(results);
    if (Buffer.byteLength(resultsJson, "utf8") > MAX_CACHED_RESULTS_BYTES) return;
    await prisma.stockSearchCache.upsert({
      where: { provider_queryKey: { provider: params.provider, queryKey } },
      update: { resultsJson, expiresAt, createdAt: now },
      create: { provider: params.provider, queryKey, resultsJson, expiresAt, createdAt: now },
    });
  } catch {
    // Caching is an optimisation, never a reason to fail a render.
  }
}

/** Opportunistic pruning of expired rows (cheap; runs at most once per job). */
export async function pruneExpiredStockSearchCache(now: Date = new Date()): Promise<void> {
  try {
    await prisma.stockSearchCache.deleteMany({ where: { expiresAt: { lt: now } } });
  } catch {
    /* best effort */
  }
}

// ── Telemetry ───────────────────────────────────────────────────────────────

export type ManagedStockUsageStats = {
  provider: ManagedStockProvider;
  queriesUsed: number;
  cacheHits: number;
};

export async function recordManagedStockUsed(userId: string | null, stats: ManagedStockUsageStats) {
  await recordTelemetryEvent(userId, {
    name: "managed_stock_used",
    category: "product",
    source: "server",
    step: "fetchStock",
    status: "done",
    value: stats.queriesUsed,
    properties: {
      provider: stats.provider,
      queriesUsed: stats.queriesUsed,
      cacheHits: stats.cacheHits,
    },
  }).catch(() => {});
}

export async function recordManagedStockThrottled(userId: string | null, stats: ManagedStockUsageStats) {
  await recordTelemetryEvent(userId, {
    name: "managed_stock_throttled",
    category: "product",
    source: "server",
    step: "fetchStock",
    status: "throttled",
    value: stats.queriesUsed,
    properties: {
      provider: stats.provider,
      queriesUsed: stats.queriesUsed,
      cacheHits: stats.cacheHits,
    },
  }).catch(() => {});
}
