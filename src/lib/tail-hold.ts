/**
 * EP5 backlog #14: `tailHoldMs` — hold the last video frame for N ms after the voice ends
 * (for end cards). Single source of truth for the bounds, shared by the web control, the MCP
 * `set_tail_hold` tool, `buildV2BurnConfig` (core render math) and the Pending Edit Draft
 * normalizer, exactly like `headline-hook.ts`'s clamps are shared by all of its call sites.
 *
 * Default 0 = today's behaviour exactly (ADR 0066 §3: a web-only knob is fine, but the OFF
 * value must never change an existing render).
 */
export const TAIL_HOLD_MS_MIN = 0;
export const TAIL_HOLD_MS_MAX = 3_000;

/** Any non-finite/out-of-range input clamps to the nearest bound; `undefined`/`null` → 0. */
export function clampTailHoldMs(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : TAIL_HOLD_MS_MIN;
  return Math.round(Math.min(TAIL_HOLD_MS_MAX, Math.max(TAIL_HOLD_MS_MIN, n)));
}
