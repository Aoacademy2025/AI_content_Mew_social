# Avatar composite — make all modes work again (design)

- **Date:** 2026-07-01
- **Status:** approved (design), pending implementation plan
- **Branch:** `mew/avatar-composite-allmodes`
- **Owner:** Mew

## Problem / background

After the 06-30 avatar-framing deploy (`a3b9913`), the avatar composite flow broke for
multiple modes. Audit findings:

1. **Gen modes (Full / Intro-bookend / Intro+Outro-bookend-both):** the 06-30 work replaced
   the unconditional `runComposite` with `compositeOrPause`, which **pauses** before
   compositing the first time an avatar is used (no saved preset). The continue control
   ("ต่อ → ประกอบ") lives as a tiny `9px` text button in OrderPanel, so users don't find it →
   pipeline stays stuck at the avatar/composite step.
2. **Direct Upload / Link:** has **no standalone composite trigger**. Composite only runs as
   the tail of the full `runAll` pipeline. The Render-step ▶ button (`runRenderOnly`) renders
   the base only (no composite), and the avatar/composite pipeline-step buttons are disabled
   (`null`) for direct mode (since 06-10). So uploading an avatar into an already-rendered
   project + re-rendering via Render ▶ → stuck (no avatar). This is the **sumawadee** case.
   Prod evidence: her last successful avatar video = 06-28; 06-29/06-30 only base RENDER/BURN.
3. **Direct, non-green ("full background") clip:** the editor always sends composite
   `mode: "chromakey"` for direct uploads. A non-green full-background clip (user generated
   their own background, just wants subtitles) only **accidentally** works (chromakey with no
   green overlays the full clip over a wastefully-rendered b-roll) and is **fragile** (any
   greenish pixels get keyed into holes).
4. **Double-gen (related):** the avatar/composite pipeline-step buttons and the main Render
   call `runAvatarPipeline`, which always re-pays HeyGen. Adjusting size then re-triggering
   re-generates the avatar instead of re-compositing.

The smart gen-vs-composite logic (`avatarGenSignature` + `nextAvatarAction` in
`src/lib/avatar-flow.ts`) and the page-level `lastGenSig` / `onAvatarPrimary` handler already
exist and are deployed — but they were wired into a **dead** RightSettingsPanel avatar block
(`{false && (...)}`, "moved to OrderPanel … remove in Phase 3"), so they have no effect. The
**live** avatar UI is OrderPanel + the page.tsx pipeline-step buttons.

## Goals

- Every avatar mode produces a finished avatar video again, with no manual "continue" step:
  Full, Intro (bookend), Intro+Outro (bookend-both), Direct·GreenScreen, Direct·FullVideo.
- Adjusting avatar position/scale never re-pays HeyGen (composite-only re-trigger).
- Direct uploads have a clear composite trigger that works even on an already-rendered project.
- Support the non-green "full background, subtitles only" direct use case cleanly.
- Keep the good parts of 06-30: gen-default framing (1.6 / −0.12), free re-composite, honest
  preview.

## Non-goals

- Cross-session position memory for **direct** uploads (decision: per-session only).
- Skipping b-roll render for Direct·FullVideo (b-roll is rendered then covered — acceptable
  waste for v1; optimization deferred).
- Touching the dead RightSettingsPanel avatar block beyond removing now-unused pieces.

## Design

Principle: **Render → finished avatar automatically; position changes = free re-composite;
every mode has an obvious trigger.**

### Change 1 — Remove the pause → auto-composite (the core stuck fix)

- Delete the pause path. Replace `compositeOrPause(...)` (in `runAll` ~2905 and
  `runAvatarPipeline` ~2665) with a direct composite, so the avatar always composites after
  the green is ready — for **all** modes (gen pauses no longer; direct already didn't pause).
- `runRenderOnly` (~3019, the Render-step ▶) gains the same post-render avatar step when
  `useAvatar` is on, so re-rendering the base also re-composites the avatar. It uses the smart
  action (Change 2) so a base-only re-render with an unchanged avatar **composites, not
  re-gens**.
- Remove the now-dead `awaitingPosition` state, the OrderPanel "ต่อ → ประกอบ" (pause/continue)
  button, and `shouldPauseForPositioning` (+ its verify-avatar-flow.ts checks).

### Change 2 — Smart re-trigger on the LIVE controls (no double-gen, direct trigger)

- Reuse `nextAvatarAction` / `avatarGenSignature` / `lastGenSig` / `onAvatarPrimary` — but move
  the wiring from the dead RightSettingsPanel block to the **live** controls:
  - **Pipeline-step buttons** (page.tsx ~4178): change
    `(useAvatar && !isDirectAvatar) ? runAvatarPipeline : null` → `useAvatar ? onAvatarPrimary
    : null`. This (a) makes the avatar/composite step buttons work for **direct** too (giving
    direct a standalone composite trigger) and (b) makes them composite-only when a green
    already exists for the same gen-inputs (no re-gen).
  - **OrderPanel** "ปรับตำแหน่ง → ประกอบใหม่" (`compositeWithCurrentLayout`) stays as the
    free, composite-only position-adjust path (already correct).
- `onAvatarPrimary` already routes: green exists + gen-inputs unchanged → composite-only;
  else → gen (or, for direct, set-green-from-URL + composite via `runAvatarPipeline`'s direct
  branch).

### Change 3 — Direct mode: Green Screen vs Full Video toggle

- Add a direct-only choice in the avatar panel (OrderPanel + the direct upload UI):
  `directCompositeMode: "chromakey" | "full"` (default `"chromakey"`).
- `runComposite` direct branch sends `mode` based on the toggle:
  - **Green Screen** → `mode: "chromakey"` (current: remove green, overlay on b-roll).
  - **Full Video / subtitles only** → `mode: "direct"` (route's existing `directComposite`:
    overlay the uploaded clip full-frame over the bg, no chroma; audio from the clip). The
    uploaded clip's own background shows; subtitles burn on top.
- Label clearly in Thai, e.g. "Green Screen (ตัดเขียว)" / "วิดีโอเต็มจอ (ใส่ซับอย่างเดียว)".

### Change 4 — Cleanup

- Remove `awaitingPosition`, the pause/continue button, `compositeOrPause`,
  `shouldPauseForPositioning` (+ tests). Keep everything else.

### Change 5 — Keep (from 06-30)

- `HEYGEN_GEN_FRAMING` (1.6 / −0.12) gen-default; `compositeWithCurrentLayout` free
  re-composite; honest preview (dimmed thumbnail before green exists); AvatarPreset
  save/load (gen, by avatarId).

## Resulting per-mode behavior

| Mode | Render → | Adjust position | Remember across sessions |
|---|---|---|---|
| Full (gen) | auto-composite (chromakey on HeyGen green) | re-composite, free | ✅ preset (avatarId) |
| Intro / เปิด (gen) | auto-composite intro | re-composite, free | ✅ preset |
| Intro+Outro / เปิด-ปิด (gen) | auto-composite intro+tail | re-composite, free | ✅ preset |
| Direct · Green Screen | auto-composite (chromakey) | re-composite, free | per-session only |
| Direct · Full Video | auto-composite (full overlay, no chroma) + subtitles | n/a (full frame) | n/a |

In all modes: no pause/continue step; position changes never re-gen; the avatar/composite
step buttons + OrderPanel re-composite give an always-available trigger.

## Components / files touched

- `src/app/(dashboard)/video-editor/page.tsx` — `runAll`, `runAvatarPipeline`, `runRenderOnly`,
  `runComposite` (direct branch `mode`), step-button handler (~4178), remove `awaitingPosition`
  + pause wiring; new `directCompositeMode` state.
- `src/app/(dashboard)/video-editor/_components/OrderPanel.tsx` — direct green/full toggle;
  step/composite trigger wiring; remove "ต่อ → ประกอบ" pause button.
- `src/app/(dashboard)/video-editor/_components/RightSettingsPanel.tsx` — no live behavior
  (its avatar block is dead, behind `{false && …}`). The smart props now drive the live
  page.tsx pipeline-step buttons instead, so stop passing
  `onAvatarPrimary`/`avatarPrimaryLabel`/`avatarPrimaryIsGen` into RightSettingsPanel (they fed
  only the dead block). Leave the dead block itself untouched (out of scope to delete).
- `src/lib/avatar-flow.ts` — keep `avatarGenSignature` + `nextAvatarAction`; remove
  `shouldPauseForPositioning`.
- `scripts/verify-avatar-flow.ts` — drop `shouldPauseForPositioning` checks; keep/extend
  signature + next-action checks.
- `src/app/api/heygen/composite/route.ts` — no change expected (`mode: "direct"` already
  supported); confirm during implementation.

## Testing

- **Unit (TDD, `scripts/verify-avatar-flow.ts`):** `avatarGenSignature` + `nextAvatarAction`
  (existing, keep); remove pause checks. Add a check for the direct composite-mode selection if
  it becomes a pure helper.
- **Build-verify:** `tsc --noEmit` clean on touched files; full build (deploy.sh).
- **Browser e2e on prod (Claude-in-Chrome / chrome-devtools):** for each — gen (one mode),
  Direct·Green, Direct·Full — confirm via Network that Render auto-composites (hits
  `/api/heygen/composite`, not a second `/api/heygen/generate-with-bg`), a position tweak
  re-composites only, and Direct·Full overlays without chroma.
- **Deploy hygiene:** clean rebuild is NOT needed (06-30 "stale bundle" was a `{false}`
  dead-code/DCE artifact, not a webpack-cache bug). Verify the new strings land in the bundle
  after a normal deploy.

## Open implementation questions (resolve in plan)

- Exact placement of the Direct green/full toggle in OrderPanel.
- Whether `runRenderOnly` calls a shared `ensureAvatarComposited()` helper or inlines the
  smart action (prefer a small shared helper for testability).
- Whether `directCompositeMode` is persisted in the draft (nice-to-have; per-session is fine).
