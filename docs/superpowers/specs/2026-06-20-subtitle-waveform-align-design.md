# Subtitle Waveform Alignment — Design Spec

**Date:** 2026-06-20
**Ticket:** cmqjciav (veerawich@aoacademy.co) — "อยากให้มีระบบแสดงกราฟเสียง เวลาซับไม่ตรงเสียงจะได้แก้ไขได้ด้วยครับ"
**Status:** Design approved, pending implementation plan.

## Problem

Auto subtitle timing can drift, especially for Gemini TTS on pause-heavy scripts (the timing is arithmetic-derived, not real per-word timing — see the subtitle-drift saga; auto-fixing it exactly is not possible without real word timing). The pragmatic fix is **human-in-the-loop**: show the user the audio waveform so they can *see* where speech actually is, and let them drag subtitle boundaries to match. The editing half of this already exists — what's missing is the visual ("the eyes").

## Goal / success criteria

In `/video-editor`, the SUBTITLES timeline track shows the voice **waveform**, and dragging a caption edge **snaps** to speech onset/offset. The adjusted timing flows through to the burned video. Works for every voice source; never touches the fragile TTS/timing logic.

Scope decisions (from brainstorm):
- **v1 = waveform + snap assist** (not just a passive waveform; not an auto-realign-all button — auto risks the over-correction that broke prior saga attempts).
- **Snap source = "C": prefer server `silenceIntervals` when present (Gemini, ffmpeg-accurate), else compute snap points client-side from the decoded waveform** (covers ElevenLabs / uploaded / avatar). Universal + best accuracy where available; the user sees one consistent behavior.

## What already exists (reused, not rebuilt)

- **Caption-edge drag on the timeline:** `clipResizeRef` in `src/app/(dashboard)/video-editor/page.tsx:424` already supports `{ capIdx, edge: "left"|"right"|"move" }` — left/right resize + move of a caption block, writing to the `captions` state.
- **Captions are the source of truth for burn:** the render rebuilds `keywordPopups` from the current `captions` (`page.tsx:1881`), and Burn uses `captionsRef.current` (`page.tsx:2617`). So manual timing edits already survive to the final burned MP4 — **no override-model needed** (unlike b-roll, which is recomputed at config time).
- **Audio + timing already in editor state:**
  - `pipe.current.voiceUrl` (`page.tsx:828, 964`) — the voice audio, already loaded; decode source for the waveform.
  - `ttsTimingRef.current` (`page.tsx:295`, captured at `page.tsx:1408`) holds the last TTS `TtsTiming`, including `silenceIntervals` (`{startMs,endMs}[]`, defined `src/lib/tts-timing.ts:47`, emitted by `tts-gemini/route.ts:411`).
- **Timeline zoom slider** already exists (the waveform must respect it).

## What's new (the actual work — frontend only)

### 1. Waveform rendering
- Tech: **custom `<canvas>` via Web Audio API** (`AudioContext.decodeAudioData`) — NOT wavesurfer.js. Rationale: our timeline, zoom, and caption-drag are custom; wavesurfer renders its own timeline/cursor and would fight the existing layout. A custom canvas aligns 1:1 with the existing time→px scale.
- On TTS done (voiceUrl ready): fetch+decode the audio **once**, downsample to a peak/min-max array (bucketed ~1–2px), cache in a ref keyed by voiceUrl.
- Draw the peaks on a canvas placed as a background lane inside the SUBTITLES track, width = timeline content width, scaled by the existing zoom. Redraw on zoom / container resize / new voiceUrl.
- Decode is async with a small loading state; never blocks the editor.

### 2. Snap points (option C)
- A snap point = a speech boundary = the edge of a silence interval (start of speech = end of a silence; end of speech = start of a silence).
- Build the snap-point list when audio/timing changes:
  - If `ttsTimingRef.current.silenceIntervals` is present and non-empty → derive snap points from it.
  - Else → derive from the decoded peaks via an amplitude threshold (simple client-side silence detection over the same buckets we already computed).
- Memoize; rebuild only when voiceUrl/timing changes.

### 3. Snap interaction
- Extend the existing `clipResizeRef` move/resize handler: while dragging a caption edge, if the dragged time is within a threshold (`SNAP_MS`, e.g. ~120ms, or an equivalent px threshold at current zoom) of a snap point → snap to it and render a vertical guide line at that point.
- A **snap toggle** (default on) lets the user disable magnetic snapping for free placement; optionally a held modifier key bypasses snap for one drag.

### 4. Data flow / safety
- Adjusted `startMs`/`endMs` write to `captions` state exactly as the current drag does → already flow into Burn. No new persistence, no schema change, no new endpoint.
- **Does NOT modify** `tts-timing.ts`, the TTS routes, `captionsFromTtsTiming`, or any render-time timing logic. It only **reads** `silenceIntervals` and `voiceUrl`. Fail-safe: if there's no voiceUrl, no decoded peaks, or no snap points, the timeline behaves exactly as today (plain drag, no waveform).

## Edge cases

- **Before TTS / no voiceUrl:** no waveform; show nothing or a thin placeholder. Drag still works (as today).
- **Avatar / composite videos:** decode the voice track (`voiceUrl`); the waveform reflects the narration the subtitles map to.
- **Long audio:** cache decoded peaks per voiceUrl; decode off the main interaction path. Re-decode only when voiceUrl changes.
- **Re-running TTS:** voiceUrl changes → invalidate cached peaks + snap points, re-decode.
- **Decode failure (CORS / unsupported):** fail-safe to no-waveform; log once; drag still works.

## Testing / QA

- Unit-ish: a pure helper that turns `silenceIntervals` (or a peak array) into a sorted snap-point list, and a `snapToNearest(ms, points, thresholdMs)` function — covered by a `scripts/verify-*.ts` (team pattern): exact-hit, within-threshold, outside-threshold, empty-points, prefer-server-over-client.
- Live browser QA (as done for #97/#99, logged in via duckyhero): generate a Gemini clip → waveform appears under the subtitle track; drag a caption edge near a pause → it snaps + a guide line shows; generate an ElevenLabs/short clip → client-computed snap works; confirm the burned MP4 reflects the adjusted caption timing.
- `tsc --noEmit` 0 errors, `npm run build` exit 0 (editor page compiles).

## Out of scope (deferred)

- Auto "re-align all captions to the waveform" button (over-correction risk; revisit after v1 feedback).
- Editing the audio itself / trimming silence.
- Waveform-based b-roll alignment (separate ticket cmqf1x1n).

## Risk / size

Medium, **frontend-only**, low risk — reuses the existing caption-drag + captions-as-source-of-truth; the only net-new piece is rendering the waveform and the snap helper. No backend, no schema, no touching the fragile timing pipeline.
