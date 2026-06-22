# B-roll Window-Based Architecture — Design Spec

**Date:** 2026-06-23
**Status:** Approved direction (Approach A: window-first keyword), pending spec review → implementation plan.

## Goal

Make b-roll change on a fixed retention-friendly cadence (~3–4s) where **every change relates to the content spoken in that window**, using **one shared formula across all modes** (free stock video, AI image gen, auto-mix) and **all users** (regular + admin).

## Problem / motivation

Today b-roll is computed three different, fragmented ways, and none of them guarantees the shown clip matches what's being said:

1. **Fragmented count logic** (won't scale — fixing one path doesn't fix the others):
   - Regular video: count = caption count (`min(captions, 36)`), cadence = global env `STOCK_MIN_HOLD_SEC=3`.
   - Auto-mix / kie-image: count = `aiGenPieceCount(duration, cadence)` (added 2026-06-22).
2. **Content drift** — the cadence layer (`buildMinHoldSegments`) cycles clips by bucket index (`pool[poolIdx++]`), NOT by which caption is in each time window. So as a clip is held across a ~3–4s window, the b-roll shown drifts behind the spoken word: it stays thematically close but is not aligned to the moment. The more pieces are reduced for cadence, the worse the drift.
3. **Over-fetch / wasted cost** — fetch-stock sizes the fetch from an over-estimated `totalDurationSec` (sceneDurations assume 3s/caption, or a char-based fallback), while generate-config sizes the displayed cut count from the REAL audio duration. A 63s/41-caption clip estimated 270s → auto-mix fetched 36 pieces (incl. 6 PAID kie AI) but the render showed only 13. (Interim fix in PR #104 corrects the duration input; this design absorbs it.)

### Product intent (from the requester)

- The ~3–4s cadence is a **retention feature**, not merely a cost lever: short-form viewers disengage if b-roll changes too fast (dizzy) or too slow (boring). Keep it.
- We do **NOT** want one b-roll per spoken word — that's too frequent.
- But **when b-roll changes, it must match or at least relate to the words being spoken in that window**.
- Photo + AI-gen were added to raise b-roll **quality**. Quality is wasted (and creates a *new* "b-roll doesn't match" perception) if a high-quality clip shows at the wrong moment. Quality only counts when it's on-time.

## Core concept

**The unit of b-roll becomes the WINDOW (~3–4s), not the caption.** A window is a contiguous group of captions whose combined span reaches the target cadence. Each window owns exactly one b-roll asset whose content is derived from that window's text. Subtitles stay per-caption and are untouched.

## Architecture — new pipeline

```
TTS (Gemini / ElevenLabs)
  → timing → captionsFromTtsTiming → captions   [per-caption; subtitle source of truth — UNCHANGED]
  → buildBrollWindows(captions, cadence)         [NEW: group captions into ~3–4s windows]
  → extract-keywords (window mode)               [1 English keyword per window, from the window's text]
  → fetch-stock (window-based)                   [1 b-roll per window; source = video/photo/ai per mix plan]
  → generate-config                              [place 1 b-roll per window time-range; subtitles still per-caption]
  → render
```

The window is the single reference all b-roll logic shares. The TTS→captions→subtitle path is a parallel, independent track that this design only **reads** from.

## Components

### 1. `buildBrollWindows(captions, cadenceSec)` — the single source of count + placement
- **Location:** `src/lib/broll-windows.ts` (new, pure).
- **Input:** `captions: { startMs, endMs, text }[]` (already sorted), `cadenceSec: number`.
- **Logic:** greedily accumulate consecutive captions into a window until the window span `(endMs - startMs)/1000 >= cadenceSec`, then start the next window at the next caption boundary. A single caption longer than the cadence is its own window.
- **Output:** `BrollWindow[]` = `{ startMs, endMs, captionStartIdx, captionEndIdx, text }[]` where `text` is the concatenated caption texts of the window. Windows tile `[0, audioEnd]` with no gaps/overlaps.
- **Count:** `windows.length ≈ ceil(audioDurationMs/1000 / cadenceSec)`.
- This replaces BOTH the per-caption keyword count AND `buildMinHoldSegments` bucketing — one rule, everywhere.

### 2. extract-keywords — window mode
- **Change:** a request flag on the EXISTING `/api/videos/extract-keywords` route (not a new endpoint) that accepts window texts (N windows) instead of per-caption texts; returns one English keyword per window, plus the existing script-level `relevanceSpec` / `visualDirection` / `contentProfile` (unchanged — those stay script-level).
- Reuses the existing Gemini call and parsing; only the input granularity (window vs caption) and output length (N windows) change. The heuristic fallback (`fallbackQueriesForText`) applies per window.
- `sceneClipCounts` becomes `[1,1,…]` of length = windows.

### 3. fetch-stock — window-based, source mix per window
- **Change:** `keywords.length === windows.length` (≈13, not 41). `overrideClipCount = windows.length`. So `downloadClipLimit = windows.length` → fetch exactly one asset per window. **No over-fetch; no min-hold needed.**
- **Source mix (orthogonal layer):** reuse `planAutoMixSources(windows.length, weights)` to assign each window `video | photo | ai`. `pickEvenIndices` is **no longer needed** (windows already are the evenly-paced pieces). Free-video mode → all windows video; kie-image → all ai; auto-mix → weighted 3:2:1. Same code path for all modes; only the weights differ.
- Each window's asset is fetched/generated for that window's keyword (video search + ranker, or `buildKieImagePrompt(keyword, spec, visualDirection)` for AI) → relevance by construction.
- `totalDurationSec` = the REAL audio duration (absorbs PR #104); used to derive cadence/windows consistently with generate-config.

### 4. generate-config — window placement
- **Change:** when given windows + one clip per window, emit one `bgVideo` segment per window `[startMs, endMs]` (clip plays from 0, clamped to clip length — freeze-safe). Remove the per-subtitle min-hold/cycling branch for this path.
- **Subtitles (`keywordPopups`) continue to be built from the original per-caption `sceneCaptions` — unchanged.**

### 5. Editor wiring (`video-editor/page.tsx`)
- Build windows from captions after TTS; pass window texts to extract-keywords, window count to fetch-stock, and windows (time ranges) to generate-config.
- Replace the per-caption trim/cycle logic (`svForConfig` cycling to caption count) with window-based mapping (1 clip per window).
- The B-roll timeline UI reflects windows (≈13 entries) instead of 41 cycled entries.

### 6. Source mix layer
- `planAutoMixSources` (existing) is the only source-selection logic, now operating on windows. The mix is a thin layer above the window unit; switching modes only changes weights, never the unit.

## Data flow & layer separation

| Track | Source of truth | Consumed by | This design |
|---|---|---|---|
| **Subtitles** | TTS `timing` → `captionsFromTtsTiming` → captions (startMs/endMs) | `keywordPopups` in generate-config → burned subs | **read-only / untouched** |
| **B-roll** | captions → `buildBrollWindows` → window keyword → asset | `bgVideos` in generate-config | **changed** |

The two tracks meet only in generate-config, where `keywordPopups` (subs) and `bgVideos` (b-roll) are built from independent inputs.

## Invariants (enforced + verified)

1. **Subtitle invariant (critical):** For identical input captions, `keywordPopups` (subtitle text, timing, frames) emitted by generate-config MUST be **byte-for-byte identical** before vs after this change. Windows affect only `bgVideos`. Subtitle timing (TTS `timing` arithmetic, `tts-timing.ts`) is not touched. Holds for **both Gemini and ElevenLabs** (both derive subs from TTS timing; windowing is provider-agnostic since it operates on captions).
2. **No over-fetch:** assets fetched == windows == assets displayed. Paid AI generations == AI windows (per mix weights), never more.
3. **Relevance:** each window's b-roll is derived from that window's own text → no drift; the clip shown during a window relates to what's spoken in that window.

## Cadence

- Target `BROLL_WINDOW_SEC` ≈ 3.5–4s, a single tunable constant/env used by `buildBrollWindows` (the only place cadence is defined). Retention-tuned; one knob.

## Rollout & safety

- Behind a flag `BROLL_WINDOW_MODE` (env). This changes b-roll for **ALL users**, so:
  - Flag OFF (default initially) → existing per-caption + min-hold path (fallback intact).
  - Flag ON → window-based path.
- Enable only after: subtitle-invariant verify passes, and prod QA confirms relevance + cadence + subtitle-sync across all three modes for both Gemini and ElevenLabs. Rollback = flip the flag (no deploy).

## What this removes / supersedes

- Per-caption b-roll unit + `buildMinHoldSegments` cycling (the drift source) — for the window path.
- `pickEvenIndices` (windows replace even-spacing).
- Auto-mix over-fetch (PR #104's concern absorbed: real duration → window count → fetch == display).
- Fragmented count formulas (one `buildBrollWindows` rule for all modes/users).

## Error handling / edge cases

- **No captions** → no windows → no b-roll (existing safety nets in generate-config apply; subs unaffected).
- **Single caption longer than cadence** → its own window (one b-roll spans it; freeze-safe clamp).
- **Very short clip (1 window)** → 1 b-roll.
- **LLM keyword failure for a window** → per-window heuristic fallback (`fallbackQueriesForText` on the window text), same as today's per-caption fallback.
- **Source key missing** (no Pexels/kie key) → that source's weight is 0 in the mix (existing `canUse*` gating); windows fall to available sources; never a hard fail.
- **A planned "photo" window finds no stock photo** → drop that window's image (per existing budget-safe rule — does NOT silently spend a paid AI).

## Testing

- **`scripts/verify-broll-windows.ts`** (pure): windowing tiles the timeline with no gaps/overlaps; count ≈ ceil(dur/cadence); single long caption → own window; window count within [min, captions].
- **`scripts/verify-subtitle-invariant.ts`**: to make this testable, extract the inline `keywordPopups` building logic in generate-config into a pure `buildKeywordPopups(captions, style, fps)` function (small, safe refactor). The verify feeds a fixed caption set and asserts identical subtitle output (text, timing, frames) regardless of `BROLL_WINDOW_MODE` — i.e. windows never reach the subtitle builder. The subtitle-sync guard.
- **`scripts/verify-broll-cadence.ts` / `verify-automix-plan.ts`**: keep; adapt to window unit.
- **Prod QA before enabling flag:** one real render per mode (free video / kie-image / auto-mix) × both Gemini and ElevenLabs → confirm (a) subtitles still land on the audio, (b) b-roll changes ~3–4s, (c) each b-roll relates to its window's content, (d) fetched count == displayed count (no waste).

## Scope / blast radius

- Touches: `src/lib/broll-windows.ts` (new), `extract-keywords`, `fetch-stock`, `generate-config`, `video-editor/page.tsx`, mix layer.
- Affects **all users**, not admin-only → flag-gated, fallback intact, QA across both TTS providers before enabling.
- Does NOT touch: TTS, `tts-timing.ts`, caption/subtitle generation, transcribe, render/burn subtitle compositions.

## Decided defaults (open to change in review)

1. Cadence ≈ 3.5–4s via `BROLL_WINDOW_SEC` (tunable).
2. `BROLL_WINDOW_MODE` flag, old path as fallback, enable post-QA.
3. Greedy windowing (accumulate captions until ≥ cadence, cut on caption boundary).
