export const HEADLINE_HOOK_PRESETS = [
  "viral",
  "news",
  "clean",
  "banner",
  "stat-burst",
  "question-pill",
] as const;

export type HeadlineHookPreset = (typeof HEADLINE_HOOK_PRESETS)[number];

export const HEADLINE_HOOK_FONTS = [
  { value: "Kanit", label: "Kanit — หนา ชัด", cssFamily: "'Kanit', 'Noto Sans Thai', sans-serif" },
  { value: "Prompt", label: "Prompt — โมเดิร์น", cssFamily: "'Prompt', 'Noto Sans Thai', sans-serif" },
  { value: "Sarabun", label: "Sarabun — อ่านง่าย", cssFamily: "'Sarabun', 'Noto Sans Thai', sans-serif" },
  { value: "Mitr", label: "Mitr — เป็นกันเอง", cssFamily: "'Mitr', 'Noto Sans Thai', sans-serif" },
  { value: "Noto Sans Thai", label: "Noto Sans Thai — เรียบกลาง", cssFamily: "'Noto Sans Thai', sans-serif" },
] as const;

export type HeadlineHookFontFamily = (typeof HEADLINE_HOOK_FONTS)[number]["value"];

export const HEADLINE_HOOK_FONT_WEIGHTS = [400, 600, 900] as const;
export type HeadlineHookFontWeight = (typeof HEADLINE_HOOK_FONT_WEIGHTS)[number];

export const HEADLINE_HOOK_ANCHORS = ["top", "bottom"] as const;
export type HeadlineHookAnchor = (typeof HEADLINE_HOOK_ANCHORS)[number];

export type HeadlineHookConfig = {
  enabled: boolean;
  headline: string;
  subheadline?: string;
  durationMs: number;
  preset: HeadlineHookPreset;
  /**
   * % from the top edge of the 1080×1920 canvas to the headline's vertical CENTER — the value
   * the renderer (`HeadlineHookOverlay`/`HeadlineHookPreview`) actually reads.
   * When `anchor`/`offsetPercent` are present, this is DERIVED from them (clamped against the
   * subtitle band and the safe area, `clampHeadlineHookCenterPercent`) and may fall outside
   * 10–42. Omitted `anchor`/`offsetPercent` means this field alone is authoritative and stays
   * clamped to 10–42 exactly as it always has — old headlines render exactly as today (EP5 #13).
   */
  topPercent: number;
  /** Omitted means anchored to the top, same as today (EP5 #13). */
  anchor?: HeadlineHookAnchor;
  /**
   * Offset from the anchored edge, as % (0–100) of the canvas height. Omitted means the legacy
   * `topPercent`-only placement above. The MCP tool and the web control also accept the same
   * offset in px of the 1080×1920 canvas (`offsetPx` on input) — it is converted to this field
   * immediately and never stored separately, so this is always the single canonical position.
   */
  offsetPercent?: number;
  /** Omitted means the legacy Kanit default. */
  fontFamily?: HeadlineHookFontFamily;
  /** Omitted means size automatically follows headline length. */
  fontSize?: number;
  /** Omitted preserves the legacy extra-bold headline/subheadline pair. */
  fontWeight?: HeadlineHookFontWeight;
  /** Omitted means size automatically follows the headline size. */
  subheadlineFontSize?: number;
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
export const MIN_HEADLINE_HOOK_SUBHEAD_FONT_SIZE = 32;
export const MAX_HEADLINE_HOOK_SUBHEAD_FONT_SIZE = 88;

/** The canvas every px-based headline field (`offsetPx` on input) is expressed against. */
export const HEADLINE_HOOK_CANVAS_WIDTH_PX = 1080;
export const HEADLINE_HOOK_CANVAS_HEIGHT_PX = 1920;

export const MIN_HEADLINE_HOOK_OFFSET_PERCENT = 0;
export const MAX_HEADLINE_HOOK_OFFSET_PERCENT = 100;

/** Never closer than this to the very top/bottom edge of the canvas (the horizontal equivalent
 *  — `left/right: 6%` — already guards `HeadlineHookOverlay`/`HeadlineHookPreview`). */
export const HEADLINE_HOOK_SAFE_AREA_PERCENT = 4;
/** Generous half-height reserve (% of canvas height) for the headline's own text block, so the
 *  clamp below never lets its box crowd the canvas edge or the subtitle band. */
export const HEADLINE_HOOK_HALF_HEIGHT_PERCENT = 9;
/** Generous half-height reserve (% of canvas height) around the subtitle's own vertical
 *  position — the "subtitle band" `clampHeadlineHookCenterPercent` keeps the headline out of.
 *  Deliberately generous (covers a 2–3 line card at the largest allowed subtitle font) rather
 *  than exact, since the real card height depends on text length/wrapping too. */
export const SUBTITLE_BAND_HALF_HEIGHT_PERCENT = 10;
/** `DEFAULT_V2_SUB.verticalPos` (subtitle-style.ts) duplicated as a literal to avoid a circular
 *  import. Used only as the subtitle band reference when a caller normalizes a headline without
 *  the project's actual subtitle position at hand — keep in sync if that default ever changes. */
const DEFAULT_SUBTITLE_VERTICAL_POS_FOR_CLAMP = 82;

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

/** Keep a controlled text field editable while still enforcing its structural
 * limits. Persist/render boundaries use `sanitizeHeadlineHookText`; the draft
 * variant deliberately preserves whitespace exactly as the browser produced
 * it so React never rewrites the value and moves a mid-sentence caret. */
function sanitizeHeadlineHookDraftText(
  value: unknown,
  opts: { maxChars: number; maxLines: number },
): string {
  if (typeof value !== "string") return "";
  const draft = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .slice(0, opts.maxLines)
    .join("\n");
  return Array.from(draft).slice(0, opts.maxChars).join("");
}

export function isHeadlineHookPreset(value: unknown): value is HeadlineHookPreset {
  return typeof value === "string"
    && HEADLINE_HOOK_PRESETS.some((preset) => preset === value);
}

function isHeadlineHookFontFamily(value: unknown): value is HeadlineHookFontFamily {
  return typeof value === "string"
    && HEADLINE_HOOK_FONTS.some((font) => font.value === value);
}

function isHeadlineHookFontWeight(value: unknown): value is HeadlineHookFontWeight {
  return typeof value === "number"
    && HEADLINE_HOOK_FONT_WEIGHTS.some((weight) => weight === value);
}

export function headlineHookFontCssFamily(value: HeadlineHookFontFamily | null | undefined): string {
  return HEADLINE_HOOK_FONTS.find((font) => font.value === value)?.cssFamily
    ?? HEADLINE_HOOK_FONTS[0].cssFamily;
}

export function clampHeadlineHookFontSize(value: number): number {
  return Math.round(clamp(value, MIN_HEADLINE_HOOK_FONT_SIZE, MAX_HEADLINE_HOOK_FONT_SIZE));
}

export function clampHeadlineHookSubheadFontSize(value: number): number {
  return Math.round(clamp(
    value,
    MIN_HEADLINE_HOOK_SUBHEAD_FONT_SIZE,
    MAX_HEADLINE_HOOK_SUBHEAD_FONT_SIZE,
  ));
}

export function headlineHookFontWeights(
  value: HeadlineHookFontWeight | null | undefined,
): { headline: number; subheadline: number } {
  if (value === 400) return { headline: 400, subheadline: 400 };
  if (value === 600) return { headline: 600, subheadline: 600 };
  return { headline: 900, subheadline: 800 };
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

/**
 * EP5 #13: keeps the headline's own reserved band off both the subtitle's reserved band and the
 * very top/bottom edge of the canvas. `centerPercent` and the result are both "% from the top
 * edge of the canvas to the headline's vertical center" — the same meaning `topPercent` always
 * had. `anchor` only decides which side the clamp prefers to push towards when the requested
 * position overlaps the subtitle band; the physical result is identical either way once pushed
 * to the limit, since both anchors are clamping the same rectangle.
 */
export function clampHeadlineHookCenterPercent(
  centerPercent: number,
  anchor: HeadlineHookAnchor,
  subtitleVerticalPos: number = DEFAULT_SUBTITLE_VERTICAL_POS_FOR_CLAMP,
): number {
  const safeSubtitlePos = clamp(
    finiteOr(subtitleVerticalPos, DEFAULT_SUBTITLE_VERTICAL_POS_FOR_CLAMP),
    0,
    100,
  );
  const lo = Math.min(
    HEADLINE_HOOK_SAFE_AREA_PERCENT + HEADLINE_HOOK_HALF_HEIGHT_PERCENT,
    100 - HEADLINE_HOOK_SAFE_AREA_PERCENT - HEADLINE_HOOK_HALF_HEIGHT_PERCENT,
  );
  const hi = Math.max(
    HEADLINE_HOOK_SAFE_AREA_PERCENT + HEADLINE_HOOK_HALF_HEIGHT_PERCENT,
    100 - HEADLINE_HOOK_SAFE_AREA_PERCENT - HEADLINE_HOOK_HALF_HEIGHT_PERCENT,
  );
  let next = clamp(finiteOr(centerPercent, DEFAULT_HEADLINE_HOOK_TOP_PERCENT), lo, hi);

  const subTop = safeSubtitlePos - SUBTITLE_BAND_HALF_HEIGHT_PERCENT;
  const subBottom = safeSubtitlePos + SUBTITLE_BAND_HALF_HEIGHT_PERCENT;
  const overlapsBand = next + HEADLINE_HOOK_HALF_HEIGHT_PERCENT > subTop
    && next - HEADLINE_HOOK_HALF_HEIGHT_PERCENT < subBottom;
  if (overlapsBand) {
    const above = subTop - HEADLINE_HOOK_HALF_HEIGHT_PERCENT;
    const below = subBottom + HEADLINE_HOOK_HALF_HEIGHT_PERCENT;
    const aboveOk = above >= lo;
    const belowOk = below <= hi;
    if (anchor === "bottom" && aboveOk) next = clamp(above, lo, hi);
    else if (belowOk) next = clamp(below, lo, hi);
    else if (aboveOk) next = clamp(above, lo, hi);
    // else: the safe area is too narrow to clear the band at all with these constants — keep
    // the safe-area clamp already applied above as the best-effort fallback.
  }
  return Math.round(next);
}

/** The offset-from-anchor-edge (%) implied by `hook`, whether it was set through the new
 *  `anchor`/`offsetPercent` fields or is still a legacy `topPercent`-only headline. Shared by the
 *  web controls/preview so both read and write the one number the renderer will apply. */
export function headlineHookOffsetPercent(hook: HeadlineHookConfig): number {
  if (typeof hook.offsetPercent === "number" && Number.isFinite(hook.offsetPercent)) {
    return hook.offsetPercent;
  }
  return hook.anchor === "bottom" ? 100 - hook.topPercent : hook.topPercent;
}

export function normalizeHeadlineHook(
  value: unknown,
  totalDurationMs = 60_000,
  subtitleVerticalPos?: number,
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

  // EP5 #13: `anchor`/`offsetPx`/`offsetPercent` are the new position fields. Absent all three,
  // `topPercent` alone is authoritative and keeps its original hard-coded 10–42 clamp exactly —
  // old headlines with none of these fields render exactly as today. `offsetPx` is in px of the
  // 1080×1920 canvas and is converted to `offsetPercent` immediately; only the percent form is
  // ever stored, so a later patch can never leave a stale px/percent pair out of sync.
  const offsetPxInput = typeof input.offsetPx === "number" && Number.isFinite(input.offsetPx)
    ? input.offsetPx
    : undefined;
  const offsetPercentInput = typeof input.offsetPercent === "number" && Number.isFinite(input.offsetPercent)
    ? input.offsetPercent
    : undefined;
  const hasNewPositionFields = input.anchor !== undefined
    || offsetPxInput !== undefined
    || offsetPercentInput !== undefined;

  let topPercent: number;
  let anchor: HeadlineHookAnchor | undefined;
  let offsetPercent: number | undefined;

  if (!hasNewPositionFields) {
    topPercent = Math.round(clamp(
      finiteOr(input.topPercent, DEFAULT_HEADLINE_HOOK_TOP_PERCENT),
      MIN_HEADLINE_HOOK_TOP_PERCENT,
      MAX_HEADLINE_HOOK_TOP_PERCENT,
    ));
  } else {
    anchor = input.anchor === "bottom" ? "bottom" : "top";
    const requestedOffsetPercent = offsetPxInput !== undefined
      ? (offsetPxInput / HEADLINE_HOOK_CANVAS_HEIGHT_PX) * 100
      : offsetPercentInput !== undefined
        ? offsetPercentInput
        : DEFAULT_HEADLINE_HOOK_TOP_PERCENT;
    const clampedRequested = clamp(
      requestedOffsetPercent,
      MIN_HEADLINE_HOOK_OFFSET_PERCENT,
      MAX_HEADLINE_HOOK_OFFSET_PERCENT,
    );
    const rawCenterPercent = anchor === "bottom" ? 100 - clampedRequested : clampedRequested;
    topPercent = clampHeadlineHookCenterPercent(rawCenterPercent, anchor, subtitleVerticalPos);
    offsetPercent = Math.round(anchor === "bottom" ? 100 - topPercent : topPercent);
  }

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
    topPercent,
    ...(anchor ? { anchor } : {}),
    ...(offsetPercent !== undefined ? { offsetPercent } : {}),
    ...(isHeadlineHookFontFamily(input.fontFamily)
      ? { fontFamily: input.fontFamily }
      : {}),
    ...(typeof input.fontSize === "number" && Number.isFinite(input.fontSize)
      ? { fontSize: clampHeadlineHookFontSize(input.fontSize) }
      : {}),
    ...(isHeadlineHookFontWeight(input.fontWeight)
      ? { fontWeight: input.fontWeight }
      : {}),
    ...(typeof input.subheadlineFontSize === "number" && Number.isFinite(input.subheadlineFontSize)
      ? { subheadlineFontSize: clampHeadlineHookSubheadFontSize(input.subheadlineFontSize) }
      : {}),
  };
}

/** Normalize non-text settings for live editor state without trimming the
 * whitespace the creator just typed. Render/API boundaries and draft reloads
 * still call `normalizeHeadlineHook`, so durable output remains canonical. */
export function normalizeHeadlineHookDraft(
  value: unknown,
  totalDurationMs = 60_000,
  subtitleVerticalPos?: number,
): HeadlineHookConfig | null {
  const normalized = normalizeHeadlineHook(value, totalDurationMs, subtitleVerticalPos);
  if (!normalized || !value || typeof value !== "object" || Array.isArray(value)) return normalized;
  const input = value as Record<string, unknown>;
  const headline = sanitizeHeadlineHookDraftText(input.headline, {
    maxChars: MAX_HEADLINE_HOOK_CHARS,
    maxLines: 2,
  });
  const subheadline = sanitizeHeadlineHookDraftText(input.subheadline, {
    maxChars: MAX_HEADLINE_HOOK_SUBHEAD_CHARS,
    maxLines: 1,
  });
  const { subheadline: _normalizedSubheadline, ...withoutSubheadline } = normalized;
  return {
    ...withoutSubheadline,
    enabled: input.enabled === true && headline.trim().length > 0,
    headline,
    ...(subheadline.length > 0 ? { subheadline } : {}),
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
  subheadlineFontSize?: number,
): { headline: number; subheadline: number } {
  const longestLine = Math.max(...headline.split("\n").map((line) => Array.from(line).length), 0);
  const autoHeadlineSize = longestLine <= 22 ? 96
    : longestLine <= 32 ? 84
      : longestLine <= 44 ? 72
        : 58;
  const headlineSize = typeof fontSize === "number" && Number.isFinite(fontSize)
    ? clampHeadlineHookFontSize(fontSize)
    : autoHeadlineSize;
  const resolvedSubheadlineSize = typeof subheadlineFontSize === "number" && Number.isFinite(subheadlineFontSize)
    ? clampHeadlineHookSubheadFontSize(subheadlineFontSize)
    : Math.max(42, Math.round(headlineSize * 0.62));
  return { headline: headlineSize, subheadline: resolvedSubheadlineSize };
}

export type InitialHeadlineHookJobInput = {
  headlineHook?: HeadlineHookConfig | string | unknown;
  headlineHookSubtext?: string | unknown;
  headlineHookStyle?: string | unknown;
  headlineHookDurationMs?: number | unknown;
  visualHook?: string | unknown;
  visualHookStyle?: string | unknown;
};

/**
 * Resolves a first-3-second visual hook (`HeadlineHookConfig`) from either an already-structured
 * `headlineHook` object or flat MCP job creation fields (`headlineHook` / `visualHook`,
 * `headlineHookSubtext`, `headlineHookStyle` / `visualHookStyle`, `headlineHookDurationMs`).
 * Defaults `durationMs` to 3000ms (0–3s hook window) when not specified on flat inputs.
 */
export function resolveInitialHeadlineHookFromJobInput(
  input: InitialHeadlineHookJobInput | Record<string, unknown> | null | undefined,
  totalDurationMs = 60_000,
  subtitleVerticalPos?: number,
): HeadlineHookConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  if (typeof input.headlineHook === "object" && input.headlineHook !== null) {
    return normalizeHeadlineHook(input.headlineHook, totalDurationMs, subtitleVerticalPos) ?? undefined;
  }
  const rawHeadline = typeof input.headlineHook === "string" && input.headlineHook.trim().length > 0
    ? input.headlineHook
    : typeof input.visualHook === "string" && input.visualHook.trim().length > 0
      ? input.visualHook
      : "";
  if (!rawHeadline) return undefined;

  const rawStyle = input.headlineHookStyle ?? input.visualHookStyle;
  const preset: HeadlineHookPreset = isHeadlineHookPreset(rawStyle)
    ? rawStyle
    : typeof input.visualHook === "string" && input.visualHook.trim().length > 0
      ? "banner"
      : DEFAULT_HEADLINE_HOOK_PRESET;

  const durationMs = typeof input.headlineHookDurationMs === "number" && Number.isFinite(input.headlineHookDurationMs)
    ? input.headlineHookDurationMs
    : MIN_HEADLINE_HOOK_DURATION_MS;

  return normalizeHeadlineHook(
    {
      enabled: true,
      headline: rawHeadline,
      ...(typeof input.headlineHookSubtext === "string" && input.headlineHookSubtext.trim().length > 0
        ? { subheadline: input.headlineHookSubtext }
        : {}),
      preset,
      durationMs,
      topPercent: DEFAULT_HEADLINE_HOOK_TOP_PERCENT,
    },
    totalDurationMs,
    subtitleVerticalPos,
  ) ?? undefined;
}

