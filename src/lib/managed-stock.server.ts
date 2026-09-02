import "server-only";

import { prisma } from "@/lib/prisma";
import { recordTelemetryEvent } from "@/lib/telemetry";
import {
  decideManagedStockEligibility,
  decideManagedStockMonthlyBudget,
  isStockSearchCacheFresh,
  managedStockHasMonthlyCap,
  managedStockPeriodKey,
  MANAGED_STOCK_PEXELS_PER_HOUR_DEFAULT,
  MANAGED_STOCK_PEXELS_PER_MONTH_DEFAULT,
  MANAGED_STOCK_PIXABAY_PER_MIN_DEFAULT,
  MANAGED_STOCK_PROVIDERS,
  MANAGED_STOCK_THROTTLED_EVENT,
  MANAGED_STOCK_USED_EVENT,
  stockSearchCacheExpiry,
  stockSearchCacheKey,
  TokenBucket,
  type ManagedStockEligibility,
  type ManagedStockProvider,
  type ManagedStockThrottleScope,
} from "@/lib/managed-stock";

/**
 * Server half of the managed stock key (issue #297, ADR 0025).
 *
 * Holds the things that must never reach the browser or a log line: the key
 * material, the shared token buckets, the 24h search cache, and the persisted
 * monthly Pexels counter.
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

/**
 * Only what the decision actually reads. Trial dates and paid-equivalent
 * entitlement were inputs before the 2026-08-26 amendment; they are gone rather
 * than left unused, because resolving them cost `/api/user/me` — a hot route — a
 * whole extra entitlement lookup on every single request.
 */
export type ManagedStockUserFacts = {
  id: string;
  plan?: string | null;
  suspended?: boolean | null;
};

/**
 * Decide whether THIS request may search on the team key, and hand back the key
 * material when it may. `hasOwnPexelsKey` / `hasOwnPixabayKey` are passed in by
 * the caller (which already decrypted them) so this never touches ciphertext.
 *
 * Since the 2026-08-26 amendment this is a PURE function of the flag, the
 * server env and two booleans — zero database work on any path, including the
 * eligible one. It is called from `/api/user/me` on every dashboard poll.
 */
export async function resolveManagedStockAccess(
  user: ManagedStockUserFacts | null | undefined,
  ownKeys: { hasOwnPexelsKey: boolean; hasOwnPixabayKey: boolean },
): Promise<ManagedStockAccess> {
  if (!isManagedStockFlagOn()) return DENIED("flag_off");
  if (!user) return DENIED("suspended");
  // BYOK wins first — we never spend the shared key on someone who brought one.
  if (ownKeys.hasOwnPexelsKey || ownKeys.hasOwnPixabayKey) return DENIED("own_key");
  if (user.suspended) return DENIED("suspended");

  const keys = managedStockKeys();
  const hasManagedKey = Boolean(keys.pexelsKey || keys.pixabayKey);
  if (!hasManagedKey) return DENIED("no_managed_key");

  const decision = decideManagedStockEligibility({
    flagOn: true,
    hasManagedKey,
    hasOwnPexelsKey: ownKeys.hasOwnPexelsKey,
    hasOwnPixabayKey: ownKeys.hasOwnPixabayKey,
    plan: user.plan ?? undefined,
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

// ── Monthly Pexels budget (Amendment 2026-08-26) ────────────────────────────
// The token buckets above live in process memory and refill to full on every
// deploy, so they cannot enforce Pexels' 20,000-req/MONTH ceiling. Now that every
// keyless account is served, that ceiling is the one that actually binds, so
// month-to-date usage is counted in `ManagedStockUsage` (provider + `YYYY-MM` in
// Asia/Bangkok, atomically incremented).
//
// Two rules, both from ADR 0025's fail-closed section:
//   • a KNOWN-exhausted month stops Pexels (fail closed) — Pixabay, the key-free
//     photo providers and AI images carry the job, which never fails;
//   • a counter that cannot be read or written is UNKNOWN, so it allows the call
//     (fail open). A database hiccup must not switch Pexels off for a month.

export function managedStockPexelsMonthlyCeiling(): number {
  // Upper bound is generous rather than 20,000: ADR 0025 anticipates asking Pexels
  // for a raised quota, and that grant must be configurable without a code change.
  return readIntEnv("MANAGED_STOCK_PEXELS_PER_MONTH", MANAGED_STOCK_PEXELS_PER_MONTH_DEFAULT, 1, 1_000_000);
}

/** Process-local mirror of the DB counter: one read per provider per minute
 *  instead of one per search, plus every increment this process made. */
type MonthlyUsageCache = { periodKey: string; used: number | null; readAtMs: number };
const MONTHLY_USAGE_REFRESH_MS = 60_000;
const monthlyUsage = new Map<ManagedStockProvider, MonthlyUsageCache>();

/** Test seam only — reset the in-process mirror between cases. */
export function __resetManagedStockMonthlyCacheForTests() {
  monthlyUsage.clear();
}

async function loadMonthlyUsage(
  provider: ManagedStockProvider,
  periodKey: string,
  nowMs: number,
): Promise<number | null> {
  const cached = monthlyUsage.get(provider);
  if (cached && cached.periodKey === periodKey && nowMs - cached.readAtMs < MONTHLY_USAGE_REFRESH_MS) {
    return cached.used;
  }
  try {
    const row = await prisma.managedStockUsage.findUnique({
      where: { provider_periodKey: { provider, periodKey } },
      select: { count: true },
    });
    const used = row?.count ?? 0;
    monthlyUsage.set(provider, { periodKey, used, readAtMs: nowMs });
    return used;
  } catch {
    // Unknown, not zero and not exhausted — decideManagedStockMonthlyBudget
    // fails OPEN on null so a broken counter never blocks a render.
    monthlyUsage.set(provider, { periodKey, used: null, readAtMs: nowMs });
    return null;
  }
}

/**
 * `false` = this provider's monthly budget is spent; skip it for the rest of the
 * month. Never throws, never fails a job. Only Pexels is metered.
 */
export async function hasManagedStockMonthlyBudget(
  provider: ManagedStockProvider,
  now: Date = new Date(),
): Promise<boolean> {
  if (!managedStockHasMonthlyCap(provider)) return true;
  const periodKey = managedStockPeriodKey(now);
  const used = await loadMonthlyUsage(provider, periodKey, now.getTime());
  return decideManagedStockMonthlyBudget({
    provider,
    used,
    ceiling: managedStockPexelsMonthlyCeiling(),
  }).allowed;
}

/**
 * Count one managed provider call. Atomic (`count = count + 1`) so concurrent
 * renders cannot lose increments, and completely swallowed on failure — the
 * counter is a budget guard, never a reason a customer's render dies.
 *
 * Called for BOTH providers: Pixabay has no monthly cap but its volume is what
 * makes the Pexels number readable in `/admin/insights`.
 */
export async function recordManagedStockCall(
  provider: ManagedStockProvider,
  now: Date = new Date(),
): Promise<void> {
  const periodKey = managedStockPeriodKey(now);
  const cached = monthlyUsage.get(provider);
  if (cached && cached.periodKey === periodKey && cached.used !== null) {
    // Keep the in-process mirror ahead of the next refresh so the ceiling binds
    // within this minute too, not only after the cache expires.
    cached.used += 1;
  }
  const where = { provider_periodKey: { provider, periodKey } };
  try {
    await prisma.managedStockUsage.upsert({
      where,
      update: { count: { increment: 1 } },
      create: { provider, periodKey, count: 1 },
    });
  } catch {
    // Lost the create race with a concurrent request → the row exists now.
    try {
      await prisma.managedStockUsage.update({ where, data: { count: { increment: 1 } } });
    } catch {
      /* counter is best effort; the render continues either way */
    }
  }
}

export type ManagedStockMonthlyStatus = {
  provider: ManagedStockProvider;
  periodKey: string;
  used: number;
  /** null for providers with no monthly ceiling (Pixabay). */
  ceiling: number | null;
  usedPct: number | null;
  exhausted: boolean;
};

/** Admin read (`/api/admin/insights`): month-to-date usage per provider. */
export async function readManagedStockMonthlyStatus(
  now: Date = new Date(),
): Promise<ManagedStockMonthlyStatus[]> {
  const periodKey = managedStockPeriodKey(now);
  let counts = new Map<string, number>();
  try {
    const rows = await prisma.managedStockUsage.findMany({
      where: { periodKey },
      select: { provider: true, count: true },
    });
    counts = new Map(rows.map((row) => [row.provider, row.count]));
  } catch {
    /* an unreadable counter shows as 0 rather than breaking the admin page */
  }
  const ceiling = managedStockPexelsMonthlyCeiling();
  return MANAGED_STOCK_PROVIDERS.map((provider) => {
    const used = counts.get(provider) ?? 0;
    const capped = managedStockHasMonthlyCap(provider);
    return {
      provider,
      periodKey,
      used,
      ceiling: capped ? ceiling : null,
      usedPct: capped && ceiling > 0 ? Math.round((used / ceiling) * 1000) / 10 : null,
      exhausted: capped && used >= ceiling,
    };
  });
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
  /** B-roll preference discriminator (`brollPreferenceCacheVariant`) — two
   *  different Step-2 preferences must never share one cached answer. */
  variant?: string;
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

/** A throttle event names WHICH limiter refused: the per-hour/per-minute token
 *  bucket (`rate`) or the monthly Pexels ceiling (`month`). `/admin/insights`
 *  splits by it — they mean very different things operationally. */
export type ManagedStockThrottleStats = ManagedStockUsageStats & {
  scope: ManagedStockThrottleScope;
};

export async function recordManagedStockUsed(userId: string | null, stats: ManagedStockUsageStats) {
  await recordTelemetryEvent(userId, {
    name: MANAGED_STOCK_USED_EVENT,
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

export async function recordManagedStockThrottled(userId: string | null, stats: ManagedStockThrottleStats) {
  await recordTelemetryEvent(userId, {
    name: MANAGED_STOCK_THROTTLED_EVENT,
    category: "product",
    source: "server",
    step: "fetchStock",
    status: "throttled",
    value: stats.queriesUsed,
    properties: {
      provider: stats.provider,
      scope: stats.scope,
      queriesUsed: stats.queriesUsed,
      cacheHits: stats.cacheHits,
    },
  }).catch(() => {});
}
