import "server-only";

import type { AiGenerationJob, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type ReusableProjectVisualAsset = {
  beatId: string;
  sceneIndex: number;
  outputUrl: string;
  imageJobId: string;
};

function refundableVideoParentId(idempotencyKey: string | null): string | null {
  return idempotencyKey?.match(/^video:([^:]+):/)?.[1] ?? null;
}

/** A settled child from a live VideoJob is still refundable if that video
 * fails. It becomes a durable reuse source only after the parent is `done`.
 * Explicit non-video namespaces (for example a delivered scene reroll) settle
 * independently and are durable as soon as their image job settles. */
export async function durablyReusableImageJobOutputs(input: {
  userId: string;
  jobIds: readonly string[];
}): Promise<Map<string, string>> {
  const uniqueJobIds = [...new Set(input.jobIds.filter(Boolean))];
  if (uniqueJobIds.length === 0) return new Map();
  const jobs = await prisma.aiGenerationJob.findMany({
    where: {
      userId: input.userId,
      id: { in: uniqueJobIds },
      status: "completed",
      chargeState: "settled",
      outputUrl: { not: null },
    },
    select: { id: true, outputUrl: true, idempotencyKey: true },
  });
  const videoParentIds = [...new Set(jobs.flatMap((job) => {
    const parentId = refundableVideoParentId(job.idempotencyKey);
    return parentId ? [parentId] : [];
  }))];
  const completedParents = videoParentIds.length > 0
    ? await prisma.videoJob.findMany({
        where: { id: { in: videoParentIds }, userId: input.userId, status: "done" },
        select: { id: true },
      })
    : [];
  const completedParentIds = new Set(completedParents.map((parent) => parent.id));
  return new Map(jobs.flatMap((job) => {
    const parentId = refundableVideoParentId(job.idempotencyKey);
    if (parentId && !completedParentIds.has(parentId)) return [];
    return job.outputUrl ? [[job.id, job.outputUrl] as const] : [];
  }));
}

/** One authoritative reuse resolver for quote, render and preview surfaces.
 * A beat URL is reusable only while its policy is current and its exact linked
 * image job is completed, settled and points at the same durable output. */
export async function reusableProjectVisualAssets(input: {
  userId: string;
  projectId: string;
  preflightId: string;
}): Promise<ReusableProjectVisualAsset[]> {
  const beats = await prisma.projectVisualBeat.findMany({
    where: {
      userId: input.userId,
      projectId: input.projectId,
      preflightId: input.preflightId,
      status: "current",
      existingAssetUrl: { not: null },
      existingImageJobId: { not: null },
    },
    select: {
      id: true,
      sequence: true,
      existingAssetUrl: true,
      existingImageJobId: true,
    },
    orderBy: { sequence: "asc" },
  });
  const jobIds = beats.flatMap((beat) => beat.existingImageJobId ? [beat.existingImageJobId] : []);
  if (jobIds.length === 0) return [];
  const outputByJobId = await durablyReusableImageJobOutputs({
    userId: input.userId,
    jobIds,
  });
  return beats.flatMap((beat) => (
    beat.existingAssetUrl
    && beat.existingImageJobId
    && outputByJobId.get(beat.existingImageJobId) === beat.existingAssetUrl
      ? [{
          beatId: beat.id,
          sceneIndex: beat.sequence,
          outputUrl: beat.existingAssetUrl,
          imageJobId: beat.existingImageJobId,
        }]
      : []
  ));
}

export function visualBeatLinkFromImageJob(job: Pick<AiGenerationJob, "inputJson">): {
  beatId: string;
  identityKey: string;
} | null {
  if (!job.inputJson) return null;
  try {
    const value = JSON.parse(job.inputJson) as Record<string, unknown>;
    const beatId = typeof value.visualBeatId === "string" ? value.visualBeatId.trim() : "";
    const identityKey = typeof value.brandVisualIdentityKey === "string"
      ? value.brandVisualIdentityKey.trim()
      : "";
    return beatId && identityKey ? { beatId, identityKey } : null;
  } catch {
    return null;
  }
}

/** Link a settled output only if its immutable identity still owns generation
 * for this beat. A late old job returns false after another tab changes the
 * selected Look; it may finish its own VideoJob but cannot become reusable. */
export async function linkVisualBeatAssetInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    beatId: string;
    outputUrl: string;
    imageJobId: string;
    identityKey: string;
  },
): Promise<boolean> {
  const linked = await tx.projectVisualBeat.updateMany({
    where: {
      id: input.beatId,
      userId: input.userId,
      OR: [
        { generationIdentityKey: input.identityKey },
        { generationIdentityKey: null },
      ],
    },
    data: {
      generationIdentityKey: input.identityKey,
      existingAssetUrl: input.outputUrl,
      existingImageJobId: input.imageJobId,
      status: "current",
      outdatedAt: null,
    },
  });
  return linked.count === 1;
}

export async function linkCompletedVisualBeatAsset(input: {
  userId: string;
  beatId: string;
  outputUrl: string;
  imageJobId: string;
  identityKey: string;
}): Promise<{ linked: boolean }> {
  const outputUrl = input.outputUrl.trim();
  const identityKey = input.identityKey.trim();
  if (!outputUrl || !identityKey) throw new Error("Visual Beat asset identity is incomplete");
  return prisma.$transaction(async (tx) => {
    const job = await tx.aiGenerationJob.findFirst({
      where: {
        id: input.imageJobId,
        userId: input.userId,
        kind: "image",
        status: "completed",
        chargeState: "settled",
        outputUrl,
      },
      select: { id: true },
    });
    if (!job) throw new Error("Visual Beat image job is not completed and settled");
    return {
      linked: await linkVisualBeatAssetInTransaction(tx, {
        ...input,
        outputUrl,
        identityKey,
      }),
    };
  });
}
