import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const count = Number.parseInt(process.env.COUPON_CONCURRENCY_COUNT ?? "50", 10);
assert.ok(Number.isInteger(count) && count > 0 && count <= 500, "count must be between 1 and 500");

const dir = mkdtempSync(join(tmpdir(), "grant-coupon-concurrency-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.CREDITS_LIVE = "1";
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { redeemGrantCoupon } = await import("../src/lib/grant-coupon-redemption");
  const now = new Date("2026-08-19T09:00:00.000Z");

  await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
  await prisma.coupon.create({
    data: {
      id: "coupon-audit500",
      code: "AUDIT500",
      type: "GRANT",
      plan: "PRO",
      durationDays: 30,
      maxUses: count,
      promoCredits: 50,
      promoCreditTtlDays: 30,
      expiresAt: new Date("2026-08-21T16:59:59.000Z"),
    },
  });
  await prisma.user.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      id: `coupon-concurrency-user-${index}`,
      name: `Coupon Concurrency User ${index}`,
      email: `coupon-concurrency-${index}@example.com`,
      plan: "FREE" as const,
    })),
  });

  const startedAt = Date.now();
  const settled = await Promise.allSettled(
    Array.from({ length: count }, (_, index) => redeemGrantCoupon({
      userId: `coupon-concurrency-user-${index}`,
      code: "AUDIT500",
      now,
    })),
  );
  const elapsedMs = Date.now() - startedAt;
  const resultCounts = new Map<string, number>();
  for (const entry of settled) {
    const key = entry.status === "rejected"
      ? `REJECTED:${(entry.reason as { code?: string })?.code ?? "UNKNOWN"}`
      : entry.value.ok
        ? `OK:${entry.value.outcome}`
        : `FAIL:${entry.value.code}`;
    resultCounts.set(key, (resultCounts.get(key) ?? 0) + 1);
  }

  const [coupon, redemptions, balances, proUsers, ledgers, promoGrants] = await Promise.all([
    prisma.coupon.findUniqueOrThrow({ where: { code: "AUDIT500" } }),
    prisma.couponRedemption.count({ where: { couponId: "coupon-audit500" } }),
    prisma.creditBalance.count(),
    prisma.user.count({ where: { plan: "PRO" } }),
    prisma.creditLedger.count({ where: { kind: "monthly-reset" } }),
    prisma.promotionalCreditGrant.count(),
  ]);

  console.log(JSON.stringify({
    count,
    elapsedMs,
    results: Object.fromEntries(resultCounts),
    persisted: {
      usedCount: coupon.usedCount,
      redemptions,
      balances,
      proUsers,
      ledgers,
      promoGrants,
    },
  }, null, 2));

  assert.equal(settled.filter((entry) => entry.status === "rejected").length, 0, "no request rejects");
  assert.equal(
    settled.filter((entry) => entry.status === "fulfilled" && entry.value.ok).length,
    count,
    "every request activates PRO",
  );
  assert.equal(coupon.usedCount, count, "every successful redemption consumes exactly one seat");
  assert.equal(redemptions, count, "every seat has durable redemption evidence");
  assert.equal(balances, count, "every activation has a credit balance");
  assert.equal(proUsers, count, "every user is materialized as PRO");
  assert.equal(ledgers, count, "every activation has one monthly credit ledger entry");
  assert.equal(promoGrants, 0, "fresh activation does not double-grant campaign credits");

  await prisma.$disconnect();
  console.log("✅ grant coupon concurrency passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
