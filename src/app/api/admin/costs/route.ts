import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import {
  getCostRates,
  computeCogs,
  computeMargins,
  computeBreakEvenTarget,
} from "@/lib/cost-rates";
import { getRevenueCohorts } from "@/lib/revenue-cohorts";
import { getLifetimeCashCollected } from "@/lib/revenue-cash.server";
import { getActiveRunpodImageCostSnapshot } from "@/lib/runpod-image-cost.server";
import {
  aiImageCostBucket,
  aiImageJobIdFromAction,
  aiImageLedgerActionWhere,
  emptyAiImageCounts,
  type AiImageCounts,
} from "@/lib/ai-image-ledger-report";

const DAY_MS = 24 * 60 * 60 * 1000;

type CogsRates = Awaited<ReturnType<typeof getCostRates>>;

// Net variable COGS (฿) from raw rows — TTS minutes + AI-image spends, netting image refunds.
// Used for the P&L, which is ALWAYS a monthly figure (matches the monthly MRR) so that gross
// margin / profit don't swing when the health-window selector changes (a 24h window would pair
// monthly MRR with 1 day of COGS and read misleadingly profitable).
function netCogs(
  clips: Array<{ chargedMinutes: number | null }>,
  spendRows: Array<{ delta: number; action: string | null }>,
  refundRows: Array<{ delta: number }>,
  rates: CogsRates,
  jobModels: ReadonlyMap<string, string>,
) {
  const managedMinutes = clips.reduce((s, r) => s + (r.chargedMinutes ?? 0), 0);
  const imageCounts = emptyAiImageCounts();
  let grossImageSpend = 0;
  for (const r of spendRows) {
    const jobId = aiImageJobIdFromAction(r.action);
    const bucket = aiImageCostBucket({ model: jobId ? jobModels.get(jobId) : null, delta: r.delta });
    if (!bucket) continue;
    imageCounts[bucket]++;
    grossImageSpend += Math.abs(r.delta);
  }
  const refundCredits = refundRows.reduce((s, r) => s + Math.abs(r.delta), 0);
  const gross = computeCogs({ managedMinutes, imageCounts, rates });
  const ratio = grossImageSpend > 0 ? Math.max(0, 1 - refundCredits / grossImageSpend) : 1;
  const imageNet = gross.image * ratio;
  return { tts: gross.tts, image: imageNet, video: gross.video, total: gross.tts + imageNet + gross.video };
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
    // Financial P&L (COGS / margin / profit) is always monthly so it stays consistent with the
    // monthly MRR regardless of the selected health window. Usage/cash/top-users still use `from`.
    const monthFrom = new Date(now.getTime() - 30 * DAY_MS);

    // ── Parallel data fetch ───────────────────────────────────────────────────
    const [
      rates,
      cohorts,
      chargedClips,
      imageSpendRows,
      paidPayments,
      rendersWeb,
      rendersMcp,
      activeCreatorsCount,
      creditGrantRows,
      imageRefundRows,
      chargedClipsMonth,
      imageSpendMonth,
      imageRefundMonth,
      runpodImageCost,
      lifetimeCash,
    ] = await Promise.all([
      getCostRates(),

      // Real revenue cohorts — money-backed customers (subs + one-time/PromptPay/annual),
      // trials excluded, annual MRR normalized. Replaces the old subStatus="active"-only count
      // that was blind to PromptPay/annual one-time payers and mislabeled trials as paying.
      getRevenueCohorts(now),

      // Managed render minutes — ChargedClip rows in window. (Under MINUTE_QUOTA=1 the
      // reserve moved to the render route, so the old `minute_reserve` telemetry no longer
      // fires; ChargedClip.chargedMinutes is the minutes-model charge record per video.)
      prisma.chargedClip.findMany({
        where: { createdAt: { gte: from }, chargedMinutes: { not: null } },
        select: { userId: true, chargedMinutes: true, createdAt: true },
      }),

      // AI-image spends in window
      prisma.creditLedger.findMany({
        where: { kind: "spend", ...aiImageLedgerActionWhere("spend"), createdAt: { gte: from } },
        select: { userId: true, delta: true, action: true, createdAt: true },
      }),

      // Cash in the Studio payment ledger. Credit packs also create Payment rows, so this is
      // the authoritative source; CreditLedger purchase rows can be admin grants and must not
      // be treated as cash or counted a second time.
      prisma.payment.findMany({
        where: { status: "PAID", paidAt: { gte: from } },
        select: { amount: true, periodDays: true, note: true },
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
        where: { kind: "refund", ...aiImageLedgerActionWhere("refund"), createdAt: { gte: from } },
        select: { delta: true },
      }),

      // ── Monthly (30-day) COGS inputs — for the P&L only (margin/profit stay monthly) ──
      prisma.chargedClip.findMany({
        where: { createdAt: { gte: monthFrom }, chargedMinutes: { not: null } },
        select: { chargedMinutes: true },
      }),
      prisma.creditLedger.findMany({
        where: { kind: "spend", ...aiImageLedgerActionWhere("spend"), createdAt: { gte: monthFrom } },
        select: { delta: true, action: true },
      }),
      prisma.creditLedger.findMany({
        where: { kind: "refund", ...aiImageLedgerActionWhere("refund"), createdAt: { gte: monthFrom } },
        select: { delta: true },
      }),
      getActiveRunpodImageCostSnapshot({ windowDays: Math.min(days, 30) }).catch(() => null),
      getLifetimeCashCollected().catch(() => null),
    ]);

    // Durable ledger actions carry the AiGenerationJob id. Join once so two-credit
    // Z-Image rows are costed as Hero/RunPod instead of being mislabeled as legacy Flux.
    const imageJobIds = Array.from(new Set(
      [...imageSpendRows, ...imageSpendMonth]
        .map((row) => aiImageJobIdFromAction(row.action))
        .filter((jobId): jobId is string => Boolean(jobId)),
    ));
    const imageJobs = imageJobIds.length > 0
      ? await prisma.aiGenerationJob.findMany({
          where: { id: { in: imageJobIds }, kind: "image" },
          select: { id: true, model: true },
        })
      : [];
    const imageJobModels = new Map(imageJobs.map((job) => [job.id, job.model]));

    // ── Managed minutes — sum ChargedClip.chargedMinutes (minutes billed per video) ──
    let managedMinutes = 0;
    const perUserMinutes = new Map<string, number>();
    for (const row of chargedClips) {
      const mins = row.chargedMinutes ?? 0;
      managedMinutes += mins;
      if (row.userId) {
        perUserMinutes.set(row.userId, (perUserMinutes.get(row.userId) ?? 0) + mins);
      }
    }

    // ── AI-image counts ───────────────────────────────────────────────────────
    const imageCounts = emptyAiImageCounts();
    const perUserImages = new Map<string, AiImageCounts>();
    for (const row of imageSpendRows) {
      const jobId = aiImageJobIdFromAction(row.action);
      const bucket = aiImageCostBucket({ model: jobId ? imageJobModels.get(jobId) : null, delta: row.delta });
      if (!bucket) continue;
      imageCounts[bucket]++;
      if (row.userId) {
        const u = perUserImages.get(row.userId) ?? emptyAiImageCounts();
        u[bucket]++;
        perUserImages.set(row.userId, u);
      }
    }

    // ── Credit-pack cash ──────────────────────────────────────────────────────
    let packCash = 0;
    // creditsSpent counts only attributable AI-image deltas so it
    // matches imageCounts (non-bucketed rows are unknown spend not attributable
    // to a model and should not inflate the gross).
    let grossImageSpend = 0;
    for (const row of imageSpendRows) {
      const absDelta = Math.abs(row.delta);
      const jobId = aiImageJobIdFromAction(row.action);
      if (aiImageCostBucket({ model: jobId ? imageJobModels.get(jobId) : null, delta: row.delta }) !== null) {
        grossImageSpend += absDelta;
      }
    }
    // FIX 1: net out refunds — image COGS/creditsSpent are NET of refunds (best-
    // effort estimate; per-model refund attribution not tracked because the refund
    // row does not record which model bucket was originally charged).
    const refundCredits = imageRefundRows.reduce((sum, r) => sum + Math.abs(r.delta), 0);
    const creditsSpent = Math.max(0, grossImageSpend - refundCredits);
    // ── Plan cash — split by term (periodDays >= 365 = annual, else monthly) ──
    let planCashMonthly = 0;
    let planCashAnnual = 0;
    for (const p of paidPayments) {
      const baht = p.amount / 100;
      if (p.note === "credits") {
        packCash += baht;
        continue;
      }
      if ((p.periodDays ?? 30) >= 365) planCashAnnual += baht;
      else planCashMonthly += baht;
    }
    const planCash = planCashMonthly + planCashAnnual;
    const cashCollected = planCash + packCash;

    // ── Credits granted total ─────────────────────────────────────────────────
    const creditsGranted = creditGrantRows.reduce((sum, r) => sum + r.delta, 0);

    // ── MRR & COGS & Margins ──────────────────────────────────────────────────
    // MRR comes from the real cohort engine: card subs + one-time/PromptPay/annual, with
    // annual terms normalized to a monthly figure. Trials are NOT revenue.
    const mrr = cohorts.mrr;
    // COGS/margin/profit are a MONTHLY P&L (30-day COGS + full monthly infra vs monthly MRR),
    // independent of the health-window selector — otherwise a 24h window shows ~1 day of COGS
    // against a full month of MRR and profit reads far too rosy.
    const cogs = netCogs(chargedClipsMonth, imageSpendMonth, imageRefundMonth, rates, imageJobModels);
    const margins = computeMargins({
      revenue: mrr,
      variableCogs: cogs.total,
      infraMonthly: rates.infraMonthly,
      periodDays: 30,
    });

    // ── Live break-even target ────────────────────────────────────────────────
    // infra ÷ gross-profit-per-paying-customer, using THIS page's own monthly margin so it can
    // never contradict the profit tile. Falls back to the static constant only when payingTotal=0.
    const breakEvenTarget = computeBreakEvenTarget({
      infraMonthly: rates.infraMonthly,
      grossProfit: margins.grossProfit,
      payingTotal: cohorts.payingTotal,
    });

    // ── Top-cost users (top 10) ───────────────────────────────────────────────
    const allUserIds = new Set([...perUserMinutes.keys(), ...perUserImages.keys()]);
    const topUsers = Array.from(allUserIds)
      .map((userId) => {
        const mins = perUserMinutes.get(userId) ?? 0;
        const imgs = perUserImages.get(userId) ?? emptyAiImageCounts();
        const userCogs = computeCogs({ managedMinutes: mins, imageCounts: imgs, rates });
        const images = Object.values(imgs).reduce((sum, count) => sum + count, 0);
        return { userId, cogs: userCogs.total, minutes: mins, images };
      })
      .sort((a, b) => b.cogs - a.cogs)
      .slice(0, 10);

    // ── Daily trend ───────────────────────────────────────────────────────────
    // Build a date-keyed map for revenue (MRR prorated per day) + cogs
    const dailyMinutes = new Map<string, number>();
    for (const row of chargedClips) {
      const label = dateLabel(row.createdAt);
      const mins = row.chargedMinutes ?? 0;
      dailyMinutes.set(label, (dailyMinutes.get(label) ?? 0) + mins);
    }

    const dailyImages = new Map<string, AiImageCounts>();
    for (const row of imageSpendRows) {
      const jobId = aiImageJobIdFromAction(row.action);
      const bucket = aiImageCostBucket({ model: jobId ? imageJobModels.get(jobId) : null, delta: row.delta });
      if (!bucket) continue;
      const label = dateLabel(row.createdAt);
      const d = dailyImages.get(label) ?? emptyAiImageCounts();
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
      const dayImgs = dailyImages.get(label) ?? emptyAiImageCounts();
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
        infraProrated: margins.infraProrated,
      },
      // Real paying customers (subs + one-time/PromptPay/annual), trials separated. See revenue-cohorts.ts.
      customers: cohorts,
      // Actual cash collected in the window, split by source (satang→baht already applied).
      cash: {
        total: cashCollected,
        planMonthly: planCashMonthly,
        planAnnual: planCashAnnual,
        packs: packCash,
        allTimeTotal: lifetimeCash?.total ?? null,
        allTimeStripeNet: lifetimeCash?.stripeNet ?? null,
        allTimeManual: lifetimeCash?.manual ?? null,
        allTimeRefunds: lifetimeCash?.refunds ?? null,
        allTimeAsOf: now.toISOString(),
      },
      breakdown: {
        tts: cogs.tts,
        image: cogs.image,
        video: cogs.video,
        infra: rates.infraMonthly,
        infraProrated: margins.infraProrated,
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
        subs: cohorts.breakEvenSubs,
        target: breakEvenTarget,
      },
      runpodImageCost,
      trend,
    });
  } catch (error) {
    return apiError({ route: "GET /api/admin/costs", error });
  }
}
