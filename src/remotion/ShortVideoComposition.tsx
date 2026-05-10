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

// CROSSFADE_FRAMES: how many frames both clips are visible simultaneously.
const CROSSFADE_FRAMES = 8;

const GRADE_FILTER = "brightness(0.92) contrast(1.12) saturate(1.08)";

// ─── VideoClip ────────────────────────────────────────────────────────────────
function VideoClip({
  src,
  startFrom,
  segDurFrames,
  tailFrames,
  headFrames,
  clipDurFrames,
  clipIndex,
}: {
  src: string;
  startFrom: number;
  segDurFrames: number;
  tailFrames: number;
  headFrames: number;
  clipDurFrames: number | null;
  clipIndex: number;
}) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  const totalFrames = segDurFrames + tailFrames;
  const endAt = startFrom + totalFrames;

  // Opacity: fade-in (entry) × fade-out (tail for next clip)
  const fadeIn  = headFrames > 0 ? interpolate(frame, [0, headFrames], [0, 1], { extrapolateRight: "clamp" }) : 1;
  const fadeOut = tailFrames > 0
    ? interpolate(frame, [segDurFrames, segDurFrames + tailFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 1;
  const opacity = Math.min(fadeIn, fadeOut);

  return (
    <AbsoluteFill style={{ opacity }}>
      <OffthreadVideo
        src={src}
        startFrom={startFrom}
        endAt={endAt}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width,
          height,
          objectFit: "cover",
          filter: GRADE_FILTER,
        }}
        muted
      />
    </AbsoluteFill>
  );
}

// ─── Cinematic overlay ────────────────────────────────────────────────────────
function CinematicOverlay() {
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{
        position: "absolute",
        inset: 0,
        background: "rgba(20, 10, 40, 1)",
        opacity: 0.06,
        mixBlendMode: "multiply",
      }} />
      <div style={{
        position: "absolute",
        inset: 0,
        background: "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.60) 100%)",
      }} />
    </AbsoluteFill>
  );
}

// ─── Subtitle rendering ───────────────────────────────────────────────────────
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
        <div style={{ display: "inline-block", background: "rgba(0,0,0,0.65)", padding: "6px 20px 8px", borderRadius: 4 }}>
          <span style={{ ...base, textShadow: "0 2px 8px rgba(0,0,0,0.9)" }}>{text}</span>
        </div>
      );
    case "box-rounded":
      return (
        <div style={{ display: "inline-block", background: "rgba(0,0,0,0.72)", padding: "8px 24px 10px", borderRadius: 16 }}>
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
          textShadow: `0 0 20px rgba(${r},${g},${b},0.9), 0 0 40px rgba(${r},${g},${b},0.6), 0 2px 4px rgba(0,0,0,0.8)`,
        }}>{text}</span>
      );
    }
    case "outline-only":
      return (
        <span style={{
          ...base,
          color: "#fff",
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
            "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 3px 8px rgba(0,0,0,0.95)",
          WebkitTextStroke: "2px #000",
          paintOrder: "stroke fill",
        } as React.CSSProperties}>{text}</span>
      );
  }
}

// ─── Animated subtitle ────────────────────────────────────────────────────────
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
  const { fps } = useVideoConfig();

  const popSpring = spring({
    frame,
    fps,
    config: { mass: 0.6, damping: 10, stiffness: 180 },
    durationInFrames: 12,
  });
  const popScale = interpolate(popSpring, [0, 1], [0.76, 1.0]);
  const slideY   = interpolate(popSpring, [0, 1], [6, 0]);
  const fadeIn   = interpolate(frame, [0, 5], [0, 1], { extrapolateRight: "clamp" });
  const fadeOut  = interpolate(frame, [captionDurFrames - 4, captionDurFrames], [1, 0], { extrapolateLeft: "clamp" });
  const opacity  = Math.min(fadeIn, fadeOut);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{
        position: "absolute",
        top: `${popup.topPercent ?? 72}%`,
        left: 0,
        right: 0,
        transform: `translateY(calc(-50% + ${slideY}px)) scale(${popScale})`,
        transformOrigin: "center center",
        opacity,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}>
        <div style={{ maxWidth: "88%", width: "100%", textAlign: "center", paddingLeft: "6%", paddingRight: "6%" }}>
          {renderSubtitle(popup.text, popup.color, popup.size, popup.isHighlight, preset, resolvedFont, popup.fontWeight ?? 900)}
        </div>
      </div>
    </AbsoluteFill>
  );
}

// ─── Fade to black at end ─────────────────────────────────────────────────────
const FADE_OUT_FRAMES = 12; // 0.4s at 30fps

function EndFade({ totalFrames }: { totalFrames: number }) {
  const frame = useCurrentFrame();
  const fadeStart = totalFrames - FADE_OUT_FRAMES;
  const opacity = interpolate(frame, [fadeStart, totalFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (opacity <= 0) return null;
  return <AbsoluteFill style={{ background: "#000", opacity, pointerEvents: "none" }} />;
}

// ─── Main composition ─────────────────────────────────────────────────────────
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
  const { fps, durationInFrames } = useVideoConfig();

  const resolvedFont = fontFamily || "'Kanit', 'Noto Sans Thai', sans-serif";
  const preset = subtitleStylePreset ?? "stroke";

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", fontFamily: resolvedFont, overflow: "hidden" }}>
      <link rel="stylesheet" href={FONTS_CSS} />

      {/* ── Stock video clips ─────────────────────────────────────────────── */}
      {(() => {
        // 1. Convert bgVideos to integer frame ranges
        type Seg = { src: string; startFrame: number; endFrame: number; clipOffset: number; clipDuration: number | null };
        const segs: Seg[] = [];
        for (const v of bgVideos) {
          const startFrame = Math.max(0, Math.round(v.start * fps));
          const endFrame   = Math.max(startFrame + 1, Math.round(v.end * fps));
          const clipDuration = v.clipDuration && v.clipDuration > 0 ? v.clipDuration : null;
          const clipOffset   = v.clipOffset ?? 0;
          // Merge adjacent segments with same src (tolerance 1 frame for rounding)
          const last = segs[segs.length - 1];
          if (last && last.src === v.src && Math.abs(last.endFrame - startFrame) <= 1) {
            last.endFrame = endFrame;
          } else {
            segs.push({ src: v.src, startFrame, endFrame, clipOffset, clipDuration });
          }
        }

        // 2. Render each segment as a Sequence
        //    - Each clip's Sequence starts AT its hard-cut frame (no early start)
        //    - Each clip's Sequence extends CROSSFADE_FRAMES PAST its endFrame (tail)
        //      so the next clip can dissolve in over it
        //    - The next clip fades in over its first CROSSFADE_FRAMES (head)
        //    - Result: both clips are always visible during the transition → no black gap
        return segs.map((v, i) => {
          const isLast        = i === segs.length - 1;
          const segDurFrames  = v.endFrame - v.startFrame; // nominal duration
          const tailFrames    = isLast ? 0 : CROSSFADE_FRAMES; // stay visible for next clip's fade-in
          const headFrames    = i === 0 ? 0 : CROSSFADE_FRAMES; // fade in over previous clip

          const clipDurFrames = v.clipDuration ? Math.max(1, Math.round(v.clipDuration * fps)) : null;
          const clipOffsetFrames = Math.round(v.clipOffset * fps);
          const startFromFrame = clipDurFrames
            ? ((clipOffsetFrames % clipDurFrames) + clipDurFrames) % clipDurFrames
            : 0;

          // Sequence starts at the hard-cut frame, runs for segDurFrames + tailFrames
          const seqFrom = v.startFrame;
          const seqDur  = segDurFrames + tailFrames;

          return (
            <Sequence key={`${i}-${v.src}-${v.startFrame}`} from={seqFrom} durationInFrames={seqDur} layout="none">
              <VideoClip
                src={v.src}
                startFrom={startFromFrame}
                segDurFrames={segDurFrames}
                tailFrames={tailFrames}
                headFrames={headFrames}
                clipDurFrames={clipDurFrames}
                clipIndex={i}
              />
            </Sequence>
          );
        });
      })()}

      {/* Cinematic overlay */}
      <CinematicOverlay />

      {/* TTS voice */}
      {voiceFile && <Audio src={voiceFile} volume={voiceVolume} />}

      {/* Background music */}
      {bgmFile && <Audio src={bgmFile} volume={bgmVolume ?? 0.12} loop />}

      {/* Subtitles */}
      {keywordPopups.map((p) => {
        const dur = p.end - p.start;
        if (dur <= 0) return null;
        const capPreset = p.stylePreset ?? preset;
        return (
          <Sequence key={`sub-${p.start}-${p.end}`} from={p.start} durationInFrames={dur} layout="none">
            <AnimatedSubtitle popup={p} preset={capPreset} resolvedFont={resolvedFont} captionDurFrames={dur} />
          </Sequence>
        );
      })}

      {/* Fade to black at end */}
      <EndFade totalFrames={durationInFrames} />
    </AbsoluteFill>
  );
}
