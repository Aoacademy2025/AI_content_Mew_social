import "server-only";

import { prisma } from "@/lib/prisma";
import { ensureStripeConfig } from "@/lib/load-stripe-config";
import { stripe } from "@/lib/stripe";
import {
  summarizeLifetimeCash,
  type CashCharge,
  type LifetimeCashSummary,
} from "@/lib/revenue-cash";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: { expiresAt: number; value: LifetimeCashSummary } | null = null;
let pending: Promise<LifetimeCashSummary> | null = null;

async function loadLifetimeCash(): Promise<LifetimeCashSummary> {
  await ensureStripeConfig();
  const manual = await prisma.payment.aggregate({
    where: { status: "PAID", manual: true },
    _sum: { amount: true },
  });
  const charges: CashCharge[] = [];
  for await (const charge of stripe.charges.list({ limit: 100 })) {
    charges.push({
      amount: charge.amount,
      amountRefunded: charge.amount_refunded,
      currency: charge.currency,
      paid: charge.paid,
      status: charge.status,
    });
  }
  return summarizeLifetimeCash(charges, manual._sum.amount ?? 0);
}

/** Real all-time cash: Stripe successful charges net of refunds + audited manual receipts. */
export async function getLifetimeCashCollected(nowMs = Date.now()): Promise<LifetimeCashSummary> {
  if (cached && cached.expiresAt > nowMs) return cached.value;
  if (pending) return pending;
  pending = loadLifetimeCash()
    .then((value) => {
      cached = { expiresAt: Date.now() + CACHE_TTL_MS, value };
      return value;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
