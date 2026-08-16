# B-roll Scope Fidelity + Per-Window Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Advanced B-roll region/style scope actually control what users see (no more Western-stock leaks when Thai/Asian is chosen, real style variety from gpt-image-2), then give users per-window b-roll control in the Editor v2 Post phase (swap stock / upload own media / AI-gen with editable prompt).

**Architecture:** Phase 1 hardens the existing preference pipeline at its three leak points — opposite-region avoid terms feeding every ranker, an explicit region clause + style-driven base look inside `buildKieImagePrompt`, and preference-aware vision/LLM rank prompts — no structural change. Phase 2 adds a net-new per-window edit surface on the existing Post-phase timeline (`TimelinePanel` b-roll track becomes clickable), three window-level asset sources behind new API routes, and a batched base re-render that reuses the job's TTS/avatar assets without re-charging minutes (per CONTEXT.md "Per-window Upgrade").

**Tech Stack:** Next.js 15 App Router, TypeScript, Prisma 6 (SQLite), kie.ai image API (gpt-image-2 default), Gemini (rank/vision), Remotion render pipeline, ffmpeg (Ken Burns/crop), existing credits ledger.

## Global Constraints

- `main` = production; work on branch `mew/broll-scope-per-window`, PR into main. Never push broken code to main.
- Subtitle timing invariant (CLAUDE.md): do NOT touch TTS-timing / caption text paths; b-roll changes must never alter captions or their timing.
- Region scope semantics (Mew, 2026-07-07): scope = **directional consistency chosen by the user**, not forced ethnicity. Thai unavailable → degrade to Asian is OK; leaking to Western/blonde is a failure. European chosen → leaking to Asian is a failure. `auto` = today's behavior, untouched.
- Style semantics (Mew, 2026-07-07): chosen style must change the actual look of AI-gen images (cinematic/surreal/etc.), not just append hints to a hardcoded photorealistic template.
- Phase 2 UX (Mew, 2026-07-07): progressive disclosure — beginners see simple Thai-language controls; the full English prompt is behind an "ขั้นสูง" (advanced) toggle. No wall of English for novices.
- No per-window AI **video** gen this round (ADR 0002: Seedance is a separate benchmarked phase).
- Per-window AI image gen charges normal image credits (2/3/4 by model, `src/lib/credit-costs.ts`); swap-stock and upload are free. Re-render after window edits must NOT re-charge render minutes (CONTEXT.md "Per-window Upgrade").
- All user-facing copy in Thai, house violet design system, `lg` breakpoint mobile support (editor v2 is mobile-responsive — don't regress).
- Test pattern = `scripts/verify-*.ts` run via `tsx` (repo convention); build-verify (`npm run build`) before merge.

## Phase Map

| Phase | What | Ships as |
|---|---|---|
| 1 | Scope fidelity quick fix (Tasks 1–4) | PR 1 — small, deployable alone |
| 2 | Per-window b-roll editing (Tasks 5–12) | PR 2 — behind `NEXT_PUBLIC_BROLL_WINDOW_EDIT` flag |

---

## Phase 1 — Scope fidelity quick fix

Background (from 2026-07-07 audit): the preference wiring is complete end-to-end (UI → job → `extract-keywords` → `fetch-stock`), but (a) every region's `avoid` list is empty so no ranker ever down-ranks the opposite region, (b) the vision re-ranker — the only stage that actually sees faces — receives no preference signal at all (`fetch-stock/route.ts:1197`), and (c) the kie image prompt receives the preference only as a truncatable tail hint (`appendBrollPreferenceToDirection` slices at 260 chars cutting the suffix first; `sanitize()` in `kie-image-prompt.ts` slices again at 240) inside a hardcoded photorealistic template.

### Task 1: Opposite-region avoid terms, thai→asian degrade, truncation fix (`broll-preferences.ts`)

**Files:**
- Modify: `src/lib/broll-preferences.ts`
- Test: `scripts/verify-broll-preferences.ts` (new)

**Interfaces:**
- Consumes: existing `REGION_HINTS`, `STYLE_HINTS`, `appendBrollPreferenceToDirection`, `collectPreferenceHints` (module-private).
- Produces: new export `brollPreferenceInstruction(input: BrollPreferenceInput): string` (returns the combined region+style instruction sentence, `""` when no preference) — Task 3 injects it into ranker prompts. Existing exports keep signatures.

- [ ] **Step 1: Write the failing verify script**

Create `scripts/verify-broll-preferences.ts` (plain assertions, run with `npx tsx`; follow the assert style of existing `scripts/verify-*.ts`):

```ts
import {
  appendBrollPreferenceToDirection,
  augmentRelevanceSpecWithBrollPreference,
  brollPreferenceInstruction,
} from "../src/lib/broll-preferences";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures++;
}

// 1. Opposite-region avoid terms exist (the leak fix)
const asianSpec = augmentRelevanceSpecWithBrollPreference(null, { brollRegionPreference: "asian" });
check("asian avoid includes western", (asianSpec?.avoidConcepts ?? []).some((t) => /caucasian|western|european/.test(t)));
const thaiSpec = augmentRelevanceSpecWithBrollPreference(null, { brollRegionPreference: "thai" });
check("thai avoid includes western", (thaiSpec?.avoidConcepts ?? []).some((t) => /caucasian|western|european/.test(t)));
const euroSpec = augmentRelevanceSpecWithBrollPreference(null, { brollRegionPreference: "european" });
check("european avoid includes asian", (euroSpec?.avoidConcepts ?? []).some((t) => /asian/.test(t)));

// 2. thai degrades to asian in fallback queries (never western)
check("thai fallback contains asian queries", (thaiSpec?.safeFallbackQueries ?? []).some((q) => q.includes("asian")));
check("thai fallback has no european", !(thaiSpec?.safeFallbackQueries ?? []).some((q) => /european|western/.test(q)));

// 3. Truncation: long base direction must NOT swallow the preference suffix
const longBase = "x".repeat(300);
const appended = appendBrollPreferenceToDirection(longBase, { brollRegionPreference: "thai" });
check("suffix survives long base", /Thai|Southeast Asian/.test(appended));

// 4. Instruction helper
check("instruction non-empty for thai", brollPreferenceInstruction({ brollRegionPreference: "thai" }).length > 0);
check("instruction empty for auto", brollPreferenceInstruction({}) === "");

process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/verify-broll-preferences.ts`
Expected: FAIL lines for avoid-term checks + suffix check, and a TS error that `brollPreferenceInstruction` is not exported (that error itself is the failing state — fine).

- [ ] **Step 3: Implement in `src/lib/broll-preferences.ts`**

3a. Fill `avoid` in `REGION_HINTS` (keep `positive`/`fallbackQueries` as-is except thai fallback):

```ts
asian: {
  // ...existing fields...
  avoid: ["caucasian people", "western people", "european people", "blonde hair"],
},
thai: {
  // ...existing fields...
  avoid: ["caucasian people", "western people", "european people", "blonde hair"],
  fallbackQueries: [
    "bangkok city street", "thai office workers", "southeast asian people",
    // degrade path: thai unavailable → asian, never western
    "asian business people", "asian city street", "asian office workers",
  ],
},
european: {
  // ...existing fields...
  avoid: ["asian people", "east asian people", "southeast asian people"],
},
// global + no-people unchanged
```

3b. Strengthen the instructions to encode the consistency rule (replace existing strings):

```ts
asian:  { instruction: "Prefer Asian people (East or Southeast Asian) and Asian urban, business, or lifestyle contexts whenever people or places appear. Never use Western/European-looking people.", ... }
thai:   { instruction: "Prefer Thai or Southeast Asian people, Bangkok or Thailand local settings, and realistic local environments. If Thai-specific footage is unavailable, other Asian people and settings are acceptable — never Western/European-looking people.", ... }
european: { instruction: "Prefer European or Western people, European city settings, and western office or lifestyle contexts whenever people or places appear. Never use Asian-looking people.", ... }
```

3c. Fix `appendBrollPreferenceToDirection` so the suffix (the preference) is never the part that gets cut:

```ts
export function appendBrollPreferenceToDirection(direction: string, input: BrollPreferenceInput): string {
  const hints = collectPreferenceHints(input);
  if (!hints) return direction;
  const suffix = hints.instruction.replace(/\s+/g, " ").trim();
  const MAX = 320;
  const budget = Math.max(0, MAX - suffix.length - 1);
  const base = direction.trim().replace(/\s+/g, " ").slice(0, budget).trimEnd();
  return [base, suffix].filter(Boolean).join(" ");
}
```

3d. Export the instruction helper (for Task 3's ranker prompts):

```ts
export function brollPreferenceInstruction(input: BrollPreferenceInput): string {
  return collectPreferenceHints(input)?.instruction ?? "";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx scripts/verify-broll-preferences.ts`
Expected: all PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/broll-preferences.ts scripts/verify-broll-preferences.ts
git commit -m "fix(broll): opposite-region avoid terms, thai→asian degrade, keep preference on truncation"
```

### Task 2: Style-driven base look + explicit region clause in the kie image prompt

**Files:**
- Modify: `src/lib/kie-image-prompt.ts`
- Modify: `src/lib/broll-preferences.ts` (add `surreal` style option + hints)
- Test: `scripts/verify-kie-image-prompt.ts` (**already exists** — extend it; update any existing assertion that pins the old fixed template)

**Interfaces:**
- Consumes: `BrollRegionPreference`, `BrollVisualStyle`, `normalizeBrollRegionPreference`, `normalizeBrollVisualStyle` from `@/lib/broll-preferences`.
- Produces: `buildKieImagePrompt(subject: string, opts?: { visualDirection?: string; terms?: RelevanceTerms | null; region?: string | null; style?: string | null }): string` — Task 3 (and Phase 2 Task 9) pass `region`/`style` through. Backward compatible: omitting them = current photorealistic default.

- [ ] **Step 1: Extend the existing verify script with failing checks**

Append to `scripts/verify-kie-image-prompt.ts` (keep its existing `check` helper and passing checks; fix any that assert the full old template verbatim):

```ts
import { buildKieImagePrompt } from "../src/lib/kie-image-prompt";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures++;
}

// region clause is a primary clause, not a truncatable tail
const thai = buildKieImagePrompt("street food vendor cooking", { region: "thai" });
check("thai clause present", /Thai or Southeast Asian/.test(thai));
check("thai clause early in prompt", thai.indexOf("Thai") < thai.length / 2);

const euro = buildKieImagePrompt("business meeting", { region: "european" });
check("european clause present", /European or Western/.test(euro));

// style changes the base look — no photorealistic lock-in
const surreal = buildKieImagePrompt("time and money", { style: "surreal" });
check("surreal not photorealistic", !/photorealistic photograph/.test(surreal));
check("surreal look present", /surreal|dreamlike/i.test(surreal));

const cinematic = buildKieImagePrompt("city at night", { style: "cinematic" });
check("cinematic film still", /film still|dramatic lighting/i.test(cinematic));

// default unchanged shape
const def = buildKieImagePrompt("coffee shop");
check("default photorealistic", /cinematic, photorealistic vertical 9:16 photograph/.test(def));
check("default keeps grid guard", /no collage, no grid/.test(def));

// no-people region
const nop = buildKieImagePrompt("desk setup", { region: "no-people" });
check("no-people clause", /no people, no faces/.test(nop));

process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/verify-kie-image-prompt.ts`
Expected: FAIL on region/style checks (current builder ignores those opts).

- [ ] **Step 3: Implement**

3a. In `src/lib/broll-preferences.ts` add the `surreal` style (type union + option + hints):

```ts
export type BrollVisualStyle = "auto" | "documentary" | "cinematic" | "business" | "lifestyle" | "tech" | "minimal" | "surreal";
// BROLL_STYLE_OPTIONS: add { value: "surreal", label: "Surreal" }
// STYLE_HINTS.surreal:
surreal: {
  instruction: "Use surreal, imaginative, dreamlike visuals with unexpected juxtapositions and bold artistic composition.",
  positive: ["surreal", "dreamlike", "imaginative", "abstract", "bold colors", "artistic"],
  avoid: ["plain office", "corporate stock photo"],
  fallbackQueries: ["surreal abstract art", "dreamlike landscape", "creative light installation"],
  domainLabel: "surreal artistic style",
},
```

(Update `isVisualStyle` to accept `"surreal"`.)

3b. Rewrite `src/lib/kie-image-prompt.ts` (full replacement — keep `sanitize` and the grid-guard tail):

```ts
import type { RelevanceTerms } from "@/lib/relevance-spec";
import {
  normalizeBrollRegionPreference,
  normalizeBrollVisualStyle,
  type BrollRegionPreference,
  type BrollVisualStyle,
} from "@/lib/broll-preferences";

function sanitize(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
}

// Style controls the OPENER (what kind of image) and the LOOK line (lighting/finish).
// "auto"/unknown falls back to today's photorealistic template so existing behavior is unchanged.
const STYLE_LOOKS: Record<Exclude<BrollVisualStyle, "auto">, { opener: string; look: string }> = {
  documentary: { opener: "A candid, documentary-style vertical 9:16 photograph of", look: "natural light, handheld observational feel, authentic unstaged detail, sharp focus" },
  cinematic:   { opener: "A cinematic vertical 9:16 film still of",                 look: "dramatic lighting, shallow depth of field, premium color grade, filmic contrast, sharp focus" },
  business:    { opener: "A clean, professional vertical 9:16 photograph of",       look: "bright modern lighting, crisp corporate aesthetic, realistic detail, sharp focus" },
  lifestyle:   { opener: "A warm, lifestyle vertical 9:16 photograph of",           look: "golden natural light, candid everyday mood, soft realistic detail, sharp focus" },
  tech:        { opener: "A sleek, modern vertical 9:16 photograph of",             look: "cool ambient lighting, high-tech atmosphere, precise clean detail, sharp focus" },
  minimal:     { opener: "A minimal, uncluttered vertical 9:16 photograph of",      look: "soft even light, generous negative space, simple composition, sharp focus" },
  surreal:     { opener: "A surreal, imaginative vertical 9:16 digital artwork of", look: "dreamlike atmosphere, unexpected juxtaposition, bold rich colors, painterly detail" },
};

const DEFAULT_LOOK = { opener: "A cinematic, photorealistic vertical 9:16 photograph of", look: "natural lighting, realistic detail, sharp focus" };

// Region becomes an explicit, conditional people clause near the head of the prompt —
// safe for people-less scenes ("any people shown…") and immune to tail truncation.
const REGION_CLAUSES: Record<Exclude<BrollRegionPreference, "auto">, string> = {
  asian: "any people shown are Asian (East or Southeast Asian), in an Asian setting",
  thai: "any people shown are Thai or Southeast Asian, in a Thailand local setting",
  european: "any people shown are European or Western, in a European or Western setting",
  global: "people shown are diverse and international",
  "no-people": "no people, no faces, focus on objects and environment",
};

export function buildKieImagePrompt(
  subject: string,
  opts?: { visualDirection?: string; terms?: RelevanceTerms | null; region?: string | null; style?: string | null },
): string {
  const subj = sanitize(subject);
  const dir = sanitize(opts?.visualDirection ?? "");
  const terms = opts?.terms ?? null;
  const region = normalizeBrollRegionPreference(opts?.region);
  const style = normalizeBrollVisualStyle(opts?.style);
  const looks = style ? STYLE_LOOKS[style] : DEFAULT_LOOK;
  const domain =
    terms?.domainLabel && terms.domainLabel.toLowerCase() !== "general" ? sanitize(terms.domainLabel) : "";
  const concepts = (terms?.positive ?? []).map(sanitize).filter(Boolean).slice(0, 2);

  const parts: string[] = [];
  parts.push(`${looks.opener} ${subj || domain || "a relevant scene"}`);
  if (region) parts.push(REGION_CLAUSES[region]);
  if (domain) parts.push(`in a ${domain} setting`);
  if (concepts.length) parts.push(`featuring ${concepts.join(" and ")}`);
  if (dir) parts.push(dir.replace(/[.?!]+$/g, ""));
  parts.push("a single uninterrupted scene, one continuous frame");
  parts.push(`${looks.look}, no text, no watermark, no logo, no caption, no collage, no grid, no split screen, no multiple panels, no storyboard, no comic layout, no borders`);
  return `${parts.join(", ")}.`;
}
```

- [ ] **Step 4: Run both verify scripts to verify pass (and no regression)**

Run: `npx tsx scripts/verify-kie-image-prompt.ts && npx tsx scripts/verify-broll-preferences.ts`
Expected: all PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/kie-image-prompt.ts src/lib/broll-preferences.ts scripts/verify-kie-image-prompt.ts
git commit -m "feat(broll): style-driven AI image look + explicit region clause, add surreal style"
```

### Task 3: Wire preference into fetch-stock's kie calls and vision/LLM rank prompts

**Files:**
- Modify: `src/app/api/videos/fetch-stock/route.ts` (call sites ~1912, ~1935, ~2565; `visionRerankCandidates` ~1146–1215; `llmRankBatch` ~1217–1260 and its callers ~1261–1290, ~2269)
- Test: extend `scripts/verify-kie-image-prompt.ts` is NOT needed; this task is verified by grep-assertions + build (route files aren't unit-testable without the Next runtime; repo convention is verify-scripts for libs + build-verify for routes)

**Interfaces:**
- Consumes: `brollPreferenceInstruction` (Task 1), extended `buildKieImagePrompt` (Task 2), existing `brollPreference: BrollPreferenceInput` already in scope at `fetch-stock/route.ts:1345`.
- Produces: no new exports; behavior change only.

- [ ] **Step 1: Pass region/style into all three `buildKieImagePrompt` call sites**

At ~1912 and ~1935 (kie-image mode) and ~2565 (Auto Mix AI slot), change:

```ts
buildKieImagePrompt(keyword, { visualDirection, terms: relTerms })
```
to:
```ts
buildKieImagePrompt(keyword, {
  visualDirection,
  terms: relTerms,
  region: brollPreference.brollRegionPreference,
  style: brollPreference.brollVisualStyle,
})
```
(same change with `kw` at the Auto Mix site).

- [ ] **Step 2: Inject the preference into the vision re-rank prompt**

`visionRerankCandidates` receives `terms` but no preference text. Add a parameter `preferenceInstruction: string` (threaded from the caller where `brollPreference` is in scope; import `brollPreferenceInstruction` from `@/lib/broll-preferences`). In the prompt template (~line 1197), after the "Down-rank footage of:" line add:

```ts
const preferenceLine = preferenceInstruction
  ? `\nSTRICT VISUAL PREFERENCE: ${preferenceInstruction} Reject options whose people clearly violate this preference.`
  : "";
```

and interpolate `${preferenceLine}` into the prompt right after the Down-rank line. Note: Task 1's avoid terms already flow into `terms.avoid` here, so the existing Down-rank line now also carries e.g. "caucasian people" — the explicit line makes the model actually look at faces for it.

- [ ] **Step 3: Inject the preference into the LLM text ranker**

`llmRankBatch` (~1217) already interpolates `directionLine` from `visualDirection`. Add the same `preferenceInstruction` parameter and a line:

```ts
const preferenceRankLine = preferenceInstruction
  ? `\nVISUAL PREFERENCE (strict): ${preferenceInstruction} Prefer candidates matching it; use -1 rather than picking a clear violation when alternatives exist.`
  : "";
```

Thread through `llmRankCandidates` (~1261) and its call site (~2269): compute once near the top of the handler:

```ts
const preferenceInstruction = brollPreferenceInstruction(brollPreference);
```

- [ ] **Step 4: Build-verify**

Run: `npm run build`
Expected: compiles clean (route has no unit harness; build is the gate). Then grep-assert the wiring:

```bash
grep -n "region: brollPreference" src/app/api/videos/fetch-stock/route.ts | wc -l   # expect 3
grep -n "STRICT VISUAL PREFERENCE" src/app/api/videos/fetch-stock/route.ts | wc -l  # expect 1
grep -n "VISUAL PREFERENCE (strict)" src/app/api/videos/fetch-stock/route.ts | wc -l # expect 1
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/videos/fetch-stock/route.ts
git commit -m "fix(broll): thread region/style scope into kie prompts and vision/LLM rankers"
```

### Task 4: Phase 1 review gate + deploy candidate

- [ ] **Step 1: Full build + all verify scripts**

Run: `npm run build && npx tsx scripts/verify-broll-preferences.ts && npx tsx scripts/verify-kie-image-prompt.ts`
Expected: build OK, all PASS.

- [ ] **Step 2: Tier-1 review (mew-reviewer) on the Phase 1 diff**, then open PR 1 (`mew/broll-scope-per-window` → main) covering Tasks 1–3.

- [ ] **Step 3: After merge+deploy — Mew live QA (acceptance)**: generate on prod (a) Thai script + region "ไทย" + AI-heavy mix → AI images show Thai/Asian people & context, stock picks don't leak Western when Asian options exist; (b) same script + region "ยุโรป" → no Asian leak; (c) style "Surreal" → visibly non-stock look.

---

## Phase 2 — Per-window b-roll editing (Editor v2 Post phase)

### Verified architecture facts (2026-07-07 recon — executors: trust these, don't re-derive)

- The preview job's b-roll lives at `VideoJob.outputJson → output.preview.config.bgVideos[]` — type `BrollVideo` (`src/remotion/types.ts:37-50`): `{ src, start, end, clipOffset?, clipDuration?, keyword?, title?, query?, provider?, ... }`, `start`/`end` in **seconds**. There is no `scenes[]` in this config.
- `TimelinePanel.tsx:31-45 brollSpansFromConfig` currently reads `config.scenes[].durationInFrames` — a field that never exists in v2 preview configs — so the b-roll lane always fail-opens to one full-width block. Phase 2 fixes it to read `bgVideos`.
- Post phase loads the job via `GET /api/videos/jobs/[id]` → `output.preview` (`VideoJobPreviewData`, `src/lib/video-job.ts:75-96`) with `captions`, `config`, `voiceUrl`, `audioDurationMs`, `avatarModel/avatarVideoUrl/avatarMode/compositeBaseUrl/tailAvatarUrl`. `usePostPhaseEditor(job, script, { onExported })` owns post-phase state; `PostPhase.tsx` passes `config={ed.preview?.config ?? null}` to the timeline.
- Burn is free because of the server-trusted `ChargedClip` table (`src/lib/clip-charge.ts` — `canonicalRenderUrl` + `isBurnAlreadyPaid`; charge recorded by `recordChargedClip(userId, outputUrl, chargedMinutes?, creditsSpent?)`). **Phase 2's free re-render must use the same server-trusted pattern — never a client-sent "this is free" flag.**
- Free-recomposite precedent: `AvatarAdjustOverlay.tsx:154-203` → `POST /api/heygen/composite` (mode `chromakey`, reuses stored avatar assets on a base URL) → `PATCH /api/videos/jobs/{id}` `{ videoUrl }` (PATCH accepts only `/^\/api\/renders\/[\w.-]+\.mp4$/`, owner + status done).
- The orchestrator (`src/lib/mcp/orchestrator.ts`) calls routes internally via `pipelineCaller(userId)` (`src/lib/mcp/pipeline-client.ts:52`). Preview render step (~line 405): `caller.post("/api/videos/render", { shortVideoConfig: baseConfig, fps: RENDER_FPS, jpegQuality: RENDER_JPEG_QUALITY, ... })` → `pollRender`. Upload/cutaway branch starts at `input.mode === "upload"` (line 192) — the new mode branches beside it.
- `searchPexels` (`fetch-stock/route.ts:247`), `searchPixabay` (:362), `downloadAndCrop` (:319), `normalizeForRemotion` (:161), `applyKenBurns` (:824), `generateKieImageKenBurns` (:859), `kieCreateTask` (:745), `kiePollResult` (:758), `buildKieImageInput` (:799), `KIE_IMAGE_MODELS`/`DEFAULT_KIE_IMAGE_MODEL`/`isKieImageModel` (:781-794) are ALL module-private in `fetch-stock/route.ts` (route files can't export helpers) — Task 5 extracts them.
- Credits: `spendCredits(userId, amount, action)` → `{ok:true, balanceAfter, fromGranted, fromPurchased} | {ok:false, reason:"insufficient"}`; `refundCredits(userId, fromGranted, fromPurchased, action)`; `creditCostFor(action)` / `costKeyForKieModel(modelId)` (only flux-2/pro, gpt-image-2, nano-banana-2 are priced; others → null = not purchasable). Ledger action convention `"{operation}:{id}"`.
- Upload precedent: `/api/videos/upload-avatar` — auth + FREE-plan 403, 500 MB cap, saves `public/renders/avatar-upload-{ts}-{uuid}.{ext}`, returns `{ url: "/api/renders/<file>" }`; files served by `/api/renders/[filename]` (Range-capable). Stock clips live in `stocks/` served by `/api/stocks/[filename]`.
- Test convention: pure helpers in `src/lib/` + `scripts/verify-*.ts` via `npx tsx` (no vitest/jest, no DB in verify scripts). Register `verify:*` in package.json like existing entries.

**Feature flag:** everything user-visible in Phase 2 is gated by `NEXT_PUBLIC_BROLL_WINDOW_EDIT === "1"` (client) — flag-off = today's behavior byte-identical. Server routes check the same env (`BROLL_WINDOW_EDIT !== "0"` is NOT the gate — use `process.env.NEXT_PUBLIC_BROLL_WINDOW_EDIT === "1"` on both sides for one switch).

### Task 5: Extract shared b-roll asset helpers out of fetch-stock (`src/lib/broll-asset-lib.ts`, `src/lib/kie-client.ts`)

**Files:**
- Create: `src/lib/kie-client.ts` (kie API machinery)
- Create: `src/lib/broll-asset-lib.ts` (ffmpeg + stock-search machinery; server-only)
- Modify: `src/app/api/videos/fetch-stock/route.ts` (delete moved code, import from the new libs)

**Interfaces:**
- Produces (moved verbatim — same names, signatures, behavior; now exported):
  - `kie-client.ts`: `KIE_IMAGE_MODELS`, `type KieImageModel`, `DEFAULT_KIE_IMAGE_MODEL`, `isKieImageModel(v): v is KieImageModel`, `buildKieImageInput(model, prompt)`, `kieCreateTask(model, input, token): Promise<string>`, `kiePollResult(taskId, token): Promise<string>` (current return shapes exactly as defined in fetch-stock today).
  - `broll-asset-lib.ts`: `normalizeForRemotion(filePath): Promise<NormalizeResult>` (+ export `NormalizeResult`), `downloadAndCrop(url, outPath): Promise<void>`, `applyKenBurns(imagePath, outPath): Promise<void>`, `generateKieImageKenBurns(prompt, label, token, model, imagePath, outPath): Promise<{duration: number; imageUrl: string}>`, `searchPexels(query, key, minDur, perPage)`, `searchPixabay(query, key, minDur, perPage)` (+ their result types `PexelsVideo`/`PixabayVideo`).
- Consumed by: fetch-stock (unchanged behavior) and Tasks 7–10.

- [ ] **Step 1: Move the functions.** Cut each listed function + its private helpers/constants/types from `fetch-stock/route.ts` into the new lib files **verbatim** (no logic edits — this task is pure relocation). Keep module-level env reads (`KEN_BURNS_DURATION_SEC` etc.) with the moved code. Add `import "server-only";` at the top of `broll-asset-lib.ts` (repo already uses this pattern if present; if the package isn't installed, skip the import — do not add a dependency).
- [ ] **Step 2: Re-import in fetch-stock.** Replace the deleted definitions with imports from `@/lib/kie-client` and `@/lib/broll-asset-lib`. No call-site changes.
- [ ] **Step 3: Build-verify.** Run `npm run build` — compiles clean. Run `npx tsx scripts/verify-kie-image-prompt.ts` — still passes (proves no accidental behavior change in the prompt path).
- [ ] **Step 4: Diff review.** `git diff --stat` should show fetch-stock shrinking by ≈ the sum of the new files; `git diff` on fetch-stock must show only deletions + import lines (zero logic edits).
- [ ] **Step 5: Commit.**

```bash
git add src/lib/kie-client.ts src/lib/broll-asset-lib.ts src/app/api/videos/fetch-stock/route.ts
git commit -m "refactor(broll): extract kie + asset helpers from fetch-stock into shared libs"
```

### Task 6: Timeline b-roll spans from `bgVideos` + window selection (`src/lib/broll-spans.ts`)

**Files:**
- Create: `src/lib/broll-spans.ts` (pure, client-safe)
- Modify: `src/app/(dashboard)/video-editor/_v2/TimelinePanel.tsx` (use the lib; make b-roll lane clickable when flag on)
- Test: `scripts/verify-broll-spans.ts` (new; register `"verify:broll-spans"` in package.json)

**Interfaces:**
- Produces:
```ts
export type BrollWindowSpan = { index: number; startMs: number; endMs: number; label: string; src: string };
export function brollWindowSpans(config: Record<string, unknown> | null | undefined, durMs: number): BrollWindowSpan[];
```
Reads `config.bgVideos[]` (`{ src: string; start: number; end: number; keyword?: string }`, seconds). Returns one span per entry (`startMs = start*1000` clamped to `[0, durMs]`, label = `keyword || คลิป ${index+1}`), sorted by start, dropping zero-width spans. When `bgVideos` is missing/empty → `[]` (caller falls back to today's single "บีโรลอัตโนมัติ" block, preserving current behavior for old jobs).
- Consumes: nothing new. TimelinePanel keeps its `Span` rendering; adds `onSelectBrollWindow?: (index: number) => void` prop; clicking a span (flag on) calls it AND still jump-seeks (current behavior).

- [ ] **Step 1: Write the failing verify script** — `scripts/verify-broll-spans.ts` with cases: (a) 3-window config → 3 spans, ms conversion + labels correct; (b) missing `bgVideos` → `[]`; (c) span exceeding `durMs` clamps; (d) non-array garbage → `[]` (no throw).
- [ ] **Step 2: Run to verify FAIL** (`npx tsx scripts/verify-broll-spans.ts` — module not found).
- [ ] **Step 3: Implement the lib**, then in `TimelinePanel.tsx` replace the body of the b-roll-lane derivation: try `brollWindowSpans(config, durMs)`; if it returns `[]`, keep the existing `brollSpansFromConfig` fallback path (delete its dead `scenes` branch, keep the single-block fallback). Wire clicks behind `process.env.NEXT_PUBLIC_BROLL_WINDOW_EDIT === "1"`.
- [ ] **Step 4: Run verify + build** — script PASS, `npm run build` clean.
- [ ] **Step 5: Commit** — `fix(editor-v2): timeline b-roll lane reads bgVideos windows; clickable behind BROLL_WINDOW_EDIT`.

### Task 7: Per-window stock search + select endpoints

**Files:**
- Create: `src/app/api/videos/broll-window/search/route.ts`
- Create: `src/app/api/videos/broll-window/select/route.ts`

**Interfaces:**
- `POST /api/videos/broll-window/search` body `{ keyword: string }` → `{ candidates: { id: string; provider: "pexels"|"pixabay"; thumb: string; videoUrl: string; duration: number; title: string }[] }` (≤ 12, portrait only).
- `POST /api/videos/broll-window/select` body `{ videoUrl: string; provider: "pexels"|"pixabay"; keyword: string }` → `{ src: string /* /api/stocks/<file>.mp4 */, clipDuration: number }`.
- Consumes: `searchPexels`/`searchPixabay`/`downloadAndCrop`/`normalizeForRemotion` from Task 5 libs.

Spec:
- Auth via the same `getCurrentUser()` guard used by `/api/videos/jobs`; 401 without user; flag-gate 404 when `NEXT_PUBLIC_BROLL_WINDOW_EDIT !== "1"`.
- Resolve the user's Pexels/Pixabay keys exactly the way `/api/videos/jobs/route.ts` resolves them for its key guard (import the same helper it uses — read that file first); if neither key → 400 with the Thai message pattern used there.
- `search`: apply the user's saved region preference is NOT done here — the client sends the final keyword (it already shows the window's stored keyword prefilled; user edits freely). Query both providers in parallel (`Promise.allSettled`), map to the candidate shape, filter portrait like fetch-stock does, cap 12.
- `select`: validate `videoUrl` is `https://` and hostname ends with an allowlist entry (`pexels.com`, `pixabay.com`, `vimeocdn.com`, plus the exact CDN hosts fetch-stock downloads from today — copy its allowlist if one exists; if fetch-stock has none, restrict to URLs that came from a fresh `search` by re-checking the hostname against the two provider CDN suffixes). Download to `stocks/` with fetch-stock's filename convention, run `normalizeForRemotion`, return `{ src, clipDuration }` (probe duration the same way fetch-stock records `duration`).
- Rate-limit: in-process sliding window, 30 select-downloads/user/hour (mirror `tryConsumeKieImageRate`'s pattern from `src/lib/kie-image-guards.ts`).

- [ ] **Step 1: Implement both routes per spec.**
- [ ] **Step 2: Build-verify** (`npm run build`).
- [ ] **Step 3: Manual smoke** (dev server + curl with a session, or via the UI in Task 11): search "asian office" returns candidates; select downloads and returns a playable `/api/stocks/...mp4`.
- [ ] **Step 4: Commit** — `feat(broll-window): stock search + select endpoints`.

### Task 8: Per-window upload endpoint (image → Ken Burns, video → crop+normalize)

**Files:**
- Create: `src/app/api/videos/broll-window/upload/route.ts`

**Interfaces:**
- `POST` multipart, field `file` → `{ src: string /* /api/stocks/<file>.mp4 */, clipDuration: number }`.
- Consumes: `applyKenBurns`, `normalizeForRemotion` (Task 5).

Spec (mirror `/api/videos/upload-avatar` structure — read it first and copy its multipart/stream handling):
- Auth + FREE-plan 403 (`plan_required`) exactly like upload-avatar. Flag-gate 404.
- Images: ext/MIME `jpg|jpeg|png|webp`, ≤ 20 MB → save temp under scratch dir → `applyKenBurns(tempImage, out)` → out file `stocks/broll-upload-{Date.now()}-{randomUUID}.mp4` → `clipDuration = 5` (KEN_BURNS_DURATION_SEC).
- Videos: ext/MIME `mp4|mov|webm` (same list as upload-avatar), ≤ 200 MB → save to `stocks/` → crop to 9:16 with the same ffmpeg scale/crop filter `downloadAndCrop` uses (extract that filter into a small exported helper `cropToPortrait(inPath, outPath)` in `broll-asset-lib.ts` if `downloadAndCrop` can't take a local file) → `normalizeForRemotion` → probe duration → return.
- Reject anything else 415; cleanup temp files in `finally`.
- **Security gate: this task requires `/security-review` at review time** (file upload + ffmpeg on user input).

- [ ] **Step 1: Implement route per spec.**
- [ ] **Step 2: Build-verify.**
- [ ] **Step 3: Manual smoke**: upload a jpg → returned mp4 plays, 5s, 1080×1920; upload an mp4 → cropped portrait.
- [ ] **Step 4: Commit** — `feat(broll-window): user media upload (image ken-burns / video crop)`.

### Task 9: Per-window AI-gen endpoint (credits)

**Files:**
- Create: `src/app/api/videos/broll-window/generate/route.ts`

**Interfaces:**
- `POST` body `{ prompt: string; model?: string }` → success `{ src: string; clipDuration: number; creditsSpent: number; balanceAfter: number }` | insufficient `402 { error, need, balance }`.
- Consumes: `kieCreateTask`/`kiePollResult`/`buildKieImageInput`/`isKieImageModel`/`DEFAULT_KIE_IMAGE_MODEL` + `generateKieImageKenBurns` (Task 5), `resolveKieImageAccess`/`capKiePrompt`/`tryConsumeKieImageRate` (`src/lib/kie-image-guards.ts`), `spendCredits`/`refundCredits`/`costKeyForKieModel`/`creditCostFor` (`src/lib/credits.ts`).

Spec:
- Auth; flag-gate 404. Resolve access exactly like fetch-stock's gate (~lines 1386–1450): `resolveKieImageAccess({ managedKieOn, creditsLive, isAdmin, isPaidPlan })`; reject 403 when kie not unlocked for this user; resolve token = server `KIE_API_KEY` (managed) or admin BYOK — copy fetch-stock's resolution order.
- Model: default `DEFAULT_KIE_IMAGE_MODEL`; reject unknown via `isKieImageModel`. Non-admin: model must have a price (`costKeyForKieModel(model) !== null`) else 403.
- Prompt: `capKiePrompt` (2000 chars); reject empty.
- Rate: `tryConsumeKieImageRate(userId)` → 429 on exceed.
- Charge (non-admin on managed key, same `chargeImages` condition as fetch-stock): `spendCredits(userId, creditCostFor(costKey), "broll-window-image:" + <new cuid/uuid>)`; on `ok:false` → 402. Generate via `generateKieImageKenBurns(prompt, "broll-window", token, model, tmpImage, out)` with out = `stocks/broll-ai-{Date.now()}-{randomUUID}.mp4`; on ANY failure after a successful spend → `refundCredits(userId, fromGranted, fromPurchased, "broll-window-image-refund:" + sameId)` then 502.
- **Security gate: `/security-review` at review time** (credit spend path).

- [ ] **Step 1: Implement route per spec.**
- [ ] **Step 2: Build-verify.**
- [ ] **Step 3: Manual smoke on dev** (admin BYOK path is fine locally): generate with a Thai prompt → playable Ken Burns mp4; ledger row written (or admin = uncharged, matching fetch-stock semantics).
- [ ] **Step 4: Commit** — `feat(broll-window): per-window AI image generation with credit spend/refund`.

### Task 10: Free b-roll re-render — job mode `broll-rerender` (mew-worker-heavy)

**Files:**
- Modify: `src/app/api/videos/jobs/route.ts` (accept the new mode)
- Modify: `src/lib/mcp/orchestrator.ts` (new branch)
- Modify: `src/app/api/videos/render/route.ts` (server-trusted charge-skip)
- Create: `src/lib/broll-rerender.ts` (pure merge/validation helpers)
- Test: `scripts/verify-broll-rerender.ts` (new; register `"verify:broll-rerender"`)

**Interfaces:**
- `POST /api/videos/jobs` body extension: `{ mode: "broll-rerender", sourceJobId: string, windowEdits: { index: number; src: string; keyword?: string }[], idempotencyKey? }` → `{ jobId, status: "queued" }` (other create-job fields ignored for this mode).
- `broll-rerender.ts` produces:
```ts
export type WindowEdit = { index: number; src: string; keyword?: string };
export function validateWindowEdits(edits: unknown): WindowEdit[] | { error: string };
// src must match /^\/api\/(renders|stocks)\/[\w.-]+\.mp4$/ (single file, no traversal); index int ≥ 0; 1–40 edits; dedupe by index (last wins)
export function mergeWindowEdits(bgVideos: unknown[], edits: WindowEdit[]): { bgVideos: Record<string, unknown>[] } | { error: string };
// bounds-check index; per edit: replace src (+ keyword when given), set clipOffset 0, drop clipDuration (render Loop probes/loops safely) — KEEP start/end untouched; never reorder
```
- Render route consumes a new optional body field `rerenderOf: { sourceJobId: string }` — **valid only when**: job exists, belongs to the same authenticated user, `status === "done"`, its `outputJson.videoUrl` canonicalizes (`canonicalRenderUrl`) to a URL with a `ChargedClip` row for this user, AND the incoming `shortVideoConfig.durationInFrames` equals the source preview config's `durationInFrames`. When valid: skip `reserveClipUsage`/minute reservation entirely, then `recordChargedClip(userId, newOutputUrl, 0)` so the subsequent burn of the new base is free too. When invalid: **fall through to normal charging** (never an error — a lying client just pays normally). Cap: 10 accepted `rerenderOf` renders per user per hour (in-process window, mirror `tryConsumeKieImageRate`).

Orchestrator branch (`input.mode === "broll-rerender"`, placed beside the `"upload"` branch at ~line 192):
1. Load source `VideoJob` (owner check), parse `outputJson`; require `preview.config.bgVideos`. Fail the job with a Thai error message if missing.
2. `mergeWindowEdits(bgVideos, input.windowEdits)` → new `baseConfig = { ...preview.config, bgVideos: merged, keywordPopups: [] }`.
3. `step("render", 40)` → `caller.post("/api/videos/render", { shortVideoConfig: baseConfig, fps: RENDER_FPS, jpegQuality: RENDER_JPEG_QUALITY, rerenderOf: { sourceJobId } })` → `pollRender`.
4. If source preview has an avatar (`avatarModel && avatarModel !== "none" && avatarVideoUrl`): `step("avatar", 80)` → `caller.post("/api/heygen/composite", ...)` exactly like `AvatarAdjustOverlay.apply()` does (mode `chromakey`, `bgVideoUrl` = new base URL, reuse `avatarVideoUrl`/`tailAvatarUrl`/`avatarMode`/`avatarIntroSecs`/`avatarTailSecs`; load the avatar layout from the same preset store AvatarAdjustOverlay reads). New `compositeBaseUrl` = the pre-composite base.
5. `finishJob` preview-mode payload = source `preview` **copied** with: `config` = new baseConfig, `videoUrl` = final URL, `compositeBaseUrl` updated. Captions/voiceUrl/words/audioDurationMs copied unchanged (subtitle invariant).

- [ ] **Step 1: Write failing verify script** for `validateWindowEdits` + `mergeWindowEdits` (valid merge keeps start/end; bad src rejected — external URL, path traversal, non-mp4; out-of-range index rejected; dedupe last-wins; >40 edits rejected).
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement `broll-rerender.ts`** → verify script PASS.
- [ ] **Step 4: Implement jobs-route mode + orchestrator branch + render-route `rerenderOf`** per spec. In `jobs/route.ts`, the `broll-rerender` mode SKIPS the API-key guards and clip-quota reserve (nothing new is fetched or charged) but KEEPS auth, the in-flight cap of 3, and idempotency. The render-route change must be surgical: one guarded block around the existing reservation call + one `recordChargedClip` call — read the existing reservation/refund flow (~lines 296-450, 845-930) first so refund-on-fail paths stay correct (a skipped reservation must also skip refund).
- [ ] **Step 5: Build-verify + full verify suite** (`npm run build && npx tsx scripts/verify-broll-rerender.ts && npx tsx scripts/verify-clip-charge.ts`) — the existing clip-charge script must still pass.
- [ ] **Step 6: Commit** — `feat(broll-window): broll-rerender job mode with server-trusted free re-render`.
- **Security gate: `/security-review` at review time** (charge bypass surface — the review must specifically attack `rerenderOf`).

### Task 11: Window Inspector UI + batched update flow (progressive disclosure)

**Files:**
- Create: `src/app/(dashboard)/video-editor/_v2/BrollWindowInspector.tsx`
- Modify: `src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts` (window-edit state)
- Modify: `src/app/(dashboard)/video-editor/_v2/PostPhase.tsx` + `PostPhaseMobile.tsx` (mount inspector, update bar)
- Modify: `src/app/(dashboard)/video-editor/_v2/TimelinePanel.tsx` (edited-window badge)

**Interfaces:**
- Consumes: `brollWindowSpans` (Task 6), endpoints (Tasks 7–9), `buildKieImagePrompt` (Task 2 — client-safe import for prompt prefill), `useV2Job`'s job state, jobs POST mode `broll-rerender` (Task 10).
- `usePostPhaseEditor` additions:
```ts
windowEdits: Map<number, { src: string; keyword?: string; kind: "stock" | "upload" | "ai"; label: string }>;
setWindowEdit(index: number, edit: ...): void; clearWindowEdit(index: number): void;
selectedWindow: number | null; setSelectedWindow(i: number | null): void;
applyWindowEdits(): Promise<void>; // POST jobs {mode:"broll-rerender", sourceJobId: job.id, windowEdits: [...]} → poll GET /api/videos/jobs/[newId] → on done: swap job output in place (same pattern the avatar adjuster uses to refresh videoUrl) and clear windowEdits
applyingWindows: { progress: number } | null;
```

UI spec (Thai copy included — workers must not invent copy):
- Click b-roll span (Task 6 callback) → inspector opens: **desktop** = right side panel (same shell style as the caption style panel); **mobile (`lg` breakpoint)** = bottom sheet (same pattern PostPhaseMobile uses for its panels). Video seeks to window start (existing jump behavior).
- Header: `บีโรลช่วงที่ {n}` + time range `0:04 – 0:08` + current source badge (`สต็อก`/`อัปโหลด`/`AI`).
- 3 tabs (segmented control, house violet):
  1. **`เปลี่ยนรูป`** — keyword input prefilled with the window's `keyword`, ปุ่ม `ค้นหา` → 2-col thumbnail grid (video thumbs, provider badge) → tap = choose (calls select endpoint, shows spinner `กำลังเตรียมคลิป…`, then marks the window edited). Empty state: `ไม่พบคลิปที่ตรง ลองเปลี่ยนคำค้น หรือใช้แท็บ AI`.
  2. **`อัปโหลด`** — dropzone `แตะเพื่อเลือกไฟล์ (รูปภาพหรือวิดีโอ)` + caption `รูปภาพจะถูกทำเป็นคลิปเคลื่อนไหวอัตโนมัติ` → POST upload → edited.
  3. **`AI Gen`** — **simple mode (default)**: textarea label `บรรยายภาพที่อยากได้` placeholder `เช่น ร้านกาแฟไทยตอนเช้า มีคนกำลังชงกาแฟ` (Thai input goes straight into `buildKieImagePrompt(<thai text>, { region, style, terms: null })` as subject — gpt-image-2 handles Thai subjects); model picker chips showing credit price from `creditCostFor` (`Flux · 2 เครดิต` / `GPT · 3 เครดิต` / `Nano · 4 เครดิต`); generate button shows price: `สร้างภาพ (ใช้ 3 เครดิต)`. **`ขั้นสูง` toggle** reveals the full composed English prompt in an editable textarea (edits override the composed prompt verbatim). On 402 → toast `เครดิตไม่พอ — ต้องใช้ {need} เครดิต (มี {balance})` + link `/pricing`. On success → preview image/clip + edited.
- Region/style for the prompt prefill: read from the project draft (`useV2Project` fields `brollRegionPreference`/`brollVisualStyle`).
- Edited windows: violet dot badge on the timeline span + row in a summary list inside the inspector footer; each has `เลิกแก้` (clearWindowEdit).
- Sticky action bar (appears when `windowEdits.size > 0`): `อัปเดตวิดีโอ ({n} จุด) — ฟรี ไม่ใช้นาทีเพิ่ม` → `applyWindowEdits()`; progress state reuses the existing render-progress UI pattern; on done toast `อัปเดตวิดีโอแล้ว`. Burn/export stays untouched (user burns after, as today).
- Everything behind `NEXT_PUBLIC_BROLL_WINDOW_EDIT === "1"`; flag off renders nothing new.

- [ ] **Step 1: State additions in `usePostPhaseEditor`** (pure state + `applyWindowEdits` wiring).
- [ ] **Step 2: Build `BrollWindowInspector`** per spec (one responsive component; bottom-sheet vs panel by `lg`).
- [ ] **Step 3: Mount in PostPhase + PostPhaseMobile; timeline badge.**
- [ ] **Step 4: Build-verify + lint.** `npm run build` clean; flag-off snapshot: with the env unset, `/video-editor` renders identically (manually verify no new UI).
- [ ] **Step 5: Manual E2E on dev** (flag on): full loop — click window → swap stock → upload image → AI gen → `อัปเดตวิดีโอ` → new preview video shows all three changes; captions unchanged; burn works.
- [ ] **Step 6: Commit** — `feat(editor-v2): per-window b-roll inspector + batched free re-render`.

### Task 12: Phase 2 gate — reviews, flag, PR

- [ ] **Step 1: Full suite**: `npm run build && npx tsx scripts/verify-broll-spans.ts && npx tsx scripts/verify-broll-rerender.ts && npx tsx scripts/verify-clip-charge.ts && npx tsx scripts/verify-kie-image-prompt.ts && npx tsx scripts/verify-broll-preferences.ts` — all pass.
- [ ] **Step 2: Tier-1 review** (mew-reviewer) on the Phase 2 diff + **`/security-review`** covering Tasks 8, 9, 10 (upload, credit spend, charge-skip).
- [ ] **Step 3: PR 2** into main. Deploy with flag unset first (dark), then set `NEXT_PUBLIC_BROLL_WINDOW_EDIT=1` + rebuild when Mew says go (rollback = remove the env line + rebuild, same pattern as editor v2 launch).
- [ ] **Step 4: Mew prod QA** per Acceptance Criteria (swap 1 + upload 1 + AI 1 in one clip).

---

## Execution Directive

| # | Task | Agent | Mode | Review gates |
|---|------|-------|------|--------------|
| 1 | broll-preferences avoid/degrade/truncation | mew-worker | subagent | verify script, code review |
| 2 | kie prompt style/region rewrite | mew-worker | subagent | verify script, code review |
| 3 | fetch-stock wiring (kie + rankers) | mew-worker | subagent | build, grep asserts, code review |
| 4 | Phase 1 review gate + PR 1 | mew-reviewer | subagent | build+verify, Tier-2 session review |
| 5 | extract kie/asset helpers to libs | mew-worker | subagent | build, zero-logic-diff check, code review |
| 6 | timeline spans from bgVideos + click | mew-worker | subagent | verify script, build, code review |
| 7 | stock search/select endpoints | mew-worker | subagent | build, smoke, code review |
| 8 | upload endpoint | mew-worker-heavy | subagent | build, smoke, code review, **security-review** |
| 9 | AI-gen endpoint (credits) | mew-worker-heavy | subagent | build, smoke, code review, **security-review** |
| 10 | broll-rerender job mode + charge-skip | mew-worker-heavy | subagent | verify scripts (incl. verify-clip-charge), build, code review, **security-review** |
| 11 | inspector UI + batched update | mew-worker | subagent | build, flag-off identical, manual E2E, code review |
| 12 | Phase 2 gate + PR 2 | mew-reviewer | subagent | full suite, Tier-2 session review |

## Acceptance Criteria

**Phase 1**
- [ ] `buildKieImagePrompt` emits an explicit region clause near the prompt head when region set; style changes opener+look (verify script passes).
- [ ] All region scopes carry opposite-region avoid terms; thai degrades to asian fallbacks, never western (verify script passes).
- [ ] Vision re-rank + LLM ranker prompts carry the preference instruction when set (grep asserts + build).
- [ ] Truncation can no longer drop the preference suffix (verify script passes).
- [ ] Mew prod QA: Thai-scope clip → AI images Asian/Thai; European-scope clip → no Asian leak; Surreal style → visibly non-stock. (Final arbiter.)

**Phase 2**
- [ ] Post phase: clicking a b-roll window on the timeline opens an inspector showing the current asset + 3 sources (stock swap / upload / AI gen). 
- [ ] Stock swap: grid of new options, keyword editable, selection replaces that window only.
- [ ] Upload: image → Ken Burns clip; video → 9:16 crop+normalize; applied to that window only.
- [ ] AI gen: system-prepared prompt visible in simple Thai UI, full English prompt editable behind "ขั้นสูง"; charge shown before generate; correct credit spend + refund-on-fail.
- [ ] Multiple window edits batch into one "อัปเดตวิดีโอ" → base re-render reusing TTS/avatar, **zero render minutes charged**; captions/subtitle edits survive.
- [ ] Mobile (`lg` breakpoint) usable; no regression to caption editing.
- [ ] Mew prod QA: in one clip — swap 1 Western-looking window, upload 1 own image, AI-gen 1 window; final video correct.

## Status
interviewed 2026-07-07 | approved: 2026-07-07 | executed: in-progress 2026-07-07 | delivered: -
