/**
 * Pure seconds→minutes rounding — NO prisma import, so it can be bundled client-side
 * (Editor v2 Render Receipt) from the SAME source the server meters minutes with.
 * Re-exported by minute-limits.ts for the server call sites.
 */

/** Convert a duration in seconds to whole minutes, ROUNDED TO NEAREST, minimum 1.
 *  One-system rounding (Mew 2026-06-26): nearest, not ceil — a 1:05 clip = 1 min,
 *  1:45 = 2 min. Non-finite / non-positive / NaN inputs default to 60s (→ 1 min). */
export function minutesFromSeconds(sec: number): number {
  return Math.max(1, Math.round((Number.isFinite(sec) && sec > 0 ? sec : 60) / 60));
}
