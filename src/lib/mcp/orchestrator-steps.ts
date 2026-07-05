// PURE request-payload builders that reproduce the video-editor's non-avatar
// chain (verified against page.tsx 2026-06-13). No I/O — unit-testable.

export interface OrchCaption { text: string; startMs: number; endMs: number; tag: "hook" | "body" | "cta" }

export const DEFAULT_STYLE = {
  fontFamily: "'Kanit', sans-serif",
  subtitlePosition: 82,
  subtitleSize: 80,
  subtitleColor: "#ffffff",
  subtitleAccentColor: "#FFE500",
  subtitleStylePreset: "stroke",
  subtitleTextEffect: "pop",
  subtitleFontWeight: 900,
} as const;

export const DEFAULT_STOCK_SOURCE = "both";
export const RENDER_FPS = 30;
export const RENDER_JPEG_QUALITY = 85; // 720p

export function maxCardCharsFor(subtitleSize: number = DEFAULT_STYLE.subtitleSize): number {
  return Math.max(10, Math.floor((1080 - 160) / (subtitleSize * 0.47)));
}

export function buildKeywordsPayload(captionTexts: string[], script: string, audioDurationMs: number) {
  const scenes = captionTexts.length > 0 ? captionTexts : script.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return {
    scenes,
    audioDurationSec: Math.min(1800, Math.max(1, Math.round(audioDurationMs / 1000))),
    preferredLLM: null as string | null,
  };
}

export function buildStockPayload(
  keywords: string[],
  totalDurationSec: number,
  stockSource: string,
  captions: OrchCaption[],
  visualDirection?: string,
  keywordAlternatives?: string[][],
  relevanceSpec?: unknown,
) {
  const perSubtitle = captions.length > 0 && captions.length === keywords.length;
  return {
    keywords,
    download: true as const,
    totalDurationSec: Math.max(30, Math.round(totalDurationSec)),
    stockSource,
    preferredLLM: null as string | null,
    ...(perSubtitle ? { perSubtitleMode: true, overrideClipCount: captions.length, subtitleTexts: captions.map((c) => c.text) } : {}),
    ...(visualDirection ? { visualDirection } : {}),
    ...(keywordAlternatives && keywordAlternatives.length ? { keywordAlternatives } : {}),
    ...(relevanceSpec ? { relevanceSpec } : {}),
  };
}

export function buildConfigPayload(
  captions: OrchCaption[],
  stockVideos: unknown[],
  voiceFile: string,
  audioDurationMs: number,
  scenes: string[],
  keywordsPerScene: number,
  sceneClipCounts: number[],
  sceneDurations: number[],
  brollWindows: { startMs: number; endMs: number }[] = [],
) {
  return {
    sceneCaptions: captions,
    stockVideos,
    voiceFile,
    audioDurationMs,
    fontFamily: DEFAULT_STYLE.fontFamily,
    subtitlePosition: DEFAULT_STYLE.subtitlePosition,
    subtitleSize: DEFAULT_STYLE.subtitleSize,
    subtitleColor: DEFAULT_STYLE.subtitleColor,
    subtitleAccentColor: DEFAULT_STYLE.subtitleAccentColor,
    subtitleStylePreset: DEFAULT_STYLE.subtitleStylePreset,
    subtitleTextEffect: DEFAULT_STYLE.subtitleTextEffect,
    subtitleFontWeight: DEFAULT_STYLE.subtitleFontWeight,
    scenes,
    keywordsPerScene: keywordsPerScene || 5,
    sceneClipCounts,
    sceneDurations,
    preferredLLM: null as string | null,
    // Window-mode b-roll cadence (parity with the web editor): one clip per ~4s window instead
    // of one per caption — generate-config takes its window branch when brollWindows is present.
    ...(brollWindows.length > 0 ? { brollWindows } : {}),
    // NOTE(auto-mix): MCP uses DEFAULT_STOCK_SOURCE="both" (stock), so the AI/auto-mix minHoldSec
    // cadence path isn't used here; window mode above governs stock cadence.
  };
}

export const POSITION_TOP_PERCENT = { top: 12, middle: 45, bottom: 78 } as const;

type CharWord = { word: string; startMs: number; endMs: number; startChar: number; endChar: number };

/**
 * Regroup word-timed tokens into cards of exactly N words (last card = remainder).
 * Card text is SLICED from the original `fullText` (preserving exact spacing — Thai has no
 * inter-word spaces, "ๆ"/script spaces stay as written) instead of re-joining tokens, which
 * would either lose or fabricate spaces. Timing (startMs/endMs) is untouched, so subtitle↔audio
 * sync is unchanged. `fullText` is the exact TTS-spoken text the word offsets index into.
 */
export function cardsByWordCount(words: CharWord[], n: number, fullText: string): OrchCaption[] {
  const out: OrchCaption[] = [];
  for (let i = 0; i < words.length; i += n) {
    const grp = words.slice(i, i + n);
    if (!grp.length) continue;
    const text = fullText.slice(grp[0].startChar, grp[grp.length - 1].endChar).trim();
    out.push({ text, startMs: grp[0].startMs, endMs: grp[grp.length - 1].endMs } as OrchCaption);
  }
  return out;
}

export function buildBurnConfig(baseVideoUrl: string, captions: OrchCaption[], audioDurationMs: number, fps: number = RENDER_FPS, topPercent?: number) {
  const lastEnd = captions.length ? captions[captions.length - 1].endMs : audioDurationMs;
  const durMs = Math.max(audioDurationMs, lastEnd);
  const resolvedTop = topPercent ?? DEFAULT_STYLE.subtitlePosition;
  const keywordPopups = captions.map((c) => ({
    text: c.text,
    start: Math.round((c.startMs / 1000) * fps),
    end: Math.round((c.endMs / 1000) * fps),
    tag: c.tag,
    isHighlight: c.tag === "hook",
    color: c.tag === "hook" ? DEFAULT_STYLE.subtitleAccentColor : DEFAULT_STYLE.subtitleColor,
    accentColor: DEFAULT_STYLE.subtitleAccentColor,
    fontWeight: DEFAULT_STYLE.subtitleFontWeight,
    topPercent: resolvedTop,
    size: DEFAULT_STYLE.subtitleSize,
    stylePreset: DEFAULT_STYLE.subtitleStylePreset,
  }));
  return {
    videoUrl: baseVideoUrl,
    keywordPopups,
    durationInFrames: Math.round((durMs / 1000) * fps),
    fontFamily: DEFAULT_STYLE.fontFamily,
    subtitleStylePreset: DEFAULT_STYLE.subtitleStylePreset,
    subtitleTextEffect: DEFAULT_STYLE.subtitleTextEffect,
    subtitleAccentColor: DEFAULT_STYLE.subtitleAccentColor,
  };
}
