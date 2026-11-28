import { externalWindowStates, externalMediaPlan, previewWindowOwner, isPresenterHookWindow, firstUnlockedCutawayWindowIndex } from "@/lib/external-media";
import { validateExternalMediaExport, ownedDraftImports } from "@/lib/external-media.server";
import { resolvePendingWindowMedia } from "@/lib/pending-broll-media";
import {
  TREATMENT_PRESET_IDS,
  isTreatmentPresetId,
  type TreatmentPresetId,
} from "@/lib/brand-treatment-catalog";
import { MAX_HERO_BROLL_CUSTOM_PROMPT_LENGTH } from "@/lib/brand-visual-system";
import { generateMcpBrollWindowHeroClip } from "@/lib/broll-window-generate.server";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { registerGatedTool, type GatingPrincipal } from "@/lib/mcp/tool-gating";
import { REFUSAL_COPY, resolveMcpChain, type McpChainRow } from "@/lib/mcp/chain-export";
import { mcpExportKey, mcpRerenderKey } from "@/lib/mcp/chain-key";
import { getVideoJobStatusTool, mcpEditorUrl } from "@/lib/mcp/tools";
import { VIDEO_JOB_INFLIGHT_STATUSES } from "@/lib/mcp/video-job-status";
import { assertMcpRenderFree, McpRenderNotFreeError } from "@/lib/mcp/render-free";
import { brollWindowEditEnabled, enqueueBrollRerender, enqueueEditorExport } from "@/lib/editor-export-enqueue";
import { MAX_BROLL_WINDOW_EDITS, mergeWindowEdits, validateWindowEdits, type WindowEdit } from "@/lib/broll-rerender";
import {
  BROLL_FITS,
  BROLL_TRANSITIONS,
  BROLL_TRANSITION_FOLLOW_DEFAULT,
  effectiveBrollFit,
  effectiveBrollTransition,
  isBrollFit,
  isBrollTransition,
  isBrollTransitionEdit,
} from "@/lib/broll-window-style";
import { effectivePunchZoom } from "@/lib/presenter-punch-zoom";
import { SFX_MODES, effectiveSfxMode, isSfxMode, type SfxMode } from "@/lib/transition-sfx";
import { createUrlImport, failMediaImport, findOwnedMediaImport } from "@/lib/media-import/imports";
import { admissionRefusal } from "@/lib/mcp/media-import-copy";
import { continueMcpRerenderChainSafely } from "@/lib/mcp/rerender-chain";
import { resolveBrandVisualAccess } from "@/lib/brand-visual-rollout.server";
import { RenderDeployDrainError, RENDER_MAINTENANCE_CUSTOMER_MESSAGE } from "@/lib/render-deploy-drain";
import { brollWindowSpans } from "@/lib/broll-spans";
import { renderedWindowSpansMs, type RenderedWindowSpan } from "@/lib/broll-coverage";
import { RENDER_FPS } from "@/lib/mcp/orchestrator-steps";
import { SUBTITLE_FONT_WEIGHTS, normalizeSubtitleFontWeight } from "@/lib/subtitle-font-weight";
import { GENERIC_ERROR_COPY } from "@/lib/error-copy";
import {
  EFFECTS_DATA,
  FONTS_LIST,
  PRESETS_DATA,
  V2_CARD_LEN_OPTIONS,
  LOCKED_COLOR_PRESETS,
  LOCKED_ACCENT_PRESETS,
  mergeCaptionWithNext,
  regroupCaptions,
  resolveV2FontWeight,
  type V2CardLen,
  type V2SubConfig,
} from "@/app/(dashboard)/video-editor/_v2/subtitle-style";
import type { SubPreset, SubTextEffect } from "@/app/(dashboard)/video-editor/_components/types";
import { normalizeSubtitleStylePresetConfig } from "@/lib/editor-style-preset-contract";
import { shiftCaptionOverrides } from "@/lib/caption-card-editing";
import {
  HEADLINE_HOOK_ANCHORS,
  HEADLINE_HOOK_CANVAS_HEIGHT_PX,
  HEADLINE_HOOK_FONTS,
  HEADLINE_HOOK_FONT_WEIGHTS,
  HEADLINE_HOOK_PRESETS,
  MAX_HEADLINE_HOOK_DURATION_MS,
  MAX_HEADLINE_HOOK_OFFSET_PERCENT,
  MIN_HEADLINE_HOOK_DURATION_MS,
  MIN_HEADLINE_HOOK_OFFSET_PERCENT,
  normalizeHeadlineHook,
  type HeadlineHookConfig,
  type HeadlineHookFontFamily,
  type HeadlineHookFontWeight,
  type HeadlineHookPreset,
} from "@/lib/headline-hook";
import { parseVideoJobOutput, type VideoJobPreviewData } from "@/lib/mcp/video-job";
import { clampTailHoldMs, TAIL_HOLD_MS_MAX, TAIL_HOLD_MS_MIN } from "@/lib/tail-hold";
import { resolveTemplatePostEdit } from "@/lib/video-template-apply";
import {
  DEFAULT_BGM_VOLUME,
  normalizeBackgroundMusicEdit,
  type BackgroundMusicEdit,
} from "@/lib/background-music";
import {
  findBackgroundMusicTrackById,
  findBackgroundMusicTrackByPath,
  listBackgroundMusicTracks,
} from "@/lib/background-music.server";
import {
  discardPendingEditDraft,
  draftDurationMs,
  draftHasBrollChanges,
  STYLE_ONLY_REPLACEMENT_KIND,
  loadPendingEditState,
  savePendingEditDraft,
  toBurnConfig,
  toEditorSnapshotDraft,
  updatePendingEditDraft,
  type PendingEditDraft,
  type PendingEditState,
  type PendingEditWindowEdit,
} from "@/lib/mcp/pending-edit-draft";
import {
  ACTIVE_STYLE_PACK_IDS,
  MUSIC_MOODS,
  isActiveStylePackId,
  stylePack,
  stylePackSubtitlePreset,
  type MusicMood,
} from "@/lib/style-pack-catalog";
import {
  MOTION_MASCOT_IDS,
  MOTION_TEMPLATE_IDS,
  MOTION_THEME_IDS,
  buildMotionBrollUri,
  isMotionMascotId,
  isMotionTemplateId,
  isMotionThemeId,
  motionTemplate,
  normalizeMotionTemplateConfig,
  planMotionSceneForWindow,
  type MotionMascotId,
  type MotionTemplateConfig,
  type MotionTemplateId,
  type MotionThemeId,
} from "@/lib/motion-broll-catalog";
import { isNoneInput, moodMenu, resolveBgm, resolveMusicMoodTrack } from "@/lib/mcp/bgm-resolve";

/**
 * T6 (ADR 0064): the tracer-bullet MCP edit tools — `get_edit_state`, `set_caption_text`,
 * `export_video` — over a Held Preview's Pending Edit Draft. Agent-neutral (G13/G14): flat
 * primitive inputs, every refusal `{ error, code, message (Thai), next }`, success replies
 * compact JSON with `next`. Registered per request through `registerGatedTool` (beta gate).
 */

export const MCP_EDIT_TOOL_NAMES = [
  "get_edit_state",
  "set_caption_text",
  "merge_captions",
  "split_caption",
  "regroup_captions",
  "set_subtitle_style",
  "set_headline_hook",
  "set_background_music",
  "set_tail_hold",
  "discard_edits",
  "replace_broll_window",
  "set_broll_style",
  "apply_video_template",
  "batch_edit_video",
  "export_video",
] as const;

/** Longest caption card text the agent may write (a card is one on-screen line or two). */
export const MAX_CAPTION_TEXT_CHARS = 500;
const MAX_JOB_ID_CHARS = 200;

// Inputs are plain zod types; bounds are checked server-side so a bad value gets the G14
// envelope instead of a protocol-level validation error.
export const getEditStateInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
} satisfies z.ZodRawShape;

export const setCaptionTextInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
  index: z.number().int().describe("ลำดับการ์ดซับ (เริ่มที่ 0) ตาม captions[].index ของ get_edit_state"),
  text: z.string().describe(`ข้อความใหม่ของการ์ด (ไม่เกิน ${MAX_CAPTION_TEXT_CHARS} ตัวอักษร) — เปลี่ยนเฉพาะข้อความ เวลาเดิม`),
} satisfies z.ZodRawShape;

export const mergeCaptionsInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
  index: z.number().int().describe("รวมการ์ดนี้เข้ากับการ์ดถัดไป (index ตาม get_edit_state) — ต้องไม่ใช่การ์ดสุดท้าย"),
} satisfies z.ZodRawShape;

export const splitCaptionInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
  index: z.number().int().describe("การ์ดที่จะแยกเป็น 2 ใบ (index ตาม get_edit_state)"),
  leftText: z.string().describe("ข้อความครึ่งแรกของการ์ด — ต้องเป็นข้อความต้นของการ์ดนี้พอดี (ไม่รวมครึ่งหลัง)"),
} satisfies z.ZodRawShape;

/** As a plain primitive, numeric-choice cardLen comes as a string enum (G13). */
function nonEmptyEnum<T extends readonly string[]>(values: T): [T[number], ...T[number][]] {
  return values as unknown as [T[number], ...T[number][]];
}

export const regroupCaptionsInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
  cardLen: z.enum(nonEmptyEnum(V2_CARD_LEN_OPTIONS.map((option) => option.value)))
    .describe("จัดกลุ่มการ์ดซับใหม่ทั้งคลิปจากต้นฉบับเดิม (ทิ้งการรวม/แยกการ์ดก่อนหน้า): sentence=1 ประโยค, 4/3/2/1=จำนวนคำสูงสุดต่อการ์ด"),
} satisfies z.ZodRawShape;

export const setSubtitleStyleInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
  fontFamily: z.enum(nonEmptyEnum(FONTS_LIST.map((font) => font.value))).optional().describe("ฟอนต์ซับ (ดูค่าที่เลือกได้จาก get_edit_state.allowed.fonts)"),
  fontSize: z.number().int().describe("ขนาดฟอนต์ 30-160 px").optional(),
  fontWeight: z.enum(["400", "600", "900"]).optional().describe("น้ำหนักฟอนต์"),
  textColor: z.string().optional().describe("สีตัวอักษร #RRGGBB (ไม่มีผลถ้า preset ล็อกสีไว้)"),
  accentColor: z.string().optional().describe("สีเน้น HOOK/CTA #RRGGBB (ไม่มีผลถ้า preset ล็อกสีเน้นไว้)"),
  preset: z.enum(nonEmptyEnum(PRESETS_DATA.map((preset) => preset.value))).optional().describe("สไตล์ซับ (ดูค่าที่เลือกได้จาก get_edit_state.allowed.presets)"),
  effect: z.enum(nonEmptyEnum(EFFECTS_DATA.map((effect) => effect.value))).optional().describe("เอฟเฟกต์ตัวอักษร (ดูค่าที่เลือกได้จาก get_edit_state.allowed.effects)"),
  shadow: z.boolean().optional().describe("เปิด/ปิดเงา"),
  outline: z.boolean().optional().describe("เปิด/ปิดเส้นขอบ"),
  outlineSize: z.number().int().describe("ความหนาเส้นขอบ 1-8").optional(),
  verticalPos: z.number().int().describe("ตำแหน่งแนวตั้งของซับ 10-95 (% จากขอบบน)").optional(),
  highlightKeywords: z.boolean().optional().describe("เปิด/ปิดไฮไลต์คำสำคัญหรือตัวเลขเด่น 1–2 คำต่อการ์ดซับอัตโนมัติด้วยสีเน้น (accentColor)"),
  statCards: z.boolean().optional().describe("เปิด/ปิดการ์ดสถิติแอนิเมชันมุมบนขวาอัตโนมัติในฉากที่มีตัวเลข/เปอร์เซ็นต์สำคัญ"),
} satisfies z.ZodRawShape;

const HEADLINE_HOOK_FONT_VALUES = HEADLINE_HOOK_FONTS.map((font) => font.value);

export const setHeadlineHookInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
  enabled: z.boolean().optional().describe("เปิด/ปิดพาดหัว (ต้องมี headline ด้วยถึงจะเปิดได้จริง)"),
  headline: z.string().optional().describe("ข้อความพาดหัว (ไม่เกิน 64 ตัวอักษร 2 บรรทัด — ระบบตัดให้เองถ้ายาวเกิน)"),
  subheadline: z.string().optional().describe("ข้อความรอง (ไม่เกิน 90 ตัวอักษร 1 บรรทัด, ส่งว่างเพื่อลบ)"),
  durationMs: z.number().int().describe("ระยะเวลาที่พาดหัวค้างอยู่ (ms)").optional(),
  preset: z.enum(nonEmptyEnum(HEADLINE_HOOK_PRESETS)).optional().describe("สไตล์พาดหัว"),
  topPercent: z.number().int().describe("ตำแหน่งแนวตั้งของพาดหัวแบบเดิม 10-42 (% จากขอบบน) — ใช้ได้เฉพาะตอนไม่ส่ง anchor/offsetPx/offsetPercent เลย (ของเดิมที่ไม่มี field ใหม่ยังเรนเดอร์เหมือนก่อนทุกอย่าง); ถ้าต้องการวางใกล้ขอบล่างหรือกำหนดระยะเป็นพิกเซล ให้ใช้ anchor + offsetPx/offsetPercent แทน").optional(),
  anchor: z.enum(HEADLINE_HOOK_ANCHORS).optional().describe("อ้างอิงตำแหน่งจากขอบบนหรือขอบล่างของจอ (ไม่ระบุ = บน เหมือนเดิม) — ใช้ร่วมกับ offsetPx/offsetPercent"),
  offsetPx: z.number().describe(`ระยะห่างจากขอบที่ anchor กำหนด หน่วยพิกเซลของจอ 1080×${HEADLINE_HOOK_CANVAS_HEIGHT_PX} — ระบบจะกันไม่ให้พาดหัวทับแถบซับหรือหลุดขอบจอให้อัตโนมัติ (ตำแหน่งที่ได้จริงอาจถูกขยับเข้ามาถ้าชนขอบเขตเหล่านี้ ดูค่าจริงที่ topPercent/offsetPercent ในผลลัพธ์) ส่งอย่างใดอย่างหนึ่งจาก offsetPx/offsetPercent ถ้าส่งทั้งคู่ offsetPx ชนะ`).optional(),
  offsetPercent: z.number().describe(`ระยะห่างจากขอบที่ anchor กำหนด หน่วย % ของความสูงจอ (${MIN_HEADLINE_HOOK_OFFSET_PERCENT}-${MAX_HEADLINE_HOOK_OFFSET_PERCENT}) — ส่งแทน offsetPx ก็ได้ ระบบกันทับแถบซับ/ขอบจอให้อัตโนมัติเช่นกัน`).optional(),
  fontFamily: z.enum(nonEmptyEnum(HEADLINE_HOOK_FONT_VALUES)).optional().describe("ฟอนต์พาดหัว"),
  fontSize: z.number().int().describe("ขนาดฟอนต์พาดหัว 52-120 px").optional(),
  fontWeight: z.enum(["400", "600", "900"]).optional().describe("น้ำหนักฟอนต์พาดหัว"),
  subheadlineFontSize: z.number().int().describe("ขนาดฟอนต์ข้อความรอง 32-88 px").optional(),
} satisfies z.ZodRawShape;

export const setBackgroundMusicInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\") — ส่ง jobId อย่างเดียวเพื่อดูรายการเพลง (tracks) และเพลงปัจจุบัน"),
  trackId: z.string().optional().describe("เพลงที่จะใช้: tracks[].trackId จากการเรียกด้วย jobId อย่างเดียว หรือ \"none\" = ไม่ใส่เพลง"),
  volume: z.number().int().optional().describe("ความดังเพลง 0-100 (%) — ค่าเริ่มต้นของระบบคือ 12"),
  ducking: z.boolean().optional().describe("ลดเสียงเพลงอัตโนมัติตอนมีเสียงพูด (เลือกเพลงใหม่ = เปิดให้เอง, ส่ง false เพื่อปิด)"),
} satisfies z.ZodRawShape;

export const setTailHoldInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
  tailHoldMs: z.number().int().describe(`ค้างเฟรมสุดท้ายของวิดีโอไว้กี่ ms หลังเสียงพากย์จบ (ใส่ end card) — ${TAIL_HOLD_MS_MIN}-${TAIL_HOLD_MS_MAX}, ค่าเริ่มต้น 0 = ไม่ค้าง`),
} satisfies z.ZodRawShape;

export const discardEditsInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
} satisfies z.ZodRawShape;

/** Longest agent media link accepted (the T10 fetch re-checks every hop). */
export const MAX_MEDIA_URL_CHARS = 2_048;

export const replaceBrollWindowInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
  windowIndex: z.number().int().describe("ช่วง B-roll ที่จะเปลี่ยน (windows[].index จาก get_edit_state)"),
  url: z.string().optional().describe("ลิงก์สาธารณะ https ของรูปหรือวิดีโอ (ระบบดาวน์โหลดเอง) — ส่งอย่างใดอย่างหนึ่งจาก url / uploadId / source"),
  uploadId: z.string().optional().describe("uploadId จาก create_upload_url ที่ PUT ไฟล์เสร็จแล้ว"),
  source: z.enum(["original", "hero-ai-image", "motion-template"]).optional().describe("\"original\" = คืนช่วงนี้กลับเป็นภาพเดิมของวิดีโอตัวอย่าง, \"hero-ai-image\" = สร้างภาพ Hero AI Image ใหม่ให้ช่วงนี้ (2 เครดิตต่อภาพ), \"motion-template\" = สร้างฉากแอนิเมชันด้วยโค้ด (Doodle / Cue Step Board / HyperFrames + Brand CI) ฟรี 0 เครดิต"),
  prompt: z.string().optional().describe("คำอธิบายฉากเมื่อใช้ source \"hero-ai-image\" (ไม่เกิน 500 ตัวอักษร เขียนไทยหรืออังกฤษได้ แทนที่ฉากเดิมของช่วงนี้ แต่ตัวอักษรในภาพรองรับเฉพาะภาษาอังกฤษ)"),
  treatment: z.string().optional().describe("สไตล์การเล่าเรื่องของภาพเมื่อใช้ source \"hero-ai-image\" (ดูค่าที่เลือกได้จาก get_edit_state.allowed.brollImageTreatments; ไม่ส่ง = ใช้แนวแบรนด์ของโปรเจกต์)"),
  motionThemeId: z.enum(MOTION_THEME_IDS).optional().describe("ธีมโมชันเมื่อใช้ source \"motion-template\" (\"doodle-explainer\" | \"cue-step-board\" | \"hyperframe-kinetic\") — หากไม่ส่ง motionTemplateId ระบบจะเลือกฉากตามบทพูดอัตโนมัติในธีมนี้"),
  motionMascot: z.enum(MOTION_MASCOT_IDS).optional().describe("รูปแบบตัวละครประกอบฉากโมชันเมื่อใช้ source \"motion-template\" (\"stickman-scarf\" | \"stickman-glasses\" | \"stickman-cap\" | \"ai-bot\")"),
  motionTemplateId: z.enum(MOTION_TEMPLATE_IDS).optional().describe("รหัสเทมเพลตฉากโมชันเมื่อใช้ source \"motion-template\" (ดูจาก get_edit_state.allowed.motionTemplates)"),
  motionHeaderText: z.string().optional().describe("ป้ายหัวข้อด้านบนสุดของฉากโมชัน (เมื่อใช้ source \"motion-template\")"),
  motionTitle: z.string().optional().describe("หัวข้อหลักในการ์ดโมชัน (เมื่อใช้ source \"motion-template\")"),
  motionSubtitle: z.string().optional().describe("ข้อความรองหรือสรุปในฉากโมชัน (เมื่อใช้ source \"motion-template\")"),
  motionBadgeText: z.string().optional().describe("ข้อความป้าย Badge หรือตัวเลขสถิติในฉากโมชัน (เมื่อใช้ source \"motion-template\")"),
  motionLeftText: z.string().optional().describe("ข้อความฝั่งซ้าย/ก่อน ในฉากเปรียบเทียบหรือราคา (เมื่อใช้ source \"motion-template\")"),
  motionRightText: z.string().optional().describe("ข้อความฝั่งขวา/หลัง ในฉากเปรียบเทียบหรือราคา (เมื่อใช้ source \"motion-template\")"),
} satisfies z.ZodRawShape;

export const setBrollStyleInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
  windowIndex: z.number().int().optional()
    .describe("ช่วง B-roll ที่จะตั้งค่า (windows[].index จาก get_edit_state) — ไม่ส่ง = ตั้งค่าหลักของทั้งคลิป (ใช้ได้กับ transition, punchZoom และ sfxMode)"),
  transition: z.enum(["dissolve", "cut", "default"]).optional()
    .describe("ตอนจบของช่วง: dissolve = ภาพละลายเข้าช่วงถัดไป (ค่าเดิม), cut = ตัดชนทันที, default = ให้ช่วงนี้ตามค่าหลักของคลิป (ใช้ได้เฉพาะเมื่อส่ง windowIndex). ช่วงสุดท้าย: dissolve = จางเป็นสีดำตอนจบคลิป, cut = จบแบบไม่จาง"),
  fit: z.enum(["cover", "contain"]).optional()
    .describe("การจัดภาพของช่วง: cover = เต็มจอ ครอปขอบ (ค่าเดิม), contain = เห็นภาพครบทั้งภาพ ขอบบน-ล่างเป็นภาพเดียวกันแบบเบลอและมืดลง (ต้องส่ง windowIndex)"),
  punchZoom: z.boolean().optional()
    .describe("เปิด/ปิดการซูมจังหวะผู้พูด (1.0x ↔ 1.15x ช่วงที่เป็นหน้าผู้พูด ซับไตเติลไม่ขยับตาม) — ตั้งเป็นค่าหลักของทั้งคลิป (ไม่ต้องส่ง windowIndex)"),
  sfxMode: z.enum(SFX_MODES).optional()
    .describe("เสียงเอฟเฟกต์เปลี่ยนฉากเบาๆ (-18 dB): \"none\" = ปิด (ค่าเริ่มต้น), \"subtle\" = เปิดเสียง whoosh/pop เบาๆ ตอนตัดฉาก B-roll — ตั้งเป็นค่าหลักของทั้งคลิป (ไม่ต้องส่ง windowIndex)"),
} satisfies z.ZodRawShape;

export const applyVideoTemplateInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
  templateId: z.enum(nonEmptyEnum(ACTIVE_STYLE_PACK_IDS))
    .describe("รหัสสไตล์เทมเพลตวิดีโอสำเร็จรูป (ดูรายการจาก get_video_options.templates หรือ get_edit_state.allowed.templates)"),
  includeMusic: z.boolean().optional()
    .describe("true = เลือกเพลงประกอบจากคลังตามอารมณ์เพลงของเทมเพลต (musicMood) พร้อมเปิด ducking อัตโนมัติ; false/ไม่ส่ง = คงเพลงเดิมไว้"),
  motionThemeId: z.enum(MOTION_THEME_IDS).optional()
    .describe("ล็อกธีมฉากเคลื่อนไหว Motion / HyperFrames ทั้งคลิป (\"doodle-explainer\" | \"cue-step-board\" | \"hyperframe-kinetic\") พร้อมดึงสีและฟอนต์ Brand CI ของเทมเพลตเข้าทุกฉากอัตโนมัติ (ฟรี 0 เครดิต)"),
  motionMascot: z.enum(MOTION_MASCOT_IDS).optional()
    .describe("รูปแบบตัวละครประกอบฉากโมชันเมื่อใช้คู่กับ motionThemeId (\"stickman-scarf\" | \"stickman-glasses\" | \"stickman-cap\" | \"ai-bot\")"),
} satisfies z.ZodRawShape;

export const batchEditVideoInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
  templateId: z.enum(nonEmptyEnum(ACTIVE_STYLE_PACK_IDS)).optional()
    .describe("สวมสไตล์เทมเพลตวิดีโอสำเร็จรูปเป็นฐานก่อนปรับฟิลด์อื่นที่ส่งมาพร้อมกัน"),
  includeTemplateMusic: z.boolean().optional()
    .describe("ใช้คู่กับ templateId: true = เลือกเพลงตามอารมณ์เทมเพลตอัตโนมัติ (ถ้าไม่ได้ระบุ bgmMoodOrTrack หรือ disableBgm แยก)"),
  motionThemeId: z.enum(MOTION_THEME_IDS).optional()
    .describe("ล็อกธีมฉากเคลื่อนไหว Motion / HyperFrames ทั้งคลิป (\"doodle-explainer\" | \"cue-step-board\" | \"hyperframe-kinetic\") โดยวางแผนฉากตามบทพูดแต่ละช่วง + Brand CI ให้อัตโนมัติทุกช่วง B-roll (ฟรี 0 เครดิต)"),
  motionMascot: z.enum(MOTION_MASCOT_IDS).optional()
    .describe("รูปแบบตัวละครประกอบฉากโมชันเมื่อใช้คู่กับ motionThemeId (\"stickman-scarf\" | \"stickman-glasses\" | \"stickman-cap\" | \"ai-bot\")"),
  regroupCardLen: z.enum(nonEmptyEnum(V2_CARD_LEN_OPTIONS.map((option) => option.value))).optional()
    .describe("จัดกลุ่มการ์ดซับใหม่จากต้นฉบับเดิมตามจำนวนคำสูงสุดต่อการ์ด (sentence / 4 / 3 / 2 / 1) ก่อนอัปเดต captionIndices"),
  captionIndices: z.array(z.number().int()).optional()
    .describe("รายการลำดับการ์ดซับที่จะเปลี่ยนข้อความ (เริ่มที่ 0 ห้ามซ้ำ และความยาวเท่ากับ captionTexts พอดี)"),
  captionTexts: z.array(z.string()).optional()
    .describe(`รายการข้อความใหม่ของการ์ดซับแต่ละใบในลำดับเดียวกับ captionIndices (ไม่เกิน ${MAX_CAPTION_TEXT_CHARS} ตัวอักษรต่อใบ)`),
  subtitlePreset: z.enum(nonEmptyEnum(PRESETS_DATA.map((preset) => preset.value))).optional()
    .describe("สไตล์ซับ (ดูค่าที่เลือกได้จาก get_edit_state.allowed.presets)"),
  subtitleEffect: z.enum(nonEmptyEnum(EFFECTS_DATA.map((effect) => effect.value))).optional()
    .describe("เอฟเฟกต์ตัวอักษรซับ (ดูค่าที่เลือกได้จาก get_edit_state.allowed.effects)"),
  fontFamily: z.enum(nonEmptyEnum(FONTS_LIST.map((font) => font.value))).optional()
    .describe("ฟอนต์ซับ (ดูค่าที่เลือกได้จาก get_edit_state.allowed.fonts)"),
  fontSize: z.number().int().optional()
    .describe("ขนาดฟอนต์ซับ 30-160 px"),
  fontWeight: z.enum(["400", "600", "900"]).optional()
    .describe("น้ำหนักฟอนต์ซับ"),
  textColor: z.string().optional()
    .describe("สีตัวอักษรซับ #RRGGBB (ไม่มีผลถ้าสไตล์ซับล็อกสีไว้)"),
  accentColor: z.string().optional()
    .describe("สีเน้นคำสำคัญ/HOOK/CTA #RRGGBB (ไม่มีผลถ้าสไตล์ซับล็อกสีเน้นไว้)"),
  shadow: z.boolean().optional()
    .describe("เปิด/ปิดเงาซับ"),
  outline: z.boolean().optional()
    .describe("เปิด/ปิดเส้นขอบซับ"),
  outlineSize: z.number().int().optional()
    .describe("ความหนาเส้นขอบซับ 1-8"),
  highlightKeywords: z.boolean().optional()
    .describe("เปิด/ปิดไฮไลต์คำสำคัญหรือตัวเลขเด่นอัตโนมัติ"),
  statCards: z.boolean().optional()
    .describe("เปิด/ปิดการ์ดสถิติแอนิเมชันมุมบนขวาอัตโนมัติ"),
  verticalPos: z.number().int().optional()
    .describe("ตำแหน่งแนวตั้งของซับ 10-95 (% จากขอบบน)"),
  headlineHookEnabled: z.boolean().optional()
    .describe("เปิด/ปิดพาดหัวช่วงต้นคลิป (ต้องมีข้อความพาดหัวด้วยถึงจะเปิดได้จริง)"),
  headlineHookText: z.string().optional()
    .describe("ข้อความพาดหัวช่วงต้นคลิป (ไม่เกิน 64 ตัวอักษร 2 บรรทัด)"),
  headlineHookSubtext: z.string().optional()
    .describe("ข้อความรองของพาดหัว (ไม่เกิน 90 ตัวอักษร 1 บรรทัด ส่งค่าว่างเพื่อลบ)"),
  headlineHookPreset: z.enum(nonEmptyEnum(HEADLINE_HOOK_PRESETS)).optional()
    .describe("สไตล์การ์ดพาดหัว"),
  headlineHookDurationMs: z.number().int().optional()
    .describe(`ระยะเวลาที่พาดหัวค้างอยู่ (${MIN_HEADLINE_HOOK_DURATION_MS}-${MAX_HEADLINE_HOOK_DURATION_MS} ms)`),
  bgmMoodOrTrack: z.string().optional()
    .describe("เพลงประกอบ: ใส่ชื่ออารมณ์เพลง (เช่น ชิล/ดราม่า/สนุก/calm/tense), ชื่อเพลง, trackId จาก set_background_music หรือ \"none\" = ปิดเพลง"),
  bgmVolume: z.number().optional()
    .describe("ความดังเพลงประกอบ 0-100 (%) เช่น 12 (รองรับทศนิยม 0-1 เช่น 0.12)"),
  bgmDucking: z.boolean().optional()
    .describe("เปิด/ปิดลดเสียงเพลงอัตโนมัติตอนมีเสียงพูด"),
  disableBgm: z.boolean().optional()
    .describe("true = ปิดเพลงประกอบของคลิปนี้"),
  tailHoldMs: z.number().int().optional()
    .describe(`ค้างเฟรมสุดท้ายหลังเสียงพากย์จบ (${TAIL_HOLD_MS_MIN}-${TAIL_HOLD_MS_MAX} ms)`),
  brollWindowIndex: z.number().int().optional()
    .describe("ระบุช่วง B-roll (windows[].index) เมื่อต้องการตั้ง brollTransition หรือ brollFit เฉพาะช่วงนั้น; ไม่ส่ง = ตั้งค่าหลักทั้งคลิป"),
  sfxMode: z.enum(SFX_MODES).optional()
    .describe("เสียงเอฟเฟกต์เปลี่ยนฉากทั้งคลิป (\"none\" / \"subtle\")"),
  brollTransition: z.enum(["dissolve", "cut", "default"]).optional()
    .describe("รูปแบบเปลี่ยนฉาก B-roll (\"dissolve\" / \"cut\"; ค่า \"default\" ใช้ได้เฉพาะเมื่อระบุ brollWindowIndex)"),
  brollFit: z.enum(["cover", "contain"]).optional()
    .describe("การจัดวางภาพ B-roll เฉพาะช่วง (\"cover\" / \"contain\" — ต้องระบุ brollWindowIndex)"),
  punchZoom: z.boolean().optional()
    .describe("เปิด/ปิดซูมจังหวะผู้พูดทั้งคลิป"),
} satisfies z.ZodRawShape;

export const exportVideoInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
  dualTikTokExport: z.boolean().optional().describe(
    "true = สร้างไฟล์คู่สำหรับ TikTok เพิ่มอีก 1 ไฟล์ (tiktokSoundVideoUrl: วิดีโอเดียวกันแต่ตัดเสียงเพลงออก เหลือเสียงพูด+เสียงคลิปจริง+SFX ที่ -14 LUFS เพื่อใส่เพลงกระแสใน TikTok โดยไม่ติดลิขสิทธิ์)",
  ),
} satisfies z.ZodRawShape;

export type EditToolFailure = {
  error: string;
  code: string;
  message: string;
  next: string;
  retryAfterSeconds?: number;
};

export function editToolFailure(
  code: string,
  message: string,
  next: string,
  retryAfterSeconds?: number,
): EditToolFailure {
  return retryAfterSeconds === undefined
    ? { error: code, code, message, next }
    : { error: code, code, message, next, retryAfterSeconds };
}

const NEXT_HOLD_CREATE = "สร้างวิดีโอใหม่ด้วย create_video_job โดยส่ง exportMode \"hold\"";
const NEXT_RELOAD = "เรียก get_edit_state เพื่อโหลดดราฟต์ล่าสุด แล้วลองอีกครั้ง";
const NEXT_EDITOR = "เปิดลิงก์ editorUrl (จาก get_video_status) เพื่อแก้หรือส่งออกในหน้าเว็บ";

export const UNKNOWN_JOB = editToolFailure("invalid_input", "ไม่พบงานนี้ในบัญชีของคุณ", "ใช้ jobId ที่ได้จาก create_video_job ที่ส่ง exportMode \"hold\"");
/** The id given is a Video id (list_my_videos/get_video), not a jobId — same error code as
 *  UNKNOWN_JOB, a more useful `next`. */
const UNKNOWN_JOB_IS_VIDEO_ID = editToolFailure(
  "invalid_input",
  "ไม่พบงานนี้ในบัญชีของคุณ",
  "ค่านี้เป็น videoId ไม่ใช่ jobId — เรียก list_my_videos หรือ get_video เพื่อดู jobId ของคลิปนี้ แล้วใช้ jobId นั้นแทน (แก้ต่อได้เฉพาะตอน editable เป็น true)",
);
const NOT_HELD = editToolFailure(
  "not_editable",
  "งานนี้แก้ผ่านเอเจนต์ไม่ได้ — แก้ได้เฉพาะวิดีโอที่สร้างด้วย exportMode \"hold\"",
  `${NEXT_HOLD_CREATE} หรือ${NEXT_EDITOR}`,
);
const ROOT_ENDED = editToolFailure(
  "not_editable",
  "วิดีโอตัวอย่างนี้ล้มเหลวหรือถูกยกเลิก จึงแก้ต่อไม่ได้",
  NEXT_HOLD_CREATE,
);
export const NOT_READY = editToolFailure(
  "not_ready",
  "วิดีโอตัวอย่างยังเรนเดอร์ไม่เสร็จ",
  "เรียก get_video_status ทุก ~60–90 วินาที จนได้ status \"held\" แล้วค่อยเรียก get_edit_state",
  60,
);
const STALE_REVISION = editToolFailure(
  "stale_revision",
  "มีการแก้ดราฟต์นี้พร้อมกันจากที่อื่น ระบบจึงยังไม่บันทึกการแก้ครั้งนี้",
  NEXT_RELOAD,
);

const LOAD_FAILURE: Record<"project_not_found" | "source_not_exportable", EditToolFailure> = {
  project_not_found: editToolFailure("project_not_found", REFUSAL_COPY.project_not_found, NEXT_HOLD_CREATE),
  source_not_exportable: editToolFailure("source_not_exportable", REFUSAL_COPY.source_not_exportable, NEXT_EDITOR),
};

export function invalidJobId(jobId: unknown): boolean {
  return typeof jobId !== "string" || !jobId.trim() || jobId.length > MAX_JOB_ID_CHARS;
}

function isInFlight(status: string): boolean {
  return (VIDEO_JOB_INFLIGHT_STATUSES as readonly string[]).includes(status);
}

type HeldRootResult = { ok: true; root: McpChainRow } | { ok: false; failure: EditToolFailure };

/** Owner-scoped: the finished Held Preview root `jobId` is, or belongs to. */
export async function resolveHeldRoot(userId: string, jobId: string): Promise<HeldRootResult> {
  const chain = await resolveMcpChain(userId, jobId);
  if (!chain) {
    const own = await prisma.videoJob.findFirst({ where: { id: jobId, userId }, select: { id: true } });
    if (own) return { ok: false, failure: NOT_HELD };
    const asVideo = await prisma.video.findFirst({ where: { id: jobId, userId }, select: { id: true } });
    return { ok: false, failure: asVideo ? UNKNOWN_JOB_IS_VIDEO_ID : UNKNOWN_JOB };
  }
  if (chain.kind !== "held") return { ok: false, failure: NOT_HELD };
  if (chain.root.status === "done") return { ok: true, root: chain.root };
  return { ok: false, failure: isInFlight(chain.root.status) ? NOT_READY : ROOT_ENDED };
}

export async function loadState(userId: string, root: McpChainRow) {
  const loaded = await loadPendingEditState(userId, root);
  return loaded.ok
    ? { ok: true as const, state: loaded.state }
    : { ok: false as const, failure: LOAD_FAILURE[loaded.code] };
}

/** T7: the common tail of every `updatePendingEditDraft` / `discardPendingEditDraft` failure
 *  branch (shared with T6's `set_caption_text`, which keeps its own inline copy unchanged). */
function mapUpdateFailure(code: string, message: string | undefined, next: string): EditToolFailure {
  if (code === "stale_revision") return STALE_REVISION;
  if (code === "project_not_found" || code === "source_not_exportable") {
    return LOAD_FAILURE[code as "project_not_found" | "source_not_exportable"];
  }
  return editToolFailure(code, message ?? GENERIC_ERROR_COPY, next);
}

/** A flat zod shape's inferred argument type (optional fields stay optional). */
type ShapeArgs<S extends z.ZodRawShape> = { [K in keyof S]: z.infer<S[K]> };

// ── get_edit_state ────────────────────────────────────────────────────────────────────────

/** What the agent may set (T7's set_subtitle_style / set_headline_hook validate against these). */
const ALLOWED = {
  fonts: FONTS_LIST.map((font) => font.value),
  presets: PRESETS_DATA.map((preset) => preset.value),
  effects: EFFECTS_DATA.map((effect) => effect.value),
  fontWeight: SUBTITLE_FONT_WEIGHTS.map((weight) => String(weight)),
  cardLen: V2_CARD_LEN_OPTIONS.map((option) => option.value),
  // The strict ranges of editor-style-preset-contract.ts (normalizeSubtitleStylePresetConfig).
  fontSize: { min: 30, max: 160 },
  outlineSize: { min: 1, max: 8 },
  verticalPos: { min: 10, max: 95 },
  captionTextMaxChars: MAX_CAPTION_TEXT_CHARS,
  // EP5 #11 / U3 / #3 (set_broll_style) + HERO-94 (apply_video_template).
  templates: [...ACTIVE_STYLE_PACK_IDS],
  motionThemes: [...MOTION_THEME_IDS],
  motionTemplates: [...MOTION_TEMPLATE_IDS],
  brollTransitions: [...BROLL_TRANSITIONS],
  brollWindowTransitions: [...BROLL_TRANSITIONS, BROLL_TRANSITION_FOLLOW_DEFAULT],
  brollFits: [...BROLL_FITS],
  brollImageTreatments: [...TREATMENT_PRESET_IDS],
  sfxModes: [...SFX_MODES],
  // headline-hook.ts's own bounds (set_headline_hook, G18).
  headlineHook: {
    headlineMaxChars: 64,
    subheadlineMaxChars: 90,
    durationMs: { min: 3_000, max: 20_000 },
    // Legacy placement — only applies when anchor/offsetPx/offsetPercent are all omitted.
    topPercent: { min: 10, max: 42 },
    // EP5 #13: anchor + offset, in px of a 1080×1920 canvas or in % of its height. The server
    // always keeps the headline off the subtitle band and off the canvas edge, so the applied
    // position (echoed back as topPercent/offsetPercent) may differ from what was requested.
    anchors: [...HEADLINE_HOOK_ANCHORS],
    offsetPercent: { min: MIN_HEADLINE_HOOK_OFFSET_PERCENT, max: MAX_HEADLINE_HOOK_OFFSET_PERCENT },
    offsetPxCanvasHeight: HEADLINE_HOOK_CANVAS_HEIGHT_PX,
    presets: [...HEADLINE_HOOK_PRESETS],
    fonts: HEADLINE_HOOK_FONT_VALUES,
    fontWeight: HEADLINE_HOOK_FONT_WEIGHTS.map((weight) => String(weight)),
    fontSize: { min: 52, max: 120 },
    subheadlineFontSize: { min: 32, max: 88 },
  },
  // set_background_music (EP5 U7): volume in %, trackId "none" removes the music.
  backgroundMusic: {
    volume: { min: 0, max: 100 },
    noneTrackId: "none",
  },
  // tail-hold.ts's own bounds (set_tail_hold, EP5 backlog #14).
  tailHoldMs: { min: TAIL_HOLD_MS_MIN, max: TAIL_HOLD_MS_MAX },
};

/** The music the export will use: the draft's edit, else the base render's own music. */
function effectiveBackgroundMusic(draft: PendingEditDraft, preview: VideoJobPreviewData): BackgroundMusicEdit {
  if (draft.backgroundMusic) return draft.backgroundMusic;
  const bgmFile = preview.config?.bgmFile;
  const bgmVolume = preview.config?.bgmVolume;
  return {
    track: typeof bgmFile === "string" && bgmFile ? bgmFile : null,
    volume: typeof bgmVolume === "number" && Number.isFinite(bgmVolume) ? Math.min(1, Math.max(0, bgmVolume)) : DEFAULT_BGM_VOLUME,
    ducking: false,
  };
}

/** Agent view: `trackId` ("none" = no music; null = a track no longer in the library), volume in
 *  %, and `changed` = the draft overrides the preview's own music. */
async function backgroundMusicView(userId: string, draft: PendingEditDraft, preview: VideoJobPreviewData) {
  const current = effectiveBackgroundMusic(draft, preview);
  const option = current.track ? await findBackgroundMusicTrackByPath(userId, current.track) : null;
  return {
    trackId: current.track === null ? "none" : option?.trackId ?? null,
    title: current.track === null ? null : option?.title ?? null,
    volume: Math.round(current.volume * 100),
    ducking: current.ducking,
    changed: draft.backgroundMusic !== undefined,
  };
}

// get_edit_state's `allowed.fonts` (and set_subtitle_style's schema) list only the canonical
// FONTS_LIST values (e.g. "'Kanit', sans-serif"), but a seed built before this task can carry
// the bare family name (e.g. "Kanit", from DEFAULT_V2_SUB). Accept and display both; stored
// values are normalised to the canonical form on the next write.
const FONT_FAMILY_BY_BARE_NAME = new Map(
  FONTS_LIST.map((font) => [(font.value.match(/^'([^']+)'/)?.[1] ?? font.value), font.value]),
);
function canonicalizeFontFamily(value: string): string | null {
  if (FONTS_LIST.some((font) => font.value === value)) return value;
  return FONT_FAMILY_BY_BARE_NAME.get(value) ?? null;
}

function subtitleStyleView(config: V2SubConfig) {
  return {
    preset: config.preset,
    effect: config.effect,
    fontFamily: canonicalizeFontFamily(config.fontFamily) ?? config.fontFamily,
    fontWeight: String(resolveV2FontWeight(config)),
    fontSize: config.fontSize,
    textColor: config.textColor,
    accentColor: config.accentColor,
    shadow: config.shadow,
    outline: config.outline,
    outlineSize: config.outlineSize,
    verticalPos: config.verticalPos,
    highlightKeywords: Boolean(config.highlightKeywords),
    statCards: Boolean(config.statCards),
  };
}

/** Exclusive Scene Ownership, read the way the web Post phase reads it (brollWindowVisible). */
const windowOwner = previewWindowOwner;

/** The Held Preview's total clip length — shared by the window spans below and the real
 *  rendered-timeline computation (U1), so both agree on the same outer bound. */
function previewDurationMs(preview: VideoJobPreviewData): number {
  const frames = Number((preview.config as { durationInFrames?: unknown }).durationInFrames);
  return Math.max(preview.audioDurationMs || 0, Number.isFinite(frames) && frames > 0 ? (frames / RENDER_FPS) * 1_000 : 0);
}

/** The B-roll windows the agent sees (and may address) on `preview`. */
function previewWindowSpans(preview: VideoJobPreviewData) {
  return brollWindowSpans(preview.config, previewDurationMs(preview));
}

type ImportView = {
  status: string;
  errorCode: string | null;
  resultSrc: string | null;
  durationMs: number | null;
  purpose: string | null;
};

/** T13: the caller's own Media Imports the draft's window edits point at (owner-scoped). */
export async function draftImportViews(userId: string, draft: PendingEditDraft): Promise<Map<string, ImportView>> {
  return ownedDraftImports(userId, draft);
}

/** A window edit's import as the agent sees it; a vanished row reads as failed. */
function importViewOf(edit: PendingEditWindowEdit | undefined, imports: Map<string, ImportView>): ImportView | null {
  if (!edit?.importId) return null;
  return imports.get(edit.importId) ?? { status: "failed", errorCode: "import_missing", resultSrc: null, durationMs: null, purpose: null };
}

/**
 * #15: a window whose replacement an earlier Export already rendered — the current base (the
 * project's activeJobId) shows different media there than the Held Preview did. Such a
 * replacement lives in the base itself, so it carries into every later export with no replay.
 */
function windowReplacedInBase(
  root: McpChainRow,
  rootPreview: VideoJobPreviewData | null,
  base: PendingEditState["base"],
  index: number,
): boolean {
  if (base.id === root.id || !rootPreview) return false;
  const baseWindow = bgVideoAt(base.preview.config, index);
  const rootWindow = bgVideoAt(rootPreview.config, index);
  if (!baseWindow || !rootWindow) return false;
  return baseWindow.src !== rootWindow.src || windowOwner(base.preview, index) !== windowOwner(rootPreview, index);
}

/**
 * U1 (read-only, best-effort companion to `rerenderEditsFor`): the same per-edit resolution —
 * a ready import's `resultSrc`/`durationMs`, or an "original" edit resolved against the root's
 * own window — but TOLERANT of a pending/failed import or an unavailable original: that one
 * edit is simply left out (its window reports the unedited base's own rendered span) instead of
 * refusing the whole read. Intentionally a separate, lenient copy rather than a refactor of
 * `rerenderEditsFor`'s export-critical strict control flow (which must keep failing fast there).
 */
export function reportableWindowEdits(
  root: McpChainRow,
  windowEdits: PendingEditWindowEdit[],
  imports: Map<string, ImportView>,
): WindowEdit[] {
  return resolvePendingWindowMedia(rootPreviewOf(root), windowEdits, imports).flatMap(p => p.edit ? [p.edit] : []);
}

/** EP5 #11 / U3: the style half of a pending window edit, as `WindowEdit` fields. */
function windowEditStyle(edit: PendingEditWindowEdit): Pick<WindowEdit, "transition" | "fit"> {
  return {
    ...(isBrollTransitionEdit(edit.transition) ? { transition: edit.transition } : {}),
    ...(isBrollFit(edit.fit) ? { fit: edit.fit } : {}),
  };
}

/** The project-default transition the next export renders with (pending value, else the base's). */
function draftProjectTransition(draft: PendingEditDraft, base: PendingEditState["base"]) {
  return effectiveBrollTransition(undefined, draft.brollTransition ?? (base.preview.config as { brollTransition?: unknown }).brollTransition);
}

/** The presenter auto punch-in zoom setting the next export renders with (pending value, else the base's). */
function draftProjectPunchZoom(draft: PendingEditDraft, base: PendingEditState["base"]): boolean {
  return effectivePunchZoom(draft.punchZoom ?? (base.preview.config as { punchZoom?: unknown }).punchZoom);
}

/** The subtle transition SFX setting the next export renders with (pending value, else the base's). */
function draftProjectSfxMode(draft: PendingEditDraft, base: PendingEditState["base"]): SfxMode {
  return effectiveSfxMode(draft.sfxMode ?? (base.preview.config as { sfxMode?: unknown }).sfxMode);
}

/** A window's transition and fit after its pending edit (if any) — what the next export renders. */
function windowStyleView(
  draft: PendingEditDraft,
  base: PendingEditState["base"],
  edit: PendingEditWindowEdit | undefined,
  index: number,
) {
  const baseWindow = bgVideoAt(base.preview.config, index);
  const ownTransition = edit?.transition === BROLL_TRANSITION_FOLLOW_DEFAULT
    ? undefined
    : edit?.transition ?? baseWindow?.transition;
  return {
    transition: effectiveBrollTransition(ownTransition, draftProjectTransition(draft, base)),
    transitionFollowsDefault: !isBrollTransition(ownTransition),
    fit: effectiveBrollFit(edit?.fit ?? baseWindow?.fit),
  };
}

/**
 * U1: `base`'s own `bgVideos[]` with every RESOLVABLE pending window edit merged on top, exactly
 * as `export_video`'s free re-render would (`mergeWindowEdits`) — the input `renderedWindowSpansMs`
 * needs to report the timeline the renderer will actually produce. Never throws: any edit that
 * can't yet be resolved, or a merge that fails validation, falls back to the unedited base.
 */
export function mergedBgVideosForReport(
  root: McpChainRow,
  base: PendingEditState["base"],
  windowEdits: PendingEditWindowEdit[],
  imports: Map<string, ImportView>,
): unknown[] {
  const baseBgVideos = ((base.preview.config as { bgVideos?: unknown }).bgVideos ?? []) as unknown[];
  if (windowEdits.length === 0) return baseBgVideos;
  const edits = reportableWindowEdits(root, windowEdits, imports);
  if (edits.length === 0) return baseBgVideos;
  const validated = validateWindowEdits(edits);
  if ("error" in validated) return baseBgVideos;
  const merged = mergeWindowEdits(baseBgVideos, validated);
  return "error" in merged ? baseBgVideos : merged.bgVideos;
}

/** `replaced` = this window differs from the Held Preview (pending edit, or already rendered);
 *  `pending` = the draft holds an edit for it that the next export_video will re-render. */
function editWindows(
  root: McpChainRow,
  draft: PendingEditDraft,
  base: PendingEditState["base"],
  imports: Map<string, ImportView>,
  rendered: Map<number, RenderedWindowSpan>,
) {
  const preview = base.preview;
  const rootPreview = base.id === root.id ? preview : rootPreviewOf(root);
  const requirements = externalWindowStates(rootPreview?.config, { bgVideos: mergedBgVideosForReport(root, base, draft.windowEdits, imports) });
  return previewWindowSpans(preview).map((span) => {
    const edit = draft.windowEdits.find((candidate) => candidate.index === span.index);
    const baseWindow = bgVideoAt(preview.config, span.index);
    const view = importViewOf(edit, imports);
    const renderedSpan = rendered.get(span.index) ?? null;
    // A style-only edit changes how the window looks, not its media.
    const replacesMedia = edit !== undefined && edit.replacementKind !== STYLE_ONLY_REPLACEMENT_KIND;
    const activeMotionTemplate =
      normalizeMotionTemplateConfig(edit?.motionTemplate) ??
      (edit === undefined || edit.replacementKind === STYLE_ONLY_REPLACEMENT_KIND
        ? normalizeMotionTemplateConfig(baseWindow?.motionTemplate)
        : null);
    return {
      index: span.index,
      startMs: span.startMs,
      endMs: span.endMs,
      renderedStartMs: renderedSpan?.startMs ?? null,
      renderedEndMs: renderedSpan?.endMs ?? null,
      owner: windowOwner(preview, span.index),
      ...(requirements.find(w => w.index === span.index) ?? {}),
      ...(view && view.status !== "ready" ? { state: view.status === "failed" ? "failed" : "pending" } : {}),
      replaced: replacesMedia || windowReplacedInBase(root, rootPreview, base, span.index),
      pending: edit !== undefined,
      importStatus: view?.status ?? null,
      importError: view?.status === "failed" ? view.errorCode ?? "import_failed" : null,
      ...(activeMotionTemplate ? { motionTemplate: activeMotionTemplate } : {}),
      ...windowStyleView(draft, base, edit, span.index),
    };
  });
}

function captionsView(draft: PendingEditDraft) {
  return draft.captions.map((caption, index) => ({
    index,
    text: caption.text,
    startMs: caption.startMs,
    endMs: caption.endMs,
  }));
}

export async function getEditStateTool(userId: string, jobId: unknown) {
  if (invalidJobId(jobId)) return UNKNOWN_JOB;
  const held = await resolveHeldRoot(userId, jobId as string);
  if (!held.ok) return held.failure;
  const loaded = await loadState(userId, held.root);
  if (!loaded.ok) return loaded.failure;
  const { state } = loaded;
  const status = await getVideoJobStatusTool(userId, held.root.id);
  const statusFields = (status ?? {}) as { status?: string; previewUrl?: string | null; editorUrl?: string | null };
  const imports = await draftImportViews(userId, state.draft);
  const externalRefusal = await validateExternalMediaExport({ userId, sourceJobId: state.base.id, draft: state.draft, allowPending: true });
  // U1: report the timeline the renderer actually produces, not the raw stored boundaries —
  // same coverage function the render route calls, fed the base's bgVideos with every
  // resolvable pending window edit merged on (mirrors the free re-render's own merge).
  const mergedBgVideos = mergedBgVideosForReport(held.root, state.base, state.draft.windowEdits, imports);
  const rendered = renderedWindowSpansMs(mergedBgVideos, previewDurationMs(state.base.preview) / 1_000, RENDER_FPS);
  return {
    jobId: held.root.id,
    status: statusFields.status ?? "held",
    previewUrl: statusFields.previewUrl ?? null,
    editorUrl: statusFields.editorUrl ?? (held.root.projectId ? mcpEditorUrl(held.root.projectId) : null),
    captions: captionsView(state.draft),
    cardLen: state.draft.cardLen,
    subtitleStyle: subtitleStyleView(state.draft.subtitleConfig),
    headlineHook: state.draft.headlineHook ?? null,
    backgroundMusic: await backgroundMusicView(userId, state.draft, state.base.preview),
    tailHoldMs: state.draft.tailHoldMs,
    windows: editWindows(held.root, state.draft, state.base, imports, rendered).map(w => ({ ...w, ...(externalRefusal?.windows.find(required => required.index === w.index) ?? {}) })),
    brollTransition: draftProjectTransition(state.draft, state.base),
    punchZoom: draftProjectPunchZoom(state.draft, state.base),
    sfxMode: draftProjectSfxMode(state.draft, state.base),
    draftRevision: state.revision,
    allowed: ALLOWED,
    next: "แก้รวดเดียวได้ด้วย batch_edit_video หรือแก้ทีละส่วนด้วย apply_video_template / set_caption_text / merge_captions / split_caption / regroup_captions / set_subtitle_style / set_headline_hook / set_background_music / set_tail_hold / replace_broll_window / set_broll_style (หรือ discard_edits เพื่อล้างทั้งหมด) แล้วเรียก export_video(jobId) ครั้งเดียวเมื่อแก้ครบ (ส่งออกไม่ตัดโควต้าเพิ่ม) — windows[].renderedStartMs/renderedEndMs คือช่วงที่เรนเดอร์จริง (อาจไม่ตรงกับ startMs/endMs ถ้าคลิปสั้นกว่าช่วงของมัน) ใช้ค่านี้ตัดสินใจ ไม่ใช่ startMs/endMs ดิบ",
  };
}

// ── set_caption_text ──────────────────────────────────────────────────────────────────────

export async function setCaptionTextTool(userId: string, args: { jobId: unknown; index: unknown; text: unknown }) {
  if (invalidJobId(args.jobId)) return UNKNOWN_JOB;
  const index = args.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    return editToolFailure("invalid_input", "index ต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป", "เรียก get_edit_state เพื่อดู index ของการ์ดซับ");
  }
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) {
    return editToolFailure("invalid_input", "ข้อความซับต้องไม่ว่าง", "ส่ง text ที่มีตัวอักษรอย่างน้อย 1 ตัว");
  }
  if (text.length > MAX_CAPTION_TEXT_CHARS) {
    return editToolFailure(
      "invalid_input",
      `ข้อความซับยาวเกิน ${MAX_CAPTION_TEXT_CHARS} ตัวอักษร`,
      "ย่อข้อความให้สั้นลงแล้วเรียก set_caption_text อีกครั้ง",
    );
  }
  const held = await resolveHeldRoot(userId, args.jobId as string);
  if (!held.ok) return held.failure;

  const updated = await updatePendingEditDraft(userId, held.root, (draft) => {
    if (index >= draft.captions.length) {
      return {
        ok: false,
        code: "invalid_input",
        message: `ไม่มีการ์ดซับลำดับที่ ${index} — มีทั้งหมด ${draft.captions.length} การ์ด (index 0 ถึง ${draft.captions.length - 1})`,
      };
    }
    draft.captions[index] = { ...draft.captions[index], text };
    return { ok: true, draft };
  });
  if (!updated.ok) {
    if (updated.code === "stale_revision") return STALE_REVISION;
    if (updated.code === "project_not_found" || updated.code === "source_not_exportable") return LOAD_FAILURE[updated.code];
    return editToolFailure(updated.code, updated.message ?? GENERIC_ERROR_COPY, "เรียก get_edit_state เพื่อดู index ของการ์ดซับ");
  }
  const caption = updated.state.draft.captions[index];
  return {
    ok: true,
    jobId: held.root.id,
    caption: { index, text: caption.text, startMs: caption.startMs, endMs: caption.endMs },
    draftRevision: updated.state.revision,
    next: "แก้การ์ดอื่นต่อด้วย set_caption_text หรือเรียก export_video(jobId) เมื่อแก้ครบ",
  };
}

// ── merge_captions / split_caption / regroup_captions (G16) ──────────────────────────────────

function invalidCaptionIndex(index: unknown): boolean {
  return typeof index !== "number" || !Number.isInteger(index) || index < 0;
}

const NEXT_MORE_EDITS = "แก้การ์ดหรือสไตล์อื่นต่อ หรือเรียก export_video(jobId) เมื่อแก้ครบ";

export async function mergeCaptionsTool(userId: string, args: ShapeArgs<typeof mergeCaptionsInputShape>) {
  if (invalidJobId(args.jobId)) return UNKNOWN_JOB;
  if (invalidCaptionIndex(args.index)) {
    return editToolFailure("invalid_input", "index ต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป", "เรียก get_edit_state เพื่อดู index ของการ์ดซับ");
  }
  const index = args.index;
  const held = await resolveHeldRoot(userId, args.jobId);
  if (!held.ok) return held.failure;

  const updated = await updatePendingEditDraft(userId, held.root, (draft) => {
    if (index >= draft.captions.length - 1) {
      return {
        ok: false,
        code: "invalid_input",
        message: `รวมการ์ดลำดับที่ ${index} ไม่ได้ — ต้องไม่ใช่การ์ดสุดท้าย (มีทั้งหมด ${draft.captions.length} การ์ด)`,
      };
    }
    draft.captionOverrides = shiftCaptionOverrides(draft.captionOverrides, { from: index + 2, delta: -1, dropIndex: index + 1 });
    draft.captions = mergeCaptionWithNext(draft.captions, index);
    return { ok: true, draft };
  });
  if (!updated.ok) return mapUpdateFailure(updated.code, updated.message, "เรียก get_edit_state เพื่อดู index ของการ์ดซับ");
  const caption = updated.state.draft.captions[index];
  return {
    ok: true,
    jobId: held.root.id,
    caption: { index, text: caption.text, startMs: caption.startMs, endMs: caption.endMs },
    cardCount: updated.state.draft.captions.length,
    draftRevision: updated.state.revision,
    next: NEXT_MORE_EDITS,
  };
}

export async function splitCaptionTool(userId: string, args: ShapeArgs<typeof splitCaptionInputShape>) {
  if (invalidJobId(args.jobId)) return UNKNOWN_JOB;
  if (invalidCaptionIndex(args.index)) {
    return editToolFailure("invalid_input", "index ต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป", "เรียก get_edit_state เพื่อดู index ของการ์ดซับ");
  }
  const index = args.index;
  const leftText = typeof args.leftText === "string" ? args.leftText.trim() : "";
  if (!leftText) {
    return editToolFailure(
      "split_text_mismatch",
      "leftText ต้องไม่ว่าง และต้องเป็นข้อความต้นของการ์ดนี้พอดี",
      "เรียก get_edit_state เพื่อดูข้อความการ์ดก่อนแยก",
    );
  }
  const held = await resolveHeldRoot(userId, args.jobId);
  if (!held.ok) return held.failure;

  const updated = await updatePendingEditDraft(userId, held.root, (draft) => {
    if (index >= draft.captions.length) {
      return {
        ok: false,
        code: "invalid_input",
        message: `ไม่มีการ์ดซับลำดับที่ ${index} — มีทั้งหมด ${draft.captions.length} การ์ด (index 0 ถึง ${draft.captions.length - 1})`,
      };
    }
    const caption = draft.captions[index];
    const text = caption.text.trim();
    if (leftText.length >= text.length || !text.startsWith(leftText)) {
      return {
        ok: false,
        code: "split_text_mismatch",
        message: "leftText ต้องเป็นข้อความต้นของการ์ดนี้พอดี (สะกดตรงตัว และสั้นกว่าทั้งใบ)",
      };
    }
    const rightText = text.slice(leftText.length).trim();
    if (!rightText) {
      return { ok: false, code: "split_text_mismatch", message: "ตัดแล้วข้อความครึ่งหลังว่าง — ลอง leftText ที่สั้นกว่านี้" };
    }
    // Cut proportional to characters, exactly like the web's splitCaption (subtitle-style.ts).
    const cutMs = caption.startMs + Math.round(((caption.endMs - caption.startMs) * leftText.length) / text.length);
    const left = { ...caption, text: leftText, endMs: cutMs };
    const right = { ...caption, text: rightText, startMs: cutMs };
    draft.captionOverrides = shiftCaptionOverrides(draft.captionOverrides, { from: index + 1, delta: 1 });
    draft.captions = [...draft.captions.slice(0, index), left, right, ...draft.captions.slice(index + 1)];
    return { ok: true, draft };
  });
  if (!updated.ok) return mapUpdateFailure(updated.code, updated.message, "เรียก get_edit_state เพื่อดูข้อความการ์ดก่อนแยก");
  const left = updated.state.draft.captions[index];
  const right = updated.state.draft.captions[index + 1];
  return {
    ok: true,
    jobId: held.root.id,
    captions: [
      { index, text: left.text, startMs: left.startMs, endMs: left.endMs },
      { index: index + 1, text: right.text, startMs: right.startMs, endMs: right.endMs },
    ],
    draftRevision: updated.state.revision,
    next: NEXT_MORE_EDITS,
  };
}

const CARD_LEN_VALUES = V2_CARD_LEN_OPTIONS.map((option) => option.value);

export async function regroupCaptionsTool(userId: string, args: ShapeArgs<typeof regroupCaptionsInputShape>) {
  if (invalidJobId(args.jobId)) return UNKNOWN_JOB;
  if (typeof args.cardLen !== "string" || !CARD_LEN_VALUES.includes(args.cardLen as V2CardLen)) {
    return editToolFailure(
      "invalid_input",
      `cardLen ต้องเป็นหนึ่งใน ${CARD_LEN_VALUES.join(", ")}`,
      "เรียก get_edit_state เพื่อดูค่าที่เลือกได้ (allowed.cardLen)",
    );
  }
  const cardLen = args.cardLen as V2CardLen;
  const held = await resolveHeldRoot(userId, args.jobId);
  if (!held.ok) return held.failure;

  const updated = await updatePendingEditDraft(userId, held.root, (draft) => {
    // Exactly like the web's applyCardLen: regroup from the UNTOUCHED original captions (any
    // prior merge/split is discarded, same as usePostPhaseEditor.ts), and reset per-card colour
    // overrides (the card structure is entirely new).
    draft.captions = regroupCaptions(draft.originalCaptions, cardLen, draft.words, draft.fullText, draft.subtitleConfig.fontSize);
    draft.cardLen = cardLen;
    draft.captionOverrides = {};
    return { ok: true, draft };
  });
  if (!updated.ok) return mapUpdateFailure(updated.code, updated.message, "เรียก get_edit_state เพื่อลองใหม่");
  return {
    ok: true,
    jobId: held.root.id,
    cardLen,
    cardCount: updated.state.draft.captions.length,
    draftRevision: updated.state.revision,
    next: "เรียก get_edit_state เพื่อดูการ์ดใหม่ หรือ export_video(jobId) เมื่อแก้ครบ",
  };
}

// ── set_subtitle_style (G17) ──────────────────────────────────────────────────────────────────

export async function setSubtitleStyleTool(userId: string, args: ShapeArgs<typeof setSubtitleStyleInputShape>) {
  if (invalidJobId(args.jobId)) return UNKNOWN_JOB;
  const held = await resolveHeldRoot(userId, args.jobId);
  if (!held.ok) return held.failure;

  let ignoredFields: string[] = [];
  const updated = await updatePendingEditDraft(userId, held.root, (draft) => {
    ignoredFields = [];
    const current = draft.subtitleConfig;
    const preset: SubPreset = args.preset !== undefined ? args.preset : current.preset;
    const effect: SubTextEffect = args.effect !== undefined ? args.effect : current.effect;
    const fontFamily = args.fontFamily !== undefined ? args.fontFamily : (canonicalizeFontFamily(current.fontFamily) ?? current.fontFamily);

    let fontWeight = resolveV2FontWeight(current);
    if (args.fontWeight !== undefined) {
      const resolved = normalizeSubtitleFontWeight(Number(args.fontWeight));
      if (resolved === null) return { ok: false, code: "invalid_input", message: "fontWeight ต้องเป็น 400, 600 หรือ 900" };
      fontWeight = resolved;
    }

    // The web's locked-preset colour rule (subtitle-style.ts LOCKED_COLOR_PRESETS /
    // LOCKED_ACCENT_PRESETS): the control is hidden for these presets, so a value sent anyway
    // never takes effect — the renderer hard-codes the preset's own colour regardless
    // (src/remotion/ShortVideoComposition.tsx).
    const colorLocked = LOCKED_COLOR_PRESETS.includes(preset);
    const accentLocked = LOCKED_ACCENT_PRESETS.includes(preset);
    let textColor = current.textColor;
    if (args.textColor !== undefined) {
      if (colorLocked) ignoredFields.push("textColor");
      else textColor = args.textColor;
    }
    let accentColor = current.accentColor;
    if (args.accentColor !== undefined) {
      if (accentLocked) ignoredFields.push("accentColor");
      else accentColor = args.accentColor;
    }

    const candidate = {
      preset,
      effect,
      cardLen: draft.cardLen,
      fontFamily,
      bold: fontWeight === 900,
      fontWeight,
      fontSize: args.fontSize !== undefined ? args.fontSize : current.fontSize,
      textColor,
      accentColor,
      shadow: args.shadow !== undefined ? args.shadow : current.shadow,
      outline: args.outline !== undefined ? args.outline : current.outline,
      outlineSize: args.outlineSize !== undefined ? args.outlineSize : current.outlineSize,
      verticalPos: args.verticalPos !== undefined ? args.verticalPos : current.verticalPos,
      highlightKeywords: args.highlightKeywords !== undefined ? args.highlightKeywords : Boolean(current.highlightKeywords),
      statCards: args.statCards !== undefined ? args.statCards : Boolean(current.statCards),
    };
    const normalized = normalizeSubtitleStylePresetConfig(candidate);
    if (!normalized) {
      return {
        ok: false,
        code: "invalid_input",
        message: "ค่าที่ส่งไม่ถูกต้อง — เช็คช่วง fontSize (30-160), outlineSize (1-8), verticalPos (10-95) หรือรูปแบบสี #RRGGBB",
      };
    }
    const { cardLen: _cardLen, ...subtitleConfig } = normalized;
    draft.subtitleConfig = subtitleConfig as V2SubConfig;
    return { ok: true, draft };
  });
  if (!updated.ok) return mapUpdateFailure(updated.code, updated.message, "เรียก get_edit_state เพื่อดูค่าปัจจุบัน");
  return {
    ok: true,
    jobId: held.root.id,
    subtitleStyle: subtitleStyleView(updated.state.draft.subtitleConfig),
    ...(ignoredFields.length > 0
      ? { ignoredFields, note: `ไม่เปลี่ยน ${ignoredFields.join(", ")} เพราะสไตล์นี้ล็อกสีไว้ (เปลี่ยน preset ก่อนถ้าต้องการกำหนดสีเอง)` }
      : {}),
    draftRevision: updated.state.revision,
    next: NEXT_MORE_EDITS,
  };
}

// ── set_headline_hook (G18) ───────────────────────────────────────────────────────────────────

function headlineHookPatchFields(args: ShapeArgs<typeof setHeadlineHookInputShape>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (args.enabled !== undefined) fields.enabled = args.enabled;
  if (args.headline !== undefined) fields.headline = args.headline;
  if (args.subheadline !== undefined) fields.subheadline = args.subheadline;
  if (args.durationMs !== undefined) fields.durationMs = args.durationMs;
  if (args.preset !== undefined) fields.preset = args.preset;
  if (args.topPercent !== undefined) fields.topPercent = args.topPercent;
  if (args.anchor !== undefined) fields.anchor = args.anchor;
  if (args.offsetPx !== undefined) fields.offsetPx = args.offsetPx;
  if (args.offsetPercent !== undefined) fields.offsetPercent = args.offsetPercent;
  if (args.fontFamily !== undefined) fields.fontFamily = args.fontFamily;
  if (args.fontSize !== undefined) fields.fontSize = args.fontSize;
  if (args.fontWeight !== undefined) fields.fontWeight = Number(args.fontWeight);
  if (args.subheadlineFontSize !== undefined) fields.subheadlineFontSize = args.subheadlineFontSize;
  return fields;
}

export async function setHeadlineHookTool(userId: string, args: ShapeArgs<typeof setHeadlineHookInputShape>) {
  if (invalidJobId(args.jobId)) return UNKNOWN_JOB;
  const held = await resolveHeldRoot(userId, args.jobId);
  if (!held.ok) return held.failure;

  const updated = await updatePendingEditDraft(userId, held.root, (draft, state) => {
    const totalDurationMs = draftDurationMs(state.base.preview, draft.captions);
    const merged = { ...(draft.headlineHook ?? {}), ...headlineHookPatchFields(args) };
    const normalized = normalizeHeadlineHook(merged, totalDurationMs, draft.subtitleConfig.verticalPos);
    if (!normalized) return { ok: false, code: "invalid_input", message: "ค่าพาดหัวไม่ถูกต้อง" };
    draft.headlineHook = normalized;
    return { ok: true, draft };
  });
  if (!updated.ok) return mapUpdateFailure(updated.code, updated.message, "เรียก get_edit_state เพื่อดูค่าปัจจุบัน");
  return {
    ok: true,
    jobId: held.root.id,
    headlineHook: updated.state.draft.headlineHook ?? null,
    draftRevision: updated.state.revision,
    next: NEXT_MORE_EDITS,
  };
}

// ── set_background_music (EP5 U7, HERO-71) ────────────────────────────────────────────────────

const NEXT_LIST_MUSIC = "เรียก set_background_music(jobId) อย่างเดียวเพื่อดูรายการ tracks แล้วใช้ trackId จากรายการนั้น";
const MAX_TRACK_ID_CHARS = 200;

export async function setBackgroundMusicTool(userId: string, args: ShapeArgs<typeof setBackgroundMusicInputShape>) {
  if (invalidJobId(args.jobId)) return UNKNOWN_JOB;
  const held = await resolveHeldRoot(userId, args.jobId);
  if (!held.ok) return held.failure;

  if (args.trackId === undefined && args.volume === undefined && args.ducking === undefined) {
    const loaded = await loadState(userId, held.root);
    if (!loaded.ok) return loaded.failure;
    const tracks = await listBackgroundMusicTracks(userId);
    return {
      ok: true,
      jobId: held.root.id,
      backgroundMusic: await backgroundMusicView(userId, loaded.state.draft, loaded.state.base.preview),
      tracks: tracks.map(({ trackId, title, kind, mood }) => ({ trackId, title, kind, mood })),
      draftRevision: loaded.state.revision,
      next: "ถาม user ว่าอยากได้เพลงไหน แล้วเรียก set_background_music(jobId, trackId, volume) — trackId \"none\" = ไม่ใส่เพลง; เลือกเพลงใหม่ระบบจะลดเสียงเพลงตอนมีเสียงพูดให้เอง (ducking:false เพื่อปิด)",
    };
  }

  if (args.volume !== undefined && (!Number.isInteger(args.volume) || args.volume < 0 || args.volume > 100)) {
    return editToolFailure("invalid_input", "ความดังเพลงต้องเป็นจำนวนเต็ม 0-100", "ส่ง volume ระหว่าง 0-100 (ค่าเริ่มต้น 12)");
  }
  let pickedTrack: string | null | undefined;
  if (args.trackId !== undefined) {
    const trackId = args.trackId.trim();
    if (trackId.toLowerCase() === "none") {
      pickedTrack = null;
    } else {
      const option = trackId && trackId.length <= MAX_TRACK_ID_CHARS
        ? await findBackgroundMusicTrackById(userId, trackId)
        : null;
      if (!option) return editToolFailure("invalid_input", "ไม่พบเพลงนี้ในคลังเพลงของคุณ", NEXT_LIST_MUSIC);
      pickedTrack = option.track;
    }
  }

  const updated = await updatePendingEditDraft(userId, held.root, (draft, state) => {
    const current = effectiveBackgroundMusic(draft, state.base.preview);
    const track = pickedTrack === undefined ? current.track : pickedTrack;
    // Ducking is on by default only for a NEW music picked here; otherwise it keeps its value.
    const newPick = typeof pickedTrack === "string" && pickedTrack !== current.track;
    const next = normalizeBackgroundMusicEdit({
      track,
      volume: args.volume === undefined ? current.volume : args.volume / 100,
      ducking: track === null ? false : args.ducking ?? (newPick ? true : current.ducking),
    });
    if (!next) {
      return { ok: false, code: "invalid_input", message: "เพลงเดิมของคลิปนี้ปรับไม่ได้ — เลือกเพลงจากรายการด้วย trackId" };
    }
    draft.backgroundMusic = next;
    return { ok: true, draft };
  });
  if (!updated.ok) return mapUpdateFailure(updated.code, updated.message, NEXT_LIST_MUSIC);
  return {
    ok: true,
    jobId: held.root.id,
    backgroundMusic: await backgroundMusicView(userId, updated.state.draft, updated.state.base.preview),
    draftRevision: updated.state.revision,
    next: NEXT_MORE_EDITS,
  };
}

// ── set_tail_hold (EP5 backlog #14) ──────────────────────────────────────────────────────────

export async function setTailHoldTool(userId: string, args: ShapeArgs<typeof setTailHoldInputShape>) {
  if (invalidJobId(args.jobId)) return UNKNOWN_JOB;
  if (!Number.isFinite(args.tailHoldMs)) {
    return editToolFailure("invalid_input", "ค่า tailHoldMs ต้องเป็นตัวเลข", "เรียก get_edit_state เพื่อดูค่าปัจจุบัน");
  }
  const held = await resolveHeldRoot(userId, args.jobId);
  if (!held.ok) return held.failure;

  const updated = await updatePendingEditDraft(userId, held.root, (draft) => {
    draft.tailHoldMs = clampTailHoldMs(args.tailHoldMs);
    return { ok: true, draft };
  });
  if (!updated.ok) return mapUpdateFailure(updated.code, updated.message, "เรียก get_edit_state เพื่อดูค่าปัจจุบัน");
  return {
    ok: true,
    jobId: held.root.id,
    tailHoldMs: updated.state.draft.tailHoldMs,
    draftRevision: updated.state.revision,
    next: NEXT_MORE_EDITS,
  };
}

// ── discard_edits (G20) ───────────────────────────────────────────────────────────────────────

export async function discardEditsTool(userId: string, jobId: unknown) {
  if (invalidJobId(jobId)) return UNKNOWN_JOB;
  const held = await resolveHeldRoot(userId, jobId as string);
  if (!held.ok) return held.failure;
  const result = await discardPendingEditDraft(userId, held.root);
  if (!result.ok) {
    if (result.code === "stale_revision") return STALE_REVISION;
    return LOAD_FAILURE[result.code as "project_not_found" | "source_not_exportable"];
  }
  return {
    ok: true,
    jobId: held.root.id,
    draftRevision: result.state.revision,
    next: "ดราฟต์ถูกรีเซ็ตกลับไปเป็นค่าตั้งต้นของวิดีโอนี้แล้ว — เรียก get_edit_state เพื่อดูค่าปัจจุบัน",
  };
}

// ── replace_broll_window (G19, G27) ───────────────────────────────────────────────────────────

const MAX_DRAFT_WINDOW_EDITS = MAX_BROLL_WINDOW_EDITS;
const BROLL_IMPORT_PURPOSES = ["broll_image", "broll_video"] as const;
const NEXT_WINDOWS = "เรียก get_edit_state เพื่อดู windows[].index ที่แก้ได้";
const NEXT_MEDIA = "ส่งลิงก์ https สาธารณะของรูปหรือวิดีโอ (url) หรืออัปโหลดด้วย create_upload_url แล้วส่ง uploadId";

const ONE_SOURCE = editToolFailure(
  "invalid_input",
  "ต้องส่งอย่างใดอย่างหนึ่งเท่านั้น: url หรือ uploadId หรือ source (\"original\" / \"hero-ai-image\" / \"motion-template\")",
  `${NEXT_MEDIA} หรือ source "original" / "hero-ai-image" / "motion-template" (อย่างใดอย่างหนึ่ง)`,
);
const BAD_URL = editToolFailure(
  "invalid_input",
  `url ไม่ถูกต้อง (ต้องเป็นลิงก์เต็มแบบ https ไม่เกิน ${MAX_MEDIA_URL_CHARS} ตัวอักษร และไม่มีชื่อผู้ใช้/รหัสผ่านในลิงก์)`,
  NEXT_MEDIA,
);
const URL_NOT_HTTPS = editToolFailure(
  "url_not_https",
  "รับเฉพาะลิงก์ที่ขึ้นต้นด้วย https:// เท่านั้น",
  "ส่งลิงก์ https:// ของไฟล์ หรืออัปโหลดไฟล์ด้วย create_upload_url แล้วส่ง uploadId แทน",
);
const NO_WINDOW = editToolFailure("invalid_input", "ไม่พบช่วง B-roll นี้ในวิดีโอตัวอย่าง", NEXT_WINDOWS);
const WINDOW_EDIT_NOT_ENABLED = editToolFailure(
  "feature_not_enabled",
  "การเปลี่ยนภาพช่วง B-roll ยังไม่เปิดให้บัญชีนี้",
  NEXT_EDITOR,
);
const WINDOW_LOCKED = editToolFailure(
  "window_locked_presenter_hook",
  "ช่วงแรกของคลิปโหมดคัตอะเวย์เป็นช่วงเปิดของพิธีกร จึงเปลี่ยนภาพช่วงนี้ไม่ได้",
  `เลือกช่วงอื่น (windowIndex ตั้งแต่ 1) หรือ${NEXT_EDITOR}`,
);
const TOO_MANY_WINDOW_EDITS = editToolFailure(
  "invalid_input",
  `แก้ช่วง B-roll ได้ไม่เกิน ${MAX_DRAFT_WINDOW_EDITS} ช่วงต่อการส่งออกหนึ่งครั้ง`,
  "เรียก export_video ก่อน แล้วค่อยแก้ช่วงที่เหลือ",
);
const ATTACH_IMPORT_FAILED = editToolFailure(
  "import_failed",
  "ไฟล์นี้นำเข้าไม่สำเร็จ จึงใช้แทนช่วงนี้ไม่ได้",
  "อัปโหลดไฟล์ใหม่ด้วย create_upload_url หรือส่ง url อื่น แล้วเรียก replace_broll_window อีกครั้ง",
);
const ORIGINAL_UNAVAILABLE = editToolFailure(
  "original_unavailable",
  "ไม่พบภาพเดิมของช่วงนี้ในวิดีโอตัวอย่าง จึงคืนค่าเดิมไม่ได้",
  NEXT_EDITOR,
);

/** Server-side "is this an https link" (T10's fetch re-validates every hop and the address). */
function parseAgentMediaUrl(raw: unknown): { ok: true; url: string } | { ok: false; failure: EditToolFailure } {
  if (typeof raw !== "string") return { ok: false, failure: BAD_URL };
  const value = raw.trim();
  if (!value || value.length > MAX_MEDIA_URL_CHARS) return { ok: false, failure: BAD_URL };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, failure: BAD_URL };
  }
  if (parsed.protocol !== "https:") return { ok: false, failure: URL_NOT_HTTPS };
  if (parsed.username || parsed.password) return { ok: false, failure: BAD_URL };
  return { ok: true, url: parsed.href };
}

function parseRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function bgVideoAt(config: unknown, index: number): Record<string, unknown> | null {
  const bgVideos = (config as { bgVideos?: unknown } | null | undefined)?.bgVideos;
  const raw = Array.isArray(bgVideos) ? bgVideos[index] : null;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

/** Opening presenter span of an auto-layout Cutaway Mode clip is the presenter's hook. */
function presenterHookLocked(root: McpChainRow, preview: VideoJobPreviewData, index: number): boolean {
  return isPresenterHookWindow(rootPreviewOf(root) ?? preview, parseRecord(root.inputJson)?.cutawayLayout, index);
}

function windowLockedFailure(root: McpChainRow, preview: VideoJobPreviewData): EditToolFailure {
  const firstUnlocked = firstUnlockedCutawayWindowIndex(
    rootPreviewOf(root) ?? preview,
    parseRecord(root.inputJson)?.cutawayLayout,
  );
  if (firstUnlocked === null) {
    return editToolFailure(
      "window_locked_presenter_hook",
      "ช่วงเปิดของคลิปโหมดคัตอะเวย์เป็นช่วงของพิธีกร จึงเปลี่ยนภาพช่วงนี้ไม่ได้",
      `เช็ค windows[] จาก get_edit_state หรือ${NEXT_EDITOR}`,
    );
  }
  return editToolFailure(
    "window_locked_presenter_hook",
    "ช่วงแรกของคลิปโหมดคัตอะเวย์เป็นช่วงเปิดของพิธีกร จึงเปลี่ยนภาพช่วงนี้ไม่ได้",
    `เลือกช่วงอื่น (windowIndex ตั้งแต่ ${firstUnlocked}) หรือ${NEXT_EDITOR}`,
  );
}

function rootPreviewOf(root: McpChainRow): VideoJobPreviewData | null {
  return parseVideoJobOutput(root.outputJson)?.preview ?? null;
}

/**
 * `source:"original"` for one window: `null` = the current base already shows the root's own
 * media there (drop any pending edit); otherwise an edit that restores the root's src (or hides
 * the window when the root gave it to the presenter).
 */
function originalWindowEdit(
  root: McpChainRow,
  base: PendingEditState["base"],
  index: number,
): { ok: true; edit: PendingEditWindowEdit | null } | { ok: false; failure: EditToolFailure } {
  if (base.id === root.id) return { ok: true, edit: null };
  const rootPreview = rootPreviewOf(root);
  const rootWindow = rootPreview ? bgVideoAt(rootPreview.config, index) : null;
  if (!rootPreview || !rootWindow) return { ok: false, failure: ORIGINAL_UNAVAILABLE };
  const baseWindow = bgVideoAt(base.preview.config, index);
  if (baseWindow && baseWindow.src === rootWindow.src && baseWindow.brollEnabled === rootWindow.brollEnabled) {
    return { ok: true, edit: null };
  }
  const rootSrc = typeof rootWindow.src === "string" && rootWindow.src ? rootWindow.src : null;
  if (!(!rootWindow.src && rootWindow.brollEnabled === false) && !externalMediaPlan(rootPreview.config)?.slots[index]?.required && windowOwner(rootPreview, index) === "broll" && (!rootSrc || "error" in validateWindowEdits([{ index, src: rootSrc }]))) {
    return { ok: false, failure: ORIGINAL_UNAVAILABLE };
  }
  return { ok: true, edit: { index, src: rootSrc, replacementKind: "original" } };
}

/**
 * G19: point one B-roll window of a Held Preview at new media (a public `url`, imported by the
 * Media Import lane; or an owned `uploadId`) or back at the root's own media
 * (`source:"original"`). Records into the Pending Edit Draft (CAS, last-wins per window) —
 * nothing renders until export_video. Never echoes the url.
 */
export async function replaceBrollWindowTool(user: User, args: ShapeArgs<typeof replaceBrollWindowInputShape>) {
  if (invalidJobId(args.jobId)) return UNKNOWN_JOB;
  const sources = [args.url, args.uploadId, args.source].filter((value) => value !== undefined).length;
  if (sources !== 1) return ONE_SOURCE;
  if (
    args.source !== undefined
    && args.source !== "original"
    && args.source !== "hero-ai-image"
    && args.source !== "motion-template"
  ) {
    return ONE_SOURCE;
  }
  if ((args.prompt !== undefined || args.treatment !== undefined) && args.source !== "hero-ai-image") {
    return editToolFailure(
      "invalid_input",
      "ส่ง prompt หรือ treatment ได้เฉพาะเมื่อระบุ source เป็น \"hero-ai-image\" เท่านั้น",
      "ระบุ source: \"hero-ai-image\" หรือลบ prompt และ treatment ออก",
    );
  }
  const hasMotionParam =
    args.motionThemeId !== undefined
    || args.motionTemplateId !== undefined
    || args.motionHeaderText !== undefined
    || args.motionTitle !== undefined
    || args.motionSubtitle !== undefined
    || args.motionBadgeText !== undefined
    || args.motionLeftText !== undefined
    || args.motionRightText !== undefined;
  if (hasMotionParam && args.source !== "motion-template") {
    return editToolFailure(
      "invalid_input",
      "ส่งพารามิเตอร์ motion* ได้เฉพาะเมื่อระบุ source เป็น \"motion-template\" เท่านั้น",
      "ระบุ source: \"motion-template\" หรือลบพารามิเตอร์ motion* ออก",
    );
  }
  if (args.motionThemeId !== undefined && !isMotionThemeId(args.motionThemeId)) {
    return editToolFailure(
      "invalid_input",
      `motionThemeId ไม่ถูกต้อง — ต้องเป็นหนึ่งใน ${MOTION_THEME_IDS.join(", ")}`,
      "ดูค่าที่เลือกได้จาก get_edit_state.allowed.motionThemes",
    );
  }
  if (args.motionTemplateId !== undefined && !isMotionTemplateId(args.motionTemplateId)) {
    return editToolFailure(
      "invalid_input",
      `motionTemplateId ไม่ถูกต้อง — ต้องเป็นหนึ่งใน ${MOTION_TEMPLATE_IDS.join(", ")}`,
      "ดูค่าที่เลือกได้จาก get_edit_state.allowed.motionTemplates",
    );
  }
  let treatmentPreset: TreatmentPresetId | undefined;
  if (args.treatment !== undefined) {
    if (!isTreatmentPresetId(args.treatment)) {
      return editToolFailure(
        "invalid_input",
        `treatment ไม่ถูกต้อง — ต้องเป็นหนึ่งใน ${TREATMENT_PRESET_IDS.join(", ")}`,
        "ดูค่าที่เลือกได้จาก get_edit_state.allowed.brollImageTreatments",
      );
    }
    treatmentPreset = args.treatment;
  }
  let customPrompt: string | undefined;
  if (args.prompt !== undefined) {
    if (typeof args.prompt !== "string") {
      return editToolFailure("invalid_input", "prompt ต้องเป็นข้อความ", "ส่ง prompt เป็นข้อความไม่เกิน 500 ตัวอักษร");
    }
    const trimmedPrompt = args.prompt.trim();
    if (trimmedPrompt.length > MAX_HERO_BROLL_CUSTOM_PROMPT_LENGTH) {
      return editToolFailure(
        "invalid_input",
        `prompt ต้องมีความยาวไม่เกิน ${MAX_HERO_BROLL_CUSTOM_PROMPT_LENGTH} ตัวอักษร`,
        "ย่อคำอธิบายฉากให้สั้นลงแล้วลองใหม่",
      );
    }
    if (trimmedPrompt.length > 0) {
      customPrompt = trimmedPrompt;
    }
  }
  const index = args.windowIndex;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return NO_WINDOW;
  let url: string | null = null;
  if (args.url !== undefined) {
    const parsed = parseAgentMediaUrl(args.url);
    if (!parsed.ok) return parsed.failure;
    url = parsed.url;
  }

  const held = await resolveHeldRoot(user.id, args.jobId);
  if (!held.ok) return held.failure;
  const { root } = held;
  const loaded = await loadState(user.id, root);
  if (!loaded.ok) return loaded.failure;
  const { base } = loaded.state;
  const spans = previewWindowSpans(base.preview);
  const targetSpan = spans.find((span) => span.index === index);
  if (!targetSpan) return NO_WINDOW;
  const baseRow = await prisma.videoJob.findFirst({
    where: { id: base.id, userId: user.id },
    select: { projectId: true, contentPreflightId: true, projectVisualContextJson: true },
  });
  if (!baseRow || !brollWindowEditEnabled(user, baseRow)) return WINDOW_EDIT_NOT_ENABLED;
  if (presenterHookLocked(root, base.preview, index)) return windowLockedFailure(root, base.preview);

  let source: "url" | "upload" | "original" | "hero-ai-image" | "motion-template";
  let importId: string | null = null;
  let importStatus: string | null = null;
  let generatedHero: { src: string; imageJobId: string; clipDuration: number; creditsSpent: number } | null = null;
  let plannedMotion: MotionTemplateConfig | null = null;
  if (args.uploadId !== undefined) {
    const owned = await findOwnedMediaImport(user.id, args.uploadId, BROLL_IMPORT_PURPOSES);
    if (!owned.ok) return owned.failure;
    if (owned.row.status === "failed") return ATTACH_IMPORT_FAILED;
    source = "upload";
    importId = owned.row.id;
    importStatus = owned.row.status;
  } else if (url !== null) {
    const created = await createUrlImport(user.id, url);
    if (!created.ok) return admissionRefusal(created.code, "replace_broll_window", created.retryAfterSeconds);
    source = "url";
    importId = created.importId;
    importStatus = "pending";
  } else if (args.source === "hero-ai-image") {
    if (await linkedRerenderInFlight(user.id, root, loaded.state.projectId)) return ORIGINAL_DURING_RERENDER;
    const windowDurationSec = Math.max(1, (targetSpan.endMs - targetSpan.startMs) / 1_000);
    const fallbackSceneText = loaded.state.draft.captions
      .filter((c) => c.endMs > targetSpan.startMs && c.startMs < targetSpan.endMs)
      .map((c) => c.text)
      .join(" ")
      .trim() || loaded.state.draft.captions[index]?.text || `B-roll scene ${index + 1}`;
    const genResult = await generateMcpBrollWindowHeroClip({
      user,
      sourceVideoJobId: base.id,
      rootJobId: root.id,
      sceneIndex: index,
      durationSec: windowDurationSec,
      fallbackSceneText,
      treatment: treatmentPreset,
      prompt: customPrompt,
    });
    if (!genResult.ok) {
      return editToolFailure(genResult.code, genResult.message, genResult.next);
    }
    source = "hero-ai-image";
    importStatus = "ready";
    generatedHero = genResult;
  } else if (args.source === "motion-template") {
    if (await linkedRerenderInFlight(user.id, root, loaded.state.projectId)) return ORIGINAL_DURING_RERENDER;
    const posIdx = Math.max(0, spans.findIndex((s) => s.index === index));
    const sceneText = loaded.state.draft.captions
      .filter((c) => c.endMs > targetSpan.startMs && c.startMs < targetSpan.endMs)
      .map((c) => c.text)
      .join(" ")
      .trim() || loaded.state.draft.captions[index]?.text || "";
    const baseWindow = bgVideoAt(base.preview.config, index);
    const brandCi = {
      primaryColor: loaded.state.draft.subtitleConfig.accentColor,
      accentColor: loaded.state.draft.subtitleConfig.textColor,
      fontFamily: loaded.state.draft.subtitleConfig.fontFamily,
    };
    const explicitTpl = args.motionTemplateId ? motionTemplate(args.motionTemplateId) : null;
    const themeId: MotionThemeId = explicitTpl?.themeId ?? args.motionThemeId ?? "doodle-explainer";
    const autoPlanned = planMotionSceneForWindow({
      themeId,
      windowIndex: posIdx,
      totalWindows: Math.max(1, spans.length),
      captionText: sceneText,
      keyword: typeof baseWindow?.keyword === "string" ? baseWindow.keyword : undefined,
      mascot: args.motionMascot,
      brandCi,
    });
    const finalTemplateId: MotionTemplateId = explicitTpl?.id ?? autoPlanned.templateId;
    plannedMotion = normalizeMotionTemplateConfig({
      templateId: finalTemplateId,
      themeId,
      headerText: args.motionHeaderText ?? autoPlanned.headerText ?? explicitTpl?.defaultProps.headerText,
      title: args.motionTitle ?? autoPlanned.title ?? explicitTpl?.defaultProps.title,
      subtitle: args.motionSubtitle ?? autoPlanned.subtitle ?? explicitTpl?.defaultProps.subtitle,
      badgeText: args.motionBadgeText ?? autoPlanned.badgeText ?? explicitTpl?.defaultProps.badgeText,
      leftText: args.motionLeftText ?? autoPlanned.leftText ?? explicitTpl?.defaultProps.leftText,
      rightText: args.motionRightText ?? autoPlanned.rightText ?? explicitTpl?.defaultProps.rightText,
      items: autoPlanned.items ?? explicitTpl?.defaultProps.items,
      mascot: args.motionMascot ?? autoPlanned.mascot,
      brandCi,
    });
    source = "motion-template";
    importStatus = "ready";
  } else {
    // A1: while a re-render of this root runs, the base it is replacing is about to change, so a
    // restore decided against the current base could be lost when the re-render lands. Refuse
    // instead of answering "will restore" (url/upload edits are safe: the rebase keeps them).
    if (await linkedRerenderInFlight(user.id, root, loaded.state.projectId)) return ORIGINAL_DURING_RERENDER;
    source = "original";
  }

  // Set inside the CAS mutation (a closure) when the failure is this tool's own copy.
  const refused: { failure: EditToolFailure | null } = { failure: null };
  const updated = await updatePendingEditDraft(user.id, root, (draft, state) => {
    let edit: PendingEditWindowEdit | null;
    if (importId) {
      edit = { index, src: null, importId, replacementKind: "upload" };
    } else if (generatedHero) {
      edit = {
        index,
        src: generatedHero.src,
        imageJobId: generatedHero.imageJobId,
        clipDuration: generatedHero.clipDuration,
        replacementKind: "ai",
      };
    } else if (plannedMotion) {
      edit = {
        index,
        src: buildMotionBrollUri(plannedMotion.templateId),
        replacementKind: "motion",
        motionTemplate: plannedMotion,
      };
    } else {
      const original = originalWindowEdit(root, state.base, index);
      if (!original.ok) {
        refused.failure = original.failure;
        return { ok: false, code: original.failure.code, message: original.failure.message };
      }
      edit = original.edit;
    }
    // EP5 #11 / U3: a transition/fit set on this window (set_broll_style) survives a media change.
    const previous = draft.windowEdits.find((candidate) => candidate.index === index);
    const style = previous ? windowEditStyle(previous) : {};
    if (Object.keys(style).length > 0) {
      edit = edit ? { ...edit, ...style } : { index, src: null, replacementKind: STYLE_ONLY_REPLACEMENT_KIND, ...style };
    }
    const others = draft.windowEdits.filter((candidate) => candidate.index !== index);
    draft.windowEdits = edit ? [...others, edit] : others;
    if (draft.windowEdits.length > MAX_DRAFT_WINDOW_EDITS) {
      refused.failure = TOO_MANY_WINDOW_EDITS;
      return { ok: false, code: TOO_MANY_WINDOW_EDITS.code, message: TOO_MANY_WINDOW_EDITS.message };
    }
    return { ok: true, draft };
  });
  if (!updated.ok) {
    // The import never made it into a draft: stop it before the lane spends a fetch on it.
    if (source === "url" && importId) await failMediaImport(importId, "canceled");
    return refused.failure ?? mapUpdateFailure(updated.code, updated.message, NEXT_WINDOWS);
  }
  return {
    ok: true,
    jobId: root.id,
    windowIndex: index,
    source,
    ...(importId ? { importId } : {}),
    ...(generatedHero
      ? {
          imageJobId: generatedHero.imageJobId,
          creditsSpent: generatedHero.creditsSpent,
          ...(treatmentPreset ? { treatment: treatmentPreset } : {}),
        }
      : {}),
    ...(plannedMotion
      ? {
          motionTemplate: plannedMotion,
          creditsSpent: 0,
        }
      : {}),
    importStatus,
    draftRevision: updated.state.revision,
    next: source === "original"
      ? "ช่วงนี้จะกลับเป็นภาพเดิมตอนส่งออก — แก้ต่อได้ หรือเรียก export_video(jobId) เมื่อแก้ครบ"
      : source === "hero-ai-image"
        ? "สร้างภาพ Hero AI Image สำหรับช่วงนี้เสร็จแล้ว — แก้ส่วนอื่นต่อได้ หรือเรียก export_video(jobId) เพื่อเรนเดอร์และส่งออก (การส่งออกไม่ตัดโควต้าเพิ่ม)"
        : source === "motion-template"
          ? "ตั้งค่าฉากแอนิเมชัน Motion / HyperFrames พร้อม Brand CI สำหรับช่วงนี้แล้ว (0 เครดิต) — แก้ส่วนอื่นต่อได้ หรือเรียก export_video(jobId) เพื่อเรนเดอร์และส่งออก"
          : importStatus === "ready"
            ? "ไฟล์พร้อมแล้ว (เสียงในไฟล์จะถูกปิด ใช้เสียงพากย์เดิม) — แก้ต่อได้ หรือเรียก export_video(jobId) เมื่อแก้ครบ"
            : "ไฟล์กำลังนำเข้า (เสียงในไฟล์จะถูกปิด ใช้เสียงพากย์เดิม) — แก้ส่วนอื่นต่อได้ระหว่างนี้; เช็ค windows[].importStatus ด้วย get_edit_state เป็นระยะจนเป็น \"ready\" แล้วเรียก export_video(jobId)",
  };
}

// ── set_broll_style (EP5 #11 hard cut, U3 fit, #4 punchZoom, #3 sfxMode) ────────────────────

const NEXT_STYLE = "ส่ง transition (\"dissolve\" / \"cut\" / \"default\"), fit (\"cover\" / \"contain\"), punchZoom (true / false) และ/หรือ sfxMode (\"none\" / \"subtle\") — ดูค่าที่ใช้ได้ที่ allowed.brollWindowTransitions / allowed.brollFits / allowed.sfxModes ของ get_edit_state";
const NO_STYLE = editToolFailure("invalid_input", "ต้องส่ง transition, fit, punchZoom หรือ sfxMode อย่างน้อยหนึ่งค่า", NEXT_STYLE);
const BAD_TRANSITION = editToolFailure("invalid_input", "รูปแบบการเปลี่ยนฉาก b-roll ไม่ถูกต้อง", NEXT_STYLE);
const BAD_FIT = editToolFailure("invalid_input", "รูปแบบการจัดภาพ b-roll ไม่ถูกต้อง", NEXT_STYLE);
const BAD_PUNCH_ZOOM = editToolFailure("invalid_input", "ตั้งค่า punchZoom ต้องเป็น true หรือ false", NEXT_STYLE);
const BAD_SFX_MODE = editToolFailure("invalid_input", "ตั้งค่า sfxMode ต้องเป็น \"none\" หรือ \"subtle\"", NEXT_STYLE);
const PROJECT_TRANSITION_ONLY = editToolFailure(
  "invalid_input",
  "ค่าหลักของทั้งคลิปตั้งได้เฉพาะ transition (\"dissolve\" / \"cut\"), punchZoom (true / false) และ sfxMode (\"none\" / \"subtle\") — fit และ \"default\" ต้องระบุ windowIndex",
  "ส่ง windowIndex (windows[].index จาก get_edit_state) เพื่อตั้งค่าทีละช่วง หรือส่ง transition (\"dissolve\"/\"cut\"), punchZoom และ/หรือ sfxMode เพื่อตั้งค่าหลัก",
);
const PUNCH_ZOOM_PROJECT_LEVEL_ONLY = editToolFailure(
  "invalid_input",
  "punchZoom เป็นการตั้งค่าหลักของทั้งคลิป — ห้ามส่งพร้อม windowIndex",
  "เรียก set_broll_style โดยไม่ส่ง windowIndex เพื่อตั้งค่า punchZoom ของทั้งคลิป",
);
const SFX_MODE_PROJECT_LEVEL_ONLY = editToolFailure(
  "invalid_input",
  "sfxMode เป็นการตั้งค่าหลักของทั้งคลิป — ห้ามส่งพร้อม windowIndex",
  "เรียก set_broll_style โดยไม่ส่ง windowIndex เพื่อตั้งค่า sfxMode ของทั้งคลิป",
);

/**
 * EP5 #11 / U3 / #4 / #3: how B-roll windows end (dissolve / hard cut), fit (cover / contain),
 * presenter punch-in zoom, and subtle transition sound effects, without replacing media. With
 * `windowIndex` it sets that window (last-wins, kept through a later replace_broll_window);
 * without it, the project default transition, presenter punchZoom, and/or sfxMode. A value equal
 * to the current base is a no-op that drops the pending change. Recorded in the Pending Edit Draft
 * (CAS) — the next export_video renders it for free.
 */
export async function setBrollStyleTool(user: User, args: ShapeArgs<typeof setBrollStyleInputShape>) {
  if (invalidJobId(args.jobId)) return UNKNOWN_JOB;
  const { transition, fit, punchZoom, sfxMode } = args;
  if (transition === undefined && fit === undefined && punchZoom === undefined && sfxMode === undefined) return NO_STYLE;
  if (transition !== undefined && !isBrollTransitionEdit(transition)) return BAD_TRANSITION;
  if (fit !== undefined && !isBrollFit(fit)) return BAD_FIT;
  if (punchZoom !== undefined && typeof punchZoom !== "boolean") return BAD_PUNCH_ZOOM;
  if (sfxMode !== undefined && !isSfxMode(sfxMode)) return BAD_SFX_MODE;
  const index = args.windowIndex;
  const projectLevel = index === undefined;
  if (!projectLevel && punchZoom !== undefined) return PUNCH_ZOOM_PROJECT_LEVEL_ONLY;
  if (!projectLevel && sfxMode !== undefined) return SFX_MODE_PROJECT_LEVEL_ONLY;
  if (projectLevel && (fit !== undefined || (transition !== undefined && !isBrollTransition(transition)))) {
    return PROJECT_TRANSITION_ONLY;
  }
  if (!projectLevel && (typeof index !== "number" || !Number.isInteger(index) || index < 0)) return NO_WINDOW;

  const held = await resolveHeldRoot(user.id, args.jobId);
  if (!held.ok) return held.failure;
  const { root } = held;
  const loaded = await loadState(user.id, root);
  if (!loaded.ok) return loaded.failure;
  const { base } = loaded.state;
  if (!projectLevel && !previewWindowSpans(base.preview).some((span) => span.index === index)) return NO_WINDOW;
  const baseRow = await prisma.videoJob.findFirst({
    where: { id: base.id, userId: user.id },
    select: { projectId: true, contentPreflightId: true, projectVisualContextJson: true },
  });
  if (!baseRow || !brollWindowEditEnabled(user, baseRow)) return WINDOW_EDIT_NOT_ENABLED;
  // Like replace_broll_window's A1: while a re-render of this root runs, the base the "equal to
  // the base → drop the pending value" decision reads is about to be replaced, so a revert decided
  // now would be lost when the re-render lands. Refuse instead of answering ok.
  if (await linkedRerenderInFlight(user.id, root, loaded.state.projectId)) return STYLE_DURING_RERENDER;

  const refused: { failure: EditToolFailure | null } = { failure: null };
  const updated = await updatePendingEditDraft(user.id, root, (draft, state) => {
    const baseConfig = state.base.preview.config as { brollTransition?: unknown; punchZoom?: unknown; sfxMode?: unknown };
    if (projectLevel) {
      if (transition !== undefined) {
        if (transition === effectiveBrollTransition(undefined, baseConfig.brollTransition)) delete draft.brollTransition;
        else if (isBrollTransition(transition)) draft.brollTransition = transition;
      }
      if (typeof punchZoom === "boolean") {
        if (punchZoom === effectivePunchZoom(baseConfig.punchZoom)) delete draft.punchZoom;
        else draft.punchZoom = punchZoom;
      }
      if (sfxMode !== undefined) {
        if (sfxMode === effectiveSfxMode(baseConfig.sfxMode)) delete draft.sfxMode;
        else if (isSfxMode(sfxMode)) draft.sfxMode = sfxMode;
      }
      return { ok: true, draft };
    }
    if (!previewWindowSpans(state.base.preview).some((span) => span.index === index)) {
      refused.failure = NO_WINDOW;
      return { ok: false, code: NO_WINDOW.code, message: NO_WINDOW.message };
    }
    const baseWindow = bgVideoAt(state.base.preview.config, index);
    const previous = draft.windowEdits.find((candidate) => candidate.index === index);
    const next: PendingEditWindowEdit = previous
      ? { ...previous }
      : { index, src: null, replacementKind: STYLE_ONLY_REPLACEMENT_KIND };
    if (transition !== undefined) {
      const baseOwn = isBrollTransition(baseWindow?.transition) ? baseWindow.transition : BROLL_TRANSITION_FOLLOW_DEFAULT;
      if (transition === baseOwn) delete next.transition;
      else next.transition = transition;
    }
    if (fit !== undefined) {
      if (fit === effectiveBrollFit(baseWindow?.fit)) delete next.fit;
      else next.fit = fit;
    }
    const others = draft.windowEdits.filter((candidate) => candidate.index !== index);
    const emptyStyleOnly = next.replacementKind === STYLE_ONLY_REPLACEMENT_KIND
      && next.transition === undefined && next.fit === undefined;
    draft.windowEdits = emptyStyleOnly ? others : [...others, next];
    if (draft.windowEdits.length > MAX_DRAFT_WINDOW_EDITS) {
      refused.failure = TOO_MANY_WINDOW_EDITS;
      return { ok: false, code: TOO_MANY_WINDOW_EDITS.code, message: TOO_MANY_WINDOW_EDITS.message };
    }
    return { ok: true, draft };
  });
  if (!updated.ok) return refused.failure ?? mapUpdateFailure(updated.code, updated.message, NEXT_WINDOWS);
  const { draft, base: updatedBase } = updated.state;
  const edit = projectLevel ? undefined : draft.windowEdits.find((candidate) => candidate.index === index);
  return {
    ok: true,
    jobId: root.id,
    ...(projectLevel
      ? {
          brollTransition: draftProjectTransition(draft, updatedBase),
          punchZoom: draftProjectPunchZoom(draft, updatedBase),
          sfxMode: draftProjectSfxMode(draft, updatedBase),
        }
      : { windowIndex: index, ...windowStyleView(draft, updatedBase, edit, index) }),
    pending: draftHasBrollChanges(draft),
    draftRevision: updated.state.revision,
    next: "ยังไม่เรนเดอร์ — แก้ต่อได้ หรือเรียก export_video(jobId) เมื่อแก้ครบ (ระบบเรนเดอร์ช่วง B-roll ใหม่ให้ ไม่ตัดโควต้าเพิ่ม)",
  };
}

// ── apply_video_template (HERO-94) ────────────────────────────────────────────────────────

const BAD_TEMPLATE_ID = editToolFailure(
  "invalid_input",
  `templateId ไม่ถูกต้อง — ต้องเป็นหนึ่งใน ${ACTIVE_STYLE_PACK_IDS.join(", ")}`,
  "เรียก get_video_options เพื่อดู templates ที่เปิดใช้งาน",
);
const BAD_MOTION_THEME_ID = editToolFailure(
  "invalid_input",
  `motionThemeId ไม่ถูกต้อง — ต้องเป็นหนึ่งใน ${MOTION_THEME_IDS.join(", ")}`,
  "เรียก get_video_options หรือ get_edit_state.allowed.motionThemes เพื่อดูธีมโมชันที่เลือกได้",
);
const BAD_INCLUDE_MUSIC = editToolFailure(
  "invalid_input",
  "ตั้งค่า includeMusic ต้องเป็น true หรือ false",
  "ส่ง includeMusic: true หรือ false",
);

/**
 * Whole-clip Motion Theme lock: auto-plans every unlocked B-roll window in `preview` with the chosen
 * `motionThemeId` (`"doodle-explainer"` | `"cue-step-board"` | `"hyperframe-kinetic"`) and the draft's
 * current Brand CI (`accentColor`, `textColor`, `fontFamily`).
 */
function applyMotionThemeAcrossDraftWindows(
  root: McpChainRow,
  draft: PendingEditDraft,
  preview: VideoJobPreviewData,
  themeId: MotionThemeId,
  mascot?: MotionMascotId,
): number {
  const spans = previewWindowSpans(preview);
  const brandCi = {
    primaryColor: draft.subtitleConfig.accentColor,
    accentColor: draft.subtitleConfig.textColor,
    fontFamily: draft.subtitleConfig.fontFamily,
  };
  const byIndex = new Map<number, PendingEditWindowEdit>(
    draft.windowEdits.map((e) => [e.index, { ...e }]),
  );
  let plannedCount = 0;
  for (let posIdx = 0; posIdx < spans.length; posIdx += 1) {
    const span = spans[posIdx];
    if (presenterHookLocked(root, preview, span.index)) continue;
    if (!byIndex.has(span.index) && byIndex.size >= MAX_DRAFT_WINDOW_EDITS) break;
    const sceneText = draft.captions
      .filter((c) => c.endMs > span.startMs && c.startMs < span.endMs)
      .map((c) => c.text)
      .join(" ")
      .trim() || draft.captions[posIdx]?.text || "";
    const baseWindow = bgVideoAt(preview.config, span.index);
    const planned = planMotionSceneForWindow({
      themeId,
      windowIndex: posIdx,
      totalWindows: spans.length,
      captionText: sceneText,
      keyword: typeof baseWindow?.keyword === "string" ? baseWindow.keyword : undefined,
      mascot,
      brandCi,
    });
    const prev = byIndex.get(span.index);
    const style = prev ? windowEditStyle(prev) : {};
    byIndex.set(span.index, {
      index: span.index,
      src: buildMotionBrollUri(planned.templateId),
      replacementKind: "motion",
      motionTemplate: planned,
      ...style,
    });
    plannedCount += 1;
  }
  draft.windowEdits = [...byIndex.values()].sort((a, b) => a.index - b.index);
  return plannedCount;
}

/**
 * HERO-94: 1-click full-recipe video template transformation on a Held Preview's Pending Edit Draft.
 * Applies the StylePack's subtitle config (`V2SubConfig` + `highlightKeywords` + `statCards` + `cardLen`),
 * headline hook preset (preserving existing hook text/enabled state when present), `sfxMode`,
 * `brollTransition` across windows + `punchZoom` (when B-roll window edits are enabled for the job),
 * optionally locks all B-roll windows to `motionThemeId` + Brand CI, and optionally picks a BGM track
 * matching `musicMood` when `includeMusic: true`.
 */
export async function applyVideoTemplateTool(user: User, args: ShapeArgs<typeof applyVideoTemplateInputShape>) {
  if (invalidJobId(args.jobId)) return UNKNOWN_JOB;
  if (!isActiveStylePackId(args.templateId)) return BAD_TEMPLATE_ID;
  if (args.includeMusic !== undefined && typeof args.includeMusic !== "boolean") return BAD_INCLUDE_MUSIC;
  if (args.motionThemeId !== undefined && !isMotionThemeId(args.motionThemeId)) return BAD_MOTION_THEME_ID;

  const held = await resolveHeldRoot(user.id, args.jobId);
  if (!held.ok) return held.failure;
  const { root } = held;
  const loaded = await loadState(user.id, root);
  if (!loaded.ok) return loaded.failure;
  const { base } = loaded.state;
  if (await linkedRerenderInFlight(user.id, root, loaded.state.projectId)) return STYLE_DURING_RERENDER;

  const baseRow = await prisma.videoJob.findFirst({
    where: { id: base.id, userId: user.id },
    select: { projectId: true, contentPreflightId: true, projectVisualContextJson: true },
  });
  const canRerenderBroll = Boolean(baseRow && brollWindowEditEnabled(user, baseRow));
  if (args.motionThemeId !== undefined && !canRerenderBroll) return WINDOW_EDIT_NOT_ENABLED;

  const pack = stylePack(args.templateId);
  let matchedMusicTrack: { track: string; title: string; trackId: string } | null = null;
  if (args.includeMusic === true) {
    const tracks = await listBackgroundMusicTracks(user.id);
    const resolved = resolveMusicMoodTrack(
      pack.musicMood,
      tracks.map((t) => ({ title: t.title, bgmFile: t.track, mood: t.mood })),
    );
    const matched = resolved ? tracks.find((t) => t.track === resolved.bgmFile) ?? null : null;
    if (matched) matchedMusicTrack = { track: matched.track, title: matched.title, trackId: matched.trackId };
  }

  let motionWindowsPlanned = 0;
  const updated = await updatePendingEditDraft(user.id, root, (draft, state) => {
    const totalDurationMs = draftDurationMs(state.base.preview, draft.captions);
    const sourceText = draft.fullText?.trim()
      || draft.captions.map((c) => c.text).join(" ").trim();
    const resolved = resolveTemplatePostEdit({
      templateId: args.templateId as typeof pack.id & string as Parameters<typeof resolveTemplatePostEdit>[0]["templateId"],
      currentHeadlineHook: draft.headlineHook ?? null,
      headlineSourceText: sourceText,
      totalDurationMs,
    });
    const canonicalFont = canonicalizeFontFamily(resolved.subtitleConfig.fontFamily) ?? resolved.subtitleConfig.fontFamily;
    draft.subtitleConfig = {
      ...(resolved.subtitleConfig as V2SubConfig),
      fontFamily: canonicalFont,
    };
    if (draft.cardLen !== resolved.cardLen) {
      draft.captions = regroupCaptions(
        draft.originalCaptions,
        resolved.cardLen,
        draft.words,
        draft.fullText,
        draft.subtitleConfig.fontSize,
      );
      draft.cardLen = resolved.cardLen;
      draft.captionOverrides = {};
    }

    if (resolved.headlineHook) {
      draft.headlineHook = resolved.headlineHook;
    }

    const baseConfig = state.base.preview.config as {
      brollTransition?: unknown;
      punchZoom?: unknown;
      sfxMode?: unknown;
    };
    if (pack.sfxMode === effectiveSfxMode(baseConfig.sfxMode)) delete draft.sfxMode;
    else draft.sfxMode = pack.sfxMode;

    if (canRerenderBroll) {
      if (pack.brollTransition === effectiveBrollTransition(undefined, baseConfig.brollTransition)) {
        delete draft.brollTransition;
      } else {
        draft.brollTransition = pack.brollTransition;
      }
      if (pack.punchZoom === effectivePunchZoom(baseConfig.punchZoom)) {
        delete draft.punchZoom;
      } else {
        draft.punchZoom = pack.punchZoom;
      }
      // Reset per-window transition overrides so the template's transition applies across all windows,
      // while preserving any media replacements and per-window fit.
      draft.windowEdits = draft.windowEdits.flatMap((edit) => {
        const baseWindow = bgVideoAt(state.base.preview.config, edit.index);
        const baseHasOwnTransition = isBrollTransition(baseWindow?.transition);
        const nextEdit: PendingEditWindowEdit = { ...edit };
        if (baseHasOwnTransition) nextEdit.transition = BROLL_TRANSITION_FOLLOW_DEFAULT;
        else delete nextEdit.transition;
        if (
          nextEdit.replacementKind === STYLE_ONLY_REPLACEMENT_KIND
          && nextEdit.transition === undefined
          && nextEdit.fit === undefined
        ) {
          return [];
        }
        return [nextEdit];
      });
      if (args.motionThemeId !== undefined) {
        motionWindowsPlanned = applyMotionThemeAcrossDraftWindows(root, draft, state.base.preview, args.motionThemeId, args.motionMascot);
      }
    }

    if (args.includeMusic === true && matchedMusicTrack) {
      const currentMusic = effectiveBackgroundMusic(draft, state.base.preview);
      const nextMusic = normalizeBackgroundMusicEdit({
        track: matchedMusicTrack.track,
        volume: currentMusic.volume || DEFAULT_BGM_VOLUME,
        ducking: true,
      });
      if (nextMusic) draft.backgroundMusic = nextMusic;
    }

    return { ok: true, draft };
  });
  if (!updated.ok) return mapUpdateFailure(updated.code, updated.message, NEXT_RELOAD);

  const { draft: nextDraft, base: updatedBase } = updated.state;
  return {
    ok: true,
    jobId: root.id,
    templateId: pack.id,
    thaiLabel: pack.thaiLabel,
    ...(args.motionThemeId ? { motionThemeId: args.motionThemeId, motionWindowsPlanned } : {}),
    cardLen: nextDraft.cardLen,
    cardCount: nextDraft.captions.length,
    subtitleStyle: subtitleStyleView(nextDraft.subtitleConfig),
    headlineHook: nextDraft.headlineHook ?? null,
    sfxMode: draftProjectSfxMode(nextDraft, updatedBase),
    brollTransition: draftProjectTransition(nextDraft, updatedBase),
    punchZoom: draftProjectPunchZoom(nextDraft, updatedBase),
    backgroundMusic: await backgroundMusicView(user.id, nextDraft, updatedBase.preview),
    musicApplied: Boolean(args.includeMusic === true && matchedMusicTrack),
    pending: draftHasBrollChanges(nextDraft),
    draftRevision: updated.state.revision,
    next: "ใช้สไตล์เทมเพลตแล้ว (ยังไม่เรนเดอร์) — แก้ข้อความซับหรือพาดหัวต่อได้ หรือเรียก export_video(jobId) เมื่อพร้อมส่งออก (ไม่ตัดโควต้าเพิ่ม)",
  };
}

// ── batch_edit_video (HERO-96) ────────────────────────────────────────────────────────────

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_BATCH_CAPTIONS = 500;
const SUBTITLE_PRESET_VALUES = PRESETS_DATA.map((preset) => preset.value);
const SUBTITLE_EFFECT_VALUES = EFFECTS_DATA.map((effect) => effect.value);
const SUBTITLE_FONT_VALUES = FONTS_LIST.map((font) => font.value);
const NEXT_BATCH = "ตรวจสอบพารามิเตอร์ตาม get_edit_state.allowed แล้วเรียก batch_edit_video ใหม่ (ยังไม่ได้บันทึกการแก้ใดๆ)";

function normalizeBatchBgmVolume(raw: number): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 100) return null;
  if (raw > 0 && raw < 1 && !Number.isInteger(raw)) return raw;
  return raw / 100;
}

/**
 * HERO-96: apply multiple Held Preview edits onto a single `jobId` atomically in one round-trip.
 * Validates all requested operations upfront and inside a cloned CAS draft so any invalid sub-edit
 * returns a G14 `{ error, code, message, next }` refusal without half-mutating `PendingEditDraft`.
 */
export async function batchEditVideoTool(user: User, args: ShapeArgs<typeof batchEditVideoInputShape>) {
  if (invalidJobId(args.jobId)) return UNKNOWN_JOB;

  const hasSubtitlePatch =
    args.subtitlePreset !== undefined
    || args.subtitleEffect !== undefined
    || args.fontFamily !== undefined
    || args.fontSize !== undefined
    || args.fontWeight !== undefined
    || args.textColor !== undefined
    || args.accentColor !== undefined
    || args.shadow !== undefined
    || args.outline !== undefined
    || args.outlineSize !== undefined
    || args.highlightKeywords !== undefined
    || args.statCards !== undefined
    || args.verticalPos !== undefined;

  const hasHeadlinePatch =
    args.headlineHookEnabled !== undefined
    || args.headlineHookText !== undefined
    || args.headlineHookSubtext !== undefined
    || args.headlineHookPreset !== undefined
    || args.headlineHookDurationMs !== undefined;

  const hasExplicitBgmPatch =
    args.disableBgm !== undefined
    || args.bgmMoodOrTrack !== undefined
    || args.bgmVolume !== undefined
    || args.bgmDucking !== undefined;

  const hasBrollPatch =
    args.brollWindowIndex !== undefined
    || args.sfxMode !== undefined
    || args.brollTransition !== undefined
    || args.brollFit !== undefined
    || args.punchZoom !== undefined;

  const hasAnyEdit =
    args.templateId !== undefined
    || args.includeTemplateMusic !== undefined
    || args.motionThemeId !== undefined
    || args.regroupCardLen !== undefined
    || args.captionIndices !== undefined
    || args.captionTexts !== undefined
    || hasSubtitlePatch
    || hasHeadlinePatch
    || hasExplicitBgmPatch
    || args.tailHoldMs !== undefined
    || hasBrollPatch;

  if (!hasAnyEdit) {
    return editToolFailure(
      "invalid_input",
      "ต้องระบุรายการแก้ไขอย่างน้อย 1 อย่างใน batch_edit_video",
      "ส่งฟิลด์ที่ต้องการแก้ เช่น templateId, motionThemeId, captionIndices+captionTexts, subtitlePreset, headlineHookText, bgmMoodOrTrack, tailHoldMs หรือ brollTransition",
    );
  }

  // 1. Template & regroup validation
  if (args.templateId !== undefined && !isActiveStylePackId(args.templateId)) {
    return BAD_TEMPLATE_ID;
  }
  if (args.motionThemeId !== undefined && !isMotionThemeId(args.motionThemeId)) {
    return BAD_MOTION_THEME_ID;
  }
  if (args.includeTemplateMusic !== undefined) {
    if (typeof args.includeTemplateMusic !== "boolean") {
      return editToolFailure("invalid_input", "ตั้งค่า includeTemplateMusic ต้องเป็น true หรือ false", NEXT_BATCH);
    }
    if (args.templateId === undefined) {
      return editToolFailure(
        "invalid_input",
        "ส่ง includeTemplateMusic ได้เฉพาะเมื่อระบุ templateId เท่านั้น",
        "ระบุ templateId ร่วมกับ includeTemplateMusic หรือใช้ bgmMoodOrTrack เพื่อเลือกเพลงโดยตรง",
      );
    }
  }
  if (
    args.regroupCardLen !== undefined
    && (typeof args.regroupCardLen !== "string" || !CARD_LEN_VALUES.includes(args.regroupCardLen as V2CardLen))
  ) {
    return editToolFailure(
      "invalid_input",
      `regroupCardLen ต้องเป็นหนึ่งใน ${CARD_LEN_VALUES.join(", ")}`,
      "เรียก get_edit_state เพื่อดูค่าที่เลือกได้ (allowed.cardLen)",
    );
  }

  // 2. Batch caption text updates validation
  if ((args.captionIndices !== undefined) !== (args.captionTexts !== undefined)) {
    return editToolFailure(
      "invalid_input",
      "ต้องส่ง captionIndices และ captionTexts คู่กันเสมอ",
      "ส่งทั้ง captionIndices และ captionTexts ที่มีความยาวเท่ากัน",
    );
  }
  const normalizedCaptionUpdates: Array<{ index: number; text: string }> = [];
  if (args.captionIndices !== undefined && args.captionTexts !== undefined) {
    if (!Array.isArray(args.captionIndices) || !Array.isArray(args.captionTexts)) {
      return editToolFailure("invalid_input", "captionIndices และ captionTexts ต้องเป็นอาเรย์", NEXT_BATCH);
    }
    if (args.captionIndices.length === 0 || args.captionTexts.length === 0) {
      return editToolFailure(
        "invalid_input",
        "captionIndices และ captionTexts ต้องมีอย่างน้อย 1 รายการ",
        "ส่งรายการการ์ดซับที่ต้องการแก้ไขอย่างน้อย 1 ใบ หรือลบทั้งสองฟิลด์ออก",
      );
    }
    if (args.captionIndices.length !== args.captionTexts.length) {
      return editToolFailure(
        "invalid_input",
        `จำนวน captionIndices (${args.captionIndices.length}) ไม่ตรงกับ captionTexts (${args.captionTexts.length})`,
        "ตรวจสอบให้ captionIndices และ captionTexts มีจำนวนรายการเท่ากันพอดี",
      );
    }
    if (args.captionIndices.length > MAX_BATCH_CAPTIONS) {
      return editToolFailure(
        "invalid_input",
        `แก้ไขการ์ดซับพร้อมกันได้ไม่เกิน ${MAX_BATCH_CAPTIONS} การ์ดต่อครั้ง`,
        NEXT_BATCH,
      );
    }
    const seenIndices = new Set<number>();
    for (let i = 0; i < args.captionIndices.length; i += 1) {
      const idx = args.captionIndices[i];
      const rawText = args.captionTexts[i];
      if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
        return editToolFailure(
          "invalid_input",
          `captionIndices[${i}] ต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป`,
          "เรียก get_edit_state เพื่อดู index ของการ์ดซับ",
        );
      }
      if (seenIndices.has(idx)) {
        return editToolFailure(
          "invalid_input",
          `พบ index ซ้ำใน captionIndices (ลำดับที่ ${idx})`,
          "รวมการแก้ของการ์ดซับลำดับเดียวกันให้เหลือรายการเดียว",
        );
      }
      seenIndices.add(idx);
      const trimmed = typeof rawText === "string" ? rawText.trim() : "";
      if (!trimmed) {
        return editToolFailure(
          "invalid_input",
          `ข้อความซับของการ์ดลำดับที่ ${idx} ต้องไม่ว่าง`,
          "ส่งข้อความซับที่มีตัวอักษรอย่างน้อย 1 ตัว",
        );
      }
      if (trimmed.length > MAX_CAPTION_TEXT_CHARS) {
        return editToolFailure(
          "invalid_input",
          `ข้อความซับของการ์ดลำดับที่ ${idx} ยาวเกิน ${MAX_CAPTION_TEXT_CHARS} ตัวอักษร`,
          "ย่อข้อความให้สั้นลงแล้วเรียก batch_edit_video อีกครั้ง",
        );
      }
      normalizedCaptionUpdates.push({ index: idx, text: trimmed });
    }
  }

  // 3. Subtitle style validation
  if (args.subtitlePreset !== undefined && !SUBTITLE_PRESET_VALUES.includes(args.subtitlePreset)) {
    return editToolFailure("invalid_input", "subtitlePreset ไม่ถูกต้อง", NEXT_BATCH);
  }
  if (args.subtitleEffect !== undefined && !SUBTITLE_EFFECT_VALUES.includes(args.subtitleEffect)) {
    return editToolFailure("invalid_input", "subtitleEffect ไม่ถูกต้อง", NEXT_BATCH);
  }
  if (args.fontFamily !== undefined && !SUBTITLE_FONT_VALUES.includes(args.fontFamily)) {
    return editToolFailure("invalid_input", "fontFamily ไม่ถูกต้อง", NEXT_BATCH);
  }
  if (args.fontWeight !== undefined && normalizeSubtitleFontWeight(Number(args.fontWeight)) === null) {
    return editToolFailure("invalid_input", "fontWeight ต้องเป็น 400, 600 หรือ 900", NEXT_BATCH);
  }
  if (args.fontSize !== undefined && (typeof args.fontSize !== "number" || !Number.isInteger(args.fontSize) || args.fontSize < 30 || args.fontSize > 160)) {
    return editToolFailure("invalid_input", "fontSize ต้องเป็นจำนวนเต็มระหว่าง 30-160", NEXT_BATCH);
  }
  if (args.outlineSize !== undefined && (typeof args.outlineSize !== "number" || !Number.isInteger(args.outlineSize) || args.outlineSize < 1 || args.outlineSize > 8)) {
    return editToolFailure("invalid_input", "outlineSize ต้องเป็นจำนวนเต็มระหว่าง 1-8", NEXT_BATCH);
  }
  if (args.verticalPos !== undefined && (typeof args.verticalPos !== "number" || !Number.isInteger(args.verticalPos) || args.verticalPos < 10 || args.verticalPos > 95)) {
    return editToolFailure("invalid_input", "verticalPos ต้องเป็นจำนวนเต็มระหว่าง 10-95", NEXT_BATCH);
  }
  if (args.textColor !== undefined && (typeof args.textColor !== "string" || !HEX_COLOR_RE.test(args.textColor))) {
    return editToolFailure("invalid_input", "textColor ต้องอยู่ในรูปแบบ #RRGGBB", NEXT_BATCH);
  }
  if (args.accentColor !== undefined && (typeof args.accentColor !== "string" || !HEX_COLOR_RE.test(args.accentColor))) {
    return editToolFailure("invalid_input", "accentColor ต้องอยู่ในรูปแบบ #RRGGBB", NEXT_BATCH);
  }
  for (const [label, flag] of [
    ["shadow", args.shadow],
    ["outline", args.outline],
    ["highlightKeywords", args.highlightKeywords],
    ["statCards", args.statCards],
  ] as const) {
    if (flag !== undefined && typeof flag !== "boolean") {
      return editToolFailure("invalid_input", `ตั้งค่า ${label} ต้องเป็น true หรือ false`, NEXT_BATCH);
    }
  }

  // 4. Headline hook validation
  if (args.headlineHookEnabled !== undefined && typeof args.headlineHookEnabled !== "boolean") {
    return editToolFailure("invalid_input", "headlineHookEnabled ต้องเป็น true หรือ false", NEXT_BATCH);
  }
  if (args.headlineHookText !== undefined && typeof args.headlineHookText !== "string") {
    return editToolFailure("invalid_input", "headlineHookText ต้องเป็นข้อความ", NEXT_BATCH);
  }
  if (args.headlineHookEnabled === true && args.headlineHookText !== undefined && !args.headlineHookText.trim()) {
    return editToolFailure(
      "invalid_input",
      "headlineHookText ต้องไม่ว่างเมื่อเปิดใช้งานพาดหัว (headlineHookEnabled: true)",
      "ส่งข้อความพาดหัวใน headlineHookText หรือตั้ง headlineHookEnabled: false",
    );
  }
  if (args.headlineHookSubtext !== undefined && typeof args.headlineHookSubtext !== "string") {
    return editToolFailure("invalid_input", "headlineHookSubtext ต้องเป็นข้อความ", NEXT_BATCH);
  }
  if (
    args.headlineHookPreset !== undefined
    && !(HEADLINE_HOOK_PRESETS as readonly string[]).includes(args.headlineHookPreset)
  ) {
    return editToolFailure("invalid_input", "headlineHookPreset ไม่ถูกต้อง", NEXT_BATCH);
  }
  if (
    args.headlineHookDurationMs !== undefined
    && (
      typeof args.headlineHookDurationMs !== "number"
      || !Number.isInteger(args.headlineHookDurationMs)
      || args.headlineHookDurationMs < MIN_HEADLINE_HOOK_DURATION_MS
      || args.headlineHookDurationMs > MAX_HEADLINE_HOOK_DURATION_MS
    )
  ) {
    return editToolFailure(
      "invalid_input",
      `headlineHookDurationMs ต้องเป็นจำนวนเต็มระหว่าง ${MIN_HEADLINE_HOOK_DURATION_MS}-${MAX_HEADLINE_HOOK_DURATION_MS} ms`,
      NEXT_BATCH,
    );
  }

  // 5. Background music & tailHoldMs validation
  if (args.disableBgm !== undefined && typeof args.disableBgm !== "boolean") {
    return editToolFailure("invalid_input", "disableBgm ต้องเป็น true หรือ false", NEXT_BATCH);
  }
  if (args.bgmDucking !== undefined && typeof args.bgmDucking !== "boolean") {
    return editToolFailure("invalid_input", "bgmDucking ต้องเป็น true หรือ false", NEXT_BATCH);
  }
  if (args.bgmMoodOrTrack !== undefined) {
    if (typeof args.bgmMoodOrTrack !== "string" || !args.bgmMoodOrTrack.trim() || args.bgmMoodOrTrack.length > MAX_TRACK_ID_CHARS) {
      return editToolFailure(
        "invalid_input",
        "bgmMoodOrTrack ต้องเป็นชื่ออารมณ์เพลง, ชื่อเพลง, trackId หรือ \"none\"",
        NEXT_LIST_MUSIC,
      );
    }
  }
  if (args.disableBgm === true && args.bgmMoodOrTrack !== undefined && !isNoneInput(args.bgmMoodOrTrack)) {
    return editToolFailure(
      "invalid_input",
      "ห้ามส่ง disableBgm: true พร้อมกับเลือกเพลงใน bgmMoodOrTrack",
      "ส่งเฉพาะ disableBgm: true เพื่อปิดเพลง หรือส่งเฉพาะ bgmMoodOrTrack เพื่อเลือกเพลง",
    );
  }
  let normalizedBgmVolume: number | undefined;
  if (args.bgmVolume !== undefined) {
    const parsedVolume = normalizeBatchBgmVolume(args.bgmVolume);
    if (parsedVolume === null) {
      return editToolFailure(
        "invalid_input",
        "ความดังเพลง bgmVolume ต้องอยู่ระหว่าง 0-100 (%) หรือทศนิยม 0-1",
        "ส่ง bgmVolume เช่น 12 (ค่าเริ่มต้น 12%)",
      );
    }
    normalizedBgmVolume = parsedVolume;
  }
  if (
    args.tailHoldMs !== undefined
    && (
      typeof args.tailHoldMs !== "number"
      || !Number.isInteger(args.tailHoldMs)
      || args.tailHoldMs < TAIL_HOLD_MS_MIN
      || args.tailHoldMs > TAIL_HOLD_MS_MAX
    )
  ) {
    return editToolFailure(
      "invalid_input",
      `tailHoldMs ต้องเป็นจำนวนเต็มระหว่าง ${TAIL_HOLD_MS_MIN}-${TAIL_HOLD_MS_MAX} ms`,
      NEXT_BATCH,
    );
  }

  // 6. B-roll style validation
  if (args.sfxMode !== undefined && !isSfxMode(args.sfxMode)) return BAD_SFX_MODE;
  if (args.brollTransition !== undefined && !isBrollTransitionEdit(args.brollTransition)) return BAD_TRANSITION;
  if (args.brollFit !== undefined && !isBrollFit(args.brollFit)) return BAD_FIT;
  if (args.punchZoom !== undefined && typeof args.punchZoom !== "boolean") return BAD_PUNCH_ZOOM;

  const windowIdx = args.brollWindowIndex;
  if (windowIdx !== undefined) {
    if (typeof windowIdx !== "number" || !Number.isInteger(windowIdx) || windowIdx < 0) return NO_WINDOW;
    if (args.brollTransition === undefined && args.brollFit === undefined) {
      return editToolFailure(
        "invalid_input",
        "เมื่อระบุ brollWindowIndex ต้องส่ง brollTransition หรือ brollFit อย่างน้อยหนึ่งค่า",
        NEXT_STYLE,
      );
    }
  } else if (
    args.brollFit !== undefined
    || (args.brollTransition !== undefined && !isBrollTransition(args.brollTransition))
  ) {
    return PROJECT_TRANSITION_ONLY;
  }

  // 7. Load Held Preview root, state, and external resources BEFORE mutating draft
  const held = await resolveHeldRoot(user.id, args.jobId);
  if (!held.ok) return held.failure;
  const { root } = held;
  const loaded = await loadState(user.id, root);
  if (!loaded.ok) return loaded.failure;
  const { base } = loaded.state;

  if (windowIdx !== undefined && !previewWindowSpans(base.preview).some((span) => span.index === windowIdx)) {
    return NO_WINDOW;
  }

  const baseRow = await prisma.videoJob.findFirst({
    where: { id: base.id, userId: user.id },
    select: { projectId: true, contentPreflightId: true, projectVisualContextJson: true },
  });
  const canRerenderBroll = Boolean(baseRow && brollWindowEditEnabled(user, baseRow));
  const needsBrollGate =
    windowIdx !== undefined
    || args.motionThemeId !== undefined
    || args.brollTransition !== undefined
    || args.brollFit !== undefined
    || args.punchZoom !== undefined;
  if (needsBrollGate && !canRerenderBroll) return WINDOW_EDIT_NOT_ENABLED;

  if (
    (args.templateId !== undefined || needsBrollGate || args.sfxMode !== undefined)
    && await linkedRerenderInFlight(user.id, root, loaded.state.projectId)
  ) {
    return STYLE_DURING_RERENDER;
  }

  // Pre-resolve template music and/or explicit BGM track before entering CAS
  const pack = args.templateId !== undefined ? stylePack(args.templateId) : null;
  let matchedTemplateMusicTrack: string | null = null;
  let explicitPickedTrack: string | null | undefined;

  if (args.disableBgm === true || (args.bgmMoodOrTrack !== undefined && isNoneInput(args.bgmMoodOrTrack))) {
    explicitPickedTrack = null;
  } else if (args.bgmMoodOrTrack !== undefined) {
    const query = args.bgmMoodOrTrack.trim();
    const byId = await findBackgroundMusicTrackById(user.id, query);
    if (byId) {
      explicitPickedTrack = byId.track;
    } else {
      const tracks = await listBackgroundMusicTracks(user.id);
      const bgmCatalog = tracks.map((t) => ({ title: t.title, bgmFile: t.track, mood: t.mood }));
      const lower = query.toLowerCase();
      let matchedPath: string | null = null;
      if ((MUSIC_MOODS as readonly string[]).includes(lower)) {
        const byStyleMood = resolveMusicMoodTrack(lower as MusicMood, bgmCatalog);
        if (byStyleMood && tracks.some((t) => t.track === byStyleMood.bgmFile)) {
          matchedPath = byStyleMood.bgmFile;
        }
      }
      if (!matchedPath) {
        const resolved = resolveBgm(query, bgmCatalog);
        if (resolved.kind === "resolved" && tracks.some((t) => t.track === resolved.bgmFile)) {
          matchedPath = resolved.bgmFile;
        }
      }
      if (!matchedPath) {
        return editToolFailure(
          "invalid_input",
          `ไม่พบเพลงหรือแนวเพลง "${query}" ในคลังเพลงของคุณ`,
          `ระบุแนวเพลง (${moodMenu()}) หรือเรียก set_background_music(jobId) อย่างเดียวเพื่อดู trackId ที่มี`,
        );
      }
      explicitPickedTrack = matchedPath;
    }
  } else if (pack && args.includeTemplateMusic === true) {
    const tracks = await listBackgroundMusicTracks(user.id);
    const resolved = resolveMusicMoodTrack(
      pack.musicMood,
      tracks.map((t) => ({ title: t.title, bgmFile: t.track, mood: t.mood })),
    );
    const matched = resolved ? tracks.find((t) => t.track === resolved.bgmFile) ?? null : null;
    if (matched) matchedTemplateMusicTrack = matched.track;
  }

  // 8. Atomic CAS mutation on a deep clone — if ANY step fails, return { ok: false } and nothing is saved!
  const refused: { failure: EditToolFailure | null } = { failure: null };
  let appliedOps: string[] = [];
  let ignoredFields: string[] = [];
  let motionWindowsPlanned = 0;

  const updated = await updatePendingEditDraft(user.id, root, (draft, state) => {
    const nextDraft: PendingEditDraft = structuredClone(draft);
    const ops: string[] = [];
    const localIgnored: string[] = [];
    const baseConfig = state.base.preview.config as {
      brollTransition?: unknown;
      punchZoom?: unknown;
      sfxMode?: unknown;
    };

    // (a) Template base recipe
    if (pack) {
      const totalDurationMs = draftDurationMs(state.base.preview, nextDraft.captions);
      const sourceText = nextDraft.fullText?.trim()
        || nextDraft.captions.map((c) => c.text).join(" ").trim();
      const resolved = resolveTemplatePostEdit({
        templateId: pack.id as Parameters<typeof resolveTemplatePostEdit>[0]["templateId"],
        currentHeadlineHook: nextDraft.headlineHook ?? null,
        headlineSourceText: sourceText,
        totalDurationMs,
      });
      const canonicalFont = canonicalizeFontFamily(resolved.subtitleConfig.fontFamily) ?? resolved.subtitleConfig.fontFamily;
      nextDraft.subtitleConfig = {
        ...(resolved.subtitleConfig as V2SubConfig),
        fontFamily: canonicalFont,
      };
      if (nextDraft.cardLen !== resolved.cardLen) {
        nextDraft.captions = regroupCaptions(
          nextDraft.originalCaptions,
          resolved.cardLen,
          nextDraft.words,
          nextDraft.fullText,
          nextDraft.subtitleConfig.fontSize,
        );
        nextDraft.cardLen = resolved.cardLen;
        nextDraft.captionOverrides = {};
      }
      if (resolved.headlineHook) {
        nextDraft.headlineHook = resolved.headlineHook;
      }
      if (pack.sfxMode === effectiveSfxMode(baseConfig.sfxMode)) delete nextDraft.sfxMode;
      else nextDraft.sfxMode = pack.sfxMode;

      if (canRerenderBroll) {
        if (pack.brollTransition === effectiveBrollTransition(undefined, baseConfig.brollTransition)) {
          delete nextDraft.brollTransition;
        } else {
          nextDraft.brollTransition = pack.brollTransition;
        }
        if (pack.punchZoom === effectivePunchZoom(baseConfig.punchZoom)) {
          delete nextDraft.punchZoom;
        } else {
          nextDraft.punchZoom = pack.punchZoom;
        }
        nextDraft.windowEdits = nextDraft.windowEdits.flatMap((edit) => {
          const baseWindow = bgVideoAt(state.base.preview.config, edit.index);
          const baseHasOwnTransition = isBrollTransition(baseWindow?.transition);
          const nextEdit: PendingEditWindowEdit = { ...edit };
          if (baseHasOwnTransition) nextEdit.transition = BROLL_TRANSITION_FOLLOW_DEFAULT;
          else delete nextEdit.transition;
          if (
            nextEdit.replacementKind === STYLE_ONLY_REPLACEMENT_KIND
            && nextEdit.transition === undefined
            && nextEdit.fit === undefined
          ) {
            return [];
          }
          return [nextEdit];
        });
      }
      if (args.includeTemplateMusic === true && matchedTemplateMusicTrack) {
        const currentMusic = effectiveBackgroundMusic(nextDraft, state.base.preview);
        const nextMusic = normalizeBackgroundMusicEdit({
          track: matchedTemplateMusicTrack,
          volume: currentMusic.volume || DEFAULT_BGM_VOLUME,
          ducking: true,
        });
        if (nextMusic) nextDraft.backgroundMusic = nextMusic;
      }
      ops.push(`template:${pack.id}`);
    }

    // (b) Explicit regroupCardLen
    if (args.regroupCardLen !== undefined) {
      const cardLen = args.regroupCardLen as V2CardLen;
      nextDraft.captions = regroupCaptions(
        nextDraft.originalCaptions,
        cardLen,
        nextDraft.words,
        nextDraft.fullText,
        nextDraft.subtitleConfig.fontSize,
      );
      nextDraft.cardLen = cardLen;
      nextDraft.captionOverrides = {};
      ops.push(`regroup:${cardLen}`);
    }

    // (c) Batch caption text updates (validated against post-template/post-regroup captions)
    if (normalizedCaptionUpdates.length > 0) {
      for (const update of normalizedCaptionUpdates) {
        if (update.index >= nextDraft.captions.length) {
          const message = `ไม่มีการ์ดซับลำดับที่ ${update.index} — มีทั้งหมด ${nextDraft.captions.length} การ์ด (index 0 ถึง ${Math.max(0, nextDraft.captions.length - 1)})`;
          refused.failure = editToolFailure("invalid_input", message, "เรียก get_edit_state เพื่อดูลำดับการ์ดซับปัจจุบัน");
          return { ok: false, code: "invalid_input", message };
        }
        nextDraft.captions[update.index] = {
          ...nextDraft.captions[update.index],
          text: update.text,
        };
      }
      ops.push(`captions:${normalizedCaptionUpdates.length}`);
    }

    // (d) Subtitle style overrides
    if (hasSubtitlePatch) {
      const current = nextDraft.subtitleConfig;
      const preset: SubPreset = args.subtitlePreset !== undefined ? args.subtitlePreset : current.preset;
      const effect: SubTextEffect = args.subtitleEffect !== undefined ? args.subtitleEffect : current.effect;
      const fontFamily = args.fontFamily !== undefined
        ? args.fontFamily
        : (canonicalizeFontFamily(current.fontFamily) ?? current.fontFamily);

      let fontWeight = resolveV2FontWeight(current);
      if (args.fontWeight !== undefined) {
        const resolvedWeight = normalizeSubtitleFontWeight(Number(args.fontWeight));
        if (resolvedWeight === null) {
          const message = "fontWeight ต้องเป็น 400, 600 หรือ 900";
          refused.failure = editToolFailure("invalid_input", message, NEXT_BATCH);
          return { ok: false, code: "invalid_input", message };
        }
        fontWeight = resolvedWeight;
      }

      const colorLocked = LOCKED_COLOR_PRESETS.includes(preset);
      const accentLocked = LOCKED_ACCENT_PRESETS.includes(preset);
      let textColor = current.textColor;
      if (args.textColor !== undefined) {
        if (colorLocked) localIgnored.push("textColor");
        else textColor = args.textColor;
      }
      let accentColor = current.accentColor;
      if (args.accentColor !== undefined) {
        if (accentLocked) localIgnored.push("accentColor");
        else accentColor = args.accentColor;
      }

      const normalized = normalizeSubtitleStylePresetConfig({
        preset,
        effect,
        cardLen: nextDraft.cardLen,
        fontFamily,
        bold: fontWeight === 900,
        fontWeight,
        fontSize: args.fontSize !== undefined ? args.fontSize : current.fontSize,
        textColor,
        accentColor,
        shadow: args.shadow !== undefined ? args.shadow : current.shadow,
        outline: args.outline !== undefined ? args.outline : current.outline,
        outlineSize: args.outlineSize !== undefined ? args.outlineSize : current.outlineSize,
        verticalPos: args.verticalPos !== undefined ? args.verticalPos : current.verticalPos,
        highlightKeywords: args.highlightKeywords !== undefined ? args.highlightKeywords : Boolean(current.highlightKeywords),
        statCards: args.statCards !== undefined ? args.statCards : Boolean(current.statCards),
      });
      if (!normalized) {
        const message = "ค่าสไตล์ซับที่ส่งไม่ถูกต้อง — เช็คช่วง fontSize (30-160), outlineSize (1-8), verticalPos (10-95) หรือรูปแบบสี #RRGGBB";
        refused.failure = editToolFailure("invalid_input", message, NEXT_BATCH);
        return { ok: false, code: "invalid_input", message };
      }
      const subtitleConfig = { ...normalized };
      delete (subtitleConfig as { cardLen?: unknown }).cardLen;
      nextDraft.subtitleConfig = subtitleConfig as V2SubConfig;
      ops.push("subtitle_style");
    }

    // (d.2) Whole-clip Motion Theme lock (after subtitle style so Brand CI colors/fonts are up to date)
    if (args.motionThemeId !== undefined && canRerenderBroll) {
      motionWindowsPlanned = applyMotionThemeAcrossDraftWindows(root, nextDraft, state.base.preview, args.motionThemeId, args.motionMascot);
      ops.push(`motion_theme:${args.motionThemeId}(${motionWindowsPlanned})`);
    }

    // (e) Headline hook overrides
    if (hasHeadlinePatch) {
      const totalDurationMs = draftDurationMs(state.base.preview, nextDraft.captions);
      const patch: Record<string, unknown> = {};
      if (args.headlineHookEnabled !== undefined) patch.enabled = args.headlineHookEnabled;
      if (args.headlineHookText !== undefined) {
        patch.headline = args.headlineHookText;
        // When headline text is supplied without an explicit enabled flag and no prior hook was active, enable it by default.
        if (args.headlineHookEnabled === undefined && nextDraft.headlineHook?.enabled === undefined && args.headlineHookText.trim()) {
          patch.enabled = true;
        }
      }
      if (args.headlineHookSubtext !== undefined) patch.subheadline = args.headlineHookSubtext;
      if (args.headlineHookPreset !== undefined) patch.preset = args.headlineHookPreset;
      if (args.headlineHookDurationMs !== undefined) patch.durationMs = args.headlineHookDurationMs;

      const merged = { ...(nextDraft.headlineHook ?? {}), ...patch };
      const normalized = normalizeHeadlineHook(merged, totalDurationMs, nextDraft.subtitleConfig.verticalPos);
      if (!normalized) {
        const message = "ค่าพาดหัวไม่ถูกต้อง";
        refused.failure = editToolFailure("invalid_input", message, NEXT_BATCH);
        return { ok: false, code: "invalid_input", message };
      }
      if (args.headlineHookEnabled === true && !normalized.enabled) {
        const message = "ต้องระบุ headlineHookText ที่มีข้อความเมื่อต้องการเปิดใช้งานพาดหัว (headlineHookEnabled: true)";
        refused.failure = editToolFailure("invalid_input", message, "ส่ง headlineHookText ร่วมกับ headlineHookEnabled: true");
        return { ok: false, code: "invalid_input", message };
      }
      nextDraft.headlineHook = normalized;
      ops.push("headline_hook");
    }

    // (f) Explicit background music overrides
    if (hasExplicitBgmPatch) {
      const current = effectiveBackgroundMusic(nextDraft, state.base.preview);
      const track = explicitPickedTrack === undefined ? current.track : explicitPickedTrack;
      if (track === null && explicitPickedTrack === undefined && (normalizedBgmVolume !== undefined || args.bgmDucking !== undefined)) {
        const message = "คลิปนี้ยังไม่มีเพลงประกอบ จึงปรับความดังหรือ ducking อย่างเดียวไม่ได้ — ระบุ bgmMoodOrTrack เพื่อเลือกเพลงก่อน";
        refused.failure = editToolFailure("invalid_input", message, NEXT_LIST_MUSIC);
        return { ok: false, code: "invalid_input", message };
      }
      const newPick = typeof explicitPickedTrack === "string" && explicitPickedTrack !== current.track;
      const nextMusic = normalizeBackgroundMusicEdit({
        track,
        volume: normalizedBgmVolume === undefined ? current.volume : normalizedBgmVolume,
        ducking: track === null ? false : args.bgmDucking ?? (newPick ? true : current.ducking),
      });
      if (!nextMusic) {
        const message = "เพลงประกอบเดิมของคลิปนี้ปรับไม่ได้ — ระบุ bgmMoodOrTrack เพื่อเลือกเพลงจากคลัง";
        refused.failure = editToolFailure("invalid_input", message, NEXT_LIST_MUSIC);
        return { ok: false, code: "invalid_input", message };
      }
      nextDraft.backgroundMusic = nextMusic;
      ops.push(track === null ? "bgm:off" : "bgm:update");
    }

    // (g) Tail hold
    if (args.tailHoldMs !== undefined) {
      nextDraft.tailHoldMs = clampTailHoldMs(args.tailHoldMs);
      ops.push("tail_hold");
    }

    // (h) B-roll style overrides (project-level and/or per-window)
    if (args.sfxMode !== undefined) {
      if (args.sfxMode === effectiveSfxMode(baseConfig.sfxMode)) delete nextDraft.sfxMode;
      else nextDraft.sfxMode = args.sfxMode;
      ops.push(`sfx:${args.sfxMode}`);
    }
    if (typeof args.punchZoom === "boolean") {
      if (args.punchZoom === effectivePunchZoom(baseConfig.punchZoom)) delete nextDraft.punchZoom;
      else nextDraft.punchZoom = args.punchZoom;
      ops.push(`punch_zoom:${args.punchZoom}`);
    }
    if (windowIdx === undefined) {
      if (args.brollTransition !== undefined && isBrollTransition(args.brollTransition)) {
        if (args.brollTransition === effectiveBrollTransition(undefined, baseConfig.brollTransition)) {
          delete nextDraft.brollTransition;
        } else {
          nextDraft.brollTransition = args.brollTransition;
        }
        ops.push(`broll_transition:${args.brollTransition}`);
      }
    } else {
      if (!previewWindowSpans(state.base.preview).some((span) => span.index === windowIdx)) {
        refused.failure = NO_WINDOW;
        return { ok: false, code: NO_WINDOW.code, message: NO_WINDOW.message };
      }
      const baseWindow = bgVideoAt(state.base.preview.config, windowIdx);
      const previous = nextDraft.windowEdits.find((candidate) => candidate.index === windowIdx);
      const nextWindowEdit: PendingEditWindowEdit = previous
        ? { ...previous }
        : { index: windowIdx, src: null, replacementKind: STYLE_ONLY_REPLACEMENT_KIND };
      if (args.brollTransition !== undefined) {
        const baseOwn = isBrollTransition(baseWindow?.transition)
          ? baseWindow.transition
          : BROLL_TRANSITION_FOLLOW_DEFAULT;
        if (args.brollTransition === baseOwn) delete nextWindowEdit.transition;
        else nextWindowEdit.transition = args.brollTransition;
      }
      if (args.brollFit !== undefined) {
        if (args.brollFit === effectiveBrollFit(baseWindow?.fit)) delete nextWindowEdit.fit;
        else nextWindowEdit.fit = args.brollFit;
      }
      const others = nextDraft.windowEdits.filter((candidate) => candidate.index !== windowIdx);
      const emptyStyleOnly = nextWindowEdit.replacementKind === STYLE_ONLY_REPLACEMENT_KIND
        && nextWindowEdit.transition === undefined
        && nextWindowEdit.fit === undefined;
      nextDraft.windowEdits = emptyStyleOnly ? others : [...others, nextWindowEdit];
      if (nextDraft.windowEdits.length > MAX_DRAFT_WINDOW_EDITS) {
        refused.failure = TOO_MANY_WINDOW_EDITS;
        return { ok: false, code: TOO_MANY_WINDOW_EDITS.code, message: TOO_MANY_WINDOW_EDITS.message };
      }
      ops.push(`broll_window:${windowIdx}`);
    }

    appliedOps = ops;
    ignoredFields = localIgnored;
    return { ok: true, draft: nextDraft };
  });

  if (!updated.ok) {
    return refused.failure ?? mapUpdateFailure(updated.code, updated.message, NEXT_RELOAD);
  }

  const { draft: finalDraft, base: updatedBase } = updated.state;
  const windowEdit = windowIdx === undefined
    ? undefined
    : finalDraft.windowEdits.find((candidate) => candidate.index === windowIdx);

  return {
    ok: true,
    jobId: root.id,
    applied: appliedOps,
    ...(pack ? { templateId: pack.id, thaiLabel: pack.thaiLabel } : {}),
    ...(args.motionThemeId ? { motionThemeId: args.motionThemeId, motionWindowsPlanned } : {}),
    cardLen: finalDraft.cardLen,
    cardCount: finalDraft.captions.length,
    ...(normalizedCaptionUpdates.length > 0
      ? {
          updatedCaptions: normalizedCaptionUpdates.map(({ index }) => {
            const c = finalDraft.captions[index];
            return { index, text: c.text, startMs: c.startMs, endMs: c.endMs };
          }),
        }
      : {}),
    subtitleStyle: subtitleStyleView(finalDraft.subtitleConfig),
    ...(ignoredFields.length > 0
      ? {
          ignoredFields,
          note: `ไม่เปลี่ยน ${ignoredFields.join(", ")} เพราะสไตล์ซับนี้ล็อกสีไว้ (เปลี่ยน subtitlePreset ก่อนถ้าต้องการกำหนดสีเอง)`,
        }
      : {}),
    headlineHook: finalDraft.headlineHook ?? null,
    backgroundMusic: await backgroundMusicView(user.id, finalDraft, updatedBase.preview),
    tailHoldMs: finalDraft.tailHoldMs,
    sfxMode: draftProjectSfxMode(finalDraft, updatedBase),
    brollTransition: draftProjectTransition(finalDraft, updatedBase),
    punchZoom: draftProjectPunchZoom(finalDraft, updatedBase),
    ...(windowIdx !== undefined
      ? { brollWindow: { windowIndex: windowIdx, ...windowStyleView(finalDraft, updatedBase, windowEdit, windowIdx) } }
      : {}),
    pending: draftHasBrollChanges(finalDraft),
    draftRevision: updated.state.revision,
    next: "บันทึกการแก้แบบรวดเดียวในดราฟต์แล้ว (ยังไม่เรนเดอร์) — ตรวจภาพตัวอย่างจุดสำคัญด้วย get_preview_frame(jobId, atMs) หรือเรียก export_video(jobId) เพื่อส่งออกทันที (ไม่ตัดโควต้าเพิ่ม)",
  };
}

// ── export_video ──────────────────────────────────────────────────────────────────────────

const EXPORT_NEXT = "เรียก get_video_status({id: jobId}) ทุก ~60–90 วินาที จนได้ status \"done\" พร้อม videoUrl";

function exportReply(rootJobId: string, exportJob: { id: string; status: string }, draftRevision: number) {
  const done = exportJob.status === "done";
  return {
    jobId: rootJobId,
    exportJobId: exportJob.id,
    status: done ? "done" : "exporting",
    draftRevision,
    message: done
      ? "ส่งออกเวอร์ชันนี้เสร็จแล้ว"
      : "เริ่มส่งออกวิดีโอพร้อมการแก้แล้ว — ไม่ตัดโควต้าเพิ่ม",
    next: EXPORT_NEXT,
  };
}

function exportRowByKey(userId: string, idempotencyKey: string) {
  return prisma.videoJob.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
    select: { id: true, status: true },
  });
}

function notFreeFailure(error: McpRenderNotFreeError): EditToolFailure {
  return editToolFailure(error.code, error.message, error.next);
}

const ENQUEUE_NEXT: Record<string, string> = {
  too_many_jobs: "รอให้งานที่ค้างอยู่เสร็จก่อน (เช็คด้วย get_video_status) แล้วเรียก export_video อีกครั้ง",
  stale_export_source: NEXT_RELOAD,
  invalid_headline_hook: NEXT_EDITOR,
  invalid_background_music: NEXT_LIST_MUSIC,
};

// T13: export with pending B-roll window edits = a free re-render of the current base that
// applies them, then (server-side, rerender-chain.ts) the Burn of that re-render.

const RERENDER_NEXT = "เรียก get_video_status({id: jobId}) ทุก ~60–90 วินาที — status จะเป็น \"rerendering\" → \"exporting\" → \"done\" พร้อม videoUrl (ระบบส่งออกต่อให้เอง ไม่ต้องเรียก export_video ซ้ำ)";
const RENDER_MAINTENANCE = editToolFailure(
  "render_maintenance",
  RENDER_MAINTENANCE_CUSTOMER_MESSAGE,
  "รอสักครู่แล้วเรียก export_video อีกครั้ง",
);
const RERENDER_IN_PROGRESS = editToolFailure(
  "rerender_in_progress",
  "กำลังเรนเดอร์ช่วง B-roll จากการสั่งส่งออกครั้งก่อนอยู่ จึงยังส่งออกการแก้ล่าสุดไม่ได้",
  "เรียก get_video_status ทุก ~60–90 วินาที จนได้ status \"done\" แล้วเรียก export_video อีกครั้งเพื่อส่งออกการแก้ที่เหลือ",
);
const ORIGINAL_DURING_RERENDER = editToolFailure(
  "rerender_in_progress",
  "กำลังเรนเดอร์ช่วง B-roll จากการสั่งส่งออกครั้งก่อนอยู่ จึงยังสั่งให้ช่วงนี้กลับเป็นภาพเดิมไม่ได้ — ยังไม่ได้บันทึกอะไร",
  "เรียก get_video_status ทุก ~60–90 วินาที จน status ไม่ใช่ \"rerendering\" แล้วเรียก replace_broll_window ด้วย source \"original\" อีกครั้ง",
);
const STYLE_DURING_RERENDER = editToolFailure(
  "rerender_in_progress",
  "กำลังเรนเดอร์ช่วง B-roll จากการสั่งส่งออกครั้งก่อนอยู่ จึงยังเปลี่ยนการตัดต่อหรือการจัดภาพของ B-roll ไม่ได้ — ยังไม่ได้บันทึกอะไร",
  "เรียก get_video_status ทุก ~60–90 วินาที จน status ไม่ใช่ \"rerendering\" แล้วเรียก set_broll_style อีกครั้ง",
);
const IMPORT_ERROR_HINT: Record<string, string> = {
  fetch_timeout: "ดาวน์โหลดไม่ทันเวลา หรือคิวนำเข้าไม่ว่างในตอนนั้น — ส่งไฟล์เดิมใหม่ได้",
  import_missing: "ไม่พบไฟล์นำเข้านี้แล้ว",
  storage_busy: "พื้นที่เก็บไฟล์ของระบบเต็มชั่วคราว — รอสักครู่แล้วส่งใหม่",
};

function rerenderReply(rootJobId: string, rerenderJobId: string, draftRevision: number) {
  return {
    jobId: rootJobId,
    rerenderJobId,
    exportJobId: null,
    status: "rerendering",
    draftRevision,
    message: "กำลังเรนเดอร์ช่วง B-roll ที่เปลี่ยนใหม่ (เสียงพากย์เดิม) แล้วจะส่งออกต่อให้เอง — ไม่ตัดโควต้าเพิ่ม",
    next: RERENDER_NEXT,
  };
}

function importFailedFailure(windowIndex: number, importError: string) {
  const hint = IMPORT_ERROR_HINT[importError];
  return {
    ...editToolFailure(
      "import_failed",
      `ไฟล์ของช่วง B-roll windowIndex ${windowIndex} นำเข้าไม่สำเร็จ (${importError})${hint ? ` — ${hint}` : ""}`,
      "ส่งไฟล์ใหม่ให้ช่วงนี้ด้วย replace_broll_window (url อื่น หรือ uploadId ใหม่) หรือ source \"original\" เพื่อใช้ภาพเดิม แล้วเรียก export_video อีกครั้ง",
    ),
    windowIndex,
    importError,
  };
}

function importsPendingFailure(windowIndexes: number[]) {
  return {
    ...editToolFailure(
      "imports_pending",
      `ไฟล์ของช่วง B-roll windowIndex ${windowIndexes.join(", ")} ยังนำเข้าไม่เสร็จ — ยังไม่ได้เรนเดอร์หรือตัดโควต้าอะไร`,
      "เช็ค windows[].importStatus ด้วย get_edit_state เป็นระยะ (ทุก ~30–60 วินาที) จนทุกช่วงเป็น \"ready\" แล้วเรียก export_video อีกครั้ง",
    ),
    windowIndexes,
  };
}

/**
 * The re-render's edits from the draft's window edits, or the refusal. Readiness first (G19):
 * a failed/missing import names its window; any import still pending/processing → imports_pending.
 */
async function rerenderEditsFor(
  userId: string,
  root: McpChainRow,
  state: PendingEditState,
): Promise<{ ok: true; edits: WindowEdit[] } | { ok: false; failure: unknown }> {
  const ids = [...new Set(state.draft.windowEdits.flatMap((edit) => (edit.importId ? [edit.importId] : [])))];
  const rows = ids.length === 0 ? [] : await prisma.mediaImport.findMany({
    where: { id: { in: ids }, userId, purpose: { in: [...BROLL_IMPORT_PURPOSES] } },
    select: { id: true, status: true, errorCode: true, resultSrc: true, durationMs: true, purpose: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = [...state.draft.windowEdits].sort((a, b) => a.index - b.index);
  const pending: number[] = [];
  for (const edit of ordered) {
    if (!edit.importId) continue;
    const row = byId.get(edit.importId);
    if (!row || row.status === "failed") {
      return { ok: false, failure: importFailedFailure(edit.index, row?.errorCode ?? "import_missing") };
    }
    if (row.status !== "ready") pending.push(edit.index);
  }
  if (pending.length > 0) return { ok: false, failure: importsPendingFailure(pending) };

  const media = resolvePendingWindowMedia(rootPreviewOf(root), ordered, byId);
  const invalid = media.find(p => p.status === "failed");
  if (invalid) return { ok: false, failure: importFailedFailure(invalid.index, invalid.error ?? "import_missing") };
  const edits = media.flatMap(p => p.edit ? [p.edit] : []);
  // EP5 #11 / #4: only a new project default transition or presenter punchZoom is pending — the re-render changes no window.
  if (edits.length === 0 && (state.draft.brollTransition !== undefined || state.draft.punchZoom !== undefined)) {
    return { ok: true, edits };
  }
  const validated = validateWindowEdits(edits);
  const merged = "error" in validated
    ? validated
    : mergeWindowEdits(((state.base.preview.config as { bgVideos?: unknown }).bgVideos ?? []) as unknown[], validated);
  if ("error" in merged || "error" in validated) {
    return { ok: false, failure: editToolFailure("invalid_input", "error" in merged ? merged.error : GENERIC_ERROR_COPY, NEXT_WINDOWS) };
  }
  return { ok: true, edits: validated };
}

/** A linked re-render of this root (any revision) still running. */
async function linkedRerenderInFlight(userId: string, root: McpChainRow, projectId: string): Promise<boolean> {
  const running = await prisma.videoJob.findFirst({
    where: {
      userId,
      projectId,
      type: "create",
      status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES] },
      inputJson: { contains: `"mcpRootJobId":"${root.id}"` },
    },
    select: { inputJson: true },
  });
  return parseRecord(running?.inputJson)?.mcpRootJobId === root.id;
}

/**
 * Every refusal of a window-edit export, in order: a linked re-render still running, import
 * readiness (G19), then the free pre-check. Reads only — so a refused export writes nothing (A2).
 */
async function windowExportPreflight(
  user: User,
  root: McpChainRow,
  state: PendingEditState,
): Promise<{ ok: true; edits: WindowEdit[] } | { ok: false; failure: unknown }> {
  if (await linkedRerenderInFlight(user.id, root, state.projectId)) return { ok: false, failure: RERENDER_IN_PROGRESS };
  const built = await rerenderEditsFor(user.id, root, state);
  if (!built.ok) return built;
  try {
    await assertMcpRenderFree({
      userId: user.id,
      baseVideoUrl: state.base.videoUrl,
      rerender: { sourceConfig: state.base.preview.config },
    });
  } catch (error) {
    if (error instanceof McpRenderNotFreeError) return { ok: false, failure: notFreeFailure(error) };
    throw error;
  }
  return built;
}

async function exportWithWindowEdits(user: User, root: McpChainRow, initial: PendingEditState, depth: number): Promise<unknown> {
  let state = initial;
  // The preflight's edits for `state`; reset whenever `state` is reloaded.
  let checked: WindowEdit[] | null = null;
  // Replay: this revision's re-render in flight → "rerendering"; finished → finish its hop
  // (idempotent) and answer from the result; failed/canceled (or no longer leading to an
  // export) → pin the draft forward (CAS) so the retry gets a fresh `mcp-rerender:` key —
  // only after the preflight passed, so a refused export never moves the revision (A2).
  for (let attempt = 0; ; attempt += 1) {
    const existing = await exportRowByKey(user.id, mcpRerenderKey(root.id, state.revision));
    if (!existing) break;
    if (isInFlight(existing.status)) return rerenderReply(root.id, existing.id, state.revision);
    if (existing.status === "done") {
      const hop = await continueMcpRerenderChainSafely({ userId: user.id, rerenderJobId: existing.id });
      if (hop?.kind === "enqueued" || hop?.kind === "exists" || hop?.kind === "refused") {
        return depth >= 1 ? STALE_REVISION : exportVideoTool(user, root.id, depth + 1);
      }
      if (!hop || (hop.kind === "deferred" && hop.reason === "busy")) return RENDER_MAINTENANCE;
      if (hop.kind === "deferred") return STALE_REVISION;
    }
    if (attempt >= 2) return STALE_REVISION;
    if (!checked) {
      const preflight = await windowExportPreflight(user, root, state);
      if (!preflight.ok) return preflight.failure;
      checked = preflight.edits;
    }
    if (await savePendingEditDraft(user.id, state.projectId, state.revision, state.draft)) {
      // Same draft and base, one revision on: the preflight still holds.
      state = { ...state, revision: state.revision + 1, stored: true };
    } else {
      const reloaded = await loadState(user.id, root);
      if (!reloaded.ok) return reloaded.failure;
      state = reloaded.state;
      checked = null;
      if (!draftHasBrollChanges(state.draft)) {
        return depth >= 1 ? STALE_REVISION : exportVideoTool(user, root.id, depth + 1);
      }
    }
  }
  if (!checked) {
    const preflight = await windowExportPreflight(user, root, state);
    if (!preflight.ok) return preflight.failure;
    checked = preflight.edits;
  }

  const idempotencyKey = mcpRerenderKey(root.id, state.revision);
  let result: Awaited<ReturnType<typeof enqueueBrollRerender>>;
  try {
    result = await enqueueBrollRerender({
      user,
      sourceJobId: state.base.id,
      windowEdits: checked,
      ...(state.draft.brollTransition ? { brollTransition: state.draft.brollTransition } : {}),
      ...(typeof state.draft.punchZoom === "boolean" ? { punchZoom: state.draft.punchZoom } : {}),
      idempotencyKey,
      rootJobId: root.id,
      mcpExportAfter: { appliedDraftWindowEdits: state.draft.windowEdits },
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "P2002") {
      // Lost a race with an identical export_video call: answer with the winner.
      const winner = await exportRowByKey(user.id, idempotencyKey);
      return winner ? rerenderReply(root.id, winner.id, state.revision) : STALE_REVISION;
    }
    if (error instanceof RenderDeployDrainError || code === "render_deploy_drain") return RENDER_MAINTENANCE;
    throw error;
  }
  if (!result.ok) {
    if (result.error === "not_enabled") return WINDOW_EDIT_NOT_ENABLED;
    if (result.error === "invalid_edits") {
      return editToolFailure("invalid_input", result.message ?? GENERIC_ERROR_COPY, NEXT_WINDOWS);
    }
    return editToolFailure(
      result.error,
      result.message ?? REFUSAL_COPY[result.error] ?? GENERIC_ERROR_COPY,
      ENQUEUE_NEXT[result.error] ?? NEXT_RELOAD,
    );
  }
  return rerenderReply(root.id, result.job.id, state.revision);
}

/**
 * G4/G7/G9: export the draft at its current revision as a free Burn of the project's current
 * `activeJobId`. Order: resolve → free pre-check (before any write) → replay or advance past a
 * failed attempt → `enqueueEditorExport` (the web's own enqueue, in-flight cap included).
 * T13: with pending B-roll window edits it first re-renders them (exportWithWindowEdits).
 */
export async function exportVideoTool(
  user: User,
  jobId: unknown,
  depth = 0,
  opts?: { dualTikTokExport?: boolean },
): Promise<unknown> {
  if (invalidJobId(jobId)) return UNKNOWN_JOB;
  if (opts?.dualTikTokExport !== undefined && typeof opts.dualTikTokExport !== "boolean") {
    return editToolFailure("invalid_input", "dualTikTokExport ต้องเป็น true หรือ false", "ส่ง dualTikTokExport เป็น boolean หรือเว้นว่างไว้");
  }
  const held = await resolveHeldRoot(user.id, jobId as string);
  if (!held.ok) return held.failure;
  const { root } = held;
  const loaded = await loadState(user.id, root);
  if (!loaded.ok) return loaded.failure;
  let state: PendingEditState = loaded.state;
  const externalRefusal = await validateExternalMediaExport({ userId: user.id, sourceJobId: state.base.id, draft: state.draft, allowPending: true });
  if (externalRefusal) return externalRefusal;
  if (draftHasBrollChanges(state.draft)) return exportWithWindowEdits(user, root, state, depth);

  let checkedBaseUrl: string | null = null;
  const assertFree = async (): Promise<EditToolFailure | null> => {
    if (checkedBaseUrl === state.base.videoUrl) return null;
    try {
      await assertMcpRenderFree({ userId: user.id, baseVideoUrl: state.base.videoUrl });
    } catch (error) {
      if (error instanceof McpRenderNotFreeError) return notFreeFailure(error);
      throw error;
    }
    checkedBaseUrl = state.base.videoUrl;
    return null;
  };
  const notFree = await assertFree();
  if (notFree) return notFree;

  // A revision whose export is in flight or done replays it; one whose export failed or was
  // canceled is pinned forward (CAS) so the retry gets a fresh `mcp-export:` key.
  for (let attempt = 0; ; attempt += 1) {
    const existing = await exportRowByKey(user.id, mcpExportKey(root.id, state.revision));
    if (!existing) break;
    if (existing.status !== "failed" && existing.status !== "canceled") {
      return exportReply(root.id, existing, state.revision);
    }
    if (attempt >= 2) return STALE_REVISION;
    if (await savePendingEditDraft(user.id, state.projectId, state.revision, state.draft)) {
      state = { ...state, revision: state.revision + 1, stored: true };
    } else {
      const reloaded = await loadState(user.id, root);
      if (!reloaded.ok) return reloaded.failure;
      state = reloaded.state;
      const changed = await assertFree();
      if (changed) return changed;
    }
  }

  const idempotencyKey = mcpExportKey(root.id, state.revision);
  const rootInput = (() => {
    try {
      return JSON.parse(root.inputJson) as { script?: unknown };
    } catch {
      return {};
    }
  })();
  const script = (state.base.preview.fullText?.trim()
    || (typeof rootInput.script === "string" ? rootInput.script.trim() : "")).slice(0, 20_000);

  let result: Awaited<ReturnType<typeof enqueueEditorExport>>;
  try {
    const burnConfig = toBurnConfig(state.draft, state.base);
    result = await enqueueEditorExport({
      user,
      brandVisualAccess: await resolveBrandVisualAccess(user),
      sourceJobId: state.base.id,
      subtitleOverlayConfig: opts?.dualTikTokExport !== undefined
        ? { ...burnConfig, dualTikTokExport: opts.dualTikTokExport }
        : burnConfig,
      editorSnapshot: toEditorSnapshotDraft(state.draft),
      idempotencyKey,
      ...(script ? { exportScript: script } : {}),
      exportSceneCount: state.draft.captions.length,
      rootJobId: root.id,
      pendingEditRevision: state.revision,
      ...(state.draft.backgroundMusic ? { backgroundMusic: state.draft.backgroundMusic } : {}),
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "P2002") {
      // Lost a race with an identical export_video call: answer with the winner.
      const winner = await exportRowByKey(user.id, idempotencyKey);
      return winner ? exportReply(root.id, winner, state.revision) : STALE_REVISION;
    }
    if (code === "project_not_found") return LOAD_FAILURE.project_not_found;
    if (code === "stale_export_source") {
      return editToolFailure("stale_export_source", REFUSAL_COPY.stale_export_source, NEXT_RELOAD);
    }
    if (error instanceof RenderDeployDrainError || code === "render_deploy_drain") {
      return editToolFailure("render_maintenance", RENDER_MAINTENANCE_CUSTOMER_MESSAGE, "รอสักครู่แล้วเรียก export_video อีกครั้ง");
    }
    throw error;
  }
  if (!result.ok) {
    return editToolFailure(
      result.error,
      result.message ?? REFUSAL_COPY[result.error] ?? GENERIC_ERROR_COPY,
      ENQUEUE_NEXT[result.error] ?? NEXT_EDITOR,
    );
  }
  return exportReply(root.id, result.job, state.revision);
}

// ── registration ──────────────────────────────────────────────────────────────────────────

type ToolReply = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
};

/** route.ts's `runTool` (plan guard + audit); `opts.next` makes its own refusals G14 envelopes. */
export type EditToolRunner = (
  toolName: string,
  extra: { authInfo?: AuthInfo },
  fn: (p: { userId: string; user: User }) => Promise<unknown>,
  args: unknown,
  opts: { next: string },
) => Promise<ToolReply>;

const GATE_NEXT = "ใช้ create_video_job / get_video_status ตามปกติ (วิดีโอจะส่งออกอัตโนมัติ)";
const RUN_NEXT = "ลองเรียกเครื่องมือนี้อีกครั้ง หรือเรียก get_video_status เพื่อดูสถานะ";

/** Registers the T6 edit tools for this request's principal (beta-gated, G1). */
export function registerEditTools(server: McpServer, principal: GatingPrincipal, runTool: EditToolRunner): void {
  registerGatedTool(
    server,
    principal,
    "get_edit_state",
    {
      title: "Get edit state",
      description: "อ่านดราฟต์การแก้ของวิดีโอที่สร้างด้วย exportMode \"hold\": การ์ดซับ (index/ข้อความ/เวลา), สไตล์ซับ, พาดหัว, เพลงประกอบ, ช่วง B-roll, draftRevision และค่าที่อนุญาต. หลัง export_video ดราฟต์ยังเก็บพาดหัวและภาพ B-roll ที่เปลี่ยนไว้ — windows[].replaced = ช่วงที่เปลี่ยนภาพแล้ว (ไม่ต้องสั่งซ้ำ), windows[].pending = ช่วงที่จะเรนเดอร์ตอน export_video ครั้งถัดไป, windows[].transition/fit = ตอนจบ (dissolve/cut) และการจัดภาพ (cover/contain) ของช่วงนั้น, brollTransition = ค่าหลักของทั้งคลิป. ไม่แก้อะไร ไม่เสียโควต้า. windows[].renderedStartMs/renderedEndMs คือช่วงที่เรนเดอร์จะใช้จริง (ถ้าคลิปสั้นกว่าช่วงของมัน ระบบจะดึงช่วงถัดไปมาเติมแทน) ใช้ค่านี้ตัดสินใจเรื่องเวลา ส่วน startMs/endMs ดิบคือช่วงที่ตั้งไว้ (เป้าหมาย ไม่ใช่ผลจริงเสมอไป).",
      inputSchema: getEditStateInputShape,
    },
    async (args, extra) =>
      runTool("get_edit_state", extra, (p) => getEditStateTool(p.userId, args.jobId), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
  registerGatedTool(
    server,
    principal,
    "set_caption_text",
    {
      title: "Set caption text",
      description: "เปลี่ยนข้อความของการ์ดซับ 1 การ์ด (เวลาเดิม) ในดราฟต์ของวิดีโอ exportMode \"hold\". ยังไม่เรนเดอร์ — เรียก export_video เมื่อแก้ครบ.",
      inputSchema: setCaptionTextInputShape,
    },
    async (args, extra) =>
      runTool("set_caption_text", extra, (p) => setCaptionTextTool(p.userId, args), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
  registerGatedTool(
    server,
    principal,
    "merge_captions",
    {
      title: "Merge captions",
      description: "รวมการ์ดซับลำดับ index เข้ากับการ์ดถัดไปเป็นใบเดียว (ช่วงเวลารวมกัน) ในดราฟต์ของวิดีโอ exportMode \"hold\". ยังไม่เรนเดอร์ — เรียก export_video เมื่อแก้ครบ.",
      inputSchema: mergeCaptionsInputShape,
    },
    async (args, extra) =>
      runTool("merge_captions", extra, (p) => mergeCaptionsTool(p.userId, args), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
  registerGatedTool(
    server,
    principal,
    "split_caption",
    {
      title: "Split caption",
      description: "แยกการ์ดซับลำดับ index ออกเป็น 2 ใบ โดยตัดที่ leftText (ต้องเป็นข้อความต้นของการ์ดนี้พอดี) — เวลาตัดตามสัดส่วนตัวอักษร. ยังไม่เรนเดอร์ — เรียก export_video เมื่อแก้ครบ.",
      inputSchema: splitCaptionInputShape,
    },
    async (args, extra) =>
      runTool("split_caption", extra, (p) => splitCaptionTool(p.userId, args), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
  registerGatedTool(
    server,
    principal,
    "regroup_captions",
    {
      title: "Regroup captions",
      description: "จัดกลุ่มการ์ดซับใหม่ทั้งคลิปจากต้นฉบับเดิมตาม cardLen (ทิ้งการรวม/แยกการ์ดที่ทำไว้ก่อนหน้า). ยังไม่เรนเดอร์ — เรียก export_video เมื่อแก้ครบ.",
      inputSchema: regroupCaptionsInputShape,
    },
    async (args, extra) =>
      runTool("regroup_captions", extra, (p) => regroupCaptionsTool(p.userId, args), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
  registerGatedTool(
    server,
    principal,
    "set_subtitle_style",
    {
      title: "Set subtitle style",
      description: "ปรับสไตล์ซับทั้งคลิป (ฟอนต์/ขนาด/น้ำหนัก/สี/preset/เอฟเฟกต์/เงา/เส้นขอบ/ตำแหน่งแนวตั้ง) ส่งเฉพาะฟิลด์ที่จะเปลี่ยน ฟิลด์ที่เว้นว่างคงค่าเดิม. บาง preset ล็อกสีไว้ (ระบบจะแจ้งถ้าค่าสีที่ส่งไม่มีผล). ยังไม่เรนเดอร์ — เรียก export_video เมื่อแก้ครบ.",
      inputSchema: setSubtitleStyleInputShape,
    },
    async (args, extra) =>
      runTool("set_subtitle_style", extra, (p) => setSubtitleStyleTool(p.userId, args), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
  registerGatedTool(
    server,
    principal,
    "set_headline_hook",
    {
      title: "Set headline hook",
      description: "ตั้ง/ปรับพาดหัว (headline hook) ที่ค้างอยู่บนวิดีโอช่วงต้น ส่งเฉพาะฟิลด์ที่จะเปลี่ยน ฟิลด์ที่เว้นว่างคงค่าเดิม — ต้องส่ง enabled:true ด้วยถ้าต้องการให้พาดหัวแสดงจริง. ยังไม่เรนเดอร์ — เรียก export_video เมื่อแก้ครบ.",
      inputSchema: setHeadlineHookInputShape,
    },
    async (args, extra) =>
      runTool("set_headline_hook", extra, (p) => setHeadlineHookTool(p.userId, args), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
  registerGatedTool(
    server,
    principal,
    "set_background_music",
    {
      title: "Set background music",
      description: "เปลี่ยนเพลงประกอบ (BGM) และความดังของวิดีโอ exportMode \"hold\" หลังสร้างแล้ว โดยไม่ต้องสร้างใหม่. เรียกด้วย jobId อย่างเดียว = ดูรายการเพลง (tracks) + เพลงปัจจุบัน ไม่แก้อะไร. ส่ง trackId (จาก tracks หรือ \"none\" = ไม่ใส่เพลง) และ/หรือ volume 0-100 เพื่อแก้. เลือกเพลงใหม่ = ระบบลดเสียงเพลงตอนมีเสียงพูดให้อัตโนมัติ (ducking) ปิดได้ด้วย ducking:false. ยังไม่เรนเดอร์ — เรียก export_video เมื่อแก้ครบ (ไม่ตัดโควต้าเพิ่ม).",
      inputSchema: setBackgroundMusicInputShape,
    },
    async (args, extra) =>
      runTool("set_background_music", extra, (p) => setBackgroundMusicTool(p.userId, args), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
  registerGatedTool(
    server,
    principal,
    "set_tail_hold",
    {
      title: "Set tail hold",
      description: "ค้างเฟรมสุดท้ายของวิดีโอไว้กี่ ms หลังเสียงพากย์จบ (ใส่ end card/ชวนแอ็กชัน) — 0-3000, ค่าเริ่มต้น 0 = ไม่ค้าง (เหมือนเดิม). เพลงพื้นหลังเล่นต่อตลอดช่วงที่ค้าง ซับไม่โชว์ในช่วงนี้. ยังไม่เรนเดอร์ — เรียก export_video เมื่อแก้ครบ.",
      inputSchema: setTailHoldInputShape,
    },
    async (args, extra) =>
      runTool("set_tail_hold", extra, (p) => setTailHoldTool(p.userId, args), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
  registerGatedTool(
    server,
    principal,
    "discard_edits",
    {
      title: "Discard edits",
      description: "ล้างการแก้ทั้งหมดในดราฟต์ (การ์ดซับ/สไตล์/พาดหัว/ช่วง B-roll ที่ยังไม่ส่งออก) กลับไปเป็นค่าตั้งต้นของวิดีโอตัวอย่างนี้ — ใช้เมื่อต้องการเริ่มแก้ใหม่.",
      inputSchema: discardEditsInputShape,
    },
    async (args, extra) =>
      runTool("discard_edits", extra, (p) => discardEditsTool(p.userId, args.jobId), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
  registerGatedTool(
    server,
    principal,
    "replace_broll_window",
    {
      title: "Replace B-roll window",
      description: "เปลี่ยนภาพของช่วง B-roll 1 ช่วง (windowIndex จาก get_edit_state.windows — ตำแหน่งในช่วง ไม่ใช่เวลา) ในดราฟต์ของวิดีโอ exportMode \"hold\" — ส่งอย่างใดอย่างหนึ่ง: url (ลิงก์ https สาธารณะของรูป/วิดีโอ ระบบดาวน์โหลดเอง), uploadId (จาก create_upload_url ต้อง PUT ไฟล์เสร็จก่อน) หรือ source \"original\" (คืนภาพเดิม). เสียงในไฟล์ถูกปิดเสมอ (ใช้เสียงพากย์เดิม). ไฟล์นำเข้าแบบเบื้องหลัง — ดูความคืบหน้าที่ get_edit_state.windows[].importStatus. ถ้าไฟล์ที่ส่งสั้นกว่าช่วงนั้น ช่วงถัดไปอาจถูกดึงมาเติมก่อนเวลาของมันเอง — เรียก get_edit_state อีกครั้งแล้วดู windows[].renderedStartMs/renderedEndMs เพื่อดูผลจริงก่อนแก้ช่วงถัดไป. ยังไม่เรนเดอร์ — เรียก export_video เมื่อแก้ครบ (ไม่ตัดโควต้าเพิ่ม).",
      inputSchema: replaceBrollWindowInputShape,
    },
    async (args, extra) =>
      runTool("replace_broll_window", extra, (p) => replaceBrollWindowTool(p.user, args), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
  registerGatedTool(
    server,
    principal,
    "set_broll_style",
    {
      title: "Set B-roll style",
      description: "ตั้งรูปแบบของช่วง B-roll โดยไม่เปลี่ยนภาพ ในดราฟต์ของวิดีโอ exportMode \"hold\": transition = ตอนจบของช่วง (\"dissolve\" ละลายเข้าช่วงถัดไป ค่าเดิม / \"cut\" ตัดชน / \"default\" ตามค่าหลักของคลิป), fit = การจัดภาพ (\"cover\" เต็มจอครอปขอบ ค่าเดิม / \"contain\" เห็นภาพครบ ขอบเป็นภาพเดียวกันแบบเบลอและมืด). ส่ง windowIndex เพื่อตั้งทีละช่วง หรือไม่ส่ง windowIndex แล้วส่ง transition \"dissolve\"/\"cut\" เพื่อตั้งค่าหลักของทั้งคลิป (ช่วงที่ตั้งเองแล้วไม่เปลี่ยน). ค่าที่ตั้งยังอยู่แม้เปลี่ยนภาพด้วย replace_broll_window. ดูค่าปัจจุบันที่ get_edit_state.windows[].transition/fit และ brollTransition. ยังไม่เรนเดอร์ — เรียก export_video เมื่อแก้ครบ (ไม่ตัดโควต้าเพิ่ม).",
      inputSchema: setBrollStyleInputShape,
    },
    async (args, extra) =>
      runTool("set_broll_style", extra, (p) => setBrollStyleTool(p.user, args), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
  registerGatedTool(
    server,
    principal,
    "apply_video_template",
    {
      title: "Apply video template",
      description: "สวมสไตล์เทมเพลตวิดีโอสำเร็จรูป (templateId จาก get_video_options.templates) ทั้งชุดลงบนดราฟต์ของวิดีโอ exportMode \"hold\" ในคำสั่งเดียว: ปรับสไตล์ซับ + ความยาวคำต่อการ์ด + ไฮไลต์คำสำคัญ + การ์ดสถิติ, สไตล์การ์ดพาดหัวเปิดคลิป (คงข้อความพาดหัวเดิมไว้ถ้ามี), เสียงเอฟเฟกต์เปลี่ยนฉาก (sfxMode), การเปลี่ยนฉาก B-roll (brollTransition) + ซูมจังหวะผู้พูด (punchZoom) และเลือกเพลงประกอบตามอารมณ์เทมเพลตเมื่อส่ง includeMusic:true. ยังไม่เรนเดอร์ — เรียก export_video เมื่อแก้ครบ (ไม่ตัดโควต้าเพิ่ม).",
      inputSchema: applyVideoTemplateInputShape,
    },
    async (args, extra) =>
      runTool("apply_video_template", extra, (p) => applyVideoTemplateTool(p.user, args), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
  registerGatedTool(
    server,
    principal,
    "batch_edit_video",
    {
      title: "Batch edit held preview video",
      description: "แก้ไขวิดีโอตัวอย่าง (exportMode \"hold\") หลายรายการพร้อมกันในคำสั่งเดียวแบบอะตอมมิก (หากฟิลด์ใดไม่ถูกต้องจะไม่บันทึกการแก้ใดๆ เลย): สวมเทมเพลต templateId + includeTemplateMusic, จัดกลุ่มคำต่อการ์ด regroupCardLen, แก้ข้อความหลายการ์ดพร้อมกันด้วย captionIndices + captionTexts, ปรับสไตล์ซับ, พาดหัวเปิดคลิป, เพลงประกอบ bgmMoodOrTrack/bgmVolume/disableBgm, ค้างเฟรมท้าย tailHoldMs และสไตล์ B-roll (sfxMode, brollTransition, brollFit, punchZoom). ยังไม่เรนเดอร์ — เรียก get_preview_frame เพื่อเช็คภาพตัวอย่าง หรือ export_video เมื่อพร้อมส่งออก (ไม่ตัดโควต้าเพิ่ม).",
      inputSchema: batchEditVideoInputShape,
    },
    async (args, extra) =>
      runTool("batch_edit_video", extra, (p) => batchEditVideoTool(p.user, args), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
  registerGatedTool(
    server,
    principal,
    "export_video",
    {
      title: "Export video",
      description: "ส่งออกวิดีโอ exportMode \"hold\" พร้อมการแก้ในดราฟต์ (เบิร์นซับบนวิดีโอตัวอย่างที่จ่ายแล้ว ไม่ตัดโควต้าเพิ่ม). ถ้ามีช่วง B-roll ที่เปลี่ยนภาพหรือรูปแบบ (replace_broll_window / set_broll_style) ระบบเรนเดอร์ B-roll ใหม่ก่อน (status \"rerendering\") แล้วส่งออกต่อให้เอง — ไฟล์นำเข้าทุกช่วงต้อง \"ready\" ก่อน. เรียกซ้ำโดยไม่แก้เพิ่ม = ได้งานเดิม. แล้ว poll get_video_status.",
      inputSchema: exportVideoInputShape,
    },
    async (args, extra) =>
      runTool("export_video", extra, (p) => exportVideoTool(p.user, args.jobId, 0, { dualTikTokExport: args.dualTikTokExport }), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
}
