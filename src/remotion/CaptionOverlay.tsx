import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Caption } from "@remotion/captions";
import {
  CAPTION_STYLES,
  DEFAULT_CAPTION_STYLE,
  type CaptionStyleId,
  type CaptionStyleDef,
} from "./captionStyles";

// Keep old type exported for any external references
export type CaptionPosition = "top" | "center" | "bottom";

// ─── Main overlay ────────────────────────────────────────────────────────────

interface CaptionOverlayProps {
  captions: Caption[];
  captionStyleId?: CaptionStyleId;
  /** Override all style properties — takes priority over captionStyleId */
  customCaptionStyle?: CaptionStyleDef | null;
  /** Vertical position 0 (top) – 100 (bottom). Default 85. */
  positionY?: number;
  fontSizeOverride?: number;
  fontWeightOverride?: number;
}

export const CaptionOverlay: React.FC<CaptionOverlayProps> = ({
  captions,
  captionStyleId = DEFAULT_CAPTION_STYLE,
  customCaptionStyle,
  positionY = 85,
  fontSizeOverride,
  fontWeightOverride,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentMs = (frame / fps) * 1000;

  const style = customCaptionStyle ?? CAPTION_STYLES[captionStyleId] ?? CAPTION_STYLES[DEFAULT_CAPTION_STYLE];

  const active = captions.find((c) => c.startMs <= currentMs && c.endMs > currentMs);
  if (!active) return null;

  const fontSize = fontSizeOverride && fontSizeOverride > 0 ? fontSizeOverride : style.fontSize;
  const fontWeight = fontWeightOverride && fontWeightOverride > 0 ? fontWeightOverride : style.fontWeight;

  const textNode = style.activeBackground ? (
    <span
      style={{
        backgroundColor: style.activeBackground,
        color: style.activeTextColor ?? "#000",
        borderRadius: 6,
        padding: "2px 8px",
        textShadow: "none",
      }}
    >
      {active.text}
    </span>
  ) : (
    <span style={{ color: style.activeColor, textShadow: style.activeTextShadow }}>
      {active.text}
    </span>
  );

  const content = (
    <p
      style={{
        margin: 0,
        width: "100%",
        textAlign: "center",
        fontSize,
        fontFamily: style.fontFamily,
        fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing ?? "0.01em",
        wordBreak: "break-word",
        overflowWrap: "break-word",
      }}
    >
      {textNode}
    </p>
  );

  const inner = style.boxBackground ? (
    <div
      style={{
        background: style.boxBackground,
        borderRadius: style.boxBorderRadius ?? 8,
        padding: style.boxPadding ?? "10px 20px",
        maxWidth: "88%",
      }}
    >
      {content}
    </div>
  ) : (
    <div style={{ maxWidth: "88%", paddingLeft: "6%", paddingRight: "6%" }}>{content}</div>
  );

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {/* Absolute placement via positionY% from top, centered horizontally */}
      <div
        style={{
          position: "absolute",
          top: `${positionY}%`,
          left: 0,
          right: 0,
          transform: "translateY(-50%)",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        {inner}
      </div>
    </AbsoluteFill>
  );
};
