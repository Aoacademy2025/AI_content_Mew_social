import { compareSubtitleContentToNarration } from "@/lib/subtitle-content-contract";
import type { EditorNarrativeSourceKind } from "@/lib/editor-default-draft";

export const MIN_CAPTION_CARD_MS = 300;
export const DEFAULT_NEW_CAPTION_CARD_MS = 1000;

export type EditableCaptionCard = {
  text: string;
  startMs: number;
  endMs: number;
  tag?: string;
};

export type InsertCaptionCardResult =
  | { ok: true; captions: EditableCaptionCard[]; index: number }
  | { ok: false; reason: "no_room" };

export type DeleteCaptionCardResult =
  | { ok: true; captions: EditableCaptionCard[]; selected: number }
  | { ok: false; reason: "invalid_index" | "last_caption" };

export type CaptionExportPreflightResult =
  | { ok: true }
  | { ok: false; reason: "blank_caption" | "spoken_content_changed"; index: number };

/**
 * Empty cards are useful while editing, but a visible empty subtitle cannot be
 * submitted: the durable export would otherwise fail later in the worker after
 * the UI has already switched into Rendering. A hidden subtitle layer is an
 * intentional no-subtitle export and must remain allowed.
 */
export function captionExportPreflight(
  captions: readonly Pick<EditableCaptionCard, "text">[],
  subtitlesVisible: boolean,
  narrationText?: string,
  narrativeSourceKind: EditorNarrativeSourceKind = "creator-script",
): CaptionExportPreflightResult {
  if (!subtitlesVisible) return { ok: true };
  const index = captions.findIndex((caption) => !caption.text.trim());
  if (index >= 0) return { ok: false, reason: "blank_caption", index };

  // An upload has no immutable authored script: its editable transcript cards are
  // the approved Narrative Source. Provider fullText may differ from the timed
  // cards, so comparing against it creates an impossible-to-fix export block.
  // Script-backed narration remains fail-closed against changed spoken content.
  if (narrativeSourceKind !== "upload-transcript" && narrationText?.trim()) {
    const comparison = compareSubtitleContentToNarration(narrationText, captions);
    if (comparison.status === "content_mismatch") {
      return {
        ok: false,
        reason: "spoken_content_changed",
        index: comparison.captionIndex,
      };
    }
  }

  return { ok: true };
}

/**
 * Add an empty caption without moving any later caption:
 * - inside a card: split its time at the playhead and use the right side;
 * - inside a real gap: occupy up to one second of that gap.
 *
 * If neither side can keep the minimum editable duration, reject instead of
 * silently shifting the rest of the subtitle timeline.
 */
export function insertCaptionCardAtPlayhead(
  captions: readonly EditableCaptionCard[],
  playheadMs: number,
  durationMs: number,
  minCardMs = MIN_CAPTION_CARD_MS,
): InsertCaptionCardResult {
  const cards = captions.map((caption) => ({ ...caption }));
  const lastEndMs = cards.length > 0 ? cards[cards.length - 1].endMs : 0;
  const timelineEndMs = Math.max(0, Math.round(durationMs), lastEndMs);
  const atMs = Math.max(0, Math.min(timelineEndMs, Math.round(playheadMs)));

  const containingIndex = cards.findIndex(
    (caption) => atMs > caption.startMs && atMs < caption.endMs,
  );
  if (containingIndex >= 0) {
    const current = cards[containingIndex];
    if (
      atMs - current.startMs < minCardMs
      || current.endMs - atMs < minCardMs
    ) {
      return { ok: false, reason: "no_room" };
    }
    cards[containingIndex] = { ...current, endMs: atMs };
    cards.splice(containingIndex + 1, 0, {
      text: "",
      startMs: atMs,
      endMs: current.endMs,
      tag: "body",
    });
    return { ok: true, captions: cards, index: containingIndex + 1 };
  }

  const insertIndex = cards.findIndex((caption) => caption.startMs >= atMs);
  const normalizedIndex = insertIndex >= 0 ? insertIndex : cards.length;
  const gapStartMs = normalizedIndex > 0 ? cards[normalizedIndex - 1].endMs : 0;
  const gapEndMs = normalizedIndex < cards.length
    ? cards[normalizedIndex].startMs
    : timelineEndMs;

  if (
    atMs < gapStartMs
    || atMs > gapEndMs
    || gapEndMs - gapStartMs < minCardMs
  ) {
    return { ok: false, reason: "no_room" };
  }

  const startMs = Math.max(gapStartMs, Math.min(atMs, gapEndMs - minCardMs));
  const endMs = Math.min(gapEndMs, startMs + DEFAULT_NEW_CAPTION_CARD_MS);
  if (endMs - startMs < minCardMs) {
    return { ok: false, reason: "no_room" };
  }

  cards.splice(normalizedIndex, 0, {
    text: "",
    startMs,
    endMs,
    tag: "body",
  });
  return { ok: true, captions: cards, index: normalizedIndex };
}

export function deleteCaptionCard(
  captions: readonly EditableCaptionCard[],
  index: number,
): DeleteCaptionCardResult {
  if (!Number.isInteger(index) || index < 0 || index >= captions.length) {
    return { ok: false, reason: "invalid_index" };
  }
  if (captions.length <= 1) {
    return { ok: false, reason: "last_caption" };
  }
  const next = captions
    .filter((_, captionIndex) => captionIndex !== index)
    .map((caption) => ({ ...caption }));
  return {
    ok: true,
    captions: next,
    selected: Math.min(index, next.length - 1),
  };
}

export function shiftCaptionOverrides<T>(
  overrides: Readonly<Record<number, T>>,
  input: { from: number; delta: number; dropIndex?: number },
): Record<number, T> {
  const next: Record<number, T> = {};
  for (const [rawIndex, value] of Object.entries(overrides)) {
    const index = Number(rawIndex);
    if (input.dropIndex !== undefined && index === input.dropIndex) continue;
    next[index >= input.from ? index + input.delta : index] = value;
  }
  return next;
}

export type CaptionHistoryEntry<TSnapshot> = {
  id: number;
  before: TSnapshot;
  after: TSnapshot;
};

export type CaptionHistoryState<TSnapshot> = {
  past: Array<CaptionHistoryEntry<TSnapshot>>;
  future: Array<CaptionHistoryEntry<TSnapshot>>;
};

export function commitCaptionHistory<TSnapshot>(
  history: CaptionHistoryState<TSnapshot>,
  entry: CaptionHistoryEntry<TSnapshot>,
  limit = 50,
): CaptionHistoryState<TSnapshot> {
  return {
    past: [...history.past, entry].slice(-Math.max(1, limit)),
    future: [],
  };
}

export function undoCaptionHistory<TSnapshot>(
  history: CaptionHistoryState<TSnapshot>,
  expectedEntryId?: number,
): {
  history: CaptionHistoryState<TSnapshot>;
  snapshot: TSnapshot | null;
  entry: CaptionHistoryEntry<TSnapshot> | null;
} {
  const entry = history.past[history.past.length - 1] ?? null;
  if (!entry || (expectedEntryId !== undefined && entry.id !== expectedEntryId)) {
    return { history, snapshot: null, entry: null };
  }
  return {
    history: {
      past: history.past.slice(0, -1),
      future: [...history.future, entry],
    },
    snapshot: entry.before,
    entry,
  };
}

export function redoCaptionHistory<TSnapshot>(
  history: CaptionHistoryState<TSnapshot>,
): {
  history: CaptionHistoryState<TSnapshot>;
  snapshot: TSnapshot | null;
  entry: CaptionHistoryEntry<TSnapshot> | null;
} {
  const entry = history.future[history.future.length - 1] ?? null;
  if (!entry) return { history, snapshot: null, entry: null };
  return {
    history: {
      past: [...history.past, entry],
      future: history.future.slice(0, -1),
    },
    snapshot: entry.after,
    entry,
  };
}
