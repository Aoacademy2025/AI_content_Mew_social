/**
 * Pure helpers for picking higher-quality b-roll out of the free stock APIs.
 * Kept separate from the fetch-stock route so they can be unit-tested in isolation
 * (scripts/verify-broll-source-quality.ts).
 */

/**
 * Long side of a clip, CLAMPED to 1920. Used as the HD tiebreaker when two
 * candidates score equally on relevance: prefer the sharper clip, but cap at 1920
 * so anything already ≥Full-HD ranks the same. The clamp matters because Pexels and
 * Pixabay report raw dimensions differently — without it a provider that returns
 * larger raw clips (e.g. Pixabay "large") would always win the tiebreak regardless
 * of real quality. It is load-bearing, not just defensive: the rare Pexels portrait
 * last-resort fallback can still return a >1920 file, and this clamp keeps such a clip
 * from dominating the tiebreak on real quality grounds.
 */
export function clampedLongSide(width?: number, height?: number): number {
  return Math.min(1920, Math.max(width ?? 0, height ?? 0));
}

export type StockVariant = { url?: string; width?: number; height?: number } | undefined;

/**
 * #8 soft resolution floor for Pixabay — RETUNED for normalize cost.
 * The render output is 1080×1920 and every clip is downscaled to fit it in
 * normalizeForRemotion, so decoding a source much larger than that is wasted CPU.
 * A/B on prod (2026-06-16): re-encoding a 1440p source took 156s vs 69s for the
 * same clip at 540p (~2.3× slower) — and the original #8 fell up to `large` (≤1920)
 * for the COMMON case (Pixabay medium is ~540p), which roughly doubled b-roll
 * normalize time per clip and stacked to ~35min/video over ~36 serial clips.
 *
 * So strongly prefer the smaller `medium` (restores pre-#8 speed). Only fall up to
 * `large` when medium is genuinely tiny (<480 long side) AND large stays modest
 * (≤1280) — keeps the anti-"soft/upscaled" intent for the worst cases without
 * paying the 1920p decode tax on every clip.
 *
 * When dimensions are unknown (0), behaves like the old `medium ?? large` fallback.
 */
export function pickPixabayVariant(
  medium: StockVariant,
  large: StockVariant,
): { url: string; width?: number; height?: number } {
  const medLong = Math.max(medium?.width ?? 0, medium?.height ?? 0);
  const lgLong = Math.max(large?.width ?? 0, large?.height ?? 0);
  const useLarge = (!medium?.url || medLong < 480) && !!large?.url && lgLong > 0 && lgLong <= 1280;
  const chosen = useLarge ? large : (medium ?? large);
  return { url: chosen?.url ?? "", width: chosen?.width, height: chosen?.height };
}
