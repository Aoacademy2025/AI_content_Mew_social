import React from "react";
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Sequence,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { ShortVideoConfig, SubtitleStylePreset } from "./types";

const FONTS_CSS =
  "https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;700;800&family=Kanit:wght@700;900&family=Prompt:wght@600;700&family=Mitr:wght@400;500;600&family=Noto+Sans+Thai:wght@400;700;900&family=K2D:wght@400;700;800&family=Charm:wght@400;700&family=IBM+Plex+Sans+Thai:wght@400;600;700&family=Itim&family=Bai+Jamjuree:wght@600;700&family=Chonburi&family=Pridi:wght@600;700&family=Krub:wght@600;700&display=swap";

// Ken Burns zoom directions — alternate per clip for visual variety
const KB_CONFIGS = [
  { startScale: 1.0, endScale: 1.08, originX: "50%", originY: "50%" },
  { startScale: 1.08, endScale: 1.0, originX: "55%", originY: "45%" },
  { startScale: 1.0, endScale: 1.08, originX: "45%", originY: "55%" },
  { startScale: 1.06, endScale: 1.0, originX: "50%", originY: "40%" },
  { startScale: 1.0, endScale: 1.06, originX: "52%", originY: "52%" },
];

function VideoClip({
  src,
  startFrom,
  clipIndex,
  segDurFrames,
  isFirst,
}: {
  src: string;
  startFrom: number;
  clipIndex: number;
  segDurFrames: number;
  isFirst: boolean;
}) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  const kb = KB_CONFIGS[clipIndex % KB_CONFIGS.length];
  const progress = segDurFrames > 1 ? frame / (segDurFrames - 1) : 0;
  const scale = interpolate(progress, [0, 1], [kb.startScale, kb.endScale]);

  // Fade windows: cap at half segment so they never overlap on short clips
  const fadeFrames = Math.min(6, Math.floor(segDurFrames / 2));
  const fadeInOpacity = isFirst ? 1 : interpolate(frame, [0, fadeFrames], [0, 1], { extrapolateRight: "clamp" });
  const fadeOutStart = Math.max(0, segDurFrames - fadeFrames);
  const fadeOutOpacity = fadeFrames > 0
    ? interpolate(frame, [fadeOutStart, segDurFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 1;
  const opacity = Math.min(fadeInOpacity, fadeOutOpacity);

  return (
    <AbsoluteFill style={{ opacity }}>
      <OffthreadVideo
        src={src}
        startFrom={startFrom}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width,
          height,
          objectFit: "cover",
          transform: `scale(${scale})`,
          transformOrigin: `${kb.originX} ${kb.originY}`,
        }}
        muted
      />
    </AbsoluteFill>
  );
}

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

function AnimatedSubtitle({
  popup,
  preset,
  resolvedFont,
  captionDurFrames,
}: {
  popup: NonNullable<ShortVideoConfig["keywordPopups"]>[number];
  preset: SubtitleStylePreset;
  resolvedFont: string;
  captionDurFrames: number;
}) {
  const frame = useCurrentFrame();

  // Pop in: scale 0.7→1.05→1.0 over first 8 frames + fade in
  const popScale = interpolate(
    frame,
    [0, 5, 8],
    [0.7, 1.05, 1.0],
    { extrapolateRight: "clamp" }
  );
  const popOpacity = interpolate(frame, [0, 4], [0, 1], { extrapolateRight: "clamp" });

  // Fade out last 4 frames
  const fadeOut = interpolate(
    frame,
    [captionDurFrames - 4, captionDurFrames],
    [1, 0],
    { extrapolateLeft: "clamp" }
  );

  const opacity = Math.min(popOpacity, fadeOut);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          top: `${popup.topPercent ?? 75}%`,
          left: 0,
          right: 0,
          transform: `translateY(-50%) scale(${popScale})`,
          transformOrigin: "center center",
          opacity,
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
  );
}

function Vignette() {
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{
        position: "absolute",
        inset: 0,
        background: "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)",
      }} />
    </AbsoluteFill>
  );
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
      <link rel="stylesheet" href={FONTS_CSS} />

      {/* Stock video segments with Ken Burns zoom + crossfade */}
      {bgVideos.flatMap((v, i) => {
        const startFrame = Math.round(v.start * fps);
        const segDurFrames = Math.max(1, Math.round((v.end - v.start) * fps));
        const clipDurFrames = v.clipDuration && v.clipDuration > 0
          ? Math.max(1, Math.round(v.clipDuration * fps))
          : null;
        const clipOffsetFrames = Math.round((v.clipOffset ?? 0) * fps);
        const initialStartFrom = (() => {
          if (!clipDurFrames) return 0;
          return ((clipOffsetFrames % clipDurFrames) + clipDurFrames) % clipDurFrames;
        })();

        const iterations = clipDurFrames ? Math.ceil(segDurFrames / clipDurFrames) : 1;

        return Array.from({ length: iterations }, (_, iter) => {
          const iterStart = iter * (clipDurFrames ?? segDurFrames);
          const iterDur = clipDurFrames
            ? Math.min(clipDurFrames, segDurFrames - iterStart)
            : segDurFrames;
          if (iterDur <= 0) return null;

          const startFromFrame = iter === 0 ? initialStartFrom : 0;

          return (
            <Sequence
              key={`${i}-${iter}`}
              from={startFrame + iterStart}
              durationInFrames={iterDur}
              layout="none"
            >
              <VideoClip
                src={v.src}
                startFrom={startFromFrame}
                clipIndex={i}
                segDurFrames={iterDur}
                isFirst={i === 0 && iter === 0}
              />
            </Sequence>
          );
        });
      })}

      {/* Vignette overlay — darkens edges for cinematic look */}
      <Vignette />

      {/* TTS voice */}
      {voiceFile && <Audio src={voiceFile} volume={voiceVolume} />}

      {/* Background music */}
      {bgmFile && <Audio src={bgmFile} volume={bgmVolume ?? 0.12} loop />}

      {/* Animated subtitle — pop in + fade out per caption */}
      {popup && (
        <Sequence
          key={`sub-${popup.start}`}
          from={popup.start}
          durationInFrames={popup.end - popup.start}
          layout="none"
        >
          <AnimatedSubtitle
            popup={popup}
            preset={preset}
            resolvedFont={resolvedFont}
            captionDurFrames={popup.end - popup.start}
          />
        </Sequence>
      )}
    </AbsoluteFill>
  );
}
