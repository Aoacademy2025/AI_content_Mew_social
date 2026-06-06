import React from "react";
import type { SubtitleStylePreset, SubtitleTextEffect } from "./types";

/**
 * Single source of truth for subtitle rendering.
 *
 * Used in BOTH:
 *   - Client preview overlay (video-editor /page.tsx, subtitle-renderer.tsx)
 *   - Remotion render passes (ShortVideoComposition, SubtitleOverlayComposition)
 *
 * What you see in preview IS what gets burned into the MP4.
 *
 * No `remotion` package imports — safe to call from a browser component.
 * `frame` and `captionDurFrames` are only used by frame-based text effects
 * (glow-pulse / highlight / karaoke / typewriter); pass 0 / 1 from preview
 * for the "static" look that matches the resting frame.
 */
export function renderSubtitle(
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

  // ── Entrance animation (pop / bounce / fade / quick / slide / flip) ──────────
  // These run at the START of each caption and were previously declared in the
  // type but never implemented, so captions just appeared statically. Driven by
  // `frame` (0 at caption start), they make subs "pop in" like kliprapp/CapCut.
  // Preview passes a live frame so it matches the burned MP4 exactly.
  // A negative frame is the "resting / fully-visible" sentinel used by static
  // preview cards (style/font pickers) that drive motion via CSS instead — it
  // skips the entrance transform so the text never renders at opacity 0. Live
  // callers (overlay + Remotion render) pass frame >= 0 to play the entrance.
  const entranceStyle: React.CSSProperties = (() => {
    if (frame < 0) return {};
    // ease-out cubic for snappy, professional motion
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
    // back-ease (overshoot) for bounce
    const easeBack = (t: number) => {
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    };
    const durFrames = (n: number) => Math.max(1, n);
    switch (textEffect) {
      case "pop": {        // scale 0.6→1 over ~7 frames
        const t = Math.min(1, frame / durFrames(7));
        const s = 0.6 + 0.4 * easeOut(t);
        return { transform: `scale(${s})`, opacity: Math.min(1, t * 1.5), transformOrigin: "center" };
      }
      case "bounce": {     // overshoot spring over ~10 frames
        const t = Math.min(1, frame / durFrames(10));
        const s = 0.5 + 0.5 * easeBack(t);
        return { transform: `scale(${s})`, opacity: Math.min(1, t * 2), transformOrigin: "center" };
      }
      case "quick": {      // ultra-fast snap ~3 frames
        const t = Math.min(1, frame / durFrames(3));
        return { transform: `scale(${0.85 + 0.15 * t})`, opacity: t, transformOrigin: "center" };
      }
      case "fade": {       // fade only, no scale ~8 frames
        const t = Math.min(1, frame / durFrames(8));
        return { opacity: easeOut(t) };
      }
      case "slide": {      // slide up from below ~9 frames
        const t = Math.min(1, frame / durFrames(9));
        return { transform: `translateY(${(1 - easeOut(t)) * 40}px)`, opacity: Math.min(1, t * 1.5) };
      }
      case "flip": {       // perspective Y flip-in ~10 frames
        const t = Math.min(1, frame / durFrames(10));
        return { transform: `perspective(400px) rotateX(${(1 - easeOut(t)) * 90}deg)`, opacity: Math.min(1, t * 2), transformOrigin: "center" };
      }
      default:
        return {}; // glow-pulse / highlight / karaoke / typewriter handle their own motion
    }
  })();

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
    ...entranceStyle,
  };

  // Caption Styles that fully own their own rendering (ignore Text Effect)
  const LOCKED_PRESETS: SubtitleStylePreset[] = [
    "classic-yellow", "hormozi", "beast", "neon-green", "neon-red", "neon-blue",
    "pastel", "retro", "box-white", "box-yellow", "news",
  ];

  // ── Text Effects that render special inline content ────────────────────────
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
      // frame < 0 = resting/static preview → show full text (no reveal animation).
      const charsToShow = frame < 0
        ? totalChars
        : Math.max(0, Math.min(totalChars, Math.floor((frame / Math.max(1, captionDurFrames)) * totalChars) + 1));
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
  void isHighlight; // legacy parameter — coloring is now driven by `color`

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
      return <span style={{ ...base, color: "#00ff88", textShadow: "0 0 8px #00ff88, 0 0 20px #00ff88, 0 0 40px #00cc66" }}>{text}</span>;

    case "neon-red":
      return <span style={{ ...base, color: "#ff3344", textShadow: "0 0 8px #ff3344, 0 0 20px #ff1133, 0 0 40px #cc0022" }}>{text}</span>;

    case "neon-blue":
      return <span style={{ ...base, color: "#00cfff", textShadow: "0 0 8px #00cfff, 0 0 20px #0099ff, 0 0 40px #0055cc" }}>{text}</span>;

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
          WebkitTextStroke: "2px #000",
          paintOrder: "stroke fill",
        } as React.CSSProperties}>{text}</span>
      );
  }
}
