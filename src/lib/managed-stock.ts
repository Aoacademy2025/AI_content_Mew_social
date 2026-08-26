/**
 * Managed stock B-roll key (issue #297, ADR 0025) — PURE policy layer.
 *
 * BYOK stays the product default (CLAUDE.md). This is a narrow, flag-gated
 * managed exception in the ADR 0003 shape: trial / FREE accounts with NO stock
 * key of their own may search Pexels/Pixabay on a team-operated key so the
 * second clip (and every later clip) does not hard-stop on `missing_key: broll`.
 *
 * Everything here is deterministic and dependency-free so it can be unit-tested
 * (`scripts/verify-managed-stock.ts`) and imported from BOTH server routes and
 * client components. No secrets are read here — key material is resolved only in
 * `managed-stock.server.ts`.
 *
 * FLAG-OFF PROOF: every entry point below short-circuits on `flagOn === false`
 * before touching plan/trial/key state, and callers resolve managed keys to
 * `null`, so with `MANAGED_STOCK` unset the request path is the pre-#297 one.
 */

export const MANAGED_STOCK_PROVIDERS = ["pixabay", "pexels"] as const;
export type ManagedStockProvider = (typeof MANAGED_STOCK_PROVIDERS)[number];

/** Pixabay ToS requires search results to be cached for 24h. Pexels allows it. */
export const MANAGED_STOCK_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

/** Default token-bucket sizes — deliberately BELOW each provider's published
 *  ceiling (Pexels 200/h, Pixabay 100/min) so the managed key never trips a 429
 *  that would also punish the next customer. Overridable per env. */
export const MANAGED_STOCK_PEXELS_PER_HOUR_DEFAULT = 150;
export const MANAGED_STOCK_PIXABAY_PER_MIN_DEFAULT = 80;

/** Per-job caps on the managed key only (BYOK jobs are unchanged). */
export const MANAGED_STOCK_MAX_ALT_QUERIES_PER_KEYWORD = 2;
/** primary keyword + at most 2 alternates */
export const MANAGED_STOCK_MAX_QUERIES_PER_KEYWORD = 1 + MANAGED_STOCK_MAX_ALT_QUERIES_PER_KEYWORD;
export const MANAGED_STOCK_MAX_QUERIES_PER_JOB = 40;
/** Page 2 is a "last resort" extra call. Never spent on the shared key. */
export const MANAGED_STOCK_ALLOW_PAGE_TWO = false;
/** Pixabay-first: only reach for Pexels when Pixabay came back thin. */
export const MANAGED_STOCK_PEXELS_FALLBACK_THRESHOLD = 3;

export type ManagedStockEligibilityReason =
  | "eligible"
  | "flag_off"
  | "own_key"
  | "suspended"
  | "no_managed_key"
  | "not_trial_or_free";

export type ManagedStockEligibility = {
  eligible: boolean;
  reason: ManagedStockEligibilityReason;
};

export type ManagedStockEligibilityInput = {
  /** `MANAGED_STOCK === "1"` (server env only). */
  flagOn: boolean;
  /** At least one managed provider key is configured on the server. */
  hasManagedKey: boolean;
  hasOwnPexelsKey: boolean;
  hasOwnPixabayKey: boolean;
  /** `resolvePaidEquivalentEntitlement(...).canUsePaidFeatures` */
  paidEquivalent: boolean;
  /** Live 7-day Conversion Trial (plan reads PRO while it runs). */
  conversionTrial: boolean;
  plan: string;
  suspended?: boolean;
};

/**
 * Who may search on the team key.
 *
 * Order is load-bearing:
 *  1. flag off  → nothing changes for anyone (byte-identical path).
 *  2. own key   → BYOK ALWAYS wins; a customer's own quota/curation is never
 *                 silently replaced by ours, and we never spend the shared key
 *                 on someone who already brought one.
 *  3. suspended → fail closed.
 *  4. no key configured on the server → nothing to offer.
 *  5. trial or FREE only.
 *
 * Paid-equivalent accounts (subscription / paid term / bundle / grant coupon /
 * administrator grant) with no stock key deliberately KEEP today's
 * `missing_key: broll` 400. Rationale: #297 is an activation problem — the 2.1%
 * vs 65.5% start-rate gap is at signup, before anyone pays — and the capacity
 * math in ADR 0025 only closes because the managed key serves the trial/FREE
 * slice. Widening it to every paying account without a key would put the whole
 * customer base on one Pexels quota. Paid accounts also have a working paid path
 * today (they can set a free key in ~1 minute, and Hero AI Image is unlocked).
 */
export function decideManagedStockEligibility(
  input: ManagedStockEligibilityInput,
): ManagedStockEligibility {
  if (!input.flagOn) return { eligible: false, reason: "flag_off" };
  if (input.hasOwnPexelsKey || input.hasOwnPixabayKey) return { eligible: false, reason: "own_key" };
  if (input.suspended) return { eligible: false, reason: "suspended" };
  if (!input.hasManagedKey) return { eligible: false, reason: "no_managed_key" };
  if (input.conversionTrial) return { eligible: true, reason: "eligible" };
  if (!input.paidEquivalent && input.plan === "FREE") return { eligible: true, reason: "eligible" };
  return { eligible: false, reason: "not_trial_or_free" };
}

/** Pixabay-first rule: Pexels is only worth a call when Pixabay came back thin. */
export function shouldQueryPexelsAfterPixabay(pixabayCandidateCount: number): boolean {
  return pixabayCandidateCount < MANAGED_STOCK_PEXELS_FALLBACK_THRESHOLD;
}

/** Managed jobs try the primary query plus at most 2 alternates per keyword. */
export function capManagedQueriesForKeyword<T>(queries: readonly T[]): T[] {
  return queries.slice(0, MANAGED_STOCK_MAX_QUERIES_PER_KEYWORD);
}

/** Whole-job ceiling on managed searches. One instance per fetch-stock request. */
export class ManagedStockJobBudget {
  private used = 0;

  constructor(private readonly max: number = MANAGED_STOCK_MAX_QUERIES_PER_JOB) {}

  /** Claim one query slot. `false` = budget spent, caller must stop searching. */
  take(): boolean {
    if (this.used >= this.max) return false;
    this.used += 1;
    return true;
  }

  get spent(): number {
    return this.used;
  }

  get exhausted(): boolean {
    return this.used >= this.max;
  }
}

/**
 * Continuous-refill token bucket. In-process is enough: production is a single
 * VPS running one PM2 app (CLAUDE.md), and the bucket is a courtesy limiter in
 * front of the provider's own limit, not a billing boundary.
 *
 * Deterministic — the clock is always injected, so the verify script can prove
 * refill/exhaustion without sleeping.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    readonly capacity: number,
    readonly refillWindowMs: number,
    startedAtMs = 0,
  ) {
    if (!(capacity > 0)) throw new Error("TokenBucket capacity must be > 0");
    if (!(refillWindowMs > 0)) throw new Error("TokenBucket refillWindowMs must be > 0");
    this.tokens = capacity;
    this.lastRefillMs = startedAtMs;
  }

  private refill(nowMs: number) {
    if (nowMs <= this.lastRefillMs) return;
    const elapsed = nowMs - this.lastRefillMs;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.capacity) / this.refillWindowMs);
    this.lastRefillMs = nowMs;
  }

  available(nowMs: number): number {
    this.refill(nowMs);
    return this.tokens;
  }

  /** `false` = exhausted → skip this provider for now (never fail the job). */
  tryTake(nowMs: number, count = 1): boolean {
    this.refill(nowMs);
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }
}

/**
 * Cache key for one provider search. Includes every parameter that changes the
 * result set, so a deeper `perPage` or a different `minDuration` can never be
 * served a narrower cached answer.
 */
export function stockSearchCacheKey(input: {
  query: string;
  perPage: number;
  minDuration: number;
  page?: number;
}): string {
  const query = input.query.trim().toLowerCase().replace(/\s+/g, " ");
  return `${query}|pp=${Math.trunc(input.perPage)}|md=${Math.trunc(input.minDuration)}|p=${Math.trunc(input.page ?? 1)}`;
}

export function stockSearchCacheExpiry(nowMs: number): Date {
  return new Date(nowMs + MANAGED_STOCK_CACHE_TTL_MS);
}

export function isStockSearchCacheFresh(expiresAt: Date | string | number, nowMs: number): boolean {
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  return Number.isFinite(ms) && ms > nowMs;
}

/**
 * Client-safe flag read. Build-baked, so it may only drive COPY (the "จำเป็น" →
 * "ไม่บังคับ" labels and the day-one wizard suppression), never access control —
 * the server flag `MANAGED_STOCK` is the only authority for spending the key.
 */
export function isManagedStockClientEnabled(): boolean {
  return process.env.NEXT_PUBLIC_MANAGED_STOCK === "1";
}

/** One-line Step-2 nudge shown after the first completed export (UX option (c)).
 *  Split in two so the second half can be the link without slicing a string at
 *  render time; `MANAGED_STOCK_BROLL_HINT` is the exact copy they compose to. */
export const MANAGED_STOCK_BROLL_HINT_LEAD = "คลังสต็อก: ใช้ของระบบ";
export const MANAGED_STOCK_BROLL_HINT_CTA = "ใส่ key ของคุณเองเพื่อเลือกภาพได้มากขึ้น (ฟรี, 1 นาที)";
export const MANAGED_STOCK_BROLL_HINT = `${MANAGED_STOCK_BROLL_HINT_LEAD} · ${MANAGED_STOCK_BROLL_HINT_CTA}`;
export const MANAGED_STOCK_BROLL_HINT_HREF = "/settings?tab=api-keys";
