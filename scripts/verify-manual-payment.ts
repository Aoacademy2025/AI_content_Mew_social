// Verify the pure manual-payment logic: normalizeManualPayment (฿→satang, period→days/expiry,
// and rejection of bad inputs) + billingPeriodFromDays.
// Run: npx tsx scripts/verify-manual-payment.ts

import {
  normalizeManualPayment,
  billingPeriodFromDays,
  type ManualPaymentInput,
} from "../src/lib/manual-payment";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 5); // fixed reference for deterministic assertions

function base(overrides: Partial<ManualPaymentInput> = {}): ManualPaymentInput {
  return {
    plan: "PRO",
    billingPeriod: "annual",
    amountBaht: 2995,
    paidAtMs: NOW,
    note: "โอนธนาคาร",
    setPlan: true,
    markFounder: false,
    ...overrides,
  };
}

function expectThrow(name: string, input: ManualPaymentInput, expectMsg?: string) {
  try {
    normalizeManualPayment(input, NOW);
    check(name, false, "expected a throw but none happened");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, expectMsg ? msg === expectMsg : true, expectMsg ? `got: ${msg}` : "");
  }
}

// ── Valid: PRO / annual ฿2995 ────────────────────────────────────────────────
{
  const r = normalizeManualPayment(base(), NOW);
  check("valid PRO/annual ฿2995 → 299500 satang", r.amountSatang === 299500, `got ${r.amountSatang}`);
  check("annual → periodDays 365", r.periodDays === 365, `got ${r.periodDays}`);
  check("annual expiry = paidAt + 365d", r.planExpiresAtMs === NOW + 365 * DAY_MS, `got ${r.planExpiresAtMs}`);
}

// ── Valid: BUSINESS / monthly ────────────────────────────────────────────────
{
  const r = normalizeManualPayment(base({ plan: "BUSINESS", billingPeriod: "monthly", amountBaht: 990 }), NOW);
  check("monthly → periodDays 30", r.periodDays === 30, `got ${r.periodDays}`);
  check("฿990 → 99000 satang", r.amountSatang === 99000, `got ${r.amountSatang}`);
  check("monthly expiry = paidAt + 30d", r.planExpiresAtMs === NOW + 30 * DAY_MS, `got ${r.planExpiresAtMs}`);
}

// ── Rounding: fractional baht → nearest satang (no floats stored) ─────────────
{
  const r = normalizeManualPayment(base({ amountBaht: 149.995 }), NOW);
  check("฿149.995 → 15000 satang (rounded)", r.amountSatang === 15000, `got ${r.amountSatang}`);
}

// ── Historical paid date is allowed; a past date shortens nothing but the expiry base ─
{
  const past = NOW - 40 * DAY_MS;
  const r = normalizeManualPayment(base({ paidAtMs: past }), NOW);
  check("historical paidAt accepted; expiry measured from it", r.planExpiresAtMs === past + 365 * DAY_MS);
}

// ── +1 day of clock skew is tolerated, genuinely-future is rejected ──────────
{
  const r = normalizeManualPayment(base({ paidAtMs: NOW + 12 * 60 * 60 * 1000 }), NOW);
  check("paidAt within +1d skew accepted", r.periodDays === 365);
}

// ── Lower bound on paidAtMs: reject dates before 2020-01-01 (typo years like 0202) ──
{
  const yearAgo = NOW - 365 * DAY_MS;
  const r = normalizeManualPayment(base({ paidAtMs: yearAgo }), NOW);
  check("paidAt a year ago still accepted", r.planExpiresAtMs === yearAgo + 365 * DAY_MS);
}
expectThrow(
  "reject paidAt before 2020-01-01",
  base({ paidAtMs: Date.UTC(2019, 11, 31) }),
  "วันที่จ่ายไม่ถูกต้อง (เก่าเกินไป)",
);
expectThrow(
  "reject paidAt typo year (0202 → epoch-era ms)",
  base({ paidAtMs: 202 }),
  "วันที่จ่ายไม่ถูกต้อง (เก่าเกินไป)",
);

// ── Rejections ───────────────────────────────────────────────────────────────
expectThrow("reject amount = 0", base({ amountBaht: 0 }), "จำนวนเงินต้องมากกว่า 0");
expectThrow("reject amount < 0", base({ amountBaht: -5 }), "จำนวนเงินต้องมากกว่า 0");
expectThrow("reject NaN amount", base({ amountBaht: Number.NaN }), "จำนวนเงินต้องมากกว่า 0");
expectThrow("reject empty note", base({ note: "   " }), "ต้องใส่หมายเหตุ (เช่น โอนธนาคาร / founder)");
expectThrow("reject bad plan", base({ plan: "FREE" as any }), "แผนไม่ถูกต้อง");
expectThrow("reject bad billingPeriod", base({ billingPeriod: "weekly" as any }), "รอบบิลไม่ถูกต้อง");
expectThrow("reject future paidAt (>+1d)", base({ paidAtMs: NOW + 3 * DAY_MS }), "วันที่จ่ายไม่ถูกต้อง");
expectThrow("reject non-finite paidAt", base({ paidAtMs: Number.NaN }), "วันที่จ่ายไม่ถูกต้อง");

// ── billingPeriodFromDays inverse ────────────────────────────────────────────
check("365 → annual", billingPeriodFromDays(365) === "annual");
check("30 → monthly", billingPeriodFromDays(30) === "monthly");
check("31 → monthly", billingPeriodFromDays(31) === "monthly");
check("400 → annual", billingPeriodFromDays(400) === "annual");

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll manual-payment checks passed ✓");
