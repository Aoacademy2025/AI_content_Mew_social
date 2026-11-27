import type { HeadlineHookConfig } from "@/lib/headline-hook";
import { effectiveSfxMode, type SfxMode, type TransitionSfxCue } from "@/lib/transition-sfx";
import type {
  SubtitleOverlayConfig,
  SubtitleStylePreset,
  SubtitleTextEffect,
} from "@/remotion/types";

export type HeroEditorialCaption = {
  text: string;
  startMs: number;
  endMs: number;
  tag: "hook" | "body" | "cta";
};

export type HeroSubtitleDesign = {
  fontFamily: string;
  positionTopPercent: number;
  fontSize: number;
  fontWeight: number;
  color: string;
  accentColor: string;
  stylePreset: SubtitleStylePreset;
  textEffect: SubtitleTextEffect;
  shadow?: boolean;
  outline?: boolean;
  outlineSize?: number;
  highlightKeywords?: boolean;
  statCards?: boolean;
};

export type HeroTimedWord = {
  word: string;
  startMs: number;
  endMs: number;
};

/**
 * Shared editorial seam used by Hero Studio and internal Story Film renders.
 * Callers own caption/alignment policy; this module owns the exact Remotion
 * SubtitleOverlayComposition contract so preview and final burn cannot drift.
 */
export function buildHeroSubtitleOverlayConfig(input: {
  baseVideoUrl: string;
  captions: HeroEditorialCaption[];
  durationMs: number;
  fps?: number;
  design: HeroSubtitleDesign;
  headlineHook?: HeadlineHookConfig | null;
  sfxMode?: SfxMode;
  sfxCues?: TransitionSfxCue[];
  words?: readonly HeroTimedWord[] | null;
}): SubtitleOverlayConfig {
  const fps = input.fps ?? 30;
  const lastEndMs = input.captions.at(-1)?.endMs ?? 0;
  const durationMs = Math.max(input.durationMs, lastEndMs);
  const design = input.design;
  const resolvedSfxMode = effectiveSfxMode(input.sfxMode);
  const timedWords = Array.isArray(input.words) ? input.words : [];
  const rawPopups = input.captions.flatMap((caption) => {
    const start = Math.max(0, Math.round((caption.startMs / 1_000) * fps));
    const end = Math.min(
      Math.round((durationMs / 1_000) * fps),
      Math.max(start + 1, Math.round((caption.endMs / 1_000) * fps)),
    );
    if (!caption.text.trim() || end <= start) return [];
    const matchedWords = timedWords
      .filter((w) => w && typeof w.word === "string" && w.word.trim() && w.endMs > caption.startMs + 20 && w.startMs < caption.endMs - 20)
      .map((w) => ({
        word: w.word,
        startFrame: Math.max(start, Math.round((w.startMs / 1_000) * fps)),
        endFrame: Math.min(end, Math.max(start + 1, Math.round((w.endMs / 1_000) * fps))),
      }));
    return [{
      text: caption.text.trim(),
      start,
      end,
      tag: caption.tag,
      isHighlight: caption.tag === "hook",
      color: caption.tag === "hook" ? design.accentColor : design.color,
      accentColor: design.accentColor,
      fontWeight: design.fontWeight,
      topPercent: design.positionTopPercent,
      size: design.fontSize,
      stylePreset: design.stylePreset,
      ...(matchedWords.length > 0 ? { words: matchedWords } : {}),
    }];
  });
  const keywordPopups = rawPopups.map((popup, idx) => {
    const prev = idx > 0 ? rawPopups[idx - 1] : undefined;
    const next = idx + 1 < rawPopups.length ? rawPopups[idx + 1] : undefined;
    const contiguousPrev = prev ? popup.start - prev.end <= 2 : false;
    const contiguousNext = next ? next.start - popup.end <= 2 : false;
    return {
      ...popup,
      ...(contiguousPrev ? { contiguousPrev: true } : {}),
      ...(contiguousNext ? { contiguousNext: true } : {}),
    };
  });
  return {
    videoUrl: input.baseVideoUrl,
    keywordPopups,
    durationInFrames: Math.max(1, Math.round((durationMs / 1_000) * fps)),
    ...(input.headlineHook?.enabled ? { headlineHook: input.headlineHook } : {}),
    fontFamily: design.fontFamily,
    subtitleStylePreset: design.stylePreset,
    subtitleTextEffect: design.textEffect,
    subtitleAccentColor: design.accentColor,
    ...(design.shadow !== undefined ? { subtitleShadow: design.shadow } : {}),
    ...(design.outline !== undefined ? { subtitleOutline: design.outline } : {}),
    ...(design.outlineSize !== undefined ? { subtitleOutlineSize: design.outlineSize } : {}),
    ...(design.highlightKeywords ? { subtitleHighlightKeywords: true } : {}),
    ...(design.statCards ? { subtitleStatCards: true } : {}),
    ...(resolvedSfxMode === "subtle" ? { sfxMode: "subtle" } : {}),
    ...(resolvedSfxMode === "subtle" && input.sfxCues?.length ? { sfxCues: input.sfxCues } : {}),
  };
}
