import {
  createDefaultHeadlineHook,
  normalizeHeadlineHook,
  type HeadlineHookConfig,
} from "@/lib/headline-hook";
import { cardsByWordCount, maxCardCharsFor } from "@/lib/mcp/orchestrator-steps";
import type { HeroEditorialCaption, HeroSubtitleDesign } from "@/lib/hero-editorial";
import type { TtsTiming, TimedWord } from "@/lib/tts-timing";
import { captionsFromTtsTiming } from "@/app/(dashboard)/video-editor/_components/tts-timing-captions";
import type { SubtitleStylePreset, SubtitleTextEffect } from "@/remotion/types";

export const STORY_FILM_SUBTITLE_MODES = ["sentence", "1", "2", "3", "4"] as const;
export const STORY_FILM_SUBTITLE_PRESETS = [
  "stroke",
  "classic-yellow",
  "bold-shadow",
  "box-rounded",
  "news",
] as const satisfies readonly SubtitleStylePreset[];
export const STORY_FILM_SUBTITLE_EFFECTS = [
  "pop",
  "fade",
  "quick",
  "highlight",
  "karaoke",
  "typewriter",
] as const satisfies readonly SubtitleTextEffect[];
export const STORY_FILM_SUBTITLE_POSITIONS = ["top", "middle", "bottom"] as const;
export const STORY_FILM_SUBTITLE_FONTS = ["Kanit", "Prompt", "Sarabun", "Mitr", "Noto Sans Thai"] as const;
export const STORY_FILM_SUBTITLE_FONT_WEIGHTS = [400, 500, 600, 700, 800, 900] as const;
export const MIN_STORY_FILM_SUBTITLE_FONT_SIZE = 44;
export const MAX_STORY_FILM_SUBTITLE_FONT_SIZE = 96;

export type StoryFilmSubtitleMode = (typeof STORY_FILM_SUBTITLE_MODES)[number];
export type StoryFilmSubtitlePreset = (typeof STORY_FILM_SUBTITLE_PRESETS)[number];
export type StoryFilmSubtitleEffect = (typeof STORY_FILM_SUBTITLE_EFFECTS)[number];
export type StoryFilmSubtitlePosition = (typeof STORY_FILM_SUBTITLE_POSITIONS)[number];
export type StoryFilmSubtitleFont = (typeof STORY_FILM_SUBTITLE_FONTS)[number];
export type StoryFilmSubtitleFontWeight = (typeof STORY_FILM_SUBTITLE_FONT_WEIGHTS)[number];

export type StoryFilmTextOverlay = {
  sceneKey: string;
  text: string;
};

export type StoryFilmEditorialConfig = {
  subtitlesEnabled: boolean;
  subtitleMode: StoryFilmSubtitleMode;
  subtitleStylePreset: StoryFilmSubtitlePreset;
  subtitleTextEffect: StoryFilmSubtitleEffect;
  subtitlePosition: StoryFilmSubtitlePosition;
  subtitleFontFamily: StoryFilmSubtitleFont;
  subtitleFontSize: number;
  subtitleFontWeight: StoryFilmSubtitleFontWeight;
  headlineHook: HeadlineHookConfig;
  /** Optional per-scene caption replacement rendered by the shared Hero subtitle engine. */
  textOverlays: StoryFilmTextOverlay[];
};

export type StoryFilmCaptionTrack = {
  version: 1;
  source: "elevenlabs_alignment" | "hero_voice_timing" | "forced_alignment" | "storyboard_fallback";
  fullText: string;
  captions: HeroEditorialCaption[];
  words: TimedWord[];
};

export type StoryFilmCaptionScene = {
  sceneKey: string;
  startMs: number;
  endMs: number;
  sourceExcerpt: string;
};

export const DEFAULT_STORY_FILM_EDITORIAL_CONFIG: StoryFilmEditorialConfig = {
  subtitlesEnabled: true,
  subtitleMode: "sentence",
  subtitleStylePreset: "stroke",
  subtitleTextEffect: "pop",
  subtitlePosition: "bottom",
  subtitleFontFamily: "Kanit",
  subtitleFontSize: 60,
  subtitleFontWeight: 600,
  headlineHook: {
    enabled: false,
    headline: "",
    durationMs: 8_000,
    preset: "viral",
    topPercent: 20,
    fontFamily: "Kanit",
    fontWeight: 600,
  },
  textOverlays: [],
};

const SCENE_KEY_PATTERN = /^scene-\d{2}$/u;
const POSITION_TOP_PERCENT: Record<StoryFilmSubtitlePosition, number> = {
  top: 12,
  middle: 45,
  bottom: 78,
};
const FONT_CSS: Record<StoryFilmSubtitleFont, string> = {
  Kanit: "'Kanit', 'Noto Sans Thai', sans-serif",
  Prompt: "'Prompt', 'Noto Sans Thai', sans-serif",
  Sarabun: "'Sarabun', 'Noto Sans Thai', sans-serif",
  Mitr: "'Mitr', 'Noto Sans Thai', sans-serif",
  "Noto Sans Thai": "'Noto Sans Thai', sans-serif",
};

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback;
}

function subtitleFontSize(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value)
    ? value
    : DEFAULT_STORY_FILM_EDITORIAL_CONFIG.subtitleFontSize;
  return Math.round(Math.min(MAX_STORY_FILM_SUBTITLE_FONT_SIZE, Math.max(MIN_STORY_FILM_SUBTITLE_FONT_SIZE, numeric)));
}

function subtitleFontWeight(value: unknown): StoryFilmSubtitleFontWeight {
  return typeof value === "number" && STORY_FILM_SUBTITLE_FONT_WEIGHTS.includes(value as StoryFilmSubtitleFontWeight)
    ? value as StoryFilmSubtitleFontWeight
    : DEFAULT_STORY_FILM_EDITORIAL_CONFIG.subtitleFontWeight;
}

export function createDefaultStoryFilmEditorialConfig(
  narrativeSource: string,
  durationMs: number,
): StoryFilmEditorialConfig {
  return {
    ...DEFAULT_STORY_FILM_EDITORIAL_CONFIG,
    headlineHook: {
      ...createDefaultHeadlineHook(narrativeSource, durationMs),
      fontFamily: "Kanit",
      fontWeight: 600,
    },
    textOverlays: [],
  };
}

export function parseStoryFilmEditorialConfig(
  value: unknown,
  durationMs = 180_000,
): StoryFilmEditorialConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_STORY_FILM_EDITORIAL_CONFIG, textOverlays: [] };
  }
  const input = value as Record<string, unknown>;
  const seen = new Set<string>();
  const textOverlays = Array.isArray(input.textOverlays)
    ? input.textOverlays.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const overlay = item as Record<string, unknown>;
        const sceneKey = typeof overlay.sceneKey === "string" ? overlay.sceneKey.trim() : "";
        const text = typeof overlay.text === "string" ? overlay.text.replace(/\s+/gu, " ").trim() : "";
        if (!SCENE_KEY_PATTERN.test(sceneKey) || !text || text.length > 240 || seen.has(sceneKey)) return [];
        seen.add(sceneKey);
        return [{ sceneKey, text }];
      }).slice(0, 60)
    : [];

  const legacyStyle = input.subtitleStyle;
  const legacyPreset = legacyStyle === "cinematic"
    ? "box-rounded"
    : legacyStyle === "bold"
      ? "classic-yellow"
      : undefined;
  const parsedHeadlineHook = normalizeHeadlineHook(input.headlineHook, durationMs)
    ?? { ...DEFAULT_STORY_FILM_EDITORIAL_CONFIG.headlineHook };
  const headlineHook = {
    ...parsedHeadlineHook,
    fontWeight: parsedHeadlineHook.fontWeight ?? 600 as const,
  };
  return {
    subtitlesEnabled: input.subtitlesEnabled !== false,
    subtitleMode: oneOf(STORY_FILM_SUBTITLE_MODES, input.subtitleMode, "sentence"),
    subtitleStylePreset: oneOf(
      STORY_FILM_SUBTITLE_PRESETS,
      input.subtitleStylePreset ?? legacyPreset,
      "stroke",
    ),
    subtitleTextEffect: oneOf(STORY_FILM_SUBTITLE_EFFECTS, input.subtitleTextEffect, "pop"),
    subtitlePosition: oneOf(STORY_FILM_SUBTITLE_POSITIONS, input.subtitlePosition, "bottom"),
    subtitleFontFamily: oneOf(STORY_FILM_SUBTITLE_FONTS, input.subtitleFontFamily, "Kanit"),
    subtitleFontSize: subtitleFontSize(input.subtitleFontSize),
    subtitleFontWeight: subtitleFontWeight(input.subtitleFontWeight),
    headlineHook,
    textOverlays,
  };
}

export function validateStoryFilmEditorialConfig(
  value: unknown,
  durationMs = 180_000,
): StoryFilmEditorialConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("editorial ต้องเป็น object");
  const input = value as Record<string, unknown>;
  if (typeof input.subtitlesEnabled !== "boolean") throw new Error("กรุณาระบุว่าจะใส่ซับหรือไม่");
  if (!STORY_FILM_SUBTITLE_MODES.includes(input.subtitleMode as StoryFilmSubtitleMode)) throw new Error("ความหนาแน่นซับไม่ถูกต้อง");
  if (!STORY_FILM_SUBTITLE_PRESETS.includes(input.subtitleStylePreset as StoryFilmSubtitlePreset)) throw new Error("รูปแบบซับไม่ถูกต้อง");
  if (!STORY_FILM_SUBTITLE_EFFECTS.includes(input.subtitleTextEffect as StoryFilmSubtitleEffect)) throw new Error("เอฟเฟกต์ซับไม่ถูกต้อง");
  if (!STORY_FILM_SUBTITLE_POSITIONS.includes(input.subtitlePosition as StoryFilmSubtitlePosition)) throw new Error("ตำแหน่งซับไม่ถูกต้อง");
  if (!STORY_FILM_SUBTITLE_FONTS.includes(input.subtitleFontFamily as StoryFilmSubtitleFont)) throw new Error("ฟอนต์ซับไม่ถูกต้อง");
  if (input.subtitleFontSize !== undefined && (
    typeof input.subtitleFontSize !== "number"
    || !Number.isInteger(input.subtitleFontSize)
    || input.subtitleFontSize < MIN_STORY_FILM_SUBTITLE_FONT_SIZE
    || input.subtitleFontSize > MAX_STORY_FILM_SUBTITLE_FONT_SIZE
  )) throw new Error(`ขนาดซับต้องอยู่ระหว่าง ${MIN_STORY_FILM_SUBTITLE_FONT_SIZE}-${MAX_STORY_FILM_SUBTITLE_FONT_SIZE}px`);
  if (input.subtitleFontWeight !== undefined && !STORY_FILM_SUBTITLE_FONT_WEIGHTS.includes(input.subtitleFontWeight as StoryFilmSubtitleFontWeight)) {
    throw new Error("น้ำหนักฟอนต์ซับไม่ถูกต้อง");
  }
  if (!input.headlineHook || typeof input.headlineHook !== "object" || Array.isArray(input.headlineHook)) throw new Error("headlineHook ไม่ถูกต้อง");
  const rawHeadline = input.headlineHook as Record<string, unknown>;
  if (typeof rawHeadline.enabled !== "boolean") throw new Error("กรุณาระบุว่าจะใส่ Headline หรือไม่");
  const normalizedHeadline = normalizeHeadlineHook(rawHeadline, durationMs);
  if (!normalizedHeadline || (rawHeadline.enabled === true && !normalizedHeadline.headline)) throw new Error("Headline ที่เปิดใช้ต้องมีข้อความ");
  if (!Array.isArray(input.textOverlays) || input.textOverlays.length > 60) throw new Error("textOverlays ต้องเป็นรายการไม่เกิน 60 ฉาก");
  const normalized = parseStoryFilmEditorialConfig(value, durationMs);
  if (normalized.textOverlays.length !== input.textOverlays.length) {
    throw new Error("ข้อความบนภาพต้องมี sceneKey ไม่ซ้ำกันและยาวไม่เกิน 240 ตัวอักษร");
  }
  return normalized;
}

export function storyFilmCaptionTrackFromTtsTiming(
  timing: TtsTiming | null | undefined,
  durationMs: number,
  source: "elevenlabs_alignment" | "hero_voice_timing",
): StoryFilmCaptionTrack | null {
  const result = captionsFromTtsTiming(timing, durationMs, maxCardCharsFor(80));
  if (!result) return null;
  return {
    version: 1,
    source,
    fullText: result.fullText,
    captions: result.captions.map((caption) => ({
      ...caption,
      tag: caption.tag ?? "body",
    })),
    words: result.words,
  };
}

export function parseStoryFilmCaptionTrack(value: unknown): StoryFilmCaptionTrack | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const sources = ["elevenlabs_alignment", "hero_voice_timing", "forced_alignment", "storyboard_fallback"];
  if (input.version !== 1 || !sources.includes(String(input.source)) || typeof input.fullText !== "string") return null;
  if (!Array.isArray(input.captions) || !Array.isArray(input.words)) return null;
  const captions: HeroEditorialCaption[] = input.captions.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const caption = item as Record<string, unknown>;
    if (typeof caption.text !== "string" || !Number.isFinite(caption.startMs) || !Number.isFinite(caption.endMs)) return [];
    const tag: HeroEditorialCaption["tag"] = caption.tag === "hook" || caption.tag === "cta" ? caption.tag : "body";
    const startMs = Math.round(Number(caption.startMs));
    const endMs = Math.round(Number(caption.endMs));
    return caption.text.trim() && endMs > startMs ? [{ text: caption.text.trim(), startMs, endMs, tag }] : [];
  });
  const words = input.words.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const word = item as Record<string, unknown>;
    if (typeof word.word !== "string" || ![word.startMs, word.endMs, word.startChar, word.endChar].every(Number.isFinite)) return [];
    const startMs = Math.round(Number(word.startMs));
    const endMs = Math.round(Number(word.endMs));
    const startChar = Math.round(Number(word.startChar));
    const endChar = Math.round(Number(word.endChar));
    return word.word && endMs > startMs && endChar > startChar
      ? [{ word: word.word, startMs, endMs, startChar, endChar }]
      : [];
  });
  if (captions.length !== input.captions.length || words.length !== input.words.length || captions.length === 0) return null;
  return {
    version: 1,
    source: input.source as StoryFilmCaptionTrack["source"],
    fullText: input.fullText,
    captions,
    words,
  };
}

export function fallbackStoryFilmCaptionTrack(scenes: StoryFilmCaptionScene[]): StoryFilmCaptionTrack {
  const captions = scenes.flatMap((scene, index) => {
    const text = scene.sourceExcerpt.replace(/\s+/gu, " ").trim();
    if (!text || scene.endMs <= scene.startMs) return [];
    return [{
      text,
      startMs: scene.startMs,
      endMs: scene.endMs,
      tag: (index === 0 ? "hook" : index === scenes.length - 1 ? "cta" : "body") as HeroEditorialCaption["tag"],
    }];
  });
  return {
    version: 1,
    source: "storyboard_fallback",
    fullText: captions.map((caption) => caption.text).join(" "),
    captions,
    words: [],
  };
}

export function captionsForStoryFilmEditorial(input: {
  editorial: StoryFilmEditorialConfig;
  track: StoryFilmCaptionTrack;
  scenes: StoryFilmCaptionScene[];
}): HeroEditorialCaption[] {
  if (!input.editorial.subtitlesEnabled) return [];
  let captions = input.track.captions;
  if (input.editorial.subtitleMode !== "sentence" && input.track.words.length > 0) {
    captions = cardsByWordCount(
      input.track.words,
      Number(input.editorial.subtitleMode),
      input.track.fullText,
    ).map((caption, index, all) => ({
      ...caption,
      tag: index === 0 ? "hook" : index === all.length - 1 ? "cta" : "body",
    }));
  }

  const overlays = new Map(input.editorial.textOverlays.map((item) => [item.sceneKey, item.text]));
  for (const scene of input.scenes) {
    const replacement = overlays.get(scene.sceneKey);
    if (!replacement) continue;
    captions = captions.filter((caption) => {
      const midpoint = caption.startMs + (caption.endMs - caption.startMs) / 2;
      return midpoint < scene.startMs || midpoint >= scene.endMs;
    });
    captions.push({ text: replacement, startMs: scene.startMs, endMs: scene.endMs, tag: "body" });
  }
  return captions
    .filter((caption) => caption.text.trim() && caption.endMs > caption.startMs)
    .sort((a, b) => a.startMs - b.startMs)
    .map((caption, index, all) => ({
      ...caption,
      tag: index === 0 ? "hook" : index === all.length - 1 ? "cta" : "body",
    }));
}

export function storyFilmSubtitleDesign(editorial: StoryFilmEditorialConfig): HeroSubtitleDesign {
  return {
    fontFamily: FONT_CSS[editorial.subtitleFontFamily],
    positionTopPercent: POSITION_TOP_PERCENT[editorial.subtitlePosition],
    fontSize: editorial.subtitleFontSize,
    fontWeight: editorial.subtitleFontWeight,
    color: "#FFFFFF",
    accentColor: "#FFE500",
    stylePreset: editorial.subtitleStylePreset,
    textEffect: editorial.subtitleTextEffect,
    shadow: editorial.subtitleStylePreset === "bold-shadow",
    outline: editorial.subtitleStylePreset === "stroke" || editorial.subtitleStylePreset === "bold-shadow",
    outlineSize: editorial.subtitleStylePreset === "bold-shadow" ? 4 : 2,
  };
}
