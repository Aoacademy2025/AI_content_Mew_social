import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  VISUAL_FORMATS,
  VISUAL_FORMAT_IDS,
  brandVisualIdentityKey,
  type BrandVisualLanguage,
  type VisualFormatId,
} from "@/lib/brand-visual-system";
import { limitsForPlan } from "@/lib/plan-limits";
import { prisma } from "@/lib/prisma";
import { normalizeLogoOverlayConfig } from "@/lib/logo-overlay";
import { normalizeSubtitleStylePresetConfig } from "@/lib/editor-style-preset-contract";
import {
  parseProjectVisualContext,
  resolveProjectVisualContextFromSnapshots,
  treatmentFromPreflight,
  type ProjectVisualContext,
} from "@/lib/project-visual-context";

const shortNullable = z.string().trim().max(180).nullable();
const safeConfigValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const brandProfilePayloadSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(80),
  // The /brands surface asks for a name and a Visual Format only; niche,
  // audience and tone are optional refinements that may legitimately be empty.
  niche: z.string().trim().max(300),
  audience: z.string().trim().max(500),
  script: z.object({
    styleId: shortNullable,
    tone: z.string().trim().max(500),
    bannedWords: z.array(z.string().trim().min(1).max(80)).max(100),
    ctaStyle: z.string().trim().min(1).max(40),
    language: z.string().trim().min(1).max(20),
    analysisNotes: z.string().trim().max(4_000).nullable().optional(),
    sampleText: z.string().trim().max(4_000).nullable().optional(),
  }),
  voice: z.object({
    provider: z.string().trim().min(1).max(40),
    voiceId: shortNullable,
  }),
  subtitle: z.object({
    presetId: shortNullable,
    config: z.record(z.string().max(80), safeConfigValue).refine(
      (value) => JSON.stringify(value).length <= 8_000,
      "Subtitle defaults are too large",
    ),
  }),
  brandMark: z.object({
    assetId: shortNullable,
    enabled: z.boolean(),
    position: z.string().trim().min(1).max(40),
    sizePct: z.number().min(1).max(100),
    opacity: z.number().min(0).max(1),
  }),
  visual: z.object({
    primaryVisualFormatId: z.enum(VISUAL_FORMAT_IDS),
    languageMode: z.enum(["defined", "none"]).optional(),
    palette: z.array(z.string().trim().min(1).max(64)).min(1).max(6),
    // No `.min(1)`: personality is editable inside ตั้งค่าเพิ่มเติม and a
    // creator may clear it. The only required field is the brand name
    // (decision 4) — the form's withSeedFallbacks() supplies a non-empty
    // default before submit, so the server only needs to bound the length.
    personality: z.string().trim().max(500),
    // Retired from the form (ADR 0006) but kept in the persisted payload with
    // defaults so pinned v1/v2 revisions still deserialize byte-for-byte.
    peopleAndSetting: z.string().trim().max(500).default(""),
    memorableCues: z.array(z.string().trim().min(1).max(160)).max(6).default([]),
    visualNotes: z.string().trim().max(800),
    // Same trap, same fix as personality: editable, clearable, not required.
    defaultTreatment: z.string().trim().max(300),
  }),
});

export type BrandProfilePayload = z.infer<typeof brandProfilePayloadSchema>;

/** Legacy Hero Script may edit/delete only pre-V1 rows. Once immutable
 * revisions exist, every mutation must go through Draft → Publish so pinned
 * EditorProjects can never lose or diverge from their historical revision. */
export function isVersionedBrandProfile(input: {
  activeRevisionNumber: number;
  frozenAt?: Date | null;
  revisionCount?: number;
}): boolean {
  return input.activeRevisionNumber > 0
    || (input.revisionCount ?? 0) > 0
    || Boolean(input.frozenAt);
}

/** Atomic predicate for the legacy Hero Script mutation seam. Keep this in the
 * UPDATE/DELETE statement itself: a prior read cannot protect against a
 * concurrent Draft → Publish transaction. */
export function legacyBrandProfileMutableWhere(
  userId: string,
  profileId: string,
): Prisma.BrandProfileWhereInput {
  return {
    id: profileId,
    userId,
    activeRevisionNumber: 0,
    frozenAt: null,
    revisions: { none: {} },
  };
}

export class BrandProfileLibraryError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "FROZEN" | "INVALID_DRAFT" | "REVISION_CONFLICT" | "NO_REVISION" | "PREFERRED_REQUIRED" | "PREFLIGHT_REQUIRED" | "LOOK_CHANGE_CONFIRMATION_REQUIRED" | "RESULT_REQUIRED",
    message: string,
    readonly details?: { existingImageCount?: number; currentPreflightId?: string },
  ) {
    super(message);
    this.name = "BrandProfileLibraryError";
  }
}

function parsedPayload(input: unknown): BrandProfilePayload {
  const result = brandProfilePayloadSchema.safeParse(input);
  if (!result.success) {
    throw new BrandProfileLibraryError(
      "INVALID_DRAFT",
      result.error.issues[0]?.message || "ข้อมูลแบรนด์ไม่ครบ",
    );
  }
  return result.data;
}

function parsedStoredPayload(value: string): BrandProfilePayload {
  try {
    return parsedPayload(JSON.parse(value));
  } catch (error) {
    if (error instanceof BrandProfileLibraryError) throw error;
    throw new BrandProfileLibraryError("INVALID_DRAFT", "ข้อมูลร่างแบรนด์เสียหาย");
  }
}

function projectDraftRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  throw new BrandProfileLibraryError("INVALID_DRAFT", "ข้อมูลโปรเจกต์ไม่สมบูรณ์");
}

/** Materialize the defaults carried by one immutable Brand Revision without
 * replacing the project's authored script or unrelated per-clip settings.
 * This pure seam is shared by Editor pinning and Hero Script handoff. */
export function applyBrandRevisionDefaultsToProjectDraft(input: {
  draft: Record<string, unknown>;
  payload: BrandProfilePayload;
}): Record<string, unknown> {
  const payload = parsedPayload(input.payload);
  const next = { ...input.draft };
  const provider = payload.voice.provider;
  if (provider === "gemini" || provider === "elevenlabs" || provider === "omnivoice") {
    next.voiceEngine = provider;
    // A Revision owns one default voice decision. Clear stale per-provider
    // overrides first; a null voiceId means "use this provider's account
    // default", not "keep whichever prior Brand happened to be selected".
    delete next.geminiVoiceName;
    delete next.voiceId;
    delete next.omniVoiceId;
    const voiceId = payload.voice.voiceId?.trim();
    if (voiceId) {
      if (provider === "gemini") next.geminiVoiceName = voiceId;
      if (provider === "elevenlabs") next.voiceId = voiceId;
      if (provider === "omnivoice") next.omniVoiceId = voiceId;
    }
  }
  const subtitle = normalizeSubtitleStylePresetConfig(payload.subtitle.config);
  if (subtitle) next.brandSubtitleDefault = subtitle;
  else delete next.brandSubtitleDefault;
  const logo = normalizeLogoOverlayConfig(payload.brandMark);
  if (logo) next.logoOverlay = logo;
  else delete next.logoOverlay;
  return next;
}

function revisionRecipe(payload: BrandProfilePayload) {
  const format = VISUAL_FORMATS.find((item) => item.id === payload.visual.primaryVisualFormatId);
  if (!format) throw new BrandProfileLibraryError("INVALID_DRAFT", "แนวภาพนี้ไม่อยู่ใน V1");
  return {
    schemaVersion: 1,
    visualFormatId: format.id,
    recipeVersion: format.recipeVersion,
    brandVisualLanguage: payload.visual.languageMode === "none" ? null : {
        palette: payload.visual.palette,
        personality: payload.visual.personality,
        peopleAndSetting: payload.visual.peopleAndSetting,
        memorableCues: payload.visual.memorableCues,
        visualNotes: payload.visual.visualNotes,
      },
    defaultTreatment: payload.visual.defaultTreatment,
  };
}

function completedJobPromotionRecipe(
  payload: BrandProfilePayload,
  context: ProjectVisualContext,
) {
  const payloadLanguage: BrandVisualLanguage | null = payload.visual.languageMode === "none"
    ? null
    : {
        palette: payload.visual.palette,
        personality: payload.visual.personality,
        peopleAndSetting: payload.visual.peopleAndSetting,
        memorableCues: payload.visual.memorableCues,
        visualNotes: payload.visual.visualNotes,
      };
  const payloadIdentity = brandVisualIdentityKey({
    visualFormatId: payload.visual.primaryVisualFormatId,
    recipeVersion: context.recipeVersion,
    treatment: payload.visual.defaultTreatment,
    brandVisualLanguage: payloadLanguage,
  });
  const completedIdentity = brandVisualIdentityKey(context);
  if (payloadIdentity !== completedIdentity) {
    throw new BrandProfileLibraryError(
      "REVISION_CONFLICT",
      "แนวภาพที่กรอกไม่ตรงกับคลิปที่เลือก กรุณาบันทึกแนวภาพจากคลิปเดิมโดยไม่เปลี่ยนค่าด้านภาพ",
    );
  }
  return {
    schemaVersion: 1,
    visualFormatId: context.visualFormatId,
    recipeVersion: context.recipeVersion,
    brandVisualLanguage: context.brandVisualLanguage,
    defaultTreatment: context.treatment,
  };
}

export type BrandProfileAvailabilityState = {
  cap: number;
  selectionRequired: boolean;
  activeProfileIds: string[];
  frozenProfileIds: string[];
};

/** Plan-authoritative availability used by every read and mutation surface.
 * Downgrades with too many currently-active profiles pause ALL mutations until
 * the creator chooses; upgrades automatically thaw as many profiles as the new
 * cap permits, so Editor does not depend on visiting /brands first. */
async function reconcileBrandProfileAvailabilityForPlanInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  preferredProfileIds?: readonly string[],
): Promise<BrandProfileAvailabilityState> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { plan: true } });
  if (!user) throw new BrandProfileLibraryError("NOT_FOUND", "ไม่พบบัญชีนี้");
  const profiles = await tx.brandProfile.findMany({
    where: { userId, activeRevisionNumber: { gt: 0 } },
    orderBy: [{ lastUsedAt: "desc" }, { updatedAt: "desc" }, { createdAt: "asc" }],
  });
  const cap = limitsForPlan(user.plan).brandProfiles;
  if (!Number.isFinite(cap) || profiles.length <= cap) {
    await tx.brandProfile.updateMany({
      where: { userId, activeRevisionNumber: { gt: 0 }, frozenAt: { not: null } },
      data: { frozenAt: null },
    });
    return {
      cap,
      selectionRequired: false,
      activeProfileIds: profiles.map((profile) => profile.id),
      frozenProfileIds: [],
    };
  }

  if (preferredProfileIds) {
    const requested = preferredProfileIds
      .map((id) => id.trim())
      .filter((id, index, values) => Boolean(id) && values.indexOf(id) === index);
    const owned = new Set(profiles.map((profile) => profile.id));
    if (requested.some((id) => !owned.has(id))) {
      throw new BrandProfileLibraryError("NOT_FOUND", "ไม่พบแบรนด์ที่เลือก");
    }
    const keep = [
      ...requested,
      ...profiles.filter((profile) => !requested.includes(profile.id)).map((profile) => profile.id),
    ].slice(0, cap);
    const keepSet = new Set(keep);
    const frozen = profiles.filter((profile) => !keepSet.has(profile.id)).map((profile) => profile.id);
    if (keep.length) {
      await tx.brandProfile.updateMany({
        where: {
          userId,
          activeRevisionNumber: { gt: 0 },
          id: { in: keep },
          frozenAt: { not: null },
        },
        data: { frozenAt: null },
      });
    }
    if (frozen.length) {
      await tx.brandProfile.updateMany({
        where: {
          userId,
          activeRevisionNumber: { gt: 0 },
          id: { in: frozen },
          frozenAt: null,
        },
        data: { frozenAt: new Date() },
      });
    }
    return {
      cap,
      selectionRequired: false,
      activeProfileIds: keep,
      frozenProfileIds: frozen,
    };
  }

  const active = profiles.filter((profile) => !profile.frozenAt);
  if (active.length > cap) {
    return {
      cap,
      selectionRequired: true,
      activeProfileIds: active.map((profile) => profile.id),
      frozenProfileIds: profiles.filter((profile) => Boolean(profile.frozenAt)).map((profile) => profile.id),
    };
  }

  const keep = [
    ...active.map((profile) => profile.id),
    ...profiles.filter((profile) => Boolean(profile.frozenAt)).map((profile) => profile.id),
  ].slice(0, cap);
  const keepSet = new Set(keep);
  const frozen = profiles.filter((profile) => !keepSet.has(profile.id)).map((profile) => profile.id);
  if (keep.length) {
    await tx.brandProfile.updateMany({
      where: { userId, id: { in: keep }, frozenAt: { not: null } },
      data: { frozenAt: null },
    });
  }
  if (frozen.length) {
    await tx.brandProfile.updateMany({
      where: { userId, id: { in: frozen }, frozenAt: null },
      data: { frozenAt: new Date() },
    });
  }
  return {
    cap,
    selectionRequired: false,
    activeProfileIds: keep,
    frozenProfileIds: frozen,
  };
}

export async function getBrandProfileAvailabilityState(input: {
  userId: string;
}): Promise<BrandProfileAvailabilityState> {
  return prisma.$transaction((tx) =>
    reconcileBrandProfileAvailabilityForPlanInTransaction(tx, input.userId));
}

/** Resolve the one immutable Revision a newly-created project may pin.
 * Legacy Hero Script rows (revision 0) intentionally return null: adopting
 * them into Brand Library requires the creator's explicit import/publish
 * confirmation. Versioned rows are checked against plan-authoritative
 * availability inside the caller's transaction, so a downgrade cannot race a
 * new project handoff. */
export async function resolveBrandProfileRevisionForNewProjectInTransaction(
  tx: Prisma.TransactionClient,
  input: { userId: string; profileId: string },
): Promise<{ revisionId: string; payload: BrandProfilePayload } | null> {
  const profile = await tx.brandProfile.findFirst({
    where: { id: input.profileId, userId: input.userId },
    select: { id: true, activeRevisionNumber: true },
  });
  if (!profile) throw new BrandProfileLibraryError("NOT_FOUND", "ไม่พบแบรนด์นี้");
  if (profile.activeRevisionNumber <= 0) return null;

  const availability = await reconcileBrandProfileAvailabilityForPlanInTransaction(tx, input.userId);
  if (availability.selectionRequired) {
    throw new BrandProfileLibraryError(
      "PREFERRED_REQUIRED",
      `กรุณาเลือก ${availability.cap} แบรนด์ที่จะใช้กับงานใหม่ก่อน`,
    );
  }
  if (availability.frozenProfileIds.includes(profile.id)) {
    throw new BrandProfileLibraryError("FROZEN", "แบรนด์นี้อยู่ในโหมดอ่านอย่างเดียวตามแผนปัจจุบัน");
  }
  const revision = await tx.brandProfileRevision.findUnique({
    where: {
      brandProfileId_version: {
        brandProfileId: profile.id,
        version: profile.activeRevisionNumber,
      },
    },
    select: { id: true, payloadJson: true },
  });
  if (!revision) throw new BrandProfileLibraryError("NO_REVISION", "แบรนด์นี้ยังไม่มีเวอร์ชันที่ใช้งานได้");
  return { revisionId: revision.id, payload: parsedStoredPayload(revision.payloadJson) };
}

async function assertBrandProfileWritableInTransaction(
  tx: Prisma.TransactionClient,
  input: { userId: string; profileId: string },
): Promise<BrandProfileAvailabilityState> {
  const state = await reconcileBrandProfileAvailabilityForPlanInTransaction(tx, input.userId);
  if (state.selectionRequired) {
    throw new BrandProfileLibraryError(
      "PREFERRED_REQUIRED",
      `กรุณาเลือก ${state.cap} แบรนด์ที่จะใช้กับงานใหม่ก่อนแก้ไข`,
    );
  }
  if (state.frozenProfileIds.includes(input.profileId)) {
    throw new BrandProfileLibraryError("FROZEN", "แบรนด์นี้อยู่ในโหมดอ่านอย่างเดียวตามแผนปัจจุบัน");
  }
  return state;
}

/** Confirm a profile into the Brand Library and publish revision 1 atomically.
 * Draft-only Project Looks never call this method and therefore never consume
 * the plan's Brand Profile cap. */
export async function createBrandProfileFromPayload(input: {
  userId: string;
  payload: BrandProfilePayload;
  source?: "manual" | "project-look";
}) {
  const payload = parsedPayload(input.payload);
  return prisma.$transaction((tx) => createBrandProfileFromPayloadInTransaction(tx, {
    ...input,
    payload,
  }));
}

async function createBrandProfileFromPayloadInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    payload: BrandProfilePayload;
    source?: "manual" | "project-look";
    sourceVideoJobId?: string;
    sourcePreflightId?: string;
    visualRecipeOverride?: ReturnType<typeof completedJobPromotionRecipe>;
  },
) {
    const payload = input.payload;
    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { plan: true } });
    if (!user) throw new BrandProfileLibraryError("NOT_FOUND", "ไม่พบบัญชีนี้");
    const cap = limitsForPlan(user.plan).brandProfiles;
    const count = await tx.brandProfile.count({
      where: { userId: input.userId, activeRevisionNumber: { gt: 0 } },
    });
    if (Number.isFinite(cap) && count >= cap) {
      throw new BrandProfileLibraryError("PREFERRED_REQUIRED", `แผนนี้บันทึกแบรนด์ได้ ${cap} แบรนด์`);
    }
    const profile = await tx.brandProfile.create({
      data: {
        userId: input.userId,
        name: payload.name,
        niche: payload.niche,
        audience: payload.audience,
        tone: payload.script.tone,
        bannedWords: JSON.stringify(payload.script.bannedWords),
        ctaStyle: payload.script.ctaStyle,
        language: payload.script.language,
        analysisNotes: payload.script.analysisNotes ?? null,
        sampleText: payload.script.sampleText ?? null,
        activeRevisionNumber: 1,
        draft: {
          create: {
            baseRevisionNumber: 1,
            payloadJson: JSON.stringify(payload),
          },
        },
      },
    });
    const revision = await tx.brandProfileRevision.create({
      data: {
        brandProfileId: profile.id,
        sourceVideoJobId: input.sourceVideoJobId,
        sourcePreflightId: input.sourcePreflightId,
        version: 1,
        payloadJson: JSON.stringify(payload),
        visualRecipeJson: JSON.stringify(input.visualRecipeOverride ?? revisionRecipe(payload)),
        source: input.source ?? "manual",
      },
    });
    return { profile, revision };
}

async function projectLookPromotionReplay(input: {
  userId: string;
  projectId: string;
  videoJobId?: string;
  preflightId?: string;
  payloadJson: string;
}) {
  const identities = [
    ...(input.videoJobId ? [{ sourceVideoJobId: input.videoJobId }] : []),
    ...(input.preflightId ? [{ sourcePreflightId: input.preflightId }] : []),
  ];
  if (identities.length === 0) return null;
  const revision = await prisma.brandProfileRevision.findFirst({
    where: { OR: identities },
    include: { brandProfile: true },
  });
  if (!revision || revision.brandProfile.userId !== input.userId) return null;
  if (revision.payloadJson !== input.payloadJson) {
    throw new BrandProfileLibraryError(
      "REVISION_CONFLICT",
      "คลิปนี้ถูกบันทึกเป็นแบรนด์ด้วยข้อมูลอีกเวอร์ชันแล้ว",
    );
  }
  const project = await prisma.editorProject.findFirst({
    where: { id: input.projectId, userId: input.userId },
    select: { id: true, brandProfileRevisionId: true },
  });
  if (!project || project.brandProfileRevisionId !== revision.id) {
    throw new BrandProfileLibraryError(
      "REVISION_CONFLICT",
      "โปรเจกต์นี้เปลี่ยนแนวภาพรุ่นที่ใช้อยู่หลังจากบันทึกคลิปแล้ว",
    );
  }
  return {
    profile: revision.brandProfile,
    revision,
    project,
    preflightId: revision.sourcePreflightId,
    replayed: true as const,
  };
}

async function promoteProjectLookInOneTransaction(input: {
  userId: string;
  projectId: string;
  videoJobId?: string;
  preflightId?: string;
  payload: BrandProfilePayload;
}) {
  const payload = parsedPayload(input.payload);
  const payloadJson = JSON.stringify(payload);
  const existing = await projectLookPromotionReplay({ ...input, payloadJson });
  if (existing) return existing;

  try {
    return await prisma.$transaction(async (tx) => {
      const job = input.videoJobId
        ? await tx.videoJob.findFirst({
            where: {
              id: input.videoJobId,
              userId: input.userId,
              projectId: input.projectId,
              status: "done",
              contentPreflightId: { not: null },
              projectVisualContextJson: { not: null },
            },
            select: { id: true, contentPreflightId: true, projectVisualContextJson: true },
          })
        : null;
      if (input.videoJobId && !job?.contentPreflightId) {
          throw new BrandProfileLibraryError(
            "NOT_FOUND",
            "ไม่พบคลิปที่สร้างเสร็จพร้อมแนวภาพสำหรับบันทึกเป็นแบรนด์",
          );
      }
      const { starterAllowanceStatusInTransaction } = await import("@/lib/starter-ai-image-allowance.server");
      const starterAllowance = await starterAllowanceStatusInTransaction(tx, input.userId);
      if (starterAllowance.eligible) {
        if (!job) {
          throw new BrandProfileLibraryError(
            "RESULT_REQUIRED",
            "สร้างคลิปให้เสร็จก่อน แล้วจึงบันทึกแนวภาพจากผลงานจริงเป็นแบรนด์ได้",
          );
        }
        const deliveredImageCount = await tx.aiGenerationJob.count({
          where: {
            userId: input.userId,
            kind: "image",
            status: "completed",
            chargeState: "settled",
            outputUrl: { not: null },
            idempotencyKey: { startsWith: `video:${job.id}:` },
          },
        });
        if (deliveredImageCount === 0) {
          throw new BrandProfileLibraryError(
            "RESULT_REQUIRED",
            "คลิปนี้ยังไม่มีภาพ AI ที่สร้างสำเร็จ กรุณาสร้างคลิปที่มีภาพ AI ก่อนบันทึกเป็นแบรนด์",
          );
        }
      }
      if (job?.contentPreflightId && input.preflightId && job.contentPreflightId !== input.preflightId) {
        throw new BrandProfileLibraryError(
          "REVISION_CONFLICT",
          "ข้อมูลฉากไม่ตรงกับคลิปที่เลือกบันทึกเป็นแบรนด์",
        );
      }
      const completedContext = job
        ? parseProjectVisualContext(job.projectVisualContextJson)
        : null;
      if (job && !completedContext) {
        throw new BrandProfileLibraryError(
          "REVISION_CONFLICT",
          "snapshot แนวภาพของคลิปนี้ไม่สมบูรณ์ จึงไม่สามารถบันทึกเป็นแบรนด์ได้",
        );
      }
      const resolvedPreflightId = job?.contentPreflightId ?? input.preflightId;
      if (!resolvedPreflightId) {
        throw new BrandProfileLibraryError("NOT_FOUND", "กรุณาระบุข้อมูลฉากที่ต้องการบันทึก");
      }
      const preflight = await tx.contentPreflight.findFirst({
        where: {
          id: resolvedPreflightId,
          userId: input.userId,
          projectId: input.projectId,
        },
        select: {
          id: true,
          suggestedVisualFormatId: true,
          suggestedTreatmentJson: true,
        },
      });
      if (!preflight) {
        throw new BrandProfileLibraryError("NOT_FOUND", "ไม่พบข้อมูลฉากของคลิปนี้");
      }
      const projectSnapshot = await tx.editorProject.findFirst({
        where: { id: input.projectId, userId: input.userId },
        select: {
          projectLookJson: true,
          brandProfileRevision: { select: { visualRecipeJson: true } },
        },
      });
      if (!projectSnapshot) {
        throw new BrandProfileLibraryError("NOT_FOUND", "ไม่พบโปรเจกต์นี้");
      }
      const promotionContext = completedContext ?? resolveProjectVisualContextFromSnapshots({
        projectLookJson: projectSnapshot.projectLookJson,
        brandProfileRevisionRecipeJson: projectSnapshot.brandProfileRevision?.visualRecipeJson,
        suggested: {
          visualFormatId: preflight.suggestedVisualFormatId as VisualFormatId,
          treatment: treatmentFromPreflight(preflight.suggestedTreatmentJson),
        },
      });
      // A zero-friction Project Look promotion is intentionally exact. Visual
      // edits must go through the normal look-change confirmation instead of
      // relabelling retained assets under a different Brand identity.
      const visualRecipeOverride = completedJobPromotionRecipe(payload, promotionContext);

      const created = await createBrandProfileFromPayloadInTransaction(tx, {
        userId: input.userId,
        payload,
        source: "project-look",
        sourceVideoJobId: job?.id,
        sourcePreflightId: preflight.id,
        visualRecipeOverride,
      });
      const pinned = await pinProjectBrandRevisionInTransaction(tx, {
        userId: input.userId,
        projectId: input.projectId,
        profileId: created.profile.id,
        revisionId: created.revision.id,
      });
      return {
        ...created,
        project: pinned.project,
        preflightId: preflight.id,
        replayed: false as const,
      };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      const replay = await projectLookPromotionReplay({ ...input, payloadJson });
      if (replay) return replay;
    }
    throw error;
  }
}

/** Promote the exact completed preview into a Brand Profile and pin its first
 * immutable Revision in one transaction. The job and preflight identities are
 * durable replay keys, so an ambiguous HTTP response cannot consume a second
 * profile slot or leave an unpinned library row. */
export async function promoteCompletedVideoJobToBrandProfile(input: {
  userId: string;
  projectId: string;
  videoJobId: string;
  preflightId?: string;
  payload: BrandProfilePayload;
}) {
  return promoteProjectLookInOneTransaction(input);
}

/** The same atomic promotion is available from Step 2 before rendering. The
 * immutable Content Preflight is its retry identity and pins the new Revision
 * to the originating project in the same transaction. */
export async function promoteProjectLookToBrandProfile(input: {
  userId: string;
  projectId: string;
  preflightId: string;
  payload: BrandProfilePayload;
}) {
  return promoteProjectLookInOneTransaction(input);
}

export async function saveBrandProfileDraft(input: {
  userId: string;
  profileId: string;
  payload: BrandProfilePayload;
}) {
  const payload = parsedPayload(input.payload);
  return prisma.$transaction(async (tx) => {
    const profile = await tx.brandProfile.findFirst({
      where: { id: input.profileId, userId: input.userId },
    });
    if (!profile) throw new BrandProfileLibraryError("NOT_FOUND", "ไม่พบแบรนด์นี้");
    await assertBrandProfileWritableInTransaction(tx, input);
    return tx.brandProfileDraft.upsert({
      where: { brandProfileId: profile.id },
      create: {
        brandProfileId: profile.id,
        baseRevisionNumber: profile.activeRevisionNumber,
        payloadJson: JSON.stringify(payload),
      },
      update: { payloadJson: JSON.stringify(payload) },
    });
  });
}

export async function publishBrandProfileDraft(input: {
  userId: string;
  profileId: string;
  source?: "manual" | "project-look";
}) {
  return prisma.$transaction(async (tx) => {
    const profile = await tx.brandProfile.findFirst({
      where: { id: input.profileId, userId: input.userId },
      include: { draft: true },
    });
    if (!profile) throw new BrandProfileLibraryError("NOT_FOUND", "ไม่พบแบรนด์นี้");
    await assertBrandProfileWritableInTransaction(tx, input);
    if (!profile.draft) throw new BrandProfileLibraryError("INVALID_DRAFT", "ยังไม่มีร่างแบรนด์ให้เผยแพร่");
    if (profile.draft.baseRevisionNumber !== profile.activeRevisionNumber) {
      throw new BrandProfileLibraryError(
        "REVISION_CONFLICT",
        "แบรนด์มีเวอร์ชันใหม่กว่าแล้ว กรุณาเปิดร่างล่าสุดก่อนบันทึก",
      );
    }

    const payload = parsedStoredPayload(profile.draft.payloadJson);
    const version = profile.activeRevisionNumber + 1;
    const revision = await tx.brandProfileRevision.create({
      data: {
        brandProfileId: profile.id,
        version,
        payloadJson: JSON.stringify(payload),
        visualRecipeJson: JSON.stringify(revisionRecipe(payload)),
        source: input.source ?? "manual",
      },
    });
    await tx.brandProfile.update({
      where: { id: profile.id },
      data: {
        name: payload.name,
        niche: payload.niche,
        audience: payload.audience,
        tone: payload.script.tone,
        bannedWords: JSON.stringify(payload.script.bannedWords),
        ctaStyle: payload.script.ctaStyle,
        language: payload.script.language,
        analysisNotes: payload.script.analysisNotes ?? null,
        sampleText: payload.script.sampleText ?? null,
        activeRevisionNumber: version,
      },
    });
    await tx.brandProfileDraft.update({
      where: { id: profile.draft.id },
      data: { baseRevisionNumber: version },
    });
    return revision;
  });
}

type ProjectBrandRevisionInput = {
  userId: string;
  projectId: string;
  profileId: string;
  revisionId?: string;
};

async function pinProjectBrandRevisionInTransaction(
  tx: Prisma.TransactionClient,
  input: ProjectBrandRevisionInput,
) {
  const [project, profile] = await Promise.all([
      tx.editorProject.findFirst({
        where: { id: input.projectId, userId: input.userId },
        include: { brandProfileRevision: { select: { brandProfileId: true } } },
      }),
      tx.brandProfile.findFirst({ where: { id: input.profileId, userId: input.userId } }),
  ]);
  if (!project || !profile) {
    throw new BrandProfileLibraryError("NOT_FOUND", "ไม่พบโปรเจกต์หรือแบรนด์นี้");
  }
  const availability = await reconcileBrandProfileAvailabilityForPlanInTransaction(tx, input.userId);
  const alreadyUsesProfile = project.brandProfileRevision?.brandProfileId === profile.id;
  if (availability.selectionRequired && !alreadyUsesProfile) {
    throw new BrandProfileLibraryError(
      "PREFERRED_REQUIRED",
      `กรุณาเลือก ${availability.cap} แบรนด์ที่จะใช้กับงานใหม่ก่อน`,
    );
  }
  const revision = input.revisionId
    ? await tx.brandProfileRevision.findFirst({
        where: { id: input.revisionId, brandProfileId: profile.id },
      })
    : await tx.brandProfileRevision.findUnique({
        where: {
          brandProfileId_version: {
            brandProfileId: profile.id,
            version: profile.activeRevisionNumber,
          },
        },
      });
  if (!revision) throw new BrandProfileLibraryError("NO_REVISION", "แบรนด์นี้ยังไม่มีเวอร์ชันที่ใช้งานได้");
  const effectivelyFrozen = availability.selectionRequired
    || availability.frozenProfileIds.includes(profile.id);
  if (effectivelyFrozen) {
    if (!alreadyUsesProfile || project.brandProfileRevisionId !== revision.id) {
      throw new BrandProfileLibraryError("FROZEN", "แบรนด์นี้เป็นแบบอ่านอย่างเดียวตามแผนปัจจุบัน");
    }
    return { project, revision };
  }
  const revisionPayload = parsedStoredPayload(revision.payloadJson);
  const projectDraft = applyBrandRevisionDefaultsToProjectDraft({
    draft: projectDraftRecord(project.draftJson),
    payload: revisionPayload,
  });
  const updated = await tx.editorProject.update({
    where: { id: project.id },
    data: {
      brandProfileRevisionId: revision.id,
      projectLookJson: null,
      projectLookUpdatedAt: new Date(),
      draftJson: JSON.stringify(projectDraft),
      draftRevision: { increment: 1 },
    },
  });
  await tx.brandProfile.update({ where: { id: profile.id }, data: { lastUsedAt: new Date() } });
  return { project: updated, revision };
}

/** Explicitly pin/adopt one immutable revision. Calling this method is the
 * creator action required by ADR-0005; publishing alone never moves projects. */
export async function pinProjectBrandRevision(input: ProjectBrandRevisionInput) {
  return prisma.$transaction((tx) => pinProjectBrandRevisionInTransaction(tx, input));
}

/** Creator-facing revision mutation. The immutable Revision pin and exact
 * preflight asset policy are one transaction, preventing a selected brand from
 * committing without its regenerate-all invalidation (or vice versa). */
export async function applyProjectBrandRevision(input: ProjectBrandRevisionInput & {
  preflightId?: string;
  applyMode?: "new-only" | "regenerate-all";
}) {
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
      throw new BrandProfileLibraryError("NOT_FOUND", "ไม่พบข้อมูลฉากชุดนี้");
    }
    if (!input.preflightId && preflight) {
      throw new BrandProfileLibraryError(
        "PREFLIGHT_REQUIRED",
        "กรุณาโหลดผลวิเคราะห์เนื้อหาเวอร์ชันปัจจุบันก่อนเลือกแบรนด์",
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
      throw new BrandProfileLibraryError(
        "LOOK_CHANGE_CONFIRMATION_REQUIRED",
        "กรุณาเลือกว่าจะเก็บภาพเดิมหรือสร้างใหม่ทั้งหมด",
        { existingImageCount },
      );
    }
    const pinned = await pinProjectBrandRevisionInTransaction(tx, input);
    let acceptedGenerationIdentityKey: string | null = null;
    if (preflight) {
      const visualRecipe = JSON.parse(pinned.revision.visualRecipeJson) as {
        visualFormatId: VisualFormatId;
        recipeVersion: string;
        defaultTreatment: string;
        brandVisualLanguage?: BrandVisualLanguage | null;
      };
      const generationIdentityKey = brandVisualIdentityKey({
        visualFormatId: visualRecipe.visualFormatId,
        recipeVersion: visualRecipe.recipeVersion,
        treatment: treatmentFromPreflight(preflight.suggestedTreatmentJson),
        brandVisualLanguage: visualRecipe.brandVisualLanguage ?? null,
      });
      acceptedGenerationIdentityKey = generationIdentityKey;
      await tx.projectVisualBeat.updateMany({
        where: { preflightId: preflight.id },
        data: input.applyMode === "regenerate-all"
          ? { generationIdentityKey, status: "outdated", outdatedAt: new Date() }
          : { generationIdentityKey },
      });
    }
    return {
      ...pinned,
      preflightId: preflight?.id ?? null,
      existingImageCount,
      applyMode: input.applyMode ?? null,
      generationIdentityKey: acceptedGenerationIdentityKey,
    };
  });
}

/** Apply the current plan cap without deleting identity or history. Overflow
 * profiles become read-only; every already-pinned project keeps its revision. */
export async function reconcileBrandProfileAvailability(input: {
  userId: string;
  preferredProfileId?: string;
  preferredProfileIds?: string[];
}) {
  return prisma.$transaction(async (tx) => {
    const requested = [
      ...(input.preferredProfileIds ?? []),
      ...(input.preferredProfileId ? [input.preferredProfileId] : []),
    ].filter((id, index, values) => values.indexOf(id) === index);
    const state = await reconcileBrandProfileAvailabilityForPlanInTransaction(
      tx,
      input.userId,
      requested.length ? requested : undefined,
    );
    if (state.selectionRequired) {
      throw new BrandProfileLibraryError(
        "PREFERRED_REQUIRED",
        `กรุณาเลือก ${state.cap} แบรนด์ที่จะใช้กับงานใหม่ตามแผนปัจจุบัน`,
      );
    }
    return state;
  });
}
