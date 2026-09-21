/**
 * HERO-42: the frame painted behind the subtitles when a video is rendered with no
 * B-roll. The colours come from the account's stored brand palette, so they are
 * caller-controlled data on their way into a CSS value — everything that is not a
 * plain six-digit hex colour is dropped rather than escaped.
 *
 * The API route and the Remotion composition both import from here on purpose. A
 * validator and a renderer with separate definitions is how a frame passes every
 * check and still renders black.
 */

/** Used when the account has no brand profile, or its palette holds nothing usable.
 *  Deliberately the house violet rather than black, so a frame with no B-roll still
 *  looks designed instead of broken. */
export const DEFAULT_BACKGROUND_COLORS: readonly string[] = ["#2a1f4d", "#0d0d12"];

/** Matches the brand palette schema's ceiling (`palette: z.array(...).min(1).max(6)`). */
export const MAX_BACKGROUND_COLORS = 6;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function sanitizeBackgroundColors(input: unknown): string[] {
  if (!Array.isArray(input)) return [...DEFAULT_BACKGROUND_COLORS];

  const usable = input
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => HEX_COLOR.test(value))
    .slice(0, MAX_BACKGROUND_COLORS);

  if (usable.length === 0) return [...DEFAULT_BACKGROUND_COLORS];
  // A gradient needs two stops. One brand colour is a legitimate palette, so it is
  // doubled into a flat fill rather than rejected.
  if (usable.length === 1) return [usable[0], usable[0]];
  return usable;
}

export function backgroundGradientCss(colors: readonly string[]): string {
  const stops = sanitizeBackgroundColors([...colors]);
  return `linear-gradient(160deg, ${stops.join(", ")})`;
}
