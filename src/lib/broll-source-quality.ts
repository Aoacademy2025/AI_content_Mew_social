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
 * #8 Full-HD resolution floor for Pixabay while respecting #63 (never pull 4K >1920).
 * The render output is 1080×1920. Pixabay `medium` is frequently 360×640 or 540×960,
 * which looks visibly blurry when upscaled 2–3× to 1080×1920. Whenever `medium` is
 * sub-Full-HD (<1080 long side) and `large` offers higher resolution without exceeding
 * 1920px (avoiding 4K 2160×3840 downloads), upgrade to `large`.
 *
 * When dimensions are unknown (0), behaves like the `medium ?? large` fallback.
 */
export function pickPixabayVariant(
  medium: StockVariant,
  large: StockVariant,
): { url: string; width?: number; height?: number } {
  const medLong = Math.max(medium?.width ?? 0, medium?.height ?? 0);
  const lgLong = Math.max(large?.width ?? 0, large?.height ?? 0);
  const useLarge =
    (!medium?.url || (medLong > 0 && medLong < 1080 && lgLong > medLong))
    && !!large?.url
    && ( !medium?.url || (lgLong > 0 && lgLong <= 1920) );
  const chosen = useLarge ? large : (medium ?? large);
  return { url: chosen?.url ?? "", width: chosen?.width, height: chosen?.height };
}
