import { buildEnableExpr } from "@/lib/cutaway-plan";
import { planPunchZoomIntervals } from "@/lib/presenter-punch-zoom";

export type CutawayPersonRange = { start: number; end: number };

export type CutawayCompositeOptions = {
  punchZoom?: boolean;
  cueTimesSec?: readonly number[];
};

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
  options?: CutawayCompositeOptions,
): string | null {
  const enableExpr = buildEnableExpr(personRangesSec);
  if (!enableExpr) return null;

  if (options?.punchZoom) {
    const zoomIntervals = planPunchZoomIntervals(
      personRangesSec,
      options.cueTimesSec,
    );
    const zoomEnableExpr = buildEnableExpr(zoomIntervals);
    if (zoomEnableExpr) {
      return [
        "[0:v]scale=1080:1920:flags=lanczos,setsar=1[bg]",
        "[1:v]scale=1080:1920:flags=lanczos,setsar=1,split=2[fg][fg_zoom_src]",
        "[fg_zoom_src]scale=1242:2208:flags=lanczos,crop=1080:1920:81:109,setsar=1[fg_zoom]",
        `[bg][fg]overlay=0:0:format=auto:enable='${enableExpr}'[bg_fg]`,
        `[bg_fg][fg_zoom]overlay=0:0:format=auto:enable='${zoomEnableExpr}'[out]`,
      ].join(";");
    }
  }

  return [
    "[0:v]scale=1080:1920:flags=lanczos,setsar=1[bg]",
    "[1:v]scale=1080:1920:flags=lanczos,setsar=1[fg]",
    `[bg][fg]overlay=0:0:format=auto:enable='${enableExpr}'[out]`,
  ].join(";");
}
