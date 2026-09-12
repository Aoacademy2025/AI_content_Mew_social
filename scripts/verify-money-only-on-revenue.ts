import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Task C4 (admin re-org, ADR 0062): money renders only on /admin/revenue.
// Source-level check (team pattern — see scripts/verify-admin-navigation.ts):
// no server/DB needed, so it runs the same in CI as locally.

const REPO_ROOT = path.resolve(__dirname, "..");
const insightsPath = "src/app/(dashboard)/admin/insights/page.tsx";
const adminPath = "src/app/(dashboard)/admin/page.tsx";
const revenuePath = "src/app/(dashboard)/admin/revenue/page.tsx";

const insights = readFileSync(path.join(REPO_ROOT, insightsPath), "utf8");
const admin = readFileSync(path.join(REPO_ROOT, adminPath), "utf8");
const revenue = readFileSync(path.join(REPO_ROOT, revenuePath), "utf8");

const MONEY_STRINGS = [
  "MRR (รายได้/เดือน)",
  "จ่ายจริง (จ่ายเงินสด)",
  "Comped (แจกสิทธิ์)",
  "CostMarginPanel",
  // Task C8 — "รอเก็บเงินครั้งแรก" (committed-trialing card).
  "รอเก็บเงินครั้งแรก (trial ผูกบัตรแล้ว)",
];

for (const needle of MONEY_STRINGS) {
  assert.ok(
    !insights.includes(needle),
    `${insightsPath} must not contain the money string ${JSON.stringify(needle)} — money renders only on /admin/revenue (ADR 0062)`,
  );
  assert.ok(
    !admin.includes(needle),
    `${adminPath} must not contain the money string ${JSON.stringify(needle)} — money renders only on /admin/revenue (ADR 0062)`,
  );
  assert.ok(
    revenue.includes(needle),
    `${revenuePath} must contain the money string ${JSON.stringify(needle)}`,
  );
}

console.log("verify-money-only-on-revenue: PASS — money strings live only on admin/revenue/page.tsx");
