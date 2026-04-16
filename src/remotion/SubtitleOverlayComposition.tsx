import React from "react";
import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig } from "remotion";
import type { SubtitleOverlayConfig } from "./types";

const FONTS_CSS =
  "https://fonts.googleapis.com/css2?family=Kanit:wght@700;900&family=Noto+Sans+Thai:wght@700;900&display=swap";

/**
 * Renders a background video (with its original audio) + KeywordPopup subtitle overlay.
 * Used as the final subtitle pass — Kanit Bold via Google Fonts, Layer 4 per spec.
 */
export function SubtitleOverlayComposition({
  videoUrl,
  keywordPopups,
  fontFamily,
}: SubtitleOverlayConfig) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const resolvedFont = fontFamily || "'Kanit', 'Noto Sans Thai', sans-serif";
  const popup = keywordPopups.find((p) => frame >= p.start && frame <= p.end);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", fontFamily: resolvedFont, overflow: "hidden" }}>
      <link rel="stylesheet" href={FONTS_CSS} />

      {/* Background video — plays WITH original audio (TTS + BGM already mixed in) */}
      <OffthreadVideo
        src={videoUrl}
        style={{ position: "absolute", top: 0, left: 0, width, height, objectFit: "cover" }}
      />

      {/* Layer 4: Keyword popup subtitle — Kanit Bold, spec colors + stroke */}
      {popup && (
        <AbsoluteFill style={{ pointerEvents: "none" }}>
          <div
            style={{
              position: "absolute",
              top: `${popup.topPercent ?? 38}%`,
              left: 0,
              right: 0,
              textAlign: "center",
              padding: "0 48px",
            }}
          >
            <span
              style={{
                color: popup.color,
                fontSize: `${popup.size}px`,
                fontWeight: 900,
                lineHeight: 1.25,
                display: "inline-block",
                // Drop shadow for depth
                textShadow: "0 3px 14px rgba(0,0,0,1), 0 6px 28px rgba(0,0,0,0.8)",
                // Stroke via WebkitTextStroke — thicker on highlights
                WebkitTextStroke: popup.isHighlight ? "3px #000" : "2px #000",
                // paintOrder ensures stroke renders behind fill (Chrome/Chromium ✅)
                paintOrder: "stroke fill",
              } as React.CSSProperties}
            >
              {popup.text}
            </span>
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
}
