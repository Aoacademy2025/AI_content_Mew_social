import "server-only";

import type { BrandLookPreviewBatch, BrandLookPreviewItem } from "@prisma/client";
import {
  VISUAL_FORMATS,
  brandVisualIdentityKey,
  compileBrandVisualPrompt,
  type BrandVisualLanguage,
  type VisualBeat,
} from "@/lib/brand-visual-system";
import { brandProfilePayloadSchema, type BrandProfilePayload } from "@/lib/brand-profile-library.server";
import { HERO_AI_IMAGE_CREDITS } from "@/lib/credit-costs";
import { ensureMonthlyGrant, getBalance } from "@/lib/credits";
import { prisma } from "@/lib/prisma";
import { getStarterAiImageAllowanceStatus } from "@/lib/starter-ai-image-allowance.server";
import {
  generateHeroImageForVideo,
  reserveHeroImageForVideo,
  type HeroImageGenerationInput,
} from "@/lib/video-hero-image.server";
import {
  recoverBrandLookPreviewAfterGeneratorError,
  refreshBrandLookPreviewBatchInTransaction,
  syncBrandLookPreviewJobInTransaction,
} from "@/lib/brand-look-preview-job-link.server";
import { reusableProjectVisualAssets } from "@/lib/project-visual-assets.server";

export type BrandLookPreviewPhase = "hook" | "explain" | "close";
type PreviewScene = {
  phase: BrandLookPreviewPhase;
  contentDomain: string;
  visualBeat: Omit<VisualBeat, "phase">;
};
type PreviewGenerationInput = {
  itemId: string;
  phase: BrandLookPreviewPhase;
  batchId: string;
  compiled: ReturnType<typeof compileBrandVisualPrompt>;
};
type PreviewGenerator = (input: PreviewGenerationInput) => Promise<{ jobId: string; outputUrl: string }>;
type PreviewReservation = (input: PreviewGenerationInput) => Promise<void>;

export type BrandLookPreviewResult = BrandLookPreviewBatch & { items: BrandLookPreviewItem[] };
export type PreparedBrandLookPreview = {
  /** Exact number of generated items in this request snapshot. Admission must
   * use this value before calling materialize(). */
  generationCount: number;
  /** Materializes the same payload/scenes/reuse snapshot that was counted.
   * Repeated calls on one preparation share one idempotent promise. */
  materialize: () => Promise<BrandLookPreviewResult>;
};
const PREVIEW_PHASES = ["hook", "explain", "close"] as const;
const PREVIEW_REQUEST_ID_PATTERN = /^[a-z0-9_-]{8,100}$/iu;

export function parseBrandLookPreviewRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const requestId = value.trim();
  return PREVIEW_REQUEST_ID_PATTERN.test(requestId) ? requestId : null;
}

export async function getBrandLookPreviewByRequestId(input: {
  userId: string;
  requestId: string;
}): Promise<BrandLookPreviewResult | null> {
  const requestId = parseBrandLookPreviewRequestId(input.requestId);
  if (!requestId) return null;
  return prisma.brandLookPreviewBatch.findUnique({
    where: { userId_requestId: { userId: input.userId, requestId } },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
}

export async function getBrandLookPreviewBatch(input: {
  userId: string;
  batchId: string;
}): Promise<BrandLookPreviewResult | null> {
  return prisma.brandLookPreviewBatch.findFirst({
    where: { id: input.batchId, userId: input.userId },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
}

function rerollIdempotencyKey(
  batchId: string,
  phase: BrandLookPreviewPhase,
  requestId: string,
): string {
  return `brand-preview-reroll:${batchId}:${phase}:${requestId}`;
}

/** Recover an ambiguous reroll before admission. The paid reservation's
 * idempotency key is the server-owned operation identity, so a browser retry or
 * reload cannot pass funding/rate checks for a second generation. */
export async function getBrandLookPreviewRerollReplay(input: {
  userId: string;
  itemId: string;
  requestId: string;
}): Promise<BrandLookPreviewItem | null> {
  const requestId = parseBrandLookPreviewRequestId(input.requestId);
  if (!requestId) return null;
  const item = await prisma.brandLookPreviewItem.findFirst({
    where: { id: input.itemId, batch: { userId: input.userId } },
    include: { batch: { select: { id: true } } },
  });
  if (!item) return null;
  const phase = item.phase as BrandLookPreviewPhase;
  if (!PREVIEW_PHASES.includes(phase)) return null;
  const job = await prisma.aiGenerationJob.findUnique({
    where: {
      userId_idempotencyKey: {
        userId: input.userId,
        idempotencyKey: rerollIdempotencyKey(item.batchId, phase, requestId),
      },
    },
  });
  if (!job) return null;
  await prisma.$transaction(async (tx) => {
    await syncBrandLookPreviewJobInTransaction(tx, job);
  });
  return prisma.brandLookPreviewItem.findFirst({
    where: { id: item.id, batch: { userId: input.userId } },
  });
}

function brandVisualLanguageFor(payload: BrandProfilePayload): BrandVisualLanguage | null {
  if (payload.visual.languageMode === "none") return null;
  return {
    palette: payload.visual.palette,
    personality: payload.visual.personality,
    peopleAndSetting: payload.visual.peopleAndSetting,
    memorableCues: payload.visual.memorableCues,
    visualNotes: payload.visual.visualNotes,
  };
}

function currentRecipeVersion(payload: BrandProfilePayload): string {
  const format = VISUAL_FORMATS.find((candidate) => candidate.id === payload.visual.primaryVisualFormatId);
  if (!format) throw new Error("Unsupported Visual Format");
  return format.recipeVersion;
}

function storedRevisionRecipeVersion(
  payload: BrandProfilePayload,
  visualRecipeJson: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(visualRecipeJson);
  } catch {
    throw new Error("Brand Profile Revision visual recipe is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Brand Profile Revision visual recipe is invalid");
  }
  const recipe = parsed as Record<string, unknown>;
  if (
    recipe.visualFormatId !== payload.visual.primaryVisualFormatId
    || typeof recipe.recipeVersion !== "string"
    || !recipe.recipeVersion.trim()
    || recipe.recipeVersion.length > 100
  ) {
    throw new Error("Brand Profile Revision visual recipe does not match its payload");
  }
  return recipe.recipeVersion.trim();
}

function previewIdentityKey(
  payload: BrandProfilePayload,
  recipeVersion = currentRecipeVersion(payload),
): string {
  return brandVisualIdentityKey({
    visualFormatId: payload.visual.primaryVisualFormatId,
    recipeVersion,
    treatment: payload.visual.defaultTreatment,
    brandVisualLanguage: brandVisualLanguageFor(payload),
  });
}

/** Product previews exercise three structurally distinct archetype scenes —
 * wide environmental establishing shot, hands-and-objects mid-shot, human
 * close-up — so a creator can judge whether a Visual Format holds across
 * different kinds of framing. Scenes never depend on `niche`/`audience`
 * (both are optional refinements, see brand-profile-library.server.ts); a
 * non-empty `niche` may still colour `contentDomain`, but it must never
 * become the `setting` string. The fixed history/health/commerce matrix
 * belongs exclusively to the 21-image Quality Gate. */
function standardPreviewScenes(payload: BrandProfilePayload): PreviewScene[] {
  const contentDomain = payload.niche.trim() || "a story worth telling";
  return [
    {
      phase: "hook",
      contentDomain,
      visualBeat: {
        subject: "a towering weather front rolling across an open horizon",
        action: "gathers force as the sky darkens and the treeline visibly bends under the wind",
        setting: "a wide open outdoor landscape with no structures in the foreground",
        emotion: "immediate tension and scale",
        emphasis: "the sheer size of the force dominating the frame",
      },
    },
    {
      phase: "explain",
      contentDomain,
      visualBeat: {
        subject: "a pair of hands arranging three small concrete objects in a deliberate row",
        action: "moves one object so its direct effect on the other two becomes visible",
        setting: "a close tabletop workspace with nothing else in frame",
        emotion: "calm concentration and clarity",
        emphasis: "the one cause-and-effect relationship that makes the lesson understandable",
      },
    },
    {
      phase: "close",
      contentDomain,
      visualBeat: {
        subject: "one person's face and shoulders leaning toward the camera in close-up",
        action: "steps forward with confident, deliberate forward motion",
        setting: "a shallow close-up frame with open, uncluttered space across the lower third",
        emotion: "earned optimism and momentum",
        emphasis: "the forward motion carrying the story toward its next concrete action",
      },
    },
  ];
}

function representativeRows<T>(rows: T[]): readonly [T, T, T] | null {
  if (rows.length < 3) return null;
  return [rows[0], rows[Math.floor((rows.length - 1) / 2)], rows[rows.length - 1]] as const;
}

function jobIdentityKey(inputJson: string | null): string | null {
  if (!inputJson) return null;
  try {
    const parsed = JSON.parse(inputJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>).brandVisualIdentityKey;
    return typeof value === "string" && value.trim() ? value : null;
  } catch {
    return null;
  }
}

async function resolveProjectPreview(input: {
  userId: string;
  projectId?: string;
  preflightId?: string;
  expectedIdentityKey: string;
  fallbackScenes: PreviewScene[];
}): Promise<{
  existing: readonly [string | null, string | null, string | null];
  scenes: PreviewScene[] | null;
}> {
  if (!input.projectId) return { existing: [null, null, null], scenes: null };
  const project = await prisma.editorProject.findFirst({
    where: { id: input.projectId, userId: input.userId },
    select: { id: true },
  });
  if (!project) throw new Error("Project not found");
  const latest = await prisma.contentPreflight.findFirst({
    where: {
      projectId: project.id,
      userId: input.userId,
      ...(input.preflightId ? { id: input.preflightId } : {}),
    },
    orderBy: input.preflightId ? undefined : { createdAt: "desc" },
    include: { visualBeats: { orderBy: { sequence: "asc" } } },
  });
  const selected = representativeRows(latest?.visualBeats ?? []);
  if (!latest || !selected) return { existing: [null, null, null], scenes: null };
  const phases = ["hook", "explain", "close"] as const;
  const scenes = selected.map((beat, index): PreviewScene => {
    const fallback = input.fallbackScenes[index].visualBeat;
    try {
      const parsed = JSON.parse(beat.beatJson) as Partial<Omit<VisualBeat, "phase">>;
      const valid = [parsed.subject, parsed.action, parsed.setting, parsed.emotion, parsed.emphasis]
        .every((value) => typeof value === "string" && value.trim());
      return {
        phase: phases[index],
        contentDomain: latest.contentDomain,
        visualBeat: valid ? parsed as Omit<VisualBeat, "phase"> : fallback,
      };
    } catch {
      return { phase: phases[index], contentDomain: latest.contentDomain, visualBeat: fallback };
    }
  });
  const reusableAssets = await reusableProjectVisualAssets({
    userId: input.userId,
    projectId: project.id,
    preflightId: latest.id,
  });
  const reusableByBeatId = new Map(reusableAssets.map((asset) => [asset.beatId, asset]));
  const jobIds = reusableAssets.map((asset) => asset.imageJobId);
  const jobs = jobIds.length > 0
    ? await prisma.aiGenerationJob.findMany({
        where: {
          userId: input.userId,
          id: { in: jobIds },
        },
        select: { id: true, inputJson: true },
      })
    : [];
  const identities = new Map(jobs.map((job) => [job.id, jobIdentityKey(job.inputJson)]));
  const existing = selected.map((beat) => {
    const asset = reusableByBeatId.get(beat.id);
    return asset && identities.get(asset.imageJobId) === input.expectedIdentityKey
      ? asset.outputUrl
      : null;
  }) as [string | null, string | null, string | null];
  return { existing, scenes };
}

type SavedPreviewLineage = {
  sourceVideoJobId: string | null;
  sourcePreflightId: string | null;
};

/** A Revision promoted from a completed clip keeps its source identities even
 * after the browser leaves the promotion wizard. Resolve those immutable
 * identities back to the exact project/preflight so a later Preview can reuse
 * Hook/Explain/Close without relying on transient query-string state. */
async function resolvePreviewSource(input: {
  userId: string;
  projectId?: string;
  preflightId?: string;
  revision?: SavedPreviewLineage | null;
}): Promise<{ projectId?: string; preflightId?: string }> {
  if (input.projectId) {
    return { projectId: input.projectId, preflightId: input.preflightId };
  }
  const preflightId = input.preflightId ?? input.revision?.sourcePreflightId ?? undefined;
  if (preflightId) {
    const preflight = await prisma.contentPreflight.findFirst({
      where: { id: preflightId, userId: input.userId },
      select: { id: true, projectId: true },
    });
    if (preflight) return { projectId: preflight.projectId, preflightId: preflight.id };
  }
  const sourceVideoJobId = input.revision?.sourceVideoJobId ?? undefined;
  if (sourceVideoJobId) {
    const job = await prisma.videoJob.findFirst({
      where: { id: sourceVideoJobId, userId: input.userId },
      select: { projectId: true, contentPreflightId: true },
    });
    if (job?.projectId) {
      return {
        projectId: job.projectId,
        preflightId: job.contentPreflightId ?? undefined,
      };
    }
  }
  return {};
}

export async function brandLookPreviewGenerationCount(input: {
  userId: string;
  projectId?: string;
  preflightId?: string;
  payload?: BrandProfilePayload;
  profileId?: string;
  useDraft?: boolean;
}): Promise<number> {
  let payload = input.payload ? brandProfilePayloadSchema.parse(input.payload) : null;
  let recipeVersion = payload ? currentRecipeVersion(payload) : null;
  let sourceRevision: SavedPreviewLineage | null = null;
  if (input.profileId) {
    const profile = await prisma.brandProfile.findFirst({
      where: { id: input.profileId, userId: input.userId },
      include: { draft: true, revisions: { orderBy: { version: "desc" }, take: 1 } },
    });
    const revision = profile?.revisions[0];
    sourceRevision = revision ?? null;
    if (!payload) {
      const sourceJson = input.useDraft ? profile?.draft?.payloadJson : revision?.payloadJson;
      if (!sourceJson) return 3;
      payload = brandProfilePayloadSchema.parse(JSON.parse(sourceJson));
      recipeVersion = input.useDraft
        ? currentRecipeVersion(payload)
        : revision
          ? storedRevisionRecipeVersion(payload, revision.visualRecipeJson)
          : null;
    }
  }
  if (!payload || !recipeVersion) return 3;
  const source = await resolvePreviewSource({
    userId: input.userId,
    projectId: input.projectId,
    preflightId: input.preflightId,
    revision: sourceRevision,
  });
  if (!source.projectId) return 3;
  const fallbackScenes = standardPreviewScenes(payload);
  const preview = await resolveProjectPreview({
    userId: input.userId,
    projectId: source.projectId,
    preflightId: source.preflightId,
    expectedIdentityKey: previewIdentityKey(payload, recipeVersion),
    fallbackScenes,
  });
  return preview.existing.filter((url) => !url).length;
}

export async function brandLookPreviewRequiresGeneration(input: {
  userId: string;
  projectId?: string;
  preflightId?: string;
  payload?: BrandProfilePayload;
  profileId?: string;
  useDraft?: boolean;
}): Promise<boolean> {
  return (await brandLookPreviewGenerationCount(input)) > 0;
}

/** UX preflight only. Durable per-image reservations remain authoritative, but
 * a known six-credit/three-unit deficit must stop before launching a partial
 * preview batch. */
export async function checkBrandLookPreviewFunding(input: {
  userId: string;
  imageCount: number;
}): Promise<
  | { ok: true; fundingSource: "starter_allowance" | "credits" }
  | { ok: false; code: "ALLOWANCE_EXHAUSTED" | "INSUFFICIENT_CREDITS"; remainingImages?: number; requiredCredits?: number; balance?: number }
> {
  const imageCount = Math.max(0, Math.floor(input.imageCount));
  const allowance = await getStarterAiImageAllowanceStatus(input.userId);
  if (allowance.eligible) {
    return allowance.remainingImages >= imageCount
      ? { ok: true, fundingSource: "starter_allowance" }
      : { ok: false, code: "ALLOWANCE_EXHAUSTED", remainingImages: allowance.remainingImages };
  }
  await ensureMonthlyGrant(input.userId);
  const balance = await getBalance(input.userId);
  const requiredCredits = imageCount * HERO_AI_IMAGE_CREDITS;
  return balance.total >= requiredCredits
    ? { ok: true, fundingSource: "credits" }
    : { ok: false, code: "INSUFFICIENT_CREDITS", requiredCredits, balance: balance.total };
}

type PreviewBatchRefs = {
  projectId?: string;
  preflightId?: string;
  brandProfileId?: string;
  brandProfileDraftId?: string | null;
  brandProfileRevisionId?: string | null;
};

type BrandLookPreviewMaterialization = {
  userId: string;
  requestId: string;
  refs: PreviewBatchRefs;
  payload: BrandProfilePayload;
  recipeVersion: string;
  previewScenes: PreviewScene[];
  source: string;
  existing: readonly [string | null, string | null, string | null];
  reservation?: PreviewReservation;
  generator: PreviewGenerator;
};

async function createPreviewBatchOrReplay(input: {
  userId: string;
  requestId: string;
  refs: PreviewBatchRefs;
  payload: BrandProfilePayload;
  recipeVersion: string;
  previewScenes: PreviewScene[];
  source: string;
  existing: readonly [string | null, string | null, string | null];
}): Promise<{ created: boolean; batch: BrandLookPreviewResult }> {
  const requestId = parseBrandLookPreviewRequestId(input.requestId);
  if (!requestId) throw new Error("Brand preview request id is required");
  const reusedCount = input.existing.filter(Boolean).length;
  const fullyReused = reusedCount === PREVIEW_PHASES.length;
  try {
    const batch = await prisma.brandLookPreviewBatch.create({
      data: {
        userId: input.userId,
        requestId,
        projectId: input.refs.projectId,
        brandProfileId: input.refs.brandProfileId,
        brandProfileDraftId: input.refs.brandProfileDraftId,
        brandProfileRevisionId: input.refs.brandProfileRevisionId,
        status: fullyReused ? "completed" : "in_progress",
        finishedAt: fullyReused ? new Date() : null,
        sourceSnapshotJson: JSON.stringify({
          payload: input.payload,
          recipeVersion: input.recipeVersion,
          previewScenes: input.previewScenes,
          preflightId: input.refs.preflightId ?? null,
          source: fullyReused
            ? `${input.source}-project-assets`
            : reusedCount > 0 ? `${input.source}-project-assets-partial` : input.source,
        }),
        items: {
          create: PREVIEW_PHASES.map((phase, index) => ({
            phase,
            sourceType: input.existing[index] ? "reused" : "generated",
            outputUrl: input.existing[index],
            status: input.existing[index] ? "completed" : "queued",
          })),
        },
      },
      include: { items: { orderBy: { createdAt: "asc" } } },
    });
    return { created: true, batch };
  } catch (error) {
    if ((error as { code?: string })?.code !== "P2002") throw error;
    const replay = await getBrandLookPreviewByRequestId({ userId: input.userId, requestId });
    if (!replay) throw error;
    return { created: false, batch: replay };
  }
}

async function materializeBrandLookPreview(
  input: BrandLookPreviewMaterialization,
): Promise<BrandLookPreviewResult> {
  const claimed = await createPreviewBatchOrReplay(input);
  if (
    ["completed", "partial", "failed"].includes(claimed.batch.status)
    || (!claimed.created && !input.reservation)
    || claimed.batch.items.every((item) => item.sourceType === "reused")
  ) return claimed.batch;
  const generationInput = (item: BrandLookPreviewItem): PreviewGenerationInput => {
    const phase = item.phase as BrandLookPreviewPhase;
    const scene = input.previewScenes.find((candidate) => candidate.phase === phase)!;
    return {
      itemId: item.id,
      phase,
      batchId: claimed.batch.id,
      compiled: compileBrandVisualPrompt({
        visualFormatId: input.payload.visual.primaryVisualFormatId,
        recipeVersion: input.recipeVersion,
        contentDomain: scene.contentDomain,
        treatment: input.payload.visual.defaultTreatment,
        visualBeat: { ...scene.visualBeat, phase },
        brandVisualLanguage: brandVisualLanguageFor(input.payload),
      }),
    };
  };
  const generatedItems = claimed.batch.items.filter((item) => item.sourceType === "generated");
  // Reserve/link every generated item before the first provider submission or
  // long poll. A process interruption can then recover three independent jobs
  // instead of leaving a logical batch with uncharged phantom work.
  if (input.reservation) {
    await Promise.all(generatedItems.filter((item) => !item.aiGenerationJobId).map(async (item) => {
      try {
        await input.reservation!(generationInput(item));
      } catch (error) {
        await recoverBrandLookPreviewAfterGeneratorError({
          itemId: item.id,
          errorCode: error instanceof Error && "code" in error
            ? String((error as Error & { code: unknown }).code).slice(0, 80)
            : "RESERVATION_FAILED",
        });
        throw error;
      }
    }));
  }
  const durableBatch = await prisma.brandLookPreviewBatch.findUniqueOrThrow({
    where: { id: claimed.batch.id },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  await Promise.all(durableBatch.items.filter((item) =>
    item.sourceType === "generated"
    && item.status !== "completed"
    && item.status !== "failed").map(async (item) => {
    try {
      const generated = await input.generator(generationInput(item));
      await prisma.brandLookPreviewItem.update({
        where: { id: item.id },
        data: {
          status: "completed",
          outputUrl: generated.outputUrl,
          aiGenerationJobId: generated.jobId,
          errorCode: null,
        },
      });
    } catch (error) {
      await recoverBrandLookPreviewAfterGeneratorError({
        itemId: item.id,
        errorCode: error instanceof Error && "code" in error
          ? String((error as Error & { code: unknown }).code).slice(0, 80)
          : error instanceof Error && error.message === "Unsupported Visual Format recipe version"
            ? "RECIPE_UNAVAILABLE"
            : "GENERATION_FAILED",
      });
    }
  }));
  await prisma.$transaction(async (tx) => {
    await refreshBrandLookPreviewBatchInTransaction(tx, claimed.batch.id);
  });
  return prisma.brandLookPreviewBatch.findUniqueOrThrow({
    where: { id: claimed.batch.id },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
}

/** Freeze every input that controls both generation count and provider work.
 * This is the preview admission boundary: mutations after preparation cannot
 * turn a 0/1-image admission into a 3-image materialization. */
function preparedMaterialization(
  input: BrandLookPreviewMaterialization,
): PreparedBrandLookPreview {
  const generationCount = input.existing.filter((url) => !url).length;
  let materialized: Promise<BrandLookPreviewResult> | null = null;
  return {
    generationCount,
    materialize: () => {
      materialized ??= materializeBrandLookPreview(input);
      return materialized;
    },
  };
}

function preparedReplay(batch: BrandLookPreviewResult): PreparedBrandLookPreview {
  return {
    generationCount: 0,
    materialize: async () => batch,
  };
}

function replayMaterializationSnapshot(batch: BrandLookPreviewResult): {
  payload: BrandProfilePayload;
  recipeVersion: string;
  previewScenes: PreviewScene[];
  preflightId?: string;
  source: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(batch.sourceSnapshotJson);
  } catch {
    throw new Error("Brand preview snapshot is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Brand preview snapshot is invalid");
  }
  const snapshot = value as Record<string, unknown>;
  const payload = brandProfilePayloadSchema.parse(snapshot.payload);
  const recipeVersion = typeof snapshot.recipeVersion === "string" ? snapshot.recipeVersion.trim() : "";
  const previewScenes = Array.isArray(snapshot.previewScenes)
    ? snapshot.previewScenes as PreviewScene[]
    : [];
  if (
    !recipeVersion
    || previewScenes.length !== PREVIEW_PHASES.length
    || !PREVIEW_PHASES.every((phase) => previewScenes.some((scene) =>
      scene?.phase === phase
      && typeof scene.contentDomain === "string"
      && scene.visualBeat
      && typeof scene.visualBeat === "object"))
  ) {
    throw new Error("Brand preview snapshot is incomplete");
  }
  return {
    payload,
    recipeVersion,
    previewScenes,
    preflightId: typeof snapshot.preflightId === "string" ? snapshot.preflightId : undefined,
    source: typeof snapshot.source === "string" ? snapshot.source : "replay",
  };
}

async function preparedDurableReplay(
  batch: BrandLookPreviewResult,
  overrides?: { reservation?: PreviewReservation; generator?: PreviewGenerator },
): Promise<PreparedBrandLookPreview> {
  if (["completed", "partial", "failed"].includes(batch.status)) return preparedReplay(batch);
  const snapshot = replayMaterializationSnapshot(batch);
  const user = await prisma.user.findUnique({
    where: { id: batch.userId },
    select: { plan: true },
  });
  if (!user) throw new Error("User not found");
  const identityKey = previewIdentityKey(snapshot.payload, snapshot.recipeVersion);
  const driver = previewGenerationDriver({
    userId: batch.userId,
    plan: user.plan,
    payload: snapshot.payload,
    identityKey,
    source: batch.brandProfileId ? "brand-revision" : "project-look",
    idempotencyPrefix: batch.brandProfileId ? "brand-preview" : "brand-preview-unsaved",
  });
  const existing = PREVIEW_PHASES.map((phase) => {
    const item = batch.items.find((candidate) => candidate.phase === phase);
    return item?.sourceType === "reused" ? item.outputUrl : null;
  }) as [string | null, string | null, string | null];
  const materialization: BrandLookPreviewMaterialization = {
    userId: batch.userId,
    requestId: batch.requestId,
    refs: {
      projectId: batch.projectId ?? undefined,
      preflightId: snapshot.preflightId,
      brandProfileId: batch.brandProfileId ?? undefined,
      brandProfileDraftId: batch.brandProfileDraftId,
      brandProfileRevisionId: batch.brandProfileRevisionId,
    },
    payload: snapshot.payload,
    recipeVersion: snapshot.recipeVersion,
    previewScenes: snapshot.previewScenes,
    source: snapshot.source,
    existing,
    reservation: overrides?.reservation ?? driver.reservation,
    generator: overrides?.generator ?? driver.generator,
  };
  let resumed: Promise<BrandLookPreviewResult> | null = null;
  return {
    generationCount: 0,
    materialize: () => {
      resumed ??= materializeBrandLookPreview(materialization);
      return resumed;
    },
  };
}

/** Resume the exact frozen batch after a transport or process interruption.
 * This performs no new admission and cannot change payload, scenes or count. */
export async function resumeBrandLookPreviewByRequestId(input: {
  userId: string;
  requestId: string;
}): Promise<BrandLookPreviewResult | null> {
  const batch = await getBrandLookPreviewByRequestId(input);
  if (!batch) return null;
  return (await preparedDurableReplay(batch)).materialize();
}

/** Internal cron recovery by durable batch id. Ownership is still preserved
 * by the batch row; unlike the public helper this accepts no caller identity. */
export async function resumeBrandLookPreviewBatch(batchId: string): Promise<BrandLookPreviewResult | null> {
  const batch = await prisma.brandLookPreviewBatch.findUnique({
    where: { id: batchId },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  if (!batch) return null;
  return (await preparedDurableReplay(batch)).materialize();
}

function previewGenerationDriver(input: {
  userId: string;
  plan: string;
  payload: BrandProfilePayload;
  identityKey: string;
  source: "project-look" | "brand-revision";
  idempotencyPrefix: "brand-preview" | "brand-preview-unsaved";
}): { reservation: PreviewReservation; generator: PreviewGenerator } {
  const heroInput = ({ itemId, phase, batchId, compiled }: PreviewGenerationInput): HeroImageGenerationInput => ({
    userId: input.userId,
    plan: input.plan,
    prompt: `${input.payload.niche} ${phase}`,
    idempotencyKey: `${input.idempotencyPrefix}:${batchId}:${phase}`,
    videoJobId: `brand-preview-${batchId}`,
    sceneIndex: PREVIEW_PHASES.indexOf(phase),
    sceneTitle: `${input.payload.name} · ${phase}`,
    brandVisualPrompt: { source: input.source, compiled, identityKey: input.identityKey },
    brandLookPreviewReservation: { itemId, expectedImageJobId: null },
  });
  return {
    reservation: async (request) => {
      await reserveHeroImageForVideo(heroInput(request));
    },
    generator: async (request) => {
      const result = await generateHeroImageForVideo(heroInput(request));
      return { jobId: result.jobId, outputUrl: result.outputUrl };
    },
  };
}

export async function prepareBrandLookPreview(input: {
  userId: string;
  requestId: string;
  profileId: string;
  projectId?: string;
  preflightId?: string;
  useDraft?: boolean;
  generator?: PreviewGenerator;
  reservation?: PreviewReservation;
}): Promise<PreparedBrandLookPreview> {
  const requestId = parseBrandLookPreviewRequestId(input.requestId);
  if (!requestId) throw new Error("Brand preview request id is required");
  const replay = await getBrandLookPreviewByRequestId({ userId: input.userId, requestId });
  if (replay) return preparedDurableReplay(replay, {
    reservation: input.reservation,
    generator: input.generator,
  });

  const profile = await prisma.brandProfile.findFirst({
    where: { id: input.profileId, userId: input.userId },
    include: {
      draft: true,
      revisions: { orderBy: { version: "desc" }, take: 1 },
      user: { select: { plan: true } },
    },
  });
  if (!profile) throw new Error("Brand Profile not found");
  if (profile.frozenAt) throw new Error("Brand Profile is frozen");
  const sourceJson = input.useDraft ? profile.draft?.payloadJson : profile.revisions[0]?.payloadJson;
  if (!sourceJson) throw new Error("Brand Profile has no previewable revision");
  const payload = brandProfilePayloadSchema.parse(JSON.parse(sourceJson));
  const recipeVersion = input.useDraft
    ? currentRecipeVersion(payload)
    : storedRevisionRecipeVersion(payload, profile.revisions[0]!.visualRecipeJson);

  const identityKey = previewIdentityKey(payload, recipeVersion);
  const fallbackScenes = standardPreviewScenes(payload);
  const source = await resolvePreviewSource({
    userId: input.userId,
    projectId: input.projectId,
    preflightId: input.preflightId,
    revision: profile.revisions[0] ?? null,
  });
  const projectPreview = await resolveProjectPreview({
    userId: input.userId,
    projectId: source.projectId,
    preflightId: source.preflightId,
    expectedIdentityKey: identityKey,
    fallbackScenes,
  });
  const previewScenes = projectPreview.scenes ?? fallbackScenes;

  const driver = previewGenerationDriver({
    userId: input.userId,
    plan: profile.user.plan,
    payload,
    identityKey,
    source: "brand-revision",
    idempotencyPrefix: "brand-preview",
  });
  return preparedMaterialization({
    userId: input.userId,
    requestId,
    refs: {
      projectId: source.projectId,
      preflightId: source.preflightId,
      brandProfileId: profile.id,
      brandProfileDraftId: input.useDraft ? profile.draft?.id : null,
      brandProfileRevisionId: input.useDraft ? null : profile.revisions[0]?.id,
    },
    payload,
    recipeVersion,
    previewScenes,
    source: input.useDraft ? "draft" : "revision",
    existing: projectPreview.existing,
    reservation: input.reservation ?? (input.generator ? undefined : driver.reservation),
    generator: input.generator ?? driver.generator,
  });
}

export async function createBrandLookPreview(input: {
  userId: string;
  requestId: string;
  profileId: string;
  projectId?: string;
  preflightId?: string;
  useDraft?: boolean;
  generator?: PreviewGenerator;
  reservation?: PreviewReservation;
}): Promise<BrandLookPreviewResult> {
  return (await prepareBrandLookPreview(input)).materialize();
}

export async function rerollBrandLookPreviewItem(input: {
  userId: string;
  itemId: string;
  requestId: string;
  generator?: PreviewGenerator;
  beforeClaim?: () => Promise<void>;
}): Promise<BrandLookPreviewItem> {
  const requestId = parseBrandLookPreviewRequestId(input.requestId);
  if (!requestId) throw new Error("Preview reroll request id is required");
  const replay = await getBrandLookPreviewRerollReplay({
    userId: input.userId,
    itemId: input.itemId,
    requestId,
  });
  if (replay) return replay;
  const item = await prisma.brandLookPreviewItem.findFirst({
    where: { id: input.itemId, batch: { userId: input.userId } },
    include: { batch: { include: { user: { select: { plan: true } } } } },
  });
  if (!item) throw new Error("Brand preview item not found");
  const phase = item.phase as BrandLookPreviewPhase;
  if (!(["hook", "explain", "close"] as string[]).includes(phase)) throw new Error("Invalid preview phase");
  if (item.status !== "completed" && item.status !== "failed") {
    throw new Error("Brand preview reroll is already in progress");
  }
  const snapshot = JSON.parse(item.batch.sourceSnapshotJson) as {
    payload?: unknown;
    recipeVersion?: unknown;
    previewScenes?: PreviewScene[];
  };
  const payload = brandProfilePayloadSchema.parse(snapshot.payload);
  const recipeVersion = typeof snapshot.recipeVersion === "string" && snapshot.recipeVersion.trim()
    ? snapshot.recipeVersion.trim()
    : currentRecipeVersion(payload);
  const scene = snapshot.previewScenes?.find((candidate) => candidate.phase === phase)
    ?? standardPreviewScenes(payload).find((candidate) => candidate.phase === phase)!;
  const identityKey = previewIdentityKey(payload, recipeVersion);
  const compiled = compileBrandVisualPrompt({
    visualFormatId: payload.visual.primaryVisualFormatId,
    recipeVersion,
    contentDomain: scene.contentDomain,
    treatment: payload.visual.defaultTreatment,
    visualBeat: { ...scene.visualBeat, phase },
    brandVisualLanguage: brandVisualLanguageFor(payload),
  });
  const expectedImageJobId = item.aiGenerationJobId;
  const generator: PreviewGenerator = input.generator ?? (async ({ itemId, batchId, compiled: prompt }) => {
    const result = await generateHeroImageForVideo({
      userId: input.userId,
      plan: item.batch.user.plan,
      prompt: `${payload.niche} ${phase}`,
      idempotencyKey: rerollIdempotencyKey(batchId, phase, requestId),
      videoJobId: `brand-preview-${batchId}`,
      sceneIndex: phase === "hook" ? 0 : phase === "explain" ? 1 : 2,
      sceneTitle: `${payload.name} · ${phase} reroll`,
      brandVisualPrompt: { source: "brand-revision", compiled: prompt, identityKey },
      brandLookPreviewReservation: {
        itemId,
        expectedImageJobId,
      },
    });
    return { jobId: result.jobId, outputUrl: result.outputUrl };
  });
  await input.beforeClaim?.();
  const claimed = await prisma.$transaction(async (tx) => {
    const changed = await tx.brandLookPreviewItem.updateMany({
      where: {
        id: item.id,
        aiGenerationJobId: expectedImageJobId,
        status: item.status,
      },
      data: { status: "in_progress", errorCode: null },
    });
    if (changed.count !== 1) return false;
    await tx.brandLookPreviewBatch.update({
      where: { id: item.batchId },
      data: { status: "in_progress", finishedAt: null },
    });
    return true;
  });
  if (!claimed) {
    const racedReplay = await getBrandLookPreviewRerollReplay({
      userId: input.userId,
      itemId: item.id,
      requestId,
    });
    if (racedReplay) return racedReplay;
    throw new Error("Brand preview item changed concurrently; retry the same request id");
  }
  try {
    const generated = await generator({ itemId: item.id, phase, batchId: item.batchId, compiled });
    await prisma.$transaction(async (tx) => {
      await tx.brandLookPreviewItem.updateMany({
        where: {
          id: item.id,
          OR: [
            { aiGenerationJobId: generated.jobId },
            { aiGenerationJobId: expectedImageJobId },
          ],
        },
        data: {
          status: "completed",
          sourceType: "generated",
          outputUrl: generated.outputUrl,
          aiGenerationJobId: generated.jobId,
          errorCode: null,
        },
      });
      await refreshBrandLookPreviewBatchInTransaction(tx, item.batchId);
    });
    return prisma.brandLookPreviewItem.findFirstOrThrow({
      where: { id: item.id, batch: { userId: input.userId } },
    });
  } catch (error) {
    await prisma.$transaction(async (tx) => {
      await tx.brandLookPreviewItem.updateMany({
        where: {
          id: item.id,
          aiGenerationJobId: expectedImageJobId,
          status: "in_progress",
        },
        data: {
          status: item.outputUrl ? "completed" : "failed",
          errorCode: error instanceof Error && "code" in error
            ? String((error as Error & { code: unknown }).code).slice(0, 80)
            : "GENERATION_FAILED",
        },
      });
      await refreshBrandLookPreviewBatchInTransaction(tx, item.batchId);
    });
    throw error;
  }
}

/** Preview a not-yet-saved Project Look. The batch deliberately has no
 * BrandProfile FK, so closing the wizard cannot leave quota-consuming library
 * debris. Only the three generated image jobs consume entitlement. */
export async function prepareUnsavedBrandLookPreview(input: {
  userId: string;
  requestId: string;
  payload: BrandProfilePayload;
  projectId?: string;
  preflightId?: string;
  generator?: PreviewGenerator;
  reservation?: PreviewReservation;
}): Promise<PreparedBrandLookPreview> {
  const requestId = parseBrandLookPreviewRequestId(input.requestId);
  if (!requestId) throw new Error("Brand preview request id is required");
  const replay = await getBrandLookPreviewByRequestId({ userId: input.userId, requestId });
  if (replay) return preparedDurableReplay(replay, {
    reservation: input.reservation,
    generator: input.generator,
  });

  const payload = brandProfilePayloadSchema.parse(input.payload);
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { plan: true } });
  if (!user) throw new Error("User not found");
  const identityKey = previewIdentityKey(payload);
  const recipeVersion = currentRecipeVersion(payload);
  const fallbackScenes = standardPreviewScenes(payload);
  const projectPreview = await resolveProjectPreview({
    userId: input.userId,
    projectId: input.projectId,
    preflightId: input.preflightId,
    expectedIdentityKey: identityKey,
    fallbackScenes,
  });
  const previewScenes = projectPreview.scenes ?? fallbackScenes;
  const driver = previewGenerationDriver({
    userId: input.userId,
    plan: user.plan,
    payload,
    identityKey,
    source: "project-look",
    idempotencyPrefix: "brand-preview-unsaved",
  });
  return preparedMaterialization({
    userId: input.userId,
    requestId,
    refs: { projectId: input.projectId, preflightId: input.preflightId },
    payload,
    recipeVersion,
    previewScenes,
    source: "unsaved-project-look",
    existing: projectPreview.existing,
    reservation: input.reservation ?? (input.generator ? undefined : driver.reservation),
    generator: input.generator ?? driver.generator,
  });
}

export async function createUnsavedBrandLookPreview(input: {
  userId: string;
  requestId: string;
  payload: BrandProfilePayload;
  projectId?: string;
  preflightId?: string;
  generator?: PreviewGenerator;
  reservation?: PreviewReservation;
}): Promise<BrandLookPreviewResult> {
  return (await prepareUnsavedBrandLookPreview(input)).materialize();
}
