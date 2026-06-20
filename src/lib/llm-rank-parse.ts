/**
 * Parse an LLM B-roll ranking response into a positional array of candidate
 * indices — one per subtitle/keyword. A value of -1 means "no LLM pick" → the
 * caller falls back to deterministic soft-score ranking for that subtitle.
 *
 * Robust to Gemini's two real-world failure modes (measured on prod: the ranker
 * lost its whole result on ~14% of runs / ~18.5% of keywords because the old
 * parser discarded the entire batch on any length mismatch):
 *  - off-by-count: the model returns N±1 entries. Index-keyed parsing aligns by
 *    key, so a missing entry only nulls THAT subtitle — no positional shift that
 *    would mis-assign every following clip.
 *  - truncation: the model's output is cut by the token cap. We salvage every
 *    complete `"key": value` pair instead of throwing the batch away.
 *
 * Accepts either output shape:
 *  - index-keyed object `{"0": 3, "1": -1, ...}` (preferred — the prompt asks
 *    for this; partial / truncated objects are salvaged by key)
 *  - a plain integer array of EXACTLY `expectedCount` entries (back-compat,
 *    positional). A wrong-length plain array is NOT positionally salvaged,
 *    because a dropped middle element would silently mis-align the rest.
 *
 * Anything unparseable → all -1 (fail-open: deterministic fallback, unchanged).
 */
export function parseLlmRankResponse(
  text: string,
  expectedCount: number,
  candidateCounts: number[],
): number[] {
  const out = new Array<number>(expectedCount).fill(-1);

  const num = (v: unknown): number => (typeof v === "number" ? v : parseInt(String(v), 10));
  // Clamp to a valid candidate index for this subtitle (parity with the old
  // inline logic): negatives / NaN → -1, over-range → last candidate, and a
  // keyword with 0 candidates can never get a pick.
  const clamp = (i: number, n: number): number => {
    if (!Number.isFinite(n) || n < 0) return -1;
    const maxIdx = (candidateCounts[i] ?? 1) - 1;
    return Math.min(Math.trunc(n), maxIdx);
  };

  // 1) Index-keyed object (incl. truncated / markdown-fenced). Look for the
  //    first '{' so a missing closing brace doesn't defeat us.
  const braceStart = text.indexOf("{");
  if (braceStart >= 0) {
    const objText = text.slice(braceStart);
    let assigned = false;

    const closed = objText.match(/^\{[\s\S]*\}/);
    if (closed) {
      try {
        const obj = JSON.parse(closed[0]);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          for (const [k, v] of Object.entries(obj)) {
            const i = parseInt(k, 10);
            if (i >= 0 && i < expectedCount) {
              out[i] = clamp(i, num(v));
              assigned = true;
            }
          }
        }
      } catch {
        // closed-object JSON.parse failed (stray prose) → fall through to salvage
      }
    }

    if (!assigned) {
      // Salvage every complete `"key": value` pair (handles truncated tails).
      const re = /"?(\d+)"?\s*:\s*(-?\d+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(objText)) !== null) {
        const i = parseInt(m[1], 10);
        if (i >= 0 && i < expectedCount) {
          out[i] = clamp(i, parseInt(m[2], 10));
          assigned = true;
        }
      }
    }

    if (assigned) return out;
  }

  // 2) Back-compat: a plain integer array of EXACTLY expectedCount → positional.
  const arrMatch = text.match(/\[[\d,\s-]+\]/);
  if (arrMatch) {
    try {
      const arr = JSON.parse(arrMatch[0]);
      if (Array.isArray(arr) && arr.length === expectedCount) {
        for (let i = 0; i < expectedCount; i++) out[i] = clamp(i, num(arr[i]));
        return out;
      }
    } catch {
      // not valid JSON → fall through to all -1
    }
  }

  // 3) Nothing usable → deterministic fallback for every subtitle.
  return out;
}
