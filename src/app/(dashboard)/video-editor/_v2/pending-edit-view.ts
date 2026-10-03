/**
 * T8 (ADR 0064, plan G21): the client-safe view of a Pending Edit Draft, matching
 * `pendingEditForWeb()`'s shape (`src/lib/mcp/pending-edit-draft.ts`, server-only — that module
 * imports `prisma` and must never be imported from a "use client" file) field-for-field. Kept as
 * its own small module so `usePostPhaseEditor.ts` / `usePendingEditDraft.ts` never need to import
 * the server module, only this one.
 *
 * `logoOverlay` and `windowEdits` are deliberately absent here — the plan is explicit that the
 * logo stays from the project (the web never adopts the agent's logo), and window edits are an
 * MCP-only concern the web Post phase does not read.
 */
import type { VideoJobPreviewData } from "@/lib/mcp/video-job";
import type { V2CardLen, V2CardOverrides, V2Caption, V2SubConfig } from "./subtitle-style";
import type { HeadlineHookConfig } from "@/lib/headline-hook";

export type WebPendingEditDraft = {
  captions: V2Caption[];
  originalCaptions: V2Caption[];
  words?: NonNullable<VideoJobPreviewData["words"]>;
  fullText?: string;
  cardLen: V2CardLen;
  subtitleConfig: V2SubConfig;
  captionOverrides: V2CardOverrides;
  headlineHook?: HeadlineHookConfig;
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
    },
  };
}
