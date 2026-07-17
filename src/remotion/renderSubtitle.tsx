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

// Parse a hex color (#rgb or #rrggbb) to RGB channels. "#fff" shorthand IS expanded;
// any other non-hex value ("rgb(...)", named colors) falls back to white instead of
// making parseInt() return NaN — which would yield an invalid "rgba(...,NaN,...)"
// textShadow that Chromium silently drops at render time. subtitleColor reaches here
// unvalidated from the render API, so this normalization is the safety net.
function hexToRgb(color: string): { r: number; g: number; b: number } {
  let hex = (color || "").trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(hex)) hex = hex.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) hex = "ffffff";
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

// ── Intl.Segmenter singleton ────────────────────────────────────────────────
// Constructing a Segmenter loads ICU word-break data and is expensive.
// segmentWords runs on EVERY subtitle render — in the editor preview that is
// 60×/sec during karaoke/highlight playback — so cache one instance per
// locale+granularity at module level instead of constructing per call.
const segmenterCache = new Map<string, Intl.Segmenter>();

function getSegmenter(locale: string, granularity: "word" | "grapheme" | "sentence"): Intl.Segmenter | null {
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (!Seg) return null;
  const key = `${locale}|${granularity}`;
  const cached = segmenterCache.get(key);
  if (cached) return cached;
  try {
    const seg = new Seg(locale, { granularity });
    segmenterCache.set(key, seg);
    return seg;
  } catch {
    return null;
  }
}

// Tokenize for per-word effects (highlight / karaoke) without losing any source
// characters. Separators stay in the output but do not participate in timing.
// Thai is written WITHOUT spaces between words, so a naive `split(/\s+/)`
// returns the whole line as one token → the entire caption highlights at once
// (illegible yellow-on-yellow block). Use Intl.Segmenter to split Thai into
// real words; it also handles spaced scripts (English) correctly.
type TokenPart = { text: string; isWordLike: boolean };

function segmentParts(s: string): TokenPart[] {
  const seg = getSegmenter("th", "word");
  if (seg) {
    const out: TokenPart[] = [];
    for (const { segment, isWordLike } of seg.segment(s)) {
      out.push({
        text: segment,
        isWordLike: isWordLike === true && segment.trim().length > 0,
      });
    }
    if (out.length > 0) return out;
  }

  const pieces = s.match(/\s+|[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]+/gu) ?? [];
  return pieces.map((part) => ({
    text: part,
    isWordLike: /[\p{L}\p{N}]/u.test(part),
  }));
}

type TokenLine = { parts: TokenPart[] };

function splitManualLines(s: string): string[] {
  return s.replace(/\r\n?/g, "\n").split("\n");
}

// Bounded cache: tokenization is frame-invariant, but tokenLines runs once per caption
// PER FRAME for karaoke/highlight (60×/s in preview; every frame at render). Cache by text
// so the ICU word-segmentation runs once per distinct caption instead of once per frame.
// The result is treated as read-only by all callers, so sharing the reference is safe.
const tokenLinesCache = new Map<string, TokenLine[]>();
const TOKEN_LINES_CACHE_MAX = 256;

function tokenLines(text: string): TokenLine[] {
  const cached = tokenLinesCache.get(text);
  if (cached) return cached;
  const result = splitManualLines(text).map((line) => ({
    parts: segmentParts(line),
  }));
  if (tokenLinesCache.size >= TOKEN_LINES_CACHE_MAX) {
    const oldest = tokenLinesCache.keys().next().value; // Map preserves insertion order
    if (oldest !== undefined) tokenLinesCache.delete(oldest);
  }
  tokenLinesCache.set(text, result);
  return result;
}

const KARAOKE_NUMERIC_MIN_ACTIVE_FRAMES = 8;

function activeTokenIndex(
  lines: TokenLine[],
  frame: number,
  captionDurFrames: number,
  numericMinActiveFrames = 0,
): number {
  const tokens = lines.flatMap((line) => line.parts).filter((part) => part.isWordLike);
  if (tokens.length === 0) return -1;

  // A one-character number received only ~0.1s under pure character-weighted
  // timing. For Karaoke, reserve a readable minimum for numeric tokens when the
  // caption has enough frames, then distribute the remaining time using the
  // existing character weights. Highlight passes 0 and keeps its old timing.
  const totalFrames = Math.max(1, Math.round(captionDurFrames));
  const numericCount = tokens.filter((part) => /\p{N}/u.test(part.text)).length;
  if (numericMinActiveFrames > 0 && numericCount > 0 && totalFrames >= tokens.length) {
    const nonNumericCount = tokens.length - numericCount;
    const numericMinimum = Math.min(
      numericMinActiveFrames,
      Math.max(1, Math.floor((totalFrames - nonNumericCount) / numericCount)),
    );
    const minimums = tokens.map((part) => /\p{N}/u.test(part.text) ? numericMinimum : 1);
    const remainingFrames = totalFrames - minimums.reduce((sum, value) => sum + value, 0);
    const totalWeight = tokens.reduce((sum, part) => sum + Math.max(1, part.text.length), 0);
    const exactExtras = tokens.map((part) => (
      remainingFrames * Math.max(1, part.text.length) / totalWeight
    ));
    const extras = exactExtras.map(Math.floor);
    let unassigned = remainingFrames - extras.reduce((sum, value) => sum + value, 0);
    const remainderOrder = exactExtras
      .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
      .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (let i = 0; i < remainderOrder.length && unassigned > 0; i++, unassigned--) {
      extras[remainderOrder[i].index] += 1;
    }

    const targetFrame = Math.max(0, Math.min(totalFrames - 1, Math.floor(frame)));
    let cumulativeFrames = 0;
    for (let index = 0; index < tokens.length; index++) {
      cumulativeFrames += minimums[index] + extras[index];
      if (targetFrame < cumulativeFrames) return index;
    }
    return tokens.length - 1;
  }

  const totalChars = tokens.reduce((sum, part) => sum + part.text.length, 0) || 1;
  const cumulative: number[] = [];
  let cum = 0;
  for (const part of tokens) {
    cum += part.text.length / totalChars;
    cumulative.push(cum);
  }
  const progress = captionDurFrames > 0 ? frame / captionDurFrames : 1;
  const activeIdx = cumulative.findIndex(c => progress < c);
  return activeIdx === -1 ? tokens.length - 1 : activeIdx;
}

export interface SubtitleDecorationOptions {
  shadow?: boolean;
  outline?: boolean;
  outlineSize?: number;
}

function mergeTextShadow(...parts: Array<React.CSSProperties["textShadow"] | undefined>): string | undefined {
  const values = parts
    .map((part) => typeof part === "string" ? part.trim() : "")
    .filter((part) => part.length > 0 && part !== "none");
  return values.length > 0 ? values.join(", ") : undefined;
}

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
  decorations: SubtitleDecorationOptions = {},
) {
  // Size by the LONGEST line, not total length: manual "\n" breaks split the caption across
  // lines, so counting "\n" + every line's chars would shrink multi-line captions for no
  // visual reason. Single-line text (no "\n") yields [text], so charCount is unchanged.
  const charCount = splitManualLines(text).reduce((longest, line) => Math.max(longest, line.length), 0);
  const lengthScale = charCount <= 6 ? 1 : charCount <= 12 ? 0.9 : charCount <= 20 ? 0.78 : 0.68;
  const scaledSize = Math.round(size * lengthScale);
  const outlineSize = Math.max(1, Math.min(12, Math.round(decorations.outlineSize ?? 2)));
  const manualShadow = decorations.shadow
    ? "0 5px 14px rgba(0,0,0,0.95), 0 2px 4px rgba(0,0,0,0.9)"
    : undefined;

  const withDecorations = (style: React.CSSProperties): React.CSSProperties => {
    if (!decorations.shadow && !decorations.outline) return style;
    const next: React.CSSProperties = { ...style };
    if (decorations.outline) {
      next.WebkitTextStroke = `${outlineSize}px #000`;
      next.paintOrder = "stroke fill";
    }
    if (manualShadow) {
      next.textShadow = mergeTextShadow(next.textShadow, manualShadow);
    }
    return next;
  };

  // NOTE: renderSubtitle renders the TEXT + per-character/word effects only
  // (glow-pulse / highlight / karaoke / typewriter). The container ENTRANCE
  // animation (pop/bounce/slide/flip scale+translate) is owned by the caller —
  // AnimatedSubtitle for render, and a matching wrapper in the editor preview —
  // so do NOT add entrance transforms here, or render would double-animate.

  const base: React.CSSProperties = {
    fontFamily,
    fontSize: `${scaledSize}px`,
    fontWeight,
    lineHeight: 1.25,
    display: "block",
    textAlign: "center",
    width: "100%",
    letterSpacing: "0.01em",
    whiteSpace: "pre-line",
    // FIX D: no wordBreak:"break-all" — it let Chromium cut a Thai word mid-syllable.
    // With it gone, Chromium's ICU Thai dictionary wraps on real word boundaries;
    // overflowWrap:"anywhere" stays as the emergency valve for an unbreakable run.
    overflowWrap: "anywhere",
    color,
  };

  // Caption Styles that fully own their own rendering (ignore Text Effect)
  const LOCKED_PRESETS: SubtitleStylePreset[] = [
    "classic-yellow", "hormozi", "beast", "neon-green", "neon-red", "neon-blue",
    "pastel", "retro", "box-white", "box-yellow", "news",
  ];

  // ── Text Effects that render special inline content ────────────────────────
  if (!LOCKED_PRESETS.includes(preset)) {
    if (textEffect === "glow-pulse") {
      const { r, g, b } = hexToRgb(color);
      const pulse = 0.6 + 0.4 * Math.sin((frame / captionDurFrames) * Math.PI * 4);
      return (
        <span style={withDecorations({
          ...base,
          textShadow: `0 0 ${20 + pulse * 20}px rgba(${r},${g},${b},${0.7 + pulse * 0.3}), 0 0 ${40 + pulse * 30}px rgba(${r},${g},${b},0.5), 0 2px 4px rgba(0,0,0,0.8)`,
        })}>{text}</span>
      );
    }

    if (textEffect === "highlight") {
      if (frame < 0) {
        return <span style={withDecorations({ ...base, display: "inline" })}>{text}</span>;
      }
      const lines = tokenLines(text);
      const active = activeTokenIndex(lines, frame, captionDurFrames);
      if (active < 0) {
        return <span style={withDecorations({ ...base, display: "inline" })}>{text}</span>;
      }
      // Thinner outline + drop shadow only — heavy 4-way stroke smeared the
      // small text into an unreadable blob. The active word reads dark-on-yellow,
      // so it needs no stroke; inactive words keep a light outline for contrast.
      let tokenIdx = 0;
      return (
        <span style={withDecorations({ ...base, display: "inline" })}>
          {lines.map((line, lineIdx) => (
            <React.Fragment key={lineIdx}>
              {line.parts.map((part, partIdx) => {
                if (!part.isWordLike) {
                  return <React.Fragment key={`${lineIdx}-${partIdx}`}>{part.text}</React.Fragment>;
                }
                const currentIdx = tokenIdx++;
                const isActive = currentIdx === active;
                return (
                  <span key={`${lineIdx}-${partIdx}`} style={withDecorations({
                    background: isActive ? accentColor : "transparent",
                    color: isActive ? "#000" : color,
                    borderRadius: "0.12em",
                    padding: isActive ? "0.02em 0.18em" : undefined,
                    textShadow: isActive ? "none" : "0 2px 6px rgba(0,0,0,0.9)",
                    WebkitTextStroke: isActive ? undefined : "1px rgba(0,0,0,0.85)",
                    paintOrder: "stroke fill",
                    boxDecorationBreak: "clone",
                    WebkitBoxDecorationBreak: "clone",
                  } as React.CSSProperties)}>{part.text}</span>
                );
              })}
              {lineIdx < lines.length - 1 ? <br /> : null}
            </React.Fragment>
          ))}
        </span>
      );
    }

    if (textEffect === "karaoke") {
      const stroke = "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 2px 8px rgba(0,0,0,0.95)";
      const lines = tokenLines(text);
      const wrapKaraoke = (inner: React.ReactNode) => {
        if (preset === "box") return <div style={{ display: "inline-block", background: "rgba(0,0,0,0.65)", padding: "6px 20px 8px", borderRadius: 4 }}>{inner}</div>;
        if (preset === "box-rounded") return <div style={{ display: "inline-block", background: "rgba(0,0,0,0.72)", padding: "8px 24px 10px", borderRadius: 16 }}>{inner}</div>;
        if (preset === "karaoke-box") return <div style={{ display: "inline-block", background: "rgba(0,0,0,0.75)", padding: "8px 22px 10px", borderRadius: 12 }}>{inner}</div>;
        return inner;
      };
      if (frame < 0) {
        return wrapKaraoke(
          <span style={withDecorations({ ...base, display: "inline", textShadow: stroke })}>{text}</span>,
        );
      }
      const active = activeTokenIndex(
        lines,
        frame,
        captionDurFrames,
        KARAOKE_NUMERIC_MIN_ACTIVE_FRAMES,
      );
      if (active < 0) {
        return wrapKaraoke(
          <span style={withDecorations({ ...base, display: "inline", textShadow: stroke })}>{text}</span>,
        );
      }
      let tokenIdx = 0;
      const inner = (
        <span style={withDecorations({ ...base, display: "inline", textShadow: stroke })}>
          {lines.map((line, lineIdx) => (
            <React.Fragment key={lineIdx}>
              {line.parts.map((part, partIdx) => {
                if (!part.isWordLike) {
                  return <React.Fragment key={`${lineIdx}-${partIdx}`}>{part.text}</React.Fragment>;
                }
                const currentIdx = tokenIdx++;
                const isActive = currentIdx === active;
                return (
                  <span key={`${lineIdx}-${partIdx}`} style={{
                    // Keep every token readable throughout playback. Karaoke is
                    // communicated by the accent color, not by making future
                    // words translucent against unpredictable video footage.
                    color: isActive ? accentColor : color,
                    fontWeight: isActive ? fontWeight : Math.min(fontWeight, 500),
                  }}>{part.text}</span>
                );
              })}
              {lineIdx < lines.length - 1 ? <br /> : null}
            </React.Fragment>
          ))}
        </span>
      );
      return wrapKaraoke(inner);
    }

    if (textEffect === "typewriter") {
      const totalChars = text.length;
      // frame < 0 = resting/static preview → show full text (no reveal animation).
      const charsToShow = frame < 0
        ? totalChars
        : Math.max(0, Math.min(totalChars, Math.floor((frame / Math.max(1, captionDurFrames)) * totalChars) + 1));
      const stroke = "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 2px 8px rgba(0,0,0,0.95)";
      const inner = (
        <span style={withDecorations({ ...base, display: "inline", textShadow: stroke })}>
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
      return <span style={withDecorations({ ...base })}>{text}</span>;
    case "shadow":
      return <span style={withDecorations({ ...base, textShadow: "0 4px 16px rgba(0,0,0,1), 0 2px 4px rgba(0,0,0,0.9)" })}>{text}</span>;
    case "box":
      return (
        <div style={{ display: "inline-block", background: "rgba(0,0,0,0.65)", padding: "6px 20px 8px", borderRadius: 4 }}>
          <span style={withDecorations({ ...base, textShadow: "0 2px 8px rgba(0,0,0,0.9)" })}>{text}</span>
        </div>
      );
    case "box-rounded":
      return (
        <div style={{ display: "inline-block", background: "rgba(0,0,0,0.72)", padding: "8px 24px 10px", borderRadius: 16 }}>
          <span style={withDecorations({ ...base, textShadow: "0 2px 8px rgba(0,0,0,0.8)" })}>{text}</span>
        </div>
      );
    case "glow": {
      const { r, g, b } = hexToRgb(color);
      return (
        <span style={withDecorations({
          ...base,
          textShadow: `0 0 20px rgba(${r},${g},${b},0.9), 0 0 40px rgba(${r},${g},${b},0.6), 0 2px 4px rgba(0,0,0,0.8)`,
        })}>{text}</span>
      );
    }
    case "outline-only":
      return (
        <span style={withDecorations({
          ...base,
          color: "#fff",
          WebkitTextStroke: `3px ${color}`,
          paintOrder: "stroke fill",
        } as React.CSSProperties)}>{text}</span>
      );

    case "neon-green":
      return <span style={withDecorations({ ...base, color: "#00ff88", textShadow: "0 0 8px #00ff88, 0 0 20px #00ff88, 0 0 40px #00cc66" })}>{text}</span>;

    case "neon-red":
      return <span style={withDecorations({ ...base, color: "#ff3344", textShadow: "0 0 8px #ff3344, 0 0 20px #ff1133, 0 0 40px #cc0022" })}>{text}</span>;

    case "neon-blue":
      return <span style={withDecorations({ ...base, color: "#00cfff", textShadow: "0 0 8px #00cfff, 0 0 20px #0099ff, 0 0 40px #0055cc" })}>{text}</span>;

    case "bold-shadow":
      return <span style={withDecorations({ ...base, fontWeight, textShadow: "0 6px 0 rgba(0,0,0,0.9), 0 10px 20px rgba(0,0,0,0.8), 0 2px 0 rgba(0,0,0,1)" })}>{text}</span>;

    case "karaoke-box":
      return (
        <div style={{ display: "inline-block", background: "rgba(0,0,0,0.75)", padding: "8px 22px 10px", borderRadius: 12 }}>
          <span style={withDecorations({ ...base })}>{text}</span>
        </div>
      );

    case "pop-outline": {
      const cInv = color === "#ffffff" || color === "#fff" ? "#000000" : "#ffffff";
      return <span style={withDecorations({ ...base, WebkitTextStroke: `2px ${cInv}`, paintOrder: "stroke fill" } as React.CSSProperties)}>{text}</span>;
    }

    case "pastel":
      return <span style={withDecorations({ ...base, color: "#ffb3d9", textShadow: "0 2px 8px rgba(255,100,180,0.5), 0 1px 0 rgba(0,0,0,0.5)" })}>{text}</span>;

    case "classic-yellow":
      return (
        <span style={withDecorations({
          ...base, color: "#FFE500",
          textShadow: "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 4px 12px rgba(0,0,0,0.9)",
          WebkitTextStroke: "1.5px #000", paintOrder: "stroke fill",
        } as React.CSSProperties)}>{text}</span>
      );

    case "hormozi":
      return (
        <span style={withDecorations({
          ...base, color: "#ff2244", fontStyle: "italic", fontWeight,
          textShadow: "-2px -2px 0 #fff, 2px -2px 0 #fff, -2px 2px 0 #fff, 2px 2px 0 #fff, 0 4px 16px rgba(200,0,30,0.6)",
          WebkitTextStroke: "1px #fff", paintOrder: "stroke fill",
        } as React.CSSProperties)}>{text}</span>
      );

    case "beast":
      return (
        <span style={withDecorations({
          ...base, color: "#ffffff",
          textShadow: "-2px -2px 0 #ff8800, 2px -2px 0 #ff8800, -2px 2px 0 #ff8800, 2px 2px 0 #ff8800, 0 0 20px rgba(255,140,0,0.5)",
          WebkitTextStroke: "2px #ff8800", paintOrder: "stroke fill",
        } as React.CSSProperties)}>{text}</span>
      );

    case "box-white":
      return (
        <div style={{ display: "inline-block", background: "#ffffff", padding: "6px 20px 8px", borderRadius: 4 }}>
          <span style={withDecorations({ ...base, color: "#111111", textShadow: "none" })}>{text}</span>
        </div>
      );

    case "box-yellow":
      return (
        <div style={{ display: "inline-block", background: "#FFE500", padding: "6px 20px 8px", borderRadius: 6 }}>
          <span style={withDecorations({ ...base, color: "#111111", textShadow: "none" })}>{text}</span>
        </div>
      );

    case "retro":
      return (
        <span style={withDecorations({
          ...base, color: "#ff6600",
          textShadow: "2px 2px 0 #cc3300, 4px 4px 0 rgba(150,0,0,0.5), 0 6px 16px rgba(200,50,0,0.4)",
        })}>{text}</span>
      );

    case "sharp-outline":
      return (
        <span style={withDecorations({
          ...base, color: "#ffffff",
          WebkitTextStroke: `3px ${color}`, paintOrder: "stroke fill",
          textShadow: "0 3px 10px rgba(0,0,0,0.8)",
        } as React.CSSProperties)}>{text}</span>
      );

    case "news":
      return (
        <div style={{ display: "inline-block", background: "rgba(0,0,0,0.88)", padding: "5px 18px 7px" }}>
          <span style={withDecorations({ ...base, color: "#ffffff", textShadow: "none", letterSpacing: "0.05em" })}>{text}</span>
        </div>
      );

    case "stroke":
    default:
      return (
        <span style={withDecorations({
          ...base,
          WebkitTextStroke: "2px #000",
          paintOrder: "stroke fill",
        } as React.CSSProperties)}>{text}</span>
      );
  }
}
