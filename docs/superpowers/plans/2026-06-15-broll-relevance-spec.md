# B-roll Relevance Spec + Soft Re-rank — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make b-roll relevance driven by a per-script LLM "relevance spec" with soft (never-eliminating) re-ranking, demoting the fixed 10-profile taxonomy to a no-LLM fallback — so accuracy improves and new topics never need a new hardcoded bucket.

**Architecture:** All new logic lives in one pure, unit-tested module `src/lib/relevance-spec.ts` (types, JSON parse, profile→terms bridge, soft scoring, ranker-distrust). The route handlers (`extract-keywords`, `fetch-stock`) and `orchestrator-steps` are thin wiring that call those pure functions. `broll-profile.ts` is unchanged (its existing exports are reused). `relevanceSpec` is optional end-to-end, so the web path keeps working unchanged.

**Tech Stack:** Next.js route handlers (Node runtime), TypeScript, Gemini (`geminiGenerateText`). Tests follow this repo's existing pattern: standalone `scripts/verify-*.ts` run with `npx tsx`, using a local `check(name, cond)` helper and `process.exit(failures ? 1 : 0)` (see `scripts/verify-mcp-orchestrator-steps.ts` for the established style). There is NO jest/pytest in this repo.

**Spec:** `docs/superpowers/specs/2026-06-15-broll-relevance-spec-design.md`

**Branch:** `mew/broll-relevance-spec` (already created off `main`; the design spec is already committed there).

---

## Design note (deviation from spec, intentional)

The spec said `profileToTerms` would live in `broll-profile.ts`. To avoid a circular import
(`relevance-spec.ts` needs `ContentProfile` from `broll-profile.ts`), `profileToTerms` instead
lives in `relevance-spec.ts` and is built from `broll-profile.ts`'s ALREADY-EXPORTED functions
(`positiveTermsForProfile`, `rejectTermsForProfile`, `fallbackQueriesForProfile`,
`normalizeContentProfile`). **`broll-profile.ts` is not modified.** Also: when the LLM spec is
absent, `extract-keywords` sends no spec and `fetch-stock` does the profile→terms fallback
itself (it already computes the profile). Both still guarantee "downstream always has terms."

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/lib/relevance-spec.ts` | Pure: types, parse, profileToTerms, soft scoring, ranker-distrust | CREATE |
| `scripts/verify-relevance-spec.ts` | Unit tests for the pure module | CREATE |
| `src/app/api/videos/extract-keywords/route.ts` | Emit `relevanceSpec` from the existing visualDirection LLM call | MODIFY |
| `src/app/api/videos/fetch-stock/route.ts` | Source terms from spec/profile; soft scoring; ranker prompt + distrust | MODIFY |
| `src/lib/mcp/orchestrator-steps.ts` | Forward `relevanceSpec` into the stock payload | MODIFY |

---

## Task 1: relevance-spec module — types, `parseRelevanceSpec`, `specToTerms`, `profileToTerms`

**Files:**
- Create: `src/lib/relevance-spec.ts`
- Test: `scripts/verify-relevance-spec.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-relevance-spec.ts`:

```ts
// Unit tests for src/lib/relevance-spec.ts (run: npx tsx scripts/verify-relevance-spec.ts)
import {
  parseRelevanceSpec, specToTerms, profileToTerms,
} from "../src/lib/relevance-spec";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// parse: valid JSON (with ```json fence) → spec
const good = parseRelevanceSpec('```json\n{"visualDomain":"consumer drones","positiveConcepts":["Drone","quadcopter"],"avoidConcepts":["medical"],"safeFallbackQueries":["drone flying sky","quadcopter close up"]}\n```');
check("parse: valid → spec", !!good);
check("parse: positives lowercased + trimmed", good?.positiveConcepts.includes("drone") === true);
check("parse: keeps avoid + fallback", (good?.avoidConcepts[0] === "medical") && (good?.safeFallbackQueries.length === 2));

// parse: malformed / empty / no signal → null
check("parse: not JSON → null", parseRelevanceSpec("the mood is dark and dramatic") === null);
check("parse: empty → null", parseRelevanceSpec("") === null);
check("parse: JSON with no positive+no fallback → null", parseRelevanceSpec('{"visualDomain":"x","avoidConcepts":["y"]}') === null);

// specToTerms
const terms = specToTerms(good!);
check("specToTerms: shape", Array.isArray(terms.positive) && Array.isArray(terms.avoid) && Array.isArray(terms.fallbackQueries) && typeof terms.domainLabel === "string");
check("specToTerms: domainLabel from visualDomain", terms.domainLabel === "consumer drones");

// profileToTerms (fallback bridge) — uses broll-profile exports
const pt = profileToTerms("news_crime");
check("profileToTerms: news_crime has positive terms", pt.positive.length > 0);
check("profileToTerms: news_crime has reject terms as avoid", pt.avoid.length > 0);
check("profileToTerms: general → empty-ish but valid shape", Array.isArray(profileToTerms("general").positive));

console.log(failures === 0 ? "\n✅ ALL RELEVANCE-SPEC CHECKS PASSED" : `\n❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/verify-relevance-spec.ts`
Expected: FAIL — module `../src/lib/relevance-spec` not found / exports undefined.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/relevance-spec.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/verify-relevance-spec.ts`
Expected: PASS — all checks ✓, "ALL RELEVANCE-SPEC CHECKS PASSED".

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "relevance-spec" || echo "✓ clean"`
Expected: `✓ clean`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/relevance-spec.ts scripts/verify-relevance-spec.ts
git commit -m "feat(broll): relevance-spec module — parse + specToTerms + profileToTerms"
```

---

## Task 2: soft scoring + ranker-distrust

**Files:**
- Modify: `src/lib/relevance-spec.ts` (append functions)
- Test: `scripts/verify-relevance-spec.ts` (append checks)

- [ ] **Step 1: Write the failing test**

Append before the final `console.log(...)` summary line in `scripts/verify-relevance-spec.ts`
(also add `scoreCandidateSoft, shouldDistrustRanker` to the import at the top):

```ts
// ── soft scoring: penalize but NEVER eliminate ──
const droneTerms = { positive: ["drone", "quadcopter", "aerial"], avoid: ["medical", "hospital"], fallbackQueries: [], domainLabel: "consumer drones" };
const droneClip = scoreCandidateSoft("drone flying over field aerial", "โดรนบินสูง", droneTerms);
const medicalClip = scoreCandidateSoft("doctor in hospital surgery", "โดรนบินสูง", droneTerms);
check("soft: on-domain clip scores higher than off-domain", droneClip > medicalClip, `drone=${droneClip} medical=${medicalClip}`);
check("soft: off-domain clip is penalized but still a finite number (not eliminated)", Number.isFinite(medicalClip));
// best-of all-off-domain is still selectable (max score exists, nothing dropped)
const allOff = [scoreCandidateSoft("cat playing", "โดรน", droneTerms), scoreCandidateSoft("city street", "โดรน", droneTerms)];
check("soft: even all-off-domain yields a best (non-empty selection)", Math.max(...allOff) !== -Infinity);

// ── ranker distrust: ≥80% of -1 → distrust ──
check("distrust: 9/10 rejected → distrust", shouldDistrustRanker([0,-1,-1,-1,-1,-1,-1,-1,-1,-1], 80) === true);
check("distrust: 5/10 rejected → trust", shouldDistrustRanker([0,1,2,3,4,-1,-1,-1,-1,-1], 80) === false);
check("distrust: empty results → distrust", shouldDistrustRanker([], 80) === true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/verify-relevance-spec.ts`
Expected: FAIL — `scoreCandidateSoft` / `shouldDistrustRanker` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/relevance-spec.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/verify-relevance-spec.ts`
Expected: PASS — all checks ✓.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "relevance-spec" || echo "✓ clean"
git add src/lib/relevance-spec.ts scripts/verify-relevance-spec.ts
git commit -m "feat(broll): soft candidate scoring + ranker-distrust helper"
```

---

## Task 3: extract-keywords emits `relevanceSpec`

**Files:**
- Modify: `src/app/api/videos/extract-keywords/route.ts`

This route has TWO LLM `visualDirection` calls (perSubtitle mode ~line 280; normal mode ~line 491). Both currently return a one-sentence string. Change both to return JSON and parse a spec, then return `relevanceSpec` in both responses. Keep `visualDirection` (used elsewhere) working.

- [ ] **Step 1: Add the import**

At the top of the file, add to the imports block (after the `broll-profile` import):

```ts
import { parseRelevanceSpec, type RelevanceSpec } from "@/lib/relevance-spec";
```

- [ ] **Step 2: perSubtitle mode — replace the visualDirection block**

Find (perSubtitle mode, ~line 277-298):

```ts
    // Step 0: Analyze script once to get visual direction for consistent B-roll tone
    let visualDirection = "";
    try {
      const analysisPrompt = `Analyze this video script and describe its visual direction in ONE concise English sentence (max 20 words).
Focus on: mood/tone, setting/environment, color palette, energy level, target emotion.
Examples:
- "Dark dramatic tech documentary — neon-lit servers, urgent energy, high-contrast monochrome city"
- "Warm motivational lifestyle — golden hour outdoors, slow motion, bright optimistic energy"
- "Educational calm explainer — clean office, moderate pace, neutral professional tone"

Script: ${fullScript.slice(0, 1500)}

Output ONLY the one-sentence visual direction, nothing else.`;
      visualDirection = (await callLLM(analysisPrompt, 80, false)).trim().replace(/^["']|["']$/g, "");
      console.log(`[extract-keywords] visualDirection: ${visualDirection}`);
    } catch (e) {
```

Replace with:

```ts
    // Step 0: Analyze script once → visual direction (tone) + per-script relevance spec
    let visualDirection = "";
    let relevanceSpec: RelevanceSpec | null = null;
    try {
      const analysisPrompt = `Analyze this video script. Return ONLY a JSON object (no prose, no markdown fences):
{
  "visualDirection": "<one concise English sentence, max 20 words: mood/tone, setting, color, energy>",
  "visualDomain": "<2-6 word English label of the literal subject, e.g. 'consumer drones and RC aircraft', 'home cooking', 'crypto trading'>",
  "positiveConcepts": ["<8-15 lowercase English nouns a camera can film that SHOULD appear for this exact topic>"],
  "avoidConcepts": ["<3-8 lowercase English nouns that are OFF-topic for THIS script and should be down-ranked>"],
  "safeFallbackQueries": ["<6-10 English Pexels search phrases, 2-5 words each, on-topic, filmable, no names/brands>"]
}
Ground the topic literally (a script about drones → drone/quadcopter/aerial, NOT generic tech). avoidConcepts come from THIS script's topic, not a fixed category.

Script: ${fullScript.slice(0, 1500)}`;
      const raw = (await callLLM(analysisPrompt, 400, false)).trim();
      relevanceSpec = parseRelevanceSpec(raw);
      visualDirection = relevanceSpec?.visualDomain
        ? raw.match(/"visualDirection"\s*:\s*"([^"]{1,200})"/)?.[1]?.trim() ?? relevanceSpec.visualDomain
        : raw.replace(/^["']|["']$/g, "").slice(0, 200);
      console.log(`[extract-keywords] visualDirection: ${visualDirection} | spec: ${relevanceSpec ? relevanceSpec.visualDomain : "none"}`);
    } catch (e) {
```

- [ ] **Step 3: perSubtitle mode — return `relevanceSpec`**

Find the perSubtitle return (~line 441-451) and add `relevanceSpec,` to the object:

```ts
    return NextResponse.json({
      keywords: allKeywords,
      keywordAlternatives: allAlternatives,
      sceneClipCounts: allKeywords.map(() => 1),
      sceneDurations: subtitleList.map(() => 3),
      keywordsPerScene: 1,
      visualDirection,
      contentProfile,
      relevanceSpec,
      fallback: useHeuristicFallback ? "heuristic" : undefined,
      fallbackReason: useHeuristicFallback ? heuristicFallbackReason : undefined,
    });
```

- [ ] **Step 4: normal mode — replace the visualDirection block**

Find (normal mode, ~line 488-500):

```ts
  // Analyze script visual direction first
  let visualDirection = "";
  try {
    const analysisPrompt = `Analyze this video script and describe its visual direction in ONE concise English sentence (max 20 words).
Focus on: mood/tone, setting/environment, color palette, energy level, target emotion.
Script: ${cleanScript.slice(0, 1500)}
Output ONLY the one-sentence visual direction, nothing else.`;
    visualDirection = (await callLLM(analysisPrompt, 80, false)).trim().replace(/^["']|["']$/g, "");
    console.log(`[extract-keywords] visualDirection: ${visualDirection}`);
  } catch (e) {
```

Replace with:

```ts
  // Analyze script → visual direction (tone) + per-script relevance spec
  let visualDirection = "";
  let relevanceSpec: RelevanceSpec | null = null;
  try {
    const analysisPrompt = `Analyze this video script. Return ONLY a JSON object (no prose, no markdown fences):
{
  "visualDirection": "<one concise English sentence, max 20 words: mood/tone, setting, color, energy>",
  "visualDomain": "<2-6 word English label of the literal subject, e.g. 'consumer drones and RC aircraft', 'home cooking', 'crypto trading'>",
  "positiveConcepts": ["<8-15 lowercase English nouns a camera can film that SHOULD appear for this exact topic>"],
  "avoidConcepts": ["<3-8 lowercase English nouns that are OFF-topic for THIS script and should be down-ranked>"],
  "safeFallbackQueries": ["<6-10 English Pexels search phrases, 2-5 words each, on-topic, filmable, no names/brands>"]
}
Ground the topic literally (a script about drones → drone/quadcopter/aerial, NOT generic tech). avoidConcepts come from THIS script's topic, not a fixed category.

Script: ${cleanScript.slice(0, 1500)}`;
    const raw = (await callLLM(analysisPrompt, 400, false)).trim();
    relevanceSpec = parseRelevanceSpec(raw);
    visualDirection = relevanceSpec?.visualDomain
      ? raw.match(/"visualDirection"\s*:\s*"([^"]{1,200})"/)?.[1]?.trim() ?? relevanceSpec.visualDomain
      : raw.replace(/^["']|["']$/g, "").slice(0, 200);
    console.log(`[extract-keywords] visualDirection: ${visualDirection} | spec: ${relevanceSpec ? relevanceSpec.visualDomain : "none"}`);
  } catch (e) {
```

- [ ] **Step 5: normal mode — return `relevanceSpec` in BOTH return paths**

(a) In `heuristicNormalResponse` (~line 584-595), add `relevanceSpec: null,` to the returned object (heuristic path has no LLM spec):

```ts
    return NextResponse.json({
      keywords: allKeywords,
      keywordAlternatives: allAlternatives,
      scenes: sceneList,
      keywordsPerScene: kwPerScene,
      sceneClipCounts,
      sceneDurations,
      visualDirection,
      contentProfile,
      relevanceSpec: null,
      fallback: "heuristic",
      fallbackReason: reason,
    });
```

(b) In the normal success return (~line 671-680), add `relevanceSpec,`:

```ts
    return NextResponse.json({
      keywords: allKeywords,
      keywordAlternatives: allAlternatives,
      scenes: sceneList,
      keywordsPerScene: kwPerScene,
      sceneClipCounts,
      sceneDurations,
      visualDirection,
      contentProfile,
      relevanceSpec,
    });
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "extract-keywords" || echo "✓ clean"`
Expected: `✓ clean`. (If `relevanceSpec` is "declared but never read" in heuristic-only branches, that is fine — it is returned.)

- [ ] **Step 7: Commit**

```bash
git add src/app/api/videos/extract-keywords/route.ts
git commit -m "feat(broll): extract-keywords emits per-script relevanceSpec (reuses visualDirection call)"
```

---

## Task 4: orchestrator-steps forwards `relevanceSpec`

**Files:**
- Modify: `src/lib/mcp/orchestrator-steps.ts` (`buildStockPayload`, `buildKeywordsPayload` consumer)
- Modify: `src/lib/mcp/orchestrator.ts` (thread `relevanceSpec` from keywords result into stock payload)
- Test: `scripts/verify-mcp-orchestrator-steps.ts` (existing — add a check)

- [ ] **Step 1: Inspect the current signatures**

Run: `grep -n "buildStockPayload\|relevanceSpec\|kw.visualDirection\|keywordAlternatives" src/lib/mcp/orchestrator-steps.ts src/lib/mcp/orchestrator.ts`
Note the exact parameter list of `buildStockPayload` and how `orchestrator.ts` calls it (it currently passes `kw.visualDirection, kw.keywordAlternatives`).

- [ ] **Step 2: Add a failing check to the existing verify**

In `scripts/verify-mcp-orchestrator-steps.ts`, add (adapt the variable name to the file's existing `check`/assert helper — match the surrounding style):

```ts
// relevanceSpec is forwarded into the stock payload when present
{
  const { buildStockPayload } = await import("../src/lib/mcp/orchestrator-steps");
  const spec = { visualDomain: "drones", positiveConcepts: ["drone"], avoidConcepts: ["medical"], safeFallbackQueries: ["drone sky"] };
  const payload = buildStockPayload(["drone"], 30, "both", [{ text: "x" }], "dark", [["drone"]], spec) as Record<string, unknown>;
  check("stock payload forwards relevanceSpec", JSON.stringify(payload.relevanceSpec) === JSON.stringify(spec));
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx tsx scripts/verify-mcp-orchestrator-steps.ts`
Expected: FAIL — `buildStockPayload` ignores/!has the 7th arg (`relevanceSpec` undefined in payload).

- [ ] **Step 4: Implement — extend `buildStockPayload`**

In `src/lib/mcp/orchestrator-steps.ts`, add a trailing optional param and include it in the returned object. Example shape (match the existing function body/param names):

```ts
export function buildStockPayload(
  keywords: string[],
  totalDurationSec: number,
  stockSource: string,
  captions: { text: string }[],
  visualDirection?: string,
  keywordAlternatives?: string[][],
  relevanceSpec?: unknown,                 // NEW (optional, additive)
) {
  return {
    keywords,
    download: true as const,
    totalDurationSec,
    stockSource,
    subtitleTexts: captions.map((c) => c.text),
    perSubtitleMode: true,
    visualDirection,
    keywordAlternatives,
    ...(relevanceSpec ? { relevanceSpec } : {}),   // NEW
  };
}
```

> Match the EXACT existing keys/param names in the file — only ADD the `relevanceSpec` param and the spread. Do not rename existing fields.

- [ ] **Step 5: Thread it through `orchestrator.ts`**

In `src/lib/mcp/orchestrator.ts`, the keywords result type and the `buildStockPayload(...)` call must carry the spec. Update the `kw` generic to include `relevanceSpec?: unknown` and pass it:

Find the stock step:

```ts
    const stock = await caller.post<{ results: unknown[] }>(
      "/api/videos/fetch-stock", buildStockPayload(kw.keywords ?? [], totalDur, DEFAULT_STOCK_SOURCE, captions, kw.visualDirection, kw.keywordAlternatives),
    );
```

Replace the last call arg list to append `kw.relevanceSpec`:

```ts
    const stock = await caller.post<{ results: unknown[] }>(
      "/api/videos/fetch-stock", buildStockPayload(kw.keywords ?? [], totalDur, DEFAULT_STOCK_SOURCE, captions, kw.visualDirection, kw.keywordAlternatives, kw.relevanceSpec),
    );
```

And in the same file add `relevanceSpec?: unknown;` to the inline type of the `kw` post-result (the `caller.post<{ keywords: string[]; ... }>` generic on the keywords step).

- [ ] **Step 6: Run to verify it passes + full orchestrator suite**

```bash
npx tsx scripts/verify-mcp-orchestrator-steps.ts
npx tsx scripts/verify-mcp-orchestrator.ts
```
Expected: both PASS (all checks ✓).

- [ ] **Step 7: Typecheck + commit**

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "orchestrator" || echo "✓ clean"
git add src/lib/mcp/orchestrator-steps.ts src/lib/mcp/orchestrator.ts scripts/verify-mcp-orchestrator-steps.ts
git commit -m "feat(broll): forward relevanceSpec through orchestrator into stock payload"
```

---

## Task 5: fetch-stock — source terms from spec/profile, soft scoring, ranker prompt + distrust

**Files:**
- Modify: `src/app/api/videos/fetch-stock/route.ts`

This is the behavioral change. Goal: candidates are RANKED, never ELIMINATED; terms come from the spec when present.

- [ ] **Step 1: Add imports**

Add near the other `@/lib/broll-profile` import:

```ts
import { parseRelevanceSpec, specToTerms, profileToTerms, scoreCandidateSoft, shouldDistrustRanker, type RelevanceSpec, type RelevanceTerms } from "@/lib/relevance-spec";
```

- [ ] **Step 2: Read `relevanceSpec` from the body + build the active terms**

In `POST`, the body is already destructured (`keywords, keywordAlternatives, ... contentProfile`). Add `relevanceSpec` to that destructure:

```ts
    relevanceSpec,
  }: {
    // ...existing field types...
    relevanceSpec?: RelevanceSpec | null;
  } = body ?? {};
```

Right after `resolvedContentProfile` is computed, add:

```ts
  const RANK_DISTRUST_PCT = readIntEnv("MCP_RANK_DISTRUST_PCT", 80, 50, 100);
  const relSpec: RelevanceSpec | null = relevanceSpec ?? null;
  const relTerms: RelevanceTerms = relSpec ? specToTerms(relSpec) : profileToTerms(resolvedContentProfile);
  console.log(`[fetch-stock] relevance source=${relSpec ? "spec" : "profile"} domain="${relTerms.domainLabel}" +${relTerms.positive.length}/-${relTerms.avoid.length}`);
```

(`readIntEnv` already exists in this file.)

- [ ] **Step 3: Make scoring soft — rewrite `scoreCandidate` to use terms and never reject**

Replace the existing `scoreCandidate` function body so it delegates to the soft scorer and ALWAYS marks relevant (keep the same return shape so callers compile):

```ts
function scoreCandidate(
  candidate: CandidateVideo,
  keyword: string,
  subtitleText: string,
  terms: RelevanceTerms,
): CandidateFit {
  const titleText = `${candidate.title} ${candidate.query}`;
  const contextText = `${keyword} ${subtitleText}`;
  const score = scoreCandidateSoft(titleText, contextText, terms);
  // Soft mode: never eliminate. Everything is "relevant"; ranking by score decides the pick.
  return { index: -1, score, rejectReason: undefined, isRelevant: true };
}
```

- [ ] **Step 4: Thread `terms` through the ranking helpers (replace the `contentProfile` param)**

`orderCandidateIndices` and `bestRelevantCandidateIndex` currently take `contentProfile: ContentProfile`. Change their signatures to `terms: RelevanceTerms` and pass `terms` into `scoreCandidate`. Update EVERY call site in the file to pass `relTerms` instead of `resolvedContentProfile`. Concretely:

- `orderCandidateIndices(candidates, preferredIndex, keyword, subtitleText, terms, allowNeutral)` — change last-but-one param name/type to `terms: RelevanceTerms`; inside, call `scoreCandidate(candidate, keyword, subtitleText, terms)`.
- `bestRelevantCandidateIndex(candidates, keyword, subtitleText, terms)` — same.
- Call sites (search via `grep -n "orderCandidateIndices(\|bestRelevantCandidateIndex(\|scoreCandidate(" src/app/api/videos/fetch-stock/route.ts`): replace the `resolvedContentProfile` argument with `relTerms` at each.

> Because `scoreCandidate` now always returns `isRelevant: true`, the existing `orderCandidateIndices` filter (`fit.isRelevant || (allowNeutral && !fit.rejectReason)`) keeps ALL candidates, sorted by score — the desired soft behavior. The `forced-original-after-profile-fallback` branches become unreachable safety and can stay as-is.

- [ ] **Step 5: Fallback queries from terms**

In `findProfileFallbackClip`, replace `...fallbackQueriesForProfile(resolvedContentProfile)` with `...relTerms.fallbackQueries`. (Leave the keyword-word fallbacks that follow it.)

- [ ] **Step 6: LLM ranker prompt — domain + concepts, never reject-all**

In `llmRankBatch`, replace the `profileLine` construction:

```ts
  const profileLine = `\n${contentProfilePromptBlock(contentProfile)}\nReject candidates outside this profile.\n`;
```

with a terms-driven block (pass `terms: RelevanceTerms` into `llmRankBatch` / `llmRankCandidates` instead of `contentProfile`):

```ts
  const profileLine = `\nVISUAL DOMAIN: ${terms.domainLabel}\nPrefer footage of: ${terms.positive.slice(0, 12).join(", ") || "the subject described"}.\nDown-rank (do NOT hard-reject) footage of: ${terms.avoid.slice(0, 8).join(", ") || "obviously unrelated subjects"}.\n`;
```

And change the RULES line `- Return -1 if none ...` to:

```ts
- Return the BEST available index even if imperfect. Use -1 ONLY for a candidate that is truly unusable. NEVER return -1 for every subtitle.
```

Update `llmRankCandidates` + its two call sites in `POST` to pass `relTerms` where they currently pass `resolvedContentProfile`.

- [ ] **Step 7: Distrust the ranker when it rejects too much**

In `POST`, right after `bestIdxByKeyword = await llmRankCandidates(...)` (the per-subtitle ranking block), add:

```ts
      if (shouldDistrustRanker(bestIdxByKeyword, RANK_DISTRUST_PCT)) {
        console.warn(`[fetch-stock] LLM ranker rejected >=${RANK_DISTRUST_PCT}% — using deterministic relevance ranking instead`);
        bestIdxByKeyword = candidatesByKeyword.map((cs, i) =>
          bestRelevantCandidateIndex(cs, keywords[i] ?? "", subtitleTexts?.[i] ?? "", relTerms),
        );
        stockTelemetry.llmRejectedCount = bestIdxByKeyword.filter((idx) => idx < 0).length;
        stockTelemetry.llmRankingFailed = true;
      }
```

- [ ] **Step 8: Add the source to telemetry (observability)**

In `recordFetchStockTelemetry`'s `properties`, add `relevanceSource: relSpec ? "spec" : "profile",` so future audits can compare accuracy by source.

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "fetch-stock" || echo "✓ clean"`
Expected: `✓ clean`. Fix any leftover call site still passing `resolvedContentProfile`/`contentProfile` to a now-`terms` parameter, or any unused import (`contentProfilePromptBlock`, `positiveTermsForProfile`, `rejectTermsForProfile`, `fallbackQueriesForProfile` may become unused — remove them from the import if so).

- [ ] **Step 10: Commit**

```bash
git add src/app/api/videos/fetch-stock/route.ts
git commit -m "feat(broll): fetch-stock uses relevance terms + soft scoring + ranker distrust (no hard reject)"
```

---

## Task 6: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the whole MCP/broll verify suite**

```bash
npx tsx scripts/verify-relevance-spec.ts
npx tsx scripts/verify-mcp-orchestrator-steps.ts
npx tsx scripts/verify-mcp-orchestrator.ts
npx tsx scripts/verify-mcp-tools.ts
npx tsx scripts/verify-broll-even-split-fallback.ts || echo "(only present on the #54 branch — skip if absent here)"
```
Expected: all present scripts print "ALL ... CHECKS PASSED".

- [ ] **Step 2: Full typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | tail -20`
Expected: no errors in the touched files (`relevance-spec`, `extract-keywords`, `fetch-stock`, `orchestrator*`). Pre-existing unrelated errors elsewhere, if any, are out of scope.

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin mew/broll-relevance-spec
gh pr create --base main --head mew/broll-relevance-spec \
  --title "feat(broll): per-script relevance spec + soft re-rank (accuracy, no taxonomy loop)" \
  --body "Implements docs/superpowers/specs/2026-06-15-broll-relevance-spec-design.md. Relevance now comes from a per-script LLM spec (reusing the existing visualDirection call); scoring is soft (never eliminates a candidate); the fixed 10-profile taxonomy is demoted to the no-LLM fallback. Fixes the drone→ai_tech misclassification + 100% LLM-reject failures from the audit. Backend-only; web unaffected (spec optional). Pairs with #54.

VERIFY: relevance-spec (unit), orchestrator-steps/orchestrator/tools all pass; typecheck clean.
FINAL GATE: prod build + 1 real render on VPS — confirm fetch-stock log shows 'relevance source=spec' and llmRejectedCount is NOT ~100%."
```

---

## Notes for the implementer

- **Test convention:** this repo has no jest. A "test" is a check inside a `scripts/verify-*.ts`
  run via `npx tsx`. Copy the `check(name, cond, detail?)` + `process.exit` pattern already in
  `scripts/verify-relevance-spec.ts` (Task 1).
- **Never hard-reject:** the single most important behavior — `scoreCandidate` must always
  return `isRelevant: true`. If you ever reintroduce elimination, the drone-style 100%-reject
  bug returns.
- **Optional everywhere:** `relevanceSpec` is optional on the wire. If a caller (web editor)
  doesn't send it, `fetch-stock` falls back to `profileToTerms(resolvedContentProfile)` — same
  behavior as before but now soft. Do not make any route REQUIRE the spec.
- **Don't touch** `broll-profile.ts`, `generate-config` (PR #54 owns the blank net), or the
  render compositions.
