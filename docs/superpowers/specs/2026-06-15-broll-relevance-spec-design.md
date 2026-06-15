# B-roll Relevance: Per-script Relevance Spec + Soft Re-rank

**Date:** 2026-06-15
**Owner:** Mew
**Status:** Design approved — ready for implementation plan

## Problem

B-roll relevance is driven by `src/lib/broll-profile.ts`: a **fixed taxonomy of 10
content profiles** (`detectContentProfile` keyword-count heuristic → one bucket → hardcoded
positive/reject terms + fallback queries + an LLM-prompt block). It was added 2026-06-14
(`b3f0442`) to stop b-roll being unrelated.

It backfires in two ways, confirmed by the 2026-06-15 prod audit:

1. **Misclassification of off-domain content.** A "consumer drones" script is bucketed as
   `ai_tech` / `health_medical` (there is no aviation/gadget profile). The wrong bucket's
   reject terms then fight the actual footage.
2. **Hard reject nukes everything.** Once mis-bucketed, the scoring drops every candidate
   that carries a reject term (`score -= 6` + `isRelevant=false` filter), and the LLM ranker
   is told to "reject candidates outside this profile" → it returns `-1` for **100%** of
   keywords (`llmRejectedCount == keywordCount` in telemetry). The pipeline then force-picks
   by clip duration → irrelevant b-roll.

Adding more buckets (drone, cooking, sports…) does not fix this — every future topic outside
the taxonomy loops the same failure. **The taxonomy is the wrong primary abstraction.**

## Goals

1. **More accurate b-roll** — relevance understands the *actual* script, not a coarse bucket.
2. **No maintenance loop** — new topics need zero new hardcoded buckets.
3. **Never reject-all / never blank** — relevance only re-orders; the best available clip is
   always shown.

Non-goals: changing the render/timeline logic; the web video-editor's manual profile selector
(if any) — see Open Questions. The blank-b-roll safety net is already handled separately
(PR #54, `evenSplitBgVideos`).

## Decision

**Approach A1 + soft re-rank** (chosen over: A2 "soften reject only, keep taxonomy" — does
not kill the loop; A3 "delete taxonomy entirely" — weakens the no-LLM fallback, largest blast
radius).

The **LLM call that already produces `visualDirection`** in `extract-keywords` becomes the
primary relevance source: it also emits a per-script **Relevance Spec**. All scoring reads a
single neutral interface (`RelevanceTerms`) sourced from EITHER the spec OR — only when the
LLM is unavailable — the existing fixed profile. Scoring becomes soft (penalize, never
eliminate). The 10-profile taxonomy is kept solely as the no-LLM fallback.

## Architecture

### Components (each one purpose, independently testable)

**1. `src/lib/relevance-spec.ts` (new) — the brain + scoring**
- `RelevanceSpec = { visualDomain: string; positiveConcepts: string[]; avoidConcepts: string[]; safeFallbackQueries: string[] }`
- `RelevanceTerms = { positive: string[]; avoid: string[]; fallbackQueries: string[]; domainLabel: string }`
  — the neutral shape every consumer reads.
- `parseRelevanceSpec(llmText): RelevanceSpec | null` — JSON extraction + salvage; null on failure.
- `specToTerms(spec): RelevanceTerms`
- `scoreCandidateSoft(titleText, subtitleText, terms): { score: number }` — pure scoring,
  moved out of `fetch-stock` so it is unit-testable. **No elimination** — returns a score only.

**2. `src/lib/broll-profile.ts` (demoted, not deleted)**
- Keep all `PROFILE_*` tables + `detectContentProfile`.
- Add `profileToTerms(profile): RelevanceTerms` mapping the fixed tables into the neutral shape.
- Used ONLY to synthesize terms when no LLM spec exists.

**3. `src/app/api/videos/extract-keywords/route.ts` (extend existing call, no new call)**
- The Step-0 `visualDirection` LLM call's prompt is changed to return JSON:
  `{ visualDirection, visualDomain, positiveConcepts, avoidConcepts, safeFallbackQueries }`.
- Parse via `parseRelevanceSpec`. On Gemini error / parse failure → `relevanceSpec` is derived
  from `profileToTerms(detectContentProfile(script))` so downstream always receives a spec.
- Response gains a `relevanceSpec` field (additive; `visualDirection`/`contentProfile` kept).

**4. `src/app/api/videos/fetch-stock/route.ts` (behavior change)**
- `terms = relevanceSpec ? specToTerms(relevanceSpec) : profileToTerms(resolvedProfile)` —
  one source feeds search + scoring + ranker.
- Search fallback queries come from `terms.fallbackQueries` (was `fallbackQueriesForProfile`).
- **Soft scoring:** replace `scoreCandidate`'s hard path with `scoreCandidateSoft`. Remove the
  `isRelevant === false → dropped` filter and the "forced-original-after-profile-fallback"
  duration path. ALL candidates are ranked by score; best wins; dedupe globally. A clip is
  never eliminated — only deprioritized.
- **LLM ranker (`llmRankBatch`):** prompt uses `terms.domainLabel` + positive/avoid instead of
  `contentProfilePromptBlock` + "reject outside profile". New instruction: "pick the best
  visual match; prefer on-domain; return -1 only for a truly unusable candidate — **never
  reject the whole batch**." If the ranker still returns -1 for **≥ 80%** of items
  (`MCP_RANK_DISTRUST_PCT`, default 80, env-tunable) → discard the ranker output and use the
  deterministic relevance ranking (subtitle↔title token overlap + `terms`).

**5. `src/lib/mcp/orchestrator-steps.ts`**
- `buildStockPayload` forwards `relevanceSpec` into the fetch-stock body (additive).

### Data flow

```
script
 └─ extract-keywords (existing LLM call):
      keywords[], keywordAlternatives[], visualDirection
      + relevanceSpec { visualDomain, positiveConcepts, avoidConcepts, safeFallbackQueries }
      (Gemini down / parse fail → relevanceSpec from profileToTerms(detectContentProfile))
 └─ orchestrator buildStockPayload: forward relevanceSpec
 └─ fetch-stock:
      terms  = relevanceSpec ? specToTerms : profileToTerms(detected)
      search = keyword alternatives + terms.fallbackQueries
      rank   = LLM(domainLabel, ±concepts, never reject-all)
               → if ≥80% returned -1, use deterministic ranking instead
      score  = scoreCandidateSoft (+positive, −avoid; NEVER eliminate)
      pick   = best-by-score, dedupe → always returns clips
 └─ generate-config (+ PR #54 even-split net) → render
```

### Degradation (every layer ends at "show the best available clip")

1. Gemini error in extract-keywords → heuristic path; spec from fixed profile.
2. Spec JSON malformed → salvage → else profile terms.
3. LLM ranker fails / ≥80% -1 → deterministic relevance ranking.
4. A keyword has zero candidates → `terms.fallbackQueries` search (existing machinery).
5. Scene mapping yields 0 bgVideos → PR #54 even-split net (never blank).

No path produces an all-rejected or empty result.

## Testing — `scripts/verify-relevance-spec.ts`

- **parse:** valid JSON → `RelevanceSpec`; malformed/empty → `null` (caller falls back).
- **specToTerms / profileToTerms:** both return a well-formed `RelevanceTerms`.
- **soft scoring (core):** a candidate matching an `avoid` term is *penalized but still
  returned* (not eliminated); given a set where every candidate is off-domain, the highest
  score is still selectable (never empty).
- **ranker distrust:** when the simulated ranker returns -1 for ≥80% of items, the
  deterministic ranking is used and yields non-(-1) picks.
- **drone replay:** spec with `avoidConcepts:["medical"]` + drone candidates vs a medical
  candidate → drone out-ranks; no 100% rejection.
- Existing `verify-mcp-orchestrator`, `verify-mcp-orchestrator-steps`, `verify-mcp-tools`
  still pass (relevanceSpec is additive/optional).

## Files touched

| File | Change |
|---|---|
| `src/lib/relevance-spec.ts` | NEW — types, parse, specToTerms, scoreCandidateSoft |
| `src/lib/broll-profile.ts` | add `profileToTerms`; tables kept as fallback |
| `src/app/api/videos/extract-keywords/route.ts` | spec-emitting prompt + return field |
| `src/app/api/videos/fetch-stock/route.ts` | terms source + soft scoring + ranker prompt/distrust |
| `src/lib/mcp/orchestrator-steps.ts` | forward `relevanceSpec` |

Shared by web + MCP: `relevanceSpec` is **optional** — the web path keeps working on the fixed
profile until/if it is updated to send a spec. New branch off `main`. Pairs with PR #54.

## Decisions locked in this design

- (i) Scoring is extracted to `relevance-spec.ts` so it is unit-testable. **Yes.**
- (ii) Ranker-distrust threshold = **80%** of `-1`, env-tunable (`MCP_RANK_DISTRUST_PCT`).
- (iii) Scope = backend pipeline only. Web video-editor keeps working via the optional spec.

## Open questions (do not block implementation)

- Does the web video-editor expose a **manual profile selector** to users? If so, a follow-up
  can let a user-chosen domain seed the spec. Out of scope here.
- Root cause of the dense-subtitle **caption-timing collapse** (why generate-config sometimes
  yields 0 bgVideos) is a separate investigation; PR #54 only nets it.
