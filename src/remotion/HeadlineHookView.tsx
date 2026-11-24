import React from "react";
import {
  HEADLINE_HOOK_CANVAS_WIDTH_PX,
  headlineHookFontCssFamily,
  headlineHookFontSizes,
  headlineHookFontWeights,
  type HeadlineHookConfig,
  type HeadlineHookPreset,
} from "../lib/headline-hook";
import {
  hasExtremeUnbreakableToken,
  segmentThaiDisplayWordBreaks,
} from "./renderSubtitle";

export type HeadlineHookMotion = {
  opacity: number;
  translateY: number;
  scale: number;
};

// HeadlineHookOverlay and HeadlineHookPreview both anchor the headline at
// `left: "6%", right: "6%"` (88% of the 1080px canvas = 950.4px). Each preset's
// unscaled 1080-frame font scale and horizontal padding/border/bar are defined
// here once so overflow-safety budgeting is completely independent of
// `frameScale` — Web Editor preview and Remotion burn wrap identically.
const HEADLINE_CONTAINER_WIDTH_PX = HEADLINE_HOOK_CANVAS_WIDTH_PX * 0.88;

const PRESET_WRAP_METRICS: Record<
  HeadlineHookPreset,
  { headlineScale: number; subheadlineScale: number; horizontalChromePx: number }
> = {
  viral: { headlineScale: 1, subheadlineScale: 1, horizontalChromePx: 0 },
  news: { headlineScale: 0.9, subheadlineScale: 0.9, horizontalChromePx: 58 },
  clean: { headlineScale: 0.86, subheadlineScale: 1, horizontalChromePx: 48 },
  banner: { headlineScale: 0.88, subheadlineScale: 0.88, horizontalChromePx: 61 },
  "stat-burst": { headlineScale: 0.94, subheadlineScale: 0.9, horizontalChromePx: 62 },
  "question-pill": { headlineScale: 0.85, subheadlineScale: 0.86, horizontalChromePx: 69 },
};

function headlineOneLineBudget(fontSizePx: number, horizontalChromePx: number): number {
  const usableWidth = Math.max(320, HEADLINE_CONTAINER_WIDTH_PX - horizontalChromePx);
  const safeSize = Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx : 84;
  return Math.max(10, Math.floor(usableWidth / (safeSize * 0.47)));
}

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
  const sizes = headlineHookFontSizes(hook.headline, hook.fontSize, hook.subheadlineFontSize);
  const weights = headlineHookFontWeights(hook.fontWeight);
  const presetMetrics = PRESET_WRAP_METRICS[hook.preset] ?? PRESET_WRAP_METRICS.viral;
  const headlineSize = sizes.headline * frameScale;
  const subheadlineSize = sizes.subheadline * frameScale;
  const fontFamily = headlineHookFontCssFamily(hook.fontFamily);
  const headlineText = segmentThaiDisplayWordBreaks(hook.headline);
  const subheadlineText = hook.subheadline
    ? segmentThaiDisplayWordBreaks(hook.subheadline)
    : undefined;
  const headlineBudget = headlineOneLineBudget(
    sizes.headline * presetMetrics.headlineScale,
    presetMetrics.horizontalChromePx,
  );
  const subheadlineBudget = headlineOneLineBudget(
    sizes.subheadline * presetMetrics.subheadlineScale,
    presetMetrics.horizontalChromePx,
  );
  // Never use overflow-wrap:anywhere here — it lets Chromium break Thai words
  // at arbitrary characters. Keep word-boundary wrapping (keep-all + normal) by
  // default and allow break-word only when a single unbreakable token exceeds
  // the container's 1080-frame line budget.
  const headlineOverflowWrap: React.CSSProperties["overflowWrap"] =
    hasExtremeUnbreakableToken(hook.headline, headlineBudget) ? "break-word" : "normal";
  const subheadlineOverflowWrap: React.CSSProperties["overflowWrap"] =
    hook.subheadline && hasExtremeUnbreakableToken(hook.subheadline, subheadlineBudget)
      ? "break-word"
      : "normal";
  const commonHeadline: React.CSSProperties = {
    margin: 0,
    color: "#F8F7FC",
    fontFamily,
    fontSize: headlineSize,
    fontWeight: weights.headline,
    lineHeight: 1.08,
    letterSpacing: `${-1.2 * frameScale}px`,
    textAlign: "center",
    whiteSpace: "pre-line",
    wordBreak: "keep-all",
    overflowWrap: headlineOverflowWrap,
    ...outline(frameScale, 4),
  };
  const commonSubheadline: React.CSSProperties = {
    margin: 0,
    marginTop: 12 * frameScale,
    color: "#FFE44D",
    fontFamily,
    fontSize: subheadlineSize,
    fontWeight: weights.subheadline,
    lineHeight: 1.18,
    textAlign: "center",
    whiteSpace: "pre-line",
    wordBreak: "keep-all",
    overflowWrap: subheadlineOverflowWrap,
    ...outline(frameScale, 3),
  };

  const content = hook.preset === "news" ? (
    <div
      style={{
        display: "inline-flex",
        maxWidth: "100%",
        boxSizing: "border-box",
        alignItems: "stretch",
        background: "rgba(8, 8, 13, 0.88)",
        boxShadow: `0 ${8 * frameScale}px ${24 * frameScale}px rgba(0,0,0,.28)`,
      }}
    >
      <span style={{ width: 10 * frameScale, flex: "none", background: "#FF5A2F" }} />
      <div style={{ minWidth: 0, boxSizing: "border-box", padding: `${16 * frameScale}px ${24 * frameScale}px ${19 * frameScale}px` }}>
        <p style={{ ...commonHeadline, fontSize: headlineSize * 0.9, WebkitTextStroke: "0px transparent", textShadow: "none" }}>
          {headlineText}
        </p>
        {subheadlineText && (
          <p style={{ ...commonSubheadline, fontSize: subheadlineSize * 0.9, WebkitTextStroke: "0px transparent", textShadow: "none" }}>
            {subheadlineText}
          </p>
        )}
      </div>
    </div>
  ) : hook.preset === "clean" ? (
    <div
      style={{
        display: "inline-block",
        maxWidth: "100%",
        boxSizing: "border-box",
        padding: `${16 * frameScale}px ${24 * frameScale}px ${19 * frameScale}px`,
        borderRadius: 18 * frameScale,
        background: "rgba(8, 8, 13, 0.58)",
        boxShadow: `0 ${8 * frameScale}px ${28 * frameScale}px rgba(0,0,0,.22)`,
      }}
    >
      <p style={{ ...commonHeadline, fontSize: headlineSize * 0.86, WebkitTextStroke: "0px transparent", textShadow: `0 ${3 * frameScale}px ${12 * frameScale}px rgba(0,0,0,.8)` }}>
        {headlineText}
      </p>
      {subheadlineText && (
        <p style={{ ...commonSubheadline, color: "#F6CB55", WebkitTextStroke: "0px transparent", textShadow: `0 ${2 * frameScale}px ${9 * frameScale}px rgba(0,0,0,.75)` }}>
          {subheadlineText}
        </p>
      )}
    </div>
  ) : hook.preset === "banner" ? (
    <div
      style={{
        display: "inline-block",
        maxWidth: "100%",
        boxSizing: "border-box",
        padding: `${16 * frameScale}px ${28 * frameScale}px ${18 * frameScale}px`,
        borderRadius: 16 * frameScale,
        background: "linear-gradient(135deg, #F97316 0%, #EA580C 52%, #DC2626 100%)",
        border: `${Math.max(1, 2.5 * frameScale)}px solid rgba(255, 255, 255, 0.32)`,
        boxShadow: `0 ${12 * frameScale}px ${32 * frameScale}px rgba(0, 0, 0, 0.42)`,
      }}
    >
      <p
        style={{
          ...commonHeadline,
          fontSize: headlineSize * 0.88,
          color: "#FFFFFF",
          WebkitTextStroke: "0px transparent",
          textShadow: `0 ${3 * frameScale}px ${10 * frameScale}px rgba(0,0,0,.45)`,
        }}
      >
        {headlineText}
      </p>
      {subheadlineText && (
        <p
          style={{
            ...commonSubheadline,
            fontSize: subheadlineSize * 0.88,
            color: "#FEF08A",
            WebkitTextStroke: "0px transparent",
            textShadow: `0 ${2 * frameScale}px ${8 * frameScale}px rgba(0,0,0,.42)`,
          }}
        >
          {subheadlineText}
        </p>
      )}
    </div>
  ) : hook.preset === "stat-burst" ? (
    <div
      style={{
        display: "inline-block",
        maxWidth: "100%",
        boxSizing: "border-box",
        padding: `${18 * frameScale}px ${28 * frameScale}px ${20 * frameScale}px`,
        borderRadius: 22 * frameScale,
        background: "radial-gradient(circle at 50% 0%, rgba(250, 204, 21, 0.24), rgba(9, 10, 18, 0.94) 72%)",
        border: `${Math.max(1, 3 * frameScale)}px solid #FACC15`,
        boxShadow: `0 ${14 * frameScale}px ${36 * frameScale}px rgba(0, 0, 0, 0.52), 0 0 ${24 * frameScale}px rgba(250, 204, 21, 0.24)`,
      }}
    >
      <p
        style={{
          ...commonHeadline,
          fontSize: headlineSize * 0.94,
          color: "#FACC15",
          WebkitTextStroke: `${Math.max(1, 2.5 * frameScale)}px rgba(4, 4, 10, 0.92)`,
        }}
      >
        {headlineText}
      </p>
      {subheadlineText && (
        <p
          style={{
            ...commonSubheadline,
            fontSize: subheadlineSize * 0.9,
            color: "#F8FAFC",
            WebkitTextStroke: "0px transparent",
            textShadow: `0 ${2 * frameScale}px ${10 * frameScale}px rgba(0,0,0,.78)`,
          }}
        >
          {subheadlineText}
        </p>
      )}
    </div>
  ) : hook.preset === "question-pill" ? (
    <div
      style={{
        display: "inline-block",
        maxWidth: "100%",
        boxSizing: "border-box",
        padding: `${15 * frameScale}px ${32 * frameScale}px ${18 * frameScale}px`,
        borderRadius: 999 * frameScale,
        background: "linear-gradient(135deg, rgba(15, 23, 42, 0.92) 0%, rgba(30, 27, 75, 0.92) 100%)",
        border: `${Math.max(1, 2.5 * frameScale)}px solid rgba(56, 189, 248, 0.72)`,
        boxShadow: `0 ${10 * frameScale}px ${28 * frameScale}px rgba(0, 0, 0, 0.44)`,
      }}
    >
      <p
        style={{
          ...commonHeadline,
          fontSize: headlineSize * 0.85,
          color: "#F8FAFC",
          WebkitTextStroke: "0px transparent",
          textShadow: `0 ${2 * frameScale}px ${10 * frameScale}px rgba(0,0,0,.7)`,
        }}
      >
        {headlineText}
      </p>
      {subheadlineText && (
        <p
          style={{
            ...commonSubheadline,
            fontSize: subheadlineSize * 0.86,
            color: "#7DD3FC",
            WebkitTextStroke: "0px transparent",
            textShadow: `0 ${2 * frameScale}px ${8 * frameScale}px rgba(0,0,0,.65)`,
          }}
        >
          {subheadlineText}
        </p>
      )}
    </div>
  ) : (
    <div style={{ display: "inline-block", maxWidth: "100%", boxSizing: "border-box" }}>
      <p style={commonHeadline}>{headlineText}</p>
      {subheadlineText && <p style={commonSubheadline}>{subheadlineText}</p>}
    </div>
  );

  return (
    <div
      data-headline-hook-text="true"
      data-headline-hook-preset={hook.preset}
      style={{
        width: "100%",
        minWidth: 0,
        boxSizing: "border-box",
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
