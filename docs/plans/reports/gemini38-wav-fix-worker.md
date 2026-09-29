# Gemini WAV decoding worker report

Status: implementation complete; independent review and final build pending. No deploy, push, production write, paid provider request, tracker update, or rollout expansion performed.

## Scope and behavior

- `callGeminiTts` now normalizes supported RIFF/WAVE containers into mono signed 16-bit little-endian PCM. It scans declared chunk sizes and padding, validates the RIFF length and PCM format/rate/alignment, rejects duplicate or missing audio/format chunks, and excludes non-audio chunks including C2PA. WAV format sample rate overrides MIME hints. Legacy raw L16 sample bytes remain unchanged.
- Invalid/truncated/unsupported media returns a bounded 502 provider failure without retrying the malformed successful response. Existing route failure/refund/fallback logic remains responsible for recovery. Unsupported float, extensible, stereo, other sample widths, RIFX/RF64, and non-L16 raw payloads are rejected rather than guessed.
- Removed waveform-based tail truncation. The existing 120 ms end fade remains and preserves the sample count. The old live-key-dependent heuristic test is now an offline regression against deleting valid loud speech after a pause.
- Preview cache version is v3, bypassing v2 without deleting existing media. The actual route regression seeds a malformed v2 file, verifies regeneration and later v3 cache hits, and confirms the old file remains unchanged.
- Preview, segmented, guard-retry, and fallback output is measured from final decoded PCM. A six-segment fixture exposed cumulative millisecond rounding drift; the route now rounds cumulative sample boundaries so the combined timeline matches the written WAV within half a millisecond.
- The route regression executes the actual handler and helper with synthetic provider responses and inert authentication, database, filesystem, telemetry, billing, and ffmpeg I/O. It verifies internal neutral 3.8, internal styled 2.5, external unchanged 2.5/style behavior, saved WAV samples, fallback on malformed media and sample-rate changes, and guard replacement timing. ADR 0056 fail-open remains unchanged.
- Registered the offline suite as `npm run verify:gemini-tts-audio` and in CI. No new dependency.

## Red/green evidence

All fixtures are synthetic; no production audio, user identities, prompts, or credentials copied.

1. Before production edits, `./node_modules/.bin/tsx scripts/verify-gemini-tts-audio.ts` exited **1** on the actual helper: `WAV/C2PA container bytes must never become audio samples`, actual **15,704**, expected **9,600**. Raw 2.5 L16 control passed first.
2. Before production edits, the tail regression failed: `a quiet gap followed by loud speech must not be trimmed`, actual **51,840**, expected **64,800** bytes. The Node assertion failure was captured; initial shell combined its output read with the test, so the enclosing command returned 0 from `cat`, not from the failed test.
3. Before cumulative rounding correction, the actual six-segment route regression exited **1**: `reported duration matches final sample count`. The final concatenated WAV and sum of independently rounded durations differed by more than 1 ms.
4. After fixes, the full offline suite exited **0**. Coverage includes 27 malformed/unsupported media cases; standard/extended PCM fmt headers; metadata before and after data; odd metadata padding; WAV delivered under L16 MIME; sample-rate authority; unchanged raw L16; preview and cache; single and six-segment output; guard retry; malformed and rate-change fallback.

## Verification commands

Run from the assigned Orca worktree on branch `codex/gemini38-wav-decoding-fix`.

| Command | Exit | Result |
| --- | ---: | --- |
| `npm run verify:gemini-tts-audio` | 0 | Helper, decoded tail, actual route, existing empty-audio retry, existing segmentation checks pass |
| `./node_modules/.bin/tsx scripts/verify-tts-timing.ts` | 0 | Existing timing contracts pass |
| `./node_modules/.bin/tsx scripts/verify-avatar-caption-fallback.ts` | 0 | Existing ADR 0056 subtitle fail-open checks pass |
| `./node_modules/.bin/tsc --noEmit --incremental false` | 0 | Full project typecheck after local Prisma generation |
| `./node_modules/.bin/eslint src/lib/gemini-tts-provider.server.ts src/lib/pcm-tail-fade.ts src/app/api/videos/tts-gemini/route.ts scripts/fixtures/gemini-audio.ts scripts/verify-gemini-tts-audio.ts scripts/verify-tts-tail-trim.ts scripts/verify-tts-gemini-audio-route.ts scripts/verify-gemini-tts-no-audio.ts` | 0 | All changed TypeScript files lint clean |
| `git diff --check` | 0 | No whitespace errors |
| `DATABASE_URL=file:./ci.db ./node_modules/.bin/prisma generate` | 0 | Generated client only in isolated dependency copy; no DB connection/migration |

Setup/verification corrections: initial typecheck exited **2** with missing generated Prisma types (e.g. `Module '@prisma/client' has no exported member 'User'`). The borrowed dependency symlink was removed and replaced by an APFS clone (`cp -cR`, exit 0), then Prisma generated locally; typecheck passed. Initial lint found `@next/next/no-assign-module-variable` in the test harness; renamed to `subject`, rerun clean. Harness setup also initially rejected an unlisted pure Thai compound dependency and used an inconsistent synthetic clock; both were corrected before route assertions passed. No source changes were needed for those environment/harness failures.

## Remaining gate and limits

Full build is deliberately deferred until review fixes settle, per approved plan. No listener scoring, real provider probe, production cache regeneration, or public load test was performed. Already generated media remain unchanged. Keep the current internal rollout; production deployment and subsequent listening/long-narration checks remain separate release decisions.
