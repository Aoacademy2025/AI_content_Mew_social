/**
 * Manual / external (off-Stripe) payment — pure input validation + normalization.
 *
 * No DB access here on purpose: this is the unit-testable core (see
 * scripts/verify-manual-payment.ts). The route (src/app/api/admin/manual-payment/route.ts)
 * calls normalizeManualPayment at the boundary, then does the DB work in one transaction.
 *
 * Money rule (project-wide): the DB stores satang (integer). The admin form takes ฿ (baht);
 * we convert ฿ → satang here with Math.round — never store a float.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_PAID_AT_MS = 1_577_836_800_000; // 2020-01-01T00:00:00Z — catches typo years (e.g. 0202)

export type ManualPaymentPlan = "PRO" | "BUSINESS";
export type ManualPaymentPeriod = "monthly" | "annual";

export type ManualPaymentInput = {
  plan: ManualPaymentPlan;
  billingPeriod: ManualPaymentPeriod;
  amountBaht: number; // ฿ from the form
  paidAtMs: number; // epoch ms (the real payment date)
  note: string;
  setPlan: boolean;
  markFounder: boolean;
};

export type NormalizedManualPayment = {
  amountSatang: number;
  periodDays: number;
  planExpiresAtMs: number;
};

/**
 * Validate + normalize an admin manual-payment input. Throws Error(reason, Thai) on invalid
 * input so the route can return the message as a 400. `nowMs` is injected for testability and
 * to bound the paid-at date (a payment dated in the far future would inflate cash-in wrongly).
 */
export function normalizeManualPayment(
  input: ManualPaymentInput,
  nowMs: number,
): NormalizedManualPayment {
  if (input.plan !== "PRO" && input.plan !== "BUSINESS") throw new Error("แผนไม่ถูกต้อง");
  if (input.billingPeriod !== "monthly" && input.billingPeriod !== "annual")
    throw new Error("รอบบิลไม่ถูกต้อง");
  if (!Number.isFinite(input.amountBaht) || input.amountBaht <= 0)
    throw new Error("จำนวนเงินต้องมากกว่า 0");
  if (!input.note?.trim()) throw new Error("ต้องใส่หมายเหตุ (เช่น โอนธนาคาร / founder)");
  // Allow up to +1 day of clock skew but reject a genuinely-future payment date.
  if (!Number.isFinite(input.paidAtMs) || input.paidAtMs > nowMs + DAY_MS)
    throw new Error("วันที่จ่ายไม่ถูกต้อง");
  // Reject a date before 2020-01-01 — catches typo years (e.g. 0202) that would otherwise
  // silently store a 1970-era date.
  if (input.paidAtMs < MIN_PAID_AT_MS) throw new Error("วันที่จ่ายไม่ถูกต้อง (เก่าเกินไป)");

  const periodDays = input.billingPeriod === "annual" ? 365 : 30;
  const amountSatang = Math.round(input.amountBaht * 100);
  const planExpiresAtMs = input.paidAtMs + periodDays * DAY_MS;
  return { amountSatang, periodDays, planExpiresAtMs };
}

/** Inverse used by the list endpoint: derive the billing period from the stored periodDays. */
export function billingPeriodFromDays(periodDays: number): ManualPaymentPeriod {
  return periodDays >= 365 ? "annual" : "monthly";
}
