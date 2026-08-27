export const REVENUE_RANGE_DAYS = [7, 30, 90] as const;
export type RevenueRangeDays = (typeof REVENUE_RANGE_DAYS)[number];

const DAY_MS = 86_400_000;

export type RevenueCashEvent = {
  at: Date;
  amountBaht: number;
  refundedBaht: number;
  source: "stripe" | "manual";
};

export type RevenueReceiptEvent = {
  at: Date;
  amountBaht: number;
  source: "studio" | "bundle" | "credit" | "manual";
  customerKey: string;
};

export type RevenueMix = {
  studio: number;
  bundle: number;
  credit: number;
  manual: number;
  other: number;
  refunds: number;
  reconciliation: number;
};

export type RevenuePeriodSummary = {
  currentGross: number;
  previousGross: number;
  changePct: number | null;
  stripeGross: number;
  stripeNet: number;
  manual: number;
  refunds: number;
  transactions: number;
  newPayers: number;
  repeatPayers: number;
  mix: RevenueMix;
  trend: Array<{ date: string; label: string; current: number; previous: number }>;
};

function finiteMoney(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function inWindow(at: Date, from: Date, until: Date): boolean {
  const time = at.getTime();
  return time >= from.getTime() && time < until.getTime();
}

function sumCash(events: readonly RevenueCashEvent[], from: Date, until: Date) {
  let stripeGross = 0;
  let refunds = 0;
  let manual = 0;
  let transactions = 0;
  for (const event of events) {
    if (!inWindow(event.at, from, until)) continue;
    const amount = finiteMoney(event.amountBaht);
    // Refunds are dated when money leaves, not moved back to the original
    // charge date. A refund-only event therefore has amount=0 and refund>0.
    const refunded = finiteMoney(event.refundedBaht);
    if (event.source === "manual") manual += amount;
    else {
      stripeGross += amount;
      refunds += refunded;
    }
    if (amount > 0) transactions += 1;
  }
  return {
    stripeGross,
    stripeNet: stripeGross - refunds,
    manual,
    refunds,
    total: stripeGross - refunds + manual,
    transactions,
  };
}

function bangkokDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function shortBangkokDate(date: Date): string {
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
  }).format(date);
}

function bucketIndex(at: Date, from: Date, days: number): number {
  return Math.min(days - 1, Math.max(0, Math.floor((at.getTime() - from.getTime()) / DAY_MS)));
}

/**
 * Summarise real customer cash without ever reading Stripe fees.
 *
 * Stripe charges + audited manual receipts own the total. Product receipts only
 * explain the mix; a visible reconciliation figure catches missing/duplicate
 * ledger rows instead of silently changing the cash truth.
 */
export function summarizeRevenuePeriod(input: {
  now: Date;
  days: RevenueRangeDays;
  cashEvents: readonly RevenueCashEvent[];
  receipts: readonly RevenueReceiptEvent[];
}): RevenuePeriodSummary {
  const until = input.now;
  const from = new Date(until.getTime() - input.days * DAY_MS);
  const previousFrom = new Date(from.getTime() - input.days * DAY_MS);
  const current = sumCash(input.cashEvents, from, until);
  const previous = sumCash(input.cashEvents, previousFrom, from);

  const mix: RevenueMix = {
    studio: 0,
    bundle: 0,
    credit: 0,
    manual: 0,
    other: 0,
    refunds: current.refunds,
    reconciliation: 0,
  };
  const earliestByCustomer = new Map<string, number>();
  for (const receipt of input.receipts) {
    const key = receipt.customerKey.trim().toLowerCase();
    if (!key) continue;
    const time = receipt.at.getTime();
    const seen = earliestByCustomer.get(key);
    if (seen == null || time < seen) earliestByCustomer.set(key, time);
  }

  const currentCustomers = new Map<string, number>();
  for (const receipt of input.receipts) {
    if (!inWindow(receipt.at, from, until)) continue;
    const amount = finiteMoney(receipt.amountBaht);
    mix[receipt.source] += amount;
    const key = receipt.customerKey.trim().toLowerCase();
    if (!key) continue;
    const time = receipt.at.getTime();
    const seen = currentCustomers.get(key);
    if (seen == null || time < seen) currentCustomers.set(key, time);
  }

  const classifiedStripe = mix.studio + mix.bundle + mix.credit;
  mix.other = Math.max(0, current.stripeGross - classifiedStripe);
  const explainedNet = mix.studio + mix.bundle + mix.credit + mix.manual + mix.other - mix.refunds;
  mix.reconciliation = current.total - explainedNet;

  let newPayers = 0;
  let repeatPayers = 0;
  for (const [key, firstInWindow] of currentCustomers) {
    if (earliestByCustomer.get(key) === firstInWindow) newPayers += 1;
    else repeatPayers += 1;
  }

  const currentBins = Array.from({ length: input.days }, () => 0);
  const previousBins = Array.from({ length: input.days }, () => 0);
  for (const event of input.cashEvents) {
    const net = event.source === "manual"
      ? finiteMoney(event.amountBaht)
      : finiteMoney(event.amountBaht) - finiteMoney(event.refundedBaht);
    if (inWindow(event.at, from, until)) currentBins[bucketIndex(event.at, from, input.days)] += net;
    else if (inWindow(event.at, previousFrom, from)) previousBins[bucketIndex(event.at, previousFrom, input.days)] += net;
  }

  return {
    currentGross: current.total,
    previousGross: previous.total,
    changePct: previous.total > 0 ? ((current.total - previous.total) / previous.total) * 100 : null,
    stripeGross: current.stripeGross,
    stripeNet: current.stripeNet,
    manual: current.manual,
    refunds: current.refunds,
    transactions: current.transactions,
    newPayers,
    repeatPayers,
    mix,
    trend: currentBins.map((value, index) => {
      const date = new Date(from.getTime() + index * DAY_MS);
      return {
        date: bangkokDate(date),
        label: shortBangkokDate(date),
        current: value,
        previous: previousBins[index],
      };
    }),
  };
}

export function parseRevenueRange(raw: string | null): RevenueRangeDays {
  const value = Number(raw);
  return REVENUE_RANGE_DAYS.includes(value as RevenueRangeDays) ? value as RevenueRangeDays : 30;
}
