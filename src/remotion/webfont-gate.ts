import { useCallback, useEffect, useRef, useState } from "react";
import { continueRender, delayRender } from "remotion";

/** Longest a frame is held for the webfonts. Past it the frame is shot anyway (fallback face). */
export const WEBFONT_GATE_CAP_MS = 5_000;
const WEIGHTS = [400, 500, 600, 700, 800, 900] as const;
// Google serves Thai and Latin as separate unicode-range faces: one character of each loads both.
const SAMPLE = "กA1";

/**
 * Holds the frame until the Google Fonts sheet has arrived AND the faces for `families` have
 * loaded, capped at WEBFONT_GATE_CAP_MS (then it continues; it never fails the render).
 *
 * Remotion's own wait is `document.fonts.ready`, which resolves at once while the sheet is still
 * in flight (no @font-face rules yet). A preview still is always the FIRST frame of a fresh
 * browser, so without this hold it is shot in the fallback face, or blank on a host with no Thai
 * system font. Only the still asks for it (`awaitWebfonts`); with `enabled` false this takes no
 * delayRender and returns no props, so every export renders exactly as before.
 *
 * Returns the props to spread on the sheet's `<link>`.
 */
export function useWebfontGate(
  enabled: boolean,
  families: readonly (string | null | undefined)[],
): { onLoad?: () => void; onError?: () => void } {
  const [handle] = useState(() => (enabled
    ? delayRender("webfonts (preview still)", { timeoutInMilliseconds: WEBFONT_GATE_CAP_MS + 10_000 })
    : null));
  const released = useRef(false);
  const release = useCallback(() => {
    if (handle === null || released.current) return;
    released.current = true;
    continueRender(handle);
  }, [handle]);
  useEffect(() => {
    if (handle === null) return;
    const timer = setTimeout(release, WEBFONT_GATE_CAP_MS);
    return () => {
      clearTimeout(timer);
      release();
    };
  }, [handle, release]);
  // The first family of each stack is the one the text asks for; the rest are fallbacks.
  const firstFamilies = [...new Set(families.map((stack) => stack?.split(",")[0]?.trim()).filter(Boolean))].join("|");
  const onSheet = useCallback(() => {
    try {
      const loads = firstFamilies.split("|").filter(Boolean).flatMap((family) =>
        WEIGHTS.map((weight) => document.fonts.load(`${weight} 48px ${family}`, SAMPLE)));
      Promise.allSettled(loads).then(release, release);
    } catch {
      release();
    }
  }, [firstFamilies, release]);
  return handle === null ? {} : { onLoad: onSheet, onError: release };
}
