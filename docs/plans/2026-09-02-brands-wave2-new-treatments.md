# Brands Wave 2 — Five new Treatment Presets and pack activation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `คดีดัง / เรื่องเล่าดาร์ก`, `เจาะประเด็นการเมือง`, `ลึกลับ / ทฤษฎีสมคบคิด`, `นิทานธรรมะ` and `โมทิเวชันซีเนมาติก` become selectable Style Packs backed by qualified Treatment Presets.

**Architecture:** Add five presets to the closed Treatment Catalog (append-only, `v1.0.0`), teach every active Visual Format compiler their vocabulary, extend the Real-Person Depiction Boundary trigger to the two presets that need it, add de-identified benchmark fixtures, run the paid qualification matrix once after Mew's go, review strictly, record the disposition in an ADR, then flip the five packs from `pending-benchmark` to `active`.

**Tech Stack:** TypeScript catalog + compilers in `src/lib/brand-visual-system.ts`, fixtures JSON, `scripts/run-brand-treatment-benchmark-v1.ts` (RunPod Z-Image, ≈ ฿0.175/image), Gemini Content Preflight.

**Spec:** `docs/audits/2026-09-02-brands-review.md` §8 (packs 8–12) · ADR 0010 (qualification rule) · ADR 0015/0016 (boundaries) · ADR 0017/0018 (compiler rules) · ADR 0058 · research §1–§5, §7–§8.

## Global Constraints

- Blocked by wave 1 merged (catalog with `pending-benchmark` entries exists).
- Branch `mew/brands-wave2`; PR into `main`; CI green.
- Treatment recipes are append-only; existing preset versions and pins are untouched.
- Every new preset × 5 active formats × 3 scenes must render in the qualification run (75 images) before any pack flips to `active`; benchmark generations are internal cost, never customer credits (ADR 0010).
- Paid execution (the 75-image run) requires Mew's explicit go in that session; the run uses the existing two-part paid-execution lock of the runner.
- `political-commentary` and `dark-story-true-crime` compile the Real-Person Depiction Boundary (ADR 0016); `dharma-storytelling` must depict monks respectfully (adult, robed, no caricature) — encoded as a hard rule in the compiler, not left to the model.
- No hidden retry, no engine switch (ADR 0023). Customer copy Thai only.

---

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Catalog: 5 presets + related ids + schema counts | mew-worker | subagent | — | build+test, code review |
| 2 | Compilers: vocabulary per active format + boundary triggers | mew-worker-heavy | subagent | 1 | build+test, code review |
| 3 | Benchmark fixtures (5 × 3 scenes, de-identified) + matrix builder | mew-worker | subagent | 1 | build+test, code review |
| 4 | Paid qualification run (Mew go) + strict review report | mew-worker-heavy | subagent | 2, 3 | session final (visual review with Mew) |
| 5 | ADR 0060 disposition; flip packs to `active`; release notes | (session model) + mew-worker | inline + subagent | 4 | criteria check |

---

### Task 1: Catalog entries

**Files:**
- Modify: `src/lib/brand-treatment-catalog.ts:5-98`
- Modify: `src/lib/brand-treatment-benchmark.ts:51` (`fixtureSetSchema` length 8 → `TREATMENT_PRESET_IDS.length`)
- Modify: `scripts/verify-brand-treatment-catalog-v1.ts`, `scripts/verify-brand-treatment-ui-v1.ts` (`groups.all.length` 8 → 13), `src/lib/content-preflight.server.ts:723-728` (JSON schema enum derives from `TREATMENT_PRESET_IDS` — confirm, else update)
- Modify: `src/lib/style-pack-catalog.ts` (`StylePackTreatmentId` collapses to `TreatmentPresetId`)

- [ ] **Step 1: Failing test** — in `verify-brand-treatment-catalog-v1.ts`: `TREATMENT_PRESET_IDS.length === 13`; each new id has a Thai label; `relatedTreatmentPresetIds("thai-supernatural-horror")` includes `"mystery-unexplained"`; `createCatalogTreatmentPin("political-commentary","creator").version === "v1.0.0"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Append entries** (exact values):

```ts
{ id: "dark-story-true-crime", internalName: "Dark Story and True Crime", thaiLabel: "คดีดังและเรื่องเล่าดาร์ก", version: "v1.0.0",
  versions: [{ version: "v1.0.0", promptDirection: "grim true-crime retelling, desaturated archival stillness, dim high-contrast rooms and rain-wet streets, tense restraint" }],
  relatedPresetIds: ["investigative-news-crime", "mystery-unexplained"] },
{ id: "political-commentary", internalName: "Political Commentary", thaiLabel: "เจาะประเด็นการเมือง", version: "v1.0.0",
  versions: [{ version: "v1.0.0", promptDirection: "sober editorial current-affairs commentary, institutional settings, neutral cool documentary grade, wide deliberate frames" }],
  relatedPresetIds: ["investigative-news-crime", "expert-clarity"] },
{ id: "mystery-unexplained", internalName: "Mystery and Unexplained", thaiLabel: "ลึกลับและปริศนา", version: "v1.0.0",
  versions: [{ version: "v1.0.0", promptDirection: "gothic mystery of the unexplained, fog and lantern light, teal-and-amber low key, slow discovery" }],
  relatedPresetIds: ["thai-supernatural-horror", "dark-story-true-crime"] },
{ id: "dharma-storytelling", internalName: "Dharma Storytelling", thaiLabel: "นิทานธรรมะ", version: "v1.0.0",
  versions: [{ version: "v1.0.0", promptDirection: "reverent Buddhist parable, warm gold temple light, calm illustrated serenity, gentle moral clarity" }],
  relatedPresetIds: ["thai-history-period-storytelling", "thai-human-drama"] },
{ id: "stoic-motivation", internalName: "Stoic Motivation", thaiLabel: "โมทิเวชันซีเนมาติก", version: "v1.0.0",
  versions: [{ version: "v1.0.0", promptDirection: "contemplative cinematic motivation, vast dawn landscapes and lone figures, moody blue-gold, epic quiet scale" }],
  relatedPresetIds: ["thai-human-drama", "premium-product-lifestyle"] },
```

Also add `"mystery-unexplained"` to `thai-supernatural-horror.relatedPresetIds`, `"dharma-storytelling"` to `thai-history-period-storytelling`, `"political-commentary"` to `investigative-news-crime`, `"stoic-motivation"` to `thai-human-drama`.

- [ ] **Step 4:** `npx tsc --noEmit --pretty false` — every exhaustive `switch`/`Record` over `TreatmentPresetId` in `brand-visual-system.ts` now fails to compile; list those sites in the commit body for Task 2. Run `tsx scripts/verify-brand-treatment-catalog-v1.ts` → PASS. Commit `feat(treatment): five new presets (dark story, politics, mystery, dharma, motivation)` (tsc may still be red until Task 2 — note it; do not merge before Task 2).

---

### Task 2: Compilers + boundaries

**Files:**
- Modify: `src/lib/brand-visual-system.ts` — every per-preset mapping the Task-1 `tsc` run flagged (Simple Editorial Story translates treatments into format-safe mood/composition language per ADR 0017; Clear Infographic, Dramatic Comic, Retro Story and Cinematic Realism v10 each have their own translation table)
- Modify: `src/lib/scene-content-policy.ts` (the trigger set that adds the Real-Person Depiction Boundary clause for `investigative-news-crime` gains `political-commentary` and `dark-story-true-crime`)
- Test: `scripts/verify-brand-treatment-compiler-v1.ts` (extend), `scripts/verify-scene-content-policy.ts` (extend)

- [ ] **Step 1: Failing tests** — for each new preset × each active format, `compileBrandVisualPrompt` output contains that format's medium words and the preset's mood words, contains no hex code, no Thai glyphs (ADR 0007), and Hard Scene Facts precede art direction (ADR 0014). `political-commentary` and `dark-story-true-crime` prompts include the boundary clause used today for `investigative-news-crime`; `dharma-storytelling` prompts for a scene with a monk include `"an adult Thai Buddhist monk in saffron robes, depicted respectfully"`. Fixed strings per format/preset live in the test as the contract:

| preset | simple-editorial-story translation | clear-infographic translation |
|---|---|---|
| dark-story-true-crime | "muted grey-blue flat colors, dim room, tense stillness" | "dark slate background, red accent markers, evidence-board hierarchy" |
| political-commentary | "neutral cool flat colors, civic buildings, calm order" | "navy and white, institutional icons, balanced two-column comparison" |
| mystery-unexplained | "deep teal flat colors, fog shapes, lantern glow" | "dark teal background, question-mark silhouettes, spotlight focus" |
| dharma-storytelling | "warm gold and ochre flat colors, temple mural calm, soft rounded forms" | "warm cream background, lotus and bell pictograms, gentle sequence" |
| stoic-motivation | "dawn blue and gold flat colors, wide horizon, one small figure" | "midnight blue background, gold accent, single rising arrow" |

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the tables and the boundary trigger. **Step 4:** `tsx scripts/verify-brand-treatment-compiler-v1.ts && npm run verify:scene-content-policy && npm run verify:brand-treatment-v1 && npx tsc --noEmit --pretty false` → PASS; commit `feat(treatment): compile the five new presets in every active format; extend real-person boundary`.

---

### Task 3: Benchmark fixtures

**Files:**
- Modify: the fixtures JSON loaded by `loadBrandTreatmentBenchmarkFixtures` (`src/lib/brand-treatment-benchmark.ts:65-68` — path constant there) — add 5 fixtures, each 3 scenes (`opening`, `development`, `key`), de-identified (CONTEXT.md rule)
- Modify: `scripts/verify-brand-treatment-benchmark-v1.ts` (matrix = 13 × 5 × 3 = 195; focused wave-2 builder = 5 × 5 × 3 = 75)
- Modify: `scripts/run-brand-treatment-benchmark-v1.ts` (accepts `--treatments=a,b,c` to run the focused 75)

Fixture content (narrative pattern + Hard Scene Facts; write these exactly):

| preset | opening | development | key |
|---|---|---|---|
| dark-story-true-crime | a dim apartment corridor at night, one closed door, one adult Thai woman standing alone (count 1) | a rain-wet street at night, one parked car, police tape (no people) | an old photograph on a wooden table under a desk lamp, one hand (no face) |
| political-commentary | a government building exterior at dusk, national flag, no identifiable person | a crowd rally seen from behind at wide distance, placards blank, night (no faces) | a stack of documents and a ballot box on a table, daylight |
| mystery-unexplained | fog over a lake at dawn, one wooden boat (count 1) | an old hand-drawn map on a table under lantern light, night | a stone ruin in a forest with one lantern (count 1), night |
| dharma-storytelling | one adult Thai monk walking a village road at dawn (count 1) | a temple hall interior, candles and lotus offerings, morning | a rice field at sunrise with one farmer bowing (count 1) |
| stoic-motivation | one runner on a mountain road at sunrise, seen from behind (count 1) | storm clouds over the sea, no people | a city skyline at dawn from a rooftop, one standing figure silhouette (count 1) |

- [ ] **Step 1: Failing test** — matrix sizes; every new fixture's `key` scene carries at least one exact count; `political-commentary` fixtures contain no proper noun. **Step 2: Run** → FAIL. **Step 3:** write fixtures + builder flag. **Step 4:** `tsx scripts/verify-brand-treatment-benchmark-v1.ts` → PASS; commit `test(treatment): wave-2 qualification fixtures (75-image focused matrix)`.

---

### Task 4: Paid qualification run + strict review (Mew go)

- [ ] **Step 1:** Mew says go in-session; record the timestamp in Status.
- [ ] **Step 2:** `npm run benchmark:brand-treatment-v1 -- --treatments=dark-story-true-crime,political-commentary,mystery-unexplained,dharma-storytelling,stoic-motivation` with the runner's paid-execution lock; artifacts to `artifacts/brand-treatment-wave2-qualification/` (`manifest.json` + images).
- [ ] **Step 3:** strict review at original resolution, one row per case: hard facts preserved (count, entity type, time of day, setting), boundary respected (no identifiable real person; monk depicted respectfully), treatment recognisable, cross-scene coherence, incidental Thai lettering. Write `artifacts/brand-treatment-wave2-qualification/review.md` and a customer-safe summary `docs/audits/2026-09-XX-treatment-wave2-qualification.md`.
- [ ] **Step 4:** any preset with a hard-fact or boundary failure is fixed at the compiler (Task 2 tables) and only that preset's 15 cases are rerun — each rerun is a separate Mew go. No automatic retry.

---

### Task 5: Disposition + activation

- [ ] Write `docs/adr/0060-wave2-treatment-qualification-disposition.md` (which presets qualified on which formats; pragmatic acceptance per ADR 0023 wording where strict gate is not met; what remains fail-closed).
- [ ] Flip the qualified packs in `src/lib/style-pack-catalog.ts` to `status: "active"`; `verify-style-pack-catalog.ts` expectation 7 → N active; unqualified packs stay `pending-benchmark` with a comment naming the failing case ids.
- [ ] Add the new pack cards' sample images (same procedure as wave 1 Task 10, Mew go).
- [ ] `/updates` post draft (Thai) listing the newly available packs; update the map's "Decisions so far"; Status line.

---

## Acceptance Criteria

- [ ] 13 presets in the catalog; every compiler handles all 13; `tsc`, `verify:brand-treatment-v1`, `verify:style-pack-catalog` green.
- [ ] Real-Person Depiction Boundary compiles for `political-commentary` and `dark-story-true-crime`; monk rule compiles for `dharma-storytelling`.
- [ ] 75-image focused matrix delivered (manifest, distinct hashes, no retry, no engine switch) after Mew's go; strict review recorded.
- [ ] ADR 0060 written; only qualified packs are `active`; pickers never show a pending pack.
- [ ] No customer credit consumed by the benchmark; no existing pin or recipe changed.

## Out of scope

- Adding further presets (creepypasta, Thai prison stories) — next catalog iteration after telemetry.
- Character Identity Lock for recurring characters (ADR 0011).
- Any change to the Z-Image default or reroll pricing (ADR 0023).

## Status
interviewed 2026-09-02 | approved: pending (after wave 1) | executed: - | delivered: -
