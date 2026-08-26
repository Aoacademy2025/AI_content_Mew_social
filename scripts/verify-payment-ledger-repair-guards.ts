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

// Guard PLACEMENT, not the mere presence of the word `apply`. Proven by injecting an
// unconditional `prisma.payment.update` followed by `if (apply) console.log(...)`: the old
// check reported ALL PASS, this one fails A3.1 with "no `if (apply)` before it". The first version of this check
// looked for `apply` anywhere after the update call, so it passed on code that wrote
// unconditionally and merely mentioned `apply` on the next line — it would have green-lit a
// dry run that voided production rows. Each write must be preceded by an `if (apply)` with no
// other statement in between.
const writeSites = [...body.matchAll(/prisma\.payment\.update\(/g)].map((m) => m.index ?? 0);
check("A2: the tool performs at least one write (otherwise this file proves nothing)", writeSites.length > 0);
for (const [index, at] of writeSites.entries()) {
  const before = body.slice(0, at);
  const lastGuard = before.lastIndexOf("if (apply)");
  const between = lastGuard >= 0 ? before.slice(lastGuard + "if (apply)".length) : "";
  const guarded = lastGuard >= 0 && !/;/.test(between);
  check(
    `A3.${index + 1}: payment.update #${index + 1} is directly guarded by \`if (apply)\``,
    guarded,
    // Only explain a failure — a passing check should stay quiet.
    guarded ? "" : lastGuard < 0 ? "no `if (apply)` before it" : `statements in between: ${between.trim().slice(0, 60)}`,
  );
}

// ── Argument parsing must never fall through to the writing default ──
check("A4: unrecognised arguments stop the run", body.includes("unrecognised argument"));
check(
  "A5: --flag-manual without a session id stops the run",
  /flagManualIndex >= 0 && \(!flagManualSession/.test(body),
);
check(
  "A6: a value that looks like a flag is not accepted as a session id",
  body.includes('flagManualSession.startsWith("--")'),
);
check("A7: two modes at once are refused rather than silently half-run", body.includes("run them one at a time"));

// ── Voiding is scoped to test-mode ids only ──
check("B1: void targets only cs_test_ sessions", body.includes('startsWith: "cs_test_"'));
check("B2: void never matches a live session id", !body.includes('startsWith: "cs_live'));
check("B3: void soft-voids, never deletes", body.includes('status: "VOIDED"') && !body.includes("payment.delete"));

// ── Off-Stripe cash is flagged one row at a time, never inferred ──
check("C1: manual flagging takes an explicit session id", body.includes("--flag-manual"));
check(
  "C1b: a Stripe-backed row is refused — flagging it would double-count the payment",
  body.includes('row.stripeSessionId.startsWith("cs_")') && body.includes("row.stripePaymentIntent"),
);
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
