# Managed-Gemini Cost Guards (defense-in-depth) — 2026-06-28

> Blocks the cost-burn hole that the 3-agent audit found before `MANAGED_GEMINI=1` can be flipped.
> Branch: `mew/managed-cost-guards` (off `mew/managed-path-ux`). All flag-gated; flag-off byte-identical.

## Decision (locked with Mew)
**Model A — "นาที = ความยาววิดีโอที่ render จริง เท่านั้น".** TTS / transcribe / keyword-gen / re-roll / preview do **NOT** deduct visible minutes (bundled in the package). Cost is bounded instead by an **invisible monthly ceiling = `minutesLimit × 2` audio-minutes** (TTS+transcribe combined), per-user rate-limits, input caps, and a Google Cloud billing cap (Mew, external).

Why not meter side-channels into minutes: it creates "ทำคลิป 2 นาที ทำไมหาย 5 นาที" confusion + chills re-rolls. Ceiling ×2 keeps clean UX; worst-case abuse ≈ heavy-normal cost (PRO ~฿85/mo, BIZ ~฿159/mo).

## Cost facts (verified Google pricing, FX 35฿/$)
- Gemini 2.5 Flash TTS audio out = $10/1M tok, 25 tok/sec → **฿0.53/นาทีเสียง** (dominant cost)
- transcribe audio in $1/1M (cheap/min, rare — TTS-path doesn't transcribe), text-gen ฿0.2–0.5/video
- Normal bundled Gemini we absorb: PRO ~฿80/mo (32% of ฿250 floor), BIZ ~฿150/mo. Margin floor stays 64–68%.
- Without a ceiling, TTS abuse = ฿3,800–6,400/abuser. With ceiling ×2 = ฿85–159/abuser.

## Layers
- **L1 — Google Cloud billing+quota cap on `GEMINI_SERVER_KEY`** (Mew, external, do regardless). Absolute backstop.
- **L2a — AI-audio-minute ceiling** (keystone): `minutesLimit × AI_AUDIO_CEILING_MULT` (default 2), shared 30-day window, atomic reserve. ✅ DONE
- **L2b — per-user inbound rate-limit / daily cap** on all Gemini-spending routes (one shared helper). ⬜ DEFERRED → fast-follow (thumbnail-ownership done)
- **L4 — input/array caps** (cap `scenes[]`, script length, `whisperWords[]`) to kill per-request amplification. ✅ DONE

## Status

### ✅ L2a — keystone (DONE, TDD, all green)
- `prisma/schema.prisma`: `User.aiAudioMinutesUsed Float @default(0)` (additive).
- `src/lib/minute-limits.ts`: `syncMinuteWindow` exported + resets `aiAudioMinutesUsed` on the SAME window as render minutes.
- `src/lib/ai-spend-limits.ts`: `aiAudioCeilingFor`, `aiAudioCeilingMult` (env `AI_AUDIO_CEILING_MULT`), `reserveAiAudioMinutes(userId, minutes, {enforce})` (atomic, mirrors reserveMinutes; `enforce:false`=BYOK no-op no-DB-write), `refundAiAudioMinutes` (clamp 0).
- `scripts/verify-ai-audio-ceiling.ts`: 22 checks (ceiling math, block-at-ceiling, refund, trial-cap 15→30, window-reset, flag-off noop). Regression: minute-meter/credits/enforcement/reset/credit-overflow all green.

### ✅ L4 — input caps (DONE, `verify-ai-input-caps` 12/12)
- `checkAiInputCaps` wired into `extract-keywords` (caps `scenes[]` — the CRITICAL amplifier), `analyze-script`, `split-phrases` (cap `script`), `align-scenes` (cap `scenes[]`+`whisperWords[]`).

### ✅ L2a wiring (DONE, tsc clean) — managed mode only (`geminiMode==="managed"`)
- `tts-gemini/route.ts`: preview path peek (`checkAiAudioCeiling`) on cache-MISS + record actual minutes; non-preview peek before generation; record actual audio-min at BOTH fail-open + success returns. BYOK → no-op (byte-identical).
- `transcribe/route.ts`: `reserveAiAudioMinutes` up-front by input-audio minutes (atomic). refund-on-failure = fast-follow (avatar/upload-only, rare).

### ⬜ L2b — rate-limit (DEFERRED → fast-follow)
- L2a (ceiling) + L4 (input caps) + L1 (billing cap) already bound catastrophic cost → broad rate-limit is hardening/stability, deferred.
- ✅ DONE now: `thumbnail` mode=suggest requires an OWNED `videoId` (closes the no-resource loop-burn vector).
- TODO fast-follow: shared per-user limiter (DB-backed, single-box) keyed on user.id on all Gemini routes (burst/RPM protection + cheap-text-endpoint frequency) + transcribe refund-on-failure + preview cache by fixed text.

## Go-live note
Deploy bundle **flag-OFF = safe now** (BYOK, user pays). These guards gate only the `MANAGED_GEMINI=1` flip. Flip order unchanged (see [[managed-gemini-cost-abuse-2026-06-28]] memory): GEMINI_SERVER_KEY + 4 flags together + rebuild.
