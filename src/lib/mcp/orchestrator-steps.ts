import { groupTimedCaptionWords } from "../word-caption-groups";
import { DEFAULT_CARD_SUBTITLE_SIZE } from "../card-line-budget";
// PURE request-payload builders that reproduce the video-editor's non-avatar
// chain (verified against page.tsx 2026-06-13). No I/O — unit-testable.

import { stockMoodForProject, pacingForProject, type BrollPreferenceInput, type ResolvedStockMood } from "@/lib/broll-preferences";
import type { PacingLevel, StylePackId } from "@/lib/style-pack-catalog";
import { stylePackSnapshotFromJson } from "@/lib/style-pack-snapshot";
import { buildHeroSubtitleOverlayConfig, type HeroSubtitleDesign } from "@/lib/hero-editorial";
import type { SubtitleCardLen, SubtitleStylePresetConfig } from "@/lib/editor-style-preset-contract";
import {
  DEFAULT_V2_SUB,
  V2_QUICK_STYLES,
  type V2SubConfig,
} from "@/app/(dashboard)/video-editor/_v2/subtitle-style";

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

// Card Line Budget lives in the pure module so the caption core and renderer share it.
export { maxCardCharsFor } from "../card-line-budget";

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
export function cardsByWordCount(
  words: CharWord[],
  n: number,
  fullText: string,
  subtitleSize: number = DEFAULT_CARD_SUBTITLE_SIZE,
): OrchCaption[] {
  return groupTimedCaptionWords(words, n, fullText, subtitleSize) as OrchCaption[];
}

/** The burned overlay now takes the fully resolved design (T4) instead of building one
 *  from the MCP-only DEFAULT_STYLE — callers pass `v2SubConfigToHeroDesign(resolved)`. */
export function buildBurnConfig(
  baseVideoUrl: string,
  captions: OrchCaption[],
  audioDurationMs: number,
  design: HeroSubtitleDesign,
  fps: number = RENDER_FPS,
) {
  return buildHeroSubtitleOverlayConfig({
    baseVideoUrl,
    captions,
    durationMs: audioDurationMs,
    fps,
    design,
  });
}

// ── T4: MCP subtitle style resolution ───────────────────────────────────────────────
// Subtitle style resolution order (Global Constraints): explicit MCP args → Brand
// Subtitle Style → DEFAULT_V2_SUB. A brand affects only the subtitle look this round —
// voice, visuals and logo are never touched. Mode/position resolve per field: an
// explicit subtitleMode/subtitlePosition always beats the brand's cardLen/verticalPos,
// even when the rest of the design comes from the brand.

/** V2SubConfig (what MCP resolves, and what the web editor already burns) →
 *  HeroSubtitleDesign (the Remotion burn contract `buildHeroSubtitleOverlayConfig`
 *  takes). `fontFamily` passes through as the plain family name: the web editor
 *  burns it unquoted too (`buildV2BurnConfig`), and `SubtitleOverlayComposition`'s
 *  CSS-stack fallback only applies when it is falsy. `preset`/`effect` and
 *  `stylePreset`/`textEffect` share one literal id set (`_components/types.ts` vs
 *  `remotion/types.ts`), so the cast is an identity, not a lookup. */
export function v2SubConfigToHeroDesign(cfg: V2SubConfig): HeroSubtitleDesign {
  return {
    fontFamily: cfg.fontFamily,
    positionTopPercent: cfg.verticalPos,
    fontSize: cfg.fontSize,
    fontWeight: cfg.fontWeight ?? (cfg.bold ? 900 : 400),
    color: cfg.textColor,
    accentColor: cfg.accentColor,
    stylePreset: cfg.preset as HeroSubtitleDesign["stylePreset"],
    textEffect: cfg.effect as HeroSubtitleDesign["textEffect"],
    shadow: cfg.shadow,
    outline: cfg.outline,
    outlineSize: cfg.outlineSize,
  };
}

/** Brand Subtitle Style (an immutable Revision's own persisted preset,
 * `payload.subtitle.config` normalized) → the same V2SubConfig shape explicit args
 * and DEFAULT_V2_SUB resolve against. Drops `cardLen`: T4 resolves card length
 * separately from the rest of the look (see `resolveMcpSubtitleDesign`). */
export function brandSubtitleStyleToV2SubConfig(preset: SubtitleStylePresetConfig): V2SubConfig {
  const { cardLen: _cardLen, ...design } = preset;
  return design;
}

export type McpSubtitleStyleArgs = {
  subtitleSize?: number;
  subtitleStyle?: string;
  subtitleColor?: string;
  subtitleAccentColor?: string;
  subtitlePosition?: "top" | "middle" | "bottom";
  subtitleMode?: SubtitleCardLen;
};

/** Resolve one job's subtitle design + card length from explicit MCP args and an
 * (already looked-up) Brand Subtitle Style. Pure — the brand lookup itself (owner
 * check, active-only, foreign/inactive refusal) is `resolveMcpBrandSubtitleStyle`
 * in `brand-profile-library.server.ts`; this function only merges precedence. */
export function resolveMcpSubtitleDesign(
  args: McpSubtitleStyleArgs,
  brandStyle: SubtitleStylePresetConfig | null,
): { design: V2SubConfig; cardLen: SubtitleCardLen } {
  const base: V2SubConfig = brandStyle ? brandSubtitleStyleToV2SubConfig(brandStyle) : DEFAULT_V2_SUB;
  const quickStyle = args.subtitleStyle
    ? V2_QUICK_STYLES.find((style) => style.key === args.subtitleStyle)
    : undefined;
  const design: V2SubConfig = {
    ...base,
    ...(quickStyle ? { preset: quickStyle.preset, effect: quickStyle.effect } : {}),
    ...(args.subtitleSize !== undefined ? { fontSize: args.subtitleSize } : {}),
    ...(args.subtitleColor ? { textColor: args.subtitleColor } : {}),
    ...(args.subtitleAccentColor ? { accentColor: args.subtitleAccentColor } : {}),
    ...(args.subtitlePosition ? { verticalPos: POSITION_TOP_PERCENT[args.subtitlePosition] } : {}),
  };
  const cardLen: SubtitleCardLen = args.subtitleMode ?? brandStyle?.cardLen ?? "sentence";
  return { design, cardLen };
}

export type ResolvedMcpSubtitleJobInput = {
  subtitleDesign?: V2SubConfig;
  subtitleCardLen?: SubtitleCardLen;
  /** Pre-T4 jobs only ever carried the raw arg under this key. */
  subtitleMode?: string;
};

/** Read back what `resolveMcpSubtitleDesign` persisted into job `inputJson` (T4). A
 * job created before this field existed falls back to DEFAULT_V2_SUB and its own
 * `subtitleMode` — exactly pre-T4 behaviour (DEFAULT_CARD_SUBTITLE_SIZE/DEFAULT_STYLE
 * for the design, `subtitleMode || "sentence"` for the mode). Both `orchestrator.ts`
 * burn sites and T3's QA finding read the design/size through this one helper. */
export function resolvedMcpSubtitleDesignFromInput(
  input: ResolvedMcpSubtitleJobInput,
): { design: V2SubConfig; cardLen: SubtitleCardLen } {
  return {
    design: input.subtitleDesign ?? DEFAULT_V2_SUB,
    cardLen: input.subtitleCardLen ?? (input.subtitleMode as SubtitleCardLen | undefined) ?? "sentence",
  };
}
