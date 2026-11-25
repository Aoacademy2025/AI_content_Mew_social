import type { BrollTransition } from "@/lib/broll-window-style";
import {
  normalizeSubtitleStylePresetConfig,
  type SubtitleCardLen,
  type SubtitleStylePresetConfig,
} from "@/lib/editor-style-preset-contract";
import type { GeminiVoiceStyleId } from "@/lib/gemini-voice-styles";
import {
  applyHeadlineHookPatchWithFallback,
  createDefaultHeadlineHook,
  normalizeHeadlineHook,
  type HeadlineHookConfig,
  type HeadlineHookPreset,
} from "@/lib/headline-hook";
import {
  activeStylePacks,
  isActiveStylePackId,
  stylePack,
  stylePackSubtitlePreset,
  type ActiveStylePackId,
  type MusicMood,
  type PacingLevel,
  type StockMood,
  type StylePack,
} from "@/lib/style-pack-catalog";
import type { SfxMode } from "@/lib/transition-sfx";

export const TEMPLATE_VOICE_STYLE_BY_ID: Record<ActiveStylePackId, GeminiVoiceStyleId> = {
  "thai-ghost": "serious",
  "thai-history": "warm",
  "life-drama": "warm",
  "finance-clear": "serious",
  "news-fast": "excited",
  "health-simple": "warm",
  "premium-product": "warm",
  "comic-story": "excited",
  "shop-review": "cheerful",
  "listicle-fast": "excited",
  "ai-tech-doc": "serious",
  "true-crime": "serious",
  "self-growth": "warm",
};

export const TEMPLATE_TTS_SPEED_BY_PACING: Record<PacingLevel, number> = {
  slow: 0.94,
  normal: 1,
  fast: 1.08,
};

export type Step1TemplateDefaults = {
  templateId: ActiveStylePackId;
  thaiLabel: string;
  tagline: string;
  palette: [string, string, string];
  pacing: PacingLevel;
  ttsSpeed: number;
  geminiVoiceStyle: GeminiVoiceStyleId;
  musicMood: MusicMood;
  stockMood: StockMood;
  subtitleDefault: SubtitleStylePresetConfig;
  headlineHookPreset: HeadlineHookPreset;
  headlineHook?: HeadlineHookConfig;
  highlightKeywords: boolean;
  statCards: boolean;
  sfxMode: SfxMode;
  punchZoom: boolean;
  brollTransition: BrollTransition;
};

export function resolveStep1TemplateDefaults(
  templateId: ActiveStylePackId,
  options?: {
    currentHeadlineHook?: HeadlineHookConfig | null;
    scriptText?: string;
    estimatedDurationMs?: number;
  },
): Step1TemplateDefaults {
  const pack = stylePack(templateId);
  const rawSubtitle = stylePackSubtitlePreset(pack);
  const subtitleDefault = normalizeSubtitleStylePresetConfig(rawSubtitle) ?? rawSubtitle;
  const durationMs = Math.max(1_000, options?.estimatedDurationMs ?? 60_000);
  const existingHook = options?.currentHeadlineHook ?? null;
  const sourceText = options?.scriptText?.trim() ?? "";

  let headlineHook: HeadlineHookConfig | undefined;
  if (existingHook && existingHook.headline.trim().length > 0) {
    headlineHook = normalizeHeadlineHook(
      { ...existingHook, preset: pack.headlineHookPreset, enabled: true },
      durationMs,
      subtitleDefault.verticalPos,
    ) ?? undefined;
  } else if (sourceText.length > 0) {
    const seeded = applyHeadlineHookPatchWithFallback(
      createDefaultHeadlineHook(sourceText, durationMs),
      { preset: pack.headlineHookPreset, enabled: true },
      sourceText,
      durationMs,
    );
    headlineHook = normalizeHeadlineHook(seeded, durationMs, subtitleDefault.verticalPos) ?? undefined;
  }

  return {
    templateId,
    thaiLabel: pack.thaiLabel,
    tagline: pack.tagline,
    palette: pack.palette,
    pacing: pack.pacing,
    ttsSpeed: TEMPLATE_TTS_SPEED_BY_PACING[pack.pacing],
    geminiVoiceStyle: TEMPLATE_VOICE_STYLE_BY_ID[templateId],
    musicMood: pack.musicMood,
    stockMood: pack.stockMood,
    subtitleDefault,
    headlineHookPreset: pack.headlineHookPreset,
    ...(headlineHook ? { headlineHook } : {}),
    highlightKeywords: pack.highlightKeywords,
    statCards: pack.statCards,
    sfxMode: pack.sfxMode,
    punchZoom: pack.punchZoom,
    brollTransition: pack.brollTransition,
  };
}

export type PostTemplateResolution = {
  pack: StylePack;
  templateId: ActiveStylePackId;
  subtitlePreset: SubtitleStylePresetConfig;
  subtitleConfig: Omit<SubtitleStylePresetConfig, "cardLen">;
  cardLen: SubtitleCardLen;
  headlineHook: HeadlineHookConfig | null;
  highlightKeywords: boolean;
  statCards: boolean;
  sfxMode: SfxMode;
  punchZoom: boolean;
  brollTransition: BrollTransition;
  musicMood: MusicMood;
};

/**
 * Pure post-render template transformation shared by Web `usePostPhaseEditor` and
 * MCP `apply_video_template`. Preserves existing headline hook text when present, or
 * seeds from `headlineSourceText` when available so the template's hook card renders.
 */
export function resolveTemplatePostEdit(input: {
  templateId: ActiveStylePackId;
  currentHeadlineHook?: HeadlineHookConfig | null;
  headlineSourceText?: string;
  totalDurationMs: number;
}): PostTemplateResolution {
  const pack = stylePack(input.templateId);
  const rawPreset = stylePackSubtitlePreset(pack);
  const subtitlePreset = normalizeSubtitleStylePresetConfig(rawPreset) ?? rawPreset;
  const { cardLen, ...subtitleConfig } = subtitlePreset;
  const durationMs = Math.max(1_000, input.totalDurationMs || 60_000);
  const sourceText = input.headlineSourceText?.trim() ?? "";
  const existing = input.currentHeadlineHook ?? null;

  const baseHook = existing && existing.headline.trim().length > 0
    ? existing
    : createDefaultHeadlineHook(sourceText, durationMs);
  const patchedHook = applyHeadlineHookPatchWithFallback(
    baseHook,
    { preset: pack.headlineHookPreset, enabled: true },
    sourceText,
    durationMs,
  );
  const headlineHook = normalizeHeadlineHook(
    patchedHook,
    durationMs,
    subtitleConfig.verticalPos,
  );

  return {
    pack,
    templateId: input.templateId,
    subtitlePreset,
    subtitleConfig,
    cardLen,
    headlineHook,
    highlightKeywords: pack.highlightKeywords,
    statCards: pack.statCards,
    sfxMode: pack.sfxMode,
    punchZoom: pack.punchZoom,
    brollTransition: pack.brollTransition,
    musicMood: pack.musicMood,
  };
}

export { activeStylePacks, isActiveStylePackId };
