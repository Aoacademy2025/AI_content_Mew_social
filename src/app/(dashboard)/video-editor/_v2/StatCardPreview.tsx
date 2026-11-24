"use client";

import React, { memo, useEffect, useRef, useState } from "react";
import {
  STAT_CARD_DEFAULT_TOP_PERCENT,
  findActiveStatCard,
  type StatCardItem,
  type StatCardToggleStatus,
} from "@/lib/stat-cards";
import {
  StatCardBadge,
  statCardMotionAt,
  statCardPreviewElapsedMs,
} from "@/remotion/StatCardView";
import { color, radius } from "./tokens";

/**
 * Live Web Editor preview for animated Stat Cards — shares the exact `StatCardBadge`,
 * motion curve, and `[startMs, endMs)` timing semantics with Remotion `StatCardOverlay`.
 * Always `pointer-events-none` so it never intercepts video controls or subtitle dragging.
 */
export const StatCardPreview = memo(function StatCardPreview({
  cards,
  videoRef,
  timeMs,
  playing,
  fontFamily,
  topPercent = STAT_CARD_DEFAULT_TOP_PERCENT,
}: {
  cards: readonly StatCardItem[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  timeMs: number;
  playing: boolean;
  fontFamily?: string;
  topPercent?: number;
}) {
  const [rafVideoMs, setRafVideoMs] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [frameScale, setFrameScale] = useState(0.3);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video) setRafVideoMs(video.currentTime * 1_000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef]);

  useEffect(() => {
    const frame = rootRef.current?.parentElement;
    if (!frame) return;
    const observer = new ResizeObserver(() => setFrameScale(frame.clientWidth / 1080 || 0.3));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const currentMs = rafVideoMs ?? timeMs;
  const active = findActiveStatCard(cards, currentMs);
  if (!active) {
    return <div ref={rootRef} className="hidden" aria-hidden="true" />;
  }

  const elapsedMs = Math.max(0, currentMs - active.startMs);
  const durationMs = Math.max(1, active.endMs - active.startMs);
  const previewElapsed = statCardPreviewElapsedMs(elapsedMs, durationMs, playing);
  const motion = statCardMotionAt(previewElapsed, durationMs);

  return (
    <div
      ref={rootRef}
      data-stat-card-preview="true"
      data-stat-card-id={active.id}
      aria-hidden="true"
      className="pointer-events-none select-none absolute z-[18]"
      style={{
        left: "6%",
        right: "6%",
        top: `${topPercent}%`,
        transform: "translateY(-50%)",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <StatCardBadge
        card={active}
        frameScale={frameScale}
        motion={motion}
        fontFamily={fontFamily}
      />
    </div>
  );
});

export function StatCardToggleBadge({
  status,
  enabled,
}: {
  status: StatCardToggleStatus;
  enabled: boolean;
}) {
  const tone = status.hasMatches
    ? enabled
      ? {
          background: "rgba(52,211,153,.13)",
          border: "rgba(52,211,153,.35)",
          text: color.success,
        }
      : {
          background: "rgba(255,255,255,.06)",
          border: "rgba(255,255,255,.12)",
          text: color.textSecondary,
        }
    : enabled
      ? {
          background: "rgba(251,191,36,.12)",
          border: "rgba(251,191,36,.38)",
          text: color.warningText,
        }
      : {
          background: "rgba(255,255,255,.05)",
          border: "rgba(255,255,255,.10)",
          text: color.textFaint,
        };

  return (
    <span
      data-stat-cards-status={status.hasMatches ? "match" : "empty"}
      data-stat-cards-count={status.count}
      style={{
        padding: "1px 6px",
        borderRadius: radius.pill,
        fontSize: 10,
        fontWeight: 600,
        lineHeight: 1.5,
        whiteSpace: "nowrap",
        background: tone.background,
        border: `1px solid ${tone.border}`,
        color: tone.text,
      }}
    >
      {status.badgeText}
    </span>
  );
}

export function StatCardToggleHint({
  status,
  enabled,
  subtitlesVisible,
}: {
  status: StatCardToggleStatus;
  enabled: boolean;
  subtitlesVisible: boolean;
}) {
  if (status.helperText) {
    return (
      <span
        data-stat-cards-hint="empty"
        role={enabled ? "status" : undefined}
        style={
          enabled
            ? {
                padding: "6px 9px",
                borderRadius: 8,
                background: "rgba(251,191,36,.08)",
                border: "1px solid rgba(251,191,36,.24)",
                color: color.warningText,
                fontSize: 10.5,
                lineHeight: 1.45,
              }
            : {
                fontSize: 10,
                lineHeight: 1.45,
                color: color.textFaintest,
              }
        }
      >
        {status.helperText}
      </span>
    );
  }

  if (enabled && status.hasMatches && !subtitlesVisible) {
    return (
      <span
        data-stat-cards-hint="subtitles-hidden"
        role="status"
        style={{
          padding: "6px 9px",
          borderRadius: 8,
          background: "rgba(251,191,36,.08)",
          border: "1px solid rgba(251,191,36,.24)",
          color: color.warningText,
          fontSize: 10.5,
          lineHeight: 1.45,
        }}
      >
        เลเยอร์ซับถูกซ่อนอยู่ — เปิดเลเยอร์ซับเพื่อแสดงการ์ดสถิติในพรีวิวและไฟล์ส่งออก
      </span>
    );
  }

  return null;
}
