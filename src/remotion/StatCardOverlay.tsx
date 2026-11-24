import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import {
  STAT_CARD_DEFAULT_TOP_PERCENT,
  findActiveStatCard,
  type StatCardItem,
} from "../lib/stat-cards";
import {
  StatCardBadge,
  statCardMotionAt,
  type StatCardMotion,
} from "./StatCardView";

export { StatCardBadge, statCardMotionAt, type StatCardMotion };

export function StatCardOverlay({
  cards,
  topPercent = STAT_CARD_DEFAULT_TOP_PERCENT,
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
  const active = findActiveStatCard(cards, currentMs);
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
