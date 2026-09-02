import { z } from "zod";
import {
  TREATMENT_PRESET_IDS,
  treatmentPinSchema,
  treatmentPresetThaiLabel,
  type TreatmentPin,
  type TreatmentPresetId,
} from "@/lib/brand-treatment-catalog";
import { stylePackSnapshotSchema, type StylePackSnapshot } from "@/lib/style-pack-snapshot";
import {
  SUPPORTED_VISUAL_FORMATS,
  SUPPORTED_VISUAL_FORMAT_IDS,
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
  treatmentPresetId: z.enum(TREATMENT_PRESET_IDS),
  brandVisualLanguage: brandLanguageSchema.nullable().optional(),
});

const legacyProjectLookSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  visualFormatId: z.enum(SUPPORTED_VISUAL_FORMAT_IDS),
  recipeVersion: z.string().min(1),
  treatment: z.string().min(1),
  brandVisualLanguage: brandLanguageSchema.nullable(),
});

const catalogProjectLookSnapshotSchema = z.object({
  schemaVersion: z.literal(2),
  visualFormatId: z.enum(SUPPORTED_VISUAL_FORMAT_IDS),
  recipeVersion: z.string().min(1),
  treatment: z.string().min(1),
  treatmentPin: treatmentPinSchema,
  brandVisualLanguage: brandLanguageSchema.nullable(),
});

export const projectLookSnapshotSchema = z.union([
  catalogProjectLookSnapshotSchema,
  legacyProjectLookSnapshotSchema,
]);

export const revisionRecipeSchema = z.object({
  visualFormatId: z.enum(SUPPORTED_VISUAL_FORMAT_IDS),
  recipeVersion: z.string().min(1),
  brandVisualLanguage: brandLanguageSchema.nullable().optional(),
  // No `.min(1)`: same reason as brandLanguageSchema.personality above — the
  // payload schema allows an empty visual.defaultTreatment.
  defaultTreatment: z.string(),
  treatmentPolicy: z.enum(["adaptive", "locked"]).default("adaptive"),
  lockedTreatmentPin: treatmentPinSchema.nullable().default(null),
  // The Style Pack snapshot written at publish time (wave 1). These are plain
  // (non-strict) z.objects, so WITHOUT this field the snapshot is silently
  // STRIPPED on parse and every render-time reader sees a pack-less recipe.
  // Optional + nullable: recipes written before wave 1 must still parse.
  stylePack: stylePackSnapshotSchema.nullable().optional(),
}).superRefine((recipe, context) => {
  if (recipe.treatmentPolicy === "locked" && !recipe.lockedTreatmentPin) {
    context.addIssue({ code: "custom", path: ["lockedTreatmentPin"], message: "Locked treatment pin is required" });
  }
});

const legacyProjectVisualContextSchema = z.object({
  source: z.enum(["project-look", "brand-revision", "suggested"]),
  visualFormatId: z.enum(SUPPORTED_VISUAL_FORMAT_IDS),
  recipeVersion: z.string().min(1),
  treatment: z.string().min(1),
  brandVisualLanguage: brandLanguageSchema.nullable(),
  stylePack: stylePackSnapshotSchema.nullable().optional(),
});

const catalogProjectVisualContextSchema = z.object({
  schemaVersion: z.literal(2),
  source: z.enum(["project-look", "brand-revision", "suggested"]),
  visualFormatId: z.enum(SUPPORTED_VISUAL_FORMAT_IDS),
  recipeVersion: z.string().min(1),
  treatment: z.string().min(1),
  treatmentPin: treatmentPinSchema,
  brandVisualLanguage: brandLanguageSchema.nullable(),
  // A per-clip Style Pack pinned onto ONE video job. Same reason as the recipe
  // above: without the field the snapshot would be stripped on parse.
  stylePack: stylePackSnapshotSchema.nullable().optional(),
});

export const projectVisualContextSchema = z.union([
  catalogProjectVisualContextSchema,
  legacyProjectVisualContextSchema,
]);

export type ProjectLookInput = z.infer<typeof projectLookInputSchema>;
export type ProjectLookSnapshot = z.infer<typeof projectLookSnapshotSchema>;
export type ProjectVisualContext = {
  source: "project-look" | "brand-revision" | "suggested";
  visualFormatId: VisualFormatId;
  recipeVersion: string;
  treatment: string;
  treatmentPin?: TreatmentPin;
  legacyCustomTreatment?: boolean;
  schemaVersion?: 1 | 2;
  brandVisualLanguage: BrandVisualLanguage | null;
  stylePack?: StylePackSnapshot | null;
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

/** Scene Reroll maps a missing/incomplete Visual Beat to 409, not an uncaught 500. */
export function sceneRerollUnavailablePayload(error: unknown): {
  error: "scene_reroll_unavailable";
  message: string;
} | null {
  if (!(error instanceof ProjectLookError)) return null;
  if (error.code !== "PREFLIGHT_INCOMPLETE" && error.code !== "NOT_FOUND") return null;
  return { error: "scene_reroll_unavailable", message: error.message };
}

export function recipeFor(formatId: VisualFormatId): string {
  const format = SUPPORTED_VISUAL_FORMATS.find((item) => item.id === formatId);
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
    const parsed = projectVisualContextSchema.parse(JSON.parse(value));
    if ("treatmentPin" in parsed) {
      if (parsed.treatment !== treatmentPresetThaiLabel(parsed.treatmentPin)) return null;
      return parsed;
    }
    return { ...parsed, legacyCustomTreatment: parsed.source === "project-look" };
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
  suggested: {
    visualFormatId: VisualFormatId;
    treatment: string;
    treatmentPin?: TreatmentPin;
  };
}): ProjectVisualContext {
  const projectLook = parseProjectLook(input.projectLookJson);
  if (projectLook) {
    if (projectLook.schemaVersion === 2) {
      return { source: "project-look", ...projectLook };
    }
    return { source: "project-look", ...projectLook, legacyCustomTreatment: true };
  }
  const brand = parseRevision(input.brandProfileRevisionRecipeJson);
  if (brand) {
    if (brand.treatmentPolicy === "locked" && brand.lockedTreatmentPin) {
      return {
        schemaVersion: 2,
        source: "brand-revision",
        visualFormatId: brand.visualFormatId,
        recipeVersion: brand.recipeVersion,
        treatment: treatmentPresetThaiLabel(brand.lockedTreatmentPin),
        treatmentPin: brand.lockedTreatmentPin,
        brandVisualLanguage: brand.brandVisualLanguage ?? null,
      };
    }
    return {
      ...(input.suggested.treatmentPin ? { schemaVersion: 2 as const } : {}),
      source: "brand-revision",
      visualFormatId: brand.visualFormatId,
      recipeVersion: brand.recipeVersion,
      treatment: input.suggested.treatment.trim() || brand.defaultTreatment,
      ...(input.suggested.treatmentPin ? { treatmentPin: input.suggested.treatmentPin } : {}),
      brandVisualLanguage: brand.brandVisualLanguage ?? null,
    };
  }
  return {
    ...(input.suggested.treatmentPin ? { schemaVersion: 2 as const } : {}),
    source: "suggested",
    visualFormatId: input.suggested.visualFormatId,
    recipeVersion: recipeFor(input.suggested.visualFormatId),
    treatment: input.suggested.treatment,
    ...(input.suggested.treatmentPin ? { treatmentPin: input.suggested.treatmentPin } : {}),
    brandVisualLanguage: null,
  };
}
