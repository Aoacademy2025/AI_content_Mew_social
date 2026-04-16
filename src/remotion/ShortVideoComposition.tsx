import React from "react";
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { ShortVideoConfig, SubtitleStylePreset } from "./types";

const FONTS_CSS =
  "https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;700;800&family=Kanit:wght@700;900&family=Prompt:wght@600;700&family=Mitr:wght@400;500;600&family=Noto+Sans+Thai:wght@400;700;900&family=K2D:wght@400;700;800&family=Charm:wght@400;700&family=IBM+Plex+Sans+Thai:wght@400;600;700&family=Itim&family=Bai+Jamjuree:wght@600;700&family=Chonburi&family=Pridi:wght@600;700&family=Krub:wght@600;700&display=swap";

function renderSubtitle(
  text: string,
  color: string,
  size: number,
  isHighlight: boolean,
  preset: SubtitleStylePreset,
  fontFamily: string,
  fontWeight: number = 900,
) {
  const base: React.CSSProperties = {
    fontFamily,
    fontSize: `${size}px`,
    fontWeight,
    lineHeight: 1.3,
    display: "block",
    letterSpacing: "0.01em",
    wordBreak: "break-word",
    overflowWrap: "break-word",
    color,
    maxWidth: "100%",
  };

  switch (preset) {
    case "box":
      return (
        <div style={{ display: "block", background: "rgba(0,0,0,0.62)", padding: "6px 20px 8px", borderRadius: 0 }}>
          <span style={{ ...base, textShadow: "0 2px 8px rgba(0,0,0,0.9)" }}>{text}</span>
        </div>
      );
    case "box-rounded":
      return (
        <div style={{ display: "block", background: "rgba(0,0,0,0.70)", padding: "8px 24px 10px", borderRadius: 16 }}>
          <span style={{ ...base, textShadow: "0 2px 8px rgba(0,0,0,0.8)" }}>{text}</span>
        </div>
      );
    case "glow": {
      // Parse hex color to build rgba glow
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      return (
        <span style={{
          ...base,
          textShadow: `0 0 20px rgba(${r},${g},${b},0.9), 0 0 40px rgba(${r},${g},${b},0.6), 0 0 60px rgba(${r},${g},${b},0.4), 0 2px 4px rgba(0,0,0,0.8)`,
          WebkitTextStroke: "0px transparent",
        }}>{text}</span>
      );
    }
    case "outline-only":
      return (
        <span style={{
          ...base,
          color: "#fff",
          textShadow: "none",
          WebkitTextStroke: `3px ${color}`,
          paintOrder: "stroke fill",
        } as React.CSSProperties}>{text}</span>
      );
    case "stroke":
    default:
      return (
        <span style={{
          ...base,
          textShadow:
            "0 3px 0 #000, 0 -1px 0 #000, 1px 0 0 #000, -1px 0 0 #000, " +
            "0 4px 20px rgba(0,0,0,0.95), 0 8px 32px rgba(0,0,0,0.8)",
          WebkitTextStroke: isHighlight ? "3px #000" : "2px #000",
          paintOrder: "stroke fill",
        } as React.CSSProperties}>{text}</span>
      );
  }
}

export function ShortVideoComposition({
  bgVideos,
  keywordPopups,
  voiceFile,
  voiceVolume = 1,
  bgmFile,
  bgmVolume = 0.12,
  fontFamily,
  subtitleStylePreset = "stroke",
}: ShortVideoConfig) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const resolvedFont = fontFamily || "'Kanit', 'Noto Sans Thai', sans-serif";

  // Current keyword popup — use < end so adjacent captions don't overlap by 1 frame
  const popup = keywordPopups.find((p) => frame >= p.start && frame < p.end);
  const preset = popup?.stylePreset ?? subtitleStylePreset ?? "stroke";

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#000",
        fontFamily: resolvedFont,
        overflow: "hidden",
      }}
    >
      {/* Load Google Fonts */}
      <link rel="stylesheet" href={FONTS_CSS} />

      {/* Stock video segments — OffthreadVideo decodes via ffmpeg, supports all codecs */}
      {bgVideos.flatMap((v, i) => {
        const startFrame      = Math.round(v.start * fps);
        const segDurFrames    = Math.max(1, Math.round((v.end - v.start) * fps));
        const clipOffsetFrames = Math.round((v.clipOffset ?? 0) * fps);
        const clipDurFrames   = v.clipDuration && v.clipDuration > 0
          ? Math.max(1, Math.round(v.clipDuration * fps))
          : null;

        // OffthreadVideo doesn't support loop prop — we must render one <Sequence>
        // per "loop iteration" so startFrom stays within the source clip duration.
        const iterations = clipDurFrames
          ? Math.ceil(segDurFrames / clipDurFrames)
          : 1;

        return Array.from({ length: iterations }, (_, iter) => {
          const iterStart  = iter * (clipDurFrames ?? segDurFrames);
          const iterDur    = clipDurFrames
            ? Math.min(clipDurFrames, segDurFrames - iterStart)
            : segDurFrames;
          if (iterDur <= 0) return null;

          // startFrom restarts at the clip offset for each iteration
          const startFrom = iter === 0 ? clipOffsetFrames : 0;

          return (
            <Sequence
              key={`${i}-${iter}`}
              from={startFrame + iterStart}
              durationInFrames={iterDur}
              layout="none"
            >
              <AbsoluteFill>
                <OffthreadVideo
                  src={v.src}
                  startFrom={startFrom}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: width,
                    height: height,
                    objectFit: "cover",
                  }}
                  muted
                />
              </AbsoluteFill>
            </Sequence>
          );
        });
      })}

      {/* TTS voice */}
      {voiceFile && <Audio src={voiceFile} volume={voiceVolume} />}

      {/* Background music */}
      {bgmFile && <Audio src={bgmFile} volume={bgmVolume ?? 0.12} loop />}

      {/* Subtitle */}
      {popup && (
        <AbsoluteFill style={{ pointerEvents: "none" }}>
          <div
            style={{
              position: "absolute",
              top: `${popup.topPercent ?? 75}%`,
              left: 0,
              right: 0,
              transform: "translateY(-50%)",
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <div style={{ maxWidth: "88%", width: "100%", textAlign: "center", paddingLeft: "6%", paddingRight: "6%" }}>
              {renderSubtitle(popup.text, popup.color, popup.size, popup.isHighlight, preset, resolvedFont, popup.fontWeight ?? 900)}
            </div>
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
}
