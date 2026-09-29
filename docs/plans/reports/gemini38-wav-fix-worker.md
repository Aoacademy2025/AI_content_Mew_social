# Gemini WAV decoding worker report

Status: implementation complete; review round 1 corrected; final build of corrected source pending.

Initial implementation commit: `ab2ca5e5b7287370ffd96130090dbc6355c44cbe`. No deploy, push, production write, paid provider request, tracker update, or rollout expansion performed.

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
4. After fixes, the full offline suite exited **0**. Coverage includes 31 malformed/unsupported media cases (including four added during review); standard/extended PCM fmt headers; metadata before and after data; odd metadata padding; WAV delivered under L16 MIME; sample-rate authority; unchanged raw L16; preview and cache; single and six-segment output; guard retry; malformed and rate-change fallback.

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

The initial implementation passed the full build; the corrected parser is queued for a final build. No listener scoring, real provider probe, production cache regeneration, or public load test was performed. Already generated media remain unchanged. Keep the current internal rollout; production deployment and subsequent listening/long-narration checks remain separate release decisions.


## Review fix round 1 and build evidence

The task reviewer reproduced a high-bit FourCC alias: Node ASCII decoding strips the high bit, so malformed bytes could compare equal to RIFF, WAVE, fmt or data. Added four actual-helper regression fixtures before fixing; the test exited **1** (`high-bit alias of RIFF: invalid media must fail safely`, actual true). Changed only the three identifier reads to byte-preserving Latin-1 plus an explanatory comment. The focused suite, scoped lint and `git diff --check` then exited **0**.

`npm run verify:build-worker-config` exited **0**. For the full build, Orca had copied local `.env` files into the worktree: the first attempt was stopped during compilation (exit **143**) after noticing Next loaded `.env`. The worktree copies were temporarily renamed, then the build rerun under a cleared environment with only PATH, HOME, `DATABASE_URL=file:./ci.db`, `NEXT_DISABLE_ESLINT=1`, `NEXT_TELEMETRY_DISABLED=1`, and `CI=true`. No secrets were supplied to the rerun; Sentry confirmed no auth token and no release upload. That isolated `npm run build` exited **0**: compiled in 52 s, TypeScript completed in 21.2 s, and all 193 static pages generated. This build predates the three-read FourCC correction; final corrected-source build remains required. Existing Node deprecation/Sentry-without-token notices are nonblocking. Build log is local `/tmp/gemini38-wav-build-isolated.log`, not committed.
