export const SUBTITLE_FONT_WEIGHTS = [400, 600, 900] as const;
export type SubtitleFontWeight = (typeof SUBTITLE_FONT_WEIGHTS)[number];

export function normalizeSubtitleFontWeight(value: unknown): SubtitleFontWeight | null {
  return typeof value === "number"
    && SUBTITLE_FONT_WEIGHTS.some((weight) => weight === value)
    ? value as SubtitleFontWeight
    : null;
}

/** New `fontWeight` is authoritative; `bold` keeps old projects/presets byte-compatible. */
export function resolveSubtitleFontWeight(config: {
  fontWeight?: unknown;
  bold?: unknown;
}): SubtitleFontWeight {
  return normalizeSubtitleFontWeight(config.fontWeight)
    ?? (config.bold === true ? 900 : 400);
}

export function legacyBoldForSubtitleFontWeight(weight: SubtitleFontWeight): boolean {
  return weight === 900;
}
