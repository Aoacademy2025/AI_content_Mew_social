# EP5 & S2 Post-Live Studio Feature Backlog Plan (Waves 1–3)

## Context & Audit of the 17 EP5/S2 Backlog Items

Source reference: `mewic/metaads` (`docs/plans/reports/2026-10-14-live-ep5/studio-feature-backlog.md`).

### Already Shipped to Production (`main`, PRs #587–#598)
- **#2 Music that ducks under the voice (`bgmDucking` + post-render BGM change):** Shipped in PR #596 (`6414b0ca`).
- **#7 & #15 Headline & window replacements survive export:** Shipped in PR #590 (`06c99f7a`).
- **#8 Loudness normalize to −14 LUFS / −1.5 dBTP on export:** Shipped in PR #593 (`75cc27d3`).
- **#9 Fix export audio delay (4096-sample / 85.3 ms AAC priming):** Shipped in PR #588 (`97c9bd76`).
- **#10 Keep uploaded B-roll colour levels (`bt709` range/matrix):** Shipped in PR #587 (`2c6cb902`).
- **#11 Per-window hard cut (`transition: "cut"`) & `fit` mode (`cover`/`contain`):** Shipped in PR #595 (`cb9a0d39`).
- **#13 Headline position by pixel or bottom anchor (`anchor: "top" | "bottom"`, `px`/`percent`):** Shipped in PR #592 (`f4921bb8`).
- **#14 End-card hold after voice (`tailHoldMs`):** Shipped in PR #593 (`75cc27d3`).
- **#16 Media import capacity & burst allowance:** Shipped in PR #591 (`6c1c2471`).

---

## Interview Decisions (Approved by Mew, 2026-10-14)

1. **Phasing (Q1):** Deliver the 8 remaining items in 3 focused Waves:
   - **Wave 1 (Pacing, Zoom & Batch Upload):** `#4` Auto punch-in zoom, `#17` TTS speed & target duration, `#1` Tighten presenter clip on import, `#16` Batch upload links (`count` on `create_upload_url`).
   - **Wave 2 (Audio Polish & Endings):** `#3` Auto SFX (`sfx: "auto"` + `clean | viral | cinematic` kits with ~2–2.5s cooldown) and `#6` End card templates + entrance transitions + `endFade: false`.
   - **Wave 3 (Unified Visual Overlays):** `#5` Animated callout cards (`chip | badge | calendar | checklist`) and `#12` Bring-your-own alpha overlay (`PNG / alpha WebM`) unified on one safe-zone-clamped `overlays[]` track.
2. **Tighten Presenter Pace (`#1`, Q2):** Support both a 1-click preset (`tighten: true` → cuts silences > `400 ms` down to `100 ms` with `12 ms` audio crossfade + `1.10x` speed) and custom bounds (`maxGapMs: 250..2000`, `speed: 1.0..1.25`). Cut video and audio in lockstep before transcription so lip-sync and captions match 100%.
3. **Presenter Punch-In Zoom (`#4`, Q3):** Zoom the full presenter video layer (`1.00x ↔ 1.15x`, anchored around upper-center `50% 38%`) on jump cuts / sentence-window boundaries before drawing Studio's subtitle overlay layer so subtitles remain completely still without slicing the presenter's torso.
4. **TTS Speed & Target Duration (`#17`, Q4):** Support both `ttsSpeed` (`0.85x–1.25x`) and `targetDurationSec` (auto-computing speed clamped to natural `0.85x–1.20x` with a Thai `warnings[]` notice when clamped). Retime the TTS audio and scale `timing` before `prepareGeneratedTts` and `alignNarrationOnce` so subtitle alignment stays exact.
5. **Auto SFX (`#3`, Q5):** Intelligent auto mode (`sfx: "auto"` + `sfxKit: "clean" | "viral" | "cinematic"` + `sfxVolume`) placing *whoosh* on B-roll window changes, *pop* on numeric/highlighted cards, and *impact* on the ending, with a ~2.0–2.5s cooldown so rapid cuts never spam SFX.
6. **End Card + Transitions (`#6`, Q6):** Built-in Remotion end-card templates (`cta-card`, `minimal-brand`, `checklist-summary`) with title/lines/CTA/footer, entrance transition (`flash | zoom-blur | fade | cut`), automatic integration with the ending / `tailHoldMs`, and automatic `endFade: false`.
7. **Unified Overlay Track & Web + MCP Parity (`#5` + `#12`, Q7):** Share one `overlays[]` track clamped above the subtitle band (`y` safe zone) for both template callouts and uploaded alpha PNG/WebM assets, exposed in both MCP tools and Web Editor v2 across all 3 waves.
8. **Billing & Quotes (Q8):** Zero extra Hero credits for all 8 features. Quote estimation (`prepare_video_job`) accounts for `targetDurationSec` / `ttsSpeed` up front.

---

## Wave 1 Execution Plan (Current Branch: `mewic/ep5-backlog-wave1`)

### Task 1: `#16` Batch Upload Links (`create_upload_url` with `count`)
- Extend `createUploadUrlInputShape` in `src/lib/mcp/edit-tools.ts` with optional `count?: z.number().int().min(1).max(20).optional()`.
- Mint `count` upload slots in a single call (checking per-user byte/rate admission cleanly).
- Return `uploads: Array<{ uploadId, uploadUrl, expiresAt, maxBytes }>` alongside top-level `uploadId` / `uploadUrl` (first slot) so both single-slot and batch callers work seamlessly.
- Verification: `scripts/verify-mcp-batch-upload-url.ts`.

### Task 2: `#4` Auto Punch-In Zoom on Presenter (`punchZoom`)
- Add `punchZoom?: boolean` to `createVideoJobInputShape` (`src/lib/mcp/create-video-input.ts`), `setBrollStyleInputShape` (`src/lib/mcp/edit-tools.ts`), `PendingEditDraft` (`src/lib/mcp/pending-edit-draft.ts`), and `ShortVideoConfig` (`src/remotion/types.ts`).
- Build pure helper `src/lib/presenter-punch-zoom.ts`:
  - Computes alternating `1.00x ↔ 1.15x` zoom intervals from presenter ranges / caption boundaries (switching every ~3.5–5.0s at sentence/caption starts or jump-cut boundaries, anchored at `x=50%, y=38%`).
  - Generates the ffmpeg crop/scale expression for `buildCutawayCompositeFilter` (`src/lib/cutaway-composite.ts`) and React transform style for `AvatarComposition.tsx` / Web Editor preview.
- Expose toggle in Web Editor v2 style controls for presenter/avatar projects.
- Verification: `scripts/verify-presenter-punch-zoom.ts`.

### Task 3: `#17` TTS Pace & Length Target (`ttsSpeed` & `targetDurationSec`)
- Add `ttsSpeed?: z.number().min(0.85).max(1.25).optional()` and `targetDurationSec?: z.number().int().min(5).max(600).optional()` to `createVideoJobInputShape` & `prepareVideoJobInputShape`.
- Update `estimateQuoteDurationSeconds` in `src/lib/mcp/video-quote.server.ts` so `prepare_video_job` reflects `targetDurationSec` or `ttsSpeed` in the quote's duration estimate.
- Build `src/lib/tts-pace.ts`:
  - Pure `resolveEffectiveTtsSpeed({ rawDurationMs, ttsSpeed, targetDurationSec })` returning `{ speed, clamped, warning }`.
  - Pure `scaleTtsTiming(timing, speed)` that scales `audioDurationMs` and segment/word timestamps by `1 / speed`.
  - Server helper `retimeTtsAudioFile(voiceUrl, speed)` using ffmpeg `atempo` before `prepareGeneratedTts` and `alignNarrationOnce` in `src/lib/mcp/orchestrator.ts`.
- Verification: `scripts/verify-tts-pace.ts`.

### Task 4: `#1` Tighten Presenter Pace on Import (`tighten`)
- Add `tighten?: boolean` and `tightenMaxGapMs?: number` (`250..2000`), `tightenSpeed?: number` (`1.0..1.25`) to `createVideoJobInputShape` / `prepareVideoJobInputShape` (flat agent-neutral schema per G13, plus shorthand `tighten: true`).
- Build `src/lib/presenter-tighten.ts`:
  - Pure `buildTightenSegments(silences, durationSec, { maxGapMs, keepGapMs, speed })` that turns `silencedetect` intervals into speech-preserving keep-segments (`keepGapMs = 100ms` around pauses > `maxGapMs`), plus jump-cut timestamps for `punchZoom`.
  - Ffmpeg execution helper `tightenPresenterVideoFile` that trims video + audio in lockstep with `12 ms` audio crossfades (`acrossfade` / `afade`) and applies `setpts=PTS/speed` + `atempo=speed` before `transcribeUploadedClip` in `src/lib/mcp/orchestrator.ts`.
- Verification: `scripts/verify-presenter-tighten.ts`.
