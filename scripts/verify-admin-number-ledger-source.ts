// One money source per figure, and a ฿0 Payment row is never a customer paying.
//
// Audit A4 (2026-09-12), rows #37 / #38 / #97 — the "one money source" candidate:
//   - `ลูกค้าใหม่ / เดิม` (`newPayers`/`repeatPayers`) counted EVERY `Payment PAID` row with no
//     amount test. 15 of the 36 rows in the 30-day window were ฿0, so "ลูกค้าใหม่ 28" sat one
//     line under a Stripe-truth ฿31,346 and counted people who had paid nothing.
//   - The cost panel's `รายการรับเงินใน Studio` is `SUM(Payment.amount)` — the internal ledger —
//     while `รายได้รวมสะสม` two tiles away is Stripe. Two money numbers, two sources, no label
//     saying which is which. The ledger is the one that silently includes those ฿0 rows and
//     nets no refunds; the 2026-08-27 repair established that it must never be read as revenue.
//
// The ledger figure stays (it answers "what did our own records book this window"), but it is
// now labelled as the ledger, and Stripe truth is named as living on /admin/revenue.
//
// Run: node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-admin-number-ledger-source.ts
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Type-only: erased at compile time, so the module is not loaded before DATABASE_URL is set.
import type { RevenueReceiptEvent } from "../src/lib/revenue-growth";

const dir = mkdtempSync(join(tmpdir(), "admin-number-ledger-source-"));
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

const DAY_MS = 86_400_000;
// Asia/Bangkok is UTC+7 all year: these two instants are 23:59 and 00:00 of adjacent Bangkok days.
const LAST_MINUTE_OF_0910 = new Date("2026-09-10T16:59:00.000Z");
const FIRST_MINUTE_OF_0911 = new Date("2026-09-10T17:00:00.000Z");
const NOW = new Date("2026-09-12T04:00:00.000Z");
const BEFORE_WINDOW = new Date(NOW.getTime() - 45 * DAY_MS); // older than the 30-day window

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { summarizeRevenuePeriod } = await import("../src/lib/revenue-growth");

  await prisma.user.createMany({
    data: [
      // Only ever paid ฿0 — a ledger artefact, never a customer who paid.
      { id: "zero-only", name: "zero-only", email: "zero-only@example.test" },
      // Real first-time payer, on the late side of Bangkok midnight.
      { id: "cash-new", name: "cash-new", email: "cash-new@example.test" },
      // Paid before the window and again inside it — a repeat payer.
      { id: "cash-repeat", name: "cash-repeat", email: "cash-repeat@example.test" },
      // A ฿0 row came first, then real money arrived: the real payment is their first payment.
      { id: "zero-then-cash", name: "zero-then-cash", email: "zero-then-cash@example.test" },
    ],
  });
  const rows: Array<{ id: string; userId: string; amount: number; at: Date }> = [
    { id: "r-zero-a", userId: "zero-only", amount: 0, at: LAST_MINUTE_OF_0910 },
    { id: "r-zero-b", userId: "zero-only", amount: 0, at: FIRST_MINUTE_OF_0911 },
    { id: "r-new", userId: "cash-new", amount: 59_900, at: FIRST_MINUTE_OF_0911 },
    { id: "r-repeat-old", userId: "cash-repeat", amount: 59_900, at: BEFORE_WINDOW },
    { id: "r-repeat-new", userId: "cash-repeat", amount: 59_900, at: LAST_MINUTE_OF_0910 },
    { id: "r-ztc-zero", userId: "zero-then-cash", amount: 0, at: BEFORE_WINDOW },
    { id: "r-ztc-cash", userId: "zero-then-cash", amount: 29_900, at: FIRST_MINUTE_OF_0911 },
  ];
  await prisma.payment.createMany({
    data: rows.map((r) => ({
      id: r.id, userId: r.userId, stripeSessionId: `sess-${r.id}`, plan: "PRO",
      amount: r.amount, status: "PAID", periodDays: 30, createdAt: r.at, paidAt: r.at,
    })),
  });

  // Build receipts exactly the way src/lib/revenue-growth.server.ts does.
  const payments = await prisma.payment.findMany({
    where: { status: "PAID" },
    select: { amount: true, paidAt: true, createdAt: true, manual: true, note: true, user: { select: { email: true } } },
    orderBy: { createdAt: "asc" },
  });
  const receipts: RevenueReceiptEvent[] = payments.map((payment) => ({
    at: payment.paidAt ?? payment.createdAt,
    amountBaht: payment.amount / 100,
    source: payment.note === "credits" ? "credit" : "studio",
    customerKey: payment.user.email.trim().toLowerCase(),
  }));

  const summary = summarizeRevenuePeriod({ now: NOW, days: 30, cashEvents: [], receipts });

  check(
    summary.newPayers === 2,
    "A1: ลูกค้าใหม่ counts only people who actually paid money in the window",
    `newPayers=${summary.newPayers} (expected 2: cash-new, zero-then-cash)`,
  );
  check(
    summary.repeatPayers === 1,
    "A2: ลูกค้าเดิม likewise",
    `repeatPayers=${summary.repeatPayers} (expected 1: cash-repeat)`,
  );
  check(
    summary.newPayers + summary.repeatPayers === 3,
    "A3: the ฿0-only account appears in neither counter",
    `total=${summary.newPayers + summary.repeatPayers} of 4 accounts with PAID rows`,
  );
  check(
    summary.mix.studio === 599 + 599 + 299,
    "A4: the cash mix is unchanged — ฿0 rows never contributed money to begin with",
    `studio=${summary.mix.studio}`,
  );
  check(
    summary.trend.length === 30 && summary.trend.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date)),
    "A5: the daily trend is still 30 Bangkok-dated buckets",
  );

  // A ฿0 row must not steal "first ever payment" from the real one that follows it: the person
  // pays for the first time inside the window, so they are new, not repeat.
  check(
    summary.repeatPayers !== 2,
    "A6: an earlier ฿0 row does not demote a first real payment to a repeat purchase",
  );

  // ── The panel names its source ──────────────────────────────────────────────
  const panel = readFileSync("src/components/admin/cost-margin-panel.tsx", "utf8");
  check(
    /บัญชีภายใน \(ledger\)/.test(panel),
    "B1: the windowed Studio cash figure is labelled as the internal ledger",
  );
  check(
    /\/admin\/revenue/.test(panel),
    "B2: …and the panel names /admin/revenue as where Stripe cash truth lives",
  );
  check(
    /รายได้รวมสะสม[\s\S]*cash\.allTimeTotal/.test(panel),
    "B3: the Stripe all-time figure is still present and distinct from the ledger one",
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
