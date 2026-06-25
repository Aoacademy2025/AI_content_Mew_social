import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { getPlanConfig } from "@/lib/plan-config";
import {
  getCostRates,
  computeMrr,
  computeCogs,
  computeMargins,
  BREAK_EVEN_SUBS,
} from "@/lib/cost-rates";

const DAY_MS = 24 * 60 * 60 * 1000;

// Credit-pack delta → Thai baht price mapping
const PACK_CREDIT_TO_BAHT: Record<number, number> = {
  200: 199,
  540: 499,
  1150: 999,
};

// AI-image spend delta → image model bucket
// MUST stay in sync with CREDIT_COST / costKeyForKieModel in src/lib/credits.ts.
// Today only 3 (gpt-1k) and 4 (nano-1k) are reachable; 5/6 reserved.
// If CREDIT_COST image values change, update here or spends silently drop from COGS.
function imageModelBucket(absDelta: number): "gpt1k" | "nano1k" | "gpt2k" | "nano2k" | null {
  if (absDelta === 3) return "gpt1k";
  if (absDelta === 4) return "nano1k";
  if (absDelta === 5) return "gpt2k";
  if (absDelta === 6) return "nano2k";
  return null;
}

function parseDays(raw: string | null): number {
  const n = Number(raw ?? 30);
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(Math.floor(n), 365);
}

function dateLabel(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

export async function GET(req: Request) {
  try {
    // ── Auth guard (mirror /api/admin/insights) ───────────────────────────────
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (authUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // ── Window ────────────────────────────────────────────────────────────────
    const url = new URL(req.url);
    const days = parseDays(url.searchParams.get("days"));
    const now = new Date();
    const from = new Date(now.getTime() - days * DAY_MS);

    // ── Parallel data fetch ───────────────────────────────────────────────────
    const [
      rates,
      planConfig,
      proSubCount,
      businessSubCount,
      minuteReserveEvents,
      imageSpendRows,
      creditPurchaseRows,
      paidPayments,
      rendersWeb,
      rendersMcp,
      activeCreatorsCount,
      creditGrantRows,
      imageRefundRows,
    ] = await Promise.all([
      getCostRates(),
      getPlanConfig(),

      // Active subscriber counts by tier
      prisma.user.count({ where: { subStatus: "active", plan: "PRO" } }),
      prisma.user.count({ where: { subStatus: "active", plan: "BUSINESS" } }),

      // Managed minutes — TelemetryEvent name="minute_reserve" in window
      prisma.telemetryEvent.findMany({
        where: { name: "minute_reserve", createdAt: { gte: from } },
        select: { userId: true, properties: true, createdAt: true },
      }),

      // AI-image spends in window
      prisma.creditLedger.findMany({
        where: { kind: "spend", action: "ai-image", createdAt: { gte: from } },
        select: { userId: true, delta: true, createdAt: true },
      }),

      // Credit-pack purchases in window (kind="purchase")
      prisma.creditLedger.findMany({
        where: { kind: "purchase", createdAt: { gte: from } },
        select: { delta: true },
      }),

      // Subscription cash in window (only PAID payments)
      prisma.payment.findMany({
        where: { status: "PAID", paidAt: { gte: from } },
        select: { amount: true },
      }),

      // Web renders (parentJobId IS null)
      prisma.renderJob.count({
        where: { status: "DONE", parentJobId: null, createdAt: { gte: from } },
      }),

      // MCP renders (parentJobId IS NOT null)
      prisma.renderJob.count({
        where: { status: "DONE", parentJobId: { not: null }, createdAt: { gte: from } },
      }),

      // Distinct creators who did anything in the window
      prisma.telemetryEvent.groupBy({
        by: ["userId"],
        where: { userId: { not: null }, createdAt: { gte: from } },
      }),

      // Credit grants in window (for creditsGranted reporting)
      prisma.creditLedger.findMany({
        where: { kind: "grant", createdAt: { gte: from } },
        select: { delta: true },
      }),

      // AI-image refunds in window — failed generations are refunded as a separate row
      // (kind="refund", action="ai-image-refund"); the original spend row remains.
      // We net these out so image COGS/creditsSpent are not upward-biased.
      prisma.creditLedger.findMany({
        where: { kind: "refund", action: "ai-image-refund", createdAt: { gte: from } },
        select: { delta: true },
      }),
    ]);

    // ── Managed minutes — parse properties JSON ───────────────────────────────
    let managedMinutes = 0;
    const perUserMinutes = new Map<string, number>();
    for (const row of minuteReserveEvents) {
      let mins = 0;
      if (row.properties) {
        try {
          const parsed = JSON.parse(row.properties) as Record<string, unknown>;
          const v = parsed.minutes;
          if (typeof v === "number" && Number.isFinite(v)) mins = v;
          else if (typeof v === "string") {
            const n = parseFloat(v);
            if (Number.isFinite(n)) mins = n;
          }
        } catch {
          // skip bad rows
        }
      }
      managedMinutes += mins;
      if (row.userId) {
        perUserMinutes.set(row.userId, (perUserMinutes.get(row.userId) ?? 0) + mins);
      }
    }

    // ── AI-image counts ───────────────────────────────────────────────────────
    const imageCounts = { gpt1k: 0, nano1k: 0, gpt2k: 0, nano2k: 0 };
    const perUserImages = new Map<string, { gpt1k: number; nano1k: number; gpt2k: number; nano2k: number }>();
    for (const row of imageSpendRows) {
      const bucket = imageModelBucket(Math.abs(row.delta));
      if (!bucket) continue;
      imageCounts[bucket]++;
      if (row.userId) {
        const u = perUserImages.get(row.userId) ?? { gpt1k: 0, nano1k: 0, gpt2k: 0, nano2k: 0 };
        u[bucket]++;
        perUserImages.set(row.userId, u);
      }
    }

    // ── Credit-pack cash ──────────────────────────────────────────────────────
    let packCash = 0;
    // FIX 2: creditsSpent counts only BUCKETED ai-image deltas {3,4,5,6} so it
    // matches imageCounts (non-bucketed rows are unknown spend not attributable
    // to a model and should not inflate the gross).
    let grossImageSpend = 0;
    for (const row of imageSpendRows) {
      const absDelta = Math.abs(row.delta);
      if (imageModelBucket(absDelta) !== null) {
        grossImageSpend += absDelta;
      }
    }
    // FIX 1: net out refunds — image COGS/creditsSpent are NET of refunds (best-
    // effort estimate; per-model refund attribution not tracked because the refund
    // row does not record which model bucket was originally charged).
    const refundCredits = imageRefundRows.reduce((sum, r) => sum + Math.abs(r.delta), 0);
    const creditsSpent = Math.max(0, grossImageSpend - refundCredits);
    for (const row of creditPurchaseRows) {
      const baht = PACK_CREDIT_TO_BAHT[row.delta];
      if (baht !== undefined) packCash += baht;
    }

    // ── Subscription cash ─────────────────────────────────────────────────────
    const subCash = paidPayments.reduce((sum, p) => sum + p.amount, 0) / 100;

    const cashCollected = subCash + packCash;

    // ── Credits granted total ─────────────────────────────────────────────────
    const creditsGranted = creditGrantRows.reduce((sum, r) => sum + r.delta, 0);

    // ── MRR & COGS & Margins ──────────────────────────────────────────────────
    const prices = { pro: planConfig.pro.price, business: planConfig.business.price };
    const activeSubs = { pro: proSubCount, business: businessSubCount };

    const mrr = computeMrr(activeSubs, prices);
    const cogsGross = computeCogs({ managedMinutes, imageCounts, rates });
    // FIX 1: scale image COGS proportionally to net out refunds.
    // imageCogsNet = imageCogsGross × max(0, 1 − refundCredits / grossImageSpend)
    // Guard grossImageSpend=0 to avoid NaN.
    const imageRefundRatio = grossImageSpend > 0
      ? Math.max(0, 1 - refundCredits / grossImageSpend)
      : 1;
    const imageCogsNet = cogsGross.image * imageRefundRatio;
    const cogs = { ...cogsGross, image: imageCogsNet, total: cogsGross.tts + imageCogsNet + cogsGross.video };
    const margins = computeMargins({
      revenue: mrr,
      variableCogs: cogs.total,
      infraMonthly: rates.infraMonthly,
      periodDays: days,
    });

    // ── Top-cost users (top 10) ───────────────────────────────────────────────
    const allUserIds = new Set([...perUserMinutes.keys(), ...perUserImages.keys()]);
    const topUsers = Array.from(allUserIds)
      .map((userId) => {
        const mins = perUserMinutes.get(userId) ?? 0;
        const imgs = perUserImages.get(userId) ?? { gpt1k: 0, nano1k: 0, gpt2k: 0, nano2k: 0 };
        const userCogs = computeCogs({ managedMinutes: mins, imageCounts: imgs, rates });
        const images = imgs.gpt1k + imgs.nano1k + imgs.gpt2k + imgs.nano2k;
        return { userId, cogs: userCogs.total, minutes: mins, images };
      })
      .sort((a, b) => b.cogs - a.cogs)
      .slice(0, 10);

    // ── Daily trend ───────────────────────────────────────────────────────────
    // Build a date-keyed map for revenue (MRR prorated per day) + cogs
    const dailyMinutes = new Map<string, number>();
    for (const row of minuteReserveEvents) {
      const label = dateLabel(row.createdAt);
      let mins = 0;
      if (row.properties) {
        try {
          const parsed = JSON.parse(row.properties) as Record<string, unknown>;
          const v = parsed.minutes;
          if (typeof v === "number" && Number.isFinite(v)) mins = v;
          else if (typeof v === "string") {
            const n = parseFloat(v);
            if (Number.isFinite(n)) mins = n;
          }
        } catch {
          // skip bad rows
        }
      }
      dailyMinutes.set(label, (dailyMinutes.get(label) ?? 0) + mins);
    }

    const dailyImages = new Map<string, { gpt1k: number; nano1k: number; gpt2k: number; nano2k: number }>();
    for (const row of imageSpendRows) {
      const bucket = imageModelBucket(Math.abs(row.delta));
      if (!bucket) continue;
      const label = dateLabel(row.createdAt);
      const d = dailyImages.get(label) ?? { gpt1k: 0, nano1k: 0, gpt2k: 0, nano2k: 0 };
      d[bucket]++;
      dailyImages.set(label, d);
    }

    // Daily revenue = MRR / 30 (daily run-rate from current active subs)
    const dailyMrr = mrr / 30;

    const trend: Array<{ date: string; revenue: number; cogs: number }> = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(from.getTime() + i * DAY_MS);
      const label = dateLabel(d);
      const dayMins = dailyMinutes.get(label) ?? 0;
      const dayImgs = dailyImages.get(label) ?? { gpt1k: 0, nano1k: 0, gpt2k: 0, nano2k: 0 };
      const dayCogs = computeCogs({ managedMinutes: dayMins, imageCounts: dayImgs, rates });
      trend.push({ date: label, revenue: dailyMrr, cogs: dayCogs.total });
    }

    // ── Response ──────────────────────────────────────────────────────────────
    return NextResponse.json({
      period: { days, from: from.toISOString() },
      hero: {
        mrr,
        cashCollected,
        variableCogs: cogs.total,
        grossMarginPct: margins.grossMarginPct,
        aiCostPct: margins.aiCostPct,
        netProfit: margins.netProfit,
      },
      breakdown: {
        tts: cogs.tts,
        image: cogs.image,
        video: cogs.video,
        infra: rates.infraMonthly,
      },
      usage: {
        managedMinutes,
        images: imageCounts,
        creditsSpent,
        creditsGranted,
        rendersWeb,
        rendersMcp,
        activeCreators: activeCreatorsCount.length,
      },
      topUsers,
      breakEven: {
        subs: proSubCount + businessSubCount,
        target: BREAK_EVEN_SUBS,
      },
      trend,
    });
  } catch (error) {
    return apiError({ route: "GET /api/admin/costs", error });
  }
}
