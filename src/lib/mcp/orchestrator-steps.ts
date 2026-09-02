// PURE request-payload builders that reproduce the video-editor's non-avatar
// chain (verified against page.tsx 2026-06-13). No I/O — unit-testable.

import { stockMoodForProject, pacingForProject, type BrollPreferenceInput, type ResolvedStockMood } from "@/lib/broll-preferences";
import type { PacingLevel } from "@/lib/style-pack-catalog";
import { buildHeroSubtitleOverlayConfig } from "@/lib/hero-editorial";

/** What one video job's pinned Style Pack resolves to at render time: the
 *  Stock Mood driving B-roll search, and the Pacing driving window cadence /
 *  AI-gen min-hold (Task 5). */
export interface StylePackRenderResolver {
  resolveStockMood: () => Promise<ResolvedStockMood | null>;
  resolvePacing: () => Promise<PacingLevel>;
}

/** Resolve the pinned Style Pack snapshot for ONE video job, once, and expose
 *  its render-time facets.
 *
 *  Both worker paths write the job's Project Visual Context AFTER the job row
 *  is read — the upload path through `pinProjectVisualContextToVideoJob`, the
 *  script path inside `ensureVideoJobContentPreflight` — and only then reach
 *  the keyword step. So the context must be read LAZILY here, at the moment a
 *  facet is asked for: resolving it from the row captured at job load would
 *  hand every upload-mode clip the PRE-PIN value and silently ignore the pack
 *  pinned for that clip. The reads are injected, so this module stays I/O-free.
 *
 *  Memoized (four keyword/stock payload sites ask `resolveStockMood` for the
 *  same answer) and fail-open: any failing lookup yields `null` (mood) /
 *  `"normal"` (pacing), because a pack is a flavour and never a reason for a
 *  render to stop. `resolveStockMood` and `resolvePacing` both read the SAME
 *  memoized snapshot load — one resolution, two readers — so a job can never
 *  render one facet from a different snapshot than the other. */
export function createStylePackRenderResolver(load: {
  projectVisualContextJson: () => Promise<string | null>;
  brandRevisionRecipeJson: () => Promise<string | null>;
}): StylePackRenderResolver {
  let resolution: Promise<{ projectVisualContextJson: string | null; brandRevisionRecipeJson: string | null }> | null = null;
  const resolveJson = () => {
    resolution ??= (async () => {
      const [projectVisualContextJson, brandRevisionRecipeJson] = await Promise.all([
        load.projectVisualContextJson(),
        load.brandRevisionRecipeJson(),
      ]);
      return { projectVisualContextJson, brandRevisionRecipeJson };
    })();
    return resolution;
  };
  return {
    resolveStockMood: async () => {
      try {
        return stockMoodForProject(await resolveJson());
      } catch {
        return null;
      }
    },
    resolvePacing: async () => {
      try {
        return pacingForProject(await resolveJson());
      } catch {
        return "normal";
      }
    },
  };
}

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
    // Resolved server-side from the pinned Style Pack snapshot (ADR 0057). No
    // pack = no key, so a pack-less project sends the pre-wave-1 body exactly.
    ...(brollPreference?.stockMood ? { stockMood: brollPreference.stockMood } : {}),
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
    ...(brollPreference?.stockMood ? { stockMood: brollPreference.stockMood } : {}),
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
  minHoldSec?: number,
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
    // AI-gen / auto-mix min-hold cadence (Task 5): generate-config's per-subtitle-top branch
    // only reads minHoldSec when brollWindows is EMPTY (window mode above already governs
    // cadence when present) — most MCP jobs run in window mode, so this is usually a no-op,
    // but a job with window mode off and an AI-gen/auto-mix source still needs SOME cadence
    // control instead of one paid image per caption. The pack's PACING_MIN_HOLD_SEC[pacing]
    // is that default (falls back to `"normal"`'s 4s when no pack is pinned).
    ...(brollWindows.length === 0 && typeof minHoldSec === "number" && minHoldSec > 0 ? { minHoldSec } : {}),
  };
}

export const POSITION_TOP_PERCENT = { top: 12, middle: 45, bottom: 78 } as const;

type CharWord = { word: string; startMs: number; endMs: number; startChar: number; endChar: number };

// A gap (in fullText, between two consecutive words) that contains a line break
// or a sentence-final punctuation mark is a HARD card boundary: the current card
// flushes so a card never spans across a sentence end or an authored line break.
// Kept in LOCKSTEP with the v2 copy in video-editor/_v2/subtitle-style.ts
// (SENTENCE_BOUNDARY_RE / regroupCaptions) — แก้ที่นึงต้องแก้อีกที่.
const SENTENCE_BOUNDARY_RE = /[\n,.!?…ฯ;:，；：]/;

// A strict N-token flush can strand Thai function words/modifiers at a card
// edge (production examples: "เริ่มต้นให้|ชัดเจน", "วัน|เดียว"). Permit one
// extra timed token only when it completes that local phrase. The overrun is
// capped at N+1, so the requested density still governs every card.
const THAI_BINDS_NEXT = new Set([
  "ไม่", "ได้", "จะ", "กำลัง", "ต้อง", "ควร", "อยาก", "ให้", "ใน", "จาก",
  "ของ", "กับ", "เพื่อ", "โดย", "เพราะ", "ถ้า", "เมื่อ", "คือ", "เป็น", "อย่าง", "ทุก",
  "ช่วง", "ซับ", "นำ", "งาน",
]);
const THAI_BINDS_PREVIOUS = new Set([
  "เดียว", "แล้ว", "อยู่", "ไว้", "มาก", "ขึ้น", "ลง", "ก่อน", "หลัง", "ทันที", "เสมอ", "จริง", "ได้", "ๆ",
]);
const THAI_FINAL_CLOSING_TOKENS = new Set(["ได้"]);

function completesNaturalThaiPhrase(previous: string, current: string): boolean {
  return THAI_BINDS_NEXT.has(previous) || THAI_BINDS_PREVIOUS.has(current);
}

/**
 * Regroup word-timed tokens into cards targeting N words that never cross a sentence/line
 * boundary. A Thai phrase may use one extra token to avoid a dangling function word;
 * otherwise the v2 "≤N คำ" density is preserved. Card text is SLICED from the original
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
    if (grp.length > 0) {
      // Authored sentence/line boundaries always win over natural-phrase grouping.
      const hardBoundary = SENTENCE_BOUNDARY_RE.test(
        fullText.slice(grp[grp.length - 1].endChar, words[i].startChar),
      );
      if (hardBoundary) {
        flush();
      } else if (grp.length >= n) {
        const allowOneNaturalToken = n <= 3 && grp.length === n
          && completesNaturalThaiPhrase(grp[grp.length - 1].word, words[i].word);
        // Mode 2 may need one final closing auxiliary after the N+1 phrase
        // (e.g. ใช้+งาน+จริง+ได้). This is still bounded at N+2 and keeps the
        // exact provider timing for every token.
        const allowFinalClosingToken = n <= 2 && grp.length === n + 1
          && THAI_FINAL_CLOSING_TOKENS.has(words[i].word);
        if (!allowOneNaturalToken && !allowFinalClosingToken) flush();
      }
    }
    grp.push(words[i]);
  }
  flush();
  return out;
}

export function buildBurnConfig(baseVideoUrl: string, captions: OrchCaption[], audioDurationMs: number, fps: number = RENDER_FPS, topPercent?: number) {
  return buildHeroSubtitleOverlayConfig({
    baseVideoUrl,
    captions,
    durationMs: audioDurationMs,
    fps,
    design: {
      fontFamily: DEFAULT_STYLE.fontFamily,
      positionTopPercent: topPercent ?? DEFAULT_STYLE.subtitlePosition,
      fontSize: DEFAULT_STYLE.subtitleSize,
      fontWeight: DEFAULT_STYLE.subtitleFontWeight,
      color: DEFAULT_STYLE.subtitleColor,
      accentColor: DEFAULT_STYLE.subtitleAccentColor,
      stylePreset: DEFAULT_STYLE.subtitleStylePreset,
      textEffect: DEFAULT_STYLE.subtitleTextEffect,
    },
  });
}
