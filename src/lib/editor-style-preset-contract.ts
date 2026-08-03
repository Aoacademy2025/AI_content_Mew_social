import type { SubPreset, SubTextEffect } from "@/app/(dashboard)/video-editor/_components/types";
import {
  normalizeLogoOverlayConfig,
  type LogoOverlayConfig,
} from "@/lib/logo-overlay";
import {
  normalizeSubtitleFontWeight,
  type SubtitleFontWeight,
} from "@/lib/subtitle-font-weight";

export const EDITOR_STYLE_PRESET_KINDS = ["subtitle", "logo"] as const;
export type EditorStylePresetKind = (typeof EDITOR_STYLE_PRESET_KINDS)[number];

export const MAX_EDITOR_STYLE_PRESET_NAME_LENGTH = 40;
export const MAX_EDITOR_STYLE_PRESETS_PER_KIND = 20;

export type SubtitleCardLen = "sentence" | "4" | "3" | "2" | "1";

export type SubtitleStylePresetConfig = {
  preset: SubPreset;
  effect: SubTextEffect;
  cardLen: SubtitleCardLen;
  fontFamily: string;
  bold: boolean;
  fontWeight: SubtitleFontWeight;
  fontSize: number;
  textColor: string;
  accentColor: string;
  shadow: boolean;
  outline: boolean;
  outlineSize: number;
  verticalPos: number;
};

export type SubtitleEditorStylePreset = {
  id: string;
  kind: "subtitle";
  name: string;
  config: SubtitleStylePresetConfig;
  createdAt: string;
  updatedAt: string;
};

export type LogoEditorStylePreset = {
  id: string;
  kind: "logo";
  name: string;
  config: LogoOverlayConfig;
  createdAt: string;
  updatedAt: string;
};

export type EditorStylePreset =
  | SubtitleEditorStylePreset
  | LogoEditorStylePreset;

const SUBTITLE_PRESETS = new Set<SubPreset>([
  "stroke",
  "plain",
  "shadow",
  "box",
  "box-rounded",
  "glow",
  "outline-only",
  "karaoke",
  "typewriter",
  "bold-shadow",
  "karaoke-box",
  "pop-outline",
  "neon-green",
  "neon-red",
  "neon-blue",
  "pastel",
  "classic-yellow",
  "hormozi",
  "beast",
  "box-white",
  "box-yellow",
  "retro",
  "sharp-outline",
  "news",
]);

const SUBTITLE_EFFECTS = new Set<SubTextEffect>([
  "pop",
  "bounce",
  "fade",
  "quick",
  "glow-pulse",
  "slide",
  "flip",
  "highlight",
  "karaoke",
  "typewriter",
]);
const SUBTITLE_CARD_LENGTHS = new Set<SubtitleCardLen>(["sentence", "4", "3", "2", "1"]);

const COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= min
    && value <= max;
}

export function normalizeEditorStylePresetName(value: unknown): {
  name: string;
  nameKey: string;
} | null {
  if (typeof value !== "string") return null;
  const name = value
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    !name
    || Array.from(name).length > MAX_EDITOR_STYLE_PRESET_NAME_LENGTH
    || /[\u0000-\u001f\u007f-\u009f]/u.test(name)
  ) {
    return null;
  }
  return { name, nameKey: name.toLocaleLowerCase("th-TH") };
}

export function normalizeSubtitleStylePresetConfig(
  value: unknown,
): SubtitleStylePresetConfig | null {
  if (!isRecord(value)) return null;
  // Rows saved before card length became part of the preset contract never carried
  // enough information to reconstruct the user's old grouping. Keep them usable with
  // the editor's historical default; re-saving upgrades the row to the full contract.
  const cardLen = value.cardLen === undefined ? "sentence" : value.cardLen;
  const fontWeight = value.fontWeight === undefined
    ? (value.bold === true ? 900 : 400)
    : normalizeSubtitleFontWeight(value.fontWeight);
  if (
    typeof value.preset !== "string"
    || !SUBTITLE_PRESETS.has(value.preset as SubPreset)
    || typeof value.effect !== "string"
    || !SUBTITLE_EFFECTS.has(value.effect as SubTextEffect)
    || typeof cardLen !== "string"
    || !SUBTITLE_CARD_LENGTHS.has(cardLen as SubtitleCardLen)
    || typeof value.fontFamily !== "string"
    || !value.fontFamily.trim()
    || value.fontFamily.length > 120
    || typeof value.bold !== "boolean"
    || fontWeight === null
    || !isFiniteNumberInRange(value.fontSize, 30, 160)
    || typeof value.textColor !== "string"
    || !COLOR_PATTERN.test(value.textColor)
    || typeof value.accentColor !== "string"
    || !COLOR_PATTERN.test(value.accentColor)
    || typeof value.shadow !== "boolean"
    || typeof value.outline !== "boolean"
    || !isFiniteNumberInRange(value.outlineSize, 1, 8)
    || !isFiniteNumberInRange(value.verticalPos, 10, 95)
  ) {
    return null;
  }

  return {
    preset: value.preset as SubPreset,
    effect: value.effect as SubTextEffect,
    cardLen: cardLen as SubtitleCardLen,
    fontFamily: value.fontFamily.trim(),
    bold: value.bold,
    fontWeight,
    fontSize: value.fontSize,
    textColor: value.textColor.toUpperCase(),
    accentColor: value.accentColor.toUpperCase(),
    shadow: value.shadow,
    outline: value.outline,
    outlineSize: value.outlineSize,
    verticalPos: value.verticalPos,
  };
}

export function normalizeEditorStylePresetConfig(
  kind: "subtitle",
  value: unknown,
): SubtitleStylePresetConfig | null;
export function normalizeEditorStylePresetConfig(
  kind: "logo",
  value: unknown,
): LogoOverlayConfig | null;
export function normalizeEditorStylePresetConfig(
  kind: EditorStylePresetKind,
  value: unknown,
): SubtitleStylePresetConfig | LogoOverlayConfig | null {
  return kind === "subtitle"
    ? normalizeSubtitleStylePresetConfig(value)
    : normalizeLogoOverlayConfig(value);
}

export function parseEditorStylePreset(value: unknown): EditorStylePreset | null {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || !value.id
    || typeof value.name !== "string"
    || !value.name
    || typeof value.createdAt !== "string"
    || typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  if (value.kind === "subtitle") {
    const config = normalizeEditorStylePresetConfig("subtitle", value.config);
    return config
      ? {
          id: value.id,
          kind: "subtitle",
          name: value.name,
          config,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt,
        }
      : null;
  }
  if (value.kind === "logo") {
    const config = normalizeEditorStylePresetConfig("logo", value.config);
    return config
      ? {
          id: value.id,
          kind: "logo",
          name: value.name,
          config,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt,
        }
      : null;
  }
  return null;
}
