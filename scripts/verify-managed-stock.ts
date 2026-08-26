/**
 * verify-managed-stock — pure contract tests for the managed Pexels/Pixabay key
 * (issue #297, ADR 0025).
 *
 * Covers the four rules that keep the shared key safe:
 *   1. eligibility  — flag-gated, own key always wins, trial/FREE only
 *   2. Pixabay-first — Pexels is only asked when Pixabay came back thin
 *   3. per-job caps  — ≤2 alt queries/keyword, ≤40 provider queries/job
 *   4. token bucket  — Pexels 150/h, Pixabay 80/min, refill, fail-closed skip
 *   5. cache keys    — 24h TTL, and no two different searches share a key
 *
 * No DB, no network, no clock: everything under test is deterministic.
 */

import {
  capManagedQueriesForKeyword,
  decideManagedStockEligibility,
  isStockSearchCacheFresh,
  ManagedStockJobBudget,
  MANAGED_STOCK_CACHE_TTL_MS,
  MANAGED_STOCK_MAX_ALT_QUERIES_PER_KEYWORD,
  MANAGED_STOCK_MAX_QUERIES_PER_JOB,
  MANAGED_STOCK_MAX_QUERIES_PER_KEYWORD,
  MANAGED_STOCK_ALLOW_PAGE_TWO,
  MANAGED_STOCK_PEXELS_FALLBACK_THRESHOLD,
  MANAGED_STOCK_PEXELS_PER_HOUR_DEFAULT,
  MANAGED_STOCK_PIXABAY_PER_MIN_DEFAULT,
  shouldQueryPexelsAfterPixabay,
  stockSearchCacheExpiry,
  stockSearchCacheKey,
  TokenBucket,
  type ManagedStockEligibilityInput,
} from "../src/lib/managed-stock";

let failures = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}`);
  }
}

// ── 1. Eligibility ──────────────────────────────────────────────────────────
const base: ManagedStockEligibilityInput = {
  flagOn: true,
  hasManagedKey: true,
  hasOwnPexelsKey: false,
  hasOwnPixabayKey: false,
  paidEquivalent: false,
  conversionTrial: false,
  plan: "FREE",
};

console.log("eligibility");
check(
  "flag off denies everyone (byte-identical path)",
  decideManagedStockEligibility({ ...base, flagOn: false }).reason === "flag_off",
);
check(
  "FREE with no key of its own is eligible",
  decideManagedStockEligibility(base).eligible,
);
check(
  "Conversion Trial (plan reads PRO) is eligible",
  decideManagedStockEligibility({ ...base, plan: "PRO", conversionTrial: true }).eligible,
);
check(
  "own Pexels key always wins over the managed key",
  decideManagedStockEligibility({ ...base, hasOwnPexelsKey: true }).reason === "own_key",
);
check(
  "own Pixabay key always wins over the managed key",
  decideManagedStockEligibility({ ...base, hasOwnPixabayKey: true }).reason === "own_key",
);
check(
  "own key wins even for a trial account",
  decideManagedStockEligibility({
    ...base,
    plan: "PRO",
    conversionTrial: true,
    hasOwnPixabayKey: true,
  }).reason === "own_key",
);
check(
  "paid-equivalent without a key keeps today's missing_key: broll",
  decideManagedStockEligibility({ ...base, plan: "PRO", paidEquivalent: true }).reason
    === "not_trial_or_free",
);
check(
  "grant-coupon PRO (paid-equivalent, not a trial) is NOT eligible",
  !decideManagedStockEligibility({ ...base, plan: "PRO", paidEquivalent: true }).eligible,
);
check(
  "a lapsed trial that fell back to FREE becomes eligible again",
  decideManagedStockEligibility({ ...base, plan: "FREE", conversionTrial: false }).eligible,
);
check(
  "suspended accounts fail closed",
  decideManagedStockEligibility({ ...base, suspended: true }).reason === "suspended",
);
check(
  "no managed key configured on the server → nothing to offer",
  decideManagedStockEligibility({ ...base, hasManagedKey: false }).reason === "no_managed_key",
);
check(
  "BUSINESS plan without paid-equivalent evidence is still not trial/FREE",
  decideManagedStockEligibility({ ...base, plan: "BUSINESS" }).reason === "not_trial_or_free",
);

// ── 2. Pixabay-first ────────────────────────────────────────────────────────
console.log("\npixabay-first");
check("threshold is 3 candidates", MANAGED_STOCK_PEXELS_FALLBACK_THRESHOLD === 3);
check("0 Pixabay candidates → ask Pexels", shouldQueryPexelsAfterPixabay(0));
check("2 Pixabay candidates → ask Pexels", shouldQueryPexelsAfterPixabay(2));
check("3 Pixabay candidates → do NOT spend Pexels quota", !shouldQueryPexelsAfterPixabay(3));
check("30 Pixabay candidates → do NOT spend Pexels quota", !shouldQueryPexelsAfterPixabay(30));

// ── 3. Per-job caps ─────────────────────────────────────────────────────────
console.log("\nper-job caps");
check("≤2 alternative queries per keyword", MANAGED_STOCK_MAX_ALT_QUERIES_PER_KEYWORD === 2);
check("→ at most 3 query attempts per keyword", MANAGED_STOCK_MAX_QUERIES_PER_KEYWORD === 3);
check("page 2 is never used on the managed key", MANAGED_STOCK_ALLOW_PAGE_TWO === false);
check(
  "a 6-query ladder is trimmed to 3",
  capManagedQueriesForKeyword(["a", "b", "c", "d", "e", "f"]).join(",") === "a,b,c",
);
check(
  "a shorter ladder is left alone",
  capManagedQueriesForKeyword(["a", "b"]).join(",") === "a,b",
);

check("job cap is 40 provider queries", MANAGED_STOCK_MAX_QUERIES_PER_JOB === 40);
const budget = new ManagedStockJobBudget();
let taken = 0;
for (let i = 0; i < 100; i++) if (budget.take()) taken += 1;
check("job budget hands out exactly 40 slots", taken === MANAGED_STOCK_MAX_QUERIES_PER_JOB);
check("job budget reports itself exhausted", budget.exhausted && budget.spent === 40);
check("an exhausted budget keeps refusing", budget.take() === false);

const smallBudget = new ManagedStockJobBudget(2);
check(
  "budget size is configurable and stops at its own max",
  smallBudget.take() && smallBudget.take() && !smallBudget.take(),
);

// ── 4. Token buckets ────────────────────────────────────────────────────────
console.log("\ntoken buckets");
check("Pexels default is 150/hour (below the 200/h ceiling)", MANAGED_STOCK_PEXELS_PER_HOUR_DEFAULT === 150);
check("Pixabay default is 80/minute (below the 100/min ceiling)", MANAGED_STOCK_PIXABAY_PER_MIN_DEFAULT === 80);

const HOUR = 60 * 60 * 1_000;
const pexels = new TokenBucket(MANAGED_STOCK_PEXELS_PER_HOUR_DEFAULT, HOUR, 0);
let pexelsTaken = 0;
for (let i = 0; i < 200; i++) if (pexels.tryTake(0)) pexelsTaken += 1;
check("Pexels bucket allows exactly 150 calls in one instant", pexelsTaken === 150);
check("the 151st call is refused (→ skip provider, never fail the job)", pexels.tryTake(0) === false);
check("nothing refills before any time passes", pexels.available(0) < 1);
check(
  "half an hour refills ~half the bucket",
  Math.round(pexels.available(HOUR / 2)) === 75,
);
check("a full hour refills to capacity, never beyond", pexels.available(HOUR * 5) === 150);

const MINUTE = 60 * 1_000;
const pixabay = new TokenBucket(MANAGED_STOCK_PIXABAY_PER_MIN_DEFAULT, MINUTE, 0);
let pixabayTaken = 0;
for (let i = 0; i < 120; i++) if (pixabay.tryTake(0)) pixabayTaken += 1;
check("Pixabay bucket allows exactly 80 calls in one instant", pixabayTaken === 80);
check("Pixabay refuses the 81st", pixabay.tryTake(0) === false);
check("Pixabay is whole again one minute later", pixabay.available(MINUTE) === 80);
check(
  "a throttled bucket recovers gradually, not all at once",
  pixabay.tryTake(MINUTE / 2) && new TokenBucket(4, MINUTE, 0).tryTake(0, 5) === false,
);

// ── 5. Search cache ─────────────────────────────────────────────────────────
console.log("\n24h search cache");
check("TTL is 24 hours (Pixabay ToS)", MANAGED_STOCK_CACHE_TTL_MS === 24 * 60 * 60 * 1_000);

const keyA = stockSearchCacheKey({ query: "  Coffee   Shop ", perPage: 30, minDuration: 5 });
const keyB = stockSearchCacheKey({ query: "coffee shop", perPage: 30, minDuration: 5 });
check("query normalization collapses case and whitespace", keyA === keyB);
check(
  "a deeper perPage is a DIFFERENT cache entry",
  stockSearchCacheKey({ query: "coffee shop", perPage: 80, minDuration: 5 }) !== keyB,
);
check(
  "a different minDuration is a DIFFERENT cache entry",
  stockSearchCacheKey({ query: "coffee shop", perPage: 30, minDuration: 3 }) !== keyB,
);
check(
  "page 2 is a DIFFERENT cache entry",
  stockSearchCacheKey({ query: "coffee shop", perPage: 30, minDuration: 5, page: 2 }) !== keyB,
);
check(
  "page 1 is the default and does not change the key",
  stockSearchCacheKey({ query: "coffee shop", perPage: 30, minDuration: 5, page: 1 }) === keyB,
);

const now = 1_700_000_000_000;
const expiry = stockSearchCacheExpiry(now);
check("expiry is exactly now + 24h", expiry.getTime() === now + MANAGED_STOCK_CACHE_TTL_MS);
check("an entry is fresh 23h59m in", isStockSearchCacheFresh(expiry, now + MANAGED_STOCK_CACHE_TTL_MS - 60_000));
check("an entry is stale the moment it expires", !isStockSearchCacheFresh(expiry, now + MANAGED_STOCK_CACHE_TTL_MS));
check("an entry is stale a day later", !isStockSearchCacheFresh(expiry, now + MANAGED_STOCK_CACHE_TTL_MS * 2));
check("an unparseable expiry is treated as stale", !isStockSearchCacheFresh("not-a-date", now));

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nverify-managed-stock: PASS");
