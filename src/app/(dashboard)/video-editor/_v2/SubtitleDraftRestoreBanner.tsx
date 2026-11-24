"use client";

import { RotateCcw } from "lucide-react";
import { color, font, radius } from "./tokens";
import {
  SUBTITLE_DRAFT_RESTORE_COPY,
  type StoredSubtitleDraft,
} from "./subtitle-draft-storage";

export function SubtitleDraftRestoreBanner({
  draft,
  onRestore,
  onDiscard,
  compact = false,
}: {
  draft: StoredSubtitleDraft | null;
  onRestore: () => void;
  onDiscard: () => void;
  compact?: boolean;
}) {
  if (!draft) return null;

  return (
    <div
      role="status"
      data-subtitle-draft-restore-banner="true"
      className={compact ? "flex flex-wrap items-center justify-between gap-2 px-4 py-2" : "flex flex-wrap items-center justify-between gap-3 px-5 py-2"}
      style={{
        background: color.selectedBg,
        borderBottom: `1px solid ${color.selectedBorder}`,
        fontFamily: font.body,
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <RotateCcw size={14} strokeWidth={2} color={color.primary300} className="shrink-0" aria-hidden="true" />
        <span style={{ fontSize: compact ? 12 : 12.5, color: color.text }}>
          <strong style={{ fontWeight: 600, color: color.primary300 }}>
            {SUBTITLE_DRAFT_RESTORE_COPY.title}
          </strong>
          {!compact && (
            <span style={{ color: color.textSecondary }}>
              {" "}· {SUBTITLE_DRAFT_RESTORE_COPY.description}
            </span>
          )}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          data-subtitle-draft-action="restore"
          onClick={onRestore}
          style={{
            padding: compact ? "6px 12px" : "5px 12px",
            minHeight: compact ? 36 : 30,
            borderRadius: radius.control,
            border: "none",
            background: color.gradientPrimary,
            color: "#fff",
            font: `500 ${compact ? 12 : 11.5}px ${font.heading}`,
            cursor: "pointer",
          }}
        >
          {SUBTITLE_DRAFT_RESTORE_COPY.restoreLabel}
        </button>
        <button
          type="button"
          data-subtitle-draft-action="discard"
          onClick={onDiscard}
          style={{
            padding: compact ? "6px 10px" : "5px 10px",
            minHeight: compact ? 36 : 30,
            borderRadius: radius.control,
            border: `1px solid ${color.cardBorder}`,
            background: "transparent",
            color: color.textSecondary,
            font: `500 ${compact ? 12 : 11.5}px ${font.body}`,
            cursor: "pointer",
          }}
        >
          {SUBTITLE_DRAFT_RESTORE_COPY.discardLabel}
        </button>
      </div>
    </div>
  );
}
