import type { SubPreset, SubTextEffect } from "./types";
import { renderSubtitle } from "@/remotion/renderSubtitle";

/**
 * Render subtitle text with a given preset style for the editor preview.
 *
 * THIS WRAPS THE SAME `renderSubtitle` FUNCTION THE REMOTION RENDER USES.
 * What the user sees in preview is exactly what gets burned into the MP4.
 *
 * Old signature is preserved so existing callers don't have to change.
 *
 * @param scale  multiplier on font size to fit the preview viewport
 *               (full render = 1; small preview overlay = 200/1080 etc.)
 */
export function renderSubEl(
  text: string,
  color: string,
  accentColor: string,
  isAccent: boolean,
  preset: SubPreset,
  fontFamily: string,
  fontSizePx: number,
  fontWeight: number,
  scale = 1,
  textEffect: SubTextEffect = "pop",
  // Pass a live frame + the caption's total duration (in frames) to drive the
  // frame-based effects (glow-pulse / highlight / karaoke / typewriter) in the
  // preview. Defaults reproduce the old static (resting-frame) look.
  frame = 0,
  captionDurFrames = 1,
): React.ReactNode {
  // The Remotion renderer expects the final pixel size; scale it here so the
  // preview overlay (e.g. 260/1080 phone frame) matches what gets rendered at 1080.
  const scaledSize = Math.max(1, Math.round(fontSizePx * scale));
  const effectiveColor = isAccent ? accentColor : color;
  return renderSubtitle(
    text,
    effectiveColor,
    scaledSize,
    isAccent,
    preset,
    fontFamily,
    fontWeight,
    frame,
    captionDurFrames,
    textEffect,
    accentColor,
  );
}
