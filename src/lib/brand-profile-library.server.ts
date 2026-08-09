import { z } from "zod";
import { VISUAL_FORMATS, VISUAL_FORMAT_IDS } from "@/lib/brand-visual-system";
import { limitsForPlan } from "@/lib/plan-limits";
import { prisma } from "@/lib/prisma";

const shortNullable = z.string().trim().max(180).nullable();
const safeConfigValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const brandProfilePayloadSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(80),
  niche: z.string().trim().min(1).max(300),
  audience: z.string().trim().min(1).max(500),
  script: z.object({
    styleId: shortNullable,
    tone: z.string().trim().min(1).max(500),
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
    palette: z.array(z.string().trim().min(1).max(64)).min(1).max(6),
    personality: z.string().trim().min(1).max(500),
    peopleAndSetting: z.string().trim().max(500),
    memorableCues: z.array(z.string().trim().min(1).max(160)).max(6),
    visualNotes: z.string().trim().max(800),
    defaultTreatment: z.string().trim().min(1).max(300),
  }),
});

export type BrandProfilePayload = z.infer<typeof brandProfilePayloadSchema>;

export class BrandProfileLibraryError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "FROZEN" | "INVALID_DRAFT" | "REVISION_CONFLICT" | "NO_REVISION" | "PREFERRED_REQUIRED",
    message: string,
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

function revisionRecipe(payload: BrandProfilePayload) {
  const format = VISUAL_FORMATS.find((item) => item.id === payload.visual.primaryVisualFormatId);
  if (!format) throw new BrandProfileLibraryError("INVALID_DRAFT", "แนวภาพนี้ไม่อยู่ใน V1");
  return {
    schemaVersion: 1,
    visualFormatId: format.id,
    recipeVersion: format.recipeVersion,
    brandVisualLanguage: {
      palette: payload.visual.palette,
      personality: payload.visual.personality,
      peopleAndSetting: payload.visual.peopleAndSetting,
      memorableCues: payload.visual.memorableCues,
      visualNotes: payload.visual.visualNotes,
    },
    defaultTreatment: payload.visual.defaultTreatment,
  };
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
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { plan: true } });
    if (!user) throw new BrandProfileLibraryError("NOT_FOUND", "ไม่พบบัญชีนี้");
    const cap = limitsForPlan(user.plan).brandProfiles;
    const count = await tx.brandProfile.count({ where: { userId: input.userId } });
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
        version: 1,
        payloadJson: JSON.stringify(payload),
        visualRecipeJson: JSON.stringify(revisionRecipe(payload)),
        source: input.source ?? "manual",
      },
    });
    return { profile, revision };
  });
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
    if (profile.frozenAt) {
      throw new BrandProfileLibraryError("FROZEN", "แบรนด์นี้อยู่ในโหมดอ่านอย่างเดียวตามแผนปัจจุบัน");
    }
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
    if (profile.frozenAt) {
      throw new BrandProfileLibraryError("FROZEN", "แบรนด์นี้อยู่ในโหมดอ่านอย่างเดียวตามแผนปัจจุบัน");
    }
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

/** Explicitly pin/adopt one immutable revision. Calling this method is the
 * creator action required by ADR-0005; publishing alone never moves projects. */
export async function pinProjectBrandRevision(input: {
  userId: string;
  projectId: string;
  profileId: string;
  revisionId?: string;
}) {
  return prisma.$transaction(async (tx) => {
    const [project, profile, user, profileCount, availableProfileCount] = await Promise.all([
      tx.editorProject.findFirst({
        where: { id: input.projectId, userId: input.userId },
        include: { brandProfileRevision: { select: { brandProfileId: true } } },
      }),
      tx.brandProfile.findFirst({ where: { id: input.profileId, userId: input.userId } }),
      tx.user.findUnique({ where: { id: input.userId }, select: { plan: true } }),
      tx.brandProfile.count({ where: { userId: input.userId } }),
      tx.brandProfile.count({ where: { userId: input.userId, frozenAt: null } }),
    ]);
    if (!project || !profile || !user) {
      throw new BrandProfileLibraryError("NOT_FOUND", "ไม่พบโปรเจกต์หรือแบรนด์นี้");
    }
    const alreadyUsesProfile = project.brandProfileRevision?.brandProfileId === profile.id;
    const cap = limitsForPlan(user.plan).brandProfiles;
    if (
      Number.isFinite(cap)
      && profileCount > cap
      && availableProfileCount > cap
      && !alreadyUsesProfile
    ) {
      throw new BrandProfileLibraryError(
        "PREFERRED_REQUIRED",
        `กรุณาเลือก ${cap} แบรนด์ที่จะใช้กับงานใหม่ก่อน`,
      );
    }
    if (profile.frozenAt && !alreadyUsesProfile) {
      throw new BrandProfileLibraryError("FROZEN", "แบรนด์นี้ใช้กับโปรเจกต์ใหม่ไม่ได้ตามแผนปัจจุบัน");
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
    const updated = await tx.editorProject.update({
      where: { id: project.id },
      data: {
        brandProfileRevisionId: revision.id,
        projectLookJson: null,
        projectLookUpdatedAt: new Date(),
      },
    });
    await tx.brandProfile.update({ where: { id: profile.id }, data: { lastUsedAt: new Date() } });
    return { project: updated, revision };
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
    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { plan: true } });
    if (!user) throw new BrandProfileLibraryError("NOT_FOUND", "ไม่พบบัญชีนี้");
    const profiles = await tx.brandProfile.findMany({
      where: { userId: input.userId },
      orderBy: [{ lastUsedAt: "desc" }, { updatedAt: "desc" }, { createdAt: "asc" }],
    });
    const cap = limitsForPlan(user.plan).brandProfiles;
    if (!Number.isFinite(cap) || profiles.length <= cap) {
      await tx.brandProfile.updateMany({
        where: { userId: input.userId, frozenAt: { not: null } },
        data: { frozenAt: null },
      });
      return { cap, activeProfileIds: profiles.map((profile) => profile.id), frozenProfileIds: [] as string[] };
    }

    const requested = [
      ...(input.preferredProfileIds ?? []),
      ...(input.preferredProfileId ? [input.preferredProfileId] : []),
    ].filter((id, index, values) => values.indexOf(id) === index);
    if (!requested.length) {
      throw new BrandProfileLibraryError(
        "PREFERRED_REQUIRED",
        `กรุณาเลือก ${cap} แบรนด์ที่จะใช้กับงานใหม่ตามแผนปัจจุบัน`,
      );
    }
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
    await tx.brandProfile.updateMany({
      where: { userId: input.userId, id: { in: keep } },
      data: { frozenAt: null },
    });
    if (frozen.length) {
      await tx.brandProfile.updateMany({
        where: { userId: input.userId, id: { in: frozen }, frozenAt: null },
        data: { frozenAt: new Date() },
      });
    }
    return { cap, activeProfileIds: keep, frozenProfileIds: frozen };
  });
}
