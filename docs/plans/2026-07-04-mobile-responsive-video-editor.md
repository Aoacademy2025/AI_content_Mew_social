# Mobile-Responsive Video Editor v2 — Decisions + Plan (grilled 2026-07-04)

Fills the gap left open by `docs/superpowers/plans/2026-07-02-video-editor-v2-redesign.md`
("Desktop-first… Design ref = 1200×800" → mobile was explicitly out of scope). Editor v2 is
now LIVE on prod, so /video-editor is unusable on phones — this plan makes the 4 phase screens
+ topbar work on ~390px touch devices.

See also: `CONTEXT.md` (glossary: Editor Phase / Setup / Post / Timeline / Caption), the v2
redesign plan above, `_v2/tokens.ts` + `_v2/ui.tsx` (design system — reuse, don't reinvent).

## Decisions (resolved with Mew, 2026-07-04)

| # | Decision | Choice |
|---|----------|--------|
| Q1 | Mobile scope | **Full create+render on mobile + Post-phase subtitle editing REDESIGNED for touch** (not a shrunk timeline). Rationale: TH market is mobile-first; the "one script → auto video" flow is mobile-friendly; only the Post timeline is genuinely hard on touch. |
| Q2 | Preview/controls spine | **Sticky 9:16 preview on top (~40vh, tap→fullscreen) + controls scroll below.** CapCut-familiar; video stays visible while editing captions. Applies where a live preview exists (Post + upload-mode Step1). |
| Q3 | Post touch model | **Vertical caption-card list + tap-to-edit; DROP the 4-track timeline on mobile.** avatar/b-roll/music tracks (display-only even on desktop) collapse into a compact read-only summary. The editable "subtitle track" becomes the card list. |
| Q4 | Timing edit on touch | **Nudge buttons (−/+0.1s) for in/out + "ตั้ง = ตำแหน่งที่เล่นอยู่" (snap boundary to current playhead).** No fine dragging. Auto-timing is exact-by-arithmetic (see CLAUDE.md subtitle-timing note) → Post edits are mostly small tweaks + text fixes. |
| Q5 | Deliverable | **Interactive HTML mockup first (Artifact, opened on a real phone) → then implement in repo after design approval.** |

### Self-decided defaults (Mew may veto)
1. **Single breakpoint at `lg` (1024px).** `<lg` = new mobile stacked layout; `≥lg` = current desktop code **untouched** → zero desktop-regression risk; tablet-portrait gets the (touch-friendly) mobile layout.
2. **Delivery = hybrid.** Step1 / Step2 / RenderingScreen / Topbar → responsive in-place via `lg:` prefixes. **PostPhase → separate `<PostPhaseMobile>` component** (interaction differs fundamentally, not reflow). Both mobile + desktop views consume the same `useV2Project` / `useV2Job` hooks — no state fork. View chosen by a client media-query hook (editor is already `"use client"`).
3. **Setup mobile** = single column; the fixed `w-[372px]` rails stack below; the off-screen "ถัดไป"/"เรนเดอร์" CTAs move to a **sticky bottom bar** (thumb-reachable); ตั้งค่าขั้นสูง collapsed by default.
4. **Topbar mobile** = StepIndicator compacted to numbered dots (01·02·03, no long Thai labels); logo + account kept.
5. **Session scope = the 4 /video-editor phase screens + topbar only.** Dashboard/nav is a later pass.

## Mobile screen specs

### Topbar (all phases)
Compact: logo (30px) · numbered step dots 01·02·03 (active = gradient, done = check) · account dot. "กลับ UI ปัจจุบัน" link → move into an overflow/`⋯` or drop on mobile. Height stays 58px.

### Step 1 — สคริปต์ (`Step1Script`)
Single column, scroll: mode cards (script / upload-clip) → grid-1 (or 2 tight) → script textarea (full width, min-h ~220) → segment rail (the `w-[372px]` aside) becomes a **vertical segment list below** the textarea (drag-reorder retained). Upload mode: the `<video>` preview obeys the Q2 spine (sticky top). **Sticky bottom CTA: "ถัดไป".**

### Step 2 — องค์ประกอบ (`Step2Elements`)
Single column of the ~4 control groups (voice / avatar / b-roll mix preset / music + subtitle-style entry), each `Card`-wrapped; ตั้งค่าขั้นสูง collapsibles collapsed. The `w-[372px]` right rail (196×348 preview placeholder + SummaryRows) stacks to the bottom of the column (placeholder can shrink / become a thin summary). **Sticky bottom CTA: the render button** (exact label from content inventory) — triggers the Render Receipt dialog (already `max-w-full`, safe).

### Rendering (`RenderingScreen`)
Already mobile-safe (`max-w-[92vw]`). Only tighten inner `px-10` → smaller on mobile. Humanized stage checklist + cancel unchanged.

### Post — แต่งซับ (`PostPhaseMobile`, new)
Replaces the 3-column (266+center+330) + timeline desktop layout:
- **Sticky top**: 9:16 preview (~40vh) with `V2CaptionOverlay`; tap → fullscreen. Under it a thin scrub/progress bar (tap-to-seek) + play/pause.
- **Body (scroll)**: vertical **caption-card list** — each card = caption text + time range + tag (hook/body/cta); the currently-playing card highlights and auto-scrolls into view; tap a card → seek + open **edit sheet**.
- **Edit sheet (bottom sheet)**: caption text field · in/out timing via nudge ±0.1s + "ตั้ง = ตำแหน่งที่เล่นอยู่" · (merge/split/delete if desktop has them).
- **"สไตล์ซับ" button** (in a sticky action row) → **full-screen sheet** carrying the desktop right-rail global style controls (quick styles / presets / effects / color).
- **avatar/b-roll/music summary**: one collapsed read-only "รายละเอียดคลิป" strip (low priority).
- **Sticky bottom action row**: "สไตล์ซับ" (secondary) + **"ส่งออกวิดีโอ"** (primary export/burn). "เรนเดอร์ใหม่" as ghost/overflow.

## Execution Directive
| # | Task | Agent | Mode | Review gates |
|---|------|-------|------|--------------|
| 0 | Interactive HTML mockup of Post + Setup1 + Setup2 + topbar (real tokens/content) | (session model) | inline Artifact | Mew reaction (this session) |
| 1 | Topbar + Setup1 + Setup2 + Rendering responsive in-place (`lg:` prefixes, sticky bottom CTAs) | mew-worker | subagent | build, mew-reviewer, mobile visual QA |
| 2 | `PostPhaseMobile` component + media-query view switch (shared hooks, desktop untouched) | mew-worker-heavy | subagent | build, mew-reviewer, mobile visual QA |
| 3 | Caption edit sheet (text + nudge/set-playhead) + global style sheet | mew-worker | subagent | build, mew-reviewer |

(Tasks 1–3 gated behind Mew's approval of the mockup design — do NOT dispatch before then.)

## Acceptance Criteria
- [ ] At ~390px, every phase screen has **no horizontal overflow / no clipped controls**.
- [ ] Setup: primary CTA (ถัดไป/เรนเดอร์) always reachable as a sticky bottom bar.
- [ ] Post mobile: sticky preview + caption card list + tap-to-edit sheet (text + nudge ±0.1s + set-to-playhead) + global "สไตล์ซับ" sheet — all touch-operable, targets ≥44px.
- [ ] Desktop (`≥lg`) renders byte-identical to current code (no regression).
- [ ] Uses the real editor v2 design system (tokens.ts colors/gradient, Kanit+Noto, existing ui.tsx components).
- [ ] (mockup) opens on a real phone with no pinch/scroll-sideways; Post interactions feel native.

## Status
interviewed 2026-07-04 | mockup delivered + approved 2026-07-04 (Artifact `bfa44a8c`) | code executed 2026-07-04 (branch `mew/mobile-responsive-editor`, 4 commits, tsc+build pass, both Tier-1 reviews PASS, desktop parity proven) | delivered: pending Mew device-QA + merge/deploy

## Execution log (2026-07-04)
- `c3c2b03` + `e3da3d1` — Task B: Step1/Step2/Rendering responsive + sticky CTAs + single-scroll fix (Tier-1 clean, build pass).
- `43e1bce` — Task A: extracted `usePostPhaseEditor` (behavior-preserving), refactored desktop `PostPhase` to consume it (JSX = pure `ed.` rewrites, desktop render unchanged), new `PostPhaseMobile` + `useIsMobile` + shell viewport branch + `StepIndicator compact` prop (opus Tier-1 PASS, build pass).
- `0e39158` — Task A polish: mobile scrub ≥44px, undo button, nudge-guard toast, pause-on-edit (tsc clean).
- Remaining Minor (accepted): done-phase brief desktop→mobile mount flash (rare, no data loss).
- **Human check still owed (Mew, on a phone/preview):** the `แต่งซับ` touch flow (card→sheet nudge/snap/undo, style presets+per-card color scope, export label transitions), the avatar-adjust overlay usability at ~40vh, and the compact topbar at 360–430px.
