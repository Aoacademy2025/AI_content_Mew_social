import { buildEnableExpr } from "@/lib/cutaway-plan";

export type CutawayPersonRange = { start: number; end: number };

/**
 * Build the full-frame presenter-over-B-roll graph used by upload cutaway.
 *
 * The uploaded presenter keeps playing on its original timeline while `enable`
 * controls only when its pixels cover the B-roll. Audio is mapped separately by
 * the route, so this graph never cuts, retimes, or re-muxes narration. Returning
 * null preserves the route's fail-closed empty-range guard.
 */
export function buildCutawayCompositeFilter(
  personRangesSec: CutawayPersonRange[],
): string | null {
  const enableExpr = buildEnableExpr(personRangesSec);
  if (!enableExpr) return null;

  return [
    "[0:v]scale=1080:1920:flags=lanczos,setsar=1[bg]",
    "[1:v]scale=1080:1920:flags=lanczos,setsar=1[fg]",
    `[bg][fg]overlay=0:0:format=auto:enable='${enableExpr}'[out]`,
  ].join(";");
}
