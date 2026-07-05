// automix-weights.ts — validate the untrusted `autoMixWeights` request field
// (Editor v2 "mix preset"). PURE, no I/O.
//
// The Editor v2 mix-preset UI sends per-request Auto Mix weights so paid users can
// pick how much AI vs stock is in the mix (ฟรีล้วน / ผสม AI แนะนำ / AI เต็มที่).
// These weights are only ever HONORED under MANAGED_KIE by fetch-stock, and the ai
// weight is force-zeroed there for users not authorized for kie spend — this module
// only decides whether the field is well-formed at all (three integers in [0,9]).

import type { AutoMixWeights } from "./automix-plan";

/**
 * Parse an untrusted `autoMixWeights` value. Returns the weights ONLY when `raw`
 * is an object whose `video`/`photo`/`ai` are each an integer in the range [0, 9];
 * anything else (missing field, non-object, non-int, out of range) → `null`, and
 * the caller falls back to the env-var defaults. Pure — no side effects.
 */
export function parseAutoMixWeights(raw: unknown): AutoMixWeights | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const okInt = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 9;
  if (!okInt(w.video) || !okInt(w.photo) || !okInt(w.ai)) return null;
  return { video: w.video, photo: w.photo, ai: w.ai };
}
