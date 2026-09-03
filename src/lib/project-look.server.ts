import "server-only";

import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  GENERIC_TREATMENT_PLACEHOLDER,
  TREATMENT_PRESET_IDS,
  catalogTreatmentPinForVersion,
  createCatalogTreatmentPin,
  isGenericTreatmentPlaceholder,
  treatmentPinSchema,
  treatmentPromptDirection,
  treatmentPresetThaiLabel,
  type TreatmentPin,
  type TreatmentPinSource,
  type TreatmentPresetId,
} from "@/lib/brand-treatment-catalog";
import {
  SUPPORTED_VISUAL_FORMAT_IDS,
  VISUAL_FORMAT_IDS,
  brandLookIdentityKey,
  brandVisualIdentityKey,
  compileBrandVisualPrompt,
  type ActiveVisualFormatId,
  type BrandVisualLanguage,
  type CompiledBrandVisualPrompt,
  type SceneRenderingDirection,
  type VisualBeat,
  type VisualFormatId,
} from "@/lib/brand-visual-system";
import { stylePack, type StylePack } from "@/lib/style-pack-catalog";
import { STYLE_PACK_UNAVAILABLE_MESSAGE } from "@/lib/style-pack-apply";
import { stylePackSnapshotOf, type StylePackSnapshot } from "@/lib/style-pack-snapshot";
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
import {
  brandVisualPinAdmissionFields,
  hasAdmittedPersistedPin,
  hasPersistedProjectPin,
  type PinAdmission,
} from "@/lib/brand-visual-pin-admission";
import { resolveRenderTimePinAdmissionFields } from "@/lib/brand-visual-pin-admission.server";
import { CONTENT_PREFLIGHT_ANALYZER_VERSION } from "@/lib/content-preflight.server";

const pendingUploadVisualContextSchema = z.discriminatedUnion("selection", [
  z.object({
    schemaVersion: z.literal(1),
    state: z.enum(["awaiting-upload-preflight", "awaiting-content-preflight"]),
    selection: z.literal("suggested"),
    narrativeSourceKind: z.enum(["ai-script", "creator-script", "upload-transcript"]).optional(),
  }),
  z.object({
    schemaVersion: z.literal(1),
    state: z.enum(["awaiting-upload-preflight", "awaiting-content-preflight"]),
    selection: z.literal("brand-revision"),
    narrativeSourceKind: z.enum(["ai-script", "creator-script", "upload-transcript"]).optional(),
    visualFormatId: z.enum(SUPPORTED_VISUAL_FORMAT_IDS),
    recipeVersion: z.string().min(1),
    brandVisualLanguage: brandLanguageSchema.nullable(),
    treatmentPin: treatmentPinSchema.nullable().optional(),
  }),
  z.object({
    schemaVersion: z.literal(1),
    state: z.enum(["awaiting-upload-preflight", "awaiting-content-preflight"]),
    selection: z.literal("project-look"),
    narrativeSourceKind: z.enum(["ai-script", "creator-script", "upload-transcript"]).optional(),
    visualFormatId: z.enum(VISUAL_FORMAT_IDS),
    recipeVersion: z.string().min(1),
    brandVisualLanguage: brandLanguageSchema.nullable(),
  }),
]);

export type ProjectVisualApplyMode = "regenerate-all";

export {
  parseProjectVisualContext,
  projectLookInputSchema,
  ProjectLookError,
  resolveProjectVisualContextFromSnapshots,
  treatmentFromPreflight,
};
export type { ProjectLookInput, ProjectLookSnapshot, ProjectVisualContext };

/** The one place a Style Pack becomes a clip's look. A pack resolves the image
 * format, the narrative treatment AND the visual language (palette +
 * personality) — exactly the axes `applyStylePackToPayload` resolves on a Brand
 * Profile, so that promoting this clip later produces the same look rather than
 * a conflict. The client's own format/treatment are ignored on a pack request:
 * the browser only ever knows the pack id. */
function packResolvedLook(pack: StylePack): {
  visualFormatId: ActiveVisualFormatId;
  treatmentPresetId: TreatmentPresetId;
  brandVisualLanguage: BrandVisualLanguage;
  stylePack: StylePackSnapshot;
} {
  if (!(TREATMENT_PRESET_IDS as readonly string[]).includes(pack.treatmentPresetId)) {
    // Only reachable if a catalog edit activates a pack before its narrative
    // treatment ships. Refuse the look instead of pinning a treatment the
    // compilers cannot render.
    throw new ProjectLookError("INVALID_LOOK", STYLE_PACK_UNAVAILABLE_MESSAGE);
  }
  return {
    visualFormatId: pack.visualFormatId,
    treatmentPresetId: pack.treatmentPresetId as TreatmentPresetId,
    brandVisualLanguage: {
      palette: [...pack.palette],
      personality: pack.personality,
      peopleAndSetting: "",
      memorableCues: [],
      visualNotes: "",
    },
    stylePack: stylePackSnapshotOf(pack),
  };
}

function snapshotForLook(
  look: ProjectLookInput,
  brandRevisionJson: string | null | undefined,
  currentLookJson?: string | null,
): ProjectLookSnapshot {
  const parsed = projectLookInputSchema.safeParse(look);
  if (!parsed.success) {
    throw new ProjectLookError("INVALID_LOOK", parsed.error.issues[0]?.message || "ข้อมูลแนวภาพไม่ครบ");
  }
  const brandRecipe = parseRevision(brandRevisionJson);
  const packed = parsed.data.stylePackId ? packResolvedLook(stylePack(parsed.data.stylePackId)) : null;
  // Unlinking a pack ("กำหนดเอง", or simply editing one of its axes) must not
  // change the look the creator is looking at — it only stops calling it a
  // ready-made style. So the palette and personality the pack resolved stay,
  // exactly as `clearStylePack` keeps them on /brands. Only a look that never
  // had a pack still inherits its language from the Brand, unchanged.
  const currentLook = parseProjectLook(currentLookJson);
  const unlinkedPackLanguage = !packed
    && currentLook?.schemaVersion === 2
    && currentLook.stylePack
    ? currentLook.brandVisualLanguage
    : null;
  // The superRefine above guarantees both axes when there is no pack.
  const visualFormatId = packed?.visualFormatId ?? parsed.data.visualFormatId!;
  const treatmentPin = createCatalogTreatmentPin(
    packed?.treatmentPresetId ?? parsed.data.treatmentPresetId!,
    "creator",
  );
  return {
    schemaVersion: 2,
    visualFormatId,
    recipeVersion: recipeFor(visualFormatId),
    treatment: treatmentPresetThaiLabel(treatmentPin),
    treatmentPin,
    brandVisualLanguage: packed?.brandVisualLanguage
      ?? (parsed.data.brandVisualLanguage === undefined
        ? (unlinkedPackLanguage ?? brandRecipe?.brandVisualLanguage ?? null)
        : parsed.data.brandVisualLanguage),
    // Absent/`null` unlinks the pack while keeping everything it resolved —
    // the clip's look does not change, it simply becomes the creator's own.
    stylePack: packed?.stylePack ?? null,
  };
}

async function saveProjectLookInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    projectId: string;
    look: ProjectLookInput;
    admission: PinAdmission;
  },
): Promise<ProjectLookSnapshot> {
  const project = await tx.editorProject.findFirst({
    where: { id: input.projectId, userId: input.userId },
    include: { brandProfileRevision: { select: { visualRecipeJson: true } } },
  });
  if (!project) throw new ProjectLookError("NOT_FOUND", "ไม่พบโปรเจกต์นี้");
  const snapshot = snapshotForLook(
    input.look,
    project.brandProfileRevision?.visualRecipeJson,
    project.projectLookJson,
  );
  await tx.editorProject.update({
    where: { id: project.id },
    data: {
      projectLookJson: JSON.stringify(snapshot),
      projectLookUpdatedAt: new Date(),
      treatmentPresetId: snapshot.schemaVersion === 2 ? snapshot.treatmentPin.presetId : null,
      treatmentPresetVersion: snapshot.schemaVersion === 2 ? snapshot.treatmentPin.version : null,
      treatmentPinSource: snapshot.schemaVersion === 2 ? snapshot.treatmentPin.source : null,
      treatmentPinnedAt: snapshot.schemaVersion === 2 ? new Date() : null,
      // The pin and the image decision behind it commit together (#430).
      ...brandVisualPinAdmissionFields(input.admission),
    },
  });
  return snapshot;
}

export async function saveProjectLook(input: {
  userId: string;
  projectId: string;
  look: ProjectLookInput;
  admission: PinAdmission;
}): Promise<ProjectLookSnapshot> {
  return prisma.$transaction((tx) => saveProjectLookInTransaction(tx, input));
}

/** Upload Step 2 runs before speech transcription, so the creator can choose
 * the image format but there is no content-grounded Treatment yet. Persist the
 * format as an explicit temporary Project Look; the upload worker replaces
 * only its placeholder Treatment after Content Preflight succeeds. */
export async function saveUploadProjectVisualFormatAwaitingPreflight(input: {
  userId: string;
  projectId: string;
  visualFormatId: ActiveVisualFormatId;
  admission: PinAdmission;
}): Promise<ProjectLookSnapshot> {
  return prisma.$transaction(async (tx) => {
    const project = await tx.editorProject.findFirst({
      where: { id: input.projectId, userId: input.userId },
      include: { brandProfileRevision: { select: { visualRecipeJson: true } } },
    });
    if (!project) throw new ProjectLookError("NOT_FOUND", "ไม่พบโปรเจกต์นี้");
    if (!VISUAL_FORMAT_IDS.includes(input.visualFormatId)) {
      throw new ProjectLookError("INVALID_LOOK", "แนวภาพนี้ไม่อยู่ใน V1");
    }
    const brandRecipe = parseRevision(project.brandProfileRevision?.visualRecipeJson);
    const snapshot: ProjectLookSnapshot = {
      schemaVersion: 1,
      visualFormatId: input.visualFormatId,
      recipeVersion: recipeFor(input.visualFormatId),
      treatment: GENERIC_TREATMENT_PLACEHOLDER,
      brandVisualLanguage: brandRecipe?.brandVisualLanguage ?? null,
    };
    await tx.editorProject.update({
      where: { id: project.id },
      data: {
        projectLookJson: JSON.stringify(snapshot),
        projectLookUpdatedAt: new Date(),
        treatmentPresetId: null,
        treatmentPresetVersion: null,
        treatmentPinSource: null,
        treatmentPinnedAt: null,
        // A temporary format pin is a pin: it records the same admission (#430).
        ...brandVisualPinAdmissionFields(input.admission),
      },
    });
    return snapshot;
  });
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
  admission: PinAdmission;
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
    if (existingImageCount > 0 && input.applyMode !== "regenerate-all") {
      throw new ProjectLookError(
        "LOOK_CHANGE_CONFIRMATION_REQUIRED",
        "การเปลี่ยนแนวเล่าเรื่องต้องสร้างภาพ AI เดิมใหม่ทั้งหมดหรือยกเลิก",
        { existingImageCount },
      );
    }
    const look = await saveProjectLookInTransaction(tx, input);
    if (preflight) {
      const generationIdentityKey = brandVisualIdentityKey(look);
      await tx.projectVisualBeat.updateMany({
        where: { preflightId: preflight.id },
        data: { generationIdentityKey, status: "outdated", outdatedAt: new Date() },
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
    // The treatment pin is part of the project-scoped override. Leaving it
    // behind would make a cleared Project Look silently outrank the selected
    // Brand Profile or the next adaptive Content Preflight.
    data: {
      projectLookJson: null,
      projectLookUpdatedAt: new Date(),
      treatmentPresetId: null,
      treatmentPresetVersion: null,
      treatmentPinSource: null,
      treatmentPinnedAt: null,
      // Clearing a pin clears the image admission that pin was granted (#430);
      // the next pin write records the owner's decision at THAT moment.
      ...brandVisualPinAdmissionFields(null),
    },
  });
  if (updated.count !== 1) throw new ProjectLookError("NOT_FOUND", "ไม่พบโปรเจกต์นี้");
}

const persistedVisualPinSelect = {
  projectLookJson: true,
  brandProfileRevisionId: true,
  treatmentPresetId: true,
  treatmentPresetVersion: true,
  brandVisualPinAdmittedCohort: true,
  brandVisualPinAdmittedAt: true,
} as const;

/** A persisted selection survives plan downgrade and feature rollback. This
 * check grants no mutation/adoption rights; it only lets VideoJob acceptance
 * preserve the exact context an existing project already owns. */
export async function projectHasPersistedVisualPin(input: {
  userId: string;
  projectId: string;
}): Promise<boolean> {
  const project = await prisma.editorProject.findFirst({
    where: { id: input.projectId, userId: input.userId },
    select: persistedVisualPinSelect,
  });
  if (!project) throw new ProjectLookError("NOT_FOUND", "ไม่พบโปรเจกต์นี้");
  return hasPersistedProjectPin(project);
}

/** The render-path question (#430): does this project own a pin that was
 * written while its owner could use managed AI images? Ownership-scoped, and
 * fail-closed — a project that does not exist (or is not the caller's) admits
 * nothing instead of raising into a 500 on a render request. */
export async function projectHasAdmittedPersistedPin(input: {
  userId: string;
  projectId: string;
}): Promise<boolean> {
  const project = await prisma.editorProject.findFirst({
    where: { id: input.projectId, userId: input.userId },
    select: persistedVisualPinSelect,
  });
  return project ? hasAdmittedPersistedPin(project) : false;
}

export async function resolveProjectVisualContext(input: {
  userId: string;
  projectId: string;
  suggested: {
    visualFormatId: VisualFormatId;
    treatment: string;
    treatmentPin?: TreatmentPin;
  };
}): Promise<ProjectVisualContext> {
  const [project, generatedAiImageCount] = await Promise.all([
    prisma.editorProject.findFirst({
      where: { id: input.projectId, userId: input.userId },
      select: {
        projectLookJson: true,
        treatmentPresetId: true,
        treatmentPresetVersion: true,
        treatmentPinSource: true,
        brandProfileRevision: { select: { visualRecipeJson: true } },
      },
    }),
    prisma.projectVisualBeat.count({
      where: { userId: input.userId, projectId: input.projectId, existingImageJobId: { not: null } },
    }),
  ]);
  if (!project) throw new ProjectLookError("NOT_FOUND", "ไม่พบโปรเจกต์นี้");
  const resolved = resolveProjectVisualContextFromSnapshots({
    projectLookJson: project.projectLookJson,
    brandProfileRevisionRecipeJson: project.brandProfileRevision?.visualRecipeJson,
    suggested: input.suggested,
  });
  const storedPin = catalogPinFromStoredProject(project);
  const adaptiveCanFollowContent = storedPin?.source === "adaptive"
    && generatedAiImageCount === 0
    && process.env.TREATMENT_EMERGENCY_STOP !== "1";
  if (!storedPin || adaptiveCanFollowContent) return resolved;
  return {
    ...resolved,
    schemaVersion: 2,
    treatment: treatmentPresetThaiLabel(storedPin),
    treatmentPin: storedPin,
    legacyCustomTreatment: false,
  };
}

function catalogPinFromStoredProject(project: {
  treatmentPresetId: string | null;
  treatmentPresetVersion: string | null;
  treatmentPinSource: string | null;
}): TreatmentPin | null {
  const presetId = project.treatmentPresetId as TreatmentPresetId | null;
  const source = project.treatmentPinSource as TreatmentPinSource | null;
  if (
    !presetId
    || !TREATMENT_PRESET_IDS.includes(presetId)
    || !source
    || !["adaptive", "locked", "creator", "repair"].includes(source)
  ) {
    return null;
  }
  return catalogTreatmentPinForVersion(
    presetId,
    project.treatmentPresetVersion ?? "",
    source,
  );
}

export type ProjectVisualPin = {
  contentPreflightId: string | null;
  projectVisualContextJson: string;
};

/** Advance carried assets to the identity accepted for this exact preflight.
 * A non-null different identity proves that the image was rendered under an
 * older format/treatment/language, so it must be regenerated. Legacy null
 * identities remain compatible and are claimed by the current context. */
async function advancePreflightVisualIdentityInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    preflightId: string;
    context: ProjectVisualContext;
  },
): Promise<void> {
  const generationIdentityKey = brandVisualIdentityKey(input.context);
  await tx.projectVisualBeat.updateMany({
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
  });
  await tx.projectVisualBeat.updateMany({
    where: {
      preflightId: input.preflightId,
      userId: input.userId,
      OR: [
        { generationIdentityKey: null },
        { generationIdentityKey: { not: generationIdentityKey } },
      ],
    },
    data: { generationIdentityKey },
  });
}

async function advancePreflightVisualIdentity(input: {
  userId: string;
  preflightId: string;
  context: ProjectVisualContext;
}): Promise<void> {
  await prisma.$transaction((tx) => advancePreflightVisualIdentityInTransaction(tx, input));
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
    || !VISUAL_FORMAT_IDS.includes(preflight.suggestedVisualFormatId as ActiveVisualFormatId)
    || preflight.analyzerVersion !== CONTENT_PREFLIGHT_ANALYZER_VERSION
    || !preflight.suggestedTreatmentPresetId
    || !preflight.suggestedTreatmentPresetVersion
  ) {
    throw new ProjectLookError(
      "PREFLIGHT_INCOMPLETE",
      "ผลวิเคราะห์ยังไม่มีฉากที่ใช้สร้างภาพได้",
    );
  }
  const suggestedPresetId = preflight.suggestedTreatmentPresetId as TreatmentPresetId;
  if (!TREATMENT_PRESET_IDS.includes(suggestedPresetId)) {
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ผลวิเคราะห์เลือกแนวเล่าเรื่องที่ระบบยังไม่รองรับ");
  }
  const suggestedPin = createCatalogTreatmentPin(suggestedPresetId, "adaptive");
  if (suggestedPin.version !== preflight.suggestedTreatmentPresetVersion) {
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ข้อมูลแนวเล่าเรื่องในผลวิเคราะห์ไม่ตรงกับงานนี้");
  }
  const project = await prisma.editorProject.findFirst({
    where: { id: input.projectId, userId: input.userId },
    select: {
      projectLookJson: true,
      projectLookUpdatedAt: true,
      treatmentPresetId: true,
      treatmentPresetVersion: true,
      treatmentPinSource: true,
      brandProfileRevision: { select: { visualRecipeJson: true } },
    },
  });
  if (!project) throw new ProjectLookError("NOT_FOUND", "ไม่พบโปรเจกต์นี้");

  const generatedAiImageCount = await prisma.projectVisualBeat.count({
    where: { userId: input.userId, projectId: input.projectId, existingImageJobId: { not: null } },
  });
  const existingStoredPin = catalogPinFromStoredProject(project);
  const storedPin = existingStoredPin?.source === "adaptive"
    && generatedAiImageCount === 0
    && process.env.TREATMENT_EMERGENCY_STOP !== "1"
    ? null
    : existingStoredPin;
  const projectLook = parseProjectLook(project.projectLookJson);
  const establishedLegacyCustom = Boolean(
    projectLook?.schemaVersion === 1
    && !isGenericTreatmentPlaceholder(projectLook.treatment),
  );
  const establishedCatalogLook = projectLook?.schemaVersion === 2;
  if (
    process.env.TREATMENT_EMERGENCY_STOP === "1"
    && !storedPin
    && !establishedLegacyCustom
    && !establishedCatalogLook
  ) {
    throw new ProjectLookError(
      "PREFLIGHT_INCOMPLETE",
      "ระบบแนวเล่าเรื่องหยุดรับงานภาพ AI ใหม่ชั่วคราว กรุณาใช้ Stock หรือลองใหม่ภายหลัง",
    );
  }

  let context: ProjectVisualContext;
  if (projectLook?.schemaVersion === 1 && isGenericTreatmentPlaceholder(projectLook.treatment)) {
    const provenRace = Boolean(
      project.projectLookUpdatedAt
      && project.projectLookUpdatedAt.getTime() < preflight.createdAt.getTime(),
    );
    if (!provenRace) {
      throw new ProjectLookError(
        "PREFLIGHT_INCOMPLETE",
        "ค่าแนวเรื่องชั่วคราวนี้ยืนยันที่มาไม่ได้ จึงไม่ใช้สร้างภาพ",
      );
    }
    const repairPin = createCatalogTreatmentPin(suggestedPresetId, "repair");
    const repairedLook: ProjectLookSnapshot = {
      schemaVersion: 2,
      visualFormatId: projectLook.visualFormatId,
      recipeVersion: projectLook.recipeVersion,
      treatment: treatmentPresetThaiLabel(repairPin),
      treatmentPin: repairPin,
      brandVisualLanguage: projectLook.brandVisualLanguage,
    };
    await prisma.editorProject.update({
      where: { id: input.projectId },
      data: {
        projectLookJson: JSON.stringify(repairedLook),
        projectLookUpdatedAt: new Date(),
        treatmentPresetId: repairPin.presetId,
        treatmentPresetVersion: repairPin.version,
        treatmentPinSource: repairPin.source,
        treatmentPinnedAt: new Date(),
        // R5: a render-time pin write stamps its own admission in the SAME
        // statement — from the owner's live image decision, else from an
        // already-admitted pin, else nothing.
        ...(await resolveRenderTimePinAdmissionFields({
          userId: input.userId,
          projectId: input.projectId,
        })),
      },
    });
    context = { source: "project-look", ...repairedLook };
  } else {
    context = resolveProjectVisualContextFromSnapshots({
      projectLookJson: project.projectLookJson,
      brandProfileRevisionRecipeJson: project.brandProfileRevision?.visualRecipeJson,
      suggested: {
        visualFormatId: preflight.suggestedVisualFormatId as VisualFormatId,
        treatment: treatmentPresetThaiLabel(suggestedPin),
        treatmentPin: suggestedPin,
      },
    });
    if (storedPin) {
      context = {
        ...context,
        schemaVersion: 2,
        treatment: treatmentPresetThaiLabel(storedPin),
        treatmentPin: storedPin,
        legacyCustomTreatment: false,
      };
    } else if (context.treatmentPin) {
      await prisma.editorProject.update({
        where: { id: input.projectId },
        data: {
          treatmentPresetId: context.treatmentPin.presetId,
          treatmentPresetVersion: context.treatmentPin.version,
          treatmentPinSource: context.treatmentPin.source,
          treatmentPinnedAt: new Date(),
          // R5: materialising a treatment pin is a pin write, so it carries its
          // own admission rather than inheriting whatever the row held.
          ...(await resolveRenderTimePinAdmissionFields({
            userId: input.userId,
            projectId: input.projectId,
          })),
        },
      });
    }
  }
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

/** A render may arrive before script analysis or upload transcription is
 * ready. Snapshot an explicit Project Look/Brand Revision immediately; if the
 * project still uses AI suggestion, persist only that selection mode so the
 * eventual Content Preflight supplies the suggestion without consulting
 * mutable project state again. */
export async function prepareProjectVisualSnapshotAwaitingPreflight(input: {
  userId: string;
  projectId: string;
  narrativeSourceKind: "ai-script" | "creator-script" | "upload-transcript";
}): Promise<ProjectVisualPin> {
  const context = await resolveProjectVisualContext({
    userId: input.userId,
    projectId: input.projectId,
    suggested: { visualFormatId: "clear-infographic", treatment: "pending upload transcript" },
  });
  if (
    process.env.TREATMENT_EMERGENCY_STOP === "1"
    && !context.treatmentPin
    && !(context.legacyCustomTreatment && !isGenericTreatmentPlaceholder(context.treatment))
  ) {
    throw new ProjectLookError(
      "PREFLIGHT_INCOMPLETE",
      "ระบบแนวเล่าเรื่องหยุดรับงานภาพ AI ใหม่ชั่วคราว กรุณาใช้ Stock หรือลองใหม่ภายหลัง",
    );
  }
  const snapshot = context.source === "suggested"
    ? {
        schemaVersion: 1 as const,
        state: "awaiting-content-preflight" as const,
        selection: "suggested" as const,
        narrativeSourceKind: input.narrativeSourceKind,
      }
      : context.source === "brand-revision"
      ? {
          schemaVersion: 1 as const,
          state: "awaiting-content-preflight" as const,
          selection: "brand-revision" as const,
          narrativeSourceKind: input.narrativeSourceKind,
          visualFormatId: context.visualFormatId,
          recipeVersion: context.recipeVersion,
          brandVisualLanguage: context.brandVisualLanguage,
          treatmentPin: context.treatmentPin ?? null,
        }
      : context.source === "project-look"
        && context.legacyCustomTreatment
        && isGenericTreatmentPlaceholder(context.treatment)
        ? {
            schemaVersion: 1 as const,
            state: "awaiting-content-preflight" as const,
            selection: "project-look" as const,
            narrativeSourceKind: input.narrativeSourceKind,
            visualFormatId: context.visualFormatId as ActiveVisualFormatId,
            recipeVersion: context.recipeVersion,
            brandVisualLanguage: context.brandVisualLanguage,
          }
      : context;
  return {
    contentPreflightId: null,
    projectVisualContextJson: JSON.stringify(snapshot),
  };
}

export async function prepareUploadProjectVisualSnapshot(input: {
  userId: string;
  projectId: string;
}): Promise<ProjectVisualPin> {
  return prepareProjectVisualSnapshotAwaitingPreflight({
    ...input,
    narrativeSourceKind: "upload-transcript",
  });
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
  if (!job) throw new ProjectLookError("NOT_FOUND", "ไม่พบงานสร้างคลิปที่ต้องใช้แนวภาพนี้");
  const alreadyPinned = parseProjectVisualContext(job.projectVisualContextJson);
  if (job.contentPreflightId) {
    if (job.contentPreflightId !== input.preflightId) {
      throw new ProjectLookError(
        "PREFLIGHT_INCOMPLETE",
        "งานสร้างคลิปผูกกับข้อมูลฉากคนละชุดแล้ว",
      );
    }
    if (!alreadyPinned) {
      throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ข้อมูลแนวภาพที่บันทึกไว้อ่านไม่ได้");
    }
    await hydrateBrandVisualJobAcceptanceReuse(input);
    return {
      contentPreflightId: job.contentPreflightId,
      projectVisualContextJson: job.projectVisualContextJson!,
    };
  }
  if (!job.projectVisualContextJson) {
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "งานสร้างคลิปไม่มีข้อมูลแนวภาพตอนรับงาน");
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
    throw new ProjectLookError("PREFLIGHT_REQUIRED", "ไม่พบผลวิเคราะห์คำพูดที่งานนี้ต้องใช้");
  }
  if (
    preflight.visualBeats.length === 0
    || !VISUAL_FORMAT_IDS.includes(preflight.suggestedVisualFormatId as ActiveVisualFormatId)
    || preflight.analyzerVersion !== CONTENT_PREFLIGHT_ANALYZER_VERSION
    || !preflight.suggestedTreatmentPresetId
    || !preflight.suggestedTreatmentPresetVersion
  ) {
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ผลวิเคราะห์เสียงพูดยังไม่มีฉากที่ใช้ได้");
  }

  let context = alreadyPinned;
  let materializePendingProjectLook = false;
  if (!context) {
    let pendingValue: unknown = null;
    try {
      pendingValue = JSON.parse(job.projectVisualContextJson);
    } catch {}
    const pending = pendingUploadVisualContextSchema.safeParse(pendingValue);
    if (!pending.success) {
      throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ข้อมูลแนวภาพของงานนี้อ่านไม่ได้");
    }
    const suggestedPresetId = preflight.suggestedTreatmentPresetId as TreatmentPresetId;
    if (!TREATMENT_PRESET_IDS.includes(suggestedPresetId)) {
      throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ผลวิเคราะห์เลือกแนวเล่าเรื่องที่ระบบยังไม่รองรับ");
    }
    const suggestedPin = createCatalogTreatmentPin(suggestedPresetId, "adaptive");
    if (suggestedPin.version !== preflight.suggestedTreatmentPresetVersion) {
      throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ข้อมูลแนวเล่าเรื่องในผลวิเคราะห์ไม่ตรงกับงานนี้");
    }
    if (pending.data.selection === "brand-revision") {
      const treatmentPin = pending.data.treatmentPin ?? suggestedPin;
      context = {
        schemaVersion: 2,
        source: "brand-revision",
        visualFormatId: pending.data.visualFormatId,
        recipeVersion: pending.data.recipeVersion,
        treatment: treatmentPresetThaiLabel(treatmentPin),
        treatmentPin,
        brandVisualLanguage: pending.data.brandVisualLanguage,
      };
    } else if (pending.data.selection === "project-look") {
      materializePendingProjectLook = true;
      context = {
        schemaVersion: 2,
        source: "project-look",
        visualFormatId: pending.data.visualFormatId,
        recipeVersion: pending.data.recipeVersion,
        treatment: treatmentPresetThaiLabel(suggestedPin),
        treatmentPin: suggestedPin,
        brandVisualLanguage: pending.data.brandVisualLanguage,
      };
    } else {
      context = {
        schemaVersion: 2,
        source: "suggested",
        visualFormatId: preflight.suggestedVisualFormatId as VisualFormatId,
        recipeVersion: recipeFor(preflight.suggestedVisualFormatId as VisualFormatId),
        treatment: treatmentPresetThaiLabel(suggestedPin),
        treatmentPin: suggestedPin,
        brandVisualLanguage: null,
      };
    }
  }
  const pin = {
    contentPreflightId: preflight.id,
    projectVisualContextJson: JSON.stringify(projectVisualContextSchema.parse(context)),
  };
  // R5: resolved before the transaction, exactly like a creator route resolves
  // its image decision before its own write, and merged into the SAME statement
  // that materialises the pin below.
  const materializedPinAdmission = await resolveRenderTimePinAdmissionFields({
    userId: input.userId,
    projectId: input.projectId,
  });
  const committedPin = await prisma.$transaction(async (tx) => {
    await advancePreflightVisualIdentityInTransaction(tx, {
      userId: input.userId,
      preflightId: preflight.id,
      context,
    });
    if (context.treatmentPin) {
      const materializedLook: ProjectLookSnapshot | null = materializePendingProjectLook
        ? {
            schemaVersion: 2,
            visualFormatId: context.visualFormatId,
            recipeVersion: context.recipeVersion,
            treatment: context.treatment,
            treatmentPin: context.treatmentPin,
            brandVisualLanguage: context.brandVisualLanguage,
          }
        : null;
      await tx.editorProject.updateMany({
        where: { id: input.projectId, userId: input.userId },
        data: {
          ...(materializedLook ? {
            projectLookJson: JSON.stringify(materializedLook),
            projectLookUpdatedAt: new Date(),
          } : {}),
          treatmentPresetId: context.treatmentPin.presetId,
          treatmentPresetVersion: context.treatmentPin.version,
          treatmentPinSource: context.treatmentPin.source,
          treatmentPinnedAt: new Date(),
          ...materializedPinAdmission,
        },
      });
    }
    const updated = await tx.videoJob.updateMany({
      where: {
        id: input.videoJobId,
        userId: input.userId,
        projectId: input.projectId,
        contentPreflightId: null,
        projectVisualContextJson: job.projectVisualContextJson,
      },
      data: pin,
    });
    if (updated.count === 1) return pin;

    const existing = await tx.videoJob.findFirst({
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
        throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ข้อมูลแนวภาพที่บันทึกไว้อ่านไม่ได้");
      }
      return {
        contentPreflightId: existing.contentPreflightId,
        projectVisualContextJson: existing.projectVisualContextJson,
      };
    }
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "งานสร้างคลิปถูกแก้ไขก่อนบันทึกแนวภาพสำเร็จ");
  });
  await hydrateBrandVisualJobAcceptanceReuse(input);
  return committedPin;
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
  sceneRenderingDirection?: SceneRenderingDirection;
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
  let context = parseProjectVisualContext(job.projectVisualContextJson);
  if (!context || !job.contentPreflightId) {
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "งานสร้างคลิปไม่มีข้อมูลแนวภาพที่สมบูรณ์");
  }
  const preflight = await prisma.contentPreflight.findFirst({
    where: { id: job.contentPreflightId, projectId: job.projectId, userId: input.userId },
    select: {
      id: true,
      contentDomain: true,
      storyEntitiesJson: true,
      createdAt: true,
      suggestedTreatmentPresetId: true,
      suggestedTreatmentPresetVersion: true,
    },
  });
  if (!preflight) {
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ไม่พบข้อมูลฉากที่ผูกกับงานสร้างคลิปนี้");
  }
  if (context.legacyCustomTreatment && isGenericTreatmentPlaceholder(context.treatment)) {
    const project = await prisma.editorProject.findFirst({
      where: { id: job.projectId, userId: input.userId },
      select: {
        projectLookJson: true,
        projectLookUpdatedAt: true,
        treatmentPresetId: true,
        treatmentPresetVersion: true,
        treatmentPinSource: true,
      },
    });
    if (!project) throw new ProjectLookError("NOT_FOUND", "ไม่พบโปรเจกต์นี้");
    const alreadyRepairedPin = catalogPinFromStoredProject(project);
    const storedLook = parseProjectLook(project.projectLookJson);
    let repairPin = alreadyRepairedPin?.source === "repair" ? alreadyRepairedPin : null;
    const provenRace = Boolean(
      storedLook?.schemaVersion === 1
      && isGenericTreatmentPlaceholder(storedLook.treatment)
      && project.projectLookUpdatedAt
      && project.projectLookUpdatedAt.getTime() < preflight.createdAt.getTime(),
    );
    if (!repairPin && provenRace) {
      const presetId = preflight.suggestedTreatmentPresetId as TreatmentPresetId | null;
      if (!presetId || !TREATMENT_PRESET_IDS.includes(presetId)) {
        throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ผลวิเคราะห์ยังไม่มีแนวเล่าเรื่องสำหรับซ่อมค่าเดิม");
      }
      repairPin = createCatalogTreatmentPin(presetId, "repair");
      if (repairPin.version !== preflight.suggestedTreatmentPresetVersion) {
        throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ข้อมูลแนวเล่าเรื่องสำหรับซ่อมค่าเดิมไม่ตรงกัน");
      }
    }
    if (!repairPin) {
      throw new ProjectLookError(
        "PREFLIGHT_INCOMPLETE",
        "ค่าแนวเรื่องชั่วคราวนี้ยืนยันที่มาไม่ได้ จึงไม่ใช้สร้างภาพ",
      );
    }
    const repairedLook: ProjectLookSnapshot = {
      schemaVersion: 2,
      visualFormatId: context.visualFormatId,
      recipeVersion: context.recipeVersion,
      treatment: treatmentPresetThaiLabel(repairPin),
      treatmentPin: repairPin,
      brandVisualLanguage: context.brandVisualLanguage,
    };
    context = { source: context.source, ...repairedLook };
    // R5: the scene-prompt repair also writes pin columns, so it stamps in the
    // same statement instead of leaving whatever the row happened to hold.
    const repairedPinAdmission = await resolveRenderTimePinAdmissionFields({
      userId: input.userId,
      projectId: job.projectId,
    });
    await prisma.$transaction([
      prisma.editorProject.update({
        where: { id: job.projectId },
        data: {
          projectLookJson: JSON.stringify(repairedLook),
          projectLookUpdatedAt: new Date(),
          treatmentPresetId: repairPin.presetId,
          treatmentPresetVersion: repairPin.version,
          treatmentPinSource: repairPin.source,
          treatmentPinnedAt: new Date(),
          ...repairedPinAdmission,
        },
      }),
      prisma.videoJob.update({
        where: { id: input.videoJobId },
        data: { projectVisualContextJson: JSON.stringify(projectVisualContextSchema.parse(context)) },
      }),
    ]);
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
  let storyEntities: Array<{
    entityId: string;
    properName: string;
    renderingDescription: string;
    recurringCharacterDescription?: string | null;
  }>;
  try {
    storyEntities = JSON.parse(preflight.storyEntitiesJson) as typeof storyEntities;
    if (!Array.isArray(storyEntities)) throw new Error("invalid entities");
  } catch {
    throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ข้อมูลตัวละครของฉากนี้อ่านไม่ได้");
  }
  const entityById = new Map(storyEntities.map((entity) => [entity.entityId, entity]));
  const rawEntityRefs = (beatValue as unknown as { entityRefs?: unknown }).entityRefs;
  const entityRefs = Array.isArray(rawEntityRefs)
    ? rawEntityRefs.filter((value): value is string => typeof value === "string")
    : [];
  const entityRenderingDescriptions = entityRefs.map((entityId) => {
    const entity = entityById.get(entityId);
    if (!entity) throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "ฉากอ้างถึงตัวละครที่ไม่อยู่ในแผนภาพ");
    const description = (entity.recurringCharacterDescription || entity.renderingDescription).trim();
    const escapedName = entity.properName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const withoutLinkageName = escapedName
      ? description.replace(new RegExp(`\\b${escapedName}\\b`, "giu"), " ").replace(/\s+/g, " ").trim()
      : description;
    if (!withoutLinkageName) {
      throw new ProjectLookError("PREFLIGHT_INCOMPLETE", "คำบรรยายตัวละครสำหรับสร้างภาพไม่สมบูรณ์");
    }
    return withoutLinkageName;
  });
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
      treatment: context.treatmentPin
        ? treatmentPromptDirection(context.treatmentPin)
        : context.treatment,
      ...(context.treatmentPin ? { treatmentPin: context.treatmentPin } : {}),
      brandVisualLanguage: context.brandVisualLanguage,
      visualBeat: { ...beatValue, entityRenderingDescriptions, phase },
      sceneRenderingDirection: input.sceneRenderingDirection,
    }),
  };
}
