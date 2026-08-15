import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { HeadlineHookConfig } from "../lib/headline-hook";
import { HeadlineHookView, headlineHookMotionAt } from "./HeadlineHookView";

export function HeadlineHookOverlay({
  hook,
  durationInFrames,
}: {
  hook: HeadlineHookConfig;
  durationInFrames: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const elapsedMs = (frame / fps) * 1_000;
  const durationMs = (durationInFrames / fps) * 1_000;
  const motion = headlineHookMotionAt(elapsedMs, durationMs);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: "6%",
          right: "6%",
          top: `${hook.topPercent}%`,
          transform: "translateY(-50%)",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <HeadlineHookView hook={hook} motion={motion} />
      </div>
    </AbsoluteFill>
  );
}
