import { z } from "zod";
import {
  VISUAL_FORMATS,
  VISUAL_FORMAT_IDS,
  type BrandVisualLanguage,
  type VisualFormatId,
} from "@/lib/brand-visual-system";

export const brandLanguageSchema = z.object({
  palette: z.array(z.string().trim().min(1).max(64)).min(1).max(6),
  // No `.min(1)`: brand-profile-library.server.ts's brandProfilePayloadSchema
  // allows an empty personality (the only required Brand field is the name —
  // decision 4). Keeping `.min(1)` here would not surface as a 400: parseRevision
  // below fail-opens on a schema mismatch and silently drops the whole Brand's
  // visual identity (falls back to source: "suggested"), which is worse than
  // the original defect. Must stay in sync with that schema's `personality`.
  personality: z.string().trim().max(500),
  peopleAndSetting: z.string().trim().max(500).nullable().optional(),
  memorableCues: z.array(z.string().trim().min(1).max(160)).max(6),
  visualNotes: z.string().trim().max(800).nullable().optional(),
});

export const projectLookInputSchema = z.object({
  visualFormatId: z.enum(VISUAL_FORMAT_IDS),
  treatment: z.string().trim().min(1).max(300),
  brandVisualLanguage: brandLanguageSchema.nullable().optional(),
});

export const projectLookSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  visualFormatId: z.enum(VISUAL_FORMAT_IDS),
  recipeVersion: z.string().min(1),
  treatment: z.string().min(1),
  brandVisualLanguage: brandLanguageSchema.nullable(),
});

export const revisionRecipeSchema = z.object({
  visualFormatId: z.enum(VISUAL_FORMAT_IDS),
  recipeVersion: z.string().min(1),
  brandVisualLanguage: brandLanguageSchema.nullable().optional(),
  // No `.min(1)`: same reason as brandLanguageSchema.personality above — the
  // payload schema allows an empty visual.defaultTreatment.
  defaultTreatment: z.string(),
});

export const projectVisualContextSchema = z.object({
  source: z.enum(["project-look", "brand-revision", "suggested"]),
  visualFormatId: z.enum(VISUAL_FORMAT_IDS),
  recipeVersion: z.string().min(1),
  treatment: z.string().min(1),
  brandVisualLanguage: brandLanguageSchema.nullable(),
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
  constructor(
    readonly code: "NOT_FOUND" | "INVALID_LOOK" | "PREFLIGHT_REQUIRED" | "PREFLIGHT_INCOMPLETE" | "LOOK_CHANGE_CONFIRMATION_REQUIRED",
    message: string,
    readonly details?: { existingImageCount?: number; currentPreflightId?: string },
  ) {
    super(message);
    this.name = "ProjectLookError";
  }
}

export function recipeFor(formatId: VisualFormatId): string {
  const format = VISUAL_FORMATS.find((item) => item.id === formatId);
  if (!format) throw new ProjectLookError("INVALID_LOOK", "แนวภาพนี้ไม่อยู่ใน V1");
  return format.recipeVersion;
}

export function parseRevision(value: string | null | undefined) {
  if (!value) return null;
  try {
    return revisionRecipeSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

export function parseProjectLook(value: string | null | undefined) {
  if (!value) return null;
  try {
    return projectLookSnapshotSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

export function parseProjectVisualContext(value: string | null | undefined): ProjectVisualContext | null {
  if (!value) return null;
  try {
    return projectVisualContextSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

export function treatmentFromPreflight(value: string): string {
  try {
    const parsed = JSON.parse(value) as { label?: unknown; mood?: unknown };
    return [parsed.label, parsed.mood]
      .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
      .join(", ") || "clear";
  } catch {
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ผลวิเคราะห์แนวภาพของโปรเจกต์ไม่สมบูรณ์");
  }
}

/** Resolve one per-video identity from immutable JSON snapshots without a DB
 * dependency. Server mutations, acceptance and Hero Script tests share this
 * small contract instead of importing the whole persistence module. */
export function resolveProjectVisualContextFromSnapshots(input: {
  projectLookJson: string | null | undefined;
  brandProfileRevisionRecipeJson: string | null | undefined;
  suggested: { visualFormatId: VisualFormatId; treatment: string };
}): ProjectVisualContext {
  const projectLook = parseProjectLook(input.projectLookJson);
  if (projectLook) return { source: "project-look", ...projectLook };
  const brand = parseRevision(input.brandProfileRevisionRecipeJson);
  if (brand) {
    return {
      source: "brand-revision",
      visualFormatId: brand.visualFormatId,
      recipeVersion: brand.recipeVersion,
      treatment: input.suggested.treatment.trim() || brand.defaultTreatment,
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
