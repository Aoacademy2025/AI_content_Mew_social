import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { StatCardItem } from "../lib/stat-cards";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeOutBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const t = clamp01(x);
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export function statCardMotionAt(elapsedMs: number, durationMs: number) {
  const enter = clamp01(elapsedMs / 240);
  const exitStart = Math.max(0, durationMs - 200);
  const exit = elapsedMs <= exitStart ? 0 : clamp01((elapsedMs - exitStart) / 200);
  const opacity = Math.min(enter, 1 - exit);
  const scale = 0.88 + 0.12 * easeOutBack(enter) - 0.06 * exit;
  const translateY = (1 - enter) * 18 - exit * 10;
  return { opacity, scale, translateY };
}

export function StatCardBadge({
  card,
  frameScale = 1,
  motion = { opacity: 1, scale: 1, translateY: 0 },
  fontFamily,
}: {
  card: StatCardItem;
  frameScale?: number;
  motion?: { opacity: number; scale: number; translateY: number };
  fontFamily?: string;
}) {
  const accent = card.accentColor || "#FBBF24";
  const resolvedFont = fontFamily || "'Kanit', 'Noto Sans Thai', sans-serif";
  return (
    <div
      data-stat-card="true"
      data-stat-value={card.valueText}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: `${18 * frameScale}px`,
        padding: `${16 * frameScale}px ${26 * frameScale}px`,
        borderRadius: `${24 * frameScale}px`,
        background: "linear-gradient(135deg, rgba(10, 12, 24, 0.92) 0%, rgba(24, 20, 44, 0.88) 100%)",
        border: `${Math.max(1.5, 2.5 * frameScale)}px solid rgba(251, 191, 36, 0.65)`,
        boxShadow: `0 ${14 * frameScale}px ${36 * frameScale}px rgba(0, 0, 0, 0.52), 0 0 ${24 * frameScale}px rgba(251, 191, 36, 0.18)`,
        backdropFilter: "blur(12px)",
        opacity: motion.opacity,
        transform: `translateY(${motion.translateY * frameScale}px) scale(${motion.scale})`,
        transformOrigin: "center top",
        maxWidth: "88%",
      }}
    >
      <span
        data-stat-card-number="true"
        style={{
          fontFamily: resolvedFont,
          fontSize: `${56 * frameScale}px`,
          fontWeight: 900,
          lineHeight: 1,
          color: accent,
          letterSpacing: `${-1 * frameScale}px`,
          textShadow: `0 ${3 * frameScale}px ${12 * frameScale}px rgba(0, 0, 0, 0.65)`,
          whiteSpace: "nowrap",
        }}
      >
        {card.valueText}
      </span>
      <div
        style={{
          width: `${Math.max(1, 2 * frameScale)}px`,
          alignSelf: "stretch",
          background: "rgba(255, 255, 255, 0.18)",
          borderRadius: 999,
        }}
      />
      <span
        data-stat-card-label="true"
        style={{
          fontFamily: resolvedFont,
          fontSize: `${30 * frameScale}px`,
          fontWeight: 600,
          lineHeight: 1.2,
          color: "#F8FAFC",
          textAlign: "left",
        }}
      >
        {card.labelText}
      </span>
    </div>
  );
}

export function StatCardOverlay({
  cards,
  topPercent = 18,
  fontFamily,
}: {
  cards: readonly StatCardItem[];
  topPercent?: number;
  fontFamily?: string;
}) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  if (!cards || cards.length === 0) return null;

  const currentMs = (frame / fps) * 1000;
  const active = cards.find((c) => currentMs >= c.startMs && currentMs < c.endMs);
  if (!active) return null;

  const elapsedMs = Math.max(0, currentMs - active.startMs);
  const durationMs = Math.max(1, active.endMs - active.startMs);
  const motion = statCardMotionAt(elapsedMs, durationMs);
  const frameScale = width / 1080;

  return (
    <AbsoluteFill style={{ pointerEvents: "none", zIndex: 28 }}>
      <div
        style={{
          position: "absolute",
          left: "6%",
          right: "6%",
          top: `${topPercent}%`,
          transform: "translateY(-50%)",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <StatCardBadge card={active} frameScale={frameScale} motion={motion} fontFamily={fontFamily} />
      </div>
    </AbsoluteFill>
  );
}
