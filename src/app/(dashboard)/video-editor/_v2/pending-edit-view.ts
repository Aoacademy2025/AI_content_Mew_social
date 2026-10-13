import { validateWindowEdits, type WindowEdit } from "@/lib/broll-rerender";
import type { PendingWindowMedia } from "@/lib/pending-broll-media";
import type { ExternalWindowState } from "@/lib/external-media";
import { isBrollTransition, type BrollTransition } from "@/lib/broll-window-style";
/**
 * T8 (ADR 0064, plan G21): the client-safe view of a Pending Edit Draft, matching
 * `pendingEditForWeb()`'s shape (`src/lib/mcp/pending-edit-draft.ts`, server-only — that module
 * imports `prisma` and must never be imported from a "use client" file) field-for-field. Kept as
 * its own small module so `usePostPhaseEditor.ts` / `usePendingEditDraft.ts` never need to import
 * the server module, only this one.
 *
 * B-roll replacements are owner-resolved by the server before reaching this projection.
 */
import type { VideoJobPreviewData } from "@/lib/mcp/video-job";
import type { V2CardLen, V2CardOverrides, V2Caption, V2SubConfig } from "./subtitle-style";
import type { HeadlineHookConfig } from "@/lib/headline-hook";
import { normalizeBackgroundMusicEdit, type BackgroundMusicEdit } from "@/lib/background-music";
import { clampTailHoldMs } from "@/lib/tail-hold";

export type WebPendingEditDraft = {
  captions: V2Caption[];
  originalCaptions: V2Caption[];
  words?: NonNullable<VideoJobPreviewData["words"]>;
  fullText?: string;
  cardLen: V2CardLen;
  subtitleConfig: V2SubConfig;
  captionOverrides: V2CardOverrides;
  headlineHook?: HeadlineHookConfig;
  backgroundMusic?: BackgroundMusicEdit;
  /** EP5 backlog #14 — absent (a pre-existing MCP draft) reads as 0 by every caller. */
  tailHoldMs?: number;
  windowEdits?: WindowEdit[];
  windowMedia?: PendingWindowMedia[];
  requiredWindows?: ExternalWindowState[];
  brollTransition?: BrollTransition;
};

export type WebPendingEdit = {
  revision: number;
  draft: WebPendingEditDraft;
};

/** Exact banner text the plan specifies — shown whenever a draft was loaded. */
export const PENDING_EDIT_BANNER_TEXT = "มีการแก้จาก AI agent ที่ยังไม่ export";

function isCaptionArray(value: unknown): value is V2Caption[] {
  return Array.isArray(value) && value.every((item) => (
    !!item && typeof item === "object"
    && typeof (item as { text?: unknown }).text === "string"
    && typeof (item as { startMs?: unknown }).startMs === "number"
    && typeof (item as { endMs?: unknown }).endMs === "number"
  ));
}

/**
 * Defensive parse of whatever `GET /api/editor-projects/:id` returned as `project.pendingEdit` —
 * the client never trusts the network response's shape. Anything malformed reads as `null`,
 * which every caller treats exactly like "no draft" (today's unchanged behaviour).
 */
export function normalizeWebPendingEdit(value: unknown): WebPendingEdit | null {
  if (!value || typeof value !== "object") return null;
  const revision = (value as { revision?: unknown }).revision;
  const draft = (value as { draft?: unknown }).draft;
  if (typeof revision !== "number" || !Number.isFinite(revision)) return null;
  if (!draft || typeof draft !== "object") return null;
  const d = draft as Record<string, unknown>;
  if (!isCaptionArray(d.captions) || !isCaptionArray(d.originalCaptions)) return null;
  if (typeof d.cardLen !== "string") return null;
  if (!d.subtitleConfig || typeof d.subtitleConfig !== "object") return null;
  if (!d.captionOverrides || typeof d.captionOverrides !== "object") return null;
  return {
    revision,
    draft: {
      windowEdits: Array.isArray(d.windowEdits) && !("error" in validateWindowEdits(d.windowEdits)) ? validateWindowEdits(d.windowEdits) as WindowEdit[] : [],
      windowMedia: Array.isArray(d.windowMedia) ? d.windowMedia as PendingWindowMedia[] : [],
      requiredWindows: Array.isArray(d.requiredWindows) ? d.requiredWindows as ExternalWindowState[] : [],
      ...(isBrollTransition(d.brollTransition) ? { brollTransition: d.brollTransition } : {}),
      captions: d.captions,
      originalCaptions: d.originalCaptions,
      ...(Array.isArray(d.words) ? { words: d.words as WebPendingEditDraft["words"] } : {}),
      ...(typeof d.fullText === "string" ? { fullText: d.fullText } : {}),
      cardLen: d.cardLen as V2CardLen,
      subtitleConfig: d.subtitleConfig as V2SubConfig,
      captionOverrides: d.captionOverrides as V2CardOverrides,
      ...(d.headlineHook && typeof d.headlineHook === "object"
        ? { headlineHook: d.headlineHook as HeadlineHookConfig }
        : {}),
      ...(normalizeBackgroundMusicEdit(d.backgroundMusic)
        ? { backgroundMusic: normalizeBackgroundMusicEdit(d.backgroundMusic)! }
        : {}),
      ...(typeof d.tailHoldMs === "number" ? { tailHoldMs: clampTailHoldMs(d.tailHoldMs) } : {}),
    },
  };
}

/** Matches the existing inspector shape; desktop/mobile use the same hook. */
export function webPendingWindowEdits(draft: WebPendingEditDraft | null) {
  return new Map((draft?.windowEdits ?? []).map(({ index, replacementKind, start, end, ...edit }) => [index, {
    ...edit, ...(replacementKind ? { kind: replacementKind } : {}),
    ...(start !== undefined ? { startSec: start } : {}), ...(end !== undefined ? { endSec: end } : {}),
  }]));
}

/** Import status may change without a draft revision. Update only untouched server edits. */
export function refreshPendingWindowMedia<T>(current: Map<number, T>, previous: Map<number, T>, incoming: Map<number, T>): Map<number, T> {
  const next = new Map(current);
  for (const index of new Set([...previous.keys(), ...incoming.keys()])) {
    const untouched = previous.has(index)
      ? current.has(index) && JSON.stringify(current.get(index)) === JSON.stringify(previous.get(index))
      : !current.has(index);
    if (!untouched) continue;
    if (incoming.has(index)) next.set(index, incoming.get(index)!);
    else next.delete(index);
  }
  return next;
}
