import "server-only";

import { prisma } from "@/lib/prisma";
import { ensureStripeConfig } from "@/lib/load-stripe-config";
import { stripe } from "@/lib/stripe";
import { getLifetimeCashCollected } from "@/lib/revenue-cash.server";
import { getRevenueCohorts } from "@/lib/revenue-cohorts";
import { getSubscriptionNorthStar } from "@/lib/subscription-north-star.server";
import {
  summarizeRevenuePeriod,
  type RevenueCashEvent,
  type RevenueRangeDays,
  type RevenueReceiptEvent,
} from "@/lib/revenue-growth";
import {
  buildRevenueGrowthOpportunityPlan,
  type RevenueGrowthOpportunityPlan,
} from "@/lib/revenue-growth-opportunities";

const DAY_MS = 86_400_000;
const MONTHLY_REVENUE_TARGET = 100_000;

export type RevenueGrowthDashboardData = {
  range: { days: RevenueRangeDays; since: string; until: string };
  northStar: {
    metric: "MAPC";
    activeCreators: number;
    activePayingCustomers: number;
    activeRecurringPayers: number;
    creatorRatePct: number;
    monthlyCreators: number;
    annualCreators: number;
    outcomes: { videoCreators: number; scriptCreators: number; imageCreators: number };
    asOf: string;
    formula: string;
    history: Array<{
      date: string;
      activeCreators: number;
      activePayingCustomers: number;
      videoCreators: number;
      scriptCreators: number;
      imageCreators: number;
    }>;
  };
  goal: {
    monthlyRevenueTarget: number;
    last30DaysGross: number;
    progressPct: number;
    gap: number;
  };
  cash: ReturnType<typeof summarizeRevenuePeriod> & { lifetimeGross: number };
  base: {
    activePayingCustomers: number;
    recurringMonthly: number;
    prepaidMonthlyEquivalent: number;
    activeMonthlyValue: number;
    arr: number;
    deferredRevenue: number;
    creditRevenue: number;
    creditBuyers: number;
    directPayers: number;
    bundlePayers: number;
    trials: number;
    free: number;
    comped: number;
    lapsed: number;
  };
  insights: Array<{ tone: "positive" | "attention" | "neutral"; title: string; detail: string }>;
  growthPlan: RevenueGrowthOpportunityPlan;
  teamActions: Array<{
    team: "Content" | "Graphic" | "Editor" | "Media";
    focus: string;
    action: string;
    measure: string;
  }>;
};

function baht(satang: number | null | undefined): number {
  return Math.max(0, Number(satang ?? 0)) / 100;
}

function pct(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function money(value: number): string {
  return new Intl.NumberFormat("th-TH", { maximumFractionDigits: 0 }).format(value);
}

async function getBundleReceipts(): Promise<RevenueReceiptEvent[]> {
  const entitlements = await prisma.bundleEntitlement.findMany({
    where: { subscriptionId: { not: null } },
    select: { email: true, subscriptionId: true },
  });
  const bySubscription = new Map<string, string>();
  for (const entitlement of entitlements) {
    if (entitlement.subscriptionId) bySubscription.set(entitlement.subscriptionId, entitlement.email.trim().toLowerCase());
  }

  const groups = await Promise.all([...bySubscription].map(async ([subscriptionId, email]) => {
    const rows: RevenueReceiptEvent[] = [];
    for await (const invoice of stripe.invoices.list({ subscription: subscriptionId, status: "paid", limit: 100 })) {
      if (invoice.currency.toLowerCase() !== "thb" || invoice.amount_paid <= 0) continue;
      const paidAt = invoice.status_transitions.paid_at ?? invoice.created;
      rows.push({
        at: new Date(paidAt * 1_000),
        amountBaht: baht(invoice.amount_paid),
        source: "bundle",
        customerKey: email,
      });
    }
    return rows;
  }));
  return groups.flat();
}

function buildInsights(input: {
  currentGross: number;
  previousGross: number;
  changePct: number | null;
  activeCreators: number;
  activePayingCustomers: number;
  creatorRatePct: number;
  recurringMonthly: number;
  prepaidMonthly: number;
}) {
  const direction = input.changePct == null
    ? { tone: "neutral" as const, title: "เริ่มเก็บฐานเทียบ", detail: "ช่วงก่อนหน้ายังไม่มีรายได้พอให้เทียบ" }
    : input.changePct >= 0
      ? { tone: "positive" as const, title: `รายได้โต ${Math.round(input.changePct)}%`, detail: `มากกว่าช่วงก่อน ฿${money(input.currentGross - input.previousGross)}` }
      : { tone: "attention" as const, title: `รายได้ลด ${Math.abs(Math.round(input.changePct))}%`, detail: `น้อยกว่าช่วงก่อน ฿${money(input.previousGross - input.currentGross)}` };

  const inactivePayers = Math.max(0, input.activePayingCustomers - input.activeCreators);
  const creator = inactivePayers === 0
    ? { tone: "positive" as const, title: "ลูกค้าจ่ายกลับมาสร้างครบ", detail: `MAPC ${input.activeCreators} คน · อัตรากลับมา ${input.creatorRatePct}%` }
    : { tone: "attention" as const, title: `ยังดึงกลับได้อีก ${inactivePayers} คน`, detail: `ลูกค้าจ่ายจริงที่ยังไม่สร้างงานใน 30 วัน` };

  const monthlyBase = input.recurringMonthly + input.prepaidMonthly;
  const prepaidShare = pct(input.prepaidMonthly, monthlyBase);
  const renewal = prepaidShare >= 25
    ? { tone: "attention" as const, title: `ฐานรายได้ ${prepaidShare}% ไม่ต่ออายุเอง`, detail: "ต้องมีแคมเปญต่ออายุก่อนสิทธิ์หมด" }
    : { tone: "neutral" as const, title: "ฐานรายได้ต่ออายุค่อนข้างแข็งแรง", detail: `ส่วนจ่ายล่วงหน้า ${prepaidShare}% ของมูลค่ารายเดือน` };
  return [direction, creator, renewal];
}

export async function getRevenueGrowthDashboard(
  days: RevenueRangeDays,
  now: Date = new Date(),
): Promise<RevenueGrowthDashboardData> {
  await ensureStripeConfig();
  const cashFrom = new Date(now.getTime() - Math.max(days * 2, 60) * DAY_MS);

  const [payments, cohorts, northStar, history, lifetime, bundleReceipts, featureRequests] = await Promise.all([
    prisma.payment.findMany({
      where: { status: "PAID" },
      select: {
        amount: true, paidAt: true, createdAt: true, manual: true, note: true,
        user: { select: { email: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    getRevenueCohorts(now),
    getSubscriptionNorthStar(now),
    prisma.northStarDailySnapshot.findMany({
      orderBy: { snapshotDate: "desc" },
      take: 31,
      select: {
        snapshotDate: true, activeCreators: true, activePayingCustomers: true,
        activeRecurringPayers: true, videoCreators: true, scriptCreators: true, imageCreators: true,
      },
    }),
    getLifetimeCashCollected(),
    getBundleReceipts(),
    prisma.supportTicket.findMany({
      where: {
        OR: [
          { category: "FEATURE_REQUEST" },
          { recommendedAction: "ADD_FEATURE" },
        ],
      },
      select: { message: true, auditNote: true, impactNote: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    }),
  ]);

  const cashEvents: RevenueCashEvent[] = [];
  for await (const charge of stripe.charges.list({
    created: { gte: Math.floor(cashFrom.getTime() / 1_000) },
    limit: 100,
  })) {
    if (!charge.paid || charge.status !== "succeeded" || charge.currency.toLowerCase() !== "thb") continue;
    cashEvents.push({
      at: new Date(charge.created * 1_000),
      amountBaht: baht(charge.amount),
      // Refunds are fetched as their own dated cash-out events below. Using
      // amount_refunded here would move the cash-out back to the charge date.
      refundedBaht: 0,
      source: "stripe",
    });
  }
  for await (const refund of stripe.refunds.list({
    created: { gte: Math.floor(cashFrom.getTime() / 1_000) },
    limit: 100,
  })) {
    if (refund.status !== "succeeded" || refund.currency.toLowerCase() !== "thb") continue;
    cashEvents.push({
      at: new Date(refund.created * 1_000),
      amountBaht: 0,
      refundedBaht: baht(refund.amount),
      source: "stripe",
    });
  }

  const receipts: RevenueReceiptEvent[] = [...bundleReceipts];
  for (const payment of payments) {
    const at = payment.paidAt ?? payment.createdAt;
    const customerKey = payment.user.email.trim().toLowerCase();
    const amountBaht = baht(payment.amount);
    if (payment.manual) {
      cashEvents.push({ at, amountBaht, refundedBaht: 0, source: "manual" });
      receipts.push({ at, amountBaht, source: "manual", customerKey });
    } else {
      receipts.push({
        at,
        amountBaht,
        source: payment.note === "credits" ? "credit" : "studio",
        customerKey,
      });
    }
  }

  const cash = summarizeRevenuePeriod({ now, days, cashEvents, receipts });
  const monthlyCash = days === 30
    ? cash
    : summarizeRevenuePeriod({ now, days: 30, cashEvents, receipts });
  const recurringMonthly = cohorts.recurringMrr + cohorts.bundleMrr;
  const requestText = featureRequests.map((ticket) => [
    ticket.message,
    ticket.auditNote,
    ticket.impactNote,
  ].filter(Boolean).join(" ").toLowerCase());
  const brollFeatureRequests = requestText.filter((text) => /b[\s-]?roll|ฟุตเทจ|ภาพแทรก/u.test(text)).length;
  const faceConsistencyRequests = requestText.filter((text) => /face[\s-]?lock|same character|character consistency|หน้าเหมือน|ใบหน้า|คนเดิม|ตัวละครเดิม/u.test(text)).length;
  const insights = buildInsights({
    currentGross: cash.currentGross,
    previousGross: cash.previousGross,
    changePct: cash.changePct,
    activeCreators: northStar.activeCreators,
    activePayingCustomers: northStar.activePayingCustomers,
    creatorRatePct: northStar.creatorRatePct,
    recurringMonthly,
    prepaidMonthly: cohorts.prepaidMrr,
  });
  const growthPlan = buildRevenueGrowthOpportunityPlan({
    activeCreators: northStar.activeCreators,
    activePayingCustomers: northStar.activePayingCustomers,
    videoCreators: northStar.outcomes.videoCreators,
    imageCreators: northStar.outcomes.imageCreators,
    prepaidMonthlyEquivalent: cohorts.prepaidMrr,
    activeMonthlyValue: cohorts.mrr,
    brollFeatureRequests,
    faceConsistencyRequests,
  });

  const mapcGap = Math.max(0, northStar.activePayingCustomers - northStar.activeCreators);
  return {
    range: {
      days,
      since: new Date(now.getTime() - days * DAY_MS).toISOString(),
      until: now.toISOString(),
    },
    northStar: {
      metric: "MAPC",
      activeCreators: northStar.activeCreators,
      activePayingCustomers: northStar.activePayingCustomers,
      activeRecurringPayers: northStar.activeRecurringPayers,
      creatorRatePct: northStar.creatorRatePct,
      monthlyCreators: northStar.monthlyCreators,
      annualCreators: northStar.annualCreators,
      outcomes: northStar.outcomes,
      asOf: northStar.asOf,
      formula: northStar.formula,
      history: history.reverse().map((row) => ({
        date: row.snapshotDate,
        activeCreators: row.activeCreators,
        activePayingCustomers: row.activePayingCustomers || row.activeRecurringPayers,
        videoCreators: row.videoCreators,
        scriptCreators: row.scriptCreators,
        imageCreators: row.imageCreators,
      })),
    },
    goal: {
      monthlyRevenueTarget: MONTHLY_REVENUE_TARGET,
      last30DaysGross: monthlyCash.currentGross,
      progressPct: Math.min(100, pct(monthlyCash.currentGross, MONTHLY_REVENUE_TARGET)),
      gap: Math.max(0, MONTHLY_REVENUE_TARGET - monthlyCash.currentGross),
    },
    cash: { ...cash, lifetimeGross: lifetime.total },
    base: {
      activePayingCustomers: cohorts.payingTotal,
      recurringMonthly,
      prepaidMonthlyEquivalent: cohorts.prepaidMrr,
      activeMonthlyValue: cohorts.mrr,
      arr: cohorts.arr,
      deferredRevenue: cohorts.deferredRevenue,
      creditRevenue: cohorts.creditRevenue,
      creditBuyers: cohorts.creditBuyers,
      directPayers: cohorts.directPayingTotal,
      bundlePayers: cohorts.bundleActive,
      trials: cohorts.trialActive,
      free: cohorts.free,
      comped: cohorts.compedPaid,
      lapsed: cohorts.lapsedPayers,
    },
    insights,
    growthPlan,
    teamActions: [
      { team: "Content", focus: "ดึงคนจ่ายกลับมา", action: `ทำชุด Use case สำหรับ ${mapcGap} คนที่ยังไม่สร้างงาน`, measure: "MAPC" },
      { team: "Graphic", focus: "ข้อเสนอเดียว ภาพชัด", action: "แตก 3 มุมภาพจากสารหลักเดียว", measure: "คลิกต่อชิ้น" },
      { team: "Editor", focus: "Hook ให้หยุดดู", action: "ตัด Hook 3 แบบต่อแคมเปญ", measure: "ดู 3 วินาที" },
      { team: "Media", focus: "รู้ว่าเงินมาจากไหน", action: "ติด UTM แยกทุกชิ้นก่อนเพิ่มงบ", measure: "รายได้ต่อแคมเปญ" },
    ],
  };
}
