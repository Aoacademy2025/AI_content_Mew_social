/**
 * verify-managed-stock — pure contract tests for the managed Pexels/Pixabay key
 * (issue #297, ADR 0025 + Amendment 2026-08-26).
 *
 * Covers the rules that keep the shared key safe:
 *   1. eligibility   — flag-gated, own key always wins, PLAN-INDEPENDENT
 *   2. Pixabay-first — Pexels is only asked when Pixabay came back thin
 *   3. per-job caps  — ≤2 alt queries/keyword, ≤40 provider queries/job
 *   4. token bucket  — Pexels 150/h, Pixabay 80/min, refill, fail-closed skip
 *   5. cache keys    — 24h TTL, and no two different searches share a key
 *   6. monthly budget — Asia/Bangkok periods, boundary, fail-open on an unknown
 *                       counter, fail-CLOSED on a known-exhausted month
 *   7. telemetry     — event names + property shape the admin panel reads
 *   8. key checklist — renders nothing for an account that needs no key
 *
 * No DB, no network, no clock, and NO CALLS TO THE REAL PROVIDERS: everything
 * under test is deterministic.
 */

import {
  capManagedQueriesForKeyword,
  decideManagedStockEligibility,
  decideManagedStockMonthlyBudget,
  isStockSearchCacheFresh,
  managedStockHasMonthlyCap,
  managedStockPeriodKey,
  managedStockPeriodResetAt,
  ManagedStockJobBudget,
  MANAGED_STOCK_CACHE_TTL_MS,
  MANAGED_STOCK_MAX_ALT_QUERIES_PER_KEYWORD,
  MANAGED_STOCK_MAX_QUERIES_PER_JOB,
  MANAGED_STOCK_MAX_QUERIES_PER_KEYWORD,
  MANAGED_STOCK_ALLOW_PAGE_TWO,
  MANAGED_STOCK_PEXELS_FALLBACK_THRESHOLD,
  MANAGED_STOCK_PEXELS_PER_HOUR_DEFAULT,
  MANAGED_STOCK_PEXELS_PER_MONTH_DEFAULT,
  MANAGED_STOCK_PIXABAY_PER_MIN_DEFAULT,
  MANAGED_STOCK_THROTTLED_EVENT,
  MANAGED_STOCK_THROTTLE_SCOPES,
  MANAGED_STOCK_USED_EVENT,
  shouldQueryPexelsAfterPixabay,
  stockSearchCacheExpiry,
  stockSearchCacheKey,
  summarizeManagedStockTelemetry,
  TokenBucket,
  type ManagedStockEligibilityInput,
} from "../src/lib/managed-stock";
import { computeKeyStatus, planKeySetupChecklist } from "../src/lib/key-tiers";

let failures = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}`);
  }
}

// ── 1. Eligibility ──────────────────────────────────────────────────────────
// Amendment 2026-08-26: ONE rule — nobody needs their own stock key to make a
// clip. Plan is not an input, so the matrix below asserts that FREE, PRO,
// BUSINESS and a coupon/grant account all land on the SAME answer.
const base: ManagedStockEligibilityInput = {
  flagOn: true,
  hasManagedKey: true,
  hasOwnPexelsKey: false,
  hasOwnPixabayKey: false,
  plan: "FREE",
};

console.log("eligibility");
check(
  "flag off denies everyone (byte-identical path)",
  decideManagedStockEligibility({ ...base, flagOn: false }).reason === "flag_off",
);

const PLANS = ["FREE", "PRO", "BUSINESS"] as const;
for (const plan of PLANS) {
  check(
    `${plan} with no key of its own is eligible`,
    decideManagedStockEligibility({ ...base, plan }).eligible,
  );
  check(
    `${plan} with its OWN Pexels key is denied (BYOK wins)`,
    decideManagedStockEligibility({ ...base, plan, hasOwnPexelsKey: true }).reason === "own_key",
  );
  check(
    `${plan} with its OWN Pixabay key is denied (BYOK wins)`,
    decideManagedStockEligibility({ ...base, plan, hasOwnPixabayKey: true }).reason === "own_key",
  );
}

check(
  "Conversion Trial (plan reads PRO) is eligible",
  decideManagedStockEligibility({ ...base, plan: "PRO" }).eligible,
);
check(
  "coupon/grant PRO with no key is NOW eligible (was not_trial_or_free)",
  decideManagedStockEligibility({ ...base, plan: "PRO" }).reason === "eligible",
);
check(
  "a BUSINESS payer with no key is NOW eligible (was not_trial_or_free)",
  decideManagedStockEligibility({ ...base, plan: "BUSINESS" }).reason === "eligible",
);
check(
  "bundle/grant accounts on an unknown plan string are eligible too",
  decideManagedStockEligibility({ ...base, plan: "SOMETHING_ELSE" }).eligible,
);
check(
  "plan is not part of the decision at all (omitted === FREE === BUSINESS)",
  decideManagedStockEligibility({ ...base, plan: undefined }).reason
    === decideManagedStockEligibility({ ...base, plan: "BUSINESS" }).reason,
);
check(
  "`not_trial_or_free` is never returned any more",
  PLANS.every((plan) => decideManagedStockEligibility({ ...base, plan }).reason !== "not_trial_or_free"),
);
check(
  "own key wins even for a trial account",
  decideManagedStockEligibility({ ...base, plan: "PRO", hasOwnPixabayKey: true }).reason === "own_key",
);
check(
  "own key wins even for a BUSINESS payer",
  decideManagedStockEligibility({ ...base, plan: "BUSINESS", hasOwnPexelsKey: true }).reason === "own_key",
);
check(
  "suspended accounts fail closed",
  decideManagedStockEligibility({ ...base, suspended: true }).reason === "suspended",
);
check(
  "suspended fails closed on a paid plan too",
  decideManagedStockEligibility({ ...base, plan: "BUSINESS", suspended: true }).reason === "suspended",
);
check(
  "no managed key configured on the server → nothing to offer",
  decideManagedStockEligibility({ ...base, hasManagedKey: false }).reason === "no_managed_key",
);
check(
  "flag off outranks every other input",
  decideManagedStockEligibility({
    ...base, flagOn: false, plan: "BUSINESS", suspended: true, hasOwnPexelsKey: true,
  }).reason === "flag_off",
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

// ── 6. Monthly Pexels budget (Amendment 2026-08-26) ─────────────────────────
console.log("\nmonthly pexels budget");
check("default ceiling is 18,000/month (under Pexels' 20,000)", MANAGED_STOCK_PEXELS_PER_MONTH_DEFAULT === 18_000);
check("Pexels is metered per month", managedStockHasMonthlyCap("pexels"));
check("Pixabay publishes no monthly cap, so it is not metered", !managedStockHasMonthlyCap("pixabay"));

// Period keys are Asia/Bangkok (UTC+7, no DST) — a UTC month boundary is NOT
// the budget boundary, and getting that wrong would reset the ceiling 7h early.
check(
  "period key is the Bangkok calendar month",
  managedStockPeriodKey(Date.parse("2026-08-15T09:00:00Z")) === "2026-08",
);
check(
  "23:30 UTC on the last of the month is ALREADY the next Bangkok month",
  managedStockPeriodKey(Date.parse("2026-08-31T23:30:00Z")) === "2026-09",
);
check(
  "16:59 UTC on the last of the month is still the old Bangkok month",
  managedStockPeriodKey(Date.parse("2026-08-31T16:59:00Z")) === "2026-08",
);
check(
  "17:00 UTC on the last of the month flips the period",
  managedStockPeriodKey(Date.parse("2026-08-31T17:00:00Z")) === "2026-09",
);
check("a Date and its epoch ms give the same key", managedStockPeriodKey(new Date(1_756_000_000_000)) === managedStockPeriodKey(1_756_000_000_000));

const resetAt = managedStockPeriodResetAt("2026-08");
check("reset is 00:00 Bangkok on the 1st of the next month", resetAt?.toISOString() === "2026-08-31T17:00:00.000Z");
check("the reset instant already belongs to the next period", resetAt !== null && managedStockPeriodKey(resetAt) === "2026-09");
check("one ms before the reset is still the old period", resetAt !== null && managedStockPeriodKey(resetAt.getTime() - 1) === "2026-08");
check("December rolls the year", managedStockPeriodResetAt("2026-12")?.toISOString() === "2026-12-31T17:00:00.000Z");
check("a malformed period key has no reset instant", managedStockPeriodResetAt("nope") === null);
check("month 13 is rejected", managedStockPeriodResetAt("2026-13") === null);

const CEILING = MANAGED_STOCK_PEXELS_PER_MONTH_DEFAULT;
const pexelsBudget = (used: number | null, ceiling = CEILING) =>
  decideManagedStockMonthlyBudget({ provider: "pexels", used, ceiling });

// Boundary: the ceiling is the number of calls ALLOWED, so `used === ceiling`
// means the budget is spent, not that one more is free.
check("a fresh month allows the call", pexelsBudget(0).allowed);
check("one call below the ceiling is still allowed", pexelsBudget(CEILING - 1).allowed);
check("exactly at the ceiling is EXHAUSTED (fail closed)", !pexelsBudget(CEILING).allowed);
check("past the ceiling stays exhausted", !pexelsBudget(CEILING + 5_000).allowed);
check("the exhausted reason names the month scope", pexelsBudget(CEILING).reason === "month_exhausted");
check("a raised ceiling from env re-opens the month", pexelsBudget(CEILING, CEILING * 2).allowed);
check("a lowered ceiling closes it immediately", !pexelsBudget(100, 100).allowed);

// Fail OPEN on anything we do not actually know: a database hiccup on the
// counter must never be able to switch Pexels off for a whole month.
check("an unreadable counter fails OPEN", pexelsBudget(null).allowed);
check("an unreadable counter is reported as unknown, not as ok", pexelsBudget(null).reason === "usage_unknown");
check("NaN usage fails OPEN", pexelsBudget(Number.NaN).allowed);
check("a misconfigured ceiling of 0 fails OPEN", pexelsBudget(50, 0).allowed);
check("a negative ceiling fails OPEN", pexelsBudget(50, -1).allowed);

// Pixabay is never stopped by the monthly gate, even at absurd counts.
check(
  "Pixabay is never month-throttled",
  decideManagedStockMonthlyBudget({ provider: "pixabay", used: 10_000_000, ceiling: CEILING }).allowed,
);
check(
  "…and says so explicitly",
  decideManagedStockMonthlyBudget({ provider: "pixabay", used: 10_000_000, ceiling: CEILING }).reason
    === "no_monthly_cap",
);

// ── 7. Telemetry contract ───────────────────────────────────────────────────
console.log("\ntelemetry");
check("used event name is managed_stock_used", MANAGED_STOCK_USED_EVENT === "managed_stock_used");
check("throttled event name is managed_stock_throttled", MANAGED_STOCK_THROTTLED_EVENT === "managed_stock_throttled");
check(
  "throttle scopes are exactly rate + month",
  MANAGED_STOCK_THROTTLE_SCOPES.join(",") === "rate,month",
);

const telemetrySummary = summarizeManagedStockTelemetry([
  { name: "managed_stock_used", properties: JSON.stringify({ provider: "pixabay", queriesUsed: 12, cacheHits: 3 }) },
  { name: "managed_stock_used", properties: JSON.stringify({ provider: "pexels", queriesUsed: 4, cacheHits: 1 }) },
  { name: "managed_stock_used", properties: JSON.stringify({ provider: "pixabay", queriesUsed: 8, cacheHits: 2 }) },
  { name: "managed_stock_throttled", properties: JSON.stringify({ provider: "pexels", scope: "month", queriesUsed: 0, cacheHits: 0 }) },
  { name: "managed_stock_throttled", properties: JSON.stringify({ provider: "pexels", scope: "rate", queriesUsed: 3, cacheHits: 0 }) },
  // Pre-amendment row: no `scope` property at all.
  { name: "managed_stock_throttled", properties: JSON.stringify({ provider: "pexels", queriesUsed: 1, cacheHits: 0 }) },
  // Noise the admin route must ignore.
  { name: "render_server_done", properties: JSON.stringify({ provider: "pexels", queriesUsed: 999 }) },
  { name: "managed_stock_used", properties: null },
  { name: "managed_stock_used", properties: "{not json" },
]);
check("searches sum across providers", telemetrySummary.searches === 24);
check("cache hits sum across providers", telemetrySummary.cacheHits === 6);
check("unrelated events are ignored", telemetrySummary.usedEvents === 5);
check(
  "per-provider rollup is sorted by volume",
  telemetrySummary.byProvider[0]?.provider === "pixabay" && telemetrySummary.byProvider[0]?.queries === 20,
);
check(
  "a month throttle is reported under its own scope",
  telemetrySummary.throttles.some((row) => row.provider === "pexels" && row.scope === "month" && row.count === 1),
);
check(
  "pre-amendment throttles (no scope) are counted as rate, not dropped",
  telemetrySummary.throttles.some((row) => row.provider === "pexels" && row.scope === "rate" && row.count === 2),
);
check(
  "unparseable properties never throw and never invent a provider",
  telemetrySummary.byProvider.some((row) => row.provider === "unknown" && row.queries === 0),
);
check("no rows at all is an empty summary, not a crash", summarizeManagedStockTelemetry([]).searches === 0);

// ── 8. Key checklist ────────────────────────────────────────────────────────
// With the managed library serving every keyless account, an account whose only
// other requirement (Gemini) is also managed needs NO key — the card must render
// nothing rather than show a blocker that no longer exists.
console.log("\nkey setup checklist");
const noKeys = computeKeyStatus({ gemini: false, pexels: false, pixabay: false });
const managedGeminiStatus = computeKeyStatus({ gemini: false, pexels: false, pixabay: false }, true);

check(
  "managed Gemini + managed stock → nothing to ask for, render nothing",
  !planKeySetupChecklist({ status: managedGeminiStatus, managedGemini: true, managedStock: true }).render,
);
check(
  "…and it reports zero requirements",
  planKeySetupChecklist({ status: managedGeminiStatus, managedGemini: true, managedStock: true }).totalRequired === 0,
);
check(
  "managed stock alone still asks for the BYOK Gemini key",
  planKeySetupChecklist({ status: noKeys, managedGemini: false, managedStock: true }).render,
);
check(
  "…and stock is shown as optional, not required",
  !planKeySetupChecklist({ status: noKeys, managedGemini: false, managedStock: true }).stockRequired,
);
check(
  "…counting exactly one requirement (Gemini)",
  planKeySetupChecklist({ status: noKeys, managedGemini: false, managedStock: true }).totalRequired === 1,
);
check(
  "flag off keeps the original two-requirement card",
  planKeySetupChecklist({ status: noKeys, managedGemini: false, managedStock: false }).totalRequired === 2,
);
check(
  "an account that already has both keys renders nothing",
  !planKeySetupChecklist({
    status: computeKeyStatus({ gemini: true, pexels: true, pixabay: false }),
    managedGemini: false,
    managedStock: false,
  }).render,
);
check(
  "a Gemini key alone still renders the card when stock is required",
  planKeySetupChecklist({
    status: computeKeyStatus({ gemini: true, pexels: false, pixabay: false }),
    managedGemini: false,
    managedStock: false,
  }).render,
);
check(
  "…but not once the managed library covers the stock half",
  !planKeySetupChecklist({
    status: computeKeyStatus({ gemini: true, pexels: false, pixabay: false }),
    managedGemini: false,
    managedStock: true,
  }).render,
);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nverify-managed-stock: PASS");
