import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  createDefaultStoryFilmEditorialConfig,
  parseStoryFilmEditorialConfig,
  validateStoryFilmEditorialConfig,
  type StoryFilmEditorialConfig,
} from "@/lib/story-film-editorial";
import { sceneUsesProjectCharacter } from "@/lib/story-film-character-placement";

export const STORY_FILM_STAGES = [
  "setup",
  "narration",
  "storyboard",
  "character_look",
  "keyframes",
  "videos",
  "music",
  "final_render",
  "completed",
] as const;

export type StoryFilmStage = (typeof STORY_FILM_STAGES)[number];
export type StoryFilmPresentationMode = "presenter_led" | "faceless";
export type StoryFilmNarrationProvider = "hero_voice" | "elevenlabs";
export type StoryFilmDecisionKind =
  | "approve"
  | "revise"
  | "reroll"
  | "fallback"
  | "pause"
  | "resume"
  | "retry"
  | "render";

const STAGE_LABELS: Record<StoryFilmStage, string> = {
  setup: "ตั้งค่าโปรเจกต์",
  narration: "เสียงบรรยาย",
  storyboard: "สตอรี่บอร์ด",
  character_look: "ตัวละครและลุค",
  keyframes: "ภาพหลักแต่ละฉาก",
  videos: "วิดีโอแต่ละฉาก",
  music: "เพลง",
  final_render: "เรนเดอร์ฉบับตรวจ",
  completed: "เสร็จแล้ว",
};

const RESUMABLE_STATUSES = ["active", "waiting_generation", "paused", "needs_attention"];
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9:_-]{8,120}$/;

type StoredStoryFilm = {
  id: string;
  title: string;
  presentationMode: string;
  sourcePackage: string | null;
  narrativeSource: string;
  narrationMasterUrl: string | null;
  narrationDurationMs: number | null;
  narrationProvider: string;
  narrationVoiceId: string | null;
  narrationVoiceSpeed: number | null;
  presenterAssetId: string | null;
  characterProfileId: string | null;
  characterReferenceSetVersion: number | null;
  characterLookBrief: string | null;
  musicSource: string | null;
  musicTrackId: string | null;
  musicUrl: string | null;
  finalRenderUrl: string | null;
  aspectRatio: string;
  durationLimitMs: number;
  status: string;
  stage: string;
  revision: number;
  generationEpoch: number;
  awaitingApproval: boolean;
  stageDataJson: string;
  createdAt: Date;
  updatedAt: Date;
};

export type StoryFilmProjectView = {
  id: string;
  title: string;
  presentationMode: StoryFilmPresentationMode;
  presentationModeLabel: string;
  sourcePackage: string | null;
  narrativeSource: string;
  narrationMasterUrl: string | null;
  narrationDurationMs: number | null;
  narrationProvider: StoryFilmNarrationProvider;
  narrationVoiceId: string | null;
  narrationVoiceSpeed: number | null;
  presenterAssetId: string | null;
  characterProfileId: string | null;
  characterReferenceSetVersion: number | null;
  characterLookBrief: string | null;
  musicSource: string | null;
  musicTrackId: string | null;
  musicUrl: string | null;
  finalRenderUrl: string | null;
  aspectRatio: "9:16";
  durationLimitMs: 180000;
  status: string;
  stage: StoryFilmStage;
  stageLabel: string;
  revision: number;
  generationEpoch: number;
  awaitingApproval: boolean;
  nextAction: string;
  reviewUrl: string;
  stageData: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export class StoryFilmError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "not_found"
      | "stale_revision"
      | "gate_not_ready"
      | "decision_not_allowed",
    message: string,
    public readonly current?: StoryFilmProjectView,
  ) {
    super(message);
    this.name = "StoryFilmError";
  }
}

function invalid(message: string): never {
  throw new StoryFilmError("invalid_input", message);
}

function isStage(value: string): value is StoryFilmStage {
  return (STORY_FILM_STAGES as readonly string[]).includes(value);
}

function parseStageData(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function nextActionFor(project: StoredStoryFilm): string {
  if (project.status === "paused") return "resume";
  if (project.status === "rendering") return "wait_for_render";
  if (project.status === "completed" || project.stage === "completed") return "complete";
  if (project.status === "needs_attention") return "resolve_attention";
  if (project.awaitingApproval) {
    if (project.stage === "final_render") {
      return parseStageData(project.stageDataJson).renderSetup === true
        ? "configure_final_cut"
        : "review_and_render";
    }
    return "review_and_decide";
  }
  return `wait_for_${project.stage}`;
}

function toView(project: StoredStoryFilm): StoryFilmProjectView {
  const stage = isStage(project.stage) ? project.stage : "setup";
  const presentationMode = project.presentationMode === "presenter_led" ? "presenter_led" : "faceless";
  return {
    id: project.id,
    title: project.title,
    presentationMode,
    presentationModeLabel: presentationMode === "presenter_led" ? "มีพิธีกร" : "Faceless",
    sourcePackage: project.sourcePackage,
    narrativeSource: project.narrativeSource,
    narrationMasterUrl: project.narrationMasterUrl,
    narrationDurationMs: project.narrationDurationMs,
    narrationProvider: project.narrationProvider === "elevenlabs" ? "elevenlabs" : "hero_voice",
    narrationVoiceId: project.narrationVoiceId,
    narrationVoiceSpeed: project.narrationVoiceSpeed,
    presenterAssetId: project.presenterAssetId,
    characterProfileId: project.characterProfileId,
    characterReferenceSetVersion: project.characterReferenceSetVersion,
    characterLookBrief: project.characterLookBrief,
    musicSource: project.musicSource,
    musicTrackId: project.musicTrackId,
    musicUrl: project.musicUrl,
    finalRenderUrl: project.finalRenderUrl,
    aspectRatio: "9:16",
    durationLimitMs: 180000,
    status: project.status,
    stage,
    stageLabel: STAGE_LABELS[stage],
    revision: project.revision,
    generationEpoch: project.generationEpoch,
    awaitingApproval: project.awaitingApproval,
    nextAction: nextActionFor(project),
    reviewUrl: `/ai-studio/story-film?project=${encodeURIComponent(project.id)}`,
    stageData: parseStageData(project.stageDataJson),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

function cleanStartInput(input: {
  title: string;
  idempotencyKey: string;
  presentationMode: StoryFilmPresentationMode;
  sourcePackage?: string | null;
  narrativeSource: string;
  presenterAssetId?: string | null;
  narrationProvider?: StoryFilmNarrationProvider | null;
  narrationVoiceId?: string | null;
  narrationVoiceSpeed?: number | null;
  characterProfileId?: string | null;
  characterLookBrief?: string | null;
  aspectRatio?: string;
}) {
  const title = input.title?.replace(/\s+/g, " ").trim();
  const narrativeSource = input.narrativeSource?.trim();
  const sourcePackage = input.sourcePackage?.trim() || null;
  const presenterAssetId = input.presenterAssetId?.trim() || null;
  const narrationProvider = input.narrationProvider === "elevenlabs" ? "elevenlabs" : "hero_voice";
  const narrationVoiceId = input.narrationVoiceId?.trim() || null;
  const narrationVoiceSpeed = Number.isFinite(input.narrationVoiceSpeed)
    ? Math.min(3, Math.max(0.3, input.narrationVoiceSpeed!))
    : 1;
  const characterProfileId = input.characterProfileId?.trim() || null;
  const characterLookBrief = input.characterLookBrief?.trim() || null;
  if (!title || title.length > 120) invalid("ชื่อโปรเจกต์ต้องยาว 1–120 ตัวอักษร");
  if (!IDEMPOTENCY_PATTERN.test(input.idempotencyKey ?? "")) invalid("idempotencyKey ไม่ถูกต้อง");
  if (input.presentationMode !== "presenter_led" && input.presentationMode !== "faceless") {
    invalid("Presentation Mode ต้องเป็น presenter_led หรือ faceless");
  }
  if (!narrativeSource || narrativeSource.length < 10 || narrativeSource.length > 12_000) {
    invalid("Narrative Source ต้องยาว 10–12,000 ตัวอักษร");
  }
  if (sourcePackage && sourcePackage.length > 500) invalid("sourcePackage ยาวเกิน 500 ตัวอักษร");
  if (input.presentationMode === "presenter_led" && !presenterAssetId) {
    invalid("แบบมีพิธีกรต้องอัปโหลดวิดีโอพิธีกรที่ทำ lipsync แล้ว");
  }
  if (input.presentationMode === "faceless" && presenterAssetId) {
    invalid("Faceless Project ไม่รับ Presenter Asset");
  }
  if (input.presentationMode === "faceless" && narrationProvider === "hero_voice" && !narrationVoiceId) {
    invalid("Faceless Project ต้องเลือกเสียงบรรยายจาก Hero Voice");
  }
  if (input.presentationMode === "presenter_led" && narrationVoiceId) {
    invalid("Presenter-led ใช้เสียงจากวิดีโอ lipsync จึงไม่รับ Hero Voice เพิ่ม");
  }
  if (narrationVoiceId && narrationVoiceId.length > 160) invalid("Voice ID ยาวเกินกำหนด");
  if (input.presentationMode === "faceless" && narrationProvider === "elevenlabs" && narrativeSource.length > 5_000) {
    invalid("ElevenLabs v3 รับ Narrative Source ได้ไม่เกิน 5,000 ตัวอักษร");
  }
  if (presenterAssetId && presenterAssetId.length > 120) invalid("Presenter Asset ID ยาวเกินกำหนด");
  if (characterProfileId && characterProfileId.length > 120) invalid("Character Profile ID ยาวเกินกำหนด");
  if (characterLookBrief && characterLookBrief.length > 1_000) invalid("Character Look Brief ยาวเกิน 1,000 ตัวอักษร");
  if (characterLookBrief && !characterProfileId) invalid("ต้องเลือก Character Profile ก่อนกำหนดลุคของคลิป");
  if (input.aspectRatio && input.aspectRatio !== "9:16") invalid("Hero Story Film pilot รองรับเฉพาะ 9:16");
  return {
    title,
    narrativeSource,
    sourcePackage,
    presenterAssetId,
    narrationProvider,
    narrationVoiceId,
    narrationVoiceSpeed,
    characterProfileId,
    characterLookBrief,
  };
}

export type StoryFilmPresenterAssetView = {
  id: string;
  url: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  durationMs: number;
};

export async function registerStoryFilmPresenterAsset(
  userId: string,
  input: Omit<StoryFilmPresenterAssetView, "id">,
): Promise<StoryFilmPresenterAssetView> {
  if (!input.url || input.url.length > 2_000) invalid("Presenter storage URL ไม่ถูกต้อง");
  if (!input.originalName || input.originalName.length > 255) invalid("ชื่อไฟล์ Presenter ไม่ถูกต้อง");
  if (!input.mimeType || input.mimeType.length > 120) invalid("ชนิดไฟล์ Presenter ไม่ถูกต้อง");
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > 500 * 1024 * 1024) {
    invalid("ไฟล์ Presenter ต้องมีขนาดไม่เกิน 500 MB");
  }
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width <= 0 || input.height <= 0) {
    invalid("อ่านขนาดวิดีโอ Presenter ไม่ได้");
  }
  if (Math.abs(input.width / input.height - 9 / 16) > 0.03) {
    invalid("วิดีโอ Presenter ต้องเป็นแนวตั้ง 9:16");
  }
  if (!Number.isInteger(input.durationMs) || input.durationMs <= 0 || input.durationMs > 180_000) {
    invalid("วิดีโอ Presenter ต้องยาวไม่เกิน 180 วินาที");
  }
  const asset = await prisma.storyFilmPresenterAsset.create({
    data: {
      userId,
      storageUrl: input.url,
      originalName: input.originalName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      width: input.width,
      height: input.height,
      durationMs: input.durationMs,
    },
  });
  return {
    id: asset.id,
    url: asset.storageUrl,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
    durationMs: asset.durationMs,
  };
}

export async function startStoryFilm(
  userId: string,
  input: {
    title: string;
    idempotencyKey: string;
    presentationMode: StoryFilmPresentationMode;
    sourcePackage?: string | null;
    narrativeSource: string;
    presenterAssetId?: string | null;
    narrationProvider?: StoryFilmNarrationProvider | null;
    narrationVoiceId?: string | null;
    narrationVoiceSpeed?: number | null;
    characterProfileId?: string | null;
    characterLookBrief?: string | null;
    aspectRatio?: string;
  },
): Promise<{ created: boolean; project: StoryFilmProjectView }> {
  const cleaned = cleanStartInput(input);
  const existing = await prisma.storyFilmProject.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) return { created: false, project: toView(existing) };

  let narrationVoiceId = cleaned.narrationVoiceId;
  if (input.presentationMode === "faceless" && cleaned.narrationProvider === "elevenlabs") {
    const account = await prisma.user.findUnique({
      where: { id: userId },
      select: { elevenlabsKey: true, elevenlabsVoiceId: true, plan: true },
    });
    if (!account?.elevenlabsKey) {
      invalid("บัญชีนี้ยังไม่ได้ตั้งค่า ElevenLabs API key");
    }
    if (account.plan === "FREE") {
      invalid("ElevenLabs Narration ใช้ได้เฉพาะแผน Pro ขึ้นไป");
    }
    narrationVoiceId = narrationVoiceId || account.elevenlabsVoiceId?.trim() || null;
    if (!narrationVoiceId) {
      invalid("ยังไม่ได้เลือกเสียงโคลน ElevenLabs ของบัญชีนี้");
    }
  }

  const presenterAsset = cleaned.presenterAssetId
    ? await prisma.storyFilmPresenterAsset.findFirst({
        where: { id: cleaned.presenterAssetId, userId },
      })
    : null;
  if (input.presentationMode === "presenter_led" && !presenterAsset) {
    invalid("ไม่พบ Presenter Asset ที่ผ่านการตรวจสำหรับบัญชีนี้ กรุณาอัปโหลดใหม่");
  }
  const narrationMasterUrl = presenterAsset?.storageUrl ?? null;
  const narrationDurationMs = presenterAsset?.durationMs ?? null;
  const characterProfile = cleaned.characterProfileId
    ? await prisma.storyFilmCharacterProfile.findFirst({
        where: { id: cleaned.characterProfileId, userId },
        include: { references: true },
      })
    : null;
  if (cleaned.characterProfileId && !characterProfile) {
    invalid("ไม่พบ Character Profile ของบัญชีนี้");
  }
  const characterReferences = characterProfile?.references.filter(
    (reference) => reference.setVersion === characterProfile.activeReferenceSetVersion,
  ) ?? [];
  if (characterProfile && characterReferences.length === 0) {
    invalid("Character Profile ต้องมี Reference อย่างน้อย 1 ภาพ");
  }
  const characterLookBrief = characterProfile
    ? cleaned.characterLookBrief || "Keep the same identity. Choose story-appropriate wardrobe and grooming, with one coherent look across every scene."
    : null;

  try {
    const project = await prisma.storyFilmProject.create({
      data: {
        userId,
        title: cleaned.title,
        idempotencyKey: input.idempotencyKey,
        presentationMode: input.presentationMode,
        sourcePackage: cleaned.sourcePackage,
        narrativeSource: cleaned.narrativeSource,
        narrationMasterUrl,
        narrationDurationMs,
        narrationProvider: cleaned.narrationProvider,
        narrationVoiceId,
        narrationVoiceSpeed: narrationVoiceId ? cleaned.narrationVoiceSpeed : null,
        presenterAssetId: presenterAsset?.id ?? null,
        characterProfileId: characterProfile?.id ?? null,
        characterReferenceSetVersion: characterProfile?.activeReferenceSetVersion ?? null,
        characterLookBrief,
        ...(characterProfile ? {
          characterLooks: {
            create: {
              characterProfileId: characterProfile.id,
              version: 1,
              brief: characterLookBrief!,
            },
          },
        } : {}),
        stageDataJson: JSON.stringify({
          gate: "setup",
          aspectRatio: "9:16",
          durationLimitMs: 180_000,
          sourcePackage: cleaned.sourcePackage,
          hasNarrationMaster: Boolean(narrationMasterUrl),
          narrationProvider: cleaned.narrationProvider,
          narrationVoiceId,
          narrationVoiceSpeed: narrationVoiceId ? cleaned.narrationVoiceSpeed : null,
          presenterAssetId: presenterAsset?.id ?? null,
          characterProfileId: characterProfile?.id ?? null,
          characterReferenceSetVersion: characterProfile?.activeReferenceSetVersion ?? null,
          characterLookBrief,
        }),
      },
    });
    return { created: true, project: toView(project) };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const duplicate = await prisma.storyFilmProject.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } },
      });
      if (duplicate) return { created: false, project: toView(duplicate) };
    }
    throw error;
  }
}

export async function listStoryFilms(userId: string, limit = 20): Promise<StoryFilmProjectView[]> {
  const projects = await prisma.storyFilmProject.findMany({
    where: { userId, status: { not: "archived" } },
    orderBy: { updatedAt: "desc" },
    take: Math.min(Math.max(Math.floor(limit), 1), 50),
  });
  return projects.map(toView);
}

export async function readStoryFilm(
  userId: string,
  query: { projectId: string } | { latestEligible: true },
): Promise<
  | { kind: "not_found" }
  | { kind: "project"; project: StoryFilmProjectView }
  | { kind: "candidates"; candidates: StoryFilmProjectView[] }
> {
  if ("projectId" in query) {
    const project = await prisma.storyFilmProject.findFirst({ where: { id: query.projectId, userId } });
    return project ? { kind: "project", project: toView(project) } : { kind: "not_found" };
  }
  const projects = await prisma.storyFilmProject.findMany({
    where: { userId, status: { in: RESUMABLE_STATUSES } },
    orderBy: { updatedAt: "desc" },
    take: 5,
  });
  if (projects.length === 0) return { kind: "not_found" };
  if (projects.length === 1) return { kind: "project", project: toView(projects[0]) };
  return { kind: "candidates", candidates: projects.map(toView) };
}

function validateDecision(input: {
  projectId: string;
  expectedStage: string;
  expectedRevision: number;
  decision: StoryFilmDecisionKind;
  instruction?: string | null;
  target?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
}) {
  if (!input.projectId?.trim()) invalid("projectId ห้ามว่าง");
  if (!isStage(input.expectedStage)) invalid("Stage ไม่ถูกต้อง");
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) invalid("Revision ไม่ถูกต้อง");
  if (!["approve", "revise", "reroll", "fallback", "pause", "resume", "retry", "render"].includes(input.decision)) {
    invalid("Decision ไม่ถูกต้อง");
  }
  const instruction = input.instruction?.trim() || null;
  if (["revise", "reroll", "fallback"].includes(input.decision) && !instruction) {
    invalid("กรุณาระบุสิ่งที่ต้องการแก้");
  }
  if (instruction && instruction.length > 2_000) invalid("คำสั่งแก้ไขยาวเกิน 2,000 ตัวอักษร");
  if (input.idempotencyKey && !IDEMPOTENCY_PATTERN.test(input.idempotencyKey)) invalid("idempotencyKey ไม่ถูกต้อง");
  const rawVideoSceneKeys = input.target?.videoSceneKeys;
  let videoSceneKeys: string[] | undefined;
  if (rawVideoSceneKeys !== undefined) {
    if (
      input.expectedStage !== "storyboard"
      || !["revise", "reroll", "fallback"].includes(input.decision)
      || !Array.isArray(rawVideoSceneKeys)
      || rawVideoSceneKeys.length > 60
      || rawVideoSceneKeys.some((value) => typeof value !== "string" || !/^scene-\d{2}$/u.test(value))
      || new Set(rawVideoSceneKeys).size !== rawVideoSceneKeys.length
    ) {
      invalid("videoSceneKeys ต้องเป็นรายการ scene key ที่ไม่ซ้ำกันสำหรับการแก้ Storyboard");
    }
    videoSceneKeys = rawVideoSceneKeys as string[];
  }
  const rawSceneKeys = input.target?.sceneKeys;
  let sceneKeys: string[] | undefined;
  if (rawSceneKeys !== undefined) {
    if (
      input.expectedStage !== "final_render"
      || !["revise", "reroll", "fallback"].includes(input.decision)
      || !Array.isArray(rawSceneKeys)
      || rawSceneKeys.length > 60
      || rawSceneKeys.some((value) => typeof value !== "string" || !/^scene-\d{2}$/u.test(value))
      || new Set(rawSceneKeys).size !== rawSceneKeys.length
    ) {
      invalid("sceneKeys ต้องเป็นรายการ scene key ที่ไม่ซ้ำกันสำหรับ Final Review");
    }
    sceneKeys = rawSceneKeys as string[];
  }
  const repairLayer = input.target?.repairLayer;
  if (repairLayer !== undefined && (repairLayer !== "keyframe" && repairLayer !== "video")) {
    invalid("repairLayer ต้องเป็น keyframe หรือ video");
  }
  let editorial: StoryFilmEditorialConfig | undefined;
  if (input.target?.editorial !== undefined) {
    try {
      editorial = validateStoryFilmEditorialConfig(input.target.editorial);
    } catch (error) {
      invalid(error instanceof Error ? error.message : "Editorial config ไม่ถูกต้อง");
    }
  }
  return { instruction, videoSceneKeys, sceneKeys, repairLayer, editorial };
}

function stageAfterApproval(stage: StoryFilmStage): StoryFilmStage | null {
  const index = STORY_FILM_STAGES.indexOf(stage);
  const next = STORY_FILM_STAGES[index + 1];
  return next && next !== "completed" ? next : null;
}

export async function decideStoryFilm(
  userId: string,
  input: {
    projectId: string;
    expectedStage: StoryFilmStage;
    expectedRevision: number;
    decision: StoryFilmDecisionKind;
    instruction?: string | null;
    target?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
  },
): Promise<StoryFilmProjectView> {
  const { instruction, videoSceneKeys, sceneKeys, repairLayer, editorial } = validateDecision(input);
  return prisma.$transaction(async (tx) => {
    if (input.idempotencyKey) {
      const prior = await tx.storyFilmDecision.findUnique({
        where: { projectId_idempotencyKey: { projectId: input.projectId, idempotencyKey: input.idempotencyKey } },
      });
      if (prior) {
        const current = await tx.storyFilmProject.findFirst({ where: { id: input.projectId, userId } });
        if (!current) throw new StoryFilmError("not_found", "ไม่พบ Hero Story Film Project");
        return toView(current);
      }
    }

    const project = await tx.storyFilmProject.findFirst({ where: { id: input.projectId, userId } });
    if (!project) throw new StoryFilmError("not_found", "ไม่พบ Hero Story Film Project");
    const currentView = toView(project);
    if (project.stage !== input.expectedStage || project.revision !== input.expectedRevision) {
      throw new StoryFilmError("stale_revision", "โปรเจกต์เปลี่ยนจาก revision ที่กำลังดู กรุณาเปิด review ล่าสุด", currentView);
    }
    if (!isStage(project.stage)) throw new StoryFilmError("decision_not_allowed", "Stage ปัจจุบันไม่รองรับ");
    const isRevisionDecision = ["revise", "reroll", "fallback"].includes(input.decision);
    if (isRevisionDecision && !["storyboard", "character_look", "keyframes", "videos", "final_render"].includes(project.stage)) {
      throw new StoryFilmError(
        "decision_not_allowed",
        "ขั้นนี้แก้ด้วยการเลือกตัวเลือกใหม่หรือเริ่มโปรเจกต์ใหม่ แทนการสร้าง asset ซ้ำ",
        currentView,
      );
    }
    if (isRevisionDecision && project.stage === "character_look" && !project.characterProfileId) {
      throw new StoryFilmError("decision_not_allowed", "โปรเจกต์นี้ไม่ได้ใช้ Character Profile จึงไม่มีลุคให้สร้างใหม่", currentView);
    }
    const revisionSceneKey = typeof input.target?.sceneKey === "string"
      ? input.target.sceneKey.trim()
      : "";
    let revisionScene: Awaited<ReturnType<typeof tx.storyFilmScene.findFirst>> = null;
    if (isRevisionDecision && ["keyframes", "videos"].includes(project.stage)) {
      if (!revisionSceneKey) {
        throw new StoryFilmError("invalid_input", "กรุณาเลือกฉากที่ต้องการสร้างใหม่", currentView);
      }
      revisionScene = await tx.storyFilmScene.findFirst({
        where: { projectId: project.id, sceneKey: revisionSceneKey },
        orderBy: { generationEpoch: "desc" },
      });
      if (!revisionScene || revisionScene.visualOwner !== "broll") {
        throw new StoryFilmError("invalid_input", "ฉากที่เลือกไม่ใช่ B-roll ของโปรเจกต์นี้", currentView);
      }
      if (project.stage === "videos" && revisionScene.mediaPlan !== "video") {
        throw new StoryFilmError("invalid_input", "ฉากนี้ใช้ Image + Motion จึงไม่มี AI Video ให้สร้างใหม่", currentView);
      }
    }
    let finalRevisionScenes: Awaited<ReturnType<typeof tx.storyFilmScene.findMany>> = [];
    if (isRevisionDecision && project.stage === "final_render" && sceneKeys?.length) {
      const latestScene = await tx.storyFilmScene.findFirst({
        where: { projectId: project.id },
        orderBy: [{ generationEpoch: "desc" }, { sequence: "asc" }],
      });
      if (!latestScene) throw new StoryFilmError("decision_not_allowed", "โปรเจกต์นี้ไม่มี Scene ให้แก้", currentView);
      finalRevisionScenes = await tx.storyFilmScene.findMany({
        where: {
          projectId: project.id,
          generationEpoch: latestScene.generationEpoch,
          sceneKey: { in: sceneKeys },
        },
        orderBy: { sequence: "asc" },
      });
      if (finalRevisionScenes.length !== sceneKeys.length || finalRevisionScenes.some((scene) => scene.visualOwner !== "broll")) {
        throw new StoryFilmError("invalid_input", "Final Review แก้ได้เฉพาะ B-roll scene ของโปรเจกต์นี้", currentView);
      }
      if (repairLayer === "video" && finalRevisionScenes.some((scene) => scene.mediaPlan !== "video")) {
        throw new StoryFilmError("invalid_input", "ชั้น Video เลือกได้เฉพาะฉากที่ใช้ AI Video", currentView);
      }
      if (!repairLayer) {
        throw new StoryFilmError("invalid_input", "กรุณาเลือกว่าจะซ่อมภาพตั้งต้นหรือวิดีโอ", currentView);
      }
    }

    let nextStage: StoryFilmStage = project.stage;
    let nextStatus = project.status;
    let awaitingApproval = project.awaitingApproval;
    let stageDataJson = project.stageDataJson;
    let selectedMusic: { source: "user" | "system"; trackId: string; url: string; title: string } | null = null;
    let shouldQueueFinalRender = false;
    let finalRenderEditorial = editorial ?? createDefaultStoryFilmEditorialConfig(
      project.narrativeSource,
      project.narrationDurationMs ?? project.durationLimitMs,
    );
    const resolveMusic = async (source: unknown, trackId: unknown) => {
      if ((source !== "user" && source !== "system") || typeof trackId !== "string" || !trackId) {
        throw new StoryFilmError("invalid_input", "กรุณาเลือกเพลงจาก Music Library ก่อนอนุมัติ");
      }
      if (source === "user") {
        const track = await tx.userMusic.findFirst({ where: { id: trackId, userId } });
        if (!track) throw new StoryFilmError("invalid_input", "ไม่พบเพลงของบัญชีนี้");
        return { source, trackId: track.id, url: `/api/music/${track.filename}`, title: track.title } as const;
      }
      const track = await tx.music.findUnique({ where: { id: trackId } });
      if (!track) throw new StoryFilmError("invalid_input", "ไม่พบเพลงกลางที่เลือก");
      return { source, trackId: track.id, url: `/api/music/${track.filename}`, title: track.title } as const;
    };
    const currentMusic = () => project.musicSource && project.musicTrackId && project.musicUrl
      ? {
          source: project.musicSource === "system" ? "system" as const : "user" as const,
          trackId: project.musicTrackId,
          url: project.musicUrl,
          title: "เพลงที่เลือกไว้",
        }
      : null;

    if (input.decision === "retry") {
      if (project.status !== "needs_attention") {
        throw new StoryFilmError("decision_not_allowed", "โปรเจกต์นี้ไม่มีงานที่ต้องลองใหม่", currentView);
      }
      const attentionJobs = await tx.storyFilmGenerationJob.findMany({
        where: {
          projectId: project.id,
          stage: project.stage,
          generationEpoch: project.generationEpoch,
          status: "needs_attention",
        },
        select: { id: true },
      });
      if (attentionJobs.length === 0) {
        throw new StoryFilmError("decision_not_allowed", "ไม่พบงานที่ล้มเหลวใน stage ปัจจุบัน", currentView);
      }
      const now = new Date();
      const requeued = await tx.storyFilmGenerationJob.updateMany({
        where: { id: { in: attentionJobs.map((job) => job.id) }, status: "needs_attention" },
        data: {
          status: "queued",
          technicalFailureCount: 0,
          providerJobId: null,
          leaseOwner: null,
          leaseTokenHash: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          availableAt: now,
          submittedAt: null,
          finishedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      });
      if (requeued.count !== attentionJobs.length) {
        throw new StoryFilmError("stale_revision", "สถานะงานเปลี่ยนระหว่างลองใหม่ กรุณาเปิด review ล่าสุด", currentView);
      }
      const priorStageData = parseStageData(project.stageDataJson);
      nextStatus = "waiting_generation";
      awaitingApproval = false;
      stageDataJson = JSON.stringify({
        ...priorStageData,
        gate: project.stage,
        waitingForGeneration: true,
        requestedDecision: "retry",
        retryJobIds: attentionJobs.map((job) => job.id),
      });
    } else if (input.decision === "pause") {
      if (["completed", "archived", "rendering"].includes(project.status)) {
        throw new StoryFilmError("decision_not_allowed", "โปรเจกต์สถานะนี้พักไม่ได้", currentView);
      }
      nextStatus = "paused";
    } else if (input.decision === "resume") {
      if (project.status !== "paused") throw new StoryFilmError("decision_not_allowed", "โปรเจกต์นี้ไม่ได้พักอยู่", currentView);
      nextStatus = project.awaitingApproval ? "active" : "waiting_generation";
    } else if (input.decision === "render") {
      if (project.stage !== "final_render" || !project.awaitingApproval) {
        throw new StoryFilmError("gate_not_ready", "Final Render ยังไม่พร้อมให้อนุมัติ", currentView);
      }
      if (!project.finalRenderUrl) {
        throw new StoryFilmError("gate_not_ready", "ยังไม่มีไฟล์ Final Render สำหรับอนุมัติ", currentView);
      }
      const visualQa = input.target?.visualQa;
      if (!visualQa || typeof visualQa !== "object" || Array.isArray(visualQa)
        || (visualQa as Record<string, unknown>).anatomy !== true
        || (visualQa as Record<string, unknown>).spatialDirection !== true
        || (visualQa as Record<string, unknown>).continuity !== true
        || (visualQa as Record<string, unknown>).generatedText !== true) {
        throw new StoryFilmError("gate_not_ready", "กรุณาตรวจ Visual QA ให้ครบก่อนอนุมัติ Final Render", currentView);
      }
      nextStage = "completed";
      nextStatus = "completed";
      awaitingApproval = false;
      stageDataJson = JSON.stringify({
        gate: "completed",
        finalRenderUrl: project.finalRenderUrl,
      });
    } else {
      if (!project.awaitingApproval) {
        throw new StoryFilmError("gate_not_ready", "ขั้นนี้ยังไม่มีงานรอการตัดสินใจ", currentView);
      }
      if (input.decision === "approve") {
        const priorStageData = parseStageData(project.stageDataJson);
        const repair = priorStageData.repair && typeof priorStageData.repair === "object"
          ? priorStageData.repair as Record<string, unknown>
          : null;
        if (project.stage === "final_render") {
          selectedMusic = input.target?.musicSource || input.target?.musicTrackId
            ? await resolveMusic(input.target?.musicSource, input.target?.musicTrackId)
            : currentMusic();
          if (!selectedMusic) throw new StoryFilmError("invalid_input", "Final Render ยังไม่ได้เลือกเพลง", currentView);
          finalRenderEditorial = editorial ?? parseStoryFilmEditorialConfig(
            priorStageData.editorial,
            project.narrationDurationMs ?? project.durationLimitMs,
          );
          nextStage = "final_render";
          nextStatus = "waiting_generation";
          awaitingApproval = false;
          shouldQueueFinalRender = true;
          stageDataJson = JSON.stringify({
            ...priorStageData,
            gate: "final_render",
            renderSetup: false,
            waitingForGeneration: true,
            selectedMusic,
            editorial: finalRenderEditorial,
          });
        } else if (repair?.origin === "final_render" && ["keyframes", "videos"].includes(project.stage)) {
          const repairSceneKeys = Array.isArray(repair.sceneKeys)
            ? repair.sceneKeys.filter((value): value is string => typeof value === "string")
            : [];
          selectedMusic = currentMusic();
          finalRenderEditorial = parseStoryFilmEditorialConfig(
            repair.editorial,
            project.narrationDurationMs ?? project.durationLimitMs,
          );
          let repairedVideoSceneKeys: string[] = [];
          if (project.stage === "keyframes" && repairSceneKeys.length > 0) {
            const latestScene = await tx.storyFilmScene.findFirst({
              where: { projectId: project.id },
              orderBy: [{ generationEpoch: "desc" }, { sequence: "asc" }],
            });
            if (latestScene) {
              repairedVideoSceneKeys = (await tx.storyFilmScene.findMany({
                where: {
                  projectId: project.id,
                  generationEpoch: latestScene.generationEpoch,
                  sceneKey: { in: repairSceneKeys },
                  visualOwner: "broll",
                  mediaPlan: "video",
                },
                orderBy: { sequence: "asc" },
              })).map((scene) => scene.sceneKey);
            }
          }
          nextStage = repairedVideoSceneKeys.length > 0 ? "videos" : "final_render";
          nextStatus = "waiting_generation";
          awaitingApproval = false;
          shouldQueueFinalRender = nextStage === "final_render";
          stageDataJson = JSON.stringify({
            ...priorStageData,
            gate: nextStage,
            waitingForGeneration: true,
            repair: { ...repair, sceneKeys: repairedVideoSceneKeys.length ? repairedVideoSceneKeys : repairSceneKeys },
            selectedMusic,
            editorial: finalRenderEditorial,
          });
        } else {
          if (project.stage === "music") {
            selectedMusic = await resolveMusic(input.target?.musicSource, input.target?.musicTrackId);
          }
          const advanced = stageAfterApproval(project.stage);
          if (!advanced) throw new StoryFilmError("decision_not_allowed", "ขั้นนี้ต้องใช้คำสั่งเรนเดอร์", currentView);
          nextStage = advanced;
        // A script is not a Narration Master. Presenter-led starts with a
        // server-probed master; Faceless waits here until a voice adapter
        // commits real audio and timing.
          const narrationReady = advanced === "narration"
            && Boolean(project.narrationMasterUrl && project.narrationDurationMs);
          const characterLookNotNeeded = advanced === "character_look" && !project.characterProfileId;
          const musicCandidates = advanced === "music" || advanced === "final_render"
            ? [
              ...(await tx.userMusic.findMany({
                where: { userId },
                orderBy: { updatedAt: "desc" },
                take: 20,
              })).map((track) => ({
                source: "user" as const,
                trackId: track.id,
                title: track.title,
                url: `/api/music/${track.filename}`,
                durationMs: track.duration ? Math.round(track.duration * 1_000) : null,
              })),
              ...(await tx.music.findMany({ orderBy: { createdAt: "desc" }, take: 20 })).map((track) => ({
                source: "system" as const,
                trackId: track.id,
                title: track.title,
                url: `/api/music/${track.filename}`,
                durationMs: track.duration ? Math.round(track.duration * 1_000) : null,
              })),
              ]
            : [];
          const musicReady = advanced === "music" && musicCandidates.length > 0;
          awaitingApproval = narrationReady || characterLookNotNeeded || musicReady || advanced === "final_render";
          nextStatus = awaitingApproval ? "active" : "waiting_generation";
          if (advanced === "final_render" && selectedMusic) {
            const latestScene = await tx.storyFilmScene.findFirst({
              where: { projectId: project.id },
              orderBy: [{ generationEpoch: "desc" }, { sequence: "asc" }],
            });
            const scenes = latestScene ? await tx.storyFilmScene.findMany({
              where: { projectId: project.id, generationEpoch: latestScene.generationEpoch },
              orderBy: { sequence: "asc" },
            }) : [];
            stageDataJson = JSON.stringify({
              gate: "final_render",
              renderSetup: true,
              waitingForGeneration: false,
              selectedMusic,
              musicCandidates,
              editorial: createDefaultStoryFilmEditorialConfig(
                project.narrativeSource,
                project.narrationDurationMs ?? project.durationLimitMs,
              ),
              scenes: scenes.map((scene) => ({
                sceneKey: scene.sceneKey,
                sequence: scene.sequence,
                startMs: scene.startMs,
                endMs: scene.endMs,
                sourceExcerpt: scene.sourceExcerpt,
                mediaPlan: scene.mediaPlan,
                visualOwner: scene.visualOwner,
              })),
            });
          } else stageDataJson = advanced === "narration"
            ? JSON.stringify({
              gate: "narration",
              narrativeSource: project.narrativeSource,
              narrationMasterUrl: project.narrationMasterUrl,
              waitingForGeneration: !narrationReady,
            })
          : characterLookNotNeeded
            ? JSON.stringify({
                gate: "character_look",
                skipped: true,
                reason: "โปรเจกต์นี้ไม่ได้ pin Character Profile จึงไม่ต้องสร้างลุคตัวละคร",
              })
            : musicReady
              ? JSON.stringify({ gate: "music", candidates: musicCandidates, reuseFirst: true })
              : JSON.stringify({ gate: advanced, waitingForGeneration: true });
        }
      } else {
        if (project.stage === "final_render") {
          const priorStageData = parseStageData(project.stageDataJson);
          selectedMusic = input.target?.musicSource || input.target?.musicTrackId
            ? await resolveMusic(input.target?.musicSource, input.target?.musicTrackId)
            : currentMusic();
          if (!selectedMusic) throw new StoryFilmError("invalid_input", "Final Render ยังไม่ได้เลือกเพลง", currentView);
          finalRenderEditorial = editorial ?? parseStoryFilmEditorialConfig(
            priorStageData.editorial,
            project.narrationDurationMs ?? project.durationLimitMs,
          );
          nextStage = sceneKeys?.length ? (repairLayer === "video" ? "videos" : "keyframes") : "final_render";
          nextStatus = "waiting_generation";
          awaitingApproval = false;
          shouldQueueFinalRender = nextStage === "final_render";
          stageDataJson = JSON.stringify({
            gate: nextStage,
            waitingForGeneration: true,
            requestedDecision: input.decision,
            instruction,
            selectedMusic,
            editorial: finalRenderEditorial,
            musicCandidates: priorStageData.musicCandidates ?? [],
            scenes: priorStageData.scenes ?? [],
            repair: sceneKeys?.length ? {
              origin: "final_render",
              sceneKeys,
              repairLayer,
              instruction,
              editorial: finalRenderEditorial,
              previousFinalRenderUrl: project.finalRenderUrl,
            } : null,
          });
        } else {
          nextStatus = "waiting_generation";
          awaitingApproval = false;
          stageDataJson = JSON.stringify({
            gate: project.stage,
            waitingForGeneration: true,
            requestedDecision: input.decision,
            instruction,
            target: input.target ?? null,
          });
        }
      }
    }

    const resultRevision = project.revision + 1;
    const changesGenerationEpoch = input.decision === "approve"
      || ["revise", "reroll", "fallback"].includes(input.decision);
    const resultGenerationEpoch = changesGenerationEpoch
      ? project.generationEpoch + 1
      : project.generationEpoch;
    const updated = await tx.storyFilmProject.updateMany({
      where: { id: project.id, userId, stage: project.stage, revision: project.revision },
      data: {
        stage: nextStage,
        status: nextStatus,
        revision: resultRevision,
        generationEpoch: resultGenerationEpoch,
        awaitingApproval,
        stageDataJson,
        ...(selectedMusic ? {
          musicSource: selectedMusic.source,
          musicTrackId: selectedMusic.trackId,
          musicUrl: selectedMusic.url,
        } : {}),
        lastOpenedAt: new Date(),
      },
    });
    if (updated.count !== 1) {
      const latest = await tx.storyFilmProject.findFirst({ where: { id: project.id, userId } });
      throw new StoryFilmError(
        "stale_revision",
        "มีการตัดสินใจอื่นบันทึกก่อนแล้ว กรุณาเปิด review ล่าสุด",
        latest ? toView(latest) : undefined,
      );
    }
    if (input.decision === "approve" && nextStage === "storyboard") {
      await tx.storyFilmGenerationJob.create({
        data: {
          projectId: project.id,
          stage: "storyboard",
          projectRevision: resultRevision,
          generationEpoch: resultGenerationEpoch,
          kind: "storyboard_plan",
          providerBackend: "hero_text",
          payloadJson: JSON.stringify({
            narrativeSource: project.narrativeSource,
            narrationMasterUrl: project.narrationMasterUrl,
            narrationDurationMs: project.narrationDurationMs,
            aspectRatio: "9:16",
            targetSceneDurationSec: 7,
          }),
          idempotencyKey: `auto:storyboard:epoch:${resultGenerationEpoch}`,
        },
      });
      if (project.presentationMode === "presenter_led" && project.narrationMasterUrl) {
        await tx.storyFilmGenerationJob.create({
          data: {
            projectId: project.id,
            stage: "storyboard",
            projectRevision: resultRevision,
            generationEpoch: resultGenerationEpoch,
            kind: "caption_alignment",
            providerBackend: "hero_alignment",
            sceneKey: "narration-captions",
            payloadJson: JSON.stringify({
              narrationMasterUrl: project.narrationMasterUrl,
              narrationDurationMs: project.narrationDurationMs,
              script: project.narrativeSource,
            }),
            idempotencyKey: `auto:caption-alignment:epoch:${resultGenerationEpoch}`,
            priority: 80,
          },
        });
      }
    }
    if (input.decision === "approve" && nextStage === "narration" && !project.narrationMasterUrl) {
      if (!project.narrationVoiceId) {
        throw new StoryFilmError("decision_not_allowed", "Faceless Project ยังไม่ได้เลือกเสียงบรรยาย");
      }
      const narrationProvider = project.narrationProvider === "elevenlabs" ? "elevenlabs" : "hero_voice";
      await tx.storyFilmGenerationJob.create({
        data: {
          projectId: project.id,
          stage: "narration",
          projectRevision: resultRevision,
          generationEpoch: resultGenerationEpoch,
          kind: "narration_voice",
          providerBackend: narrationProvider,
          sceneKey: "narration-master",
          payloadJson: JSON.stringify({
            text: project.narrativeSource,
            voiceId: project.narrationVoiceId,
            speed: project.narrationVoiceSpeed ?? 1,
            ...(narrationProvider === "elevenlabs" ? { modelId: "eleven_v3", languageCode: "th" } : {}),
          }),
          idempotencyKey: `auto:narration:epoch:${resultGenerationEpoch}`,
        },
      });
    }
    if (input.decision === "approve" && nextStage === "character_look" && project.characterProfileId) {
      const references = await tx.storyFilmCharacterReference.findMany({
        where: {
          profileId: project.characterProfileId,
          setVersion: project.characterReferenceSetVersion ?? 1,
        },
        orderBy: { createdAt: "asc" },
      });
      if (references.length === 0) throw new StoryFilmError("decision_not_allowed", "Reference Set ที่โปรเจกต์ pin ไว้ไม่มีภาพ");
      await tx.storyFilmGenerationJob.create({
        data: {
          projectId: project.id,
          stage: "character_look",
          projectRevision: resultRevision,
          generationEpoch: resultGenerationEpoch,
          kind: "look_image",
          providerBackend: "grok_subscription",
          sceneKey: "main-character-look",
          payloadJson: JSON.stringify({
            prompt: [
              "Create a vertical 9:16 cinematic full-body character look reference for this short film.",
              project.characterLookBrief,
              "Preserve the exact facial identity from the supplied references. Show one person, one coherent wardrobe, neutral cinematic environment, no character sheet grid, no collage, no text.",
            ].filter(Boolean).join(" "),
            referenceUrls: references.map((reference) => `/api/internal/story-film-media/character-references/${encodeURIComponent(reference.id)}`),
            aspectRatio: "9:16",
          }),
          idempotencyKey: `auto:character-look:epoch:${resultGenerationEpoch}`,
        },
      });
    }
    if (input.decision === "approve" && nextStage === "keyframes") {
      const latestScene = await tx.storyFilmScene.findFirst({
        where: { projectId: project.id },
        orderBy: [{ generationEpoch: "desc" }, { sequence: "asc" }],
      });
      if (!latestScene) throw new StoryFilmError("decision_not_allowed", "ยังไม่มี Storyboard Scene สำหรับสร้าง Keyframe");
      const scenes = await tx.storyFilmScene.findMany({
        where: {
          projectId: project.id,
          generationEpoch: latestScene.generationEpoch,
          visualOwner: "broll",
        },
        orderBy: { sequence: "asc" },
      });
      const references = project.characterProfileId
        ? await tx.storyFilmCharacterReference.findMany({
            where: {
              profileId: project.characterProfileId,
              setVersion: project.characterReferenceSetVersion ?? 1,
            },
            orderBy: { createdAt: "asc" },
          })
        : [];
      const approvedLook = project.characterProfileId
        ? await tx.storyFilmArtifact.findFirst({
            where: { projectId: project.id, stage: "character_look", kind: "look_image" },
            orderBy: { createdAt: "desc" },
          })
        : null;
      for (const scene of scenes) {
        const referenceUrls = sceneUsesProjectCharacter(scene.characterDirectivesJson)
          ? [
              ...(approvedLook ? [approvedLook.storageUrl] : []),
              ...references.map((reference) => `/api/internal/story-film-media/character-references/${encodeURIComponent(reference.id)}`),
            ]
          : [];
        await tx.storyFilmGenerationJob.create({
          data: {
            projectId: project.id,
            stage: "keyframes",
            projectRevision: resultRevision,
            generationEpoch: resultGenerationEpoch,
            kind: "keyframe_image",
            providerBackend: "grok_subscription",
            sceneKey: scene.sceneKey,
            payloadJson: JSON.stringify({
              prompt: scene.grokPrompt,
              referenceUrls,
              aspectRatio: "9:16",
              storyboardSceneEpoch: scene.generationEpoch,
            }),
            idempotencyKey: `auto:keyframe:${scene.sceneKey}:epoch:${resultGenerationEpoch}`,
          },
        });
      }
    }
    if (input.decision === "approve" && nextStage === "videos") {
      const approvalStageData = parseStageData(project.stageDataJson);
      const approvalRepair = approvalStageData.repair && typeof approvalStageData.repair === "object"
        ? approvalStageData.repair as Record<string, unknown>
        : null;
      const repairSceneKeys = approvalRepair?.origin === "final_render" && Array.isArray(approvalRepair.sceneKeys)
        ? approvalRepair.sceneKeys.filter((value): value is string => typeof value === "string")
        : null;
      const latestScene = await tx.storyFilmScene.findFirst({
        where: { projectId: project.id },
        orderBy: [{ generationEpoch: "desc" }, { sequence: "asc" }],
      });
      if (!latestScene) throw new StoryFilmError("decision_not_allowed", "ยังไม่มี Storyboard Scene สำหรับสร้างวิดีโอ");
      const videoScenes = await tx.storyFilmScene.findMany({
        where: {
          projectId: project.id,
          generationEpoch: latestScene.generationEpoch,
          mediaPlan: "video",
          visualOwner: "broll",
          ...(repairSceneKeys ? { sceneKey: { in: repairSceneKeys } } : {}),
        },
        orderBy: { sequence: "asc" },
      });
      const keyframes = await tx.storyFilmArtifact.findMany({
        where: {
          projectId: project.id,
          stage: "keyframes",
          kind: "keyframe_image",
        },
        orderBy: { createdAt: "desc" },
      });
      const keyframeByScene = new Map<string | null, (typeof keyframes)[number]>();
      keyframes.forEach((artifact) => {
        if (!keyframeByScene.has(artifact.sceneKey)) keyframeByScene.set(artifact.sceneKey, artifact);
      });
      for (const scene of videoScenes) {
        const source = keyframeByScene.get(scene.sceneKey);
        if (!source) throw new StoryFilmError("decision_not_allowed", `ไม่พบ Keyframe ที่อนุมัติของ ${scene.sceneKey}`);
        await tx.storyFilmGenerationJob.create({
          data: {
            projectId: project.id,
            stage: "videos",
            projectRevision: resultRevision,
            generationEpoch: resultGenerationEpoch,
            kind: "scene_video",
            providerBackend: "grok_subscription",
            sceneKey: scene.sceneKey,
            payloadJson: JSON.stringify({
              prompt: scene.grokPrompt,
              sourceImageUrl: source.storageUrl,
              durationSec: Math.max(1, (scene.endMs - scene.startMs) / 1_000),
              aspectRatio: "9:16",
            }),
            idempotencyKey: `auto:video:${scene.sceneKey}:epoch:${resultGenerationEpoch}`,
          },
        });
      }
      if (videoScenes.length === 0) {
        await tx.storyFilmProject.update({
          where: { id: project.id },
          data: {
            status: "active",
            awaitingApproval: true,
            stageDataJson: JSON.stringify({
              gate: "videos",
              skipped: true,
              reason: "Storyboard ชุดนี้ใช้ภาพกับ editorial motion ทุกฉาก จึงไม่ต้องเรียก AI Video",
            }),
          },
        });
      }
    }
    if (input.decision === "approve" && nextStage === "music" && !awaitingApproval) {
      await tx.storyFilmGenerationJob.create({
        data: {
          projectId: project.id,
          stage: "music",
          projectRevision: resultRevision,
          generationEpoch: resultGenerationEpoch,
          kind: "music",
          providerBackend: "vidiq",
          sceneKey: "soundtrack",
          payloadJson: JSON.stringify({
            title: project.title,
            narrativeSource: project.narrativeSource,
            narrationDurationMs: project.narrationDurationMs,
            crossPlatform: ["facebook", "instagram", "youtube", "tiktok"],
          }),
          idempotencyKey: `auto:music:epoch:${resultGenerationEpoch}`,
        },
      });
    }
    if (shouldQueueFinalRender && nextStage === "final_render" && selectedMusic) {
      await tx.storyFilmGenerationJob.create({
        data: {
          projectId: project.id,
          stage: "final_render",
          projectRevision: resultRevision,
          generationEpoch: resultGenerationEpoch,
          kind: "final_render",
          providerBackend: "hero_render",
          sceneKey: "master",
          payloadJson: JSON.stringify({
            aspectRatio: "9:16",
            durationLimitMs: 180_000,
            presentationMode: project.presentationMode,
            narrationMasterUrl: project.narrationMasterUrl,
            narrationDurationMs: project.narrationDurationMs,
            musicSource: selectedMusic.source,
            musicTrackId: selectedMusic.trackId,
            musicUrl: selectedMusic.url,
            editorial: finalRenderEditorial,
          }),
          idempotencyKey: `auto:final-render:epoch:${resultGenerationEpoch}`,
          priority: 50,
        },
      });
    }
    if (isRevisionDecision && project.stage === "storyboard") {
      await tx.storyFilmGenerationJob.create({
        data: {
          projectId: project.id,
          stage: "storyboard",
          projectRevision: resultRevision,
          generationEpoch: resultGenerationEpoch,
          kind: "storyboard_plan",
          providerBackend: "hero_text",
          payloadJson: JSON.stringify({
            narrativeSource: project.narrativeSource,
            narrationMasterUrl: project.narrationMasterUrl,
            narrationDurationMs: project.narrationDurationMs,
            aspectRatio: "9:16",
            targetSceneDurationSec: 7,
            revisionInstruction: instruction,
            revisionMode: input.decision,
            ...(videoSceneKeys ? { videoSceneKeys } : {}),
          }),
          idempotencyKey: `revise:storyboard:epoch:${resultGenerationEpoch}`,
        },
      });
    }
    if (isRevisionDecision && project.stage === "character_look" && project.characterProfileId) {
      const references = await tx.storyFilmCharacterReference.findMany({
        where: {
          profileId: project.characterProfileId,
          setVersion: project.characterReferenceSetVersion ?? 1,
        },
        orderBy: { createdAt: "asc" },
      });
      if (references.length === 0) throw new StoryFilmError("decision_not_allowed", "Reference Set ที่โปรเจกต์ pin ไว้ไม่มีภาพ");
      await tx.storyFilmGenerationJob.create({
        data: {
          projectId: project.id,
          stage: "character_look",
          projectRevision: resultRevision,
          generationEpoch: resultGenerationEpoch,
          kind: "look_image",
          providerBackend: "grok_subscription",
          sceneKey: "main-character-look",
          payloadJson: JSON.stringify({
            prompt: [
              "Create a revised vertical 9:16 cinematic full-body character look reference for this short film.",
              project.characterLookBrief,
              `Creator revision: ${instruction}`,
              "Preserve the exact facial identity from the supplied references. Show one person, one coherent wardrobe, neutral cinematic environment, no character sheet grid, no collage, no text.",
            ].filter(Boolean).join(" "),
            referenceUrls: references.map((reference) => `/api/internal/story-film-media/character-references/${encodeURIComponent(reference.id)}`),
            aspectRatio: "9:16",
          }),
          idempotencyKey: `revise:character-look:epoch:${resultGenerationEpoch}`,
        },
      });
    }
    if (isRevisionDecision && project.stage === "keyframes" && revisionScene) {
      const usesProjectCharacter = sceneUsesProjectCharacter(revisionScene.characterDirectivesJson);
      const references = project.characterProfileId && usesProjectCharacter
        ? await tx.storyFilmCharacterReference.findMany({
            where: {
              profileId: project.characterProfileId,
              setVersion: project.characterReferenceSetVersion ?? 1,
            },
            orderBy: { createdAt: "asc" },
          })
        : [];
      const approvedLook = project.characterProfileId && usesProjectCharacter
        ? await tx.storyFilmArtifact.findFirst({
            where: { projectId: project.id, stage: "character_look", kind: "look_image" },
            orderBy: { createdAt: "desc" },
          })
        : null;
      await tx.storyFilmGenerationJob.create({
        data: {
          projectId: project.id,
          stage: "keyframes",
          projectRevision: resultRevision,
          generationEpoch: resultGenerationEpoch,
          kind: "keyframe_image",
          providerBackend: "grok_subscription",
          sceneKey: revisionScene.sceneKey,
          payloadJson: JSON.stringify({
            prompt: [
              revisionScene.grokPrompt,
              input.decision === "reroll" ? "Create a distinct alternate cinematic take while preserving story continuity." : null,
              `Creator revision: ${instruction}`,
            ].filter(Boolean).join(" "),
            referenceUrls: [
              ...(approvedLook ? [approvedLook.storageUrl] : []),
              ...references.map((reference) => `/api/internal/story-film-media/character-references/${encodeURIComponent(reference.id)}`),
            ],
            aspectRatio: "9:16",
            storyboardSceneEpoch: revisionScene.generationEpoch,
          }),
          idempotencyKey: `revise:keyframe:${revisionScene.sceneKey}:epoch:${resultGenerationEpoch}`,
        },
      });
    }
    if (isRevisionDecision && project.stage === "videos" && revisionScene) {
      const source = await tx.storyFilmArtifact.findFirst({
        where: {
          projectId: project.id,
          stage: "keyframes",
          kind: "keyframe_image",
          sceneKey: revisionScene.sceneKey,
        },
        orderBy: { createdAt: "desc" },
      });
      if (!source) throw new StoryFilmError("decision_not_allowed", `ไม่พบ Keyframe ที่อนุมัติของ ${revisionScene.sceneKey}`);
      await tx.storyFilmGenerationJob.create({
        data: {
          projectId: project.id,
          stage: "videos",
          projectRevision: resultRevision,
          generationEpoch: resultGenerationEpoch,
          kind: "scene_video",
          providerBackend: "grok_subscription",
          sceneKey: revisionScene.sceneKey,
          payloadJson: JSON.stringify({
            prompt: [
              revisionScene.grokPrompt,
              input.decision === "reroll" ? "Create a distinct alternate motion take while preserving continuity." : null,
              `Creator revision: ${instruction}`,
            ].filter(Boolean).join(" "),
            sourceImageUrl: source.storageUrl,
            durationSec: Math.max(1, (revisionScene.endMs - revisionScene.startMs) / 1_000),
            aspectRatio: "9:16",
          }),
          idempotencyKey: `revise:video:${revisionScene.sceneKey}:epoch:${resultGenerationEpoch}`,
        },
      });
    }
    if (isRevisionDecision && project.stage === "final_render" && finalRevisionScenes.length > 0) {
      const characterReferences = project.characterProfileId
        ? await tx.storyFilmCharacterReference.findMany({
            where: {
              profileId: project.characterProfileId,
              setVersion: project.characterReferenceSetVersion ?? 1,
            },
            orderBy: { createdAt: "asc" },
          })
        : [];
      const approvedLook = project.characterProfileId
        ? await tx.storyFilmArtifact.findFirst({
            where: { projectId: project.id, stage: "character_look", kind: "look_image" },
            orderBy: { createdAt: "desc" },
          })
        : null;
      for (const scene of finalRevisionScenes) {
        if (repairLayer === "video") {
          const source = await tx.storyFilmArtifact.findFirst({
            where: { projectId: project.id, kind: "keyframe_image", sceneKey: scene.sceneKey },
            orderBy: { createdAt: "desc" },
          });
          if (!source) throw new StoryFilmError("decision_not_allowed", `ไม่พบ Keyframe ของ ${scene.sceneKey}`);
          await tx.storyFilmGenerationJob.create({
            data: {
              projectId: project.id,
              stage: "videos",
              projectRevision: resultRevision,
              generationEpoch: resultGenerationEpoch,
              kind: "scene_video",
              providerBackend: "grok_subscription",
              sceneKey: scene.sceneKey,
              payloadJson: JSON.stringify({
                prompt: [scene.grokPrompt, `Creator repair: ${instruction}`].join(" "),
                sourceImageUrl: source.storageUrl,
                durationSec: Math.max(1, (scene.endMs - scene.startMs) / 1_000),
                aspectRatio: "9:16",
                repairOrigin: "final_review",
              }),
              idempotencyKey: `final-repair:video:${scene.sceneKey}:epoch:${resultGenerationEpoch}`,
            },
          });
          continue;
        }
        const currentFrame = await tx.storyFilmArtifact.findFirst({
          where: { projectId: project.id, kind: "keyframe_image", sceneKey: scene.sceneKey },
          orderBy: { createdAt: "desc" },
        });
        const identityUrls = sceneUsesProjectCharacter(scene.characterDirectivesJson)
          ? [
              ...(approvedLook ? [approvedLook.storageUrl] : []),
              ...characterReferences.map((reference) => `/api/internal/story-film-media/character-references/${encodeURIComponent(reference.id)}`),
            ]
          : [];
        await tx.storyFilmGenerationJob.create({
          data: {
            projectId: project.id,
            stage: "keyframes",
            projectRevision: resultRevision,
            generationEpoch: resultGenerationEpoch,
            kind: "keyframe_image",
            providerBackend: "grok_subscription",
            sceneKey: scene.sceneKey,
            payloadJson: JSON.stringify({
              prompt: [
                scene.grokPrompt,
                `Creator repair: ${instruction}`,
                "Correct only the reported defect. Preserve composition, camera direction, identity, wardrobe, lighting, and story continuity unless the repair explicitly changes them.",
              ].join(" "),
              sourceImageUrl: currentFrame?.storageUrl ?? null,
              referenceMode: currentFrame ? "image_edit" : "reference_generation",
              referenceUrls: [...(currentFrame ? [currentFrame.storageUrl] : []), ...identityUrls],
              aspectRatio: "9:16",
              storyboardSceneEpoch: scene.generationEpoch,
              repairOrigin: "final_review",
            }),
            idempotencyKey: `final-repair:keyframe:${scene.sceneKey}:epoch:${resultGenerationEpoch}`,
          },
        });
      }
    }
    await tx.storyFilmDecision.create({
      data: {
        projectId: project.id,
        idempotencyKey: input.idempotencyKey ?? null,
        stage: project.stage,
        revision: project.revision,
        kind: input.decision,
        targetJson: input.target ? JSON.stringify(input.target) : null,
        instruction,
        resultStage: nextStage,
        resultRevision,
      },
    });
    const result = await tx.storyFilmProject.findUniqueOrThrow({ where: { id: project.id } });
    return toView(result);
  });
}
