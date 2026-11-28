import { buildEnableExpr } from "@/lib/cutaway-plan";
import { planPunchZoomIntervals, type PunchZoomInterval } from "@/lib/presenter-punch-zoom";

export type CutawayPersonRange = { start: number; end: number };

export type CutawayCompositeOptions = {
  punchZoom?: boolean;
  cueTimesSec?: readonly number[];
  /**
   * Optional dissolve lead-in (seconds) when the base reel (`[0:v]`) contains
   * `timelineAligned` presenter segments that crossfade back from B-roll over
   * `CROSSFADE_FRAMES`. Delaying internal presenter overlay re-entries by this
   * lead-in lets the `[0:v]` dissolve complete before `[1:v]` takes over.
   */
  dissolveLeadInSec?: number;
};

const PRESENTER_COVER_SCALE =
  "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,setsar=1";

function applyDissolveLeadIn(
  ranges: readonly CutawayPersonRange[],
  leadInSec: number | undefined,
): CutawayPersonRange[] {
  const lead = Number(leadInSec);
  if (!Number.isFinite(lead) || lead <= 0) return [...ranges];
  return ranges.map((r) => {
    if (r.start > 0.05 && r.end - r.start > lead + 0.4) {
      return {
        start: Math.round((r.start + lead) * 1000) / 1000,
        end: r.end,
      };
    }
    return r;
  });
}

/**
 * When `[0:v]` cross-dissolves `timelineAligned` presenter segments (`1.00x`) into and
 * out of B-roll (`dissolveLeadInSec > 0`), any `1.15x` punch-zoom interval that starts
 * right at an incoming dissolve (`r.start > 0.05`) or ends right at an outgoing B-roll
 * dissolve (`r.end` before another range) would snap `1.15x <-> 1.00x` on the exact
 * transition frame. Keep only interior jump-cut zoom beats (or closing tail beats that
 * do not hand off to B-roll) so every B-roll dissolve stays 100% scale-continuous.
 */
function filterDissolveSafeZoomIntervals(
  zoomIntervals: readonly PunchZoomInterval[],
  originalRanges: readonly CutawayPersonRange[],
  effectiveRanges: readonly CutawayPersonRange[],
  dissolveLeadInSec: number | undefined,
): PunchZoomInterval[] {
  const lead = Number(dissolveLeadInSec);
  if (!Number.isFinite(lead) || lead <= 0) return [...zoomIntervals];

  const entryDissolveTimes: number[] = [];
  const exitDissolveTimes: number[] = [];
  for (let i = 0; i < effectiveRanges.length; i += 1) {
    const orig = originalRanges[i];
    const eff = effectiveRanges[i]!;
    if (orig && orig.start > 0.05) {
      entryDissolveTimes.push(eff.start);
    }
    if (i < effectiveRanges.length - 1) {
      exitDissolveTimes.push(eff.end);
    }
  }

  return zoomIntervals.filter((z) => {
    const touchesEntryDissolve = entryDissolveTimes.some((t) => Math.abs(z.start - t) <= 0.05);
    const touchesExitDissolve = exitDissolveTimes.some((t) => Math.abs(z.end - t) <= 0.05);
    return !touchesEntryDissolve && !touchesExitDissolve;
  });
}

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
  const effectiveRanges = applyDissolveLeadIn(
    personRangesSec,
    options?.dissolveLeadInSec,
  );
  const enableExpr = buildEnableExpr(effectiveRanges);
  if (!enableExpr) return null;

  if (options?.punchZoom) {
    const rawZoomIntervals = planPunchZoomIntervals(
      effectiveRanges,
      options.cueTimesSec,
    );
    const zoomIntervals = filterDissolveSafeZoomIntervals(
      rawZoomIntervals,
      personRangesSec,
      effectiveRanges,
      options.dissolveLeadInSec,
    );
    const zoomEnableExpr = buildEnableExpr(zoomIntervals);
    if (zoomEnableExpr) {
      return [
        "[0:v]scale=1080:1920:flags=lanczos,setsar=1[bg]",
        `[1:v]${PRESENTER_COVER_SCALE},split=2[fg][fg_zoom_src]`,
        "[fg_zoom_src]scale=1242:2208:flags=lanczos,crop=1080:1920:81:109,setsar=1[fg_zoom]",
        `[bg][fg]overlay=0:0:format=auto:enable='${enableExpr}'[bg_fg]`,
        `[bg_fg][fg_zoom]overlay=0:0:format=auto:enable='${zoomEnableExpr}'[out]`,
      ].join(";");
    }
  }

  return [
    "[0:v]scale=1080:1920:flags=lanczos,setsar=1[bg]",
    `[1:v]${PRESENTER_COVER_SCALE}[fg]`,
    `[bg][fg]overlay=0:0:format=auto:enable='${enableExpr}'[out]`,
  ].join(";");
}
