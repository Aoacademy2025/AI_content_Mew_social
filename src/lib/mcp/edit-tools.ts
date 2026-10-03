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
import { mergeWindowEdits, validateWindowEdits, type WindowEdit } from "@/lib/broll-rerender";
import { createUrlImport, failMediaImport, findOwnedMediaImport } from "@/lib/media-import/imports";
import { admissionRefusal } from "@/lib/mcp/media-import-copy";
import { continueMcpRerenderChainSafely } from "@/lib/mcp/rerender-chain";
import { resolveBrandVisualAccess } from "@/lib/brand-visual-rollout.server";
import { RenderDeployDrainError, RENDER_MAINTENANCE_CUSTOMER_MESSAGE } from "@/lib/render-deploy-drain";
import { brollWindowSpans } from "@/lib/broll-spans";
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
  HEADLINE_HOOK_FONTS,
  HEADLINE_HOOK_FONT_WEIGHTS,
  HEADLINE_HOOK_PRESETS,
  normalizeHeadlineHook,
  type HeadlineHookConfig,
  type HeadlineHookFontFamily,
  type HeadlineHookFontWeight,
  type HeadlineHookPreset,
} from "@/lib/headline-hook";
import { parseVideoJobOutput, type VideoJobPreviewData } from "@/lib/mcp/video-job";
import {
  discardPendingEditDraft,
  draftDurationMs,
  loadPendingEditState,
  savePendingEditDraft,
  toBurnConfig,
  toEditorSnapshotDraft,
  updatePendingEditDraft,
  type PendingEditDraft,
  type PendingEditState,
  type PendingEditWindowEdit,
} from "@/lib/mcp/pending-edit-draft";

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
  "discard_edits",
  "replace_broll_window",
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
} satisfies z.ZodRawShape;

const HEADLINE_HOOK_FONT_VALUES = HEADLINE_HOOK_FONTS.map((font) => font.value);

export const setHeadlineHookInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
  enabled: z.boolean().optional().describe("เปิด/ปิดพาดหัว (ต้องมี headline ด้วยถึงจะเปิดได้จริง)"),
  headline: z.string().optional().describe("ข้อความพาดหัว (ไม่เกิน 64 ตัวอักษร 2 บรรทัด — ระบบตัดให้เองถ้ายาวเกิน)"),
  subheadline: z.string().optional().describe("ข้อความรอง (ไม่เกิน 90 ตัวอักษร 1 บรรทัด, ส่งว่างเพื่อลบ)"),
  durationMs: z.number().int().describe("ระยะเวลาที่พาดหัวค้างอยู่ (ms)").optional(),
  preset: z.enum(nonEmptyEnum(HEADLINE_HOOK_PRESETS)).optional().describe("สไตล์พาดหัว"),
  topPercent: z.number().int().describe("ตำแหน่งแนวตั้งของพาดหัว 10-42 (% จากขอบบน)").optional(),
  fontFamily: z.enum(nonEmptyEnum(HEADLINE_HOOK_FONT_VALUES)).optional().describe("ฟอนต์พาดหัว"),
  fontSize: z.number().int().describe("ขนาดฟอนต์พาดหัว 52-120 px").optional(),
  fontWeight: z.enum(["400", "600", "900"]).optional().describe("น้ำหนักฟอนต์พาดหัว"),
  subheadlineFontSize: z.number().int().describe("ขนาดฟอนต์ข้อความรอง 32-88 px").optional(),
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
  source: z.enum(["original"]).optional().describe("\"original\" = คืนช่วงนี้กลับเป็นภาพเดิมของวิดีโอตัวอย่าง"),
} satisfies z.ZodRawShape;

export const exportVideoInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
} satisfies z.ZodRawShape;

export type EditToolFailure = { error: string; code: string; message: string; next: string };

export function editToolFailure(code: string, message: string, next: string): EditToolFailure {
  return { error: code, code, message, next };
}

const NEXT_HOLD_CREATE = "สร้างวิดีโอใหม่ด้วย create_video_job โดยส่ง exportMode \"hold\"";
const NEXT_RELOAD = "เรียก get_edit_state เพื่อโหลดดราฟต์ล่าสุด แล้วลองอีกครั้ง";
const NEXT_EDITOR = "เปิดลิงก์ editorUrl (จาก get_video_status) เพื่อแก้หรือส่งออกในหน้าเว็บ";

const UNKNOWN_JOB = editToolFailure("invalid_input", "ไม่พบงานนี้ในบัญชีของคุณ", "ใช้ jobId ที่ได้จาก create_video_job ที่ส่ง exportMode \"hold\"");
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
const NOT_READY = editToolFailure(
  "not_ready",
  "วิดีโอตัวอย่างยังเรนเดอร์ไม่เสร็จ",
  "เรียก get_video_status ทุก ~60–90 วินาที จนได้ status \"held\" แล้วค่อยเรียก get_edit_state",
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

function invalidJobId(jobId: unknown): boolean {
  return typeof jobId !== "string" || !jobId.trim() || jobId.length > MAX_JOB_ID_CHARS;
}

function isInFlight(status: string): boolean {
  return (VIDEO_JOB_INFLIGHT_STATUSES as readonly string[]).includes(status);
}

type HeldRootResult = { ok: true; root: McpChainRow } | { ok: false; failure: EditToolFailure };

/** Owner-scoped: the finished Held Preview root `jobId` is, or belongs to. */
async function resolveHeldRoot(userId: string, jobId: string): Promise<HeldRootResult> {
  const chain = await resolveMcpChain(userId, jobId);
  if (!chain) {
    const own = await prisma.videoJob.findFirst({ where: { id: jobId, userId }, select: { id: true } });
    return { ok: false, failure: own ? NOT_HELD : UNKNOWN_JOB };
  }
  if (chain.kind !== "held") return { ok: false, failure: NOT_HELD };
  if (chain.root.status === "done") return { ok: true, root: chain.root };
  return { ok: false, failure: isInFlight(chain.root.status) ? NOT_READY : ROOT_ENDED };
}

async function loadState(userId: string, root: McpChainRow) {
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
  // headline-hook.ts's own bounds (set_headline_hook, G18).
  headlineHook: {
    headlineMaxChars: 64,
    subheadlineMaxChars: 90,
    durationMs: { min: 3_000, max: 20_000 },
    topPercent: { min: 10, max: 42 },
    presets: [...HEADLINE_HOOK_PRESETS],
    fonts: HEADLINE_HOOK_FONT_VALUES,
    fontWeight: HEADLINE_HOOK_FONT_WEIGHTS.map((weight) => String(weight)),
    fontSize: { min: 52, max: 120 },
    subheadlineFontSize: { min: 32, max: 88 },
  },
};

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
  };
}

/** Exclusive Scene Ownership, read the way the web Post phase reads it (brollWindowVisible). */
function windowOwner(preview: VideoJobPreviewData, index: number): "presenter" | "broll" {
  const bgVideos = (preview.config as { bgVideos?: unknown }).bgVideos;
  const raw = Array.isArray(bgVideos) ? bgVideos[index] as Record<string, unknown> | null : null;
  if (!raw || typeof raw !== "object") return "broll";
  if (typeof raw.brollEnabled === "boolean") return raw.brollEnabled ? "broll" : "presenter";
  if (preview.avatarModel !== "upload-cutaway" || !Array.isArray(preview.cutawayPersonRanges)) return "broll";
  const start = Number(raw.start);
  const end = Number(raw.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "broll";
  const midpoint = start + (end - start) / 2;
  return preview.cutawayPersonRanges.some((range) => midpoint >= range.start && midpoint < range.end)
    ? "presenter"
    : "broll";
}

/** The B-roll windows the agent sees (and may address) on `preview`. */
function previewWindowSpans(preview: VideoJobPreviewData) {
  const frames = Number((preview.config as { durationInFrames?: unknown }).durationInFrames);
  const durMs = Math.max(preview.audioDurationMs || 0, Number.isFinite(frames) && frames > 0 ? (frames / 30) * 1_000 : 0);
  return brollWindowSpans(preview.config, durMs);
}

type ImportView = { status: string; errorCode: string | null };

/** T13: the caller's own Media Imports the draft's window edits point at (owner-scoped). */
async function draftImportViews(userId: string, draft: PendingEditDraft): Promise<Map<string, ImportView>> {
  const ids = [...new Set(draft.windowEdits.flatMap((edit) => (edit.importId ? [edit.importId] : [])))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.mediaImport.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true, status: true, errorCode: true },
  });
  return new Map(rows.map((row) => [row.id, { status: row.status, errorCode: row.errorCode }]));
}

/** A window edit's import as the agent sees it; a vanished row reads as failed. */
function importViewOf(edit: PendingEditWindowEdit | undefined, imports: Map<string, ImportView>): ImportView | null {
  if (!edit?.importId) return null;
  return imports.get(edit.importId) ?? { status: "failed", errorCode: "import_missing" };
}

function editWindows(draft: PendingEditDraft, preview: VideoJobPreviewData, imports: Map<string, ImportView>) {
  return previewWindowSpans(preview).map((span) => {
    const edit = draft.windowEdits.find((candidate) => candidate.index === span.index);
    const view = importViewOf(edit, imports);
    return {
      index: span.index,
      startMs: span.startMs,
      endMs: span.endMs,
      owner: windowOwner(preview, span.index),
      replaced: edit !== undefined,
      importStatus: view?.status ?? null,
      importError: view?.status === "failed" ? view.errorCode ?? "import_failed" : null,
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
  return {
    jobId: held.root.id,
    status: statusFields.status ?? "held",
    previewUrl: statusFields.previewUrl ?? null,
    editorUrl: statusFields.editorUrl ?? (held.root.projectId ? mcpEditorUrl(held.root.projectId) : null),
    captions: captionsView(state.draft),
    cardLen: state.draft.cardLen,
    subtitleStyle: subtitleStyleView(state.draft.subtitleConfig),
    headlineHook: state.draft.headlineHook ?? null,
    windows: editWindows(state.draft, state.base.preview, await draftImportViews(userId, state.draft)),
    draftRevision: state.revision,
    allowed: ALLOWED,
    next: "แก้ได้หลายครั้งด้วย set_caption_text / merge_captions / split_caption / regroup_captions / set_subtitle_style / set_headline_hook / replace_broll_window (หรือ discard_edits เพื่อล้างทั้งหมด) แล้วเรียก export_video(jobId) ครั้งเดียวเมื่อแก้ครบ (ส่งออกไม่ตัดโควต้าเพิ่ม)",
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
    const normalized = normalizeHeadlineHook(merged, totalDurationMs);
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

/** validateWindowEdits' own per-export cap (MAX_EDITS in broll-rerender.ts). */
const MAX_DRAFT_WINDOW_EDITS = 40;
const BROLL_IMPORT_PURPOSES = ["broll_image", "broll_video"] as const;
const NEXT_WINDOWS = "เรียก get_edit_state เพื่อดู windows[].index ที่แก้ได้";
const NEXT_MEDIA = "ส่งลิงก์ https สาธารณะของรูปหรือวิดีโอ (url) หรืออัปโหลดด้วย create_upload_url แล้วส่ง uploadId";

const ONE_SOURCE = editToolFailure(
  "invalid_input",
  "ต้องส่งอย่างใดอย่างหนึ่งเท่านั้น: url หรือ uploadId หรือ source \"original\"",
  `${NEXT_MEDIA} หรือ source "original" เพื่อคืนภาพเดิม (อย่างใดอย่างหนึ่ง)`,
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

/** Window 0 of an auto-layout Cutaway Mode clip is the presenter's opening hook. */
function presenterHookLocked(root: McpChainRow, preview: VideoJobPreviewData): boolean {
  if (preview.avatarModel !== "upload-cutaway") return false;
  return parseRecord(root.inputJson)?.cutawayLayout !== "fillYourself";
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
  if (windowOwner(rootPreview, index) === "broll" && (!rootSrc || "error" in validateWindowEdits([{ index, src: rootSrc }]))) {
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
  if (!previewWindowSpans(base.preview).some((span) => span.index === index)) return NO_WINDOW;
  const baseRow = await prisma.videoJob.findFirst({
    where: { id: base.id, userId: user.id },
    select: { projectId: true, contentPreflightId: true, projectVisualContextJson: true },
  });
  if (!baseRow || !brollWindowEditEnabled(user, baseRow)) return WINDOW_EDIT_NOT_ENABLED;
  if (index === 0 && presenterHookLocked(root, base.preview)) return WINDOW_LOCKED;

  let source: "url" | "upload" | "original";
  let importId: string | null = null;
  let importStatus: string | null = null;
  if (args.uploadId !== undefined) {
    const owned = await findOwnedMediaImport(user.id, args.uploadId, BROLL_IMPORT_PURPOSES);
    if (!owned.ok) return owned.failure;
    if (owned.row.status === "failed") return ATTACH_IMPORT_FAILED;
    source = "upload";
    importId = owned.row.id;
    importStatus = owned.row.status;
  } else if (url !== null) {
    const created = await createUrlImport(user.id, url);
    if (!created.ok) return admissionRefusal(created.code, "replace_broll_window");
    source = "url";
    importId = created.importId;
    importStatus = "pending";
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
    } else {
      const original = originalWindowEdit(root, state.base, index);
      if (!original.ok) {
        refused.failure = original.failure;
        return { ok: false, code: original.failure.code, message: original.failure.message };
      }
      edit = original.edit;
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
    importStatus,
    draftRevision: updated.state.revision,
    next: source === "original"
      ? "ช่วงนี้จะกลับเป็นภาพเดิมตอนส่งออก — แก้ต่อได้ หรือเรียก export_video(jobId) เมื่อแก้ครบ"
      : importStatus === "ready"
        ? "ไฟล์พร้อมแล้ว (เสียงในไฟล์จะถูกปิด ใช้เสียงพากย์เดิม) — แก้ต่อได้ หรือเรียก export_video(jobId) เมื่อแก้ครบ"
        : "ไฟล์กำลังนำเข้า (เสียงในไฟล์จะถูกปิด ใช้เสียงพากย์เดิม) — แก้ส่วนอื่นต่อได้ระหว่างนี้; เช็ค windows[].importStatus ด้วย get_edit_state เป็นระยะจนเป็น \"ready\" แล้วเรียก export_video(jobId)",
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
const IMPORT_ERROR_HINT: Record<string, string> = {
  fetch_timeout: "ดาวน์โหลดไม่ทันเวลา หรือคิวนำเข้าไม่ว่างในตอนนั้น — ส่งไฟล์เดิมใหม่ได้",
  import_missing: "ไม่พบไฟล์นำเข้านี้แล้ว",
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
    select: { id: true, status: true, errorCode: true, resultSrc: true, durationMs: true },
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

  const rootPreview = rootPreviewOf(root);
  const edits: WindowEdit[] = [];
  for (const edit of ordered) {
    const row = edit.importId ? byId.get(edit.importId) : undefined;
    if (row) {
      const seconds = typeof row.durationMs === "number" && row.durationMs > 0 ? row.durationMs / 1_000 : null;
      edits.push({
        index: edit.index,
        src: row.resultSrc ?? "",
        enabled: true,
        replacementKind: "upload",
        ...(seconds ? { clipDuration: seconds } : {}),
      });
      continue;
    }
    if (edit.replacementKind !== "original" || !rootPreview || !bgVideoAt(rootPreview.config, edit.index)) {
      return { ok: false, failure: ORIGINAL_UNAVAILABLE };
    }
    if (windowOwner(rootPreview, edit.index) === "presenter") {
      edits.push({ index: edit.index, enabled: false });
      continue;
    }
    const clipDuration = Number(bgVideoAt(rootPreview.config, edit.index)?.clipDuration);
    edits.push({
      index: edit.index,
      src: edit.src ?? "",
      enabled: true,
      ...(Number.isFinite(clipDuration) && clipDuration > 0 ? { clipDuration } : {}),
    });
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
      if (state.draft.windowEdits.length === 0) {
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
export async function exportVideoTool(user: User, jobId: unknown, depth = 0): Promise<unknown> {
  if (invalidJobId(jobId)) return UNKNOWN_JOB;
  const held = await resolveHeldRoot(user.id, jobId as string);
  if (!held.ok) return held.failure;
  const { root } = held;
  const loaded = await loadState(user.id, root);
  if (!loaded.ok) return loaded.failure;
  let state: PendingEditState = loaded.state;
  if (state.draft.windowEdits.length > 0) return exportWithWindowEdits(user, root, state, depth);

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
    result = await enqueueEditorExport({
      user,
      brandVisualAccess: await resolveBrandVisualAccess(user),
      sourceJobId: state.base.id,
      subtitleOverlayConfig: toBurnConfig(state.draft, state.base),
      editorSnapshot: toEditorSnapshotDraft(state.draft),
      idempotencyKey,
      ...(script ? { exportScript: script } : {}),
      exportSceneCount: state.draft.captions.length,
      rootJobId: root.id,
      pendingEditRevision: state.revision,
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

type ToolReply = { content: Array<{ type: "text"; text: string }> };

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
      description: "อ่านดราฟต์การแก้ของวิดีโอที่สร้างด้วย exportMode \"hold\": การ์ดซับ (index/ข้อความ/เวลา), สไตล์ซับ, พาดหัว, ช่วง B-roll, draftRevision และค่าที่อนุญาต. ไม่แก้อะไร ไม่เสียโควต้า.",
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
      description: "เปลี่ยนภาพของช่วง B-roll 1 ช่วง (windowIndex จาก get_edit_state.windows) ในดราฟต์ของวิดีโอ exportMode \"hold\" — ส่งอย่างใดอย่างหนึ่ง: url (ลิงก์ https สาธารณะของรูป/วิดีโอ ระบบดาวน์โหลดเอง), uploadId (จาก create_upload_url ต้อง PUT ไฟล์เสร็จก่อน) หรือ source \"original\" (คืนภาพเดิม). เสียงในไฟล์ถูกปิดเสมอ (ใช้เสียงพากย์เดิม). ไฟล์นำเข้าแบบเบื้องหลัง — ดูความคืบหน้าที่ get_edit_state.windows[].importStatus. ยังไม่เรนเดอร์ — เรียก export_video เมื่อแก้ครบ (ไม่ตัดโควต้าเพิ่ม).",
      inputSchema: replaceBrollWindowInputShape,
    },
    async (args, extra) =>
      runTool("replace_broll_window", extra, (p) => replaceBrollWindowTool(p.user, args), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
  registerGatedTool(
    server,
    principal,
    "export_video",
    {
      title: "Export video",
      description: "ส่งออกวิดีโอ exportMode \"hold\" พร้อมการแก้ในดราฟต์ (เบิร์นซับบนวิดีโอตัวอย่างที่จ่ายแล้ว ไม่ตัดโควต้าเพิ่ม). ถ้ามีช่วง B-roll ที่เปลี่ยน ระบบเรนเดอร์ช่วงเหล่านั้นใหม่ก่อน (status \"rerendering\") แล้วส่งออกต่อให้เอง — ไฟล์นำเข้าทุกช่วงต้อง \"ready\" ก่อน. เรียกซ้ำโดยไม่แก้เพิ่ม = ได้งานเดิม. แล้ว poll get_video_status.",
      inputSchema: exportVideoInputShape,
    },
    async (args, extra) =>
      runTool("export_video", extra, (p) => exportVideoTool(p.user, args.jobId), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
}
