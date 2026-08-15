export type CashCharge = {
  amount: number;
  amountRefunded: number;
  currency: string;
  paid: boolean;
  status: string;
};

export type LifetimeCashSummary = {
  total: number;
  stripeNet: number;
  manual: number;
  refunds: number;
  successfulCharges: number;
  ignoredNonThbCharges: number;
};

/**
 * Convert Stripe's immutable charge history plus audited off-Stripe receipts
 * into real lifetime cash. All arithmetic stays in satang until the return so
 * partial refunds and decimal baht never accumulate floating-point drift.
 */
export function summarizeLifetimeCash(
  charges: readonly CashCharge[],
  manualPaidSatang: number,
): LifetimeCashSummary {
  let stripeNetSatang = 0;
  let refundSatang = 0;
  let successfulCharges = 0;
  let ignoredNonThbCharges = 0;

  for (const charge of charges) {
    if (!charge.paid || charge.status !== "succeeded") continue;
    if (charge.currency.toLowerCase() !== "thb") {
      ignoredNonThbCharges += 1;
      continue;
    }
    const amount = Number.isFinite(charge.amount) ? Math.max(0, Math.round(charge.amount)) : 0;
    const refunded = Number.isFinite(charge.amountRefunded)
      ? Math.min(amount, Math.max(0, Math.round(charge.amountRefunded)))
      : 0;
    stripeNetSatang += amount - refunded;
    refundSatang += refunded;
    successfulCharges += 1;
  }

  const manualSatang = Number.isFinite(manualPaidSatang)
    ? Math.max(0, Math.round(manualPaidSatang))
    : 0;
  return {
    total: (stripeNetSatang + manualSatang) / 100,
    stripeNet: stripeNetSatang / 100,
    manual: manualSatang / 100,
    refunds: refundSatang / 100,
    successfulCharges,
    ignoredNonThbCharges,
  };
}
