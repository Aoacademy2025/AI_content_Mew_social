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
import { bangkokDate } from "@/lib/bangkok-day";
import { getLifetimeCashCollected } from "@/lib/revenue-cash.server";
import { getActiveRunpodImageCostSnapshot } from "@/lib/runpod-image-cost.server";
import {
  aiImageCostBucket,
  aiImageJobIdFromAction,
  aiImageLedgerActionWhere,
  aiImageReservationKeyFromAction,
  emptyAiImageCounts,
  resolveAiImageCost,
  summarizeAiImageUsage,
  type AiImageCounts,
} from "@/lib/ai-image-ledger-report";

const DAY_MS = 24 * 60 * 60 * 1000;

type CogsRates = Awaited<ReturnType<typeof getCostRates>>;

// P&L stays monthly. Image COGS is supplied independently from wallet credits:
// provider attempts can cost money even when the customer reservation is refunded.
function monthlyCogs(
  clips: Array<{ chargedMinutes: number | null }>,
  imageCogs: number,
  rates: CogsRates,
) {
  const managedMinutes = clips.reduce((s, r) => s + (r.chargedMinutes ?? 0), 0);
  const nonImage = computeCogs({ managedMinutes, imageCounts: emptyAiImageCounts(), rates });
  return {
    tts: nonImage.tts,
    image: imageCogs,
    video: nonImage.video,
    total: nonImage.tts + imageCogs + nonImage.video,
  };
}

function parseDays(raw: string | null): number {
  const n = Number(raw ?? 30);
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(Math.floor(n), 365);
}

// Daily trend buckets are Asia/Bangkok days. `toISOString()` labelled them in UTC, so on a
// dashboard read in Bangkok every bucket held 07:00→07:00 of the named day (audit A4, and the
// plan's global day-boundary rule).
function dateLabel(d: Date): string {
  return bangkokDate(d); // YYYY-MM-DD, Asia/Bangkok
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
    const oldestFrom = from < monthFrom ? from : monthFrom;

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
      imageJobs,
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
        select: { userId: true, delta: true, action: true },
      }),
      prisma.creditLedger.findMany({
        where: { kind: "refund", ...aiImageLedgerActionWhere("refund"), createdAt: { gte: monthFrom } },
        select: { delta: true },
      }),
      // Durable jobs are the delivered-image source of truth. `createdAt` keeps
      // current reservations joinable; `finishedAt` includes work completed in
      // the report window after an older reservation.
      prisma.aiGenerationJob.findMany({
        where: {
          kind: "image",
          OR: [
            { createdAt: { gte: oldestFrom, lt: now } },
            { finishedAt: { gte: oldestFrom, lt: now } },
          ],
        },
        select: {
          id: true,
          userId: true,
          model: true,
          status: true,
          chargeState: true,
          creditCost: true,
          fundingSource: true,
          idempotencyKey: true,
          finishedAt: true,
        },
      }),
      // P&L is always a 30-day window, even when the health selector says 24h/7d.
      getActiveRunpodImageCostSnapshot({ now, windowDays: 30 }).catch(() => null),
      getLifetimeCashCollected().catch(() => null),
    ]);

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

    // ── AI-image usage + wallet credits ───────────────────────────────────────
    // Delivery comes from durable jobs, while wallet credits come from ledger
    // rows. This includes allowance-funded output and prevents a reservation row
    // from counting the same durable image twice.
    const imageUsage = summarizeAiImageUsage({
      spendRows: imageSpendRows,
      refundRows: imageRefundRows,
      jobs: imageJobs,
      from,
      to: now,
    });
    const imageUsageMonth = summarizeAiImageUsage({
      spendRows: imageSpendMonth,
      refundRows: imageRefundMonth,
      jobs: imageJobs,
      from: monthFrom,
      to: now,
    });
    const imageCounts = imageUsage.imageCounts;
    const perUserImages = imageUsage.perUserImages;

    // ── Credit-pack cash ──────────────────────────────────────────────────────
    let packCash = 0;
    const creditsSpent = imageUsage.creditsSpent;
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
    const estimatedOtherCounts = { ...imageUsageMonth.imageCounts, hero1k: 0 };
    const estimatedOtherImageCogs = computeCogs({
      managedMinutes: 0,
      imageCounts: estimatedOtherCounts,
      rates,
    }).image;
    const knownNonImageCogs = monthlyCogs(chargedClipsMonth, 0, rates);
    const imageCost = resolveAiImageCost({
      providerSnapshot: runpodImageCost,
      estimatedOtherBaht: estimatedOtherImageCogs,
      unattributedImages: imageUsageMonth.unattributedImages,
    });
    const imageCogs = imageCost.totalBaht;
    const cogs = imageCogs === null
      ? null
      : { ...knownNonImageCogs, image: imageCogs, total: knownNonImageCogs.total + imageCogs };
    const margins = cogs === null
      ? null
      : computeMargins({
          revenue: mrr,
          variableCogs: cogs.total,
          infraMonthly: rates.infraMonthly,
          periodDays: 30,
        });

    // ── Live break-even target ────────────────────────────────────────────────
    // infra ÷ gross-profit-per-paying-customer, using THIS page's own monthly margin so it can
    // never contradict the profit tile. Falls back to the static constant only when payingTotal=0.
    const breakEvenTarget = margins
      ? computeBreakEvenTarget({
          infraMonthly: rates.infraMonthly,
          grossProfit: margins.grossProfit,
          payingTotal: cohorts.payingTotal,
        })
      : null;

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
    const imageJobIds = new Set(imageJobs.map((job) => job.id));
    const imageReservationKeys = new Set(
      imageJobs
        .filter((job) => Boolean(job.idempotencyKey))
        .map((job) => `${job.userId}\u0000${job.idempotencyKey}`),
    );
    for (const job of imageJobs) {
      if (
        job.status !== "completed"
        || job.chargeState !== "settled"
        || !job.finishedAt
        || job.finishedAt < from
        || job.finishedAt >= now
      ) continue;
      const bucket = aiImageCostBucket({ model: job.model, delta: -job.creditCost });
      if (!bucket) continue;
      const label = dateLabel(job.finishedAt);
      const d = dailyImages.get(label) ?? emptyAiImageCounts();
      d[bucket]++;
      dailyImages.set(label, d);
    }
    for (const row of imageSpendRows) {
      const jobId = aiImageJobIdFromAction(row.action);
      const reservationKey = aiImageReservationKeyFromAction(row.action);
      if (
        (jobId && imageJobIds.has(jobId))
        || (reservationKey && imageReservationKeys.has(`${row.userId}\u0000${reservationKey}`))
      ) continue;
      const bucket = aiImageCostBucket({ delta: row.delta });
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
        variableCogs: cogs?.total ?? null,
        grossMarginPct: margins?.grossMarginPct ?? null,
        aiCostPct: margins?.aiCostPct ?? null,
        netProfit: margins?.netProfit ?? null,
        infraProrated: margins?.infraProrated ?? rates.infraMonthly,
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
        tts: knownNonImageCogs.tts,
        image: imageCogs,
        video: knownNonImageCogs.video,
        infra: rates.infraMonthly,
        infraProrated: rates.infraMonthly,
      },
      usage: {
        managedMinutes,
        images: imageCounts,
        imagesDelivered: imageUsage.deliveredImages,
        imagesAllowanceFunded: imageUsage.allowanceImages,
        imagesUnattributed: imageUsage.unattributedImages,
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
      imageCost: {
        windowDays: 30,
        windowStart: runpodImageCost?.windowStart ?? monthFrom.toISOString(),
        windowEnd: runpodImageCost?.windowEnd ?? now.toISOString(),
        ...imageCost,
      },
      runpodImageCost,
      trend,
    });
  } catch (error) {
    return apiError({ route: "GET /api/admin/costs", error });
  }
}
