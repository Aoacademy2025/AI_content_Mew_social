import React from "react";
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { ShortVideoConfig, SubtitleStylePreset, SubtitleTextEffect } from "./types";
import { renderSubtitle } from "./renderSubtitle";

// Re-export for backwards compatibility with any other importers
export { renderSubtitle };

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
  // Clamp endAt so we never ask for frames past the actual clip duration —
  // prevents Remotion "No frame found at position X" compositor errors.
  const rawEndAt = startFrom + totalFrames;
  const endAt = clipDurFrames ? Math.min(rawEndAt, clipDurFrames - 1) : rawEndAt;

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
        background: "radial-gradient(ellipse 120% 80% at center, transparent 55%, rgba(0,0,0,0.35) 100%)",
      }} />
    </AbsoluteFill>
  );
}

// ─── Subtitle rendering ───────────────────────────────────────────────────────
// Moved to ./renderSubtitle.tsx so the editor preview imports the SAME function.
// Re-exported at the top of this file for callers that already imported it from here.
// ─────────────────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- duplicate impl removed (see ./renderSubtitle.tsx)
function __removed_legacy_renderSubtitle(
  text: string,
  color: string,
  size: number,
  isHighlight: boolean,
  preset: SubtitleStylePreset,
  fontFamily: string,
  fontWeight: number = 900,
  frame = 0,
  captionDurFrames = 1,
  textEffect: SubtitleTextEffect = "pop",
  accentColor = "#FFE500",
) {
  const charCount = text.length;
  const lengthScale = charCount <= 6 ? 1 : charCount <= 12 ? 0.9 : charCount <= 20 ? 0.78 : 0.68;
  const scaledSize = Math.round(size * lengthScale);

  const base: React.CSSProperties = {
    fontFamily,
    fontSize: `${scaledSize}px`,
    fontWeight,
    lineHeight: 1.25,
    display: "block",
    textAlign: "center",
    width: "100%",
    letterSpacing: "0.01em",
    whiteSpace: "normal",
    wordBreak: "break-all",
    overflowWrap: "anywhere",
    color,
  };

  // ── Caption Styles that fully own their own rendering (ignore Text Effect) ────
  // These presets have fixed colors/design — Text Effect only controls animation container
  const LOCKED_PRESETS: SubtitleStylePreset[] = [
    "classic-yellow", "hormozi", "beast", "neon-green", "neon-red", "neon-blue",
    "pastel", "retro", "box-white", "box-yellow", "news",
  ];

  // ── Text Effects that render special inline content ────────────────────────
  // Only apply if preset is NOT locked (locked presets own their own render)
  if (!LOCKED_PRESETS.includes(preset)) {
    if (textEffect === "glow-pulse") {
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      const pulse = 0.6 + 0.4 * Math.sin((frame / captionDurFrames) * Math.PI * 4);
      return (
        <span style={{
          ...base,
          textShadow: `0 0 ${20 + pulse * 20}px rgba(${r},${g},${b},${0.7 + pulse * 0.3}), 0 0 ${40 + pulse * 30}px rgba(${r},${g},${b},0.5), 0 2px 4px rgba(0,0,0,0.8)`,
        }}>{text}</span>
      );
    }

    if (textEffect === "highlight") {
      const progress = captionDurFrames > 0 ? Math.min(frame / (captionDurFrames * 0.6), 1) : 1;
      const stroke = "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000";
      return (
        <div style={{ position: "relative", display: "inline-block" }}>
          <div style={{
            position: "absolute",
            top: "10%", bottom: "10%",
            left: 0,
            width: `${progress * 100}%`,
            background: accentColor,
            opacity: 0.35,
            borderRadius: 4,
            zIndex: 0,
          }} />
          <span style={{ ...base, position: "relative", zIndex: 1, textShadow: stroke }}>{text}</span>
        </div>
      );
    }

    if (textEffect === "karaoke") {
      const tokens = text.split(/\s+/).filter(w => w.length > 0);
      const totalChars = tokens.reduce((s, w) => s + w.length, 0) || 1;
      const cumulative: number[] = [];
      let cum = 0;
      for (const w of tokens) { cum += w.length / totalChars; cumulative.push(cum); }
      const progress = captionDurFrames > 0 ? frame / captionDurFrames : 1;
      const activeIdx = cumulative.findIndex(c => progress < c);
      const active = activeIdx === -1 ? tokens.length - 1 : activeIdx;
      const stroke = "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 2px 8px rgba(0,0,0,0.95)";
      const inner = (
        <span style={{ ...base, display: "inline", textShadow: stroke }}>
          {tokens.map((word, i) => (
            <React.Fragment key={i}>
              <span style={{
                color: i === active ? accentColor : `${color}60`,
                fontWeight: i === active ? fontWeight : Math.min(fontWeight, 500),
              }}>{word}</span>
              {i < tokens.length - 1 ? " " : null}
            </React.Fragment>
          ))}
        </span>
      );
      if (preset === "box") return <div style={{ display: "inline-block", background: "rgba(0,0,0,0.65)", padding: "6px 20px 8px", borderRadius: 4 }}>{inner}</div>;
      if (preset === "box-rounded") return <div style={{ display: "inline-block", background: "rgba(0,0,0,0.72)", padding: "8px 24px 10px", borderRadius: 16 }}>{inner}</div>;
      if (preset === "karaoke-box") return <div style={{ display: "inline-block", background: "rgba(0,0,0,0.75)", padding: "8px 22px 10px", borderRadius: 12 }}>{inner}</div>;
      return inner;
    }

    if (textEffect === "typewriter") {
      const totalChars = text.length;
      const charsToShow = Math.min(totalChars, Math.floor((frame / Math.max(1, captionDurFrames)) * totalChars) + 1);
      const stroke = "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 2px 8px rgba(0,0,0,0.95)";
      const inner = (
        <span style={{ ...base, display: "inline", textShadow: stroke }}>
          <span style={{ color }}>{text.slice(0, charsToShow)}</span>
          <span style={{ color: "transparent" }}>{text.slice(charsToShow)}</span>
        </span>
      );
      if (preset === "box") return <div style={{ display: "inline-block", background: "rgba(0,0,0,0.65)", padding: "6px 20px 8px", borderRadius: 4 }}>{inner}</div>;
      if (preset === "box-rounded") return <div style={{ display: "inline-block", background: "rgba(0,0,0,0.72)", padding: "8px 24px 10px", borderRadius: 16 }}>{inner}</div>;
      return inner;
    }
  }

  // bounce / quick / fade / slide / flip / glow-pulse on locked presets — fall through to preset switch

  switch (preset) {
    case "plain":
      return <span style={{ ...base }}>{text}</span>;
    case "shadow":
      return <span style={{ ...base, textShadow: "0 4px 16px rgba(0,0,0,1), 0 2px 4px rgba(0,0,0,0.9)" }}>{text}</span>;
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

    case "neon-green":
      return <span style={{ ...base, color: "#00ff88", textShadow: "0 0 8px #00ff88, 0 0 20px #00ff88, 0 0 40px #00cc66, 0 2px 4px rgba(0,0,0,0.9)" }}>{text}</span>;

    case "neon-red":
      return <span style={{ ...base, color: "#ff3344", textShadow: "0 0 8px #ff3344, 0 0 20px #ff1133, 0 0 40px #cc0022, 0 2px 4px rgba(0,0,0,0.9)" }}>{text}</span>;

    case "neon-blue":
      return <span style={{ ...base, color: "#00cfff", textShadow: "0 0 8px #00cfff, 0 0 20px #0099ff, 0 0 40px #0055cc, 0 2px 4px rgba(0,0,0,0.9)" }}>{text}</span>;

    case "bold-shadow":
      return <span style={{ ...base, fontWeight: Math.max(fontWeight, 900), textShadow: "0 6px 0 rgba(0,0,0,0.9), 0 10px 20px rgba(0,0,0,0.8), 0 2px 0 rgba(0,0,0,1)" }}>{text}</span>;

    case "karaoke-box":
      return (
        <div style={{ display: "inline-block", background: "rgba(0,0,0,0.75)", padding: "8px 22px 10px", borderRadius: 12 }}>
          <span style={{ ...base }}>{text}</span>
        </div>
      );

    case "pop-outline": {
      const cInv = color === "#ffffff" || color === "#fff" ? "#000000" : "#ffffff";
      return <span style={{ ...base, WebkitTextStroke: `2px ${cInv}`, paintOrder: "stroke fill" } as React.CSSProperties}>{text}</span>;
    }

    case "pastel":
      return <span style={{ ...base, color: "#ffb3d9", textShadow: "0 2px 8px rgba(255,100,180,0.5), 0 1px 0 rgba(0,0,0,0.5)" }}>{text}</span>;

    case "classic-yellow":
      return (
        <span style={{
          ...base, color: "#FFE500",
          textShadow: "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 4px 12px rgba(0,0,0,0.9)",
          WebkitTextStroke: "1.5px #000", paintOrder: "stroke fill",
        } as React.CSSProperties}>{text}</span>
      );

    case "hormozi":
      return (
        <span style={{
          ...base, color: "#ff2244", fontStyle: "italic", fontWeight: Math.max(fontWeight, 800),
          textShadow: "-2px -2px 0 #fff, 2px -2px 0 #fff, -2px 2px 0 #fff, 2px 2px 0 #fff, 0 4px 16px rgba(200,0,30,0.6)",
          WebkitTextStroke: "1px #fff", paintOrder: "stroke fill",
        } as React.CSSProperties}>{text}</span>
      );

    case "beast":
      return (
        <span style={{
          ...base, color: "#ffffff",
          textShadow: "-2px -2px 0 #ff8800, 2px -2px 0 #ff8800, -2px 2px 0 #ff8800, 2px 2px 0 #ff8800, 0 0 20px rgba(255,140,0,0.5)",
          WebkitTextStroke: "2px #ff8800", paintOrder: "stroke fill",
        } as React.CSSProperties}>{text}</span>
      );

    case "box-white":
      return (
        <div style={{ display: "inline-block", background: "#ffffff", padding: "6px 20px 8px", borderRadius: 4 }}>
          <span style={{ ...base, color: "#111111", textShadow: "none" }}>{text}</span>
        </div>
      );

    case "box-yellow":
      return (
        <div style={{ display: "inline-block", background: "#FFE500", padding: "6px 20px 8px", borderRadius: 6 }}>
          <span style={{ ...base, color: "#111111", textShadow: "none" }}>{text}</span>
        </div>
      );

    case "retro":
      return (
        <span style={{
          ...base, color: "#ff6600",
          textShadow: "2px 2px 0 #cc3300, 4px 4px 0 rgba(150,0,0,0.5), 0 6px 16px rgba(200,50,0,0.4)",
        }}>{text}</span>
      );

    case "sharp-outline":
      return (
        <span style={{
          ...base, color: "#ffffff",
          WebkitTextStroke: `3px ${color}`, paintOrder: "stroke fill",
          textShadow: "0 3px 10px rgba(0,0,0,0.8)",
        } as React.CSSProperties}>{text}</span>
      );

    case "news":
      return (
        <div style={{ display: "inline-block", background: "rgba(0,0,0,0.88)", padding: "5px 18px 7px" }}>
          <span style={{ ...base, color: "#ffffff", textShadow: "none", letterSpacing: "0.05em" }}>{text}</span>
        </div>
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
export function AnimatedSubtitle({
  popup,
  preset,
  resolvedFont,
  captionDurFrames,
  textEffect = "pop",
  accentColor = "#FFE500",
}: {
  popup: NonNullable<ShortVideoConfig["keywordPopups"]>[number];
  preset: SubtitleStylePreset;
  resolvedFont: string;
  captionDurFrames: number;
  textEffect?: SubtitleTextEffect;
  accentColor?: string;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── per-effect container animation ──────────────────────────────────────────

  // "pop" — default: scale bounce + slight slide up
  const popSpring = spring({ frame, fps, config: { mass: 0.6, damping: 10, stiffness: 180 }, durationInFrames: 12 });

  // "bounce" — overshoot spring (bouncier)
  const bounceSpring = spring({ frame, fps, config: { mass: 0.5, damping: 6, stiffness: 220 }, durationInFrames: 18 });

  // "quick" — ultra-fast snap, 4-frame spring
  const quickSpring = spring({ frame, fps, config: { mass: 0.4, damping: 18, stiffness: 400 }, durationInFrames: 6 });

  // "slide" — slide up from below (no scale)
  const slideSpring = spring({ frame, fps, config: { mass: 0.7, damping: 14, stiffness: 140 }, durationInFrames: 16 });

  // "flip" — perspective flip from 90deg
  const flipSpring = spring({ frame, fps, config: { mass: 0.6, damping: 12, stiffness: 160 }, durationInFrames: 14 });

  const fadeIn  = interpolate(frame, [0, 5], [0, 1], { extrapolateRight: "clamp" });
  const fadeOut = interpolate(frame, [captionDurFrames - 4, captionDurFrames], [1, 0], { extrapolateLeft: "clamp" });
  const baseFade = Math.min(fadeIn, fadeOut);

  let transform = "translateY(-50%)";
  let opacity = baseFade;
  let extra: React.CSSProperties = {};

  if (textEffect === "pop") {
    const sc = interpolate(popSpring, [0, 1], [0.76, 1.0]);
    const sy = interpolate(popSpring, [0, 1], [6, 0]);
    transform = `translateY(calc(-50% + ${sy}px)) scale(${sc})`;
  } else if (textEffect === "bounce") {
    const sc = interpolate(bounceSpring, [0, 1], [0.5, 1.0]);
    const sy = interpolate(bounceSpring, [0, 1], [14, 0]);
    transform = `translateY(calc(-50% + ${sy}px)) scale(${sc})`;
  } else if (textEffect === "quick") {
    const sc = interpolate(quickSpring, [0, 1], [0.6, 1.0]);
    const sy = interpolate(quickSpring, [0, 1], [8, 0]);
    transform = `translateY(calc(-50% + ${sy}px)) scale(${sc})`;
  } else if (textEffect === "fade") {
    opacity = Math.min(interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" }), fadeOut);
    transform = "translateY(-50%)";
  } else if (textEffect === "slide") {
    const sy = interpolate(slideSpring, [0, 1], [40, 0]);
    opacity = Math.min(interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" }), fadeOut);
    transform = `translateY(calc(-50% + ${sy}px))`;
  } else if (textEffect === "flip") {
    const angle = interpolate(flipSpring, [0, 1], [90, 0]);
    opacity = Math.min(interpolate(frame, [0, 6], [0, 1], { extrapolateRight: "clamp" }), fadeOut);
    transform = `translateY(-50%) perspective(600px) rotateX(${angle}deg)`;
    extra = { transformOrigin: "center top" };
  } else if (textEffect === "glow-pulse") {
    // No entry animation — glow pulses via CSS animation approximated with sine via frame
    const pulse = 0.7 + 0.3 * Math.sin((frame / fps) * Math.PI * 2 * 1.5);
    extra = { filter: `brightness(${pulse + 0.3})` };
    transform = "translateY(-50%)";
  } else if (textEffect === "highlight") {
    // Slide-in for container, highlight bar handled in renderSubtitle
    const sc = interpolate(popSpring, [0, 1], [0.92, 1.0]);
    transform = `translateY(-50%) scale(${sc})`;
  } else {
    // karaoke / typewriter — pop container
    const sc = interpolate(popSpring, [0, 1], [0.92, 1.0]);
    const sy = interpolate(popSpring, [0, 1], [4, 0]);
    transform = `translateY(calc(-50% + ${sy}px)) scale(${sc})`;
  }

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{
        position: "absolute",
        top: `${popup.topPercent ?? 72}%`,
        left: 0,
        right: 0,
        transform,
        transformOrigin: "center center",
        opacity,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        ...extra,
      }}>
        <div style={{ maxWidth: "80%", textAlign: "center", paddingLeft: "10%", paddingRight: "10%", display: "flex", justifyContent: "center", alignItems: "center" }}>
          {renderSubtitle(popup.text, popup.color, popup.size, popup.isHighlight, preset, resolvedFont, popup.fontWeight ?? 900, frame, captionDurFrames, textEffect, popup.accentColor ?? accentColor)}
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
  subtitleTextEffect = "pop",
  subtitleAccentColor = "#FFE500",
}: ShortVideoConfig) {
  const { fps, durationInFrames } = useVideoConfig();

  const resolvedFont = fontFamily || "'Kanit', 'Noto Sans Thai', sans-serif";
  const preset = subtitleStylePreset ?? "stroke";
  const textEffect: SubtitleTextEffect = subtitleTextEffect ?? "pop";
  const accentColor = subtitleAccentColor ?? "#FFE500";

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
            <AnimatedSubtitle popup={p} preset={capPreset} resolvedFont={resolvedFont} captionDurFrames={dur} textEffect={textEffect} accentColor={accentColor} />
          </Sequence>
        );
      })}

      {/* Fade to black at end */}
      <EndFade totalFrames={durationInFrames} />
    </AbsoluteFill>
  );
}
