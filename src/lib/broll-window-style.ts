/**
 * Per-window B-roll presentation (EP5 #11 hard cut, U3 fit). Pure — shared by the core edit
 * model (broll-rerender), coverage, the Remotion composition, the web editor and MCP.
 *
 * Every field is optional and an absent field means today's look, so a config written before
 * this existed renders exactly as it did:
 *  - `transition` (window) — how the window ENDS: "dissolve" (crossfade into the next window;
 *    the last window fades to black) or "cut" (hard cut; the last window ends without the fade).
 *    Absent = the project default `brollTransition` (config level), absent = "dissolve".
 *  - `fit` (window) — "cover" (fill the frame, crop) or "contain" (whole picture, letterboxed
 *    over a blurred, darkened copy of itself). Absent = "cover".
 */
export const BROLL_TRANSITIONS = ["dissolve", "cut"] as const;
export type BrollTransition = (typeof BROLL_TRANSITIONS)[number];

export const BROLL_FITS = ["cover", "contain"] as const;
export type BrollFit = (typeof BROLL_FITS)[number];

/** Edit-only value: drop the window's own transition so it follows the project default again. */
export const BROLL_TRANSITION_FOLLOW_DEFAULT = "default";
export type BrollTransitionEdit = BrollTransition | typeof BROLL_TRANSITION_FOLLOW_DEFAULT;

export function isBrollTransition(value: unknown): value is BrollTransition {
  return value === "dissolve" || value === "cut";
}

export function isBrollTransitionEdit(value: unknown): value is BrollTransitionEdit {
  return isBrollTransition(value) || value === BROLL_TRANSITION_FOLLOW_DEFAULT;
}

export function isBrollFit(value: unknown): value is BrollFit {
  return value === "cover" || value === "contain";
}

/** The window's own value wins, then the project default, then today's dissolve. */
export function effectiveBrollTransition(windowValue: unknown, projectDefault: unknown): BrollTransition {
  if (isBrollTransition(windowValue)) return windowValue;
  return projectDefault === "cut" ? "cut" : "dissolve";
}

export function effectiveBrollFit(windowValue: unknown): BrollFit {
  return windowValue === "contain" ? "contain" : "cover";
}

/** Only the style fields a window actually set (no `undefined` keys — legacy output stays identical). */
export function brollWindowStyle(
  window: { transition?: unknown; fit?: unknown } | null | undefined,
): { transition?: BrollTransition; fit?: BrollFit } {
  return {
    ...(isBrollTransition(window?.transition) ? { transition: window.transition } : {}),
    ...(isBrollFit(window?.fit) ? { fit: window.fit } : {}),
  };
}

/**
 * Per rendered segment, in timeline order: `true` = no dissolve after segment i (and, for the
 * last segment, no fade to black at the end of the video).
 */
export function brollCutAfter(
  segments: readonly { transition?: unknown }[],
  projectDefault: unknown,
): boolean[] {
  return segments.map((segment) => effectiveBrollTransition(segment.transition, projectDefault) === "cut");
}
