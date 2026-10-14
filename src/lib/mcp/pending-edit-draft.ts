import type { Prisma } from "@prisma/client";
import { externalWindowStates, type ExternalWindowState } from "@/lib/external-media";
import { ownedDraftImports, validateExternalMediaExport } from "@/lib/external-media.server";
import { resolvePendingWindowMedia, type PendingWindowMedia } from "@/lib/pending-broll-media";
import { MAX_BROLL_WINDOW_EDITS, mergeWindowEdits, type WindowEdit } from "@/lib/broll-rerender";
import { prisma } from "@/lib/prisma";
import { withTransientSqliteRetry } from "@/lib/sqlite-retry";
import { parseVideoJobOutput, type VideoJobPreviewData } from "@/lib/mcp/video-job";
import {
  normalizeEditorExportDraft,
  parseEditorExportSnapshot,
  type EditorExportDraft,
  type EditorExportSnapshot,
} from "@/lib/editor-export-snapshot";
import {
  buildV2BurnConfig,
  type V2CardLen,
  type V2CardOverrides,
  type V2Caption,
  type V2SubConfig,
} from "@/app/(dashboard)/video-editor/_v2/subtitle-style";
import {
  resolvedMcpSubtitleDesignFromInput,
  type ResolvedMcpSubtitleJobInput,
} from "@/lib/mcp/orchestrator-steps";
import {
  normalizeHeadlineHook,
  resolveInitialHeadlineHookFromJobInput,
  type HeadlineHookConfig,
} from "@/lib/headline-hook";
import { normalizeLogoOverlayConfig, type LogoOverlayConfig } from "@/lib/logo-overlay";
import { normalizeBackgroundMusicEdit, type BackgroundMusicEdit } from "@/lib/background-music";
import { MAX_EDITOR_PROJECT_DRAFT_BYTES, MAX_EDITOR_PROJECT_DRAFT_REVISION } from "@/lib/editor-projects";
import {
  isBrollFit,
  isBrollTransition,
  isBrollTransitionEdit,
  type BrollFit,
  type BrollTransition,
  type BrollTransitionEdit,
} from "@/lib/broll-window-style";
import { clampTailHoldMs } from "@/lib/tail-hold";
import { effectiveSfxMode, isSfxMode, planTransitionSfxCues, type SfxMode } from "@/lib/transition-sfx";

/**
 * T6 (ADR 0064, plan G10-G12): the Pending Edit Draft an MCP agent edits between tool calls.
 *
 * Storage is two additive `EditorProject` columns: `pendingEditJson` (this draft, or null) and
 * `pendingEditRevision` (monotonic, never reset). Every write is a compare-and-swap on the
 * revision, so two writers (two agent calls, later the web editor) never silently overwrite
 * each other.
 *
 * - A project with no stored draft reads as a fresh seed (G11) at the current revision; the seed
 *   is only written by the first edit (reads never write).
 * - An export records the revision it applied (`mcpPendingEditRevision` on the export input) and,
 *   on success, clears the draft only if the revision still matches (G12). The clear also bumps
 *   the revision, so the next export of the cleared project gets a fresh `mcp-export:` key.
 */

export const PENDING_EDIT_DRAFT_VERSION = 1;

export type PendingEditWindowEdit = {
  index: number;
  src: string | null;
  importId?: string;
  /** "upload" / "original", or "style" = only `transition`/`fit` change (src stays null). */
  replacementKind: string;
  /** EP5 #11: how this window ends ("default" = drop its own value, follow the project default). */
  transition?: BrollTransitionEdit;
  /** U3: "cover" (fill, crop) or "contain" (whole picture over a blurred, darkened copy). */
  fit?: BrollFit;
};

/** EP5 #11 / U3: a window edit that changes only how the window looks, not its media. */
export const STYLE_ONLY_REPLACEMENT_KIND = "style";

export type PendingEditDraft = {
  version: 1;
  rootJobId: string;
  /** `project.activeJobId` when the draft was seeded (informational; the export always uses
   *  the project's CURRENT activeJobId as its source, G9). */
  baseJobId: string;
  captions: V2Caption[];
  originalCaptions: V2Caption[];
  words?: NonNullable<VideoJobPreviewData["words"]>;
  fullText?: string;
  cardLen: V2CardLen;
  subtitleConfig: V2SubConfig;
  /** Carried through unchanged (MCP never edits per-card colours). */
  captionOverrides: V2CardOverrides;
  headlineHook?: HeadlineHookConfig;
  /** Carried through unchanged from the project draft (MCP never edits the logo). */
  logoOverlay?: LogoOverlayConfig;
  /** EP5 U7: the music chosen after creation (`set_background_music`). Absent = the base
   *  render's own music, burned exactly as today. */
  backgroundMusic?: BackgroundMusicEdit;
  /** EP5 backlog #14 (ADR 0066: shared draft field, exposed to both web and MCP). 0-3000 ms,
   *  default 0 = today's behaviour. */
  tailHoldMs: number;
  windowEdits: PendingEditWindowEdit[];
  /** EP5 #11: a new project-default B-roll transition the next export re-renders with. */
  brollTransition?: BrollTransition;
  /** EP5 #4: a new project-level presenter auto punch-in zoom setting the next export re-renders with. */
  punchZoom?: boolean;
  /** EP5 #3: transition sound effects mode ("none" | "subtle"). */
  sfxMode?: SfxMode;
};

/** True when the next export must re-render the B-roll/base (window edits, project transition, or punchZoom). */
export function draftHasBrollChanges(draft: Pick<PendingEditDraft, "windowEdits" | "brollTransition" | "punchZoom">): boolean {
  return draft.windowEdits.length > 0 || draft.brollTransition !== undefined || draft.punchZoom !== undefined;
}

/** The base render an export burns onto: `project.activeJobId`'s finished preview. */
export type PendingEditBase = {
  id: string;
  videoUrl: string;
  preview: VideoJobPreviewData;
};

export type PendingEditState = {
  projectId: string;
  revision: number;
  draft: PendingEditDraft;
  /** false = no usable stored draft; `draft` is a fresh seed that has not been written. */
  stored: boolean;
  base: PendingEditBase;
};

export type PendingEditLoadResult =
  | { ok: true; state: PendingEditState }
  | { ok: false; code: "project_not_found" | "source_not_exportable" };

export type PendingEditMutation =
  | { ok: true; draft: PendingEditDraft }
  | { ok: false; code: string; message: string };

export type PendingEditUpdateResult =
  | { ok: true; state: PendingEditState }
  | { ok: false; code: string; message?: string };

/** Revision value the CAS refuses to grow past (Int column). */
export const MAX_PENDING_EDIT_REVISION = 2_147_483_646;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Shared with T7's `set_headline_hook` so both seeding and later edits clamp against the
 *  identical clip-duration definition (never duplicated). */
export function draftDurationMs(preview: VideoJobPreviewData, captions: readonly V2Caption[]): number {
  return Math.max(preview.audioDurationMs || 0, captions[captions.length - 1]?.endMs ?? 0, 1_000);
}

function editorFields(draft: Pick<PendingEditDraft, "captions" | "originalCaptions" | "subtitleConfig" | "cardLen" | "captionOverrides" | "tailHoldMs">): EditorExportDraft {
  return {
    version: 1,
    captions: draft.captions,
    originalCaptions: draft.originalCaptions,
    subtitleConfig: draft.subtitleConfig,
    cardLen: draft.cardLen,
    captionOverrides: draft.captionOverrides,
    tailHoldMs: draft.tailHoldMs,
  };
}

function parseWindowEdits(value: unknown): PendingEditWindowEdit[] | null {
  if (!Array.isArray(value) || value.length > MAX_BROLL_WINDOW_EDITS) return null;
  const edits: PendingEditWindowEdit[] = [];
  for (const candidate of value) {
    const item = record(candidate);
    if (
      !item
      || !Number.isInteger(item.index)
      || (item.index as number) < 0
      || (item.src !== null && typeof item.src !== "string")
      || (item.importId !== undefined && typeof item.importId !== "string")
      || typeof item.replacementKind !== "string"
      || (item.transition !== undefined && !isBrollTransitionEdit(item.transition))
      || (item.fit !== undefined && !isBrollFit(item.fit))
    ) return null;
    edits.push({
      index: item.index as number,
      src: item.src as string | null,
      ...(typeof item.importId === "string" ? { importId: item.importId } : {}),
      replacementKind: item.replacementKind,
      ...(isBrollTransitionEdit(item.transition) ? { transition: item.transition } : {}),
      ...(isBrollFit(item.fit) ? { fit: item.fit } : {}),
    });
  }
  return edits;
}

/** Tolerant reader: anything malformed reads as "no stored draft" (the caller reseeds). */
export function parsePendingEditDraft(raw: string | null | undefined): PendingEditDraft | null {
  const input = record(parseJson(raw));
  if (!input || input.version !== PENDING_EDIT_DRAFT_VERSION) return null;
  if (typeof input.rootJobId !== "string" || !input.rootJobId) return null;
  if (typeof input.baseJobId !== "string" || !input.baseJobId) return null;
  const editor = normalizeEditorExportDraft({ ...input, version: 1 });
  const windowEdits = parseWindowEdits(input.windowEdits);
  if (!editor || !windowEdits) return null;
  const words = Array.isArray(input.words) ? input.words as PendingEditDraft["words"] : undefined;
  const fullText = typeof input.fullText === "string" ? input.fullText : undefined;
  const headlineHook = input.headlineHook === undefined
    ? undefined
    : normalizeHeadlineHook(input.headlineHook, 86_400_000, editor.subtitleConfig.verticalPos);
  const logoOverlay = input.logoOverlay === undefined ? undefined : normalizeLogoOverlayConfig(input.logoOverlay);
  const backgroundMusic = input.backgroundMusic === undefined ? undefined : normalizeBackgroundMusicEdit(input.backgroundMusic);
  if (headlineHook === null || logoOverlay === null || backgroundMusic === null) return null;
  if (input.brollTransition !== undefined && !isBrollTransition(input.brollTransition)) return null;
  if (input.punchZoom !== undefined && typeof input.punchZoom !== "boolean") return null;
  if (input.sfxMode !== undefined && !isSfxMode(input.sfxMode)) return null;
  return {
    version: 1,
    rootJobId: input.rootJobId,
    baseJobId: input.baseJobId,
    captions: editor.captions,
    originalCaptions: editor.originalCaptions,
    ...(words ? { words } : {}),
    ...(fullText !== undefined ? { fullText } : {}),
    cardLen: editor.cardLen,
    subtitleConfig: editor.subtitleConfig as V2SubConfig,
    captionOverrides: editor.captionOverrides,
    ...(headlineHook ? { headlineHook } : {}),
    ...(logoOverlay ? { logoOverlay } : {}),
    ...(backgroundMusic ? { backgroundMusic } : {}),
    tailHoldMs: clampTailHoldMs(editor.tailHoldMs),
    windowEdits,
    ...(isBrollTransition(input.brollTransition) ? { brollTransition: input.brollTransition } : {}),
    ...(typeof input.punchZoom === "boolean" ? { punchZoom: input.punchZoom } : {}),
    ...(isSfxMode(input.sfxMode) ? { sfxMode: input.sfxMode } : {}),
  };
}

/**
 * G11: a fresh draft, each field from its named source:
 *  - captions: the latest export's `editSnapshot.captions`, else the base preview's captions;
 *  - originalCaptions / words / fullText: the latest export snapshot, else the base preview;
 *  - cardLen / subtitleConfig: the snapshot, else the root's resolved MCP design (T4);
 *  - captionOverrides: the snapshot (carried unchanged), else none;
 *  - headlineHook / logoOverlay / backgroundMusic: the project's `draftJson` (an MCP export writes
 *    the headline and music it applied there, #7 — see `clearPendingEditDraftIfRevision`; the web
 *    autosaves its own values there);
 *  - windowEdits: empty (replacements an export already rendered live in the base itself).
 */
export function seedPendingEditDraft(input: {
  rootJobId: string;
  rootInputJson: string;
  base: PendingEditBase;
  latestExportSnapshot: EditorExportSnapshot | null;
  projectDraftJson: string | null;
}): PendingEditDraft {
  const snapshot = input.latestExportSnapshot;
  const preview = input.base.preview;
  const rootInput = (record(parseJson(input.rootInputJson)) ?? {}) as ResolvedMcpSubtitleJobInput;
  const design = resolvedMcpSubtitleDesignFromInput(rootInput);
  const captions = (snapshot?.captions ?? preview.captions).map((caption) => ({ ...caption }));
  const originalCaptions = (snapshot?.originalCaptions ?? preview.captions).map((caption) => ({ ...caption }));
  const words = snapshot?.preview.words ?? preview.words;
  const fullText = snapshot?.preview.fullText ?? preview.fullText;
  const projectDraft = record(parseJson(input.projectDraftJson)) ?? {};
  const subtitleConfig = (snapshot?.subtitleConfig as V2SubConfig | undefined) ?? { ...design.design };
  const totalDurationMs = draftDurationMs(preview, captions);
  const headlineHook = projectDraft.headlineHook !== undefined
    ? normalizeHeadlineHook(projectDraft.headlineHook, totalDurationMs, subtitleConfig.verticalPos)
    : resolveInitialHeadlineHookFromJobInput(
        rootInput as Record<string, unknown>,
        totalDurationMs,
        subtitleConfig.verticalPos,
      );
  const logoOverlay = normalizeLogoOverlayConfig(projectDraft.logoOverlay);
  const backgroundMusic = normalizeBackgroundMusicEdit(projectDraft.backgroundMusic);
  return {
    version: 1,
    rootJobId: input.rootJobId,
    baseJobId: input.base.id,
    captions,
    originalCaptions,
    ...(Array.isArray(words) ? { words } : {}),
    ...(typeof fullText === "string" ? { fullText } : {}),
    cardLen: snapshot?.cardLen ?? design.cardLen,
    subtitleConfig,
    captionOverrides: snapshot?.captionOverrides ?? {},
    ...(headlineHook ? { headlineHook } : {}),
    ...(logoOverlay ? { logoOverlay } : {}),
    ...(backgroundMusic ? { backgroundMusic } : {}),
    tailHoldMs: clampTailHoldMs(snapshot?.tailHoldMs),
    windowEdits: [],
  };
}

async function latestExportSnapshot(userId: string, projectId: string): Promise<EditorExportSnapshot | null> {
  const latest = await prisma.videoJob.findFirst({
    where: { userId, projectId, type: "export", status: "done" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { outputJson: true },
  });
  return parseVideoJobOutput(latest?.outputJson ?? null)?.editSnapshot ?? null;
}

type ResolvedProjectAndBase = {
  ok: true;
  project: { id: string; activeJobId: string | null; draftJson: string | null; pendingEditJson: string | null; pendingEditRevision: number };
  base: PendingEditBase;
};
type ResolveProjectAndBaseResult = ResolvedProjectAndBase | { ok: false; code: "project_not_found" | "source_not_exportable" };

/** Owner-scoped project + base lookup shared by `loadPendingEditState` and `discardPendingEditDraft`
 *  (G9: the base is always the project's CURRENT `activeJobId`, a finished render with a preview). */
async function resolveProjectAndBase(
  userId: string,
  root: { id: string; projectId: string | null },
): Promise<ResolveProjectAndBaseResult> {
  if (!root.projectId) return { ok: false, code: "project_not_found" };
  const project = await prisma.editorProject.findFirst({
    where: { id: root.projectId, userId, status: { not: "archived" } },
    select: { id: true, activeJobId: true, draftJson: true, pendingEditJson: true, pendingEditRevision: true },
  });
  if (!project) return { ok: false, code: "project_not_found" };
  const baseRow = await prisma.videoJob.findFirst({
    where: { id: project.activeJobId ?? root.id, userId, projectId: project.id, status: "done" },
    select: { id: true, outputJson: true },
  });
  const output = parseVideoJobOutput(baseRow?.outputJson ?? null);
  const preview = output?.preview;
  if (!baseRow || !output?.videoUrl || !preview || !Array.isArray(preview.captions) || preview.captions.length === 0) {
    return { ok: false, code: "source_not_exportable" };
  }
  const base: PendingEditBase = { id: baseRow.id, videoUrl: output.videoUrl, preview };
  return { ok: true, project, base };
}

/**
 * Owner-scoped load of the draft for a held root's project. The base is the project's current
 * `activeJobId` (G9), which must be a finished render of this project with a preview.
 */
export async function loadPendingEditState(
  userId: string,
  root: { id: string; inputJson: string; projectId: string | null },
): Promise<PendingEditLoadResult> {
  const resolved = await resolveProjectAndBase(userId, root);
  if (!resolved.ok) return resolved;
  const { project, base } = resolved;

  const stored = parsePendingEditDraft(project.pendingEditJson);
  if (stored && stored.rootJobId === root.id) {
    return { ok: true, state: { projectId: project.id, revision: project.pendingEditRevision, draft: stored, stored: true, base } };
  }
  const draft = seedPendingEditDraft({
    rootJobId: root.id,
    rootInputJson: root.inputJson,
    base,
    latestExportSnapshot: await latestExportSnapshot(userId, project.id),
    projectDraftJson: project.draftJson,
  });
  return { ok: true, state: { projectId: project.id, revision: project.pendingEditRevision, draft, stored: false, base } };
}

/**
 * T7 (G20): reset the draft to a fresh seed of the CURRENT base, discarding any stored edits.
 * CAS write with one internal retry, same shape as `updatePendingEditDraft`.
 */
export async function discardPendingEditDraft(
  userId: string,
  root: { id: string; inputJson: string; projectId: string | null },
): Promise<PendingEditUpdateResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resolved = await resolveProjectAndBase(userId, root);
    if (!resolved.ok) return { ok: false, code: resolved.code };
    const { project, base } = resolved;
    const draft = seedPendingEditDraft({
      rootJobId: root.id,
      rootInputJson: root.inputJson,
      base,
      latestExportSnapshot: await latestExportSnapshot(userId, project.id),
      projectDraftJson: project.draftJson,
    });
    if (await savePendingEditDraft(userId, project.id, project.pendingEditRevision, draft)) {
      return {
        ok: true,
        state: { projectId: project.id, revision: project.pendingEditRevision + 1, draft, stored: true, base },
      };
    }
  }
  return { ok: false, code: "stale_revision" };
}

/**
 * CAS write: stores `draft` at `expectedRevision + 1` only if the row is still at
 * `expectedRevision`. `false` = another writer won (or the draft is too large to store).
 */
export async function savePendingEditDraft(
  userId: string,
  projectId: string,
  expectedRevision: number,
  draft: PendingEditDraft,
): Promise<boolean> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > MAX_PENDING_EDIT_REVISION) {
    return false;
  }
  const json = JSON.stringify(draft);
  if (Buffer.byteLength(json, "utf8") > MAX_EDITOR_PROJECT_DRAFT_BYTES) return false;
  const written = await prisma.editorProject.updateMany({
    where: { id: projectId, userId, pendingEditRevision: expectedRevision },
    data: { pendingEditJson: json, pendingEditRevision: expectedRevision + 1 },
  });
  return written.count === 1;
}

/**
 * Load → mutate → CAS save, retried once on a lost CAS (G10). A second loss returns
 * `stale_revision`; a mutation refusal is returned unchanged and writes nothing.
 */
export async function updatePendingEditDraft(
  userId: string,
  root: { id: string; inputJson: string; projectId: string | null },
  mutate: (draft: PendingEditDraft, state: PendingEditState) => PendingEditMutation,
): Promise<PendingEditUpdateResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const loaded = await loadPendingEditState(userId, root);
    if (!loaded.ok) return { ok: false, code: loaded.code };
    const { state } = loaded;
    const mutation = mutate(structuredClone(state.draft), state);
    if (!mutation.ok) return { ok: false, code: mutation.code, message: mutation.message };
    if (await savePendingEditDraft(userId, state.projectId, state.revision, mutation.draft)) {
      return { ok: true, state: { ...state, revision: state.revision + 1, draft: mutation.draft, stored: true } };
    }
  }
  return { ok: false, code: "stale_revision" };
}

type ProjectDraftHeadlineWrite =
  | { kind: "unchanged" }
  | { kind: "write"; json: string }
  | { kind: "blocked"; reason: "draft_not_object" | "draft_too_large" | "draft_revision_exhausted" };

/**
 * #7 (ADR 0066 §4): the project draft (`EditorProject.draftJson`, which the web editor loads and
 * every later seed reads) with the exported `headlineHook` and/or `backgroundMusic` set (EP5 U7
 * persists the music the same way). `unchanged` = the values are already there;
 * `blocked` = the project draft cannot take it (not a JSON object — never overwritten; the result
 * would exceed the draft cap; `draftRevision` cannot grow), so the caller must keep the pending
 * draft, the headline's only copy.
 */
function projectDraftWithHeadline(
  draftJson: string | null,
  draftRevision: number,
  exported: { headlineHook?: HeadlineHookConfig; backgroundMusic?: BackgroundMusicEdit },
): ProjectDraftHeadlineWrite {
  const draft = draftJson ? record(parseJson(draftJson)) : {};
  if (!draft) return { kind: "blocked", reason: "draft_not_object" };
  const patch: Record<string, unknown> = {};
  if (exported.headlineHook) {
    const current = draft.headlineHook === undefined ? null : normalizeHeadlineHook(draft.headlineHook, 86_400_000);
    if (!current || JSON.stringify(current) !== JSON.stringify(exported.headlineHook)) patch.headlineHook = exported.headlineHook;
  }
  if (exported.backgroundMusic) {
    const current = normalizeBackgroundMusicEdit(draft.backgroundMusic);
    if (!current || JSON.stringify(current) !== JSON.stringify(exported.backgroundMusic)) patch.backgroundMusic = exported.backgroundMusic;
  }
  if (Object.keys(patch).length === 0) return { kind: "unchanged" };
  if (!Number.isInteger(draftRevision) || draftRevision < 0 || draftRevision >= MAX_EDITOR_PROJECT_DRAFT_REVISION) {
    return { kind: "blocked", reason: "draft_revision_exhausted" };
  }
  const json = JSON.stringify({ ...draft, ...patch });
  if (Buffer.byteLength(json, "utf8") > MAX_EDITOR_PROJECT_DRAFT_BYTES) return { kind: "blocked", reason: "draft_too_large" };
  return { kind: "write", json };
}

const PROJECT_DRAFT_RACE = new Error("pending_edit_project_draft_race");

/**
 * G12: clear the draft after a successful export of `appliedRevision` — only if no edit landed
 * while the export ran. The clear bumps the revision so the next export gets a fresh key.
 *
 * T13 fix round 1 (A3): an export never renders B-roll window edits (only export_video's
 * re-render does), so a draft that still holds some — the web exported the agent's draft — keeps
 * them: the draft is re-seeded from the export just delivered (G11) with the window edits carried
 * over (with the stored baseJobId, so an in-flight re-render's hop can still rebase), and the
 * agent's next export_video applies them. If that re-seed cannot be built, the draft is left
 * exactly as it is; window edits are never dropped silently.
 *
 * #7 (ADR 0064 "the new draft starts from that Export's edits", ADR 0066 §4): the headline hook
 * (and, EP5 U7, the background music) are the draft fields the export snapshot does not carry —
 * seeds read them from the project draft. `persistHeadlineHook` persists BOTH (the name predates
 * the music). With it (an MCP export, where the stored draft is exactly what was
 * burned) the applied headline is written into `EditorProject.draftJson` in the SAME transaction
 * as the clear, bumping `draftRevision` so an open web session reloads instead of overwriting it.
 * A web export never sets it: the web autosaves its own headline, and the stored draft may hold
 * an agent value the creator already changed there. The headline is never dropped: if the project
 * draft cannot take it (not an object, too large, revision exhausted) or moved under us twice,
 * nothing is cleared — the pending draft keeps the headline (get_edit_state and the web still
 * show it) and a later export re-applies it.
 */
export async function clearPendingEditDraftIfRevision(
  userId: string,
  projectId: string,
  appliedRevision: number,
  options: { persistHeadlineHook?: boolean } = {},
): Promise<boolean> {
  if (!Number.isInteger(appliedRevision) || appliedRevision < 0 || appliedRevision > MAX_PENDING_EDIT_REVISION) {
    return false;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const project = await prisma.editorProject.findFirst({
      where: { id: projectId, userId, pendingEditRevision: appliedRevision },
      select: { pendingEditJson: true, draftJson: true, draftRevision: true },
    });
    if (!project) return false;
    const stored = parsePendingEditDraft(project.pendingEditJson);
    const headlineWrite = options.persistHeadlineHook && (stored?.headlineHook || stored?.backgroundMusic)
      ? projectDraftWithHeadline(project.draftJson, project.draftRevision, {
        headlineHook: stored.headlineHook,
        backgroundMusic: stored.backgroundMusic,
      })
      : null;
    if (headlineWrite?.kind === "blocked") {
      // Same rule as the oversized re-seed below: keep the draft rather than drop an edit.
      console.warn(`[pending-edit] project ${projectId}: exported headline/music not persisted (${headlineWrite.reason}); pending draft kept`);
      return false;
    }
    const projectDraftJson = headlineWrite?.kind === "write" ? headlineWrite.json : null;
    let next: string | null = null;
    if (stored && draftHasBrollChanges(stored)) {
      const root = await prisma.videoJob.findFirst({
        where: { id: stored.rootJobId, userId, projectId },
        select: { id: true, inputJson: true, projectId: true },
      });
      const resolved = root ? await resolveProjectAndBase(userId, root) : null;
      if (!root || !resolved?.ok) return false;
      const seed = seedPendingEditDraft({
        rootJobId: root.id,
        rootInputJson: root.inputJson,
        base: resolved.base,
        latestExportSnapshot: await latestExportSnapshot(userId, projectId),
        projectDraftJson: projectDraftJson ?? resolved.project.draftJson,
      });
      // R1/N1: keep the stored base. A re-render's hop rebases this draft only while baseJobId
      // still names the job it started from; re-basing on the export here would make that CAS miss
      // and leave the window edits it already applied pending, to be re-rendered a second time.
      next = JSON.stringify({
        ...seed,
        baseJobId: stored.baseJobId,
        windowEdits: stored.windowEdits,
        ...(stored.brollTransition ? { brollTransition: stored.brollTransition } : {}),
        ...(typeof stored.punchZoom === "boolean" ? { punchZoom: stored.punchZoom } : {}),
      });
      if (Buffer.byteLength(next, "utf8") > MAX_EDITOR_PROJECT_DRAFT_BYTES) return false;
    }
    // CAS on the same revision: an edit that landed since the read wins and nothing is cleared.
    const clearWhere = { id: projectId, userId, pendingEditRevision: appliedRevision };
    const clearData = { pendingEditJson: next, pendingEditRevision: appliedRevision + 1 };
    if (projectDraftJson === null) {
      const cleared = await withTransientSqliteRetry(() => prisma.editorProject.updateMany({ where: clearWhere, data: clearData }));
      return cleared.count === 1;
    }
    try {
      return await withTransientSqliteRetry(() => prisma.$transaction(async (tx) => {
        const cleared = await tx.editorProject.updateMany({ where: clearWhere, data: clearData });
        if (cleared.count !== 1) return false;
        // CAS on the project draft: a web autosave that landed since the read rolls the clear back.
        const persisted = await tx.editorProject.updateMany({
          where: { id: projectId, userId, draftRevision: project.draftRevision },
          data: { draftJson: projectDraftJson, draftRevision: { increment: 1 } },
        });
        if (persisted.count !== 1) throw PROJECT_DRAFT_RACE;
        return true;
      }));
    } catch (error) {
      if (error !== PROJECT_DRAFT_RACE) throw error;
    }
  }
  return false;
}

/** The export's burn config, built exactly the way the web editor builds it (`buildV2BurnConfig`). */
export function toBurnConfig(draft: PendingEditDraft, base: Pick<PendingEditBase, "videoUrl" | "preview">) {
  const effectiveSfx = effectiveSfxMode(
    draft.sfxMode ?? (base.preview.config as { sfxMode?: unknown } | undefined)?.sfxMode,
  );
  const rawBgVideos = Array.isArray((base.preview.config as { bgVideos?: unknown } | undefined)?.bgVideos)
    ? ((base.preview.config as { bgVideos: Array<{ start?: number; brollEnabled?: boolean; src?: string }> }).bgVideos)
    : [];
  const audioDurMs = base.preview.audioDurationMs ?? 0;
  const sfxCues = effectiveSfx === "subtle"
    ? planTransitionSfxCues({
        sfxMode: "subtle",
        hasOpeningHook: Boolean(draft.headlineHook?.enabled),
        brollStartTimesSec: rawBgVideos
          .filter((v) => v && v.brollEnabled !== false && Boolean(v.src) && typeof v.start === "number")
          .map((v) => v.start as number),
        punchCueTimesSec: draft.captions
          .filter((c) => c.tag === "hook")
          .map((c) => c.startMs / 1000),
        totalDurationSec: audioDurMs / 1000,
      })
    : undefined;
  const burn = buildV2BurnConfig(
    base.videoUrl,
    draft.captions,
    audioDurMs,
    draft.subtitleConfig,
    30,
    draft.captionOverrides,
    draft.logoOverlay,
    undefined,
    draft.headlineHook,
    draft.tailHoldMs,
    effectiveSfx,
  );
  return sfxCues && sfxCues.length > 0 ? { ...burn, sfxCues } : burn;
}

/** The editor-native draft `enqueueEditorExport` turns into the export's editSnapshot. */
export function toEditorSnapshotDraft(draft: PendingEditDraft): EditorExportDraft {
  return structuredClone(editorFields(draft));
}

/** Shared client-safe caption/style projection. Async owner-resolved media is added below. */
export type PendingEditForWeb = {
  revision: number;
  draft: {
    captions: V2Caption[];
    originalCaptions: V2Caption[];
    words?: NonNullable<VideoJobPreviewData["words"]>;
    fullText?: string;
    cardLen: V2CardLen;
    subtitleConfig: V2SubConfig;
    captionOverrides: V2CardOverrides;
    headlineHook?: HeadlineHookConfig;
    backgroundMusic?: BackgroundMusicEdit;
    tailHoldMs: number;
    windowEdits?: WindowEdit[];
    windowMedia?: PendingWindowMedia[];
    requiredWindows?: ExternalWindowState[];
    brollTransition?: BrollTransition;
    punchZoom?: boolean;
  };
};

export function pendingEditForWeb(project: {
  activeJobId: string | null;
  pendingEditJson: string | null;
  pendingEditRevision: number;
}): PendingEditForWeb | null {
  if (!project.activeJobId) return null;
  const draft = parsePendingEditDraft(project.pendingEditJson);
  if (!draft || draft.baseJobId !== project.activeJobId) return null;
  return {
    revision: project.pendingEditRevision,
    draft: {
      captions: draft.captions,
      originalCaptions: draft.originalCaptions,
      ...(draft.words ? { words: draft.words } : {}),
      ...(draft.fullText !== undefined ? { fullText: draft.fullText } : {}),
      cardLen: draft.cardLen,
      subtitleConfig: draft.subtitleConfig,
      captionOverrides: draft.captionOverrides,
      ...(draft.headlineHook ? { headlineHook: draft.headlineHook } : {}),
      ...(draft.backgroundMusic ? { backgroundMusic: draft.backgroundMusic } : {}),
      tailHoldMs: draft.tailHoldMs,
    },
  };
}

/** Owner-resolved web projection: raw import IDs/URLs never become browser render sources. */
export async function pendingEditForWebResolved(userId: string, project: Parameters<typeof pendingEditForWeb>[0]): Promise<PendingEditForWeb | null> {
  const view = pendingEditForWeb(project);
  const draft = parsePendingEditDraft(project.pendingEditJson);
  if (!view || !draft) return null;
  const rows = await prisma.videoJob.findMany({ where: { userId, id: { in: [draft.rootJobId, draft.baseJobId] } }, select: { id: true, outputJson: true, projectId: true } });
  const root = rows.find(r => r.id === draft.rootJobId);
  const base = rows.find(r => r.id === draft.baseJobId);
  if (!root || !base || root.projectId !== base.projectId) return null;
  const rootPreview = parseVideoJobOutput(root.outputJson)?.preview ?? null;
  const basePreview = parseVideoJobOutput(base.outputJson)?.preview;
  if (!basePreview) return null;
  const windowMedia = resolvePendingWindowMedia(rootPreview, draft.windowEdits, await ownedDraftImports(userId, draft));
  const windowEdits = windowMedia.flatMap(w => w.edit ? [w.edit] : []);
  const merged = mergeWindowEdits((basePreview.config as { bgVideos?: unknown[] }).bgVideos ?? [], windowEdits);
  const refusal = await validateExternalMediaExport({ userId, sourceJobId: draft.baseJobId, draft, allowPending: true });
  const requiredWindows = refusal?.windows ?? externalWindowStates(rootPreview?.config, "error" in merged ? basePreview.config : { bgVideos: merged.bgVideos });
  for (const media of windowMedia) {
    const window = requiredWindows.find(w => w.index === media.index);
    if (window && media.status !== "ready") { window.state = media.status; if (media.error) window.importError = media.error; }
  }
  return {
    ...view,
    draft: {
      ...view.draft,
      windowEdits,
      windowMedia,
      requiredWindows,
      ...(draft.brollTransition ? { brollTransition: draft.brollTransition } : {}),
      ...(typeof draft.punchZoom === "boolean" ? { punchZoom: draft.punchZoom } : {}),
    },
  };
}

export class StaleWebApplyError extends Error {
  constructor() {
    super("มีการแก้ไขใหม่ระหว่างใช้การเปลี่ยนแปลง งานนี้ยังไม่ถูกนำไปใช้ กรุณาโหลด Editor ใหม่ ตรวจสอบการแก้ไขล่าสุด แล้วกด Apply อีกครั้ง");
    this.name = "StaleWebApplyError";
  }
}

/** Completion and activation share this transaction: a newer draft must abort both. */
export async function rebaseWebPendingMedia(tx: Prisma.TransactionClient, input: { userId: string; projectId: string; sourceJobId: string; jobId: string; revision: number; indices: number[]; transitionApplied: boolean; punchZoomApplied?: boolean }) {
  const project = await tx.editorProject.findFirst({ where: { id: input.projectId, userId: input.userId, pendingEditRevision: input.revision }, select: { pendingEditJson: true } });
  const draft = parsePendingEditDraft(project?.pendingEditJson ?? null);
  if (!draft || draft.baseJobId !== input.sourceJobId) throw new StaleWebApplyError();
  const next = { ...draft, baseJobId: input.jobId, windowEdits: draft.windowEdits.filter(e => !input.indices.includes(e.index)) };
  if (input.transitionApplied) delete next.brollTransition;
  if (input.punchZoomApplied) delete next.punchZoom;
  const updated = await tx.editorProject.updateMany({ where: { id: input.projectId, userId: input.userId, pendingEditRevision: input.revision }, data: { pendingEditJson: JSON.stringify(next), pendingEditRevision: { increment: 1 } } });
  if (updated.count !== 1) throw new StaleWebApplyError();
}
