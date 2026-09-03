import "server-only";

import { z } from "zod";
import type { ImageFundingSnapshot } from "@/lib/ai-generation-jobs.server";
import type { BrandVisualAccessDecision } from "@/lib/brand-visual-rollout.server";
import type { ProjectVisualPin } from "@/lib/project-look.server";
import {
  durablyReusableImageJobOutputs,
  reusableProjectVisualAssets,
} from "@/lib/project-visual-assets.server";
import { prisma } from "@/lib/prisma";
import {
  getStarterAiImageAllowanceStatus,
  getStarterAiImageAllowanceWindowStatus,
} from "@/lib/starter-ai-image-allowance.server";

const reusableAssetSchema = z.object({
  beatId: z.string().min(1),
  sceneIndex: z.number().int().min(0).max(119),
  outputUrl: z.string().min(1),
  imageJobId: z.string().min(1),
});

const brandVisualJobAcceptanceSchema = z.object({
  schemaVersion: z.literal(1),
  acceptedAt: z.string().datetime(),
  cohort: z.enum(["internal", "treatment-10", "treatment-50", "treatment-100", "existing-pin"]),
  rolloutBucket: z.number().int().min(0).max(99).nullable(),
  funding: z.discriminatedUnion("source", [
    z.object({ source: z.literal("credits") }),
    z.object({
      source: z.literal("starter_allowance"),
      windowStartedAt: z.string().datetime(),
    }),
  ]),
  reusableAssets: z.array(reusableAssetSchema).max(120),
  preserveEstablishedDensity: z.boolean(),
});

export type BrandVisualJobAcceptance = z.infer<typeof brandVisualJobAcceptanceSchema>;
export type BrandVisualRenderAccess = BrandVisualAccessDecision | {
  canUse: true;
  cohort: "existing-pin";
  bucket: null;
};

/** Rollback blocks new Brand Visual adoption while preserving deterministic
 * rerenders for projects that already own a Project Look/immutable Revision.
 * The synthetic cohort is excluded from rollout samples and exists only to
 * snapshot funding/reuse for that established pin.
 *
 * `hasAdmittedPersistedPin` is the pin PLUS the image decision recorded when
 * that pin was written (ADR 0059 amendment 2026-09-02, #430). Honouring a bare
 * pin turned every pin writer — including the two system writers that sit
 * outside the image guard — into a self-service admission ticket. */
export function resolveBrandVisualRenderAccess(input: {
  requestsBrandVisualImage: boolean;
  hasAdmittedPersistedPin: boolean;
  liveAccess: BrandVisualAccessDecision;
}): BrandVisualRenderAccess | null {
  if (!input.requestsBrandVisualImage) return null;
  if (input.liveAccess.canUse) return input.liveAccess;
  return input.hasAdmittedPersistedPin
    ? { canUse: true, cohort: "existing-pin", bucket: null }
    : null;
}

export type BrandVisualJobAcceptanceEnvelope =
  | { state: "legacy" }
  | { state: "invalid" }
  | { state: "accepted"; acceptance: BrandVisualJobAcceptance };

export function resolveBrandVisualJobAcceptanceEnvelope(
  value: string | null | undefined,
): BrandVisualJobAcceptanceEnvelope {
  if (value === null || value === undefined || value === "") return { state: "legacy" };
  try {
    const parsed = brandVisualJobAcceptanceSchema.safeParse(JSON.parse(value));
    return parsed.success
      ? { state: "accepted", acceptance: parsed.data }
      : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

export function parseBrandVisualJobAcceptance(
  value: string | null | undefined,
): BrandVisualJobAcceptance | null {
  const envelope = resolveBrandVisualJobAcceptanceEnvelope(value);
  return envelope.state === "accepted" ? envelope.acceptance : null;
}

/** Revalidate only the immutable source job's durable settlement. Look choice,
 * beat status and density remain frozen at acceptance; a refunded source is a
 * disclosure conflict and must never be consumed for free. */
export async function validateBrandVisualAcceptedReuse(input: {
  userId: string;
  acceptance: BrandVisualJobAcceptance;
  requestedSceneIndices: readonly number[];
}): Promise<{
  assets: BrandVisualJobAcceptance["reusableAssets"];
  invalidSceneIndices: number[];
}> {
  const requested = new Set(input.requestedSceneIndices);
  const expected = input.acceptance.reusableAssets.filter((asset) => requested.has(asset.sceneIndex));
  const durableOutputs = await durablyReusableImageJobOutputs({
    userId: input.userId,
    jobIds: expected.map((asset) => asset.imageJobId),
  });
  const assets = expected.filter(
    (asset) => durableOutputs.get(asset.imageJobId) === asset.outputUrl,
  );
  const validScenes = new Set(assets.map((asset) => asset.sceneIndex));
  const invalidSceneIndices = [...new Set(expected
    .filter((asset) => !validScenes.has(asset.sceneIndex))
    .map((asset) => asset.sceneIndex))].sort((left, right) => left - right);
  return { assets, invalidSceneIndices };
}

/** Upload jobs accept access/funding before a transcript exists. Once the
 * exact transcript preflight is pinned, hydrate only its reusable-set fields;
 * cohort, acceptedAt and funding window remain the immutable acceptance-time
 * decision. The CAS makes crash/retry and competing transcript workers safe. */
export async function hydrateBrandVisualJobAcceptanceReuse(input: {
  userId: string;
  projectId: string;
  videoJobId: string;
  preflightId: string;
}): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const job = await prisma.videoJob.findFirst({
      where: {
        id: input.videoJobId,
        userId: input.userId,
        projectId: input.projectId,
        contentPreflightId: input.preflightId,
      },
      select: { brandVisualAcceptanceJson: true },
    });
    if (!job) throw new Error("Pinned upload VideoJob was not found");
    const envelope = resolveBrandVisualJobAcceptanceEnvelope(job.brandVisualAcceptanceJson);
    if (envelope.state === "legacy") return null;
    if (envelope.state === "invalid") throw new Error("Brand Visual acceptance snapshot is invalid");

    const acceptance = envelope.acceptance;
    const reusableAssets = await reusableProjectVisualAssets({
      userId: input.userId,
      projectId: input.projectId,
      preflightId: input.preflightId,
    });
    const outdatedAssetCount = await prisma.projectVisualBeat.count({
      where: {
        userId: input.userId,
        projectId: input.projectId,
        preflightId: input.preflightId,
        status: "outdated",
        existingAssetUrl: { not: null },
      },
    });
    const allowance = acceptance.funding.source === "starter_allowance"
      ? await getStarterAiImageAllowanceWindowStatus(
          input.userId,
          new Date(acceptance.funding.windowStartedAt),
        )
      : null;
    const nextJson = JSON.stringify(brandVisualJobAcceptanceSchema.parse({
      ...acceptance,
      reusableAssets,
      preserveEstablishedDensity: Boolean(
        allowance
        && allowance.remainingImages === 0
        && reusableAssets.length > 0
        && outdatedAssetCount === 0
      ),
    }));
    if (nextJson === job.brandVisualAcceptanceJson) return nextJson;
    const updated = await prisma.videoJob.updateMany({
      where: {
        id: input.videoJobId,
        userId: input.userId,
        projectId: input.projectId,
        contentPreflightId: input.preflightId,
        brandVisualAcceptanceJson: job.brandVisualAcceptanceJson,
      },
      data: { brandVisualAcceptanceJson: nextJson },
    });
    if (updated.count === 1) return nextJson;
  }
  throw new Error("Brand Visual acceptance changed while upload reuse was hydrated");
}

export function imageFundingSnapshotFromBrandVisualAcceptance(
  acceptance: BrandVisualJobAcceptance,
): ImageFundingSnapshot {
  return acceptance.funding.source === "starter_allowance"
    ? {
        fundingSource: "starter_allowance",
        windowStartedAt: new Date(acceptance.funding.windowStartedAt),
      }
    : { fundingSource: "credits" };
}

/** Freeze the money/reuse decisions disclosed when a render is accepted.
 * Rollout flags may reject new work later, while this immutable snapshot lets
 * already accepted jobs finish with the same funding source and retained set. */
export async function prepareBrandVisualJobAcceptance(input: {
  userId: string;
  projectId: string;
  projectVisualPin: ProjectVisualPin;
  access: BrandVisualRenderAccess;
  now?: Date;
}): Promise<string> {
  if (!input.access.canUse) {
    throw new Error("Brand Visual acceptance requires treatment access");
  }
  const now = input.now ?? new Date();
  const allowance = await getStarterAiImageAllowanceStatus(input.userId, now);
  const reusableAssets = input.projectVisualPin.contentPreflightId
    ? await reusableProjectVisualAssets({
        userId: input.userId,
        projectId: input.projectId,
        preflightId: input.projectVisualPin.contentPreflightId,
      })
    : [];
  const outdatedAssetCount = input.projectVisualPin.contentPreflightId
    ? await prisma.projectVisualBeat.count({
        where: {
          userId: input.userId,
          projectId: input.projectId,
          preflightId: input.projectVisualPin.contentPreflightId,
          status: "outdated",
          existingAssetUrl: { not: null },
        },
      })
    : 0;
  return JSON.stringify(brandVisualJobAcceptanceSchema.parse({
    schemaVersion: 1,
    acceptedAt: now.toISOString(),
    cohort: input.access.cohort,
    rolloutBucket: input.access.bucket,
    funding: allowance.eligible
      ? {
          source: "starter_allowance",
          windowStartedAt: allowance.windowStartedAt.toISOString(),
        }
      : { source: "credits" },
    reusableAssets,
    // A Starter clip that already spent the current window's allowance owns a
    // reduced-density visual plan. An unchanged rerender must reuse that plan;
    // a new clip at zero allowance still stops before generation.
    preserveEstablishedDensity: allowance.eligible
      && allowance.remainingImages === 0
      && reusableAssets.length > 0
      && outdatedAssetCount === 0,
  }));
}
