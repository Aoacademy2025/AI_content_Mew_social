import type { KeywordPopupItem, SubtitleStylePreset } from "@/remotion/types";

export type Cap = { text: string; startMs: number; endMs: number; tag?: "hook" | "body" | "cta" };
export type KeywordPopupOpts = {
  fps: number;
  durationInFrames: number;
  subtitleSize: number;
  primaryColor: string;
  accentColor: string;
  subtitleStylePreset?: SubtitleStylePreset;
  subtitlePosition: number;
  subtitleFontWeight: number;
};

// Auto-scale font size down for longer phrases so they fit on one line (1080px wide, 88% usable = ~950px)
function autoScaleSize(text: string, baseSize: number): number {
  const usableWidth = 950; // 1080 * 0.88
  const charWidthRatio = 0.85;
  const maxCharsOneLine = Math.floor(usableWidth / (baseSize * charWidthRatio));
  const len = text.length;
  if (len <= maxCharsOneLine) return baseSize;
  const scale = Math.max(0.6, maxCharsOneLine / len);
  return Math.round(baseSize * scale);
}

function detectStyle(text: string, baseSize: number, primaryColor: string): { color: string; size: number; isHighlight: boolean } {
  const scaled = autoScaleSize(text, baseSize);
  return { color: primaryColor, size: scaled, isHighlight: false };
}

function normalizeKeywordPopups(popups: KeywordPopupItem[], durationInFrames: number): KeywordPopupItem[] {
  const totalFrames = Math.max(1, Math.round(Number(durationInFrames) || 1));
  const out: KeywordPopupItem[] = [];
  let cursor = 0;

  for (const popup of popups) {
    if (cursor >= totalFrames) break;
    let start = Number.isFinite(Number(popup.start)) ? Math.round(Number(popup.start)) : cursor;
    let end = Number.isFinite(Number(popup.end)) ? Math.round(Number(popup.end)) : start + 1;
    start = Math.min(Math.max(0, start, cursor), totalFrames - 1);
    end = Math.min(Math.max(end, start + 1), totalFrames);
    if (end <= start) continue;
    out.push({ ...popup, start, end });
    cursor = end;
  }

  return out;
}

/**
 * Pure subtitle-popup builder — extracted verbatim from generate-config so the window
 * b-roll flag can be proven NOT to alter subtitles (verify-subtitle-invariant.ts).
 */
export function buildKeywordPopups(popupCaptions: Cap[], opts: KeywordPopupOpts): KeywordPopupItem[] {
  const { fps, durationInFrames, subtitleSize, primaryColor, accentColor, subtitleStylePreset, subtitlePosition, subtitleFontWeight } = opts;
  return normalizeKeywordPopups(
    popupCaptions.map((c) => {
      const text = c.text.trim();
      const { color, size } = detectStyle(text, subtitleSize, primaryColor);
      const isHighlight = c.tag === "hook";
      const singleColor = subtitleStylePreset === "karaoke-box";
      const startFrame = Math.floor((c.startMs / 1000) * fps);
      const endFrame = Math.max(startFrame + 1, Math.ceil((c.endMs / 1000) * fps));
      return {
        text,
        start: startFrame,
        end: endFrame,
        color: singleColor ? color : isHighlight ? accentColor : color,
        size,
        isHighlight,
        topPercent: subtitlePosition,
        fontWeight: subtitleFontWeight,
        tag: c.tag,
        stylePreset: subtitleStylePreset,
      };
    }),
    durationInFrames,
  );
}
