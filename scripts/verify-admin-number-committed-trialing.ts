// Task C8 — "รอเก็บเงินครั้งแรก": customers who CONVERTED (live Stripe subscription, card on
// file) but whose subscription is still `trialing`, so Stripe has not charged them yet.
// `src/lib/preserve-trial.ts` (#348) is what puts a User into this state: converting mid-trial
// keeps the trial's remaining days by handing Stripe `subscription_data.trial_end`, and the
// webhook stores `subStatus="trialing"` + a ฿0 `trial_preserved` Payment row — "committed, not
// yet charged". On prod 11 such accounts have a real subscription + customer but only that ฿0
// row, so `summarizePlanCash`'s `amount > 0` rule (fix 1, 2026-09-12) correctly excludes them
// from จ่ายจริง — and Mew wants a separate card that shows them, never folded into any existing
// money figure.
//
// Definition (task-C8-brief.md): subStatus="trialing" AND stripeSubscriptionId IS NOT NULL AND
// plan IN (PRO, BUSINESS) AND not suspended/internal-team AND no PAID Payment row above ฿0
// (that would already make them จ่ายจริง). Expected monthly is priced from the CURRENT
// plan-config list price (nothing has been paid yet, so there is no actual amount to read) —
// monthly = list price, annual = list price × ANNUAL_PRICE_MONTHS / 12, the same convention
// documented at the top of revenue-cohorts.ts. First-charge dates are the Asia/Bangkok calendar
// date of `planExpiresAt`, the column `checkout-plan-activation.ts` writes with Stripe's
// `current_period_end` — for a trialing subscription that IS the trial end.
//
// This script drives the real DB wrapper (`getRevenueCohorts`) against a throwaway SQLite, and
// asserts every pre-existing field (`payingTotal`, `mrr`, `compedPaid`, `free`, `lapsedPayers`,
// `trialActive`, `breakEvenSubs`) is exactly what the pre-C8 definitions already produced —
// this feature is purely additive.
//
// Run: node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-admin-number-committed-trialing.ts
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";

const dir = mkdtempSync(join(tmpdir(), "admin-number-committed-trialing-"));
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

const NOW = new Date("2026-09-12T04:00:00.000Z");
const FUTURE_EARLY = new Date("2026-09-15T10:00:00.000Z"); // Bangkok 2026-09-15 17:00
const FUTURE_LATE = new Date("2026-09-18T10:00:00.000Z"); // Bangkok 2026-09-18 17:00
const FUTURE_MID = new Date("2026-09-20T00:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { getRevenueCohorts } = await import("../src/lib/revenue-cohorts");

  type UserSeed = {
    id: string;
    plan: "FREE" | "PRO" | "BUSINESS";
    subStatus: string | null;
    stripeSubscriptionId: string | null;
    planExpiresAt: Date | null;
    billingPeriod: string | null;
    suspended: boolean;
  };
  const users: UserSeed[] = [
    // Counted — committed, converted, no cash yet, monthly.
    { id: "committed-pro-monthly", plan: "PRO", subStatus: "trialing", stripeSubscriptionId: "sub_c1", planExpiresAt: FUTURE_EARLY, billingPeriod: "monthly", suspended: false },
    // Counted — committed, converted, no cash yet, annual (expected = list price × 10 / 12).
    { id: "committed-business-annual", plan: "BUSINESS", subStatus: "trialing", stripeSubscriptionId: "sub_c2", planExpiresAt: FUTURE_LATE, billingPeriod: "annual", suspended: false },
    // NOT counted — trialing + subscription, but a real ฿599 payment already landed: already จ่ายจริง.
    { id: "trial-cash", plan: "PRO", subStatus: "trialing", stripeSubscriptionId: "sub_c3", planExpiresAt: FUTURE_MID, billingPeriod: "monthly", suspended: false },
    // NOT counted — trialing but no live Stripe subscription (never converted).
    { id: "trial-no-subscription", plan: "PRO", subStatus: "trialing", stripeSubscriptionId: null, planExpiresAt: FUTURE_MID, billingPeriod: "monthly", suspended: false },
    // NOT counted — canceled/FREE with only a ฿0 row (plan not PRO/BUSINESS).
    { id: "canceled-free-zero", plan: "FREE", subStatus: "canceled", stripeSubscriptionId: null, planExpiresAt: PAST, billingPeriod: null, suspended: false },
    // NOT counted — otherwise identical to the counted fixture, but suspended.
    { id: "suspended-trial", plan: "PRO", subStatus: "trialing", stripeSubscriptionId: "sub_c6", planExpiresAt: FUTURE_MID, billingPeriod: "monthly", suspended: true },
  ];
  await prisma.user.createMany({
    data: users.map((u) => ({
      id: u.id,
      name: u.id,
      email: `${u.id}@example.test`,
      plan: u.plan,
      subStatus: u.subStatus,
      stripeSubscriptionId: u.stripeSubscriptionId,
      planExpiresAt: u.planExpiresAt,
      billingPeriod: u.billingPeriod,
      suspended: u.suspended,
    })),
  });

  type PaySeed = { userId: string; amount: number };
  const payments: PaySeed[] = [
    { userId: "committed-pro-monthly", amount: 0 },
    { userId: "committed-business-annual", amount: 0 },
    { userId: "trial-cash", amount: 59_900 },
    { userId: "canceled-free-zero", amount: 0 },
  ];
  await prisma.payment.createMany({
    data: payments.map((p, index) => ({
      id: `pay-${index}`,
      userId: p.userId,
      stripeSessionId: `sess-${index}`,
      plan: "PRO",
      amount: p.amount,
      status: "PAID",
      periodDays: 30,
      createdAt: NOW,
      paidAt: NOW,
      note: p.amount === 0 ? "trial_preserved" : null,
    })),
  });

  const cohorts = await getRevenueCohorts(NOW);

  // ── The new bucket ────────────────────────────────────────────────────────
  check(
    cohorts.committedTrialing.users === 2,
    "committed-trialing counts only trialing + live subscription + PRO/BUSINESS, no cash, not suspended",
    `users=${cohorts.committedTrialing.users} (expected 2: committed-pro-monthly, committed-business-annual)`,
  );
  check(
    near(cohorts.committedTrialing.expectedMonthlyThb, 599 + (990 * 10) / 12),
    "expected monthly is list-priced, annual at list × ANNUAL_PRICE_MONTHS / 12",
    `expectedMonthlyThb=${cohorts.committedTrialing.expectedMonthlyThb.toFixed(2)} (expected ${(599 + (990 * 10) / 12).toFixed(2)})`,
  );
  check(
    cohorts.committedTrialing.firstChargeDates.earliest === "2026-09-15",
    "earliest first-charge date is the Bangkok calendar date of the earliest planExpiresAt",
    `earliest=${cohorts.committedTrialing.firstChargeDates.earliest}`,
  );
  check(
    cohorts.committedTrialing.firstChargeDates.latest === "2026-09-18",
    "latest first-charge date is the Bangkok calendar date of the latest planExpiresAt",
    `latest=${cohorts.committedTrialing.firstChargeDates.latest}`,
  );

  // ── Every existing field must be exactly what the pre-C8 definitions produce ──
  check(cohorts.payingTotal === 1, "payingTotal unchanged: only the real ฿599 payer counts", `payingTotal=${cohorts.payingTotal}`);
  check(cohorts.directPayingTotal === 1, "directPayingTotal unchanged", `directPayingTotal=${cohorts.directPayingTotal}`);
  check(near(cohorts.mrr, 599), "mrr unchanged: still priced from real cash only", `mrr=${cohorts.mrr.toFixed(2)}`);
  check(near(cohorts.directMrr, 599), "directMrr unchanged", `directMrr=${cohorts.directMrr.toFixed(2)}`);
  check(
    cohorts.compedPaid === 4,
    "compedPaid unchanged: committed-trialing accounts still land here (existing behaviour, not altered by C8)",
    `compedPaid=${cohorts.compedPaid} (expected 4: both committed accounts + no-subscription + suspended)`,
  );
  check(cohorts.free === 1, "free unchanged: the FREE/canceled ฿0 account", `free=${cohorts.free}`);
  check(cohorts.lapsedPayers === 0, "lapsedPayers unchanged", `lapsedPayers=${cohorts.lapsedPayers}`);
  check(cohorts.trialActive === 0, "trialActive unchanged (all fixtures are TIMED_PLAN or FREE, none unconverted TRIAL)", `trialActive=${cohorts.trialActive}`);
  check(cohorts.breakEvenSubs === cohorts.payingTotal, "breakEvenSubs still follows payingTotal", `breakEvenSubs=${cohorts.breakEvenSubs}`);

  await prisma.$disconnect();

  // ── Source-level: the exact title lives only on /admin/revenue ────────────
  const REPO_ROOT = path.resolve(__dirname, "..");
  const TITLE = "รอเก็บเงินครั้งแรก (trial ผูกบัตรแล้ว)";
  const revenuePage = readFileSync(path.join(REPO_ROOT, "src/app/(dashboard)/admin/revenue/page.tsx"), "utf8");
  const adminPage = readFileSync(path.join(REPO_ROOT, "src/app/(dashboard)/admin/page.tsx"), "utf8");
  const insightsPage = readFileSync(path.join(REPO_ROOT, "src/app/(dashboard)/admin/insights/page.tsx"), "utf8");
  check(revenuePage.includes(TITLE), "admin/revenue/page.tsx contains the exact card title");
  check(!adminPage.includes(TITLE), "admin/page.tsx does NOT contain the card title (ADR 0062: money only on /admin/revenue)");
  check(!insightsPage.includes(TITLE), "admin/insights/page.tsx does NOT contain the card title (ADR 0062)");
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
