/**
 * Managed stock B-roll key (issue #297, ADR 0025 + Amendment 2026-08-26) —
 * PURE policy layer.
 *
 * BYOK stays the product default for the PAID AI providers (Gemini / HeyGen /
 * ElevenLabs — CLAUDE.md). Stock search is different: Pexels and Pixabay are
 * free, so BYOK's cost rationale never applied to them. Since the 2026-08-26
 * amendment the rule is one line:
 *
 *     nobody needs their own Pexels/Pixabay key to make a clip.
 *
 * ANY account with no stock key of its own — FREE, trial, PRO, BUSINESS,
 * coupon/grant, bundle — searches on the team-operated key instead of
 * hard-stopping on `missing_key: broll`. The only real constraint is provider
 * rate limits, which Pixabay-first + the 24h cache + per-job caps + the token
 * buckets + the monthly Pexels ceiling below already manage.
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

/** Pexels is the only provider with a MONTHLY ceiling (20,000 req/month).
 *  The token bucket above cannot hold a month-long line — it lives in process
 *  memory and refills to full on every deploy/restart — so the monthly budget is
 *  counted in the database (`ManagedStockUsage`). Default sits well under the
 *  published 20k so a restart storm can never walk us into a hard provider block.
 *  Overridable per env via `MANAGED_STOCK_PEXELS_PER_MONTH`. */
export const MANAGED_STOCK_PEXELS_PER_MONTH_DEFAULT = 18_000;

/** Pixabay publishes no monthly cap, so only Pexels is metered per month.
 *  Usage is still COUNTED for both providers (admin visibility). */
export const MANAGED_STOCK_MONTHLY_CAPPED_PROVIDERS: readonly ManagedStockProvider[] = ["pexels"];

export function managedStockHasMonthlyCap(provider: ManagedStockProvider): boolean {
  return MANAGED_STOCK_MONTHLY_CAPPED_PROVIDERS.includes(provider);
}

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
  /**
   * RETIRED by the 2026-08-26 amendment and never returned any more. Kept in the
   * union (not deleted) so stored telemetry, admin queries and any caller that
   * still switches on the old reason keep type-checking. Do not reintroduce it:
   * plan is deliberately not part of the decision.
   */
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
  /**
   * Carried for readability and for the eligibility matrix in
   * `scripts/verify-managed-stock.ts`, which asserts that FREE / PRO / BUSINESS /
   * coupon-grant all land on the SAME answer. Deliberately not read below.
   */
  plan?: string;
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
 *  5. everyone else → eligible.
 *
 * Step 5 is the 2026-08-26 amendment. The original ADR 0025 stopped at
 * trial/FREE and kept `missing_key: broll` for paid-equivalent accounts, on a
 * capacity argument. Measured on 2026-08-26: 698 FREE accounts were already
 * eligible and widening adds ~97 accounts (4 of them real payers) against a
 * whole-system volume of ~3,289 search queries/week — the paid slice is noise,
 * not a second customer base. Plan is therefore NOT an input: a paying customer
 * hitting a wall that a FREE account does not hit was never defensible.
 */
export function decideManagedStockEligibility(
  input: ManagedStockEligibilityInput,
): ManagedStockEligibility {
  if (!input.flagOn) return { eligible: false, reason: "flag_off" };
  if (input.hasOwnPexelsKey || input.hasOwnPixabayKey) return { eligible: false, reason: "own_key" };
  if (input.suspended) return { eligible: false, reason: "suspended" };
  if (!input.hasManagedKey) return { eligible: false, reason: "no_managed_key" };
  return { eligible: true, reason: "eligible" };
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

// ── Monthly Pexels budget (Amendment 2026-08-26) ────────────────────────────
// The token bucket above is an in-PROCESS courtesy limiter: it refills to full
// on every `pm2 restart`, so it cannot hold a month-long line. Pexels' 20k/month
// is the ceiling that actually binds now that every keyless account is served,
// so month-to-date usage is counted in the database (`ManagedStockUsage`) and
// the helpers below decide against it. Everything here is pure and clock-injected.

/** Asia/Bangkok is UTC+7 all year (no DST), so a fixed offset is exact. */
export const MANAGED_STOCK_PERIOD_TZ_OFFSET_MINUTES = 7 * 60;
const PERIOD_OFFSET_MS = MANAGED_STOCK_PERIOD_TZ_OFFSET_MINUTES * 60_000;

/** `YYYY-MM` of the Asia/Bangkok calendar month — the budget's reset boundary. */
export function managedStockPeriodKey(now: Date | number = Date.now()): string {
  const ms = typeof now === "number" ? now : now.getTime();
  const shifted = new Date(ms + PERIOD_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The instant a period's budget resets: 00:00 Bangkok on the 1st of the NEXT
 *  month, returned as a plain UTC `Date` for display. `null` on a malformed key. */
export function managedStockPeriodResetAt(periodKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec(periodKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!(month >= 1 && month <= 12)) return null;
  const rolls = month === 12;
  return new Date(Date.UTC(rolls ? year + 1 : year, rolls ? 0 : month, 1) - PERIOD_OFFSET_MS);
}

export type ManagedStockMonthlyDecision = {
  allowed: boolean;
  reason: "ok" | "no_monthly_cap" | "usage_unknown" | "month_exhausted";
};

/**
 * Fail-CLOSED on a KNOWN-exhausted budget, fail-OPEN on anything unknown.
 *
 * `used === null` means the counter could not be read (or written) — a database
 * hiccup must never be able to switch Pexels off for a whole month, so an
 * unknown count is allowed through. Only a count we actually read and that has
 * reached the ceiling stops the provider, and even then the JOB never fails: the
 * caller skips Pexels and degrades to Pixabay → key-free photo providers → AI
 * images, exactly as it does for a dead provider today.
 */
export function decideManagedStockMonthlyBudget(input: {
  provider: ManagedStockProvider;
  used: number | null;
  ceiling: number;
}): ManagedStockMonthlyDecision {
  if (!managedStockHasMonthlyCap(input.provider)) return { allowed: true, reason: "no_monthly_cap" };
  if (input.used === null || !Number.isFinite(input.used)) return { allowed: true, reason: "usage_unknown" };
  if (!Number.isFinite(input.ceiling) || input.ceiling <= 0) return { allowed: true, reason: "usage_unknown" };
  if (input.used >= input.ceiling) return { allowed: false, reason: "month_exhausted" };
  return { allowed: true, reason: "ok" };
}

// ── Telemetry contract ──────────────────────────────────────────────────────
// Names are constants so the emitter (`managed-stock.server.ts`), the admin
// reader (`/api/admin/insights`) and the verify script can never drift apart.

export const MANAGED_STOCK_USED_EVENT = "managed_stock_used";
export const MANAGED_STOCK_THROTTLED_EVENT = "managed_stock_throttled";

/** Which limiter refused the call: the per-hour/per-minute token bucket
 *  (`rate`) or the monthly Pexels ceiling (`month`). */
export const MANAGED_STOCK_THROTTLE_SCOPES = ["rate", "month"] as const;
export type ManagedStockThrottleScope = (typeof MANAGED_STOCK_THROTTLE_SCOPES)[number];

export type ManagedStockTelemetryRow = {
  name: string;
  properties?: string | null;
};

export type ManagedStockTelemetrySummary = {
  usedEvents: number;
  searches: number;
  cacheHits: number;
  byProvider: Array<{ provider: string; queries: number; cacheHits: number }>;
  throttles: Array<{ provider: string; scope: string; count: number }>;
};

function readProps(raw: string | null | undefined): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Roll `managed_stock_used` / `managed_stock_throttled` rows into the numbers the
 * admin panel shows. Pure (no DB, no clock) so the verify script can pin the
 * event names and the property shape without a database.
 *
 * Events written before the amendment carry no `scope`; they were all token-bucket
 * throttles, so they are reported as `rate` rather than dropped.
 */
export function summarizeManagedStockTelemetry(
  rows: readonly ManagedStockTelemetryRow[],
): ManagedStockTelemetrySummary {
  const byProvider = new Map<string, { provider: string; queries: number; cacheHits: number }>();
  const throttles = new Map<string, { provider: string; scope: string; count: number }>();
  let usedEvents = 0;

  for (const row of rows) {
    if (row.name !== MANAGED_STOCK_USED_EVENT && row.name !== MANAGED_STOCK_THROTTLED_EVENT) continue;
    const props = readProps(row.properties);
    const provider = typeof props?.provider === "string" ? props.provider : "unknown";

    if (row.name === MANAGED_STOCK_USED_EVENT) {
      usedEvents += 1;
      const entry = byProvider.get(provider) ?? { provider, queries: 0, cacheHits: 0 };
      entry.queries += countOf(props?.queriesUsed);
      entry.cacheHits += countOf(props?.cacheHits);
      byProvider.set(provider, entry);
      continue;
    }

    const scope = typeof props?.scope === "string" ? props.scope : "rate";
    const key = `${provider}:${scope}`;
    const entry = throttles.get(key) ?? { provider, scope, count: 0 };
    entry.count += 1;
    throttles.set(key, entry);
  }

  const providers = Array.from(byProvider.values()).sort((a, b) => b.queries - a.queries);
  return {
    usedEvents,
    searches: providers.reduce((sum, p) => sum + p.queries, 0),
    cacheHits: providers.reduce((sum, p) => sum + p.cacheHits, 0),
    byProvider: providers,
    throttles: Array.from(throttles.values()).sort((a, b) => b.count - a.count),
  };
}

/**
 * Cache key for one provider search. Includes every parameter that changes the
 * result set, so a deeper `perPage` or a different `minDuration` can never be
 * served a narrower cached answer.
 *
 * `variant` carries the B-roll preference (see `brollPreferenceCacheVariant`):
 * without it, changing "คนและสถานที่"/"สไตล์ฟุตเทจสต็อก" and re-rendering inside
 * the 24h window returned byte-identical clips (F7 cause #2). An EMPTY variant
 * is appended as nothing at all, so every cache entry written before this
 * change stays valid for the no-preference case — a deploy must not cold-start
 * the whole cache into a burst of live Pexels/Pixabay calls.
 */
export function stockSearchCacheKey(input: {
  query: string;
  perPage: number;
  minDuration: number;
  page?: number;
  variant?: string;
}): string {
  const query = input.query.trim().toLowerCase().replace(/\s+/g, " ");
  const base = `${query}|pp=${Math.trunc(input.perPage)}|md=${Math.trunc(input.minDuration)}|p=${Math.trunc(input.page ?? 1)}`;
  const variant = typeof input.variant === "string" ? input.variant.trim() : "";
  return variant ? `${base}|v=${variant}` : base;
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
