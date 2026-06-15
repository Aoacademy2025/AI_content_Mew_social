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
 * #8 soft resolution floor for Pixabay. Prefer `medium` (the variable mid-res variant —
 * avoids Pixabay's up-to-4K `large`, respecting the #63 downscale cap). But some sources'
 * medium is only 540/720p, which upscales to a soft 1080×1920 — the #1 "looks cheap" tell.
 * So if medium's long side is below 720, fall UP to `large` — but ONLY when large stays
 * ≤1920 long side, so we never reintroduce the 4K download #63 removed.
 *
 * When dimensions are unknown (0), behaves like the old `medium ?? large` fallback.
 */
export function pickPixabayVariant(
  medium: StockVariant,
  large: StockVariant,
): { url: string; width?: number; height?: number } {
  const medLong = Math.max(medium?.width ?? 0, medium?.height ?? 0);
  const lgLong = Math.max(large?.width ?? 0, large?.height ?? 0);
  const useLarge = (!medium?.url || medLong < 720) && !!large?.url && lgLong > 0 && lgLong <= 1920;
  const chosen = useLarge ? large : (medium ?? large);
  return { url: chosen?.url ?? "", width: chosen?.width, height: chosen?.height };
}
