import {
  avatarFadeBlendFilter,
  normalizeAvatarFadeWindows,
} from "@/lib/avatar-fade";

export type CutawayPersonRange = { start: number; end: number };

/**
 * Build the exact full-frame presenter-over-B-roll graph used by upload cutaway.
 * The presenter source keeps playing on its original timeline; only its opacity
 * changes at each person-range edge, so the dissolve cannot shift audio or media
 * offsets. Returning null preserves the route's fail-closed empty-range guard.
 */
export function buildCutawayCompositeFilter(
  personRangesSec: readonly CutawayPersonRange[],
): string | null {
  const fadeWindows = normalizeAvatarFadeWindows(
    (Array.isArray(personRangesSec) ? personRangesSec : []).map((range) => ({
      startSec: Number(range?.start),
      endSec: Number(range?.end),
    })),
  );
  if (fadeWindows.length === 0) return null;

  return [
    "[0:v]scale=1080:1920:flags=lanczos,setsar=1,split=2[bg][bg_fade]",
    "[1:v]scale=1080:1920:flags=lanczos,setsar=1[fg]",
    "[bg][fg]overlay=0:0:format=auto[cutaway_composite]",
    avatarFadeBlendFilter({
      compositeLabel: "cutaway_composite",
      backgroundLabel: "bg_fade",
      outputLabel: "out",
      windows: fadeWindows,
    }),
  ].join(";");
}
