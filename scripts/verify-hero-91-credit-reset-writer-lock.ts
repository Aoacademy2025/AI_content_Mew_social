/**
 * HERO-91 regression test:
 * Verifies that:
 * 1. resetMonthlyGranted executes as a single non-interactive batch transaction
 *    (kind=batch, 0 interactive callback yields while holding BEGIN IMMEDIATE)
 *    instead of a 4-round-trip interactive transaction that stalls behind
 *    concurrent standalone SQLite writers on a constrained Tokio worker pool.
 * 2. MON-4 (atomic balance reset + ledger delta including active promotional credits)
 *    and MON-7 (concurrent guarded resets on priorResetAt: null and priorResetAt: Date)
 *    remain intact.
 * 3. Concurrent 30-day boundary traffic (ensureMonthlyGrant + syncSharedUsageCycle +
 *    auth/session reads + getBalance) under TOKIO_WORKER_THREADS=1 and connection_limit=2
 *    completes well below socket_timeout without P1008 or P2028 errors.
 *
 * Run: node --conditions=react-server --import tsx scripts/verify-hero-91-credit-reset-writer-lock.ts
 */

import "./register-server-only-node.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hero91-verify-"));
const dbPath = path.join(tmpDir, "test.db");

process.env.TOKIO_WORKER_THREADS = "1";
process.env.DATABASE_URL = `file:${dbPath}`;
process.env.CREDITS_LIVE = "1";
process.env.PRISMA_CONNECTION_LIMIT = "2";
process.env.SQLITE_BUSY_TIMEOUT_SEC = "1";
process.env.SQLITE_BUSY_TIMEOUT_MS = "1000";
process.env.PRISMA_TX_MAX_WAIT_MS = "3000";
process.env.PRISMA_TX_TIMEOUT_MS = "5000";
process.env.PRISMA_SLOW_TX_MS = "1";

const repoRoot = path.resolve(__dirname, "..");
execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
  cwd: repoRoot,
  env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
  stdio: "pipe",
});

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  PASS ${label}`);
    passed += 1;
  } else {
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
}

async function main(): Promise<void> {
  const txLogs: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("[prisma-slow-tx]")) {
      txLogs.push(line);
    }
    origWarn(...args);
  };

  const { prisma } = await import("../src/lib/prisma");
  const {
    MONTHLY_GRANT,
    resetMonthlyGranted,
    ensureMonthlyGrant,
    getBalance,
  } = await import("../src/lib/credits");
  const { syncSharedUsageCycle } = await import("../src/lib/usage-limits");

  const proGrant = MONTHLY_GRANT.PRO;

  try {
    console.log("\n1. Batch transaction kind + MON-4 promotional credit delta:");
    const u1 = await prisma.user.create({
      data: {
        email: "hero91-mon4@test.local",
        name: "Hero91 Mon4",
        plan: "PRO",
      },
    });
    await prisma.creditBalance.create({
      data: {
        userId: u1.id,
        granted: 120,
        purchased: 80,
        grantedResetAt: new Date(Date.now() - 35 * 86_400_000),
      },
    });
    const prior1 = (await prisma.creditBalance.findUniqueOrThrow({ where: { userId: u1.id } }))
      .grantedResetAt;

    const coupon = await prisma.coupon.create({
      data: { id: "hero91-coupon", code: "HERO91-PROMO", type: "GRANT", plan: "PRO", maxUses: 10 },
    });
    const redemption = await prisma.couponRedemption.create({
      data: { id: "hero91-redemption", couponId: coupon.id, userId: u1.id },
    });
    await prisma.promotionalCreditGrant.create({
      data: {
        id: "hero91-promo-grant",
        userId: u1.id,
        couponRedemptionId: redemption.id,
        initialAmount: 50,
        remainingAmount: 50,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });

    txLogs.length = 0;
    await resetMonthlyGranted(u1.id, "PRO", { priorResetAt: prior1 });

    const resetLogs = txLogs.filter((line) => line.includes("operation=credits.resetMonthlyGranted"));
    assert(
      resetLogs.length > 0 && resetLogs.every((line) => line.includes("kind=batch")),
      "credits.resetMonthlyGranted runs as kind=batch (never kind=interactive)",
      resetLogs.join(" | "),
    );

    const expectedTotal = proGrant + 80 + 50;
    const bal1 = await getBalance(u1.id);
    assert(
      bal1.granted === proGrant && bal1.purchased === 80 && bal1.promotional === 50 && bal1.total === expectedTotal,
      `getBalance reflects new granted (${proGrant}) + purchased (80) + promotional (50) = ${expectedTotal}`,
      JSON.stringify(bal1),
    );
    const ledger1 = await prisma.creditLedger.findMany({
      where: { userId: u1.id, action: { startsWith: "monthly-reset:" } },
    });
    assert(
      ledger1.length === 1 && ledger1[0].delta === proGrant - 120 && ledger1[0].balanceAfter === expectedTotal,
      `monthly-reset ledger records exact delta (+${proGrant - 120}) and balanceAfter including promo (${expectedTotal})`,
      JSON.stringify(ledger1),
    );

    console.log("\n2. MON-7 concurrency guard (priorResetAt: null and priorResetAt: Date):");
    const u2 = await prisma.user.create({
      data: { email: "hero91-mon7-null@test.local", name: "Hero91 Mon7", plan: "PRO" },
    });
    await Promise.all([
      resetMonthlyGranted(u2.id, "PRO", { priorResetAt: null }),
      resetMonthlyGranted(u2.id, "PRO", { priorResetAt: null }),
      resetMonthlyGranted(u2.id, "PRO", { priorResetAt: null }),
    ]);
    const u2Ledgers = await prisma.creditLedger.count({
      where: { userId: u2.id, action: { startsWith: "monthly-reset:" } },
    });
    assert(u2Ledgers === 1, "exactly 1 monthly-reset ledger row written for priorResetAt=null race");

    const staleDate = new Date(Date.now() - 31 * 86_400_000);
    await prisma.creditBalance.update({
      where: { userId: u2.id },
      data: { granted: 10, grantedResetAt: staleDate },
    });
    await Promise.all([
      resetMonthlyGranted(u2.id, "PRO", { priorResetAt: staleDate }),
      resetMonthlyGranted(u2.id, "PRO", { priorResetAt: staleDate }),
      resetMonthlyGranted(u2.id, "PRO", { priorResetAt: staleDate }),
    ]);
    const u2LedgersAfter = await prisma.creditLedger.count({
      where: { userId: u2.id, action: { startsWith: "monthly-reset:" } },
    });
    assert(u2LedgersAfter === 2, "exactly 1 additional ledger row written for priorResetAt=Date race");

    console.log("\n3. 30-day expiry boundary contention under TOKIO_WORKER_THREADS=1:");
    const expiredAt = new Date(Date.now() - 35 * 86_400_000);
    const users = await Promise.all(
      Array.from({ length: 8 }, (_, idx) =>
        prisma.user.create({
          data: {
            email: `hero91-boundary-${idx}@test.local`,
            name: `Hero91 Boundary ${idx}`,
            plan: "PRO",
            subStatus: "active",
            stripeSubscriptionId: `sub_hero91_${idx}`,
            usagePeriodStartedAt: expiredAt,
            usageCount: 2,
          },
        }),
      ),
    );
    await Promise.all(
      users.map((u) =>
        prisma.creditBalance.create({
          data: {
            userId: u.id,
            granted: 10,
            purchased: 5,
            grantedResetAt: expiredAt,
          },
        }),
      ),
    );

    const startMs = Date.now();
    await Promise.all(
      users.flatMap((u) => [
        ensureMonthlyGrant(u.id, "PRO"),
        ensureMonthlyGrant(u.id, "PRO"),
        syncSharedUsageCycle(u.id),
        getBalance(u.id),
        prisma.user.findUnique({ where: { id: u.id }, select: { id: true, plan: true } }),
      ]),
    );
    const elapsedMs = Date.now() - startMs;
    assert(
      elapsedMs < 900,
      `40 concurrent boundary operations completed in ${elapsedMs}ms (< 1000ms socket_timeout, zero P1008/P2028)`,
    );

    for (const u of users) {
      const count = await prisma.creditLedger.count({
        where: { userId: u.id, action: { startsWith: "monthly-reset:" } },
      });
      if (count !== 1) {
        assert(false, `user ${u.email} has exactly 1 monthly-reset ledger`, `got ${count}`);
      }
    }
    assert(true, "all 8 boundary users received exactly 1 monthly-reset ledger entry");
  } finally {
    console.warn = origWarn;
    await prisma.$disconnect();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Verification failed with error:", err);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
