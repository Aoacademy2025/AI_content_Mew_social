import React from "react";
import { baseGraphemeCount } from "../lib/card-line-budget";
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
const THAI_CHAR_RE = /[\u0E00-\u0E7F]/u;
const WORD_JOINER = "\u2060";
const ZERO_WIDTH_SPACE = "\u200B";

const PRESET_WRAP_METRICS: Record<
  HeadlineHookPreset,
  { headlineScale: number; subheadlineScale: number; horizontalChromePx: number }
> = {
  viral: { headlineScale: 0.96, subheadlineScale: 0.96, horizontalChromePx: 36 },
  news: { headlineScale: 0.88, subheadlineScale: 0.88, horizontalChromePx: 70 },
  clean: { headlineScale: 0.86, subheadlineScale: 0.94, horizontalChromePx: 66 },
  banner: { headlineScale: 0.88, subheadlineScale: 0.88, horizontalChromePx: 70 },
  "stat-burst": { headlineScale: 0.9, subheadlineScale: 0.88, horizontalChromePx: 70 },
  "question-pill": { headlineScale: 0.85, subheadlineScale: 0.86, horizontalChromePx: 74 },
};

function headlineOneLineBudget(fontSizePx: number, horizontalChromePx: number): number {
  const usableWidth = Math.max(320, HEADLINE_CONTAINER_WIDTH_PX - horizontalChromePx);
  const safeSize = Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx : 84;
  return Math.max(10, Math.floor(usableWidth / (safeSize * 0.47)));
}

/**
 * Prevents ugly single-word Thai orphans at the end of wrapped headlines (such as
 * `เลิกนั่งหา B-Roll เองทีละ\nซีน!` or `ไอเดียเต็มหัว แต่คลิปไม่\nเสร็จ?`) without
 * inserting literal `\n` characters: binds the final unspaced `\u200B` break opportunity
 * with `\u2060` (WORD JOINER) when the trailing word is short and the combined tail fits
 * comfortably within half the line budget. Stripping invisible controls (`\u2060\u200B`)
 * restores the authored text 100% verbatim.
 */
function bindTrailingThaiOrphans(segmented: string, oneLineBudget: number): string {
  // 1. Keep short hyphenated compounds (e.g. "B-Roll", "1-Click", "Z-Image") whole on one line
  // using U+2060 WORD JOINER so Chromium wraps at the surrounding space instead of "B-\nRoll".
  let prepared = segmented.replace(
    /\b([A-Za-z0-9]{1,8})-([A-Za-z0-9]{1,8})\b/gu,
    `$1${WORD_JOINER}-${WORD_JOINER}$2`,
  );
  // 2. When a new Thai clause starts after an ASCII space with a short conjunction (" แต่คลิป...",
  // " ให้จบ...", " เพราะ..."), bind the conjunction to its following word so Chromium wraps AT
  // the space before the conjunction ("ไอเดียเต็มหัว\nแต่คลิปไม่เสร็จ?") instead of stranding "แต่" at line end.
  prepared = prepared.replace(
    /(\s)((?:แต่|เพราะ|หรือ|และ|ให้|จน|แค่)(?:\u2060[\u0E00-\u0E7F])*)\u200B/gu,
    `$1$2${WORD_JOINER}`,
  );

  if (!prepared.includes(ZERO_WIDTH_SPACE)) return prepared;
  const maxTailGraphemes = Math.max(7, Math.min(12, Math.floor(oneLineBudget * 0.54)));

  const bindClauseEndOrphan = (clause: string, isLineEnd: boolean): string => {
    const lastZws = clause.lastIndexOf(ZERO_WIDTH_SPACE);
    if (lastZws <= 0) return clause;
    const tail = clause.slice(lastZws + 1).replace(/[\u2060\u200B]/gu, "");
    if (!tail || /\s/u.test(tail)) return clause;
    const tailGraphemes = baseGraphemeCount(tail);
    if (tailGraphemes > 6) return clause;
    const before = clause.slice(0, lastZws);
    const prevBreak = before.lastIndexOf(ZERO_WIDTH_SPACE);
    if (isLineEnd && prevBreak < 0) return clause;
    const prevSeg = before.slice(prevBreak >= 0 ? prevBreak + 1 : 0).replace(/[\u2060\u200B]/gu, "");
    const combinedGraphemes = baseGraphemeCount(prevSeg + tail);
    if (combinedGraphemes > maxTailGraphemes) return clause;
    return before + WORD_JOINER + clause.slice(lastZws + 1);
  };

  return prepared
    .split("\n")
    .map((line) => {
      const parts = line.split(/(\s+)/u);
      const hasMultipleClauses = parts.length > 1;
      return parts
        .map((part, idx) => {
          if (!part || /^\s+$/u.test(part)) return part;
          const isLastClause = idx === parts.length - 1;
          return bindClauseEndOrphan(part, isLastClause && !hasMultipleClauses);
        })
        .join("");
    })
    .join("\n");
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

const cleanContour = (scale: number, strokePx = 1.4) => ({
  WebkitTextStroke: `${Math.max(0.6, strokePx * scale)}px rgba(6, 9, 18, 0.88)`,
  paintOrder: "stroke fill" as const,
  textShadow: `0 ${Math.max(2, 4 * scale)}px ${Math.max(6, 18 * scale)}px rgba(0,0,0,0.86), 0 ${Math.max(1, 2 * scale)}px ${Math.max(2, 5 * scale)}px rgba(0,0,0,0.78)`,
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
  const hasThai = THAI_CHAR_RE.test(hook.headline) || THAI_CHAR_RE.test(hook.subheadline ?? "");
  // Optically calibrate Thai weights: Kanit/Prompt 900 closes Thai loop counters and collides
  // tone marks; 700 (Bold) + 500 (Medium) gives crisp editorial contrast and hierarchy.
  const effectiveHeadlineWeight = hasThai
    ? (weights.headline >= 800 ? 700 : weights.headline)
    : weights.headline;
  const effectiveSubWeight = hasThai
    ? (weights.subheadline >= 800 ? 500 : weights.subheadline >= 600 ? 500 : 400)
    : weights.subheadline;

  const presetMetrics = PRESET_WRAP_METRICS[hook.preset] ?? PRESET_WRAP_METRICS.viral;
  const headlineSize = sizes.headline * frameScale;
  const subheadlineSize = sizes.subheadline * frameScale;
  const fontFamily = headlineHookFontCssFamily(hook.fontFamily);
  const headlineBudget = headlineOneLineBudget(
    sizes.headline * presetMetrics.headlineScale,
    presetMetrics.horizontalChromePx,
  );
  const subheadlineBudget = headlineOneLineBudget(
    sizes.subheadline * presetMetrics.subheadlineScale,
    presetMetrics.horizontalChromePx,
  );
  const headlineText = bindTrailingThaiOrphans(
    segmentThaiDisplayWordBreaks(hook.headline),
    headlineBudget,
  );
  const subheadlineText = hook.subheadline
    ? bindTrailingThaiOrphans(
        segmentThaiDisplayWordBreaks(hook.subheadline),
        subheadlineBudget,
      )
    : undefined;

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
    color: "#F8FAFC",
    fontFamily,
    fontSize: headlineSize,
    fontWeight: effectiveHeadlineWeight,
    lineHeight: hasThai ? 1.34 : 1.15,
    letterSpacing: hasThai ? "0.01em" : `${-0.6 * frameScale}px`,
    textAlign: "center",
    textWrap: "balance" as React.CSSProperties["textWrap"],
    whiteSpace: "pre-line",
    wordBreak: "keep-all",
    overflowWrap: headlineOverflowWrap,
    ...cleanContour(frameScale, hasThai ? 1.3 : 2.2),
  };
  const commonSubheadline: React.CSSProperties = {
    margin: 0,
    marginTop: 12 * frameScale,
    color: "#FDE047",
    fontFamily,
    fontSize: subheadlineSize,
    fontWeight: effectiveSubWeight,
    lineHeight: hasThai ? 1.36 : 1.22,
    letterSpacing: hasThai ? "0.01em" : "0px",
    textAlign: "center",
    textWrap: "balance" as React.CSSProperties["textWrap"],
    whiteSpace: "pre-line",
    wordBreak: "keep-all",
    overflowWrap: subheadlineOverflowWrap,
    ...cleanContour(frameScale, hasThai ? 1.0 : 1.8),
  };

  const softCardShadow = `0 ${12 * frameScale}px ${34 * frameScale}px rgba(0, 0, 0, 0.42)`;
  const subtleTextShadow = `0 ${2 * frameScale}px ${10 * frameScale}px rgba(0, 0, 0, 0.65)`;

  const content = hook.preset === "news" ? (
    <div
      style={{
        display: "inline-flex",
        maxWidth: "100%",
        boxSizing: "border-box",
        alignItems: "stretch",
        borderRadius: 18 * frameScale,
        overflow: "hidden",
        background: "rgba(9, 13, 22, 0.86)",
        border: `${Math.max(1, 1 * frameScale)}px solid rgba(255, 255, 255, 0.14)`,
        boxShadow: softCardShadow,
      }}
    >
      <span
        style={{
          width: 6 * frameScale,
          flex: "none",
          background: "linear-gradient(180deg, #FB7185 0%, #E11D48 100%)",
        }}
      />
      <div
        style={{
          minWidth: 0,
          boxSizing: "border-box",
          padding: `${22 * frameScale}px ${30 * frameScale}px ${24 * frameScale}px`,
        }}
      >
        <p
          style={{
            ...commonHeadline,
            fontSize: headlineSize * 0.88,
            WebkitTextStroke: "0px transparent",
            textShadow: subtleTextShadow,
          }}
        >
          {headlineText}
        </p>
        {subheadlineText && (
          <p
            style={{
              ...commonSubheadline,
              fontSize: subheadlineSize * 0.88,
              color: "#FDA4AF",
              WebkitTextStroke: "0px transparent",
              textShadow: "none",
            }}
          >
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
        padding: `${22 * frameScale}px ${32 * frameScale}px ${24 * frameScale}px`,
        borderRadius: 24 * frameScale,
        background: "rgba(10, 14, 24, 0.72)",
        border: `${Math.max(1, 1 * frameScale)}px solid rgba(255, 255, 255, 0.14)`,
        boxShadow: softCardShadow,
      }}
    >
      <p
        style={{
          ...commonHeadline,
          fontSize: headlineSize * 0.86,
          WebkitTextStroke: "0px transparent",
          textShadow: subtleTextShadow,
        }}
      >
        {headlineText}
      </p>
      {subheadlineText && (
        <p
          style={{
            ...commonSubheadline,
            fontSize: subheadlineSize * 0.94,
            color: "#FDE68A",
            WebkitTextStroke: "0px transparent",
            textShadow: subtleTextShadow,
          }}
        >
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
        padding: `${24 * frameScale}px ${34 * frameScale}px ${26 * frameScale}px`,
        borderRadius: 22 * frameScale,
        background: "linear-gradient(180deg, rgba(15, 23, 42, 0.88) 0%, rgba(9, 13, 22, 0.94) 100%)",
        border: `${Math.max(1, 1 * frameScale)}px solid rgba(251, 146, 60, 0.28)`,
        boxShadow: `${softCardShadow}, inset 0 ${3.5 * frameScale}px 0 rgba(251, 146, 60, 0.9)`,
      }}
    >
      <p
        style={{
          ...commonHeadline,
          fontSize: headlineSize * 0.88,
          color: "#FFFFFF",
          WebkitTextStroke: "0px transparent",
          textShadow: subtleTextShadow,
        }}
      >
        {headlineText}
      </p>
      {subheadlineText && (
        <p
          style={{
            ...commonSubheadline,
            fontSize: subheadlineSize * 0.88,
            color: "#FED7AA",
            WebkitTextStroke: "0px transparent",
            textShadow: "none",
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
        padding: `${24 * frameScale}px ${34 * frameScale}px ${26 * frameScale}px`,
        borderRadius: 24 * frameScale,
        background: "radial-gradient(120% 90% at 50% 0%, rgba(250, 204, 21, 0.16) 0%, rgba(10, 14, 24, 0.90) 68%)",
        border: `${Math.max(1, 1.2 * frameScale)}px solid rgba(250, 204, 21, 0.34)`,
        boxShadow: softCardShadow,
      }}
    >
      <p
        style={{
          ...commonHeadline,
          fontSize: headlineSize * 0.9,
          color: "#FEF08A",
          WebkitTextStroke: "0px transparent",
          textShadow: subtleTextShadow,
        }}
      >
        {headlineText}
      </p>
      {subheadlineText && (
        <p
          style={{
            ...commonSubheadline,
            fontSize: subheadlineSize * 0.88,
            color: "#F1F5F9",
            WebkitTextStroke: "0px transparent",
            textShadow: "none",
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
        padding: `${22 * frameScale}px ${36 * frameScale}px ${24 * frameScale}px`,
        borderRadius: 28 * frameScale,
        background: "linear-gradient(145deg, rgba(15, 23, 42, 0.88) 0%, rgba(23, 37, 84, 0.86) 100%)",
        border: `${Math.max(1, 1.2 * frameScale)}px solid rgba(125, 211, 252, 0.30)`,
        boxShadow: softCardShadow,
      }}
    >
      <p
        style={{
          ...commonHeadline,
          fontSize: headlineSize * 0.85,
          color: "#F8FAFC",
          WebkitTextStroke: "0px transparent",
          textShadow: subtleTextShadow,
        }}
      >
        {headlineText}
      </p>
      {subheadlineText && (
        <p
          style={{
            ...commonSubheadline,
            fontSize: subheadlineSize * 0.86,
            color: "#BAE6FD",
            WebkitTextStroke: "0px transparent",
            textShadow: "none",
          }}
        >
          {subheadlineText}
        </p>
      )}
    </div>
  ) : (
    <div
      style={{
        display: "inline-block",
        maxWidth: "100%",
        boxSizing: "border-box",
        padding: `${16 * frameScale}px ${22 * frameScale}px`,
        background: "radial-gradient(closest-side, rgba(6, 9, 18, 0.42) 0%, rgba(6, 9, 18, 0.16) 56%, rgba(6, 9, 18, 0) 100%)",
      }}
    >
      <p style={{ ...commonHeadline, fontSize: headlineSize * 0.96 }}>{headlineText}</p>
      {subheadlineText && (
        <p style={{ ...commonSubheadline, fontSize: subheadlineSize * 0.96 }}>{subheadlineText}</p>
      )}
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
