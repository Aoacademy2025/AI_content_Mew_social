# B-roll AI-gen Quality + Cadence/Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI-generated B-roll (kie.ai) in `/video-editor` content-accurate, paced at the marketed 3–5s cadence, and cost-capped — so a 21s clip pays for ~6 good images instead of 16–17 generic ones.

**Architecture:** Three coordinated, low-blast-radius changes, all on the per-subtitle AI-gen / auto-mix path only (normal video stock untouched):
- **A (quality):** Replace the kie prompt — currently a bare stock-search keyword / raw Thai subtitle — with a content-aware English scene prompt composed from data the route already holds (`keyword` + `relevanceSpec` + `visualDirection`).
- **B1 (cost):** Cap paid AI generations to `ceil(duration / cadence)` for the per-subtitle auto case (manual clip counts untouched).
- **B2 (cadence):** Scope-activate the dormant, already-freeze-tested `buildMinHoldSegments` for the AI/auto-mix path via a `minHoldSec` request param, so the few generated images hold ~3.5s each instead of strobing.

**Tech Stack:** Next.js 15 App Router (route handlers), TypeScript, kie.ai text-to-image, ffmpeg Ken Burns, Remotion renderer. Tests = `verify-*.ts` run via `tsx` (no jest).

## Global Constraints

- `main` = production. Work on branch `mew/broll-ai-gen-quality`; open PR into `main`. Mew rebases + merges + deploys. (CLAUDE.md)
- Render-backend changes MUST build-verify before merge: `npx tsc --noEmit` per task + one `npm run build` before PR. (CLAUDE.md)
- Scope is `/video-editor` ONLY. Do NOT touch `/video-creator` (deprecated) or the MCP path in this plan.
- Reuse existing data already passed editor→fetch-stock (`relevanceSpec`, `visualDirection`, `keyword`) — add NO new LLM call, NO new API cost.
- Cadence default lives in code with an env escape hatch (`STOCK_MIN_HOLD_SEC=0` reverts B2 instantly without deploy). Env knobs are the reversible lever. (CLAUDE.md)
- Verify scripts import via **relative path** (`../src/lib/...`), NOT the `@/` alias (matches every existing `scripts/verify-*.ts`).
- Keep edits minimal; follow existing file style. Each AI image is paid per-generation — never increase generation count.

---

### Task A: Content-aware kie.ai image prompt

**Files:**
- Create: `src/lib/kie-image-prompt.ts`
- Create: `scripts/verify-kie-image-prompt.ts`
- Modify: `src/app/api/videos/fetch-stock/route.ts` (helper `generateKieImageKenBurns` ~823–841; call sites ~1475 and ~1493)
- Modify: `package.json` (add verify script)

**Interfaces:**
- Produces: `buildKieImagePrompt(subject: string, opts?: { visualDirection?: string; terms?: RelevanceTerms | null }): string`
- Consumes: `RelevanceTerms` from `@/lib/relevance-spec` (already imported in fetch-stock as `relTerms`).

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-kie-image-prompt.ts`:

```ts
// Unit tests for buildKieImagePrompt (run: npx tsx scripts/verify-kie-image-prompt.ts)
//
// ROOT CAUSE this fixes: the old kie prompt was `${query}, cinematic photo, ...`
// where query was a 2–5 word STOCK SEARCH keyword (or a raw Thai subtitle) — both
// yield generic, off-topic AI images. The new prompt composes a real English scene
// description from the keyword + the script's relevance spec + visual direction.
import { buildKieImagePrompt } from "../src/lib/kie-image-prompt";
import type { RelevanceTerms } from "../src/lib/relevance-spec";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const terms: RelevanceTerms = {
  positive: ["bitcoin coin", "trading chart", "candlestick"],
  avoid: ["cartoon"],
  fallbackQueries: ["finance"],
  domainLabel: "cryptocurrency finance",
};

// subject is always present and leads the prompt
const p1 = buildKieImagePrompt("bitcoin price surge", { visualDirection: "tense, dramatic newsroom lighting.", terms });
check("includes the subject", p1.toLowerCase().includes("bitcoin price surge"));
check("includes the domain", p1.toLowerCase().includes("cryptocurrency finance"));
check("includes concrete concepts", p1.toLowerCase().includes("bitcoin coin"));
check("includes visual direction", p1.toLowerCase().includes("newsroom"));
check("has anti-text guard", /no text, no watermark/i.test(p1));
check("ends as one sentence", p1.trim().endsWith("."));
check("limits concepts to <=2", (p1.match(/bitcoin coin|trading chart|candlestick/gi) ?? []).length <= 2);

// degrades gracefully with no spec/direction
const p2 = buildKieImagePrompt("a quiet morning coffee", { terms: null });
check("no-spec: still has subject", p2.toLowerCase().includes("quiet morning coffee"));
check("no-spec: still has anti-text guard", /no text, no watermark/i.test(p2));
check("no-spec: no 'general' domain leaks in", !/in a general setting/i.test(p2));

// empty subject must not crash and must still produce a usable prompt
const p3 = buildKieImagePrompt("", { terms });
check("empty subject: falls back to domain", p3.toLowerCase().includes("cryptocurrency finance"));

// NEVER reuse the bare old template
check("not the old bare template", !/^\s*, cinematic photo/i.test(buildKieImagePrompt("x")));

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll kie-image-prompt checks passed.");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/verify-kie-image-prompt.ts`
Expected: FAIL — `Cannot find module '../src/lib/kie-image-prompt'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/kie-image-prompt.ts`:

```ts
import type { RelevanceTerms } from "@/lib/relevance-spec";

function sanitize(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
}

/**
 * Build a content-aware text-to-image prompt for kie.ai b-roll generation.
 *
 * The old prompt was `${query}, cinematic photo, ...` where query was either a 2–5
 * word STOCK SEARCH keyword or a raw Thai subtitle — both produce generic, off-topic
 * images (the model gets a search box query, not a scene). This composes the per-caption
 * English subject with the script's already-computed relevance spec (visual domain +
 * concrete concepts) and visual direction, so the model receives an actual scene
 * description. Uses only data the fetch-stock route already holds — no extra LLM call.
 */
export function buildKieImagePrompt(
  subject: string,
  opts?: { visualDirection?: string; terms?: RelevanceTerms | null },
): string {
  const subj = sanitize(subject);
  const dir = sanitize(opts?.visualDirection ?? "");
  const terms = opts?.terms ?? null;
  const domain =
    terms?.domainLabel && terms.domainLabel.toLowerCase() !== "general"
      ? sanitize(terms.domainLabel)
      : "";
  const concepts = (terms?.positive ?? []).map(sanitize).filter(Boolean).slice(0, 2);

  const parts: string[] = [];
  parts.push(`A cinematic, photorealistic vertical 9:16 photograph of ${subj || domain || "a relevant scene"}`);
  if (domain) parts.push(`in a ${domain} setting`);
  if (concepts.length) parts.push(`featuring ${concepts.join(" and ")}`);
  if (dir) parts.push(dir.replace(/[.?!]+$/g, ""));
  parts.push("natural lighting, realistic detail, sharp focus, no text, no watermark, no logo, no caption");
  return `${parts.join(", ")}.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/verify-kie-image-prompt.ts`
Expected: PASS — "All kie-image-prompt checks passed."

- [ ] **Step 5: Wire into fetch-stock — refactor the generator to take a prompt + label**

In `src/app/api/videos/fetch-stock/route.ts`, change `generateKieImageKenBurns` (currently `~823–841`) so the prompt is built by the caller (where `relTerms`/`visualDirection` are in scope) instead of inside the helper.

Replace:

```ts
async function generateKieImageKenBurns(
  query: string,
  token: string,
  model: KieImageModel,
  imagePath: string,
  outPath: string,
): Promise<{ duration: number; imageUrl: string }> {
  const prompt = `${query}, cinematic photo, vertical 9:16, high detail, no text, no watermark`;
  const imageTaskId = await kieCreateTask(model, buildKieImageInput(model, prompt), token);
  const imageUrl = await kiePollResult(imageTaskId, token);
  console.log(`[fetch-stock] kie image ready for "${query}": ${imageUrl.slice(0, 80)}`);

  await downloadAndCrop(imageUrl, imagePath);
  console.log(`[fetch-stock] kie cropped "${query}" → ${imagePath.split(/[/\\]/).pop()}`);
  await applyKenBurns(imagePath, outPath);
  console.log(`[fetch-stock] kie Ken Burns done "${query}" → ${outPath.split(/[/\\]/).pop()}`);

  return { duration: KEN_BURNS_DURATION_SEC, imageUrl };
}
```

with (prompt now passed in; `label` is the human-readable keyword used only for logging):

```ts
async function generateKieImageKenBurns(
  prompt: string,
  label: string,
  token: string,
  model: KieImageModel,
  imagePath: string,
  outPath: string,
): Promise<{ duration: number; imageUrl: string }> {
  const imageTaskId = await kieCreateTask(model, buildKieImageInput(model, prompt), token);
  const imageUrl = await kiePollResult(imageTaskId, token);
  console.log(`[fetch-stock] kie image ready for "${label}": ${imageUrl.slice(0, 80)}`);

  await downloadAndCrop(imageUrl, imagePath);
  console.log(`[fetch-stock] kie cropped "${label}" → ${imagePath.split(/[/\\]/).pop()}`);
  await applyKenBurns(imagePath, outPath);
  console.log(`[fetch-stock] kie Ken Burns done "${label}" → ${outPath.split(/[/\\]/).pop()}`);

  return { duration: KEN_BURNS_DURATION_SEC, imageUrl };
}
```

- [ ] **Step 6: Add the import**

Near the top of `fetch-stock/route.ts`, alongside the existing `@/lib/relevance-spec` import, add:

```ts
import { buildKieImagePrompt } from "@/lib/kie-image-prompt";
```

- [ ] **Step 7: Update the two call sites to build the rich prompt from the English keyword**

In the kie generation block (`~1465–1496`), the per-image worker currently does `const query = subtitleTexts?.[i] || keyword;`. Use the **English `keyword`** as the subject (NOT the Thai `subtitleTexts[i]`, which the model can't render well) and build the prompt from the in-scope `visualDirection` + `relTerms`.

Replace the download branch call:

```ts
const { duration, imageUrl } = await generateKieImageKenBurns(query, kieKey!, resolvedKieModel, imagePath, outPath);
```

with:

```ts
const genPrompt = buildKieImagePrompt(keyword, { visualDirection, terms: relTerms });
const { duration, imageUrl } = await generateKieImageKenBurns(genPrompt, keyword, kieKey!, resolvedKieModel, imagePath, outPath);
```

Replace the non-download (preview) branch:

```ts
const imageTaskId = await kieCreateTask(resolvedKieModel, buildKieImageInput(resolvedKieModel, `${query}, cinematic photo, vertical 9:16, high detail, no text, no watermark`), kieKey!);
```

with:

```ts
const imageTaskId = await kieCreateTask(resolvedKieModel, buildKieImageInput(resolvedKieModel, buildKieImagePrompt(keyword, { visualDirection, terms: relTerms })), kieKey!);
```

Leave `const query = subtitleTexts?.[i] || keyword;` in place — it is still used for the catch-block log lines (`failed for "${query}"`). The prompt no longer depends on it.

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 9: Add verify npm script + commit**

In `package.json` scripts, add after `"verify:llm-rank"`:

```json
    "verify:kie-prompt": "tsx scripts/verify-kie-image-prompt.ts",
```

```bash
git add src/lib/kie-image-prompt.ts scripts/verify-kie-image-prompt.ts src/app/api/videos/fetch-stock/route.ts package.json
git commit -m "feat(broll): content-aware kie.ai image prompt from keyword+relevanceSpec+visualDirection"
```

---

### Task B1: Cap AI-gen count to the 3–5s cadence (cost)

**Files:**
- Modify: `src/lib/broll-even-split.ts` (add two pure helpers)
- Create: `scripts/verify-broll-cadence.ts`
- Modify: `src/app/api/videos/fetch-stock/route.ts` (`clipsToGenerate` ~1459; remove dead `avgCutSec` ~1301–1307)
- Modify: `package.json` (add verify script)

**Interfaces:**
- Produces: `targetCadenceSec(durationSec: number): number` (clamped 3–5)
- Produces: `aiGenPieceCount(durationSec: number, keywordCount: number, isAuto: boolean, hardCap: number): number`
- Consumed by: Task B2 (editor uses `targetCadenceSec`) and fetch-stock.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-broll-cadence.ts`:

```ts
// Unit tests for targetCadenceSec + aiGenPieceCount (run: npx tsx scripts/verify-broll-cadence.ts)
//
// ROOT CAUSE this fixes: per-subtitle AI-gen generates ONE paid image per caption,
// so a 21s clip with ~17 captions paid for ~17 generic images at ~1.2s each. These
// helpers decouple paid generations from caption count: ~ceil(duration/cadence) images.
import { targetCadenceSec, aiGenPieceCount } from "../src/lib/broll-even-split";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// cadence is always within the marketed 3–5s band
for (const d of [5, 10, 21, 30, 45, 60, 120]) {
  const c = targetCadenceSec(d);
  check(`cadence(${d}s) in [3,5]`, c >= 3 && c <= 5, `${c}`);
}
check("cadence: short clip not slower than long", targetCadenceSec(21) <= targetCadenceSec(120));

// THE headline case: 21s, 17 captions, auto → ~6 images (NOT 17)
const n21 = aiGenPieceCount(21, 17, true, 36);
check("21s/17cap auto → ~6 images", n21 >= 5 && n21 <= 7, `${n21}`);
check("21s auto < caption count", n21 < 17);

// never exceed the keyword count or the hard cap
check("capped by keywordCount", aiGenPieceCount(600, 4, true, 36) === 4);
check("capped by hardCap", aiGenPieceCount(600, 200, true, 36) === 36);

// manual (isAuto=false) bypasses the cadence cap — user chose the number
check("manual bypasses cadence cap", aiGenPieceCount(21, 12, false, 36) === 12);
check("manual still respects hardCap", aiGenPieceCount(21, 99, false, 36) === 36);

// degenerate inputs
check("zero duration auto → keywordCount", aiGenPieceCount(0, 8, true, 36) === 8);
check("never returns < 1 for >=1 keyword", aiGenPieceCount(3, 1, true, 36) >= 1);

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll broll-cadence checks passed.");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/verify-broll-cadence.ts`
Expected: FAIL — `targetCadenceSec is not a function` / export missing.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/broll-even-split.ts`:

```ts
/**
 * Target b-roll cut cadence (seconds per clip) for a video of the given length.
 * Anchors the product's "B-roll changes every 3–5s" promise. Used to (a) cap how many
 * AI images we pay to generate (B1) and (b) how long generate-config holds each clip (B2).
 * Always within [3, 5] so cadence neither strobes nor drags.
 */
export function targetCadenceSec(durationSec: number): number {
  if (!(durationSec > 0)) return 4;
  if (durationSec <= 20) return 3.5;
  if (durationSec <= 45) return 4;
  return 4.5;
}

/**
 * How many AI images to generate (and PAY for) on the per-subtitle AI-gen / auto-mix
 * path. Decouples paid generations from caption count: a 21s clip with 17 captions
 * generates ceil(21/3.5)=6 images, not 17. Manual clip counts (isAuto=false) bypass the
 * cadence cap — the user explicitly chose the number — but always respect keywordCount
 * and the hard cap.
 */
export function aiGenPieceCount(
  durationSec: number,
  keywordCount: number,
  isAuto: boolean,
  hardCap: number,
): number {
  const byKeywords = Math.max(0, Math.floor(keywordCount));
  const cap = Math.max(1, Math.floor(hardCap));
  const base = Math.min(byKeywords, cap);
  if (!isAuto || !(durationSec > 0)) return base;
  const byCadence = Math.max(1, Math.ceil(durationSec / targetCadenceSec(durationSec)));
  return Math.max(1, Math.min(base, byCadence));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/verify-broll-cadence.ts`
Expected: PASS — "All broll-cadence checks passed."

- [ ] **Step 5: Wire the cap into fetch-stock + remove the dead `avgCutSec`**

In `fetch-stock/route.ts`, add to the `@/lib/broll-even-split` import (or create one if absent):

```ts
import { aiGenPieceCount } from "@/lib/broll-even-split";
```

Delete the dead helper (`~1301–1307`):

```ts
  function avgCutSec(dur: number): number {
    if (dur <= 10) return 5;
    if (dur <= 20) return 4;
    if (dur <= 40) return 3.5;
    return 2.5;
  }
  void avgCutSec; // used for future adaptive logic
```

In the kie generation block, replace (`~1459`):

```ts
    const clipsToGenerate = Math.min(keywords.length, downloadClipLimit, PER_SUBTITLE_DOWNLOAD_LIMIT);
```

with:

```ts
    // Cost cap: on the per-subtitle AUTO path, pay for ~ceil(duration/cadence) images
    // (e.g. 21s → ~6), NOT one per caption. Manual clip counts (overrideClipCount set by
    // the user, perSubtitleMode false) bypass the cadence cap via isAuto=false.
    const clipsToGenerate = aiGenPieceCount(
      totalDurationSec,
      Math.min(keywords.length, downloadClipLimit),
      isPerSubtitleMode,
      PER_SUBTITLE_DOWNLOAD_LIMIT,
    );
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors (confirm nothing else referenced `avgCutSec`).

- [ ] **Step 7: Add verify npm script + commit**

In `package.json` scripts, add:

```json
    "verify:broll-cadence": "tsx scripts/verify-broll-cadence.ts",
```

```bash
git add src/lib/broll-even-split.ts scripts/verify-broll-cadence.ts src/app/api/videos/fetch-stock/route.ts package.json
git commit -m "feat(broll): cap AI-gen image count to 3-5s cadence on per-subtitle path (cost)"
```

---

### Task B2: Hold the fewer AI clips at cadence (scoped min-hold)

**Files:**
- Modify: `src/app/api/videos/generate-config/route.ts` (body destructure ~204–246; `minHoldSec` ~386)
- Modify: `src/app/(dashboard)/video-editor/page.tsx` (generate-config call ~1875–1884; add import)
- Reuse: `scripts/verify-broll-min-hold.ts` (already tests the freeze-safe invariant — no new test needed for the function)

**Interfaces:**
- Consumes: `targetCadenceSec` (Task B1), `buildMinHoldSegments` (existing).
- generate-config now accepts request field `minHoldSec?: number`; editor sends it ONLY for `stockSource ∈ {auto-mix, kie-image}`. Normal video stock sends nothing → `undefined` → env (unset) → `0` → legacy 1-clip-per-caption path (unchanged).

**Why this is safe:** `buildMinHoldSegments` is already covered by `verify-broll-min-hold.ts` for the freeze-safe invariant (every segment span ≤ its clip duration) and the cadence reduction. This task only switches its activation from a never-set global env to a per-request param scoped to the AI path.

- [ ] **Step 1: Add `minHoldSec` to the generate-config request body**

In `generate-config/route.ts`, add to the destructure (after `sceneDurations = [] as number[],` ~224):

```ts
    minHoldSec: minHoldSecParam,
```

and to the body type block (after `sceneDurations?: number[];` ~245):

```ts
    minHoldSec?: number;
```

- [ ] **Step 2: Prefer the request param over the env in the per-subtitle branch**

Replace (`~386`):

```ts
      const minHoldSec = Math.max(0, Math.min(8, Number(process.env.STOCK_MIN_HOLD_SEC) || 0));
```

with (request param wins; env still a global override; 0 = legacy):

```ts
      // Cadence: hold each clip ≥minHoldSec across several captions instead of cutting on
      // every caption. The editor sends minHoldSec only for AI-gen / auto-mix (the small,
      // cost-capped pool from B1) so normal video stock keeps the legacy 1-clip-per-caption
      // path. STOCK_MIN_HOLD_SEC stays a global override; 0/unset = legacy. buildMinHoldSegments
      // is freeze-safe (see verify-broll-min-hold.ts).
      const minHoldSec = Math.max(0, Math.min(8,
        Number(minHoldSecParam) || Number(process.env.STOCK_MIN_HOLD_SEC) || 0,
      ));
```

- [ ] **Step 3: Type-check the route**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Editor — send `minHoldSec` for the AI / auto-mix path only**

In `video-editor/page.tsx`, add the import alongside other `@/lib/broll-even-split` usage (or add a new import line):

```ts
import { targetCadenceSec } from "@/lib/broll-even-split";
```

In the generate-config fetch body (`~1882–1883`), add a line so AI/auto-mix gets cadence holding (`audioDurationMs` is already in scope here):

```ts
        sceneClipCounts: sceneClipCountsForConfig, sceneDurations: pipe.current.sceneDurations ?? [],
        preferredLLM: preferredLLMRef.current,
        ...(stockSource === "auto-mix" || stockSource === "kie-image"
          ? { minHoldSec: targetCadenceSec((audioDurationMs ?? 0) / 1000) }
          : {}),
```

(Manual clip counts on the AI path already route to even-split via `sceneClipCountsForConfig = []`, which gives `duration/N` cadence and never enters the per-subtitle branch — so this param is a no-op there, correctly.)

- [ ] **Step 5: Re-run the existing min-hold test to confirm the function still holds its invariant**

Run: `npx tsx scripts/verify-broll-min-hold.ts`
Expected: PASS (unchanged — this task didn't modify the function).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/videos/generate-config/route.ts "src/app/(dashboard)/video-editor/page.tsx"
git commit -m "feat(broll): hold AI/auto-mix b-roll at 3-5s cadence via scoped minHoldSec (no strobe)"
```

---

### Task C (DONE — added to this PR): Automix true mix

Mew chose to fold C in before deploying. Implemented:
- `src/lib/automix-plan.ts` — `planAutoMixSources(n, weights)` (weighted, interleaved source assignment; default video:photo:ai = 3:2:1) + `pickEvenIndices(total, n)` (evenly-spaced active captions). Pure, tested in `scripts/verify-automix-plan.ts`.
- `fetch-stock/route.ts` — an "Auto Mix source plan" block computes a cadence-capped piece count (`aiGenPieceCount`, 21s→~6), picks that many evenly-spaced captions, and assigns each a source by weight (only providers the user enabled get weight; env-tunable `AUTOMIX_WEIGHT_VIDEO|PHOTO|AI`). The video loop now skips non-video slots in auto-mix; the image loop is driven by the planned photo/AI slots (kind `"ai"` → kie.ai directly; `"photo"` → free photo providers, then kie fallback) instead of "keywords with zero video". Results re-sorted by script order so the mix is interleaved, not grouped.
- No editor change needed: it already sends `autoMixProviders` + per-subtitle + (via B2) `minHoldSec` for auto-mix.

Known v1 limitations (acceptable; noted for follow-up): video SEARCH still runs for all keywords (only picking is skipped — wasteful but $0); a planned "photo" slot that finds no stock photo falls back to a paid AI image; results interleave is by keyword order (good enough), not exact plan order.

---

## Build verification (before PR)

- [ ] Run all three verify scripts green:
  - `npx tsx scripts/verify-kie-image-prompt.ts`
  - `npx tsx scripts/verify-broll-cadence.ts`
  - `npx tsx scripts/verify-broll-min-hold.ts`
- [ ] `npx tsc --noEmit -p tsconfig.json` — clean.
- [ ] `npm run build` — completes (render-backend change gate per CLAUDE.md).
- [ ] Open PR `mew/broll-ai-gen-quality` → `main`. Mew merges + deploys; eyeball QA: one 21s AI-gen clip in `/video-editor` → expect ~6 images (check `[fetch-stock] kie.ai generated N clips` ≈ 6), each held ~3.5s (`[config] per-subtitle-top MIN_HOLD=3.5s: ~6 clips`), prompts content-specific (`[fetch-stock] kie image ready for "<keyword>"`).

## Self-Review notes

- **Spec coverage:** #1 count→B1; #1 frantic→B2; #2 quality→A; #3 automix→Task C (deferred, documented). ✓
- **Scope:** `/video-editor` only; normal video stock untouched (B2 gated on stockSource; B1 gated on isPerSubtitleMode). ✓
- **Type consistency:** `targetCadenceSec`/`aiGenPieceCount`/`buildKieImagePrompt` signatures identical across producer (lib) and consumers (fetch-stock, editor, generate-config). `generateKieImageKenBurns` new arg order `(prompt, label, token, model, imagePath, outPath)` applied at both call sites. ✓
- **No new cost:** A reuses existing `relevanceSpec`/`visualDirection`; no new LLM/API call. ✓
- **Reversible:** `STOCK_MIN_HOLD_SEC=0` is the global override; B2's default lives in code but the env can force-revert without deploy. ✓
