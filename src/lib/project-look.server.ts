import "server-only";

import { z } from "zod";
import {
  VISUAL_FORMATS,
  VISUAL_FORMAT_IDS,
  brandVisualIdentityKey,
  compileBrandVisualPrompt,
  type BrandVisualLanguage,
  type CompiledBrandVisualPrompt,
  type VisualBeat,
  type VisualFormatId,
} from "@/lib/brand-visual-system";
import { prisma } from "@/lib/prisma";

const brandLanguageSchema = z.object({
  palette: z.array(z.string().trim().min(1).max(64)).min(1).max(6),
  personality: z.string().trim().min(1).max(500),
  peopleAndSetting: z.string().trim().max(500).nullable().optional(),
  memorableCues: z.array(z.string().trim().min(1).max(160)).max(6),
  visualNotes: z.string().trim().max(800).nullable().optional(),
});

export const projectLookInputSchema = z.object({
  visualFormatId: z.enum(VISUAL_FORMAT_IDS),
  treatment: z.string().trim().min(1).max(300),
  brandVisualLanguage: brandLanguageSchema.nullable().optional(),
});

const projectLookSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  visualFormatId: z.enum(VISUAL_FORMAT_IDS),
  recipeVersion: z.string().min(1),
  treatment: z.string().min(1),
  brandVisualLanguage: brandLanguageSchema.nullable(),
});

const revisionRecipeSchema = z.object({
  visualFormatId: z.enum(VISUAL_FORMAT_IDS),
  recipeVersion: z.string().min(1),
  brandVisualLanguage: brandLanguageSchema.nullable().optional(),
  defaultTreatment: z.string().min(1),
});

export type ProjectLookInput = z.infer<typeof projectLookInputSchema>;
export type ProjectLookSnapshot = z.infer<typeof projectLookSnapshotSchema>;
export type ProjectVisualContext = {
  source: "project-look" | "brand-revision" | "suggested";
  visualFormatId: VisualFormatId;
  recipeVersion: string;
  treatment: string;
  brandVisualLanguage: BrandVisualLanguage | null;
};

export class ProjectLookError extends Error {
  constructor(readonly code: "NOT_FOUND" | "INVALID_LOOK", message: string) {
    super(message);
    this.name = "ProjectLookError";
  }
}

function recipeFor(formatId: VisualFormatId) {
  const format = VISUAL_FORMATS.find((item) => item.id === formatId);
  if (!format) throw new ProjectLookError("INVALID_LOOK", "แนวภาพนี้ไม่อยู่ใน V1");
  return format.recipeVersion;
}

function parseRevision(value: string | null | undefined) {
  if (!value) return null;
  try {
    return revisionRecipeSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseProjectLook(value: string | null | undefined) {
  if (!value) return null;
  try {
    return projectLookSnapshotSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

export async function saveProjectLook(input: {
  userId: string;
  projectId: string;
  look: ProjectLookInput;
}): Promise<ProjectLookSnapshot> {
  const parsed = projectLookInputSchema.safeParse(input.look);
  if (!parsed.success) {
    throw new ProjectLookError("INVALID_LOOK", parsed.error.issues[0]?.message || "ข้อมูลแนวภาพไม่ครบ");
  }
  const project = await prisma.editorProject.findFirst({
    where: { id: input.projectId, userId: input.userId },
    include: { brandProfileRevision: { select: { visualRecipeJson: true } } },
  });
  if (!project) throw new ProjectLookError("NOT_FOUND", "ไม่พบโปรเจกต์นี้");
  const brandRecipe = parseRevision(project.brandProfileRevision?.visualRecipeJson);
  const snapshot: ProjectLookSnapshot = {
    schemaVersion: 1,
    visualFormatId: parsed.data.visualFormatId,
    recipeVersion: recipeFor(parsed.data.visualFormatId),
    treatment: parsed.data.treatment,
    brandVisualLanguage: parsed.data.brandVisualLanguage === undefined
      ? (brandRecipe?.brandVisualLanguage ?? null)
      : parsed.data.brandVisualLanguage,
  };
  await prisma.editorProject.update({
    where: { id: project.id },
    data: { projectLookJson: JSON.stringify(snapshot), projectLookUpdatedAt: new Date() },
  });
  return snapshot;
}

export async function clearProjectLook(input: { userId: string; projectId: string }): Promise<void> {
  const updated = await prisma.editorProject.updateMany({
    where: { id: input.projectId, userId: input.userId },
    data: { projectLookJson: null, projectLookUpdatedAt: new Date() },
  });
  if (updated.count !== 1) throw new ProjectLookError("NOT_FOUND", "ไม่พบโปรเจกต์นี้");
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
  const projectLook = parseProjectLook(project.projectLookJson);
  if (projectLook) return { source: "project-look", ...projectLook };
  const brand = parseRevision(project.brandProfileRevision?.visualRecipeJson);
  if (brand) {
    return {
      source: "brand-revision",
      visualFormatId: brand.visualFormatId,
      recipeVersion: brand.recipeVersion,
      treatment: brand.defaultTreatment,
      brandVisualLanguage: brand.brandVisualLanguage ?? null,
    };
  }
  return {
    source: "suggested",
    visualFormatId: input.suggested.visualFormatId,
    recipeVersion: recipeFor(input.suggested.visualFormatId),
    treatment: input.suggested.treatment,
    brandVisualLanguage: null,
  };
}

export type ResolvedProjectVisualPrompt = {
  projectId: string;
  visualBeatId: string;
  source: ProjectVisualContext["source"];
  identityKey: string;
  compiled: CompiledBrandVisualPrompt;
};

/** Resolve the durable project/preflight seam from a video job. Callers retain
 * their existing prompt when no pinned project or analyzed Visual Beat exists. */
export async function resolveProjectVisualPromptForVideoScene(input: {
  userId: string;
  videoJobId: string;
  sceneIndex: number;
}): Promise<ResolvedProjectVisualPrompt | null> {
  const job = await prisma.videoJob.findFirst({
    where: { id: input.videoJobId, userId: input.userId },
    select: { projectId: true },
  });
  if (!job?.projectId) return null;
  const preflight = await prisma.contentPreflight.findFirst({
    where: { projectId: job.projectId, userId: input.userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      contentDomain: true,
      suggestedVisualFormatId: true,
      suggestedTreatmentJson: true,
    },
  });
  if (!preflight || !VISUAL_FORMAT_IDS.includes(preflight.suggestedVisualFormatId as VisualFormatId)) return null;
  const beat = await prisma.projectVisualBeat.findFirst({
    where: { preflightId: preflight.id, sequence: input.sceneIndex, userId: input.userId },
  });
  if (!beat) return null;
  let beatValue: Omit<VisualBeat, "phase">;
  let suggestedTreatment: { label?: string; mood?: string };
  try {
    beatValue = JSON.parse(beat.beatJson) as Omit<VisualBeat, "phase">;
    suggestedTreatment = JSON.parse(preflight.suggestedTreatmentJson) as { label?: string; mood?: string };
  } catch {
    return null;
  }
  if (!beatValue.subject || !beatValue.action || !beatValue.setting || !beatValue.emotion || !beatValue.emphasis) return null;
  const treatment = [suggestedTreatment.label, suggestedTreatment.mood].filter(Boolean).join(", ") || "clear";
  const context = await resolveProjectVisualContext({
    userId: input.userId,
    projectId: job.projectId,
    suggested: {
      visualFormatId: preflight.suggestedVisualFormatId as VisualFormatId,
      treatment,
    },
  });
  const count = await prisma.projectVisualBeat.count({ where: { preflightId: preflight.id } });
  const phase: VisualBeat["phase"] = input.sceneIndex === 0
    ? "hook"
    : input.sceneIndex >= count - 1 ? "close" : "explain";
  return {
    projectId: job.projectId,
    visualBeatId: beat.id,
    source: context.source,
    identityKey: brandVisualIdentityKey(context),
    compiled: compileBrandVisualPrompt({
      visualFormatId: context.visualFormatId,
      contentDomain: preflight.contentDomain,
      treatment: context.treatment,
      brandVisualLanguage: context.brandVisualLanguage,
      visualBeat: { ...beatValue, phase },
    }),
  };
}
