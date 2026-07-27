// PURE request-payload builders that reproduce the video-editor's non-avatar
// chain (verified against page.tsx 2026-06-13). No I/O — unit-testable.

import type { BrollPreferenceInput } from "@/lib/broll-preferences";
import type { TelemetryInput } from "@/lib/telemetry";
import type { TtsProvider } from "@/lib/tts-providers";

export interface OrchCaption { text: string; startMs: number; endMs: number; tag: "hook" | "body" | "cta" }

// Durable, queryable marker for the degraded-timing recovery path (stab-task-2).
// Emitted (fire-and-forget) ONLY when the orchestrator had to rebuild subtitle
// timing from the raw audio duration because the TTS route produced audio but no
// instrumented `timing` (Gemini's segmented pass fell open to a single call). It
// lands in TelemetryEvent alongside pipeline_step_*, so (1) degraded videos are
// identifiable later and (2) a systemic timing regression shows up as a spike in
// this event name instead of being silently papered over by the recovery.
export function buildDegradedTimingTelemetry(args: {
  pipelineRunId: string;
  jobId: string;
  provider: TtsProvider;
  scriptCharCount: number;
  audioDurationMs: number;
}): TelemetryInput {
  return {
    name: "tts_timing_degraded",
    category: "pipeline",
    source: "server",
    step: "captions",
    status: "recovered",
    properties: {
      pipelineRunId: args.pipelineRunId,
      jobId: args.jobId,
      via: "mcp",
      provider: args.provider,
      scriptCharCount: args.scriptCharCount,
      audioDurationMs: args.audioDurationMs,
    },
  };
}

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

export function buildKeywordsPayload(
  captionTexts: string[],
  script: string,
  audioDurationMs: number,
  brollPreference?: BrollPreferenceInput,
) {
  const scenes = captionTexts.length > 0 ? captionTexts : script.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return {
    scenes,
    ...(script.trim() ? { script: script.trim() } : {}),
    audioDurationSec: Math.min(1800, Math.max(1, Math.round(audioDurationMs / 1000))),
    preferredLLM: null as string | null,
    ...(brollPreference?.brollRegionPreference ? { brollRegionPreference: brollPreference.brollRegionPreference } : {}),
    ...(brollPreference?.brollVisualStyle ? { brollVisualStyle: brollPreference.brollVisualStyle } : {}),
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
  brollPreference?: BrollPreferenceInput,
  brollWindowMode = false,
  brollWindows: { startMs: number; endMs: number }[] = [],
  scriptContext?: { fullScript?: string },
) {
  const perSubtitle = captions.length > 0 && captions.length === keywords.length;
  return {
    keywords,
    download: true as const,
    totalDurationSec: Math.max(30, Math.round(totalDurationSec)),
    stockSource,
    ...(brollWindowMode ? { brollWindowMode: true as const } : {}),
    ...(brollWindowMode && brollWindows.length > 0 ? {
      brollWindowDurationsSec: brollWindows.map((window) =>
        Math.max(0, window.endMs - window.startMs) / 1000),
    } : {}),
    preferredLLM: null as string | null,
    ...(perSubtitle ? { perSubtitleMode: true, overrideClipCount: captions.length, subtitleTexts: captions.map((c) => c.text) } : {}),
    ...(visualDirection ? { visualDirection } : {}),
    ...(keywordAlternatives && keywordAlternatives.length ? { keywordAlternatives } : {}),
    ...(relevanceSpec ? { relevanceSpec } : {}),
    ...(brollPreference?.brollRegionPreference ? { brollRegionPreference: brollPreference.brollRegionPreference } : {}),
    ...(brollPreference?.brollVisualStyle ? { brollVisualStyle: brollPreference.brollVisualStyle } : {}),
    ...(scriptContext?.fullScript?.trim() ? { fullScript: scriptContext.fullScript.trim() } : {}),
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

// A gap (in fullText, between two consecutive words) that contains a line break
// or a sentence-final punctuation mark is a HARD card boundary: the current card
// flushes so a card never spans across a sentence end or an authored line break.
// Kept in LOCKSTEP with the v2 copy in video-editor/_v2/subtitle-style.ts
// (SENTENCE_BOUNDARY_RE / regroupCaptions) — แก้ที่นึงต้องแก้อีกที่.
const SENTENCE_BOUNDARY_RE = /[\n.!?…ฯ]/;

/**
 * Regroup word-timed tokens into cards of ≤N words that never cross a sentence/line
 * boundary ("≤N คำ", matching the v2 UI label). Card text is SLICED from the original
 * `fullText` (preserving exact spacing — Thai has no inter-word spaces, "ๆ"/script spaces
 * stay as written) instead of re-joining tokens, which would either lose or fabricate
 * spaces. Timing (startMs/endMs) is untouched, so subtitle↔audio sync is unchanged.
 * `fullText` is the exact TTS-spoken text the word offsets index into.
 *
 * FIX A: any pipeline-inherited interior whitespace/newline that got sliced into a card
 * (a script line break surviving into the card text) is collapsed to a single space so a
 * card never stacks two lines via white-space:pre-line. FIX B: the group flushes at a
 * sentence/line boundary (see SENTENCE_BOUNDARY_RE) so words are never paired across it.
 */
export function cardsByWordCount(words: CharWord[], n: number, fullText: string): OrchCaption[] {
  const out: OrchCaption[] = [];
  let grp: CharWord[] = [];
  const flush = () => {
    if (!grp.length) return;
    const text = fullText.slice(grp[0].startChar, grp[grp.length - 1].endChar).replace(/\s+/g, " ").trim();
    if (text) out.push({ text, startMs: grp[0].startMs, endMs: grp[grp.length - 1].endMs } as OrchCaption);
    grp = [];
  };
  for (let i = 0; i < words.length; i++) {
    if (grp.length >= n) flush();
    // Before appending word i to a non-empty group, check the gap in fullText between
    // the previous word and this one for a sentence/line boundary.
    if (grp.length > 0 && SENTENCE_BOUNDARY_RE.test(fullText.slice(grp[grp.length - 1].endChar, words[i].startChar))) {
      flush();
    }
    grp.push(words[i]);
  }
  flush();
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
