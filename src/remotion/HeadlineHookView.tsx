import React from "react";
import {
  headlineHookFontSizes,
  type HeadlineHookConfig,
} from "../lib/headline-hook";

export type HeadlineHookMotion = {
  opacity: number;
  translateY: number;
  scale: number;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeOutQuart = (value: number) => 1 - Math.pow(1 - clamp01(value), 4);
const easeInQuart = (value: number) => Math.pow(clamp01(value), 4);

/** Shared by browser preview and Remotion so the headline enters/exits identically. */
export function headlineHookMotionAt(
  elapsedMs: number,
  durationMs: number,
): HeadlineHookMotion {
  const enter = easeOutQuart(elapsedMs / 240);
  const exitStart = Math.max(0, durationMs - 220);
  const exit = elapsedMs <= exitStart ? 0 : easeInQuart((elapsedMs - exitStart) / 220);
  return {
    opacity: Math.min(enter, 1 - exit),
    translateY: 14 * (1 - enter) - 8 * exit,
    scale: 0.96 + 0.04 * enter,
  };
}
const outline = (scale: number, width = 3) => ({
  WebkitTextStroke: `${Math.max(1, width * scale)}px rgba(4, 4, 10, 0.96)`,
  paintOrder: "stroke fill" as const,
  textShadow: `0 ${Math.max(2, 5 * scale)}px ${Math.max(5, 16 * scale)}px rgba(0,0,0,.82)`,
});

export function HeadlineHookView({
  hook,
  frameScale = 1,
  motion = { opacity: 1, translateY: 0, scale: 1 },
}: {
  hook: HeadlineHookConfig;
  frameScale?: number;
  motion?: HeadlineHookMotion;
}) {
  const sizes = headlineHookFontSizes(hook.headline);
  const headlineSize = sizes.headline * frameScale;
  const subheadlineSize = sizes.subheadline * frameScale;
  const commonHeadline: React.CSSProperties = {
    margin: 0,
    color: "#F8F7FC",
    fontFamily: "'Kanit', 'Noto Sans Thai', sans-serif",
    fontSize: headlineSize,
    fontWeight: 900,
    lineHeight: 1.08,
    letterSpacing: `${-1.2 * frameScale}px`,
    textAlign: "center",
    whiteSpace: "pre-line",
    overflowWrap: "anywhere",
    ...outline(frameScale, 4),
  };
  const commonSubheadline: React.CSSProperties = {
    margin: 0,
    marginTop: 12 * frameScale,
    color: "#FFE44D",
    fontFamily: "'Kanit', 'Noto Sans Thai', sans-serif",
    fontSize: subheadlineSize,
    fontWeight: 800,
    lineHeight: 1.18,
    textAlign: "center",
    whiteSpace: "pre-line",
    overflowWrap: "anywhere",
    ...outline(frameScale, 3),
  };

  const content = hook.preset === "news" ? (
    <div
      style={{
        display: "inline-flex",
        maxWidth: "100%",
        alignItems: "stretch",
        background: "rgba(8, 8, 13, 0.88)",
        boxShadow: `0 ${8 * frameScale}px ${24 * frameScale}px rgba(0,0,0,.28)`,
      }}
    >
      <span style={{ width: 10 * frameScale, flex: "none", background: "#FF5A2F" }} />
      <div style={{ padding: `${16 * frameScale}px ${24 * frameScale}px ${19 * frameScale}px` }}>
        <p style={{ ...commonHeadline, fontSize: headlineSize * 0.9, WebkitTextStroke: "0px transparent", textShadow: "none" }}>
          {hook.headline}
        </p>
        {hook.subheadline && (
          <p style={{ ...commonSubheadline, fontSize: subheadlineSize * 0.9, WebkitTextStroke: "0px transparent", textShadow: "none" }}>
            {hook.subheadline}
          </p>
        )}
      </div>
    </div>
  ) : hook.preset === "clean" ? (
    <div
      style={{
        display: "inline-block",
        maxWidth: "100%",
        padding: `${16 * frameScale}px ${24 * frameScale}px ${19 * frameScale}px`,
        borderRadius: 18 * frameScale,
        background: "rgba(8, 8, 13, 0.58)",
        boxShadow: `0 ${8 * frameScale}px ${28 * frameScale}px rgba(0,0,0,.22)`,
      }}
    >
      <p style={{ ...commonHeadline, fontSize: headlineSize * 0.86, WebkitTextStroke: "0px transparent", textShadow: `0 ${3 * frameScale}px ${12 * frameScale}px rgba(0,0,0,.8)` }}>
        {hook.headline}
      </p>
      {hook.subheadline && (
        <p style={{ ...commonSubheadline, color: "#F6CB55", WebkitTextStroke: "0px transparent", textShadow: `0 ${2 * frameScale}px ${9 * frameScale}px rgba(0,0,0,.75)` }}>
          {hook.subheadline}
        </p>
      )}
    </div>
  ) : (
    <div style={{ display: "inline-block", maxWidth: "100%" }}>
      <p style={commonHeadline}>{hook.headline}</p>
      {hook.subheadline && <p style={commonSubheadline}>{hook.subheadline}</p>}
    </div>
  );

  return (
    <div
      data-headline-hook-text="true"
      style={{
        width: "100%",
        textAlign: "center",
        opacity: motion.opacity,
        transform: `translateY(${motion.translateY * frameScale}px) scale(${motion.scale})`,
        transformOrigin: "center center",
      }}
    >
      {content}
    </div>
  );
}
