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
import { generateHeroImageForVideo } from "@/lib/video-hero-image.server";

export type BrandLookPreviewPhase = "hook" | "explain" | "close";
type PreviewScene = {
  phase: BrandLookPreviewPhase;
  contentDomain: string;
  visualBeat: Omit<VisualBeat, "phase">;
};
type PreviewGenerator = (input: {
  itemId: string;
  phase: BrandLookPreviewPhase;
  batchId: string;
  compiled: ReturnType<typeof compileBrandVisualPrompt>;
}) => Promise<{ jobId: string; outputUrl: string }>;

export type BrandLookPreviewResult = BrandLookPreviewBatch & { items: BrandLookPreviewItem[] };

function brandVisualLanguageFor(payload: BrandProfilePayload): BrandVisualLanguage {
  return {
    palette: payload.visual.palette,
    personality: payload.visual.personality,
    peopleAndSetting: payload.visual.peopleAndSetting,
    memorableCues: payload.visual.memorableCues,
    visualNotes: payload.visual.visualNotes,
  };
}

function previewIdentityKey(payload: BrandProfilePayload): string {
  const format = VISUAL_FORMATS.find((candidate) => candidate.id === payload.visual.primaryVisualFormatId);
  if (!format) throw new Error("Unsupported Visual Format");
  return brandVisualIdentityKey({
    visualFormatId: format.id,
    recipeVersion: format.recipeVersion,
    treatment: payload.visual.defaultTreatment,
    brandVisualLanguage: brandVisualLanguageFor(payload),
  });
}

/** Product previews represent the creator's niche. The fixed history/health/
 * commerce matrix belongs exclusively to the 21-image Quality Gate. */
function standardPreviewScenes(payload: BrandProfilePayload): PreviewScene[] {
  const contentDomain = `${payload.niche} for ${payload.audience}`;
  return [
    {
      phase: "hook",
      contentDomain,
      visualBeat: {
        subject: `one member of ${payload.audience} facing a recognizable ${payload.niche} turning point`,
        action: "pauses as one concrete problem becomes impossible to ignore",
        setting: `an authentic everyday environment connected to ${payload.niche}`,
        emotion: "immediate curiosity and useful tension",
        emphasis: "the single problem this story will resolve",
      },
    },
    {
      phase: "explain",
      contentDomain,
      visualBeat: {
        subject: `a trusted ${payload.niche} guide and three concrete cause-and-effect objects for ${payload.audience}`,
        action: "demonstrates one clear relationship between the objects",
        setting: `a practical working environment connected to ${payload.niche}`,
        emotion: "calm confidence and clarity",
        emphasis: "the one relationship that makes the lesson understandable",
      },
    },
    {
      phase: "close",
      contentDomain,
      visualBeat: {
        subject: `the same member of ${payload.audience} with one useful ${payload.niche} outcome`,
        action: "takes one confident next action toward the outcome",
        setting: `the same authentic ${payload.niche} world now opened toward forward motion`,
        emotion: "earned optimism and momentum",
        emphasis: "the concrete next action the audience can picture taking",
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
  expectedIdentityKey: string;
  fallbackScenes: PreviewScene[];
}): Promise<{
  existing: readonly [string, string, string] | null;
  scenes: PreviewScene[] | null;
}> {
  if (!input.projectId) return { existing: null, scenes: null };
  const project = await prisma.editorProject.findFirst({
    where: { id: input.projectId, userId: input.userId },
    select: { id: true },
  });
  if (!project) throw new Error("Project not found");
  const latest = await prisma.contentPreflight.findFirst({
    where: { projectId: project.id, userId: input.userId },
    orderBy: { createdAt: "desc" },
    include: { visualBeats: { orderBy: { sequence: "asc" } } },
  });
  const selected = representativeRows(latest?.visualBeats ?? []);
  if (!latest || !selected) return { existing: null, scenes: null };
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
  const urls = selected.map((beat) => beat.existingAssetUrl);
  const jobIds = selected.map((beat) => beat.existingImageJobId);
  let existing: readonly [string, string, string] | null = null;
  if (
    urls.every((url): url is string => typeof url === "string" && Boolean(url.trim()))
    && jobIds.every((jobId): jobId is string => typeof jobId === "string" && Boolean(jobId.trim()))
  ) {
    const jobs = await prisma.aiGenerationJob.findMany({
      where: { userId: input.userId, id: { in: jobIds } },
      select: { id: true, inputJson: true },
    });
    const identities = new Map(jobs.map((job) => [job.id, jobIdentityKey(job.inputJson)]));
    if (jobIds.every((jobId) => identities.get(jobId) === input.expectedIdentityKey)) {
      existing = urls as [string, string, string];
    }
  }
  return { existing, scenes };
}

export async function brandLookPreviewRequiresGeneration(input: {
  userId: string;
  projectId?: string;
  payload?: BrandProfilePayload;
  profileId?: string;
  useDraft?: boolean;
}): Promise<boolean> {
  if (!input.projectId) return true;
  let payload = input.payload ? brandProfilePayloadSchema.parse(input.payload) : null;
  if (!payload && input.profileId) {
    const profile = await prisma.brandProfile.findFirst({
      where: { id: input.profileId, userId: input.userId },
      include: { draft: true, revisions: { orderBy: { version: "desc" }, take: 1 } },
    });
    const sourceJson = input.useDraft ? profile?.draft?.payloadJson : profile?.revisions[0]?.payloadJson;
    if (!sourceJson) return true;
    payload = brandProfilePayloadSchema.parse(JSON.parse(sourceJson));
  }
  if (!payload) return true;
  const fallbackScenes = standardPreviewScenes(payload);
  return !(await resolveProjectPreview({
    userId: input.userId,
    projectId: input.projectId,
    expectedIdentityKey: previewIdentityKey(payload),
    fallbackScenes,
  })).existing;
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

export async function createBrandLookPreview(input: {
  userId: string;
  profileId: string;
  projectId?: string;
  useDraft?: boolean;
  generator?: PreviewGenerator;
}): Promise<BrandLookPreviewResult> {
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

  const brandVisualLanguage = brandVisualLanguageFor(payload);
  const identityKey = previewIdentityKey(payload);
  const fallbackScenes = standardPreviewScenes(payload);
  const projectPreview = await resolveProjectPreview({
    userId: input.userId,
    projectId: input.projectId,
    expectedIdentityKey: identityKey,
    fallbackScenes,
  });
  const existing = projectPreview.existing;
  const previewScenes = projectPreview.scenes ?? fallbackScenes;

  const phases = ["hook", "explain", "close"] as const;
  if (existing) {
    return prisma.brandLookPreviewBatch.create({
      data: {
        userId: input.userId,
        projectId: input.projectId,
        brandProfileId: profile.id,
        brandProfileDraftId: input.useDraft ? profile.draft?.id : null,
        brandProfileRevisionId: input.useDraft ? null : profile.revisions[0]?.id,
        status: "completed",
        finishedAt: new Date(),
        sourceSnapshotJson: JSON.stringify({ payload, previewScenes, source: "project-assets" }),
        items: {
          create: phases.map((phase, index) => ({
            phase,
            sourceType: "reused",
            outputUrl: existing![index],
            status: "completed",
          })),
        },
      },
      include: { items: { orderBy: { createdAt: "asc" } } },
    });
  }

  const batch = await prisma.brandLookPreviewBatch.create({
    data: {
      userId: input.userId,
      projectId: input.projectId,
      brandProfileId: profile.id,
      brandProfileDraftId: input.useDraft ? profile.draft?.id : null,
      brandProfileRevisionId: input.useDraft ? null : profile.revisions[0]?.id,
      status: "in_progress",
      sourceSnapshotJson: JSON.stringify({ payload, previewScenes, source: input.useDraft ? "draft" : "revision" }),
      items: { create: phases.map((phase) => ({ phase, sourceType: "generated", status: "queued" })) },
    },
    include: { items: true },
  });

  const generator: PreviewGenerator = input.generator ?? (async ({ itemId, phase, batchId, compiled }) => {
    const sceneIndex = phases.indexOf(phase);
    const result = await generateHeroImageForVideo({
      userId: input.userId,
      plan: profile.user.plan,
      prompt: `${payload.niche} ${phase}`,
      idempotencyKey: `brand-preview:${batchId}:${phase}`,
      videoJobId: `brand-preview-${batchId}`,
      sceneIndex,
      sceneTitle: `${payload.name} · ${phase}`,
      brandVisualPrompt: { source: "brand-revision", compiled, identityKey },
      brandLookPreviewReservation: { itemId, expectedImageJobId: null },
    });
    return { jobId: result.jobId, outputUrl: result.outputUrl };
  });

  await Promise.all(batch.items.map(async (item) => {
    const phase = item.phase as BrandLookPreviewPhase;
    const scene = previewScenes.find((candidate) => candidate.phase === phase)!;
    const compiled = compileBrandVisualPrompt({
      visualFormatId: payload.visual.primaryVisualFormatId,
      contentDomain: scene.contentDomain,
      treatment: payload.visual.defaultTreatment,
      visualBeat: { ...scene.visualBeat, phase },
      brandVisualLanguage,
    });
    await prisma.brandLookPreviewItem.update({ where: { id: item.id }, data: { status: "in_progress" } });
    try {
      const generated = await generator({ itemId: item.id, phase, batchId: batch.id, compiled });
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
      await prisma.brandLookPreviewItem.update({
        where: { id: item.id },
        data: {
          status: "failed",
          errorCode: error instanceof Error && "code" in error
            ? String((error as Error & { code: unknown }).code).slice(0, 80)
            : "GENERATION_FAILED",
        },
      });
    }
  }));
  const items = await prisma.brandLookPreviewItem.findMany({
    where: { batchId: batch.id },
    orderBy: { createdAt: "asc" },
  });
  const completed = items.filter((item) => item.status === "completed").length;
  const status = completed === items.length ? "completed" : completed > 0 ? "partial" : "failed";
  return prisma.brandLookPreviewBatch.update({
    where: { id: batch.id },
    data: { status, finishedAt: new Date() },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
}

export async function rerollBrandLookPreviewItem(input: {
  userId: string;
  itemId: string;
  requestId: string;
  generator?: PreviewGenerator;
}): Promise<BrandLookPreviewItem> {
  const item = await prisma.brandLookPreviewItem.findFirst({
    where: { id: input.itemId, batch: { userId: input.userId } },
    include: { batch: { include: { user: { select: { plan: true } } } } },
  });
  if (!item) throw new Error("Brand preview item not found");
  const phase = item.phase as BrandLookPreviewPhase;
  if (!(["hook", "explain", "close"] as string[]).includes(phase)) throw new Error("Invalid preview phase");
  const snapshot = JSON.parse(item.batch.sourceSnapshotJson) as {
    payload?: unknown;
    previewScenes?: PreviewScene[];
  };
  const payload = brandProfilePayloadSchema.parse(snapshot.payload);
  const scene = snapshot.previewScenes?.find((candidate) => candidate.phase === phase)
    ?? standardPreviewScenes(payload).find((candidate) => candidate.phase === phase)!;
  const identityKey = previewIdentityKey(payload);
  const compiled = compileBrandVisualPrompt({
    visualFormatId: payload.visual.primaryVisualFormatId,
    contentDomain: scene.contentDomain,
    treatment: payload.visual.defaultTreatment,
    visualBeat: { ...scene.visualBeat, phase },
    brandVisualLanguage: brandVisualLanguageFor(payload),
  });
  const requestId = input.requestId.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80);
  if (!requestId) throw new Error("Preview reroll request id is required");
  const generator: PreviewGenerator = input.generator ?? (async ({ itemId, batchId, compiled: prompt }) => {
    const result = await generateHeroImageForVideo({
      userId: input.userId,
      plan: item.batch.user.plan,
      prompt: `${payload.niche} ${phase}`,
      idempotencyKey: `brand-preview-reroll:${batchId}:${phase}:${requestId}`,
      videoJobId: `brand-preview-${batchId}`,
      sceneIndex: phase === "hook" ? 0 : phase === "explain" ? 1 : 2,
      sceneTitle: `${payload.name} · ${phase} reroll`,
      brandVisualPrompt: { source: "brand-revision", compiled: prompt, identityKey },
      brandLookPreviewReservation: {
        itemId,
        expectedImageJobId: item.aiGenerationJobId,
      },
    });
    return { jobId: result.jobId, outputUrl: result.outputUrl };
  });
  await prisma.brandLookPreviewItem.update({
    where: { id: item.id },
    data: { status: "in_progress", errorCode: null },
  });
  try {
    const generated = await generator({ itemId: item.id, phase, batchId: item.batchId, compiled });
    const updated = await prisma.brandLookPreviewItem.update({
      where: { id: item.id },
      data: {
        status: "completed",
        sourceType: "generated",
        outputUrl: generated.outputUrl,
        aiGenerationJobId: generated.jobId,
        errorCode: null,
      },
    });
    const remaining = await prisma.brandLookPreviewItem.count({
      where: { batchId: item.batchId, status: { not: "completed" } },
    });
    if (remaining === 0) {
      await prisma.brandLookPreviewBatch.update({
        where: { id: item.batchId },
        data: { status: "completed", finishedAt: new Date() },
      });
    }
    return updated;
  } catch (error) {
    await prisma.brandLookPreviewItem.update({
      where: { id: item.id },
      data: {
        status: item.outputUrl ? "completed" : "failed",
        errorCode: error instanceof Error && "code" in error
          ? String((error as Error & { code: unknown }).code).slice(0, 80)
          : "GENERATION_FAILED",
      },
    });
    throw error;
  }
}

/** Preview a not-yet-saved Project Look. The batch deliberately has no
 * BrandProfile FK, so closing the wizard cannot leave quota-consuming library
 * debris. Only the three generated image jobs consume entitlement. */
export async function createUnsavedBrandLookPreview(input: {
  userId: string;
  payload: BrandProfilePayload;
  projectId?: string;
  generator?: PreviewGenerator;
}): Promise<BrandLookPreviewResult> {
  const payload = brandProfilePayloadSchema.parse(input.payload);
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { plan: true } });
  if (!user) throw new Error("User not found");
  const phases = ["hook", "explain", "close"] as const;
  const identityKey = previewIdentityKey(payload);
  const fallbackScenes = standardPreviewScenes(payload);
  const projectPreview = await resolveProjectPreview({
    userId: input.userId,
    projectId: input.projectId,
    expectedIdentityKey: identityKey,
    fallbackScenes,
  });
  const previewScenes = projectPreview.scenes ?? fallbackScenes;
  if (projectPreview.existing) {
    return prisma.brandLookPreviewBatch.create({
      data: {
        userId: input.userId,
        projectId: input.projectId,
        status: "completed",
        finishedAt: new Date(),
        sourceSnapshotJson: JSON.stringify({ payload, previewScenes, source: "unsaved-project-assets" }),
        items: {
          create: phases.map((phase, index) => ({
            phase,
            sourceType: "reused",
            outputUrl: projectPreview.existing![index],
            status: "completed",
          })),
        },
      },
      include: { items: { orderBy: { createdAt: "asc" } } },
    });
  }
  const batch = await prisma.brandLookPreviewBatch.create({
    data: {
      userId: input.userId,
      projectId: input.projectId,
      status: "in_progress",
      sourceSnapshotJson: JSON.stringify({ payload, previewScenes, source: "unsaved-project-look" }),
      items: { create: phases.map((phase) => ({ phase, sourceType: "generated", status: "queued" })) },
    },
    include: { items: true },
  });
  const generator: PreviewGenerator = input.generator ?? (async ({ itemId, phase, batchId, compiled }) => {
    const result = await generateHeroImageForVideo({
      userId: input.userId,
      plan: user.plan,
      prompt: `${payload.niche} ${phase}`,
      idempotencyKey: `brand-preview-unsaved:${batchId}:${phase}`,
      videoJobId: `brand-preview-${batchId}`,
      sceneIndex: phases.indexOf(phase),
      sceneTitle: `${payload.name} · ${phase}`,
      brandVisualPrompt: { source: "project-look", compiled, identityKey },
      brandLookPreviewReservation: { itemId, expectedImageJobId: null },
    });
    return { jobId: result.jobId, outputUrl: result.outputUrl };
  });
  await Promise.all(batch.items.map(async (item) => {
    const phase = item.phase as BrandLookPreviewPhase;
    const scene = previewScenes.find((candidate) => candidate.phase === phase)!;
    const compiled = compileBrandVisualPrompt({
      visualFormatId: payload.visual.primaryVisualFormatId,
      contentDomain: scene.contentDomain,
      treatment: payload.visual.defaultTreatment,
      visualBeat: { ...scene.visualBeat, phase },
      brandVisualLanguage: brandVisualLanguageFor(payload),
    });
    await prisma.brandLookPreviewItem.update({ where: { id: item.id }, data: { status: "in_progress" } });
    try {
      const generated = await generator({ itemId: item.id, phase, batchId: batch.id, compiled });
      await prisma.brandLookPreviewItem.update({
        where: { id: item.id },
        data: { status: "completed", outputUrl: generated.outputUrl, aiGenerationJobId: generated.jobId },
      });
    } catch (error) {
      await prisma.brandLookPreviewItem.update({
        where: { id: item.id },
        data: {
          status: "failed",
          errorCode: error instanceof Error && "code" in error
            ? String((error as Error & { code: unknown }).code).slice(0, 80)
            : "GENERATION_FAILED",
        },
      });
    }
  }));
  const items = await prisma.brandLookPreviewItem.findMany({ where: { batchId: batch.id } });
  const completed = items.filter((item) => item.status === "completed").length;
  return prisma.brandLookPreviewBatch.update({
    where: { id: batch.id },
    data: {
      status: completed === 3 ? "completed" : completed > 0 ? "partial" : "failed",
      finishedAt: new Date(),
    },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
}
