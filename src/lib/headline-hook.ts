export const HEADLINE_HOOK_PRESETS = ["viral", "news", "clean"] as const;

export type HeadlineHookPreset = (typeof HEADLINE_HOOK_PRESETS)[number];

export const HEADLINE_HOOK_FONTS = [
  { value: "Kanit", label: "Kanit — หนา ชัด", cssFamily: "'Kanit', 'Noto Sans Thai', sans-serif" },
  { value: "Prompt", label: "Prompt — โมเดิร์น", cssFamily: "'Prompt', 'Noto Sans Thai', sans-serif" },
  { value: "Sarabun", label: "Sarabun — อ่านง่าย", cssFamily: "'Sarabun', 'Noto Sans Thai', sans-serif" },
  { value: "Mitr", label: "Mitr — เป็นกันเอง", cssFamily: "'Mitr', 'Noto Sans Thai', sans-serif" },
  { value: "Noto Sans Thai", label: "Noto Sans Thai — เรียบกลาง", cssFamily: "'Noto Sans Thai', sans-serif" },
] as const;

export type HeadlineHookFontFamily = (typeof HEADLINE_HOOK_FONTS)[number]["value"];

export type HeadlineHookConfig = {
  enabled: boolean;
  headline: string;
  subheadline?: string;
  durationMs: number;
  preset: HeadlineHookPreset;
  topPercent: number;
  /** Omitted means the legacy Kanit default. */
  fontFamily?: HeadlineHookFontFamily;
  /** Omitted means size automatically follows headline length. */
  fontSize?: number;
};

export type HeadlineHookSuggestion = {
  headline: string;
  subheadline?: string;
};

export const MIN_HEADLINE_HOOK_DURATION_MS = 3_000;
export const MAX_HEADLINE_HOOK_DURATION_MS = 20_000;
export const MIN_HEADLINE_HOOK_TOP_PERCENT = 10;
export const MAX_HEADLINE_HOOK_TOP_PERCENT = 42;
export const MAX_HEADLINE_HOOK_CHARS = 64;
export const MAX_HEADLINE_HOOK_SUBHEAD_CHARS = 90;
export const DEFAULT_HEADLINE_HOOK_PRESET: HeadlineHookPreset = "viral";
export const DEFAULT_HEADLINE_HOOK_TOP_PERCENT = 20;
export const DEFAULT_HEADLINE_HOOK_FONT: HeadlineHookFontFamily = "Kanit";
export const MIN_HEADLINE_HOOK_FONT_SIZE = 52;
export const MAX_HEADLINE_HOOK_FONT_SIZE = 120;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const finiteOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function truncateCodePoints(value: string, maxChars: number): string {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join("").trimEnd();
}
export function sanitizeHeadlineHookText(
  value: unknown,
  opts: { maxChars: number; maxLines: number },
): string {
  if (typeof value !== "string") return "";
  const lines = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, opts.maxLines);
  return truncateCodePoints(lines.join("\n"), opts.maxChars);
}

function isHeadlineHookPreset(value: unknown): value is HeadlineHookPreset {
  return typeof value === "string"
    && HEADLINE_HOOK_PRESETS.some((preset) => preset === value);
}

function isHeadlineHookFontFamily(value: unknown): value is HeadlineHookFontFamily {
  return typeof value === "string"
    && HEADLINE_HOOK_FONTS.some((font) => font.value === value);
}

export function headlineHookFontCssFamily(value: HeadlineHookFontFamily | null | undefined): string {
  return HEADLINE_HOOK_FONTS.find((font) => font.value === value)?.cssFamily
    ?? HEADLINE_HOOK_FONTS[0].cssFamily;
}

export function clampHeadlineHookFontSize(value: number): number {
  return Math.round(clamp(value, MIN_HEADLINE_HOOK_FONT_SIZE, MAX_HEADLINE_HOOK_FONT_SIZE));
}

/**
 * Default headline hold by final clip length:
 * - under 30s: 25% of the clip, clamped to 3–8s
 * - up to 60s: 10s
 * - up to 120s: 15s
 * - longer clips: 20s
 */
export function autoHeadlineHookDurationMs(totalDurationMs: number): number {
  const total = Math.max(1_000, finiteOr(totalDurationMs, 60_000));
  if (total < 30_000) {
    return Math.round(clamp(total * 0.25, MIN_HEADLINE_HOOK_DURATION_MS, 8_000));
  }
  if (total <= 60_000) return Math.min(10_000, total);
  if (total <= 120_000) return 15_000;
  return 20_000;
}

export function clampHeadlineHookDurationMs(value: number, totalDurationMs: number): number {
  const total = Math.max(1_000, finiteOr(totalDurationMs, 60_000));
  const maximum = Math.min(MAX_HEADLINE_HOOK_DURATION_MS, total);
  const minimum = Math.min(MIN_HEADLINE_HOOK_DURATION_MS, maximum);
  return Math.round(clamp(finiteOr(value, autoHeadlineHookDurationMs(total)), minimum, maximum));
}

export function normalizeHeadlineHook(
  value: unknown,
  totalDurationMs = 60_000,
): HeadlineHookConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const headline = sanitizeHeadlineHookText(input.headline, {
    maxChars: MAX_HEADLINE_HOOK_CHARS,
    maxLines: 2,
  });
  const subheadline = sanitizeHeadlineHookText(input.subheadline, {
    maxChars: MAX_HEADLINE_HOOK_SUBHEAD_CHARS,
    maxLines: 1,
  });
  return {
    enabled: input.enabled === true && headline.length > 0,
    headline,
    ...(subheadline ? { subheadline } : {}),
    durationMs: clampHeadlineHookDurationMs(
      finiteOr(input.durationMs, autoHeadlineHookDurationMs(totalDurationMs)),
      totalDurationMs,
    ),
    preset: isHeadlineHookPreset(input.preset)
      ? input.preset
      : DEFAULT_HEADLINE_HOOK_PRESET,
    topPercent: Math.round(clamp(
      finiteOr(input.topPercent, DEFAULT_HEADLINE_HOOK_TOP_PERCENT),
      MIN_HEADLINE_HOOK_TOP_PERCENT,
      MAX_HEADLINE_HOOK_TOP_PERCENT,
    )),
    ...(isHeadlineHookFontFamily(input.fontFamily)
      ? { fontFamily: input.fontFamily }
      : {}),
    ...(typeof input.fontSize === "number" && Number.isFinite(input.fontSize)
      ? { fontSize: clampHeadlineHookFontSize(input.fontSize) }
      : {}),
  };
}

function firstMeaningfulExcerpt(text: string): string {
  const normalized = text
    .replace(/[#*_`>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";

  const sentence = normalized.split(/(?<=[.!?…ฯ])\s+/u)[0] ?? normalized;
  const clipped = truncateCodePoints(sentence, MAX_HEADLINE_HOOK_CHARS);
  if (Array.from(sentence).length <= MAX_HEADLINE_HOOK_CHARS) return clipped;

  const lastSpace = clipped.lastIndexOf(" ");
  return lastSpace >= Math.floor(MAX_HEADLINE_HOOK_CHARS * 0.55)
    ? clipped.slice(0, lastSpace).trimEnd()
    : clipped;
}

export function createDefaultHeadlineHook(
  sourceText: string,
  totalDurationMs: number,
): HeadlineHookConfig {
  const headline = firstMeaningfulExcerpt(sourceText);
  return {
    enabled: headline.length > 0,
    headline,
    durationMs: autoHeadlineHookDurationMs(totalDurationMs),
    preset: DEFAULT_HEADLINE_HOOK_PRESET,
    topPercent: DEFAULT_HEADLINE_HOOK_TOP_PERCENT,
  };
}

/** Optional draft fields must be omitted because editor autosave accepts JSON values only. */
export function headlineHookDraftFragment(
  hook: HeadlineHookConfig | null | undefined,
): { headlineHook?: HeadlineHookConfig } {
  return hook ? { headlineHook: hook } : {};
}

export function headlineHookEndMs(
  hook: HeadlineHookConfig | null | undefined,
  totalDurationMs: number,
): number {
  if (!hook?.enabled || !hook.headline.trim()) return 0;
  return clampHeadlineHookDurationMs(hook.durationMs, totalDurationMs);
}

export function isHeadlineHookActive(
  hook: HeadlineHookConfig | null | undefined,
  timeMs: number,
  totalDurationMs: number,
): boolean {
  const endMs = headlineHookEndMs(hook, totalDurationMs);
  return endMs > 0 && timeMs >= 0 && timeMs < endMs;
}

/** Keeps source captions immutable while clipping only their visible overlay span. */
export function visibleCaptionRangeAfterHeadline(
  caption: { startMs: number; endMs: number },
  hook: HeadlineHookConfig | null | undefined,
  totalDurationMs: number,
): { startMs: number; endMs: number } | null {
  const hookEnd = headlineHookEndMs(hook, totalDurationMs);
  const startMs = Math.max(caption.startMs, hookEnd);
  if (caption.endMs <= startMs) return null;
  return { startMs, endMs: caption.endMs };
}

export function headlineHookEndFrame(
  hook: HeadlineHookConfig | null | undefined,
  fps: number,
  totalFrames: number,
): number {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const totalMs = Math.max(1_000, (Math.max(1, totalFrames) / safeFps) * 1_000);
  return Math.min(totalFrames, Math.round((headlineHookEndMs(hook, totalMs) / 1_000) * safeFps));
}

export function normalizeHeadlineHookSuggestions(value: unknown): HeadlineHookSuggestion[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const items = (value as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(items)) return [];

  const unique = new Set<string>();
  const out: HeadlineHookSuggestion[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    const headline = sanitizeHeadlineHookText(candidate.headline, {
      maxChars: MAX_HEADLINE_HOOK_CHARS,
      maxLines: 2,
    });
    if (!headline) continue;
    const key = headline.toLocaleLowerCase("th-TH");
    if (unique.has(key)) continue;
    unique.add(key);
    const subheadline = sanitizeHeadlineHookText(candidate.subheadline, {
      maxChars: MAX_HEADLINE_HOOK_SUBHEAD_CHARS,
      maxLines: 1,
    });
    out.push({ headline, ...(subheadline ? { subheadline } : {}) });
    if (out.length === 3) break;
  }
  return out;
}

export function headlineHookFontSizes(
  headline: string,
  fontSize?: number,
): { headline: number; subheadline: number } {
  const longestLine = Math.max(...headline.split("\n").map((line) => Array.from(line).length), 0);
  const autoHeadlineSize = longestLine <= 22 ? 96
    : longestLine <= 32 ? 84
      : longestLine <= 44 ? 72
        : 58;
  const headlineSize = typeof fontSize === "number" && Number.isFinite(fontSize)
    ? clampHeadlineHookFontSize(fontSize)
    : autoHeadlineSize;
  return { headline: headlineSize, subheadline: Math.max(42, Math.round(headlineSize * 0.62)) };
}
