import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  BrandProfileLibraryError, brandProfilePayloadSchema, storedBrandProfilePayloadSchema,
  createBrandProfileFromPayloadInTransaction, saveBrandProfileDraft, publishBrandProfileDraft,
  resolveBrandProfileRevisionForNewProjectInTransaction, applyBrandRevisionDefaultsToProjectDraft,
} from "@/lib/brand-profile-library.server";
import { isPaid } from "@/lib/plan-limits";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import { isOmniVoiceUserAllowed, isHeroVoiceCloningEnabled } from "@/lib/omnivoice-policy";
import { RUNPOD_HERO_VOICES } from "@/lib/hero-voice-preview";
import { EDITOR_DEFAULT_DRAFT } from "@/lib/editor-default-draft";
import { createEditorProject } from "@/lib/editor-projects";
import { withTransientSqliteRetry } from "@/lib/sqlite-retry";
import type { PinAdmission } from "@/lib/brand-visual-pin-admission";
import type { BrandSetupResult } from "@/lib/brand-setup";

export const brandSetupRequestSchema = z.object({
  requestId: z.string().uuid(),
  action: z.enum(["save", "create-clip", "use-brand"]),
  profileId: z.string().min(1).max(180).optional(),
  expectedRevision: z.number().int().positive().optional(),
  revisionId: z.string().min(1).max(180).optional(),
  payload: brandProfilePayloadSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.action === "use-brand" ? !value.profileId || !value.revisionId : !value.payload) {
    ctx.addIssue({ code: "custom", message: "ข้อมูลแบรนด์ไม่ครบ กรุณาโหลดอีกครั้ง" });
  }
  if (value.profileId && value.action !== "use-brand" && !value.expectedRevision) {
    ctx.addIssue({ code: "custom", message: "กรุณาโหลดเวอร์ชันแบรนด์ก่อนบันทึก" });
  }
});

/** One atomic, replayable setup action. A network timeout cannot produce two
 * brands/projects. The request key is scoped to its authenticated owner, and
 * reusing it for different input fails instead of silently returning old work. */
export async function completeBrandSetup(userId: string, raw: unknown, admission: PinAdmission) {
  const input = brandSetupRequestSchema.parse(raw);
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return withTransientSqliteRetry(() => prisma.$transaction(async (tx) => {
    const prior = await tx.brandLibraryOperation.findUnique({ where: { userId_requestId: { userId, requestId: input.requestId } } });
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new BrandProfileLibraryError("REVISION_CONFLICT", "คำขอนี้ใช้กับข้อมูลอีกชุดแล้ว กรุณาโหลดแบรนด์อีกครั้ง");
      return { ...JSON.parse(prior.resultJson) as BrandSetupResult, replayed: true };
    }

    let revision;
    if (input.action === "use-brand") {
      const resolved = await resolveBrandProfileRevisionForNewProjectInTransaction(tx, { userId, profileId: input.profileId! });
      if (!resolved || resolved.revisionId !== input.revisionId) throw new BrandProfileLibraryError("REVISION_CONFLICT", "แบรนด์มีเวอร์ชันใหม่ กรุณาโหลดแล้วเลือกอีกครั้ง");
      revision = await tx.brandProfileRevision.findUniqueOrThrow({ where: { id: resolved.revisionId } });
    } else if (input.profileId) {
      const owned = await tx.brandProfile.findFirst({ where: { id: input.profileId, userId, archivedAt: null } });
      if (!owned) throw new BrandProfileLibraryError("NOT_FOUND", "ไม่พบแบรนด์นี้");
      if (owned.activeRevisionNumber !== input.expectedRevision) throw new BrandProfileLibraryError("REVISION_CONFLICT", "แบรนด์มีเวอร์ชันใหม่กว่า ร่างของคุณยังอยู่ กรุณาโหลดเวอร์ชันล่าสุด");
      await saveBrandProfileDraft({ userId, profileId: owned.id, payload: input.payload! }, tx);
      revision = await publishBrandProfileDraft({ userId, profileId: owned.id }, tx);
    } else {
      revision = (await createBrandProfileFromPayloadInTransaction(tx, { userId, payload: input.payload! })).revision;
    }

    const payload = storedBrandProfilePayloadSchema.parse(JSON.parse(revision.payloadJson));
    // Validate references in the same transaction: a removed/foreign asset
    // must roll back the revision and operation as well as the editor project.
    if (payload.brandMark.assetId && !await tx.brandAsset.findFirst({ where: { id: payload.brandMark.assetId, userId, retiredAt: null }, select: { id: true } })) {
      throw new BrandProfileLibraryError("INVALID_DRAFT", "โลโก้นี้ใช้ไม่ได้แล้ว กรุณาเลือกใหม่หรือปิดโลโก้");
    }
    const { provider, voiceId } = payload.voice;
    if (!["gemini", "elevenlabs", "omnivoice"].includes(provider) || provider === "gemini" && voiceId && !GEMINI_VOICES.some((v) => v.id === voiceId)) {
      throw new BrandProfileLibraryError("INVALID_DRAFT", "เสียงนี้ใช้ไม่ได้แล้ว กรุณาเลือกเสียงใหม่ในปรับรายละเอียด");
    }
    if (provider === "elevenlabs") {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { plan: true, elevenlabsKey: true } });
      if (!isPaid(user.plan) || !user.elevenlabsKey) throw new BrandProfileLibraryError("INVALID_DRAFT", "ElevenLabs ยังไม่พร้อมสำหรับบัญชีนี้ กรุณาเลือกเสียง AI หรือเชื่อมต่อ ElevenLabs ในตั้งค่า");
    }
    if (provider === "omnivoice") {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, email: true, role: true } });
      if (!isOmniVoiceUserAllowed(user)) throw new BrandProfileLibraryError("INVALID_DRAFT", "Hero AI Voice ยังไม่เปิดให้บัญชีนี้ กรุณาเลือกเสียงใหม่");
      if (voiceId?.startsWith("user_")) {
        if (!isHeroVoiceCloningEnabled() || user.role !== "ADMIN" || !await tx.userVoice.findFirst({ where: { id: voiceId.slice(5), userId }, select: { id: true } })) throw new BrandProfileLibraryError("INVALID_DRAFT", "เสียงส่วนตัวนี้ใช้ไม่ได้แล้ว กรุณาเลือกเสียงใหม่");
      } else if (voiceId && !RUNPOD_HERO_VOICES.some((v) => v.voice_id === voiceId) && process.env.OMNIVOICE_BACKEND === "runpod") {
        throw new BrandProfileLibraryError("INVALID_DRAFT", "เสียงนี้ใช้ไม่ได้แล้ว กรุณาเลือกเสียงใหม่");
      }
    }
    let projectId: string | null = null;
    if (input.action !== "save") {
      const project = await createEditorProject(userId, {
        title: `คลิปใหม่ · ${payload.name}`,
        draft: applyBrandRevisionDefaultsToProjectDraft({ draft: { ...EDITOR_DEFAULT_DRAFT, projectTitle: `คลิปใหม่ · ${payload.name}` }, payload }),
        brandProfileRevisionId: revision.id,
        brandVisualPinAdmission: admission,
      }, tx);
      projectId = project.id;
      await tx.brandProfile.update({ where: { id: revision.brandProfileId }, data: { lastUsedAt: new Date() } });
    }
    const result: BrandSetupResult = { profileId: revision.brandProfileId, revisionId: revision.id, revision: revision.version, projectId };
    await tx.brandLibraryOperation.create({ data: { userId, requestId: input.requestId, fingerprint, resultJson: JSON.stringify(result) } });
    return { ...result, replayed: false };
  }, { timeout: 15_000 }));
}
