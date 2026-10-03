import { prisma } from "@/lib/prisma";
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
import { normalizeHeadlineHook, type HeadlineHookConfig } from "@/lib/headline-hook";
import { normalizeLogoOverlayConfig, type LogoOverlayConfig } from "@/lib/logo-overlay";
import { MAX_EDITOR_PROJECT_DRAFT_BYTES } from "@/lib/editor-projects";

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
  replacementKind: string;
};

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
  windowEdits: PendingEditWindowEdit[];
};

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

function editorFields(draft: Pick<PendingEditDraft, "captions" | "originalCaptions" | "subtitleConfig" | "cardLen" | "captionOverrides">): EditorExportDraft {
  return {
    version: 1,
    captions: draft.captions,
    originalCaptions: draft.originalCaptions,
    subtitleConfig: draft.subtitleConfig,
    cardLen: draft.cardLen,
    captionOverrides: draft.captionOverrides,
  };
}

function parseWindowEdits(value: unknown): PendingEditWindowEdit[] | null {
  if (!Array.isArray(value) || value.length > 200) return null;
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
    ) return null;
    edits.push({
      index: item.index as number,
      src: item.src as string | null,
      ...(typeof item.importId === "string" ? { importId: item.importId } : {}),
      replacementKind: item.replacementKind,
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
  const headlineHook = input.headlineHook === undefined ? undefined : normalizeHeadlineHook(input.headlineHook, 86_400_000);
  const logoOverlay = input.logoOverlay === undefined ? undefined : normalizeLogoOverlayConfig(input.logoOverlay);
  if (headlineHook === null || logoOverlay === null) return null;
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
    windowEdits,
  };
}

/**
 * G11: a fresh draft, each field from its named source:
 *  - captions: the latest export's `editSnapshot.captions`, else the base preview's captions;
 *  - originalCaptions / words / fullText: the latest export snapshot, else the base preview;
 *  - cardLen / subtitleConfig: the snapshot, else the root's resolved MCP design (T4);
 *  - captionOverrides: the snapshot (carried unchanged), else none;
 *  - headlineHook / logoOverlay: the project's `draftJson`;
 *  - windowEdits: empty.
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
  const headlineHook = normalizeHeadlineHook(projectDraft.headlineHook, draftDurationMs(preview, captions));
  const logoOverlay = normalizeLogoOverlayConfig(projectDraft.logoOverlay);
  return {
    version: 1,
    rootJobId: input.rootJobId,
    baseJobId: input.base.id,
    captions,
    originalCaptions,
    ...(Array.isArray(words) ? { words } : {}),
    ...(typeof fullText === "string" ? { fullText } : {}),
    cardLen: snapshot?.cardLen ?? design.cardLen,
    subtitleConfig: (snapshot?.subtitleConfig as V2SubConfig | undefined) ?? { ...design.design },
    captionOverrides: snapshot?.captionOverrides ?? {},
    ...(headlineHook ? { headlineHook } : {}),
    ...(logoOverlay ? { logoOverlay } : {}),
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

/**
 * G12: clear the draft after a successful export of `appliedRevision` — only if no edit landed
 * while the export ran. The clear bumps the revision so the next export gets a fresh key.
 *
 * T13 fix round 1 (A3): an export never renders B-roll window edits (only export_video's
 * re-render does), so a draft that still holds some — the web exported the agent's draft — keeps
 * them: the draft is re-seeded from the export just delivered (G11) with the window edits carried
 * over, and the agent's next export_video applies them. If that re-seed cannot be built, the draft
 * is left exactly as it is; window edits are never dropped silently.
 */
export async function clearPendingEditDraftIfRevision(
  userId: string,
  projectId: string,
  appliedRevision: number,
): Promise<boolean> {
  if (!Number.isInteger(appliedRevision) || appliedRevision < 0 || appliedRevision > MAX_PENDING_EDIT_REVISION) {
    return false;
  }
  const project = await prisma.editorProject.findFirst({
    where: { id: projectId, userId, pendingEditRevision: appliedRevision },
    select: { pendingEditJson: true },
  });
  if (!project) return false;
  const stored = parsePendingEditDraft(project.pendingEditJson);
  let next: string | null = null;
  if (stored && stored.windowEdits.length > 0) {
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
      projectDraftJson: resolved.project.draftJson,
    });
    next = JSON.stringify({ ...seed, windowEdits: stored.windowEdits });
    if (Buffer.byteLength(next, "utf8") > MAX_EDITOR_PROJECT_DRAFT_BYTES) return false;
  }
  // CAS on the same revision: an edit that landed since the read wins and nothing is cleared.
  const cleared = await prisma.editorProject.updateMany({
    where: { id: projectId, userId, pendingEditRevision: appliedRevision },
    data: { pendingEditJson: next, pendingEditRevision: appliedRevision + 1 },
  });
  return cleared.count === 1;
}

/** The export's burn config, built exactly the way the web editor builds it (`buildV2BurnConfig`). */
export function toBurnConfig(draft: PendingEditDraft, base: Pick<PendingEditBase, "videoUrl" | "preview">) {
  return buildV2BurnConfig(
    base.videoUrl,
    draft.captions,
    base.preview.audioDurationMs ?? 0,
    draft.subtitleConfig,
    30,
    draft.captionOverrides,
    draft.logoOverlay,
    undefined,
    draft.headlineHook,
  );
}

/** The editor-native draft `enqueueEditorExport` turns into the export's editSnapshot. */
export function toEditorSnapshotDraft(draft: PendingEditDraft): EditorExportDraft {
  return structuredClone(editorFields(draft));
}

/** T8 (ADR 0064, G21): the fields the web Post phase needs, projected from the stored draft —
 *  only when it still targets the project's current base (`activeJobId`). `rootJobId`, `logoOverlay`
 *  and `windowEdits` are MCP-only concerns and are never surfaced here: the web keeps its own logo
 *  from the project (per the plan, "logo stays from the project"), and web edits never touch
 *  windowEdits. A project with no stored draft, or a draft seeded for a different base job
 *  (the agent edited an earlier render than the one the project now points at), reads as `null` —
 *  the web Post phase then behaves exactly as it does today. */
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
    },
  };
}
