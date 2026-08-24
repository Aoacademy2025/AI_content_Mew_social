# Phase 2 — Minute-Quota Enforcement (clips → minutes-by-duration)

> Branch: `mew/managed-path-ux`. NEW flag `MINUTE_QUOTA` (`process.env.MINUTE_QUOTA === "1"`, default OFF → byte-identical to current clip-cap). ON = minutes-by-video-duration quota for everyone, retire clip-cap. Deploy WITH the new model. Reuse existing reserve/refund/ChargedClip machinery — swap unit only.

## Locked rules (Mew)
Quota = minutes, all users, count at RENDER by output duration, **ceil to whole min (min 1)**, once per video (ChargedClip anti-double-charge), refund on ANY no-valid-output (system/user/cancel/supersede/invalid). ElevenLabs videos COUNT (render-load) even though their TTS cost is $0 to us.

## Exact integration map (from Explore)
- `render/route.ts`: duration from `requestedDurationSec` (~299) / `durationInFrames` (~398) / `safeDuration` (~397, defaults 60). Precheck `checkClipQuota` ~281; reserve `reserveClipUsage` ~382 (gated `!burnAlreadyPaid`, sets `quotaReserved`); refunds ~844 (`refundReservedClip` fn, used by supersede + render-error ~1013) + ~1062 (setup error); record `recordChargedClip` ~993 (gated `quotaReserved && !isSubtitleOverlay`).
- `clip-charge.ts`: `recordChargedClip(userId, outputUrl)`, `isBurnAlreadyPaid`; `ChargedClip` model (schema ~446).
- `tts-gemini/route.ts`: `reserveMinutes` ~427 + ~453 (gated `geminiMode==="managed"`) → must SKIP when MINUTE_QUOTA on (render reserves instead; avoid double-count).
- `generate/route.ts`: reserve ~95, refund ~156 (avatar; duration = narration/audio duration, known after TTS).
- `job-store.ts`: reserve ~34 (`input.reserveQuotaFor`), refunds ~102 (supersede) + ~224 (failRenderJob); uses `RenderJob.reservedQuota`.
- `minute-limits.ts`: `reserveMinutes(userId, minutes)`, `refundMinutes(userId, minutes)`, `checkMinuteQuota(userId)` already exist.

## Schema (additive, nullable → flag-off unaffected)
- `ChargedClip.chargedMinutes Int?` (minutes charged for this video; null = clips-mode/legacy).
- `RenderJob.reservedMinutes Int?` (minutes reserved for a queued job; for exact refund).

---

### Task 1: Schema + duration helper + recordChargedClip signature (foundation)
**Files:** `prisma/schema.prisma` (+2 nullable fields); `src/lib/minute-limits.ts` (+`minutesFromSeconds`); `src/lib/clip-charge.ts` (`recordChargedClip` optional `chargedMinutes`); Test `scripts/verify-minute-enforcement.ts`.
- [ ] Add `chargedMinutes Int?` to `ChargedClip`, `reservedMinutes Int?` to `RenderJob`. `npx prisma db push` + `npx prisma generate`.
- [ ] `minute-limits.ts`: `export function minutesFromSeconds(sec: number): number { return Math.max(1, Math.ceil((Number.isFinite(sec) && sec > 0 ? sec : 60) / 60)); }`
- [ ] `clip-charge.ts`: `recordChargedClip(userId, outputUrl, chargedMinutes?: number)` — store `chargedMinutes` when given (additive; existing 2-arg callers unaffected).
- [ ] TDD `scripts/verify-minute-enforcement.ts`: `minutesFromSeconds`: 90→2, 60→1, 30→1, 0→1, 150→3, 360→6; `recordChargedClip(u,url,3)` then read → chargedMinutes=3; 2-arg call → chargedMinutes null. Run→fail→implement→pass. tsc 0. Commit.

### Task 2: render route — flag-gated clips→minutes (CORE — opus impl + opus review)
**File:** `src/app/api/videos/render/route.ts`.
- [ ] `const useMinuteQuota = process.env.MINUTE_QUOTA === "1";` Compute `reservedMinutes = minutesFromSeconds(requestedDurationSec ?? safeDuration)`.
- [ ] Precheck (~281): when useMinuteQuota → `checkMinuteQuota` else `checkClipQuota` (keep `!burnAlreadyPaid` gate, keep `quotaExceededResponse`).
- [ ] Reserve (~382): when useMinuteQuota → `reserveMinutes(userId, reservedMinutes)` else `reserveClipUsage(userId)`. Set `quotaReserved`/`reservedUserId` same.
- [ ] Refund fn (~844 `refundReservedClip`) + setup-error (~1062): when useMinuteQuota → `refundMinutes(userId, reservedMinutes)` else `refundClipUsage`. (Same trigger conditions/guards.)
- [ ] Record (~993): `recordChargedClip(userId, videoUrl, useMinuteQuota ? reservedMinutes : undefined)`.
- [ ] Verify flag-off byte-identical (all changes inside `useMinuteQuota` branches). tsc 0. Commit.

### Task 3: tts-gemini skip + generate + job-store (avoid double-count; cover avatar/queue)
**Files:** `tts-gemini/route.ts`, `generate/route.ts`, `job-store.ts`.
- [ ] tts-gemini ~427/~453: add `&& process.env.MINUTE_QUOTA !== "1"` to the reserve guard (skip when render reserves). (Keep the `geminiMode==="managed"` path when flag off.)
- [ ] generate/route.ts ~95/~156: when useMinuteQuota → reserve/refund minutes by narration duration (derive from the audio/script duration available there); store for refund.
- [ ] job-store.ts ~34/~102/~224: when useMinuteQuota → reserve/refund minutes; persist `RenderJob.reservedMinutes` for exact refund.
- [ ] Verify flag-off byte-identical. tsc 0. Commit.

### Final: whole-branch review (opus) — flag-off byte-identical across ALL paths; no double-count when on; refund on every fail path; once-per-video. Then STOP (no prod).
