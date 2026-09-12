// จ่ายจริง means CASH: a PAID plan Payment for MORE than ฿0.
//
// Audit A4 (2026-09-12), rows #10 / #41 / #58 / #94: /admin, /admin/revenue's base block and
// /admin/insights all rendered จ่ายจริง = 39 while the Subscription North Star on the SAME
// /admin/revenue page rendered 28. The gap was exactly 11 accounts whose only plan `Payment`
// rows are ฿0. `revenue-cohorts.ts` accepted ANY non-credit PAID row as cash evidence;
// `subscription-north-star.server.ts:116-121` requires `amount > 0`. 28 is the right number,
// and CONTEXT.md's "Paid Conversion" is defined as a *successful payment*, not a ฿0 ledger row.
//
// This script drives the real DB wrapper (`getRevenueCohorts`) against a throwaway SQLite so the
// whole path Payment rows → paidUserIds → payingTotal is proven, not just the pure helper.
// Fixtures straddle Bangkok midnight (16:59Z / 17:00Z) and every cohort boundary that reads the
// cash flag: paying, comped, lapsed.
//
// Run: node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-admin-number-paying-cash-only.ts
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "admin-number-paying-cash-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`ok: ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

// Asia/Bangkok is UTC+7 all year, so 16:59Z and 17:00Z on the same UTC day are the last minute
// of one Bangkok day and the first minute of the next. Cash evidence must not depend on which
// side of that line a payment landed.
const BEFORE_BKK_MIDNIGHT = new Date("2026-09-10T16:59:00.000Z"); // 2026-09-10 23:59 Bangkok
const AFTER_BKK_MIDNIGHT = new Date("2026-09-10T17:00:00.000Z"); // 2026-09-11 00:00 Bangkok
const NOW = new Date("2026-09-12T04:00:00.000Z");
const FUTURE = new Date("2026-12-31T00:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { getRevenueCohorts } = await import("../src/lib/revenue-cohorts");

  type UserSeed = {
    id: string;
    plan: "FREE" | "PRO" | "BUSINESS";
    planExpiresAt: Date | null;
    billingPeriod: string | null;
  };
  const users: UserSeed[] = [
    // Entitled PRO whose ONLY plan payment is ฿0 — one on each side of Bangkok midnight.
    { id: "zero-before-midnight", plan: "PRO", planExpiresAt: FUTURE, billingPeriod: "monthly" },
    { id: "zero-after-midnight", plan: "PRO", planExpiresAt: FUTURE, billingPeriod: "monthly" },
    // Real ฿599 payers, likewise straddling Bangkok midnight.
    { id: "cash-before-midnight", plan: "PRO", planExpiresAt: FUTURE, billingPeriod: "monthly" },
    { id: "cash-after-midnight", plan: "PRO", planExpiresAt: FUTURE, billingPeriod: "monthly" },
    // A ฿0 ledger row followed by real cash: still a paying customer.
    { id: "zero-then-cash", plan: "PRO", planExpiresAt: FUTURE, billingPeriod: "monthly" },
    // Credit pack only — never plan cash (pre-existing rule, kept as a regression guard).
    { id: "credit-only", plan: "PRO", planExpiresAt: FUTURE, billingPeriod: null },
    // Cohort boundary: access already lapsed. Only the one who actually paid is a churned payer.
    { id: "zero-lapsed", plan: "FREE", planExpiresAt: PAST, billingPeriod: "monthly" },
    { id: "cash-lapsed", plan: "FREE", planExpiresAt: PAST, billingPeriod: "monthly" },
  ];
  await prisma.user.createMany({
    data: users.map((u) => ({
      id: u.id,
      name: u.id,
      email: `${u.id}@example.test`,
      plan: u.plan,
      planExpiresAt: u.planExpiresAt,
      billingPeriod: u.billingPeriod,
    })),
  });

  type PaySeed = { userId: string; amount: number; at: Date; note?: string | null; periodDays?: number };
  const payments: PaySeed[] = [
    { userId: "zero-before-midnight", amount: 0, at: BEFORE_BKK_MIDNIGHT },
    { userId: "zero-after-midnight", amount: 0, at: AFTER_BKK_MIDNIGHT },
    { userId: "cash-before-midnight", amount: 59_900, at: BEFORE_BKK_MIDNIGHT },
    { userId: "cash-after-midnight", amount: 59_900, at: AFTER_BKK_MIDNIGHT },
    { userId: "zero-then-cash", amount: 0, at: BEFORE_BKK_MIDNIGHT },
    { userId: "zero-then-cash", amount: 59_900, at: AFTER_BKK_MIDNIGHT },
    { userId: "credit-only", amount: 19_900, at: BEFORE_BKK_MIDNIGHT, note: "credits", periodDays: 0 },
    { userId: "zero-lapsed", amount: 0, at: PAST },
    { userId: "cash-lapsed", amount: 59_900, at: PAST },
  ];
  await prisma.payment.createMany({
    data: payments.map((p, index) => ({
      id: `pay-${index}`,
      userId: p.userId,
      stripeSessionId: `sess-${index}`,
      plan: "PRO",
      amount: p.amount,
      status: "PAID",
      periodDays: p.periodDays ?? 30,
      createdAt: p.at,
      paidAt: p.at,
      note: p.note ?? null,
    })),
  });

  const cohorts = await getRevenueCohorts(NOW);

  check(
    cohorts.payingTotal === 3,
    "จ่ายจริง counts only accounts with a plan payment above ฿0",
    `payingTotal=${cohorts.payingTotal} (expected 3: cash-before, cash-after, zero-then-cash)`,
  );
  check(
    cohorts.directPayingTotal === 3,
    "the Studio-only payer count agrees",
    `directPayingTotal=${cohorts.directPayingTotal}`,
  );
  check(
    cohorts.compedPaid === 3,
    "a ฿0-only PRO account is comped access, not revenue",
    `compedPaid=${cohorts.compedPaid} (expected 3: two ฿0 accounts + the credit-only buyer)`,
  );
  check(
    cohorts.lapsedPayers === 1,
    "only a real payer who lost access is a churned payer",
    `lapsedPayers=${cohorts.lapsedPayers} (expected 1: cash-lapsed)`,
  );
  check(
    near(cohorts.mrr, 3 * 599),
    "the ฿0 accounts carry no monthly revenue with them",
    `mrr=${cohorts.mrr.toFixed(2)} (expected ${(3 * 599).toFixed(2)})`,
  );
  check(
    cohorts.breakEvenSubs === cohorts.payingTotal,
    "the break-even numerator follows the same cash rule",
    `breakEvenSubs=${cohorts.breakEvenSubs}`,
  );
  check(
    cohorts.payingTotal !== 5,
    "regression guard: the pre-fix behaviour counted both ฿0 accounts as paying",
  );

  await prisma.$disconnect();
}

main()
  .catch((error) => {
    failed += 1;
    console.error(error);
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} ok, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
