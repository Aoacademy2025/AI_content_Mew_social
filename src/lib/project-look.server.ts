import "server-only";

import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  VISUAL_FORMAT_IDS,
  brandLookIdentityKey,
  brandVisualIdentityKey,
  compileBrandVisualPrompt,
  type CompiledBrandVisualPrompt,
  type VisualBeat,
  type VisualFormatId,
} from "@/lib/brand-visual-system";
import {
  brandLanguageSchema,
  parseProjectLook,
  parseProjectVisualContext,
  parseRevision,
  projectLookInputSchema,
  projectVisualContextSchema,
  ProjectLookError,
  recipeFor,
  resolveProjectVisualContextFromSnapshots,
  treatmentFromPreflight,
  type ProjectLookInput,
  type ProjectLookSnapshot,
  type ProjectVisualContext,
} from "@/lib/project-visual-context";
import { prisma } from "@/lib/prisma";
import { reusableProjectVisualAssets } from "@/lib/project-visual-assets.server";
import { hydrateBrandVisualJobAcceptanceReuse } from "@/lib/brand-visual-job-acceptance.server";

const pendingUploadVisualContextSchema = z.discriminatedUnion("selection", [
  z.object({
    schemaVersion: z.literal(1),
    state: z.literal("awaiting-upload-preflight"),
    selection: z.literal("suggested"),
  }),
  z.object({
    schemaVersion: z.literal(1),
    state: z.literal("awaiting-upload-preflight"),
    selection: z.literal("brand-revision"),
    visualFormatId: z.enum(VISUAL_FORMAT_IDS),
    recipeVersion: z.string().min(1),
    brandVisualLanguage: brandLanguageSchema.nullable(),
  }),
]);

export type ProjectVisualApplyMode = "new-only" | "regenerate-all";

export {
  parseProjectVisualContext,
  projectLookInputSchema,
  ProjectLookError,
  resolveProjectVisualContextFromSnapshots,
  treatmentFromPreflight,
};
export type { ProjectLookInput, ProjectLookSnapshot, ProjectVisualContext };

function snapshotForLook(
  look: ProjectLookInput,
  brandRevisionJson: string | null | undefined,
): ProjectLookSnapshot {
  const parsed = projectLookInputSchema.safeParse(look);
  if (!parsed.success) {
    throw new ProjectLookError("INVALID_LOOK", parsed.error.issues[0]?.message || "ข้อมูลแนวภาพไม่ครบ");
  }
  const brandRecipe = parseRevision(brandRevisionJson);
  return {
    schemaVersion: 1,
    visualFormatId: parsed.data.visualFormatId,
    recipeVersion: recipeFor(parsed.data.visualFormatId),
    treatment: parsed.data.treatment,
    brandVisualLanguage: parsed.data.brandVisualLanguage === undefined
      ? (brandRecipe?.brandVisualLanguage ?? null)
      : parsed.data.brandVisualLanguage,
  };
}

async function saveProjectLookInTransaction(
  tx: Prisma.TransactionClient,
  input: { userId: string; projectId: string; look: ProjectLookInput },
): Promise<ProjectLookSnapshot> {
  const project = await tx.editorProject.findFirst({
    where: { id: input.projectId, userId: input.userId },
    include: { brandProfileRevision: { select: { visualRecipeJson: true } } },
  });
  if (!project) throw new ProjectLookError("NOT_FOUND", "ไม่พบโปรเจกต์นี้");
  const snapshot = snapshotForLook(input.look, project.brandProfileRevision?.visualRecipeJson);
  await tx.editorProject.update({
    where: { id: project.id },
    data: { projectLookJson: JSON.stringify(snapshot), projectLookUpdatedAt: new Date() },
  });
  return snapshot;
}

export async function saveProjectLook(input: {
  userId: string;
  projectId: string;
  look: ProjectLookInput;
}): Promise<ProjectLookSnapshot> {
  return prisma.$transaction((tx) => saveProjectLookInTransaction(tx, input));
}

/** Creator-facing Project Look mutation. Exact-preflight selection, selection
 * snapshot and asset invalidation commit together so quote/runtime can treat
 * ProjectVisualBeat.status as the authoritative reuse policy. */
export async function applyProjectLook(input: {
  userId: string;
  projectId: string;
  preflightId?: string;
  applyMode?: ProjectVisualApplyMode;
  look: ProjectLookInput;
}): Promise<{
  look: ProjectLookSnapshot;
  preflightId: string | null;
  existingImageCount: number;
  applyMode: ProjectVisualApplyMode | null;
}> {
  return prisma.$transaction(async (tx) => {
    const preflight = await tx.contentPreflight.findFirst({
      where: {
        userId: input.userId,
        projectId: input.projectId,
        ...(input.preflightId ? { id: input.preflightId } : {}),
      },
      orderBy: input.preflightId ? undefined : { createdAt: "desc" },
      include: { visualBeats: { select: { existingAssetUrl: true } } },
    });
    if (input.preflightId && !preflight) {
      throw new ProjectLookError("NOT_FOUND", "ไม่พบข้อมูลฉากชุดนี้");
    }
    if (!input.preflightId && preflight) {
      throw new ProjectLookError(
        "PREFLIGHT_REQUIRED",
        "กรุณาโหลดผลวิเคราะห์เนื้อหาเวอร์ชันปัจจุบันก่อนเปลี่ยนแนวภาพ",
        { currentPreflightId: preflight.id },
      );
    }
    const existingImageCount = preflight?.visualBeats
      .filter((beat) => Boolean(beat.existingAssetUrl)).length ?? 0;
    if (
      existingImageCount > 0
      && input.applyMode !== "new-only"
      && input.applyMode !== "regenerate-all"
    ) {
      throw new ProjectLookError(
        "LOOK_CHANGE_CONFIRMATION_REQUIRED",
        "กรุณาเลือกว่าจะเก็บภาพเดิมหรือสร้างใหม่ทั้งหมด",
        { existingImageCount },
      );
    }
    const look = await saveProjectLookInTransaction(tx, input);
    if (preflight) {
      const generationIdentityKey = brandVisualIdentityKey(look);
      await tx.projectVisualBeat.updateMany({
        where: { preflightId: preflight.id },
        data: input.applyMode === "regenerate-all"
          ? { generationIdentityKey, status: "outdated", outdatedAt: new Date() }
          : { generationIdentityKey },
      });
    }
    return {
      look,
      preflightId: preflight?.id ?? null,
      existingImageCount,
      applyMode: input.applyMode ?? null,
    };
  });
}

export async function clearProjectLook(input: { userId: string; projectId: string }): Promise<void> {
  const updated = await prisma.editorProject.updateMany({
    where: { id: input.projectId, userId: input.userId },
    data: { projectLookJson: null, projectLookUpdatedAt: new Date() },
  });
  if (updated.count !== 1) throw new ProjectLookError("NOT_FOUND", "ไม่พบโปรเจกต์นี้");
}

/** A persisted selection survives plan downgrade and feature rollback. This
 * check grants no mutation/adoption rights; it only lets VideoJob acceptance
 * preserve the exact context an existing project already owns. */
export async function projectHasPersistedVisualPin(input: {
  userId: string;
  projectId: string;
}): Promise<boolean> {
  const project = await prisma.editorProject.findFirst({
    where: { id: input.projectId, userId: input.userId },
    select: { projectLookJson: true, brandProfileRevisionId: true },
  });
  if (!project) throw new ProjectLookError("NOT_FOUND", "ไม่พบโปรเจกต์นี้");
  return Boolean(project.projectLookJson || project.brandProfileRevisionId);
}

export async function resolveProjectVisualContext(input: {
  userId: string;
  projectId: string;
  suggested: { visualFormatId: VisualFormatId; treatment: string };
}): Promise<ProjectVisualContext> {
  const project = await prisma.editorProject.findFirst({
    where: { id: input.projectId, userId: input.userId },
    select: {
      projectLookJson: true,
      brandProfileRevision: { select: { visualRecipeJson: true } },
    },
  });
  if (!project) throw new ProjectLookError("NOT_FOUND", "ไม่พบโปรเจกต์นี้");
  return resolveProjectVisualContextFromSnapshots({
    projectLookJson: project.projectLookJson,
    brandProfileRevisionRecipeJson: project.brandProfileRevision?.visualRecipeJson,
    suggested: input.suggested,
  });
}

export type ProjectVisualPin = {
  contentPreflightId: string | null;
  projectVisualContextJson: string;
};

/** Advance carried assets to the identity accepted for this exact preflight.
 * A non-null different identity proves that the image was rendered under an
 * older format/treatment/language, so it must be regenerated. Legacy null
 * identities remain compatible and are claimed by the current context. */
async function advancePreflightVisualIdentity(input: {
  userId: string;
  preflightId: string;
  context: ProjectVisualContext;
}): Promise<void> {
  const generationIdentityKey = brandVisualIdentityKey(input.context);
  await prisma.$transaction([
    prisma.projectVisualBeat.updateMany({
      where: {
        preflightId: input.preflightId,
        userId: input.userId,
        generationIdentityKey: { not: null, notIn: [generationIdentityKey] },
        OR: [
          { existingAssetUrl: { not: null } },
          { existingImageJobId: { not: null } },
        ],
      },
      data: {
        generationIdentityKey,
        status: "outdated",
        outdatedAt: new Date(),
      },
    }),
    prisma.projectVisualBeat.updateMany({
      where: {
        preflightId: input.preflightId,
        userId: input.userId,
        OR: [
          { generationIdentityKey: null },
          { generationIdentityKey: { not: generationIdentityKey } },
        ],
      },
      data: { generationIdentityKey },
    }),
  ]);
}

/** Freeze both inputs used by scene compilation at the VideoJob boundary.
 * ContentPreflight rows are immutable per source hash; the context JSON copies
 * the selected recipe/treatment/language so later project/profile edits cannot
 * change an already accepted render. */
export async function prepareProjectVisualPin(input: {
  userId: string;
  projectId: string;
  preflightId?: string;
  /** Candidate hashes for the narrative accepted by this job. Supplying this
   * list fails closed instead of falling back to another tab's latest row. */
  sourceHashes?: string[];
}): Promise<ProjectVisualPin> {
  const sourceHashes = input.sourceHashes === undefined
    ? undefined
    : [...new Set(input.sourceHashes.map((value) => value.trim()).filter(Boolean))];
  const preflight = await prisma.contentPreflight.findFirst({
    where: {
      userId: input.userId,
      projectId: input.projectId,
      ...(input.preflightId ? { id: input.preflightId } : {}),
      ...(sourceHashes !== undefined
        ? { sourceHash: { in: sourceHashes } }
        : {}),
    },
    orderBy: input.preflightId ? undefined : { createdAt: "desc" },
    include: { visualBeats: { select: { id: true }, take: 1 } },
  });
  if (!preflight) {
    throw new ProjectLookError(
      "PREFLIGHT_REQUIRED",
      "กรุณารอให้ AI เตรียมแนวภาพและฉากก่อนเริ่มสร้างภาพ",
    );
  }
  if (
    preflight.visualBeats.length === 0
    || !VISUAL_FORMAT_IDS.includes(preflight.suggestedVisualFormatId as VisualFormatId)
  ) {
    throw new ProjectLookError(
      "PREFLIGHT_INCOMPLETE",
      "ผลวิเคราะห์ยังไม่มีฉากที่ใช้สร้างภาพได้",
    );
  }
  const context = await resolveProjectVisualContext({
    userId: input.userId,
    projectId: input.projectId,
    suggested: {
      visualFormatId: preflight.suggestedVisualFormatId as VisualFormatId,
      treatment: treatmentFromPreflight(preflight.suggestedTreatmentJson),
    },
  });
  await advancePreflightVisualIdentity({
    userId: input.userId,
    preflightId: preflight.id,
    context,
  });
  return {
    contentPreflightId: preflight.id,
    projectVisualContextJson: JSON.stringify(projectVisualContextSchema.parse(context)),
  };
}

/** Uploads have no transcript/preflight at acceptance time. Snapshot an
 * explicit Project Look/Brand Revision immediately; if the project still uses
 * AI suggestion, persist only that selection mode so the eventual transcript
 * supplies the suggestion without consulting mutable project state again. */
export async function prepareUploadProjectVisualSnapshot(input: {
  userId: string;
  projectId: string;
}): Promise<ProjectVisualPin> {
  const context = await resolveProjectVisualContext({
    userId: input.userId,
    projectId: input.projectId,
    suggested: { visualFormatId: "clear-infographic", treatment: "pending upload transcript" },
  });
  const snapshot = context.source === "suggested"
    ? {
        schemaVersion: 1 as const,
        state: "awaiting-upload-preflight" as const,
        selection: "suggested" as const,
      }
    : context.source === "brand-revision"
      ? {
          schemaVersion: 1 as const,
          state: "awaiting-upload-preflight" as const,
          selection: "brand-revision" as const,
          visualFormatId: context.visualFormatId,
          recipeVersion: context.recipeVersion,
          brandVisualLanguage: context.brandVisualLanguage,
        }
      : context;
  return {
    contentPreflightId: null,
    projectVisualContextJson: JSON.stringify(snapshot),
  };
}

export async function pinProjectVisualContextToVideoJob(input: {
  userId: string;
  projectId: string;
  videoJobId: string;
  preflightId: string;
}): Promise<ProjectVisualPin> {
  const job = await prisma.videoJob.findFirst({
    where: { id: input.videoJobId, userId: input.userId, projectId: input.projectId },
    select: { contentPreflightId: true, projectVisualContextJson: true },
  });
  if (!job) throw new ProjectLookError("NOT_FOUND", "ไม่พบ VideoJob ที่ต้องการ pin แนวภาพ");
  const alreadyPinned = parseProjectVisualContext(job.projectVisualContextJson);
  if (job.contentPreflightId) {
    if (job.contentPreflightId !== input.preflightId) {
      throw new ProjectLookError(
        "PREFLIGHT_INCOMPLETE",
        "งานสร้างคลิปผูกกับข้อมูลฉากคนละชุดแล้ว",
      );
    }
    if (!alreadyPinned) {
      throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "snapshot แนวภาพที่ pin ไว้อ่านไม่ได้");
    }
    await hydrateBrandVisualJobAcceptanceReuse(input);
    return {
      contentPreflightId: job.contentPreflightId,
      projectVisualContextJson: job.projectVisualContextJson!,
    };
  }
  if (!job.projectVisualContextJson) {
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "VideoJob ไม่มี snapshot แนวภาพตอนรับงาน");
  }

  const preflight = await prisma.contentPreflight.findFirst({
    where: {
      id: input.preflightId,
      userId: input.userId,
      projectId: input.projectId,
    },
    include: { visualBeats: { select: { id: true }, take: 1 } },
  });
  if (!preflight) {
    throw new ProjectLookError("PREFLIGHT_REQUIRED", "ไม่พบผลวิเคราะห์ transcript ที่งานนี้ต้องใช้");
  }
  if (
    preflight.visualBeats.length === 0
    || !VISUAL_FORMAT_IDS.includes(preflight.suggestedVisualFormatId as VisualFormatId)
  ) {
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ผลวิเคราะห์เสียงพูดยังไม่มีฉากที่ใช้ได้");
  }

  let context = alreadyPinned;
  if (!context) {
    let pendingValue: unknown = null;
    try {
      pendingValue = JSON.parse(job.projectVisualContextJson);
    } catch {}
    const pending = pendingUploadVisualContextSchema.safeParse(pendingValue);
    if (!pending.success) {
      throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "snapshot แนวภาพของ VideoJob อ่านไม่ได้");
    }
    const treatment = treatmentFromPreflight(preflight.suggestedTreatmentJson);
    context = pending.data.selection === "brand-revision"
      ? {
          source: "brand-revision",
          visualFormatId: pending.data.visualFormatId,
          recipeVersion: pending.data.recipeVersion,
          treatment,
          brandVisualLanguage: pending.data.brandVisualLanguage,
        }
      : {
          source: "suggested",
          visualFormatId: preflight.suggestedVisualFormatId as VisualFormatId,
          recipeVersion: recipeFor(preflight.suggestedVisualFormatId as VisualFormatId),
          treatment,
          brandVisualLanguage: null,
        };
  }
  const pin = {
    contentPreflightId: preflight.id,
    projectVisualContextJson: JSON.stringify(projectVisualContextSchema.parse(context)),
  };
  await advancePreflightVisualIdentity({
    userId: input.userId,
    preflightId: preflight.id,
    context,
  });
  const updated = await prisma.videoJob.updateMany({
    where: {
      id: input.videoJobId,
      userId: input.userId,
      projectId: input.projectId,
      contentPreflightId: null,
      projectVisualContextJson: job.projectVisualContextJson,
    },
    data: pin,
  });
  if (updated.count !== 1) {
    const existing = await prisma.videoJob.findFirst({
      where: { id: input.videoJobId, userId: input.userId, projectId: input.projectId },
      select: { contentPreflightId: true, projectVisualContextJson: true },
    });
    if (existing?.contentPreflightId && existing.projectVisualContextJson) {
      if (existing.contentPreflightId !== input.preflightId) {
        throw new ProjectLookError(
          "PREFLIGHT_INCOMPLETE",
          "งานสร้างคลิปผูกกับข้อมูลฉากคนละชุดแล้ว",
        );
      }
      if (!parseProjectVisualContext(existing.projectVisualContextJson)) {
        throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "snapshot แนวภาพที่ pin ไว้อ่านไม่ได้");
      }
      await hydrateBrandVisualJobAcceptanceReuse(input);
      return {
        contentPreflightId: existing.contentPreflightId,
        projectVisualContextJson: existing.projectVisualContextJson,
      };
    }
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "VideoJob ถูกแก้ไขก่อน pin แนวภาพสำเร็จ");
  }
  await hydrateBrandVisualJobAcceptanceReuse(input);
  return pin;
}

/** Reuse quote for one exact Content Preflight. ProjectVisualBeat.status is the
 * apply-mode policy: new-only keeps old-style assets current; regenerate-all
 * makes them outdated. Only successfully settled durable jobs are reusable. */
export async function reusableProjectVisualBeatSceneIndices(input: {
  userId: string;
  projectId: string;
  preflightId: string;
}): Promise<number[]> {
  return (await reusableProjectVisualAssets(input)).map((asset) => asset.sceneIndex);
}

export type ResolvedProjectVisualPrompt = {
  projectId: string;
  visualBeatId: string;
  source: ProjectVisualContext["source"];
  identityKey: string;
  lookIdentityKey: string;
  compiled: CompiledBrandVisualPrompt;
};

/** Resolve the durable project/preflight seam from a video job. Legacy or
 * non-project jobs return null; an incomplete/corrupt durable pin fails closed. */
export async function resolveProjectVisualPromptForVideoScene(input: {
  userId: string;
  videoJobId: string;
  sceneIndex: number;
}): Promise<ResolvedProjectVisualPrompt | null> {
  const job = await prisma.videoJob.findFirst({
    where: { id: input.videoJobId, userId: input.userId },
    select: {
      projectId: true,
      contentPreflightId: true,
      projectVisualContextJson: true,
    },
  });
  if (!job?.projectId || !job.projectVisualContextJson) return null;
  const context = parseProjectVisualContext(job.projectVisualContextJson);
  if (!context || !job.contentPreflightId) {
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "VideoJob ไม่มี snapshot แนวภาพที่สมบูรณ์");
  }
  const preflight = await prisma.contentPreflight.findFirst({
    where: { id: job.contentPreflightId, projectId: job.projectId, userId: input.userId },
    select: {
      id: true,
      contentDomain: true,
    },
  });
  if (!preflight) {
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ไม่พบข้อมูลฉากที่ผูกกับงานสร้างคลิปนี้");
  }
  const beats = await prisma.projectVisualBeat.findMany({
    where: { preflightId: preflight.id, userId: input.userId },
    orderBy: { sequence: "asc" },
  });
  if (beats.length === 0) {
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ข้อมูลที่ผูกกับงานสร้างคลิปนี้ไม่มีฉาก");
  }
  const exactBeat = beats.find((candidate) => candidate.sequence === input.sceneIndex);
  if (!exactBeat) {
    throw new ProjectLookError(
      "PREFLIGHT_INCOMPLETE",
      `ไม่พบข้อมูลภาพสำหรับฉากที่ ${input.sceneIndex + 1}`,
    );
  }
  const beat = exactBeat;
  let beatValue: Omit<VisualBeat, "phase">;
  try {
    beatValue = JSON.parse(beat.beatJson) as Omit<VisualBeat, "phase">;
  } catch {
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ข้อมูลภาพของฉากนี้อ่านไม่ได้");
  }
  if (!beatValue.subject || !beatValue.action || !beatValue.setting || !beatValue.emotion || !beatValue.emphasis) {
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ข้อมูลภาพของฉากนี้ไม่ครบ");
  }
  const phase: VisualBeat["phase"] = beat.sequence === beats[0].sequence
    ? "hook"
    : beat.sequence === beats[beats.length - 1].sequence ? "close" : "explain";
  return {
    projectId: job.projectId,
    visualBeatId: beat.id,
    source: context.source,
    identityKey: brandVisualIdentityKey(context),
    lookIdentityKey: brandLookIdentityKey(context),
    compiled: compileBrandVisualPrompt({
      visualFormatId: context.visualFormatId,
      recipeVersion: context.recipeVersion,
      contentDomain: preflight.contentDomain,
      treatment: context.treatment,
      brandVisualLanguage: context.brandVisualLanguage,
      visualBeat: { ...beatValue, phase },
    }),
  };
}
