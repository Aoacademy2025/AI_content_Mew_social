import "server-only";

import type { AiGenerationAttempt, AiGenerationJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  heroVoiceResultFromJob,
  type HeroVoiceGenerationResult,
} from "@/lib/hero-voice-generation.server";

export type PublicAiGenerationJob = {
  id: string;
  kind: string;
  provider: string;
  model: string;
  providerModel: string | null;
  providerRoute: string | null;
  quoteVersion: string | null;
  status: string;
  inputPreview: string | null;
  inputText: string | null;
  input: Record<string, unknown> | null;
  voiceResult: HeroVoiceGenerationResult | null;
  outputUrl: string | null;
  creditCost: number;
  chargeState: string;
  errorCode: string | null;
  errorMessage: string | null;
  delayTimeMs: number | null;
  executionTimeMs: number | null;
  createdAt: string;
  finishedAt: string | null;
  mediaExpiresAt: string | null;
};

function parseInput(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function extractInputText(job: AiGenerationJob): string | null {
  const parsed = parseInput(job.inputJson);
  if (parsed) {
    if (typeof parsed.prompt === "string" && parsed.prompt.trim()) return parsed.prompt;
    if (typeof parsed.script === "string" && parsed.script.trim()) return parsed.script;
    if (Array.isArray(parsed.chunks)) {
      const text = parsed.chunks
        .map((chunk) => {
          if (!chunk || typeof chunk !== "object") return "";
          const chunkText = (chunk as Record<string, unknown>).text;
          return typeof chunkText === "string" ? chunkText : "";
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) return text;
    }
  }
  return job.inputPreview;
}

export function publicAiGenerationJob(job: AiGenerationJob): PublicAiGenerationJob {
  const input = job.kind === "voice"
    ? { voiceId: job.model, backend: job.provider }
    : parseInput(job.inputJson);
  return {
    id: job.id,
    kind: job.kind,
    provider: job.provider,
    model: job.model,
    providerModel: job.providerModel,
    providerRoute: job.providerRoute,
    quoteVersion: job.quoteVersion,
    status: job.status,
    inputPreview: job.inputPreview,
    inputText: extractInputText(job),
    input,
    voiceResult: heroVoiceResultFromJob(job),
    outputUrl: job.outputUrl,
    creditCost: job.creditCost,
    chargeState: job.chargeState,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    delayTimeMs: job.delayTimeMs,
    executionTimeMs: job.executionTimeMs,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    mediaExpiresAt: job.mediaExpiresAt?.toISOString() ?? null,
  };
}

export async function createReservedImageJob(input: {
  userId: string;
  model: string;
  inputPreview: string;
  inputJson: string;
  creditCost: number;
  quoteVersion: string;
  costBudgetUsdMicros: number;
  provider: string;
  providerModel: string;
  providerRoute: string;
  providerEndpoint: string;
  estimatedCostUsdMicros: number;
  idempotencyKey: string;
  mediaExpiresAt: Date;
}): Promise<
  | { ok: true; created: boolean; job: AiGenerationJob; balanceAfter: number }
  | { ok: false; reason: "insufficient"; balanceAfter: number }
> {
  if (input.estimatedCostUsdMicros > input.costBudgetUsdMicros) {
    throw new Error("Image provider route exceeds the quoted COGS budget");
  }
  return prisma.$transaction(async (tx) => {
    const existing = await tx.aiGenerationJob.findFirst({
      where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      const balance = await tx.creditBalance.findUnique({ where: { userId: input.userId } });
      return { ok: true, created: false, job: existing, balanceAfter: (balance?.granted ?? 0) + (balance?.purchased ?? 0) };
    }

    const balance = await tx.creditBalance.upsert({
      where: { userId: input.userId },
      create: { userId: input.userId, granted: 0, purchased: 0 },
      update: {},
    });
    const total = balance.granted + balance.purchased;
    if (total < input.creditCost) return { ok: false as const, reason: "insufficient" as const, balanceAfter: total };

    const fromGranted = Math.min(balance.granted, input.creditCost);
    const fromPurchased = input.creditCost - fromGranted;
    const debited = await tx.creditBalance.updateMany({
      where: {
        userId: input.userId,
        granted: { gte: fromGranted },
        purchased: { gte: fromPurchased },
      },
      data: {
        granted: { decrement: fromGranted },
        purchased: { decrement: fromPurchased },
      },
    });
    if (debited.count !== 1) return { ok: false as const, reason: "insufficient" as const, balanceAfter: total };

    const job = await tx.aiGenerationJob.create({
      data: {
        userId: input.userId,
        kind: "image",
        provider: input.provider,
        model: input.model,
        providerModel: input.providerModel,
        providerRoute: input.providerRoute,
        providerEndpoint: input.providerEndpoint,
        quoteVersion: input.quoteVersion,
        costBudgetUsdMicros: input.costBudgetUsdMicros,
        estimatedCostUsdMicros: input.estimatedCostUsdMicros,
        status: "queued",
        inputPreview: input.inputPreview,
        inputJson: input.inputJson,
        creditCost: input.creditCost,
        creditsFromGranted: fromGranted,
        creditsFromPurchased: fromPurchased,
        chargeState: "reserved",
        idempotencyKey: input.idempotencyKey,
        mediaExpiresAt: input.mediaExpiresAt,
        attempts: {
          create: {
            sequence: 1,
            provider: input.provider,
            providerModel: input.providerModel,
            providerRoute: input.providerRoute,
            providerEndpoint: input.providerEndpoint,
            estimatedCostUsdMicros: input.estimatedCostUsdMicros,
          },
        },
      },
    });
    const balanceAfter = total - input.creditCost;
    await tx.creditLedger.create({
      data: {
        userId: input.userId,
        delta: -input.creditCost,
        kind: "spend",
        action: `ai-image:${job.id}`,
        balanceAfter,
      },
    });
    return { ok: true as const, created: true, job, balanceAfter };
  });
}

export async function latestImageGenerationAttempt(
  userId: string,
  jobId: string,
): Promise<AiGenerationAttempt | null> {
  return prisma.aiGenerationAttempt.findFirst({
    where: { jobId, job: { userId } },
    orderBy: { sequence: "desc" },
  });
}

export async function markImageAttemptSubmitted(input: {
  userId: string;
  jobId: string;
  providerJobId: string;
  inProgress: boolean;
}): Promise<AiGenerationJob | null> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.aiGenerationJob.findFirst({ where: { id: input.jobId, userId: input.userId } });
    if (!job) return null;
    const now = new Date();
    await tx.aiGenerationAttempt.updateMany({
      where: { jobId: job.id, sequence: 1, status: "planned" },
      data: {
        providerJobId: input.providerJobId,
        status: input.inProgress ? "in_progress" : "queued",
        submittedAt: now,
      },
    });
    return tx.aiGenerationJob.update({
      where: { id: job.id },
      data: {
        providerJobId: input.providerJobId,
        status: input.inProgress ? "in_progress" : "queued",
        startedAt: input.inProgress ? (job.startedAt ?? now) : job.startedAt,
      },
    });
  });
}

export async function markImageAttemptProgress(input: {
  userId: string;
  jobId: string;
  inProgress: boolean;
  delayTimeMs?: number;
}): Promise<AiGenerationJob | null> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.aiGenerationJob.findFirst({ where: { id: input.jobId, userId: input.userId } });
    if (!job) return null;
    const now = new Date();
    await tx.aiGenerationAttempt.updateMany({
      where: { jobId: job.id, sequence: 1, status: { in: ["submitted", "queued", "in_progress"] } },
      data: { status: input.inProgress ? "in_progress" : "queued" },
    });
    return tx.aiGenerationJob.update({
      where: { id: job.id },
      data: {
        status: input.inProgress ? "in_progress" : "queued",
        startedAt: input.inProgress ? (job.startedAt ?? now) : job.startedAt,
        delayTimeMs: input.delayTimeMs ?? job.delayTimeMs,
      },
    });
  });
}

export async function failAndRefundAiJob(
  userId: string,
  jobId: string,
  errorCode: string,
  errorMessage: string,
): Promise<AiGenerationJob | null> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.aiGenerationJob.findFirst({ where: { id: jobId, userId } });
    if (!job) return null;
    if (job.status === "completed" || job.chargeState === "settled") return job;

    await tx.aiGenerationAttempt.updateMany({
      where: { jobId: job.id, status: { in: ["planned", "submitted", "queued", "in_progress"] } },
      data: {
        status: "failed",
        errorCode,
        errorMessage: errorMessage.slice(0, 500),
        finishedAt: new Date(),
      },
    });

    let chargeState = job.chargeState;
    if (job.chargeState === "reserved") {
      const restored = await tx.creditBalance.upsert({
        where: { userId },
        create: {
          userId,
          granted: job.creditsFromGranted,
          purchased: job.creditsFromPurchased,
        },
        update: {
          granted: { increment: job.creditsFromGranted },
          purchased: { increment: job.creditsFromPurchased },
        },
      });
      await tx.creditLedger.create({
        data: {
          userId,
          delta: job.creditCost,
          kind: "refund",
          action: `ai-image-refund:${job.id}`,
          balanceAfter: restored.granted + restored.purchased,
        },
      });
      chargeState = "refunded";
    }

    return tx.aiGenerationJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        chargeState,
        errorCode,
        errorMessage: errorMessage.slice(0, 500),
        finishedAt: new Date(),
      },
    });
  });
}

export async function completeImageJob(input: {
  userId: string;
  jobId: string;
  outputUrl: string;
  delayTimeMs?: number;
  executionTimeMs?: number;
  providerReportedCostUsdMicros?: number;
  providerReportedCredits?: number;
  sceneTitle?: string;
}): Promise<AiGenerationJob | null> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.aiGenerationJob.findFirst({ where: { id: input.jobId, userId: input.userId } });
    if (!job) return null;
    if (job.status === "completed") return job;
    if (job.status === "failed" || job.chargeState === "refunded") return job;

    const image = await tx.generatedImage.create({
      data: {
        userId: input.userId,
        prompt: job.inputPreview ?? "AI artwork",
        url: input.outputUrl,
        imageModel: job.model,
        sceneTitle: input.sceneTitle?.slice(0, 180) || "AI Studio",
      },
    });
    await tx.aiGenerationAttempt.updateMany({
      where: { jobId: job.id, status: { in: ["submitted", "queued", "in_progress"] } },
      data: {
        status: "completed",
        providerReportedCostUsdMicros: input.providerReportedCostUsdMicros,
        providerReportedCredits: input.providerReportedCredits,
        finishedAt: new Date(),
      },
    });
    return tx.aiGenerationJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        chargeState: job.chargeState === "reserved" ? "settled" : job.chargeState,
        outputUrl: input.outputUrl,
        generatedImageId: image.id,
        delayTimeMs: input.delayTimeMs,
        executionTimeMs: input.executionTimeMs,
        providerReportedCostUsdMicros: input.providerReportedCostUsdMicros,
        providerReportedCredits: input.providerReportedCredits,
        finishedAt: new Date(),
      },
    });
  });
}
