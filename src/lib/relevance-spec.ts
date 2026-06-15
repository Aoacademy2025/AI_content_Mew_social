import {
  positiveTermsForProfile, rejectTermsForProfile, fallbackQueriesForProfile,
  normalizeContentProfile, type ContentProfile,
} from "@/lib/broll-profile";

export type RelevanceSpec = {
  visualDomain: string;
  positiveConcepts: string[];
  avoidConcepts: string[];
  safeFallbackQueries: string[];
};

// Neutral shape every consumer (search/score/rank) reads — sourced from a spec OR a profile.
export type RelevanceTerms = {
  positive: string[];
  avoid: string[];
  fallbackQueries: string[];
  domainLabel: string;
};

function cleanTermList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const t = item.trim().toLowerCase().replace(/\s+/g, " ");
    if (t.length >= 2 && t.length <= 60 && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Parse the LLM's JSON relevance spec. Returns null if unusable (caller falls back to profile). */
export function parseRelevanceSpec(llmText: string): RelevanceSpec | null {
  if (typeof llmText !== "string" || !llmText.trim()) return null;
  const stripped = llmText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const objMatch = stripped.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(objMatch[0]) as Record<string, unknown>; } catch { return null; }
  const positive = cleanTermList(parsed.positiveConcepts, 20);
  const avoid = cleanTermList(parsed.avoidConcepts, 20);
  const fallbackQueries = cleanTermList(parsed.safeFallbackQueries, 12);
  const visualDomain = typeof parsed.visualDomain === "string" ? parsed.visualDomain.trim().slice(0, 120) : "";
  // A spec with neither positive signal nor fallback queries can't steer anything — reject it.
  if (positive.length === 0 && fallbackQueries.length === 0) return null;
  return { visualDomain, positiveConcepts: positive, avoidConcepts: avoid, safeFallbackQueries: fallbackQueries };
}

export function specToTerms(spec: RelevanceSpec): RelevanceTerms {
  return {
    positive: spec.positiveConcepts,
    avoid: spec.avoidConcepts,
    fallbackQueries: spec.safeFallbackQueries,
    domainLabel: spec.visualDomain || "general",
  };
}

/** No-LLM fallback: map a fixed content profile into the same neutral terms shape. */
export function profileToTerms(profile: ContentProfile | string): RelevanceTerms {
  const p = normalizeContentProfile(profile);
  return {
    positive: positiveTermsForProfile(p),
    avoid: rejectTermsForProfile(p),
    fallbackQueries: fallbackQueriesForProfile(p),
    domainLabel: p,
  };
}

function tokenizeForRelevance(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
}

function includesTerm(text: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return false;
  return new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(text);
}

/**
 * Soft relevance score for a candidate. Higher = better match. NEVER eliminates a candidate —
 * returns a number the caller sorts by, so the best available clip is always pickable.
 *   +2 per subtitle token that appears in the title (the concrete moment — strongest signal)
 *   +1 per positive concept present in the title
 *   -3 per avoid concept present in the title (only if NOT also in the subtitle context)
 */
export function scoreCandidateSoft(titleText: string, subtitleContext: string, terms: RelevanceTerms): number {
  const title = (titleText ?? "").toLowerCase();
  const ctx = (subtitleContext ?? "").toLowerCase();
  const titleTokens = new Set(tokenizeForRelevance(title));

  let score = 0;
  for (const tok of tokenizeForRelevance(ctx)) if (titleTokens.has(tok)) score += 2;
  for (const term of terms.positive) if (includesTerm(title, term)) score += 1;
  for (const term of terms.avoid) {
    if (includesTerm(title, term) && !includesTerm(ctx, term)) score -= 3;
  }
  return score;
}

/** True when the LLM ranker rejected (-1) at least `thresholdPct`% of items — distrust it. */
export function shouldDistrustRanker(rankResults: number[], thresholdPct: number): boolean {
  if (!rankResults.length) return true;
  const rejected = rankResults.filter((n) => n < 0).length;
  return (rejected / rankResults.length) * 100 >= thresholdPct;
}
