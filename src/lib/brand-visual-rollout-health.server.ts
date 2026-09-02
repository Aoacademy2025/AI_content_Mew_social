import "server-only";

import { prisma } from "@/lib/prisma";
import { getRunpodImageCostSnapshot } from "@/lib/runpod-image-cost.server";
import {
  evaluateBrandVisualSafety,
  summarizeBrandVisualDailyCogs,
  type BrandVisualSafetyInputs,
} from "@/lib/brand-visual-safety";
import { evaluateBrandVisualFunnel } from "@/lib/brand-visual-funnel";
import { brandVisualRolloutFlags } from "@/lib/brand-visual-rollout.server";
import { STYLE_PACK_IDS, type StylePackId } from "@/lib/style-pack-catalog";

const THIRTY_MINUTES_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const SEVEN_DAYS_MS = 7 * DAY_MS;

type TelemetryProperties = Record<string, string | number | boolean | null>;

function properties(value: string | null): TelemetryProperties {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as TelemetryProperties
      : {};
  } catch {
    return {};
  }
}

function configuredDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function brandedJobInput(value: string | null): {
  videoJobId: string;
  visualFormatId: string | null;
  identityKey: string | null;
  lookIdentityKey: string | null;
  cohort: "internal" | "treatment-10" | "treatment-50" | "treatment-100" | null;
} | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const source = parsed.brandVisualSource;
    if (source !== "project-look" && source !== "brand-revision" && source !== "suggested") return null;
    if (typeof parsed.videoJobId !== "string" || !parsed.videoJobId) return null;
    const cohort = parsed.brandVisualCohort === "internal"
      || parsed.brandVisualCohort === "treatment-10"
      || parsed.brandVisualCohort === "treatment-50"
      || parsed.brandVisualCohort === "treatment-100"
      ? parsed.brandVisualCohort
      : null;
    return {
      videoJobId: parsed.videoJobId,
      visualFormatId: typeof parsed.visualFormatId === "string" ? parsed.visualFormatId : null,
      identityKey: typeof parsed.brandVisualIdentityKey === "string" ? parsed.brandVisualIdentityKey : null,
      lookIdentityKey: typeof parsed.brandLookIdentityKey === "string" ? parsed.brandLookIdentityKey : null,
      cohort,
    };
  } catch {
    return null;
  }
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export type StylePackAcceptanceSegment = {
  packId: StylePackId | "none";
  exported: number;
  rejected: number;
  acceptanceRate: number | null;
};

/** Task 9 (Telemetry): segment first-pass visual acceptance by the pinned
 *  Style Pack. Pure over the `packId` already carried on
 *  `first_pass_visual_exported` / `first_pass_visual_rejected` properties, so
 *  `getBrandVisualRolloutHealth` stays a thin telemetry query + this summary.
 *  A packId outside the current catalog (or `null` — no pack pinned for that
 *  clip) rolls up into `"none"`, never a fabricated per-pack row. A pack with
 *  no events at all is simply absent — never a zero-row nobody asked for. */
export function summarizeStylePackAcceptance(input: {
  exportedPackIds: Array<string | null>;
  rejectedPackIds: Array<string | null>;
}): StylePackAcceptanceSegment[] {
  const counts = new Map<StylePackId | "none", { exported: number; rejected: number }>();
  const normalizedPackId = (packId: string | null): StylePackId | "none" =>
    packId && (STYLE_PACK_IDS as readonly string[]).includes(packId) ? (packId as StylePackId) : "none";
  const bump = (packId: string | null, key: "exported" | "rejected") => {
    const id = normalizedPackId(packId);
    const current = counts.get(id) ?? { exported: 0, rejected: 0 };
    current[key] += 1;
    counts.set(id, current);
  };
  for (const packId of input.exportedPackIds) bump(packId, "exported");
  for (const packId of input.rejectedPackIds) bump(packId, "rejected");
  return [...counts.entries()]
    .map(([packId, { exported, rejected }]) => ({
      packId,
      exported,
      rejected,
      acceptanceRate: rate(exported, exported + rejected),
    }))
    .sort((left, right) => (right.exported + right.rejected) - (left.exported + left.rejected));
}

function percentile(values: number[], target: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((target / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export async function getBrandVisualFunnelHealth(input: { from: Date; now: Date }) {
  const step2Events = await prisma.telemetryEvent.findMany({
    where: {
      name: "editor_step2_reached",
      userId: { not: null },
      createdAt: { gte: input.from, lt: input.now },
    },
    orderBy: { createdAt: "asc" },
    select: { userId: true, properties: true, createdAt: true },
  });
  const configuredStageStart = configuredDate(process.env.BRAND_VISUAL_50_PERCENT_STARTED_AT);
  const inferredStageStart = step2Events.find((event) => properties(event.properties).cohort === "treatment-50")?.createdAt ?? null;
  const stageStart = configuredStageStart ?? inferredStageStart;
  const effectiveFrom = stageStart && stageStart > input.from ? stageStart : input.from;

  const enrollment = new Map<string, { cohort: "control" | "treatment-50"; reachedAt: Date }>();
  if (stageStart) {
    for (const event of step2Events) {
      if (!event.userId || event.createdAt < effectiveFrom || enrollment.has(event.userId)) continue;
      const detail = properties(event.properties);
      const bucket = typeof detail.bucket === "number" ? detail.bucket : null;
      if (detail.cohort === "treatment-50" && bucket !== null && bucket < 50) {
        enrollment.set(event.userId, { cohort: "treatment-50", reachedAt: event.createdAt });
      } else if (detail.cohort === "control" && bucket !== null && bucket >= 50) {
        enrollment.set(event.userId, { cohort: "control", reachedAt: event.createdAt });
      }
    }
  }

  const users = enrollment.size
    ? await prisma.user.findMany({
        where: { id: { in: [...enrollment.keys()] } },
        select: { id: true, createdAt: true },
      })
    : [];
  const eligibleUsers = users.filter((user) => {
    if (!configuredStageStart) return true;
    return user.createdAt >= configuredStageStart;
  });
  const userById = new Map(eligibleUsers.map((user) => [user.id, user]));
  const controlIds = eligibleUsers
    .filter((user) => enrollment.get(user.id)?.cohort === "control")
    .map((user) => user.id);
  const treatmentIds = eligibleUsers
    .filter((user) => enrollment.get(user.id)?.cohort === "treatment-50")
    .map((user) => user.id);
  const maturedControlIds = controlIds.filter((id) => userById.get(id)!.createdAt.getTime() + DAY_MS <= input.now.getTime());
  const maturedTreatmentIds = treatmentIds.filter((id) => userById.get(id)!.createdAt.getTime() + DAY_MS <= input.now.getTime());
  const maturedIds = [...maturedControlIds, ...maturedTreatmentIds];
  const firstRenderJobs = maturedIds.length
    ? await prisma.videoJob.findMany({
        where: {
          userId: { in: maturedIds },
          type: "create",
          status: "done",
          finishedAt: { not: null },
        },
        select: { userId: true, finishedAt: true },
        orderBy: { finishedAt: "asc" },
      })
    : [];
  const firstRenderSuccessIds = new Set<string>();
  const firstVideoSuccess = new Map<string, Date>();
  for (const job of firstRenderJobs) {
    const user = userById.get(job.userId);
    if (!user || !job.finishedAt) continue;
    const elapsed = job.finishedAt.getTime() - user.createdAt.getTime();
    if (elapsed < 0) continue;
    if (!firstVideoSuccess.has(job.userId)) firstVideoSuccess.set(job.userId, job.finishedAt);
    if (elapsed <= DAY_MS) firstRenderSuccessIds.add(job.userId);
  }

  const imageJobs = treatmentIds.length
    ? await prisma.aiGenerationJob.findMany({
        where: {
          userId: { in: treatmentIds },
          kind: "image",
          status: "completed",
          chargeState: "settled",
          outputUrl: { not: null },
          finishedAt: { gte: effectiveFrom, lt: input.now },
        },
        select: { userId: true, inputJson: true, finishedAt: true },
      })
    : [];
  const visualJobs = imageJobs.flatMap((job) => {
    const detail = brandedJobInput(job.inputJson);
    return detail ? [{ ...job, detail }] : [];
  });
  const videoJobIds = [...new Set(visualJobs.map((job) => job.detail.videoJobId))];
  const completedVideos = videoJobIds.length
    ? await prisma.videoJob.findMany({
        where: {
          id: { in: videoJobIds },
          userId: { in: treatmentIds },
          type: "create",
          status: "done",
          finishedAt: { not: null },
        },
        select: { id: true, userId: true, projectId: true, finishedAt: true },
        orderBy: { finishedAt: "asc" },
      })
    : [];
  const visualByVideo = new Map<string, (typeof visualJobs)[number]>();
  for (const job of visualJobs) {
    if (!visualByVideo.has(job.detail.videoJobId)) visualByVideo.set(job.detail.videoJobId, job);
  }
  const firstBrandVisualSuccess = new Map<string, {
    at: Date;
    projectId: string | null;
    identityKey: string | null;
    lookIdentityKey: string | null;
    visualFormatId: string | null;
  }>();
  for (const video of completedVideos) {
    if (!video.finishedAt || firstBrandVisualSuccess.has(video.userId)) continue;
    const visual = visualByVideo.get(video.id);
    if (!visual) continue;
    firstBrandVisualSuccess.set(video.userId, {
      at: video.finishedAt,
      projectId: video.projectId,
      identityKey: visual.detail.identityKey,
      lookIdentityKey: visual.detail.lookIdentityKey,
      visualFormatId: visual.detail.visualFormatId,
    });
  }
  const observedSuccesses = [...firstBrandVisualSuccess]
    .filter(([, success]) => success.at.getTime() + SEVEN_DAYS_MS <= input.now.getTime());
  const earliestSuccess = observedSuccesses.reduce<Date | null>(
    (earliest, [, success]) => !earliest || success.at < earliest ? success.at : earliest,
    null,
  );
  const reuseEvents = observedSuccesses.length && earliestSuccess
    ? await prisma.telemetryEvent.findMany({
        where: {
          userId: { in: observedSuccesses.map(([userId]) => userId) },
          name: { in: ["brand_profile_saved", "project_look_changed", "brand_profile_pinned"] },
          createdAt: { gte: earliestSuccess, lt: input.now },
        },
        select: { userId: true, name: true, properties: true, createdAt: true },
      })
    : [];
  const eventsByUser = new Map<string, typeof reuseEvents>();
  for (const event of reuseEvents) {
    if (!event.userId) continue;
    const current = eventsByUser.get(event.userId) ?? [];
    current.push(event);
    eventsByUser.set(event.userId, current);
  }
  let qualifiedWithin7dUsers = 0;
  for (const [userId, success] of observedSuccesses) {
    const qualified = (eventsByUser.get(userId) ?? []).some((event) => {
      const elapsed = event.createdAt.getTime() - success.at.getTime();
      if (elapsed < 0 || elapsed > SEVEN_DAYS_MS) return false;
      const detail = properties(event.properties);
      const sameLook = success.lookIdentityKey && typeof detail.brandLookIdentityKey === "string"
        ? detail.brandLookIdentityKey === success.lookIdentityKey
        : success.identityKey && typeof detail.brandVisualIdentityKey === "string"
          ? detail.brandVisualIdentityKey === success.identityKey
        : success.visualFormatId && typeof detail.visualFormatId === "string"
          ? detail.visualFormatId === success.visualFormatId
          : false;
      if (!sameLook) return false;
      if (event.name === "brand_profile_saved") return true;
      return typeof detail.projectId === "string"
        && detail.projectId !== success.projectId;
    });
    if (qualified) qualifiedWithin7dUsers += 1;
  }

  const observedControlSuccesses = controlIds.flatMap((userId) => {
    const at = firstVideoSuccess.get(userId);
    return at && at.getTime() + SEVEN_DAYS_MS <= input.now.getTime()
      ? [{ userId, at }]
      : [];
  });
  const observedTreatmentSuccesses = observedSuccesses.map(([userId, success]) => ({
    userId,
    at: success.at,
  }));
  const paidObservationIds = [
    ...observedControlSuccesses.map(({ userId }) => userId),
    ...observedTreatmentSuccesses.map(({ userId }) => userId),
  ];
  const paidPayments = paidObservationIds.length
    ? await prisma.payment.findMany({
        where: {
          userId: { in: paidObservationIds },
          status: "PAID",
          periodDays: { gt: 0 },
          paidAt: { not: null, lt: input.now },
        },
        select: { userId: true, paidAt: true },
      })
    : [];
  const paidByUser = new Map<string, Date[]>();
  for (const payment of paidPayments) {
    if (!payment.paidAt) continue;
    const current = paidByUser.get(payment.userId) ?? [];
    current.push(payment.paidAt);
    paidByUser.set(payment.userId, current);
  }
  const convertedWithin7d = (rows: Array<{ userId: string; at: Date }>) => rows.filter((row) =>
    (paidByUser.get(row.userId) ?? []).some((paidAt) => {
      const elapsed = paidAt.getTime() - row.at.getTime();
      return elapsed >= 0 && elapsed <= SEVEN_DAYS_MS;
    })).length;
  const controlPaidConversions = convertedWithin7d(observedControlSuccesses);
  const treatmentPaidConversions = convertedWithin7d(observedTreatmentSuccesses);
  const controlPaidRate = rate(controlPaidConversions, observedControlSuccesses.length);
  const treatmentPaidRate = rate(treatmentPaidConversions, observedTreatmentSuccesses.length);

  const evaluation = evaluateBrandVisualFunnel({
    controlStep2Users: controlIds.length,
    treatmentStep2Users: treatmentIds.length,
    controlObserved24hUsers: maturedControlIds.length,
    treatmentObserved24hUsers: maturedTreatmentIds.length,
    controlFirstRenderWithin24hUsers: maturedControlIds.filter((id) => firstRenderSuccessIds.has(id)).length,
    treatmentFirstRenderWithin24hUsers: maturedTreatmentIds.filter((id) => firstRenderSuccessIds.has(id)).length,
    treatmentBrandVisualSuccessUsersObserved7d: observedSuccesses.length,
    treatmentQualifiedWithin7dUsers: qualifiedWithin7dUsers,
  });
  return {
    measurementWindow: {
      configured: Boolean(configuredStageStart),
      configuredAt: configuredStageStart?.toISOString() ?? null,
      inferredAt: inferredStageStart?.toISOString() ?? null,
      effectiveFrom: effectiveFrom.toISOString(),
      note: configuredStageStart
        ? null
        : "Set BRAND_VISUAL_50_PERCENT_STARTED_AT before using this funnel to authorize 100% rollout.",
    },
    paidConversion7d: {
      observationalOnly: true as const,
      control: {
        observedUsers: observedControlSuccesses.length,
        convertedUsers: controlPaidConversions,
        rate: controlPaidRate,
      },
      treatment: {
        observedUsers: observedTreatmentSuccesses.length,
        convertedUsers: treatmentPaidConversions,
        rate: treatmentPaidRate,
      },
      treatmentVsControlPercentagePointDelta: controlPaidRate !== null && treatmentPaidRate !== null
        ? (treatmentPaidRate - controlPaidRate) * 100
        : null,
    },
    ...evaluation,
  };
}

export async function getBrandVisualRolloutHealth(input: {
  now?: Date;
  days?: number;
} = {}) {
  const now = input.now ?? new Date();
  const days = Math.max(1, Math.min(90, Math.floor(input.days ?? 30)));
  const rollout = brandVisualRolloutFlags();
  const requestedFrom = new Date(now.getTime() - days * DAY_MS);
  const from = rollout.startedAt && rollout.startedAt > requestedFrom
    ? rollout.startedAt
    : requestedFrom;
  const safetyCohort = rollout.percent === 10
    ? "treatment-10" as const
    : rollout.percent === 50
      ? "treatment-50" as const
      : rollout.percent === 100
        ? "treatment-100" as const
        : null;
  const staleBefore = new Date(now.getTime() - THIRTY_MINUTES_MS);
  const brandedCandidates = (await prisma.aiGenerationJob.findMany({
    where: { kind: "image", provider: "runpod", createdAt: { gte: from, lt: now } },
    select: {
      id: true,
      userId: true,
      status: true,
      chargeState: true,
      fundingSource: true,
      outputUrl: true,
      inputJson: true,
      createdAt: true,
      updatedAt: true,
      finishedAt: true,
      providerEndpoint: true,
    },
  })).flatMap((job) => {
    const detail = brandedJobInput(job.inputJson);
    return detail ? [{ ...job, detail }] : [];
  });
  // The 100-image safety sample belongs to the stable public treatment cohort
  // for the CURRENT rollout stage. Internal/ducky/test jobs and historical
  // stage labels remain observable but can never authorize expansion.
  const jobs = safetyCohort
    ? brandedCandidates.filter((job) => job.detail.cohort === safetyCohort)
    : [];

  const terminal = jobs.filter((job) =>
    job.status === "completed" || job.status === "failed" || job.status === "canceled");
  const usable = terminal.filter((job) =>
    job.status === "completed" && job.chargeState === "settled" && Boolean(job.outputUrl));
  const failed = terminal.filter((job) => job.status === "failed" || job.status === "canceled");
  const restored = failed.filter((job) =>
    job.chargeState === "refunded" || job.chargeState === "none");
  const staleReservations = jobs.filter((job) =>
    job.chargeState === "reserved" && job.updatedAt < staleBefore).length;
  const terminalDurations = terminal.flatMap((job) => {
    if (!job.finishedAt) return [];
    const durationMs = job.finishedAt.getTime() - job.createdAt.getTime();
    return Number.isFinite(durationMs) && durationMs >= 0 ? [durationMs] : [];
  });

  const creditSpendActions = jobs
    .filter((job) => job.fundingSource === "credits")
    .map((job) => `ai-image:${job.id}`);
  const [negativeCreditBalances, allowanceRows, spendLedgerRows] = await Promise.all([
    prisma.creditBalance.count({
      where: { OR: [{ granted: { lt: 0 } }, { purchased: { lt: 0 } }] },
    }),
    prisma.starterAiImageAllowance.findMany({
      select: { limitImages: true, reservedImages: true, usedImages: true },
    }),
    creditSpendActions.length
      ? prisma.creditLedger.findMany({
          where: {
            kind: "spend",
            action: { in: creditSpendActions },
            createdAt: { gte: from, lt: now },
          },
          select: { userId: true, action: true },
        })
      : Promise.resolve([]),
  ]);
  const invalidAllowances = allowanceRows.filter((row) =>
    row.limitImages !== 8
    || row.reservedImages < 0
    || row.usedImages < 0
    || row.reservedImages + row.usedImages > row.limitImages).length;
  const spendCounts = new Map<string, number>();
  for (const row of spendLedgerRows) {
    if (!row.action) continue;
    const key = `${row.userId}:${row.action}`;
    spendCounts.set(key, (spendCounts.get(key) ?? 0) + 1);
  }
  const duplicateDeductions = [...spendCounts.values()]
    .reduce((total, count) => total + Math.max(0, count - 1), 0);

  const endpointId = jobs.find((job) => job.providerEndpoint)?.providerEndpoint ?? undefined;
  const costSnapshot = await getRunpodImageCostSnapshot({ endpointId, now, windowDays: days })
    .catch(() => null);
  let highestDailyCogsBahtPerImage: number | null = null;
  let unattributedCostDays: string[] = [];
  if (costSnapshot) {
    const [buckets, delivered] = await Promise.all([
      prisma.runpodBillingBucket.findMany({
        where: {
          endpointId: costSnapshot.endpointId,
          bucketStart: { gte: from, lt: now },
        },
        select: { bucketStart: true, amountUsdMicros: true },
      }),
      prisma.aiGenerationJob.findMany({
        where: {
          kind: "image",
          provider: "runpod",
          providerEndpoint: costSnapshot.endpointId,
          status: "completed",
          chargeState: "settled",
          finishedAt: { gte: from, lt: now },
        },
        select: { finishedAt: true },
      }),
    ]);
    const costsByDay = new Map<string, number>();
    const imagesByDay = new Map<string, number>();
    for (const bucket of buckets) {
      const key = dayKey(bucket.bucketStart);
      costsByDay.set(key, (costsByDay.get(key) ?? 0) + bucket.amountUsdMicros);
    }
    for (const job of delivered) {
      if (!job.finishedAt) continue;
      const key = dayKey(job.finishedAt);
      imagesByDay.set(key, (imagesByDay.get(key) ?? 0) + 1);
    }
    const daily = summarizeBrandVisualDailyCogs({
      costsByDay,
      imagesByDay,
      usdThbRate: costSnapshot.usdThbRate,
    });
    highestDailyCogsBahtPerImage = daily.highestDailyCogsBahtPerImage;
    unattributedCostDays = daily.unattributedCostDays;
  }

  const inputs: BrandVisualSafetyInputs = {
    terminalJobs: terminal.length,
    usableJobs: usable.length,
    failedJobs: failed.length,
    correctlyRestoredFailedJobs: restored.length,
    staleReservations,
    duplicateDeductions,
    negativeCreditBalances,
    invalidAllowances,
    cogsDataAdmitted: costSnapshot?.admitted === true && costSnapshot.status !== "stale",
    averageCogsBahtPerImage: costSnapshot?.costBahtPerImage ?? null,
    highestDailyCogsBahtPerImage,
  };
  const safety = evaluateBrandVisualSafety(inputs);
  const rerollEvents = safetyCohort
    ? await prisma.telemetryEvent.findMany({
        where: {
          name: "brand_look_scene_rerolled",
          createdAt: { gte: from, lt: now },
        },
        select: { properties: true },
      })
    : [];
  const rerollCount = rerollEvents.filter((event) =>
    properties(event.properties).cohort === safetyCohort).length;
  const activatedUsers = new Set(usable.map((job) => job.userId)).size;
  const estimatedCogsBahtPerActivatedUser = costSnapshot?.costBahtPerImage !== null
    && costSnapshot?.costBahtPerImage !== undefined
    && activatedUsers > 0
    ? costSnapshot.costBahtPerImage * usable.length / activatedUsers
    : null;
  const funnel = await getBrandVisualFunnelHealth({ from, now });
  // Task 9 (Telemetry): first-pass acceptance segmented by Style Pack. Not
  // cohort-scoped like the canary jobs above — these events fire for every
  // Brand Visual customer, not only the RunPod image safety sample.
  const acceptanceEvents = await prisma.telemetryEvent.findMany({
    where: {
      name: { in: ["first_pass_visual_exported", "first_pass_visual_rejected"] },
      createdAt: { gte: from, lt: now },
    },
    select: { name: true, properties: true },
  });
  const packIdOf = (event: (typeof acceptanceEvents)[number]): string | null => {
    const value = properties(event.properties).packId;
    return typeof value === "string" ? value : null;
  };
  const byStylePack = summarizeStylePackAcceptance({
    exportedPackIds: acceptanceEvents
      .filter((event) => event.name === "first_pass_visual_exported")
      .map(packIdOf),
    rejectedPackIds: acceptanceEvents
      .filter((event) => event.name === "first_pass_visual_rejected")
      .map(packIdOf),
  });
  return {
    window: { from: from.toISOString(), to: now.toISOString(), days },
    canary: {
      cohort: safetyCohort,
      candidateBrandedJobs: brandedCandidates.length,
      excludedInternalJobs: brandedCandidates.filter((job) => job.detail.cohort === "internal").length,
      excludedOtherCohortJobs: brandedCandidates.filter((job) =>
        job.detail.cohort !== "internal" && job.detail.cohort !== safetyCohort).length,
    },
    jobs: {
      accepted: jobs.length,
      terminal: terminal.length,
      usable: usable.length,
      failed: failed.length,
      restored: restored.length,
      inFlight: jobs.length - terminal.length,
    },
    latency: {
      sampleJobs: terminalDurations.length,
      p50Ms: percentile(terminalDurations, 50),
      p95Ms: percentile(terminalDurations, 95),
      blocksCanary: false,
    },
    settlement: {
      staleReservations,
      duplicateDeductions,
      negativeCreditBalances,
      invalidAllowances,
    },
    leadingMetrics: {
      rerolls: rerollCount,
      rerollsPerUsableImage: rate(rerollCount, usable.length),
      activatedUsers,
      estimatedRunpodCogsBahtPerActivatedUser: estimatedCogsBahtPerActivatedUser,
    },
    cogs: costSnapshot ? {
      averageBahtPerImage: costSnapshot.costBahtPerImage,
      highestDailyBahtPerImage: highestDailyCogsBahtPerImage,
      unattributedCostDays,
      deliveredImages: costSnapshot.deliveredImages,
      lastSuccessfulSyncAt: costSnapshot.lastSuccessfulSyncAt,
      status: costSnapshot.status,
    } : null,
    safety,
    funnel,
    acceptance: { byStylePack },
    rollout: {
      percent: rollout.percent,
      canExpandFrom10To50: rollout.percent === 10 && safety.canExpand,
      canExpandFrom50To100: rollout.percent === 50
        && safety.canExpand
        && funnel.measurementWindow.configured
        && funnel.canExpandTo100,
    },
  };
}
