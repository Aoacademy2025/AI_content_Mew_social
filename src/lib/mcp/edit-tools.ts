import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { registerGatedTool, type GatingPrincipal } from "@/lib/mcp/tool-gating";
import { REFUSAL_COPY, resolveMcpChain, type McpChainRow } from "@/lib/mcp/chain-export";
import { mcpExportKey } from "@/lib/mcp/chain-key";
import { getVideoJobStatusTool, mcpEditorUrl } from "@/lib/mcp/tools";
import { VIDEO_JOB_INFLIGHT_STATUSES } from "@/lib/mcp/video-job-status";
import { assertMcpRenderFree, McpRenderNotFreeError } from "@/lib/mcp/render-free";
import { enqueueEditorExport } from "@/lib/editor-export-enqueue";
import { resolveBrandVisualAccess } from "@/lib/brand-visual-rollout.server";
import { RenderDeployDrainError, RENDER_MAINTENANCE_CUSTOMER_MESSAGE } from "@/lib/render-deploy-drain";
import { brollWindowSpans } from "@/lib/broll-spans";
import { SUBTITLE_FONT_WEIGHTS } from "@/lib/subtitle-font-weight";
import { GENERIC_ERROR_COPY } from "@/lib/error-copy";
import {
  EFFECTS_DATA,
  FONTS_LIST,
  PRESETS_DATA,
  V2_CARD_LEN_OPTIONS,
  resolveV2FontWeight,
  type V2SubConfig,
} from "@/app/(dashboard)/video-editor/_v2/subtitle-style";
import type { VideoJobPreviewData } from "@/lib/mcp/video-job";
import {
  loadPendingEditState,
  savePendingEditDraft,
  toBurnConfig,
  toEditorSnapshotDraft,
  updatePendingEditDraft,
  type PendingEditDraft,
  type PendingEditState,
} from "@/lib/mcp/pending-edit-draft";

/**
 * T6 (ADR 0064): the tracer-bullet MCP edit tools — `get_edit_state`, `set_caption_text`,
 * `export_video` — over a Held Preview's Pending Edit Draft. Agent-neutral (G13/G14): flat
 * primitive inputs, every refusal `{ error, code, message (Thai), next }`, success replies
 * compact JSON with `next`. Registered per request through `registerGatedTool` (beta gate).
 */

export const MCP_EDIT_TOOL_NAMES = ["get_edit_state", "set_caption_text", "export_video"] as const;

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

// ── get_edit_state ────────────────────────────────────────────────────────────────────────

/** What the agent may set (T7's set_subtitle_style validates against the same lists). */
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
};

function subtitleStyleView(config: V2SubConfig) {
  return {
    preset: config.preset,
    effect: config.effect,
    fontFamily: config.fontFamily,
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

function editWindows(draft: PendingEditDraft, preview: VideoJobPreviewData) {
  const frames = Number((preview.config as { durationInFrames?: unknown }).durationInFrames);
  const durMs = Math.max(preview.audioDurationMs || 0, Number.isFinite(frames) && frames > 0 ? (frames / 30) * 1_000 : 0);
  return brollWindowSpans(preview.config, durMs).map((span) => ({
    index: span.index,
    startMs: span.startMs,
    endMs: span.endMs,
    owner: windowOwner(preview, span.index),
    replaced: draft.windowEdits.some((edit) => edit.index === span.index),
    importStatus: null,
  }));
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
    windows: editWindows(state.draft, state.base.preview),
    draftRevision: state.revision,
    allowed: ALLOWED,
    next: "แก้ข้อความการ์ดด้วย set_caption_text(jobId, index, text) ได้หลายครั้ง แล้วเรียก export_video(jobId) ครั้งเดียวเมื่อแก้ครบ (ส่งออกไม่ตัดโควต้าเพิ่ม)",
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

/**
 * G4/G7/G9: export the draft at its current revision as a free Burn of the project's current
 * `activeJobId`. Order: resolve → free pre-check (before any write) → replay or advance past a
 * failed attempt → `enqueueEditorExport` (the web's own enqueue, in-flight cap included).
 */
export async function exportVideoTool(user: User, jobId: unknown) {
  if (invalidJobId(jobId)) return UNKNOWN_JOB;
  const held = await resolveHeldRoot(user.id, jobId as string);
  if (!held.ok) return held.failure;
  const { root } = held;
  const loaded = await loadState(user.id, root);
  if (!loaded.ok) return loaded.failure;
  let state: PendingEditState = loaded.state;

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
    "export_video",
    {
      title: "Export video",
      description: "ส่งออกวิดีโอ exportMode \"hold\" พร้อมการแก้ในดราฟต์ (เบิร์นซับบนวิดีโอตัวอย่างที่จ่ายแล้ว ไม่ตัดโควต้าเพิ่ม). เรียกซ้ำโดยไม่แก้เพิ่ม = ได้งานส่งออกเดิม. แล้ว poll get_video_status.",
      inputSchema: exportVideoInputShape,
    },
    async (args, extra) =>
      runTool("export_video", extra, (p) => exportVideoTool(p.user, args.jobId), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
}
