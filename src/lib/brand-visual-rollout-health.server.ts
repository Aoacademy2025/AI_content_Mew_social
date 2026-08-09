import "server-only";

import { prisma } from "@/lib/prisma";
import { getRunpodImageCostSnapshot } from "@/lib/runpod-image-cost.server";
import {
  evaluateBrandVisualSafety,
  type BrandVisualSafetyInputs,
} from "@/lib/brand-visual-safety";
import { evaluateBrandVisualFunnel } from "@/lib/brand-visual-funnel";
import { brandVisualRolloutFlags } from "@/lib/brand-visual-rollout.server";

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
} | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const source = parsed.brandVisualSource;
    if (source !== "project-look" && source !== "brand-revision" && source !== "suggested") return null;
    if (typeof parsed.videoJobId !== "string" || !parsed.videoJobId) return null;
    return {
      videoJobId: parsed.videoJobId,
      visualFormatId: typeof parsed.visualFormatId === "string" ? parsed.visualFormatId : null,
      identityKey: typeof parsed.brandVisualIdentityKey === "string" ? parsed.brandVisualIdentityKey : null,
    };
  } catch {
    return null;
  }
}

function isBrandedInput(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value) as { brandVisualSource?: unknown };
    return parsed.brandVisualSource === "project-look"
      || parsed.brandVisualSource === "brand-revision"
      || parsed.brandVisualSource === "suggested";
  } catch {
    return false;
  }
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
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
      })
    : [];
  const firstRenderSuccessIds = new Set<string>();
  for (const job of firstRenderJobs) {
    const user = userById.get(job.userId);
    if (!user || !job.finishedAt) continue;
    const elapsed = job.finishedAt.getTime() - user.createdAt.getTime();
    if (elapsed >= 0 && elapsed <= DAY_MS) firstRenderSuccessIds.add(job.userId);
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
      const sameLook = success.identityKey && typeof detail.brandVisualIdentityKey === "string"
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
    ...evaluation,
  };
}

export async function getBrandVisualRolloutHealth(input: {
  now?: Date;
  days?: number;
} = {}) {
  const now = input.now ?? new Date();
  const days = Math.max(1, Math.min(90, Math.floor(input.days ?? 30)));
  const from = new Date(now.getTime() - days * DAY_MS);
  const staleBefore = new Date(now.getTime() - THIRTY_MINUTES_MS);
  const jobs = (await prisma.aiGenerationJob.findMany({
    where: { kind: "image", provider: "runpod", createdAt: { gte: from, lt: now } },
    select: {
      id: true,
      status: true,
      chargeState: true,
      fundingSource: true,
      outputUrl: true,
      inputJson: true,
      updatedAt: true,
      finishedAt: true,
      providerEndpoint: true,
    },
  })).filter((job) => isBrandedInput(job.inputJson));

  const terminal = jobs.filter((job) =>
    job.status === "completed" || job.status === "failed" || job.status === "canceled");
  const usable = terminal.filter((job) =>
    job.status === "completed" && job.chargeState === "settled" && Boolean(job.outputUrl));
  const failed = terminal.filter((job) => job.status === "failed" || job.status === "canceled");
  const restored = failed.filter((job) =>
    job.chargeState === "refunded" || job.chargeState === "none");
  const staleReservations = jobs.filter((job) =>
    job.chargeState === "reserved" && job.updatedAt < staleBefore).length;

  const [negativeCreditBalances, allowanceRows] = await Promise.all([
    prisma.creditBalance.count({
      where: { OR: [{ granted: { lt: 0 } }, { purchased: { lt: 0 } }] },
    }),
    prisma.starterAiImageAllowance.findMany({
      select: { limitImages: true, reservedImages: true, usedImages: true },
    }),
  ]);
  const invalidAllowances = allowanceRows.filter((row) =>
    row.limitImages !== 8
    || row.reservedImages < 0
    || row.usedImages < 0
    || row.reservedImages + row.usedImages > row.limitImages).length;

  const endpointId = jobs.find((job) => job.providerEndpoint)?.providerEndpoint ?? undefined;
  const costSnapshot = await getRunpodImageCostSnapshot({ endpointId, now, windowDays: days })
    .catch(() => null);
  let highestDailyCogsBahtPerImage: number | null = null;
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
    const dailyCosts = [...costsByDay].flatMap(([key, usdMicros]) => {
      const images = imagesByDay.get(key) ?? 0;
      return images > 0
        ? [(usdMicros / 1_000_000) * costSnapshot.usdThbRate / images]
        : [];
    });
    highestDailyCogsBahtPerImage = dailyCosts.length ? Math.max(...dailyCosts) : null;
  }

  const inputs: BrandVisualSafetyInputs = {
    terminalJobs: terminal.length,
    usableJobs: usable.length,
    failedJobs: failed.length,
    correctlyRestoredFailedJobs: restored.length,
    staleReservations,
    negativeCreditBalances,
    invalidAllowances,
    averageCogsBahtPerImage: costSnapshot?.costBahtPerImage ?? null,
    highestDailyCogsBahtPerImage,
  };
  const safety = evaluateBrandVisualSafety(inputs);
  const funnel = await getBrandVisualFunnelHealth({ from, now });
  const rollout = brandVisualRolloutFlags();
  return {
    window: { from: from.toISOString(), to: now.toISOString(), days },
    jobs: {
      accepted: jobs.length,
      terminal: terminal.length,
      usable: usable.length,
      failed: failed.length,
      restored: restored.length,
      inFlight: jobs.length - terminal.length,
    },
    settlement: {
      staleReservations,
      negativeCreditBalances,
      invalidAllowances,
    },
    cogs: costSnapshot ? {
      averageBahtPerImage: costSnapshot.costBahtPerImage,
      highestDailyBahtPerImage: highestDailyCogsBahtPerImage,
      deliveredImages: costSnapshot.deliveredImages,
      lastSuccessfulSyncAt: costSnapshot.lastSuccessfulSyncAt,
      status: costSnapshot.status,
    } : null,
    safety,
    funnel,
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
