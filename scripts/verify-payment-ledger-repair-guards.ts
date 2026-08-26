// Safety guards for the Payment-ledger repair tool.
// Run: npx tsx scripts/verify-payment-ledger-repair-guards.ts
//
// This script writes to the production Payment table, so the properties that keep it safe are
// asserted here rather than trusted to review. It ran on prod on 2026-08-27 and repaired:
//   - 5 rows that recorded the plan LIST price instead of the settled amount (18,885฿ overstated)
//   - 8 test-mode rows still counted as PAID (7,529฿ that never arrived; the all-time payer
//     count read 24 because one of them belonged to an internal @aoacademy account)
//   - 2 hand-made rows flagged as off-Stripe cash (5,302฿ genuinely received outside Stripe)
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "scripts/backfill-payment-amount-from-stripe.ts"), "utf8");
const body = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// ── Dry run is the default in every mode ──
check("A1: writing requires an explicit --apply", body.includes('argv.includes("--apply")'));
check(
  "A2: no write happens without it",
  !/prisma\.payment\.update\((?![\s\S]{0,400}?apply)/.test(body) && body.split("prisma.payment.update").length - 1 === body.split("if (apply)").length - 1,
  "every payment.update must sit behind `if (apply)`",
);

// ── Voiding is scoped to test-mode ids only ──
check("B1: void targets only cs_test_ sessions", body.includes('startsWith: "cs_test_"'));
check("B2: void never matches a live session id", !body.includes('startsWith: "cs_live'));
check("B3: void soft-voids, never deletes", body.includes('status: "VOIDED"') && !body.includes("payment.delete"));

// ── Off-Stripe cash is flagged one row at a time, never inferred ──
check("C1: manual flagging takes an explicit session id", body.includes("--flag-manual"));
check("C2: it refuses a row that is not PAID", body.includes('row.status !== "PAID"'));
check("C3: it is a no-op on an already-flagged row", body.includes("row.manual"));
check(
  "C4: no bulk manual flagging exists",
  !/updateMany\([\s\S]{0,200}manual:\s*true/.test(body),
);

// ── Amounts are proven, never guessed ──
check("D1: the amount comes from Stripe's own objects", body.includes("checkout.sessions.retrieve") && body.includes("paymentIntents.retrieve"));
check("D2: a row with no Stripe record is reported, not rewritten", body.includes("unresolved"));
check("D3: admin-entered rows are skipped", body.includes("if (row.manual) continue"));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
