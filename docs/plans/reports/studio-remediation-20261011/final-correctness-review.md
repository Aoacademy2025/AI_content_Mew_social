# Final integrated correctness review — 2026-10-11

Verdict: **PASS** for reviewed integrated commit `e18347411307e6b38abb93544c67e760190d97f7` against baseline `149efd9647911821ba90f1eede601e141afb2f67`. No blocking medium-or-higher correctness or regression findings. The source and test target was `057cea77d83e997ccdbbb41fd5c97fa5fd0722e0`; the subsequent `e1834741` commit adds only the integration evidence report. This review used an independent Orca worktree and did not edit implementation code.

## Cross-component assessment

- **HERO-72:** `makeTargets` now emits a shared start for a gap the coverage policy accepts, so generation and render coverage share contiguous geometry. The merge exception requires unchanged source edges on consecutive 30 fps ticks. Other gaps, overlaps, moved edges, invalid bounds, and source validation still follow existing guards. Presenter playback takes its offset from the emitted timeline cursor; no narration or caption clock changed. The saved legacy one-frame gap remains in the merged config and is filled during render coverage.
- **HERO-78:** The actual video-scene catch labels recognized local SQLite contention `DB_CONTENTION`. `HeroImageGenerationError` takes precedence, retaining genuine provider code and stop behavior. Retry and refund decisions use unchanged `retryable`, `systemic`, and `stopBatch` fields rather than this label. This is an error taxonomy correction; SQLite contention and HERO-10/HERO-70 are unresolved.
- **HERO-77:** The conversion lookup alone absorbs recognized browser fetch `TypeError` messages. Its next clip event can retry. JSON parsing, unrelated application errors and unrelated `TypeError`s still reject, while HTTP non-success retains its prior quiet behavior. The production authenticated-fetch wrapper remains in the real-component browser regression.
- **HERO-46:** Only the editor diagnostic harness changed. Its delayed-save sequence and sensitivity probe do not establish or claim a production fix. The integration report and proposed PR text state this limit accurately.
- **CI and packaging:** The new browser and scene regression scripts are appended to package commands already invoked by `.github/workflows/ci.yml`; the B-roll regression is imported by the existing timeline command. The browser harness awaits Puppeteer's managed executable path on non-macOS. CI uses Node 22/Ubuntu and `npm ci`, whose Puppeteer postinstall is available; the integrator's forced managed-path red/green probe supports the fix, but is not a Linux CI run. No dependency, lockfile, or workflow change is needed for the wiring.

## Independent verification

`package-lock.json` matched the integrated worktree byte-for-byte (exit **0**) before using its ignored dependency cache. In this review worktree at `e1834741`:

| Check | Exit | Evidence |
| --- | ---: | --- |
| `npm run verify:first-clip-convert` | 0 | Existing conversion checks and new real React recovery harness pass, including later-event retry and observable JSON/application faults. |
| `npm run verify:hero-image-scene-retry` | 0 | Existing retry check and new actual-scene-callback classification check pass. |
| `npm run verify:broll-timeline` | 0 | Shared-boundary, new 21-window frame-gap regression, and prior boundary drift pass. |
| `git diff --check 149efd96 e1834741` | 0 | No whitespace errors. |

The integrator separately recorded 15 suite commands, sequential typecheck, and two production builds at exit **0**. I did not repeat the full build or 15 suites. The scoped ESLint exit **1** is the unchanged baseline conversion effect rule, with baseline comparison recorded in integration.md. Local execution used Node 26/macOS; remote Node 22/Linux CI has not yet run.

## Advisory

The new browser regression starts its local HTTP server before `puppeteer.launch` and enters `try/finally` only after launch. If Chrome launch itself rejects, that local server can keep the test process alive until CI timeout. The installed-browser and forced managed-path probes both launched successfully, so this does not block this branch, but moving launch inside a cleanup-protected scope would make the test fail promptly on a future runner setup failure.

The integration report's PR description accurately separates repaired behavior from unresolved HERO-46 and SQLite root causes. No PR, push, merge, deployment, production access, or customer-data operation was performed by this reviewer.
