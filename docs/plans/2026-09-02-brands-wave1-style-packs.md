# Brands Wave 1 — Style Packs (ชุดสไตล์), Stock Mood, Pacing, Music Mood

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator picks one ชุดสไตล์ on `/brands` (or per clip in the editor) and every B-roll source, subtitle default, pacing, music default and Hero Script tone of their clips follows it; the Step-2 stock-style menu disappears; the AI recommendation stops collapsing onto `expert-clarity`.

**Architecture:** A versioned catalog module (`style-pack-catalog.ts`) is the single definition of the 12 looks (7 `active`, 5 `pending-benchmark`). A pack is *applied* onto the existing Brand Profile payload (locked treatment + primary format + palette + subtitle + tone) so pinning, revisions and compilers are untouched (ADR 0058). The pack's Stock Mood rides the `broll-preferences` pipe fixed in wave 0 (ADR 0057). Pacing multiplies the existing B-roll window cadence. Music mood is an additive column on `Music`.

**Tech Stack:** Next.js 15, Prisma 6 / SQLite (additive `Music.mood`), Zod, React 19 (shadcn), `tsx` verify scripts, Gemini 2.5 Flash (Content Preflight).

**Spec:** `docs/audits/2026-09-02-brands-review.md` §6–§8 · ADR 0057, 0058 · `CONTEXT.md` (ชุดสไตล์, Stock Mood, Pacing, Music Mood, People & Place Preference) · research `docs/research/2026-09-02-faceless-short-video-style-trends.md` §Synthesis.

## Global Constraints

- Blocked by wave 0 merged (`docs/plans/2026-09-02-brands-wave0-make-it-work.md`) — this wave reuses `applyBrollPreferenceToSearchQuery(…, { role })`, `brollPreferenceCacheVariant`, the library/image guard split and the CI job.
- Branch `mew/brands-wave1` in an Orca worktree; PR into `main`; CI green.
- Customer copy: Thai only; pack names exactly as in §Catalog; never `Treatment`, `Preset`, `Pin`, `Trend Pack`, `Style Pack` (English) in UI.
- Schema: additive only — exactly one column this wave: `Music.mood String?`.
- Existing revisions/projects are never mutated by the catalog; a pack version is snapshotted into `visualRecipeJson` (ADR 0005).
- `pending-benchmark` packs are never selectable or recommended (ADR 0058).
- Stock Mood may never add people/props/places (region guardrails stay); no render may fail because of a mood.
- Pacing changes window cadence only; never subtitle timing (ADR 0056); Ken Burns stays env-gated (`STOCK_KEN_BURNS`, ~4× per-frame render cost — see memory `broll-quality-2-perf`).
- No hidden image retries / engine switches (ADR 0023).
- Paid generation (card sample images, Gemini distribution benchmark) only after Mew's explicit go, recorded in Status.

---

## Catalog (authoritative values — Task 1 encodes exactly these)

| id | thaiLabel | format × treatment | status | stockMood.queryToken | pacing | musicMood | subtitle preset / accent | palette (hex → words by compiler) |
|---|---|---|---|---|---|---|---|---|
| thai-ghost | หนังผีไทย | cinematic-realism × thai-supernatural-horror | active | `night` | normal | ominous | bold-shadow / #E11D48 | #0B0F1A #7C1D2B #C9A24C |
| thai-history | ประวัติศาสตร์ย้อนยุค | retro-story × thai-history-period-storytelling | active | `vintage` | normal | serious | retro / #D4A017 | #3B2A1A #C8A86B #F1E6D0 |
| life-drama | ดราม่าชีวิตจริง | cinematic-realism × thai-human-drama | active | `cinematic` | normal | emotional | shadow / #FDE68A | #1F2933 #B45309 #E7D8C4 |
| finance-clear | ธุรกิจ-การเงินชัดเจน | clear-infographic × expert-clarity | active | `clean` | fast | upbeat | box / #FACC15 | #0F172A #2563EB #F8FAFC |
| news-fast | ข่าวสรุปเร็ว | cinematic-realism × investigative-news-crime | active | `news` | fast | tense | news / #DC2626 | #111827 #DC2626 #E5E7EB |
| health-simple | สุขภาพเข้าใจง่าย | simple-editorial-story × expert-clarity | active | `healthy` | normal | calm | box-rounded / #34D399 | #ECFDF5 #10B981 #1F2937 |
| premium-product | โฆษณาสินค้าพรีเมียม | cinematic-realism × premium-product-lifestyle | active | `luxury` | slow | lounge | plain / #D4A017 | #111111 #D4A017 #F5F5F4 |
| dark-story | คดีดัง / เรื่องเล่าดาร์ก | cinematic-realism × dark-story-true-crime | pending-benchmark | `dark` | normal | ominous | bold-shadow / #B91C1C | #0A0A0A #6B7280 #B91C1C |
| politics | เจาะประเด็นการเมือง | cinematic-realism × political-commentary | pending-benchmark | `editorial` | normal | serious | news / #2563EB | #1E293B #2563EB #F1F5F9 |
| mystery | ลึกลับ / ทฤษฎีสมคบคิด | cinematic-realism × mystery-unexplained | pending-benchmark | `mysterious` | slow | eerie | glow / #14B8A6 | #061A1F #14B8A6 #C89B3C |
| dharma | นิทานธรรมะ | simple-editorial-story × dharma-storytelling | pending-benchmark | `temple` | slow | traditional | plain (centered) / #D4A017 | #7C2D12 #D4A017 #FFF7E6 |
| motivation | โมทิเวชันซีเนมาติก | cinematic-realism × stoic-motivation | pending-benchmark | `cinematic` | slow | epic | bold-shadow / #FFFFFF | #0B1B2B #1D4ED8 #E0B04A |

Treatment ids `dark-story-true-crime`, `political-commentary`, `mystery-unexplained`, `dharma-storytelling`, `stoic-motivation` are created in wave 2; in this wave the catalog references them through a string union that is a **superset** of `TreatmentPresetId` (see Task 1) so `pending-benchmark` entries type-check without existing in the treatment catalog yet.

---

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Catalog module + pure helpers + verify | mew-worker | subagent | — | build+test, code review |
| 2 | Payload/seed/publish: `stylePackId`+`stylePackVersion`, `applyStylePackToPayload`, recipe snapshot | mew-worker-heavy | subagent | 1 | build+test, code review |
| 3 | `/brands` UI: StylePackPicker default surface; two axes under "กำหนดเอง" | mew-worker | subagent | 2 | build+test, code review |
| 4 | Stock Mood pipe: pack → orchestrator → keywords/stock/per-window; remove Step-2 style menu | mew-worker-heavy | subagent | 2 | build+test, code review |
| 5 | Pacing → window cadence + minHold | mew-worker | subagent | 2 | build+test, code review |
| 6 | Music mood: `Music.mood`, admin field, default track | mew-worker | subagent | 1 | build+test, code review, security-review (admin write) |
| 7 | Editor: pack summary, "เปลี่ยนเฉพาะคลิปนี้" picker as Project Look, promote keeps pack | mew-worker-heavy | subagent | 3, 4 | build+test, code review |
| 8 | Recommendation rebalance + `suggestedStylePackId` + distribution benchmark (paid text, Mew go) | mew-worker-heavy | subagent | 1 | build+test, code review, session final |
| 9 | Telemetry: `style_pack_selected`, pack on first-pass events, admin funnel | mew-worker | subagent | 2, 7 | build+test, code review |
| 10 | Card sample images (12) — internal generation (Mew go) + gradient fallback | mew-worker | subagent | 3 | session final (visual) |
| 11 | Final gate, `/updates` post draft, plan status | (session model) | inline | 1–10 | criteria check |

Frontier at start: 1, 6. Then 2, 8 (after 1). Then 3, 4, 5 (after 2). Then 7 (after 3, 4), 9, 10.

---

### Task 1: Catalog module

**Files:**
- Create: `src/lib/style-pack-catalog.ts`
- Test: `scripts/verify-style-pack-catalog.ts`; `package.json` script `verify:style-pack-catalog`

**Interfaces (Produces):**

```ts
import type { ActiveVisualFormatId } from "@/lib/brand-visual-system";
import type { TreatmentPresetId } from "@/lib/brand-treatment-catalog";
import type { SubtitleStylePresetConfig } from "@/lib/editor-style-preset-contract";

export const STYLE_PACK_IDS = ["thai-ghost","thai-history","life-drama","finance-clear","news-fast","health-simple","premium-product","dark-story","politics","mystery","dharma","motivation"] as const;
export type StylePackId = (typeof STYLE_PACK_IDS)[number];
export type StylePackStatus = "active" | "pending-benchmark";
export type PacingLevel = "slow" | "normal" | "fast";
export const MUSIC_MOODS = ["ominous","tense","emotional","upbeat","calm","epic","serious","lounge","traditional","eerie"] as const;
export type MusicMood = (typeof MUSIC_MOODS)[number];
/** Treatment ids the catalog may reference; wave 2 adds the last five to TreatmentPresetId. */
export type StylePackTreatmentId = TreatmentPresetId | "dark-story-true-crime" | "political-commentary" | "mystery-unexplained" | "dharma-storytelling" | "stoic-motivation";
export type StockMood = {
  queryToken: string;          // ONE lowercase English token appended to primary stock queries
  positive: string[];          // 8–10 filmable nouns/settings the ranker should prefer
  avoid: string[];             // 4–6 concepts to down-rank
  direction: string;           // ≤ 20 English words: mood/tone, lighting, color, energy
  fallbackQueries: string[];   // 5 plain 2–4 word Pexels phrases
};
export type StylePack = {
  id: StylePackId; version: "v1.0.0"; status: StylePackStatus;
  thaiLabel: string; tagline: string;                      // tagline ≤ 40 Thai chars, shown on the card
  visualFormatId: ActiveVisualFormatId; treatmentPresetId: StylePackTreatmentId;
  palette: [string, string, string]; personality: string;   // personality: Thai, ≤ 60 chars, feeds visual.personality
  stockMood: StockMood; pacing: PacingLevel; musicMood: MusicMood;
  subtitle: SubtitleStylePresetConfig; scriptTone: string;  // scriptTone: Thai, feeds script.tone
};
export const STYLE_PACKS: readonly StylePack[];
export function stylePack(id: StylePackId): StylePack;
export function activeStylePacks(): readonly StylePack[];          // status === "active"
export function isStylePackId(value: unknown): value is StylePackId;
export function stylePackForTreatment(treatmentPresetId: string): StylePack | null; // first ACTIVE pack with that treatment
export const PACING_CADENCE_MULTIPLIER: Record<PacingLevel, number>; // slow 1.6, normal 1, fast 0.7
export const PACING_MIN_HOLD_SEC: Record<PacingLevel, number>;       // slow 6, normal 4, fast 2.5
```

- [ ] **Step 1: Failing verify**

```ts
// scripts/verify-style-pack-catalog.ts
import assert from "node:assert/strict";
const cat = await import("../src/lib/style-pack-catalog");
const { TREATMENT_PRESET_IDS } = await import("../src/lib/brand-treatment-catalog");
const { VISUAL_FORMAT_IDS } = await import("../src/lib/brand-visual-system");
const { normalizeSubtitleStylePresetConfig } = await import("../src/lib/editor-style-preset-contract");
assert.equal(cat.STYLE_PACKS.length, 12);
assert.equal(cat.activeStylePacks().length, 7);
for (const pack of cat.STYLE_PACKS) {
  assert.ok(/[฀-๿]/u.test(pack.thaiLabel));
  assert.ok(VISUAL_FORMAT_IDS.includes(pack.visualFormatId));
  if (pack.status === "active") assert.ok((TREATMENT_PRESET_IDS as readonly string[]).includes(pack.treatmentPresetId), `${pack.id} active pack must use a qualified treatment`);
  assert.match(pack.stockMood.queryToken, /^[a-z]+$/);
  assert.ok(pack.stockMood.positive.length >= 8 && pack.stockMood.avoid.length >= 4 && pack.stockMood.fallbackQueries.length === 5);
  assert.ok(pack.stockMood.direction.split(/\s+/).length <= 20);
  assert.ok(pack.palette.every((hex) => /^#[0-9A-F]{6}$/.test(hex)));
  assert.deepEqual(normalizeSubtitleStylePresetConfig(pack.subtitle), pack.subtitle, `${pack.id} subtitle must satisfy the preset contract`);
}
assert.equal(cat.stylePackForTreatment("thai-supernatural-horror")?.id, "thai-ghost");
assert.equal(cat.stylePackForTreatment("dharma-storytelling"), null, "pending packs are never recommended");
assert.deepEqual(cat.PACING_CADENCE_MULTIPLIER, { slow: 1.6, normal: 1, fast: 0.7 });
console.log("verify-style-pack-catalog: ok");
```

- [ ] **Step 2: Run** — `tsx scripts/verify-style-pack-catalog.ts` → FAIL (module missing).

- [ ] **Step 3: Write the module** — encode the §Catalog table. Full entry for the first pack (the other eleven follow the same shape with the values from the table and the audit §8 mood lists):

```ts
{
  id: "thai-ghost", version: "v1.0.0", status: "active",
  thaiLabel: "หนังผีไทย", tagline: "มืด หลอน ค่อย ๆ กดดัน เหมือนหนังผีไทย",
  visualFormatId: "cinematic-realism", treatmentPresetId: "thai-supernatural-horror",
  palette: ["#0B0F1A", "#7C1D2B", "#C9A24C"], personality: "มืด เย็น หลอน แสงน้อย เงาเข้ม",
  stockMood: {
    queryToken: "night",
    positive: ["night", "moonlight", "abandoned house", "candle light", "fog", "shadow", "old temple", "forest at night", "rain at night", "flickering light"],
    avoid: ["bright daylight", "office", "smiling people", "product", "city skyline", "cartoon"],
    direction: "eerie nocturnal Thai horror, dim moonlight and candle glow, desaturated cold tones, slow dread",
    fallbackQueries: ["dark forest night", "old wooden house night", "candle in dark room", "fog at night", "empty corridor dim light"],
  },
  pacing: "normal", musicMood: "ominous",
  subtitle: { preset: "bold-shadow", effect: "fade", cardLen: "3", fontFamily: "Kanit", bold: true, fontWeight: 800, fontSize: 64, textColor: "#FFFFFF", accentColor: "#E11D48", shadow: true, outline: false, outlineSize: 2, verticalPos: 78 },
  scriptTone: "เล่าช้า ๆ สร้างความกดดันทีละนิด ใช้รายละเอียดที่รู้สึกได้ ไม่เฉลยเร็ว",
},
```

Subtitle values for the rest: thai-history `retro/fade/4/Sarabun/700/60/#F5E6C8/#D4A017/shadow/78`; life-drama `shadow/fade/4/Kanit/700/60/#FFFFFF/#FDE68A/shadow/78`; finance-clear `box/pop/3/Kanit/800/64/#FFFFFF/#FACC15/no-shadow/76`; news-fast `news/quick/2/Kanit/900/68/#FFFFFF/#DC2626/no-shadow/76`; health-simple `box-rounded/pop/3/Prompt/700/60/#FFFFFF/#34D399/no-shadow/78`; premium-product `plain/fade/sentence/Prompt/bold:false 500/52/#FFFFFF/#D4A017/shadow/80`; dark-story `bold-shadow/quick/2/Kanit/900/66/#FFFFFF/#B91C1C/shadow/78`; politics `news/quick/3/Sarabun/800/62/#FFFFFF/#2563EB/no-shadow/76`; mystery `glow/fade/3/Kanit/700/62/#E5E7EB/#14B8A6/shadow/78`; dharma `plain/fade/sentence/Sarabun/700/58/#FFF7E6/#D4A017/shadow/50`; motivation `bold-shadow/fade/4/Kanit/900/64/#FFFFFF/#FFFFFF/shadow/78`. `outline: false, outlineSize: 2` everywhere. Mood word lists: take the "ต้องการ / เลี่ยง" columns of audit §8, extend to ≥ 8 positive / ≥ 4 avoid, and write 5 plain fallback phrases per pack.

- [ ] **Step 4: Verify + commit** — `tsx scripts/verify-style-pack-catalog.ts` → PASS; add the npm script; `git commit -m "feat(brands): style pack catalog (12 packs, 7 active)"`.

---

### Task 2: Pack on the Brand Profile payload

**Files:**
- Modify: `src/lib/brand-profile-library.server.ts:47-125` (payload schema), `:600-620` and `:880-905` (publish → `revisionRecipe`), `:225-256` (`applyBrandRevisionDefaultsToProjectDraft`)
- Modify: `src/lib/brand-profile-seed.ts` (blank seed gains `visual.stylePackId: null, stylePackVersion: null`)
- Create: `src/lib/style-pack-apply.ts`
- Test: `scripts/verify-style-pack-apply.ts`; extend `scripts/verify-brand-profile-library.ts`

**Interfaces (Produces):**

```ts
// style-pack-apply.ts
export function applyStylePackToPayload(payload: BrandProfilePayload, pack: StylePack): BrandProfilePayload;
// sets visual.stylePackId/stylePackVersion, visual.primaryVisualFormatId = pack.visualFormatId,
// visual.treatmentPolicy = "locked", visual.lockedTreatmentPresetId = pack.treatmentPresetId,
// visual.palette = pack.palette, visual.personality = pack.personality,
// subtitle.config = pack.subtitle ONLY when subtitle.presetId is null,
// script.tone = pack.scriptTone ONLY when script.tone equals the blank-seed default.
export function clearStylePack(payload: BrandProfilePayload): BrandProfilePayload; // stylePackId/version → null, keeps the resolved fields
export function stylePackOfPayload(payload: BrandProfilePayload): StylePack | null;
// Revision recipe snapshot (revisionRecipe) gains: { stylePack: { id, version, stockMood, pacing, musicMood } | null }
```

- [ ] **Step 1: Failing test** — `verify-style-pack-apply.ts`: blank seed + `applyStylePackToPayload(seed, stylePack("thai-ghost"))` → `treatmentPolicy === "locked"`, `lockedTreatmentPresetId === "thai-supernatural-horror"`, `subtitle.config.preset === "bold-shadow"`, `script.tone` equals the pack tone; a payload with `subtitle.presetId = "mine"` keeps its own subtitle; a payload with a custom tone keeps it; `applyStylePackToPayload(seed, stylePack("dharma"))` throws `"Style Pack not available"` (pending). In `verify-brand-profile-library.ts`: publishing a payload with `stylePackId: "thai-ghost"` produces a revision whose `visualRecipeJson` contains `stylePack.id === "thai-ghost"` and `stylePack.stockMood.queryToken === "night"`; a payload with `stylePackId: "dharma"` is rejected at the Zod boundary.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — Zod: `stylePackId: z.enum(STYLE_PACK_IDS).nullable().default(null).refine(id => id === null || stylePack(id).status === "active", "Style Pack not available")`, `stylePackVersion: z.literal("v1.0.0").nullable().default(null)`. `revisionRecipe(payload)` adds the `stylePack` snapshot. `applyBrandRevisionDefaultsToProjectDraft` additionally writes `draft.pacing = recipe.stylePack?.pacing ?? "normal"` and `draft.musicMoodDefault = recipe.stylePack?.musicMood ?? null` (draft type extended in `editor-default-draft.ts` with those two optional fields).
- [ ] **Step 4: Verify + commit** — both scripts PASS; `git commit -m "feat(brands): style pack applies onto the Brand Profile payload and revision recipe"`.

---

### Task 3: `/brands` default surface = name + StylePackPicker

**Files:**
- Create: `src/app/(dashboard)/brands/_components/StylePackPicker.tsx`
- Modify: `BrandLibraryClient.tsx:805-830` (default surface), `AdvancedSettings.tsx:532-598` (wrap format picker + policy + locked preset + palette + personality into a `กำหนดเอง` section that is collapsed while a pack is selected)
- Modify: `src/app/api/brand-library/route.ts` (return `stylePacks: activeStylePacks().map(p => ({ id, thaiLabel, tagline, palette, visualFormatId, sampleImage: `/style-packs/${id}.jpg` }))`)
- Test: extend `scripts/verify-brands-mobile.mjs` and `scripts/verify-brand-library-support-features.ts`

**Interfaces:**

```tsx
export function StylePackPicker(props: {
  packs: Array<{ id: StylePackId; thaiLabel: string; tagline: string; palette: [string,string,string]; sampleImage: string }>;
  value: StylePackId | null;
  onChange: (id: StylePackId | null) => void;   // null = "กำหนดเอง"
  disabled?: boolean;
}): JSX.Element;
```

Card grid: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`, each card `<button role="radio" aria-checked>` with the sample image (falls back to a CSS gradient from `palette` when the image 404s via `onError`), `thaiLabel` bold, `tagline` muted; a final card `กำหนดเอง` (icon `SlidersHorizontal`) selects `null` and expands the advanced section. Heading `สไตล์ประจำแบรนด์`, sub `ทุกคลิปของแบรนด์นี้จะใช้สไตล์เดียวกัน เปลี่ยนทีหลังได้`.

- [ ] **Step 1: Failing assertions** — `verify-brand-library-support-features.ts`: source of `StylePackPicker.tsx` contains `role="radio"` and `กำหนดเอง`; `BrandLibraryClient.tsx` renders `<StylePackPicker` before `<AdvancedSettings`. `verify-brands-mobile.mjs`: at 320 px the picker has no horizontal overflow (reuse its existing DOM harness).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — in `BrandLibraryClient`, `onChange(id)` calls `setDraft(id ? applyStylePackToPayload(draft, stylePack(id)) : clearStylePack(draft))`; `VisualFormatPicker` moves into the `กำหนดเอง` section; when a pack is selected the section header shows `ใช้ค่าจากชุดสไตล์ · แก้เองได้ในกำหนดเอง`. Editing any custom field while a pack is selected calls `clearStylePack` (the look becomes custom — never silently half-pack).
- [ ] **Step 4: Verify + commit** — `npm run verify:brands-ci && npx tsc --noEmit --pretty false` → PASS; `git commit -m "feat(brands): one-tap style pack picker as the default surface"`.

---

### Task 4: Stock Mood pipe + remove the Step-2 style menu

**Files:**
- Modify: `src/lib/broll-preferences.ts` (`BrollPreferenceInput` gains `stockMood?: StockMood | null`)
- Modify: `src/lib/mcp/orchestrator-steps.ts:28-77` (`buildKeywordPayload`/`buildStockPayload` carry `stockMood`), `src/lib/mcp/orchestrator.ts` (resolve the pack from the project's pinned visual context before the keyword step; both the upload path and the script path)
- Modify: `src/app/api/videos/extract-keywords/route.ts`, `fetch-stock/route.ts`, `broll-window/search/route.ts` (accept `stockMood` in body, pass into `BrollPreferenceInput`)
- Modify: `src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx:501-518` (remove the style `Segmented`; show `สไตล์ฟุตเทจ: <pack.thaiLabel> · จากแบรนด์` or `ตามเนื้อหา` when no pack), `useV2Job.ts:435-438,471-474` (stop sending `brollVisualStyle`)
- Test: extend `scripts/verify-broll-preferences.ts`; `scripts/verify-orchestrator-steps.ts` (exists? else create minimal)

**Interfaces (Produces):**

```ts
// broll-preferences.ts
export type BrollPreferenceInput = { brollRegionPreference?: …; brollVisualStyle?: …; stockMood?: StockMood | null };
// collectPreferenceHints: when stockMood is present it REPLACES the legacy style hint (positive/avoid/instruction/fallback from the mood),
// applyBrollPreferenceToSearchQuery: mood.queryToken is appended to PRIMARY queries exactly like STYLE_QUERY_TOKENS; legacy style is ignored when a mood exists,
// brollPreferenceCacheVariant: "m=<packId>" replaces "s=<style>" when a mood exists,
// appendBrollPreferenceToDirection: mood.direction is appended (same 320-char budget).
export function stockMoodForProject(input: { projectVisualContextJson: string | null; brandRevisionRecipeJson: string | null }): (StockMood & { packId: StylePackId }) | null;
```

- [ ] **Step 1: Failing tests** — `applyBrollPreferenceToSearchQuery("old house", { stockMood: stylePack("thai-ghost").stockMood }, { role: "primary" }) === "old house night"`; `brollPreferenceCacheVariant({ stockMood, brollRegionPreference: "thai" }) === "r=thai;m=thai-ghost"` (mood carries `packId` — extend `StockMood` with `packId` at the pipe boundary); fallback role leaves the query untouched; `stockMoodForProject` returns the pack's mood from a project visual context that pins `thai-ghost`, `null` for a custom (no-pack) revision.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — orchestrator: right before the keyword step resolve `const stockMood = stockMoodForProject({ projectVisualContextJson: job.projectVisualContextJson, brandRevisionRecipeJson })` (the recipe is loaded where `pinnedBrandVisualWindows` is computed, `orchestrator.ts:2314`); pass it in both payload builders. Routes: `stockMood` in the request body is validated with a Zod schema mirroring `StockMood` (max lengths: token 24, 12 positives, 8 avoids, direction 160, 5 fallbacks) — never trusted raw. Step 2 UI: delete the style `Segmented`; keep the region control; add the read-only line. `useV2Job`: stop sending `brollVisualStyle`; keep accepting it server-side for old drafts (normalize → ignored when a mood exists).
- [ ] **Step 4: Verify + commit** — `npm run verify:broll-preferences && npm run verify:broll-window-management && npx tsc --noEmit --pretty false` → PASS; `git commit -m "feat(broll): stock mood from the pinned style pack drives stock search; remove Step-2 style menu (ADR 0057)"`.

---

### Task 5: Pacing

**Files:**
- Modify: `src/lib/broll-windows.ts:18` (`buildBrollWindows` gains `options?: { cadenceMultiplier?: number }`), `src/lib/broll-even-split.ts:72` (`targetCadenceSec(durationSec, multiplier = 1)`)
- Modify: `src/lib/mcp/orchestrator.ts` (read `pacing` from the pinned recipe via a new `pacingForProject(...)` next to `stockMoodForProject`; pass `cadenceMultiplier = PACING_CADENCE_MULTIPLIER[pacing]` to window building and `minHoldSec = PACING_MIN_HOLD_SEC[pacing]` where the editor currently sends `minHoldSec` for AI-gen / auto-mix pools — `generate-config/route.ts:378-383`)
- Test: extend `scripts/verify-broll-windows.ts` and `scripts/verify-broll-cadence.ts`

- [ ] **Step 1: Failing tests** — for a 60 s narration, windows built with multiplier 1.6 are fewer than with 1, and with 0.7 are more; no window shorter than 2 s or longer than 10 s at any multiplier; `targetCadenceSec(60, 0.7) < targetCadenceSec(60) < targetCadenceSec(60, 1.6)`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with clamps `[2, 10]` s. **Step 4:** `npm run verify:broll-windows && npm run verify:broll-cadence` → PASS; `git commit -m "feat(broll): style pack pacing scales window cadence and min-hold"`.

---

### Task 6: Music mood

**Files:**
- Modify: `prisma/schema.prisma` `Music` → add `mood String?` ; `npx prisma migrate dev --name music_mood` (additive)
- Modify: `src/app/api/admin/music/route.ts`, `[id]/route.ts` (accept `mood` ∈ `MUSIC_MOODS`), admin music UI (find with `grep -rn "api/admin/music" src/app`), `src/app/api/music/route.ts` (return `mood`)
- Modify: `src/app/(dashboard)/video-editor/_v2/useV2Project.ts` — when a brand revision is applied and the draft has no `musicTrack`, pick the first system track whose `mood === draft.musicMoodDefault`
- Test: `scripts/verify-music-mood.ts` (temp DB: admin PUT with invalid mood → 400; valid → stored; default-track picker returns the first match / null)

- [ ] Steps: failing test → run → implement → verify → `git commit -m "feat(music): mood tag on system tracks; style pack suggests a default track"`.

---

### Task 7: Editor: pack summary + per-clip picker (Project Look)

**Files:**
- Modify: `src/app/(dashboard)/video-editor/_v2/BrandVisualSelector.tsx` (summary line = `pack.thaiLabel` when the pinned recipe has a pack, else the existing `คนสมจริง · หนังผีไทย` form; `เปลี่ยนเฉพาะคลิปนี้` opens `StylePackPicker` from Task 3 with a `กำหนดเอง` path to the existing format/treatment controls)
- Modify: `src/lib/project-look.server.ts` (Project Look accepts `{ stylePackId }` → sets project visual format override + treatment pin `source: "creator"` + stores `stylePack` snapshot in `projectVisualContextJson` so `stockMoodForProject`/`pacingForProject` see it); `src/app/api/brand-library/from-project-look/route.ts` (promotion carries `stylePackId` into the new profile payload via `applyStylePackToPayload`)
- Test: extend `scripts/verify-project-look.ts` and `scripts/verify-brand-treatment-ui-v1.ts` (`buildVisualSummary` gains a pack branch)

- [ ] Steps: failing tests (Project Look with `thai-ghost` pins `thai-supernatural-horror` + `cinematic-realism` and snapshots the pack; promotion produces a revision with `stylePack.id === "thai-ghost"`; summary copy) → implement → verify (`verify:brand-visual-system`, `verify:brand-treatment-v1`) → `git commit -m "feat(editor): pick a style pack per clip and promote it to the brand"`.

---

### Task 8: Recommendation rebalance + pack suggestion

**Files:**
- Modify: `src/lib/content-preflight.server.ts:806-869` (prompt) and the response schema (`suggestedStylePackId: StylePackId | null` derived server-side via `stylePackForTreatment(rankedTreatmentPresetIds[0])`, never model-chosen)
- Create: `scripts/benchmark-content-preflight-distribution.ts` + fixtures `scripts/fixtures/content-preflight-distribution.json` (20 de-identified Thai scripts: 3 ghost, 3 history, 3 drama, 3 news/crime, 3 finance explainer, 2 health, 3 product)
- Test: extend `scripts/verify-brand-treatment-content-preflight-v1.ts` (fake analyzer path) for `suggestedStylePackId`

- [ ] **Step 1:** add to the prompt after the ranking rule: `"expert-clarity and practical-documentary are the neutral last resort: rank one first only when the Dominant Narrative Mode is a plain explanation with no supernatural, historical, investigative, emotional human-story, product or business-technology frame. When such a frame governs the whole source, the matching preset must rank first."`
- [ ] **Step 2:** benchmark script calls the real analyzer with the team's managed Gemini key (env `CONTENT_PREFLIGHT_BENCHMARK_KEY`; ~20 text calls, < ฿5) and prints the distribution; gate: `expert-clarity` first-ranked ≤ 40 % on this fixture set, and each ghost/history/news fixture ranks its matching preset first. **Requires Mew's go before running** (paid text); record the run in the plan Status.
- [ ] **Step 3:** verify + `git commit -m "feat(preflight): rebalance treatment ranking; suggest a style pack"`.

---

### Task 9: Telemetry

- Events: `style_pack_selected` (`properties: { packId, surface: "brand" | "project", version }`), `style_pack_pinned` at job start (`packId`), and `packId` added to `first_pass_visual_exported` / `first_pass_visual_rejected` properties in `src/lib/first-pass-visual-acceptance.server.ts`.
- Admin: `src/app/api/admin/brand-visual-health/route.ts` returns acceptance segmented by `packId`.
- Test: extend `scripts/verify-first-pass-visual-acceptance-v1.ts` (event carries `packId`).
- [ ] Steps: failing test → implement → verify → `git commit -m "feat(telemetry): style pack selection and per-pack acceptance"`.

---

### Task 10: Card sample images

- Fallback ships first: `StylePackPicker` gradient from `palette` (Task 3).
- With Mew's go: generate one 720×1280 image per active pack using the benchmark tooling (`scripts/run-brand-treatment-benchmark-v1.ts` pattern) from a fixed neutral scene per pack (e.g. thai-ghost: "an old wooden Thai house at night, one lit window"), save as `public/style-packs/<id>.jpg` (≤ 120 KB, `git add -f` like `public/showcase/*.jpg`), review visually, commit `feat(brands): style pack card images`.

---

### Task 11: Final gate (session)

- [ ] `npm run verify:brand-visual-system && npm run verify:brand-treatment-v1 && npm run verify:brands-ci && npm run lint:brands && npx tsc --noEmit --pretty false && npm run build`.
- [ ] Draft the `/updates` post (Thai, isPinned=true per memory `product-updates-posting`) in `docs/marketing/updates-2026-09-style-packs.md`.
- [ ] Update this plan's Status and the map's "Decisions so far".

---

## Acceptance Criteria

- [ ] `/brands` default surface = name + 7 pack cards + กำหนดเอง; selecting a pack publishes a revision whose recipe snapshots `stylePack {id, version, stockMood, pacing, musicMood}`.
- [ ] A clip rendered on a `หนังผีไทย` brand with stock B-roll sends `night`-token primary queries, mood-partitioned cache keys and mood avoid/positive terms to the ranker (verify scripts + one manual render on the QA rig).
- [ ] Step 2 has no style menu; region control remains; the pack name is displayed.
- [ ] Windows cadence differs measurably between `slow` and `fast` packs (verify script).
- [ ] Admin can tag music moods; a new project on a pack gets a default track when one exists.
- [ ] Editor per-clip pack choice pins the pack and promotion keeps it; no English internal terms in copy.
- [ ] Content Preflight distribution benchmark (after Mew's go): `expert-clarity` ≤ 40 % first-rank on the fixture set.
- [ ] Telemetry segmented by `packId`; `pending-benchmark` packs never appear in any picker or recommendation.
- [ ] Exactly one additive schema change (`Music.mood`); all suites + build green; CI green.

## Out of scope

- The five new Treatment Presets and their qualification (wave 2).
- Motion effects per pack (Q5 option B) — fast-follow.
- Moving the region preference into the Brand Profile — revisit with telemetry.

## Status
interviewed 2026-09-02 | approved: 2026-09-02 (Mew) | executed: started 2026-09-02 (branch mew/brands-wave1) | delivered: -
