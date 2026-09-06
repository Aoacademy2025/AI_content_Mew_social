import { groupTimedCaptionWords } from "../word-caption-groups";
// PURE request-payload builders that reproduce the video-editor's non-avatar
// chain (verified against page.tsx 2026-06-13). No I/O — unit-testable.

import { stockMoodForProject, pacingForProject, type BrollPreferenceInput, type ResolvedStockMood } from "@/lib/broll-preferences";
import type { PacingLevel, StylePackId } from "@/lib/style-pack-catalog";
import { stylePackSnapshotFromJson } from "@/lib/style-pack-snapshot";
import { buildHeroSubtitleOverlayConfig } from "@/lib/hero-editorial";

/** What one video job's pinned Style Pack resolves to at render time: the
 *  Stock Mood driving B-roll search, and the Pacing driving window cadence /
 *  AI-gen min-hold (Task 5). `resolvePacing` returns `null` when no pack is
 *  pinned (or the lookup failed) — NOT `"normal"` — so a caller that only
 *  sends an override when a pack is actually pinned (e.g. `minHoldSec`) can
 *  tell "no pack" apart from "a pinned pack whose pacing is normal". A caller
 *  that only needs the cadence multiplier can still treat `null` as ×1. */
export interface StylePackRenderResolver {
  resolveStockMood: () => Promise<ResolvedStockMood | null>;
  resolvePacing: () => Promise<PacingLevel | null>;
}

/** The `style_pack_pinned` telemetry detail (Task 9) — `packId` and `version`
 *  come straight off the pinned snapshot; `source` says which of the two
 *  precedence layers supplied it, same vocabulary as the visual-context GET
 *  route's `stylePackSource`. */
export type StylePackPinnedDetail = {
  packId: StylePackId;
  version: string;
  source: "project" | "brand";
};

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
 *  same answer) and fail-open: any failing lookup yields `null` for BOTH
 *  facets — no pack, never a reason for a render to stop. `resolveStockMood`
 *  and `resolvePacing` both read the SAME memoized snapshot load — one
 *  resolution, two readers — so a job can never render one facet from a
 *  different snapshot than the other.
 *
 *  `onPinned` (Task 9) is this resolver's own once-per-job accounting for the
 *  `style_pack_pinned` telemetry event: it fires at most once per resolver
 *  instance — the first time EITHER facet's read finds a non-null pack,
 *  regardless of how many times `resolveStockMood`/`resolvePacing` are called
 *  or in what order — and never at all when no pack is pinned anywhere. Kept
 *  IN the resolver (not the orchestrator) because it shares the exact same
 *  memoized read and precedence: a second, separately-computed "is a pack
 *  pinned" check could disagree with the one `resolveStockMood` acted on.
 *  Fails open like everything else here: a throwing `onPinned` (or a throwing
 *  loader) can never surface past this function. */
export function createStylePackRenderResolver(
  load: {
    projectVisualContextJson: () => Promise<string | null>;
    brandRevisionRecipeJson: () => Promise<string | null>;
  },
  options?: {
    onPinned?: (detail: StylePackPinnedDetail) => void;
  },
): StylePackRenderResolver {
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
  let pinnedNotified = false;
  const notifyPinnedOnce = async () => {
    if (pinnedNotified || !options?.onPinned) return;
    try {
      const { projectVisualContextJson, brandRevisionRecipeJson } = await resolveJson();
      const projectSnapshot = stylePackSnapshotFromJson(projectVisualContextJson);
      const detail: StylePackPinnedDetail | null = projectSnapshot
        ? { packId: projectSnapshot.id, version: projectSnapshot.version, source: "project" }
        : (() => {
            const brandSnapshot = stylePackSnapshotFromJson(brandRevisionRecipeJson);
            return brandSnapshot
              ? { packId: brandSnapshot.id, version: brandSnapshot.version, source: "brand" as const }
              : null;
          })();
      if (!detail) return;
      pinnedNotified = true;
      options.onPinned(detail);
    } catch {
      // A pin notification is a flavour, never a reason for a render to stop.
    }
  };
  return {
    resolveStockMood: async () => {
      try {
        const mood = stockMoodForProject(await resolveJson());
        await notifyPinnedOnce();
        return mood;
      } catch {
        return null;
      }
    },
    resolvePacing: async () => {
      try {
        const pacing = pacingForProject(await resolveJson());
        await notifyPinnedOnce();
        return pacing;
      } catch {
        return null;
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

/** Shared word grouping keeps text, numeric punctuation and Thai phrase edges
 * identical to the editor while preserving the provider's word timing. */
export function cardsByWordCount(words: CharWord[], n: number, fullText: string): OrchCaption[] {
  return groupTimedCaptionWords(words, n, fullText) as OrchCaption[];
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
