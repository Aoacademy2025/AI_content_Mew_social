import "server-only";

import type { Prisma } from "@prisma/client";
import type { WindowEdit } from "@/lib/broll-rerender";
import { cutawayTimelineSourceFromJob, sceneRerollBeatTarget } from "@/lib/cutaway-plan";
import { prisma } from "@/lib/prisma";
import { linkVisualBeatAssetInTransaction } from "@/lib/project-visual-assets.server";
import { resolveProjectVisualPromptForVideoScene } from "@/lib/project-look.server";

type SceneRerollCandidate = {
  id: string;
  userId: string;
  kind: string;
  status: string;
  chargeState: string;
  productSurface: string | null;
  outputUrl: string | null;
  inputJson: string | null;
};

type ReadySceneRerollDerivative = {
  id: string;
  userId: string;
  imageJobId: string;
  sourceVideoJobId: string;
  sceneIndex: number;
  src: string;
  status: string;
  appliedVideoJobId: string | null;
};

export type PreparedSceneRerollPromotion = {
  derivativeId: string;
  userId: string;
  sourceVideoJobId: string;
  sceneIndex: number;
  src: string;
  beatId: string;
  outputUrl: string;
  imageJobId: string;
  identityKey: string;
};

type SceneRerollApplyDependencies = {
  /** `src` is globally unique, so look it up without trusting any client-owned binding fields. */
  findDerivativeBySrc: (input: { src: string }) => Promise<ReadySceneRerollDerivative | null>;
  findCandidate: (input: { userId: string; imageJobId: string }) => Promise<SceneRerollCandidate | null>;
  resolveVisualPrompt: (input: { userId: string; videoJobId: string; sceneIndex: number }) => Promise<{
    visualBeatId: string;
    identityKey: string;
  } | null>;
};

const defaultDependencies: SceneRerollApplyDependencies = {
  findDerivativeBySrc: ({ src }) => prisma.sceneRerollDerivative.findUnique({ where: { src } }),
  findCandidate: ({ userId, imageJobId }) => prisma.aiGenerationJob.findFirst({
    where: {
      id: imageJobId,
      userId,
      kind: "image",
      status: "completed",
      chargeState: "settled",
      productSurface: "scene_reroll",
    },
    select: {
      id: true,
      userId: true,
      kind: true,
      status: true,
      chargeState: true,
      productSurface: true,
      outputUrl: true,
      inputJson: true,
    },
  }),
  resolveVisualPrompt: resolveProjectVisualPromptForVideoScene,
};

function candidateSource(inputJson: string | null): { videoJobId: string; sceneIndex: number } | null {
  if (!inputJson) return null;
  try {
    const value = JSON.parse(inputJson) as Record<string, unknown>;
    if (
      typeof value.videoJobId !== "string"
      || typeof value.sceneIndex !== "number"
      || !Number.isInteger(value.sceneIndex)
      || value.sceneIndex < 0
    ) return null;
    return { videoJobId: value.videoJobId, sceneIndex: value.sceneIndex };
  } catch {
    return null;
  }
}

/** Resolve and validate exact staged candidates before the completion transaction. */
export async function prepareAppliedSceneRerollAssets(
  input: {
    userId: string;
    sourceVideoJobId: string;
    edits: WindowEdit[];
  },
  dependencies: SceneRerollApplyDependencies = defaultDependencies,
): Promise<PreparedSceneRerollPromotion[]> {
  const prepared: PreparedSceneRerollPromotion[] = [];
  const replacements = input.edits.filter(
    (edit): edit is WindowEdit & { src: string } => typeof edit.src === "string",
  );
  const inspected = await Promise.all(replacements.map(async (edit) => ({
    edit,
    derivative: await dependencies.findDerivativeBySrc({ src: edit.src }),
  })));
  const sourceJob = await prisma.videoJob.findFirst({
    where: { id: input.sourceVideoJobId, userId: input.userId },
    select: { inputJson: true, outputJson: true },
  });
  const cutawaySource = cutawayTimelineSourceFromJob(sourceJob ?? {});
  for (const { edit, derivative } of inspected) {
    // Discover paid derivatives from the server-owned unique src. Client metadata can be lost
    // or forged, so a ready derivative may never fall through as an ordinary Stock/AI edit.
    if (!derivative) {
      if (edit.imageJobId) {
        throw new Error("Applied Scene Reroll derivative does not belong to this video scene");
      }
      continue;
    }
    // Once a derivative has been consumed, its Visual Beat was already promoted atomically.
    // It is now ordinary same-owner media and may be moved in a later edit without replaying
    // promotion. Still reject cross-account reuse and any contradictory client job identity.
    if (derivative.status === "applied") {
      if (
        derivative.userId !== input.userId
        || (edit.imageJobId !== undefined && edit.imageJobId !== derivative.imageJobId)
      ) {
        throw new Error("Applied Scene Reroll derivative does not belong to this user");
      }
      continue;
    }
    if (derivative.status !== "ready" || derivative.appliedVideoJobId !== null) {
      throw new Error("Applied Scene Reroll derivative is not in a usable state");
    }
    if (edit.replacementKind !== "ai" || !edit.imageJobId) {
      throw new Error("Applied Scene Reroll derivative is missing its exact image job binding");
    }
    const imageJobId = edit.imageJobId;
    if (
      derivative.userId !== input.userId
      || derivative.imageJobId !== imageJobId
      || derivative.sourceVideoJobId !== input.sourceVideoJobId
      || derivative.sceneIndex !== edit.index
      || derivative.src !== edit.src
    ) {
      throw new Error("Applied Scene Reroll derivative does not belong to this video scene");
    }
    const candidate = await dependencies.findCandidate({ userId: input.userId, imageJobId });
    if (
      !candidate
      || candidate.id !== imageJobId
      || candidate.userId !== input.userId
      || candidate.kind !== "image"
      || candidate.status !== "completed"
      || candidate.chargeState !== "settled"
      || candidate.productSurface !== "scene_reroll"
      || !candidate.outputUrl
    ) {
      throw new Error("Applied Scene Reroll candidate is not completed and settled");
    }
    const source = candidateSource(candidate.inputJson);
    if (source?.videoJobId !== input.sourceVideoJobId || source.sceneIndex !== edit.index) {
      throw new Error("Applied Scene Reroll candidate does not belong to this video scene");
    }
    const beatTarget = sceneRerollBeatTarget(edit.index, cutawaySource);
    if (beatTarget.kind === "presenter") {
      throw new Error("Applied Scene Reroll has no durable Visual Beat");
    }
    const prompt = await dependencies.resolveVisualPrompt({
      userId: input.userId,
      videoJobId: input.sourceVideoJobId,
      sceneIndex: beatTarget.visualBeatSequence,
    });
    if (!prompt) throw new Error("Applied Scene Reroll has no durable Visual Beat");
    prepared.push({
      derivativeId: derivative.id,
      userId: input.userId,
      sourceVideoJobId: input.sourceVideoJobId,
      sceneIndex: edit.index,
      src: derivative.src,
      beatId: prompt.visualBeatId,
      outputUrl: candidate.outputUrl,
      imageJobId: candidate.id,
      identityKey: prompt.identityKey,
    });
  }
  return prepared;
}

/** Atomically consume prepared derivatives and promote their reusable Visual Beats. */
export async function commitAppliedSceneRerollAssetsInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    appliedVideoJobId: string;
    promotions: PreparedSceneRerollPromotion[];
  },
): Promise<void> {
  for (const promotion of input.promotions) {
    const [candidate, derivative] = await Promise.all([
      tx.aiGenerationJob.findFirst({
        where: {
          id: promotion.imageJobId,
          userId: promotion.userId,
          kind: "image",
          status: "completed",
          chargeState: "settled",
          productSurface: "scene_reroll",
          outputUrl: promotion.outputUrl,
        },
        select: { id: true },
      }),
      tx.sceneRerollDerivative.findFirst({
        where: {
          id: promotion.derivativeId,
          userId: promotion.userId,
          imageJobId: promotion.imageJobId,
          sourceVideoJobId: promotion.sourceVideoJobId,
          sceneIndex: promotion.sceneIndex,
          src: promotion.src,
          status: "ready",
          appliedVideoJobId: null,
        },
        select: { id: true },
      }),
    ]);
    if (!candidate || !derivative) {
      throw new Error("Applied Scene Reroll changed before durable completion");
    }
    const linked = await linkVisualBeatAssetInTransaction(tx, {
      userId: promotion.userId,
      beatId: promotion.beatId,
      outputUrl: promotion.outputUrl,
      imageJobId: promotion.imageJobId,
      identityKey: promotion.identityKey,
    });
    if (!linked) throw new Error("Applied Scene Reroll Visual Beat identity changed before promotion");
    const consumed = await tx.sceneRerollDerivative.updateMany({
      where: { id: promotion.derivativeId, status: "ready", appliedVideoJobId: null },
      data: {
        status: "applied",
        appliedVideoJobId: input.appliedVideoJobId,
        appliedAt: new Date(),
      },
    });
    if (consumed.count !== 1) throw new Error("Applied Scene Reroll derivative was already consumed");
  }
}
