/**
 * verify-managed-stock-server — the DB-backed half of the managed stock key
 * (#297, ADR 0025 + Amendment 2026-08-26). The pure contracts live in
 * `verify-managed-stock.ts`; this covers what only a real database can prove:
 *
 *   1. `resolveManagedStockAccess` serves ANY keyless plan and hands back key
 *      material only when eligible — and does ZERO database work doing it.
 *   2. The monthly Pexels counter increments ATOMICALLY under concurrency.
 *   3. A known-exhausted month fails CLOSED (Pexels skipped, Pixabay untouched).
 *   4. An unreadable/unwritable counter fails OPEN and never throws at a render.
 *
 * Runs against a throwaway SQLite (the repo's verify pattern) — no production
 * data, no network, and NEVER a call to the real Pexels/Pixabay APIs. The
 * managed keys below are obvious dummies and are never printed.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "managed-stock-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
// Flag ON + dummy managed keys: this file exercises the flag-ON behaviour.
process.env.MANAGED_STOCK = "1";
process.env.MANAGED_PEXELS_API_KEY = "dummy-pexels-not-a-real-key";
process.env.MANAGED_PIXABAY_API_KEY = "dummy-pixabay-not-a-real-key";
// Tiny ceiling so the boundary is reachable without 18,000 writes.
process.env.MANAGED_STOCK_PEXELS_PER_MONTH = "5";
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

let failures = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}`);
  }
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const {
    resolveManagedStockAccess,
    hasManagedStockMonthlyBudget,
    recordManagedStockCall,
    readManagedStockMonthlyStatus,
    managedStockPexelsMonthlyCeiling,
    __resetManagedStockMonthlyCacheForTests,
  } = await import("../src/lib/managed-stock.server");

  // ── 1. Eligibility through the real resolver ──────────────────────────────
  console.log("eligibility (real resolver, flag ON)");
  const keyless = { hasOwnPexelsKey: false, hasOwnPixabayKey: false };

  for (const plan of ["FREE", "PRO", "BUSINESS", "SOME_GRANT_PLAN"]) {
    const access = await resolveManagedStockAccess({ id: `u-${plan}`, plan, suspended: false }, keyless);
    check(
      `${plan} with no stock key is served (no missing_key: broll)`,
      access.eligible && access.reason === "eligible" && !!access.pexelsKey && !!access.pixabayKey,
    );
  }
  check(
    "a null user fails closed",
    !(await resolveManagedStockAccess(null, keyless)).eligible,
  );

  const byok = await resolveManagedStockAccess({ id: "u-byok", plan: "BUSINESS" }, { hasOwnPexelsKey: true, hasOwnPixabayKey: false });
  check("BYOK wins even on BUSINESS", !byok.eligible && byok.reason === "own_key");
  check("a denied decision NEVER carries key material", byok.pexelsKey === null && byok.pixabayKey === null);

  const suspended = await resolveManagedStockAccess({ id: "u-s", plan: "PRO", suspended: true }, keyless);
  check("suspended fails closed with no key material", !suspended.eligible && suspended.reason === "suspended" && suspended.pexelsKey === null);

  // The whole point of dropping the entitlement lookup: /api/user/me calls this
  // on every dashboard poll, so it must not touch the database at all.
  let queries = 0;
  const countQueries = () => { queries += 1; };
  const realUserFind = prisma.user.findUnique;
  (prisma.user as unknown as { findUnique: unknown }).findUnique = async (...args: unknown[]) => {
    countQueries();
    return (realUserFind as (...a: unknown[]) => unknown).apply(prisma.user, args);
  };
  await resolveManagedStockAccess({ id: "u-hot", plan: "PRO" }, keyless);
  (prisma.user as unknown as { findUnique: unknown }).findUnique = realUserFind;
  check("the hot /api/user/me path performs no user lookup", queries === 0);

  const flagOff = process.env.MANAGED_STOCK;
  process.env.MANAGED_STOCK = "0";
  const off = await resolveManagedStockAccess({ id: "u-off", plan: "FREE" }, keyless);
  check("flag off → flag_off with no key material (rollback is total)", !off.eligible && off.reason === "flag_off" && off.pexelsKey === null);
  process.env.MANAGED_STOCK = flagOff;

  // ── 2/3. Monthly counter + fail-closed boundary ───────────────────────────
  console.log("\nmonthly pexels counter (throwaway SQLite)");
  check("ceiling is read from MANAGED_STOCK_PEXELS_PER_MONTH", managedStockPexelsMonthlyCeiling() === 5);
  await prisma.managedStockUsage.deleteMany({});
  __resetManagedStockMonthlyCacheForTests();
  check("a fresh month allows Pexels", await hasManagedStockMonthlyBudget("pexels"));

  // 20 concurrent renders must not lose a single increment.
  await Promise.all(Array.from({ length: 20 }, () => recordManagedStockCall("pexels")));
  __resetManagedStockMonthlyCacheForTests();
  const afterConcurrent = await readManagedStockMonthlyStatus();
  const pexels = afterConcurrent.find((row) => row.provider === "pexels");
  check("20 concurrent increments all landed (atomic upsert)", pexels?.used === 20);
  check("status reports the configured ceiling", pexels?.ceiling === 5);
  check("status reports exhaustion", pexels?.exhausted === true);
  check("FAIL CLOSED: an exhausted month stops Pexels", (await hasManagedStockMonthlyBudget("pexels")) === false);
  check("Pixabay is never stopped by the monthly gate", await hasManagedStockMonthlyBudget("pixabay"));
  check(
    "Pixabay usage is counted but uncapped",
    afterConcurrent.find((row) => row.provider === "pixabay")?.ceiling === null,
  );

  // The in-process mirror must bind inside the same refresh window, otherwise a
  // burst inside one minute could overshoot the ceiling by the whole burst.
  await prisma.managedStockUsage.deleteMany({});
  __resetManagedStockMonthlyCacheForTests();
  check("counter reset → Pexels allowed again", await hasManagedStockMonthlyBudget("pexels"));
  for (let i = 0; i < 5; i += 1) await recordManagedStockCall("pexels");
  check("the ceiling binds within the same minute (no DB re-read needed)", (await hasManagedStockMonthlyBudget("pexels")) === false);
  const rows = await prisma.managedStockUsage.findMany({ where: { provider: "pexels" } });
  check("one row per provider per period (unique constraint holds)", rows.length === 1 && rows[0]?.count === 5);
  assert.match(rows[0]?.periodKey ?? "", /^\d{4}-\d{2}$/, "periodKey is YYYY-MM");

  // ── 4. Fail OPEN on counter errors ────────────────────────────────────────
  console.log("\nfail-open on counter errors");
  __resetManagedStockMonthlyCacheForTests();
  const realFind = prisma.managedStockUsage.findUnique;
  (prisma.managedStockUsage as unknown as { findUnique: unknown }).findUnique = async () => {
    throw new Error("counter table unreachable");
  };
  check("an UNREADABLE counter allows the call (never a month-long outage)", await hasManagedStockMonthlyBudget("pexels"));
  (prisma.managedStockUsage as unknown as { findUnique: unknown }).findUnique = realFind;

  const realUpsert = prisma.managedStockUsage.upsert;
  const realUpdate = prisma.managedStockUsage.update;
  (prisma.managedStockUsage as unknown as { upsert: unknown }).upsert = async () => {
    throw new Error("counter write failed");
  };
  (prisma.managedStockUsage as unknown as { update: unknown }).update = async () => {
    throw new Error("counter write failed");
  };
  let threw = false;
  try {
    await recordManagedStockCall("pexels");
  } catch {
    threw = true;
  }
  check("a FAILED counter write never throws at the render", !threw);
  (prisma.managedStockUsage as unknown as { upsert: unknown }).upsert = realUpsert;
  (prisma.managedStockUsage as unknown as { update: unknown }).update = realUpdate;

  const realStatusFind = prisma.managedStockUsage.findMany;
  (prisma.managedStockUsage as unknown as { findMany: unknown }).findMany = async () => {
    throw new Error("counter table unreachable");
  };
  const degraded = await readManagedStockMonthlyStatus();
  check("the admin read degrades to zeros instead of throwing", degraded.length === 2 && degraded.every((row) => row.used === 0));
  (prisma.managedStockUsage as unknown as { findMany: unknown }).findMany = realStatusFind;

  // ── 5. The two integration points are actually wired ──────────────────────
  // Source assertions (the repo's verify convention): the resolver above is only
  // useful if the job-create gate and the search path really consult it.
  console.log("\nwiring");
  const jobsRoute = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
  check(
    "job create still refuses ONLY on a non-eligible managed decision",
    /if \(!managedStock\.eligible\) \{[\s\S]{0,200}missing_key/.test(jobsRoute),
  );
  check(
    "job create no longer branches on plan/trial before that gate",
    !/conversionTrial|paidEquivalent/.test(
      jobsRoute.slice(jobsRoute.indexOf("Managed stock key"), jobsRoute.indexOf("ElevenLabs VALIDITY preflight")),
    ),
  );

  const fetchStock = readFileSync("src/app/api/videos/fetch-stock/route.ts", "utf8");
  const searchFn = fetchStock.slice(
    fetchStock.indexOf("async function managedProviderSearch"),
    fetchStock.indexOf("function applyNormalizeTelemetry"),
  );
  check("the managed search consults the monthly budget", searchFn.includes("hasManagedStockMonthlyBudget"));
  check("the managed search counts every call it makes", searchFn.includes("recordManagedStockCall"));
  check(
    "the monthly gate is checked BEFORE the hourly token is spent",
    searchFn.indexOf("hasManagedStockMonthlyBudget") < searchFn.indexOf("takeManagedStockToken"),
  );
  check(
    "a cache hit still returns before any budget is touched",
    searchFn.indexOf("cacheHits++") < searchFn.indexOf("hasManagedStockMonthlyBudget"),
  );
  check("an exhausted month reports scope=month", searchFn.includes('throttleScope = "month"'));
  check("a spent token bucket still reports scope=rate", searchFn.includes('throttleScope ??= "rate"'));
  check(
    "budget/token/month exhaustion returns [] rather than throwing",
    !/throw new Error/.test(searchFn),
  );

  const serverLib = readFileSync("src/lib/managed-stock.server.ts", "utf8");
  check(
    "the resolver no longer imports paid-equivalent entitlement",
    !serverLib.includes("resolvePaidEquivalentEntitlement"),
  );

  await prisma.$disconnect();

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nverify-managed-stock-server: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
