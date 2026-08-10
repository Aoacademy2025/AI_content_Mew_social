# Brand Visual System — storytelling fix + /brands rebuild

> Fixes the two defects Mew reported on 2026-08-10 against the shipped Brand Visual System
> (origin/main `f520e006`). Product decisions from `2026-08-09-brand-visual-system-product-brief.md`
> stay in force except where this plan explicitly supersedes them.

## Problem

Two independent defects, one shared cause pattern: **brand fields are injected into the image
prompt at the "what is in the frame" layer instead of the "how it is rendered" layer.**

### Defect A — images do not tell the story

Evidence from production (`duckyhero` / brand `mewsocial`, a script about a cyclone):
every generated B-roll frame is people sitting in an office/classroom, with literal blue discs
mounted on walls, TV screens and picture frames. All three Brand Look Preview images show the
same office setting.

Root causes, all in `src/lib/brand-visual-system.ts` unless noted:

| # | Location | Code | Effect |
|---|---|---|---|
| A1 | `:461` | `"Every circular motif is either an empty unmarked ring or a solid unmarked disc"` — appended unconditionally to **every** v2 prompt, every format | Presupposes circles exist, then colors them. Primary driver of the blue discs |
| A2 | `:460` | `"Background walls, device screens and framed areas use plain empty solid color fields"` — also unconditional | Turns walls / TVs / frames into flat color plates. Both A1 and A2 were written as anti-gibberish-text guardrails and backfired into art direction |
| A3 | `:440` | `` `Use the recurring palette ${safePalette}` `` where `safePalette` is **raw hex** (`list()` at `:386` only trims) | Z-Image has no hex grounding; it renders color *swatches as objects* rather than applying a grade. The form is `<input type="color">` (`brands/page.tsx:855`) so hex is the only possible input, and the blank seed is already hex-only (`brand-profile-seed.ts:85`) |
| A4 | `:443` | `` `Repeat the visual cues ${safeMemorableCues}` `` over unvalidated free text | Mew's approved cue is "วงกลม + ลูกศรฟ้า marker" → an explicit repetition command for rings |
| A5 | `:442` | `` `People and places follow ${safePeopleAndSetting}` `` | Overrides the Visual Beat's own `setting`. Storm beat → brand's habitual office |
| A6 | `:209-217` | `cinematic-realism-v2` direction contains `"one nuanced human moment"` + `"real human anatomy and believable Thai environments"` | Forces a human into every frame even when the beat's subject is weather, a map or an object |
| A7 | `:237-243` | `clear-infographic-v2` (the **default** `primaryVisualFormatId` for every new brand, `brand-profile-seed.ts:83`) contains `"geometric grouping made from circles, arrows and recognizable pictograms"` | A second, independent source of circles |
| A8 | `:245-259` | `retro-story-v2` hardcodes `"limited sepia, mustard, teal and burgundy palette"` | Contradicts whatever brand palette `:440` supplied |
| A9 | `brand-look-preview.server.ts:181-218` | `standardPreviewScenes()` templates all three phases from `niche` + `audience`; every phase says `"…environment connected to ${niche}"` and `"one member of ${audience}"` | Hook / Explain / Close are structurally identical → three near-duplicate office photos |

### Defect B — /brands is off the design system and asks too much

- `src/app/(dashboard)/brands/page.tsx` is a single 894-line `"use client"` component with a
  hand-rolled neo-brutalist theme: `bg-[#eee9df]`, graph-paper inline gradient, `shadow-[7px_7px_0_#151515]`,
  accent `#38BDF8`, `fontFamily: var(--font-kanit)`, raw `<input>/<select>/<button>`. Zero `@/components/ui/*`.
  The app's system is single-accent **violet `#8b5cf6`** + shadcn/ui + Bai Jamjuree (see `CLAUDE.md`).
- 20 fields; 4 required (`name`, `niche`, `audience`, `script.tone` — `page.tsx:782`). Everything that
  actually drives the image (`palette`, `personality`, `memorableCues`, `peopleAndSetting`) is optional
  and buried, so the required fields are the ones a normal creator can least easily answer.

## Decisions (locked with Mew 2026-08-10)

1. **Story always wins.** A Brand Profile controls *how the frame is rendered* — palette grade,
   contrast, lighting, lens, composition, texture, mood — and never *what is in the frame*.
   Any brand input that names a subject, prop or location is subordinate to the Visual Beat.
   → becomes ADR 0006.
2. **"จุดจำทางภาพ" (memorable visual cues) is removed from V1 entirely**, for all Visual Formats.
   Brand recognition comes from the image layer (color + light + composition) plus the overlay layer
   (subtitle, logo, headline). A photoreal model can only render a graphic motif as a physical prop.
3. **/brands is rebuilt on the app design system** — shadcn/ui, violet `#8b5cf6`, Bai Jamjuree —
   and the 894-line file is split into components.
4. **The default /brands surface shows two things: ชื่อแบรนด์ + การ์ดแนวภาพ.** Everything else moves
   into ตั้งค่าเพิ่มเติม. `niche` / `audience` / `script.tone` stop being required.
5. **Proof gate before merge: 9 real images.** 3 stories × Hook/Explain/Close under the `mewsocial`
   brand, one of them the cyclone story, presented before/after. Mew judges by eye.

### Supersedes the 08-09 brief

- Brief line "เพิ่มจุดจำทางภาพ" in the Brand Profile wizard → **removed** (decision 2).
- Brief line "ระบุคนหรือฉากแวดล้อมที่ใช้บ่อย" → **removed from the prompt and the form** (decision 1);
  it is a scene input by definition and cannot be made subordinate without becoming meaningless.
- `CONTEXT.md` terms **Brand Visual Language** and **Visual Brand Brief** narrow accordingly.

## Constraint: revision immutability (ADR 0005)

Prompt recipes are pinned per Brand Profile Revision. `V1_FORMAT_DIRECTION` (`:161-206`) is already
frozen precedent. Therefore **`*-v2` recipes must not be edited in place** — this plan adds `*-v3`
and freezes v2 alongside v1.

**Assumption to verify in Task 1 (states it, does not block):** Brand Visual rollout is currently
env-gated to internal accounts only (`BRAND_VISUAL_SYSTEM_ENABLED` + `BRAND_VISUAL_TEST_EMAILS`,
`BRAND_VISUAL_ROLLOUT_PERCENT` = 0 — `brand-visual-rollout.server.ts:40-75`). If production holds no
Brand Profile Revisions belonging to non-internal accounts, Task 1 also ships a one-time, logged
migration moving existing revisions from `-v2` to `-v3`. If any external revision exists, the
migration is skipped and existing revisions keep rendering on `-v2` until their owner republishes.

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Prompt compiler v3 — story-first | `mew-worker-heavy` | subagent | — | build + `verify-brand-visual-system.ts` + `verify-project-look.ts`, code review |
| 2 | /brands rebuild — design system + 2-field surface | `mew-worker-heavy` | subagent | — | build + `verify-brand-profile-library.ts` + `verify-brand-profile-seed.ts`, code review |
| 3 | Brand Look Preview — three genuinely different scenes | `mew-worker` | subagent | 1 | build + `verify-brand-look-preview.ts`, code review |
| 4 | ADR 0006 + CONTEXT.md + brief supersede notes | `mew-worker` | subagent | 1, 2 | session review vs decisions above |
| 5 | Proof pack — 9 real images, before/after contact sheet | `mew-worker` | subagent | 1, 3 | Mew's eye (decision 5) |

Frontier: **1 and 2 dispatch together.** 3 unblocks on 1. 4 unblocks on 1+2. 5 unblocks on 1+3.

---

### Task 1 — Prompt compiler v3 (story-first)

**Files:** `src/lib/brand-visual-system.ts`, `scripts/verify-brand-visual-system.ts`,
`src/lib/project-look.server.ts` (only if the compile call signature changes),
plus a migration script under `scripts/` if the assumption above holds.

**Do:**

1. **Freeze v2.** Copy `FORMAT_RECIPE_DIRECTION` to `V2_FORMAT_RECIPE_DIRECTION` and route
   `recipeVersion` ending in `-v2` to a frozen `compileBrandVisualPromptV2()`, exactly as
   `compileBrandVisualPromptV1` does today (`:309-361`). v1 and v2 output must be byte-identical
   to today's — assert this in the verify script with stored golden strings.
2. **Add `*-v3` recipes** for all five formats and make them the compiler default.
   - Delete the two unconditional lines A1 (`:461`) and A2 (`:460`) from the v3 positive prompt.
     Their anti-text job moves entirely to the negative prompt, which already carries
     `screen text`, `wall chart`, `document`, `legible writing`, `pseudo-text`, `gibberish text`.
   - `cinematic-realism-v3`: drop `"one nuanced human moment"`. Human presence must follow the beat's
     `subject`, not the recipe. Keep the lens/contrast/lighting language — that is the brand-safe part.
   - `clear-infographic-v3`: drop `"circles, arrows and recognizable pictograms"`; express the format
     as hierarchy, grouping and negative space without naming shapes.
   - `retro-story-v3`: the sepia/mustard/teal/burgundy palette applies **only when the brand supplies
     no palette**; a brand palette always wins.
   - Every other recipe: strip any clause that names a subject, prop or location.
3. **Hex → color words.** Add a small nearest-named-color mapper (no new dependency — a table of
   ~24 named colors + RGB distance is enough) and emit a *grading* instruction, not a swatch list:
   `The overall color grade favors deep charcoal, warm off-white and cool sky blue` — never a hex code.
   A brand palette entry that is already a word passes through unchanged.
   Reachability: hex must not appear anywhere in the compiled positive prompt.
   **This replaces the existing assertion at `verify-brand-visual-system.ts:132`
   (`assert.match(mewsocialPrompt.positive, /#38BDF8/)`), which currently locks the bug in.**
4. **Remove `memorableCues` from the prompt** (`:443`) for v3. Keep the payload field and DB column so
   pinned v1/v2 revisions still compile; v3 simply ignores it.
5. **Remove `peopleAndSetting` from the prompt** (`:442`) for v3, same treatment.
6. **Reorder the v3 positive prompt so the scene dominates.** Target shape:
   `[frame/format direction] → [the scene from the Visual Beat, in full] → [treatment mood] → [brand rendering direction] → [craft guardrails]`.
   Brand direction in v3 may only contain: color grade, contrast/exposure character, lighting quality,
   lens/perspective language, composition and texture. Assert this by construction — the brand fragment
   is built from a fixed set of clause builders, not from free concatenation.
7. **Visual Notes** (`structuredVisualNotes`, `:366`) already whitelists to 10 bounded rules. Audit that
   allowlist and drop any rule that introduces subject or location content.
8. **Migration** (conditional, see assumption): a `scripts/` one-shot that lists Brand Profile Revisions,
   reports owners, and — only if all owners are internal — rewrites `recipeVersion` `-v2` → `-v3` and logs
   every row it changed. It must be a dry-run by default and require an explicit `--apply` flag.

**Do not:** change the negative prompt's existing entries (they are load-bearing for the text-free
contract); change `content-preflight.server.ts`; touch the `-v1` path.

**Verify:** extend `scripts/verify-brand-visual-system.ts` with — golden v1/v2 immutability strings;
no `#` hex in any v3 positive; no `circular motif` / `solid unmarked disc` / `plain empty solid color fields`
in any v3 positive; a storm beat (`subject: "a towering cyclone wall"`, `setting: "an open coastal town"`)
compiled against a brand whose `peopleAndSetting` is `"ทีมงานในออฟฟิศ"` and whose `memorableCues` is
`["วงกลมฟ้า", "ลูกศร marker"]` must contain the cyclone and the coastal town and must contain **neither**
office nor circle language; all five v3 formats compile.

---

### Task 2 — /brands rebuild

**Files:** `src/app/(dashboard)/brands/page.tsx` (split), new components under
`src/app/(dashboard)/brands/_components/`, `src/lib/brand-profile-seed.ts`,
`src/lib/brand-profile-library.server.ts` (required-field gate only),
`scripts/verify-brand-profile-library.ts`, `scripts/verify-brand-profile-seed.ts`.

**Do:**

1. **Design system.** Replace the neo-brutalist theme wholesale with shadcn/ui primitives
   (`Card`, `Input`, `Textarea`, `Select`, `Button`, `Label`, `Slider`, `Switch`, `Collapsible`)
   and the violet accent. No hardcoded hex for chrome, no inline `fontFamily`, no `shadow-[Npx_Npx_0_...]`,
   no graph-paper gradient. Headings use the existing heading font stack, not an inline Kanit override.
   Match `/video-editor` and `/dashboard` — read them first, do not invent a third look.
2. **Split the 894-line file.** Server component for the route shell; client islands per section
   (`VisualFormatPicker`, `BrandBasicsForm`, `AdvancedSettings`, `BrandLookPreviewPanel`, `BrandList`).
   Keep all existing API calls and state transitions intact.
3. **Default surface = 2 inputs.**
   - `ชื่อแบรนด์` (text, the only required field)
   - `แนวภาพประจำแบรนด์` — the 5 image cards, already step 1 today
   - Primary action stays `ใช้แนวภาพใหม่นี้`; `บันทึกร่าง` stays.
4. **Everything else into `ตั้งค่าเพิ่มเติม`** (a single collapsed `Collapsible`, closed by default):
   `niche`, `audience`, `script.tone`, `script.analysisNotes`, `visual.palette`, `visual.personality`,
   `visual.defaultTreatment`, `visual.visualNotes`, voice, subtitle preset, brand mark block.
5. **Remove two fields entirely** from the form and from `BrandProfileSeed` construction:
   `visual.memorableCues` and `visual.peopleAndSetting`. Keep them in the persisted payload schema
   (default `[]` / `""`) so pinned revisions still deserialize — do not drop the columns.
6. **Relax the publish gate.** `canPublish` becomes `draft.name.trim().length > 0`.
   `niche`, `audience` and `script.tone` fall back to the blank-seed defaults when empty; because
   Task 3 stops deriving preview scenes from `niche`/`audience`, empty values are now safe.
   Server-side payload validation must accept empty `niche`/`audience` — check
   `brand-profile-library.server.ts` and relax only these three, nothing else.
7. **Copy** (Thai, use verbatim):
   - Page title: `แบรนด์ของฉัน`
   - Empty state: `สร้างแบรนด์แรกของคุณ — ตั้งชื่อ แล้วเลือกแนวภาพที่อยากให้คลิปของคุณเป็น`
   - Name field label: `ชื่อแบรนด์` · placeholder: `เช่น Mew Social`
   - Format section label: `แนวภาพประจำแบรนด์`
     · helper: `ทุกคลิปของแบรนด์นี้จะใช้แนวภาพเดียวกัน เปลี่ยนทีหลังได้`
   - Collapsible trigger: `ตั้งค่าเพิ่มเติม` · helper: `สี เสียง ซับ โลโก้ และรายละเอียดแบรนด์ — ไม่กรอกก็ได้`
   - Palette field helper (new, explains the fix): `ระบบจะใช้สีเหล่านี้เป็นโทนของภาพ ไม่ใช่วาดเป็นวัตถุในภาพ`

**Do not:** change any API route contract; change the preview/settlement flow; touch rollout gating.

**Verify:** `npm run build`; `verify-brand-profile-library.ts` + `verify-brand-profile-seed.ts` updated
for the relaxed gate and the two removed fields; grep the new components for `#eee9df`, `#38BDF8`,
`shadow-[`, `var(--font-kanit)` → zero hits.

---

### Task 3 — Brand Look Preview scenes

**Files:** `src/lib/brand-look-preview.server.ts`, `scripts/verify-brand-look-preview.ts`.

**Problem restated:** `standardPreviewScenes()` (`:181-218`) makes Hook/Explain/Close structurally
identical — same `"environment connected to ${niche}"`, same `"one member of ${audience}"` — so the
three preview images are three photos of the same room. It also depends on `niche`/`audience`, which
Task 2 makes optional.

**Do:**

1. Replace `standardPreviewScenes()` with three **structurally distinct archetype scenes** that do not
   depend on `niche` or `audience` and that exercise different framing, so the creator can actually
   judge whether the look holds across different kinds of content:
   - **Hook** — a wide environmental establishing frame with a force or condition dominating the frame
     and no human required (this is the case the current template cannot produce at all).
   - **Explain** — a mid-shot of a person's hands and two or three concrete objects in a
     cause-and-effect relationship.
   - **Close** — a human close-up with forward motion and open space at the lower third.
   Each supplies the full `VisualBeat` shape (`subject` / `action` / `setting` / `emotion` / `emphasis`).
2. When `niche` is non-empty, it may still colour `contentDomain` — but it must never be the
   `setting` string. When empty, `contentDomain` falls back to a neutral value.
3. Leave `resolveProjectPreview()` (`:237-300`) alone — previews opened from a real project already use
   real Visual Beats, which is correct.

**Verify:** `verify-brand-look-preview.ts` asserts the three scenes differ in `setting` **and** in
`subject`; the hook scene contains no person noun; compiled prompts for the three scenes are pairwise
distinct; batching / idempotency / settlement assertions all still pass.

---

### Task 4 — Docs

1. `docs/adr/0006-brand-visual-language-controls-rendering-not-scene.md` — decision 1, its consequences
   (fields removed from the prompt), and the v2-frozen / v3-default recipe split.
2. `CONTEXT.md` — narrow **Brand Visual Language** and **Visual Brand Brief** to rendering-only;
   delete the memorable-cue clause. Do not restate the ADR, link it.
3. `docs/plans/2026-08-09-brand-visual-system-product-brief.md` — append a short
   `## แก้ไขภายหลัง (2026-08-10)` section pointing at this plan and ADR 0006 for the two superseded lines.
   Do not rewrite the original text.

---

### Task 5 — Proof pack (9 real images)

**Do:** using the `mewsocial` brand values, generate Hook / Explain / Close for three scripts —
(a) the cyclone story Mew already shipped, (b) a personal-finance story, (c) a health story —
through the real Z-Image path, and lay them out as an HTML contact sheet next to the corresponding
**before** frames from the existing production video (supplied by Mew or pulled from her latest render).
Write to `artifacts/brand-visual-fix-2026-08-10/`.

Each cell must print the compiled positive prompt underneath the image so a bad frame is traceable to
its prompt without re-running anything.

**Verify:** 9 images present; zero blue discs on walls, screens or frames; the cyclone Hook shows
weather, not a meeting room; the three stories are visually distinguishable from each other while
sharing one palette/lighting/lens signature. Mew's eye is the gate.

---

## Acceptance Criteria

- [ ] No compiled `-v3` positive prompt contains a hex code, `circular motif`, `solid unmarked disc`,
      `plain empty solid color fields`, or any `Repeat the visual cues` / `People and places follow` clause.
- [ ] `-v1` and `-v2` compiled output is byte-identical to today's, proven by golden-string assertions.
- [ ] A cyclone Visual Beat compiled against a brand whose `peopleAndSetting` says "office" yields a
      cyclone in a coastal town — verified in `verify-brand-visual-system.ts`.
- [ ] Brand Look Preview's three scenes differ in both `subject` and `setting`; the hook scene needs no person.
- [ ] `/brands` renders on shadcn/ui + violet + the app heading font; grep finds no `#eee9df` / `#38BDF8` /
      `shadow-[` / `var(--font-kanit)` in the route's components.
- [ ] `/brands` default surface shows exactly two inputs — ชื่อแบรนด์ and the แนวภาพ cards; everything
      else is inside a collapsed ตั้งค่าเพิ่มเติม.
- [ ] A brand can be published with only a name filled in.
- [ ] `npm run build` passes; every listed `scripts/verify-*.ts` passes.
- [ ] 9 real images generated; Mew confirms by eye that the images tell their stories and carry no
      literal brand props.

## Out of scope

- Trend Packs / หมวดกำลังนิยม — fast-follow in the 08-09 brief, untouched here.
- Model-rendered text in images (GPT Image via KIE) — still out of V1.
- Quick brand creation inside Editor Step 2 — separate work; this plan only fixes `/brands`.
- Rollout percentage changes — this plan does not widen exposure.
- The Gemini Visual Beat extraction prompt (`content-preflight.server.ts:214-229`) — beats already carry
  correct story content; the compiler was discarding it. Revisit only if Task 5 shows weak beats.

## Status

interviewed 2026-08-10 | approved: 2026-08-10 | executed: 2026-08-10 | delivered: PR #212 (awaiting Mew merge)
