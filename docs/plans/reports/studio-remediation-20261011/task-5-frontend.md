# Task 5 — first-clip recovery, editor diagnosis, subtitle follow-up

Baseline: `149efd9647911821ba90f1eede601e141afb2f67`. Worktree `frontend-fix-20261011`, branch `codex/frontend-fix-20261011`. No production mutation, customer media inspection, export, generation, deployment, or external record write.

## HERO-77: reproduced and fixed

The actual `FirstClipConvertPrompt` mounted in React, then received `hero-first-clip-viewed`. A synthetic fetch rejection (`TypeError: Load failed`) escaped `Promise.all` through `void load()`, producing the browser's `unhandledrejection`, exactly matching WEB-1G's load/openGate frames. The regression before implementation failed exit 1 with `actual: ['Load failed'], expected: []`.

Ranked explanations before implementation: (1) conversion fetch rejection escapes the unawaited load (confirmed); (2) profile lookup fails (not required for reproduction and already caught); (3) JSON/application fault is misclassified (separate negative fixtures distinguish it). Confidence high for this reproduced mechanism; the user's original network outage cause is not established or changed.

The fix handles only recognized browser fetch TypeErrors (`Load failed`, `Failed to fetch`, Firefox's `NetworkError when attempting to fetch resource.`) on the conversion request. That optional lookup returns no response for that attempt. No dismissal/cooldown or retry latch is set; the next clip event retries. JSON parsing and unrelated application exceptions, including other TypeErrors, remain observable. HTTP non-success behavior remains unchanged. No global exception filter, retry loop, new API, or dependency.

The regression runs the real component, authenticated-fetch wrapper, profile fetcher, reveal gates, and DOM with stubbed external auth/navigation/telemetry boundaries. It exercises viewed, completed, delayed exported-view, and armed-session mount entry paths; all recover and render the prompt after a successful later event. All fetches are local synthetic responses. Tests use existing esbuild/Puppeteer dependencies.

Integration proposal (coordinator owns package/CI): append `tsx scripts/verify-first-clip-convert-recovery.tsx` to `verify:first-clip-convert`, or add an explicit browser-test CI invocation on a Chrome-equipped runner. No shared package/CI file was edited here.

## HERO-46: no reproduced root cause; no speculative application patch

Reused the real `EditorV2Shell` production React probe. Existing-project keyboard input, new-project reset, paste, synthetic composition and autosave all passed. Extended that existing harness to hold an older PATCH response while 120 keyboard edits cross the same `Step1Script.onChange → useV2Project.setScript` path, release the response, then verify the newest script autosaves and remains in the textarea. This also passed, with no maximum-update-depth error. Sensitivity checks inject both React production #185 and development maximum-depth signatures; both correctly make the probe fail.

An authorized read-only Sentry read of the latest WEB-13 event (2026-10-10 08:07:56 UTC) found context keys only `culture`, `react`, `trace`; **no editor_diagnostics, browser, or OS context**. Release was `149efd9647911821ba90f1eede601e141afb2f67`; React `19.3.0-canary-cbb046ab-20260731`, exactly matching the diagnostic's bundled runtime. Only allowlisted metadata was emitted; no raw event, request, user, breadcrumb or customer payload was persisted.

This evidence does not establish a cause. Missing discriminating evidence:

1. First matching depth exception of the same editor mount, with existing bounded `editor_diagnostics` (`phase`, lifecycle, recovery/revision/save/input enums, composition, focus, mount count). The collector intentionally attaches once per mount, so absence on this later event does not prove instrumentation is absent. Do not expand its budget or privacy envelope speculatively.
2. Whether that first event occurred before effect activation, after teardown, or from a different loaded client module; verify actual served chunk/build provenance, not just release metadata. A synthetic staging reproduction should exercise the full production Next layout/router/hydration and the reported recovery/input enum combination when obtained.
3. Browser/OS and native IME sequence if composition is implicated; the current browser harness uses Chromium and synthetic composition with mocked service responses, not a full production route or native OS IME.

No ranked root-cause claim is offered without a red production-symptom loop. The local passing probes rule out these bounded triggers as sufficient causes, not HERO-46 itself. Retain In Progress.

Harness development corrections: one run failed a cursor-position fixture assumption (Mac End key), corrected by setting the textarea selection explicitly; another timed out because the fixture reused the deliberately single-use diagnostic attachment to wait for save completion. Corrected the fixture to await the actual latest PATCH and two rendering frames. Neither was the production maximum-depth symptom; neither prompted application code changes.

## HERO-51 / HERO-11: concrete QA follow-up, unchanged policy

Audit snapshot: create done 235 / warning 68; export done 127 / warning 58 (36 unverified timing, 14 text mismatch, 7 spacing, 1 punctuation). Acoustic 96 attempts (69 partial, 27 timeout) and verification 96 events (62 aligned, 34 failed) overlap stages/subsets. These counts do not establish 96 bad clips or any perceptual defect rate.

HERO-51 concerns long-narration bounded alignment/partial evidence; HERO-11 concerns uploaded-audio clock behavior. Review evidence includes the existing HERO-51 plan, the October 11 operational audit's canonical mapping and ADR 0056. Keep the two cohorts separate until per-job source/clock evidence connects them. Existing partial-alignment and acoustic-clock fixtures pass; this is functional evidence, not perceptual quality acceptance.

For later explicitly permitted media sampling:

- Build a private sample manifest using opaque local sample labels, never raw identities/scripts/URLs in reports. Stratify generated narration (HERO-51) versus uploaded narration (HERO-11), short/long duration bucket, selected clock, and warning code. Include aligned/no-warning controls and partial/timeout/unverified cases. Deduplicate creates and their exports; report unique source clips and attempts separately.
- Select at least one permitted example for each observed warning family. For timing, inspect beginning/middle/end and every partial-chunk join or long pause. Record spoken onset versus displayed card onset/end as numerical milliseconds, clock provenance, completed-chunk coverage, tail drift and missing/overlapping cards. Compare against persisted timing evidence; a timeout by itself is not a visible sync failure.
- For text mismatch, distinguish creator edits at export from transcription differences, missing/added spoken words or numbers, whitespace-only and punctuation-only changes. Record only category/count/delta in the shareable report. Preserve the original caption text; do not normalize away a meaningful word/number mismatch to make QA pass.
- Use existing artifacts only; no new export/paid generation. Require a human timing/text verdict on the permitted samples before proposing any clock change. Compare warning cases against controls; document sample size and selection limitations.
- For reproducible synthetic fixtures, extend the existing partial-alignment/acoustic-clock seams with fixed words/times for a long pause, a completed first chunk plus stalled second chunk, a repeated Thai phrase near a chunk boundary, zero usable words, and creator whitespace/punctuation edits. Assert immutable narrative text, monotone bounded timing, valid partial anchors only, deterministic fallback for invalid evidence and warning jobs completing. Existing `verify-partial-alignment.ts` and `verify-acoustic-subtitle-clock.ts` already cover partial/invalid evidence and immutable text.

ADR 0056 remains intact: warning is a report, only empty script/captions block; no new gate, budget increase, retries, TTS spend, export realignment or historical rewrite. This checklist is proposed future sampling, not a claim media was reviewed.

## Verification

| Command | Exit | Evidence |
|---|---:|---|
| `tsx scripts/verify-first-clip-convert-recovery.tsx` before fix | 1 | Viewed event emits unhandled `Load failed` |
| same command after fix | 0 | Four paths recover; three browser error signatures; application/TypeError/JSON remain observable; HTTP recovers |
| `tsx scripts/verify-first-clip-convert.ts` | 0 | Existing conversion eligibility, reveal and UI assertions pass |
| `tsx scripts/verify-editor-script-loop.tsx` baseline + extended | 0 | Production React actual interactions; NO_REPRO, including delayed autosave stress |
| `tsx scripts/verify-editor-script-loop-sensitivity.ts` | 0 | Both injected maximum-depth signatures rejected by harness |
| `tsx scripts/verify-partial-alignment.ts` | 0 | ALL PASS |
| `tsx scripts/verify-acoustic-subtitle-clock.ts` | 0 | Regression/partial/immutable text/pause/invalid evidence PASS |
| `tsc --noEmit --incremental false` | 0 | Type check passes |
| ESLint two changed browser scripts | 0 | No findings |
| ESLint conversion component | 1 | Pre-existing `react-hooks/set-state-in-effect` at armed session `setExportedViewShown(true)`; same finding on baseline via `git show HEAD:...` piped to ESLint |

Component lint failure excerpt: `Error: Calling setState synchronously within an effect can trigger cascading renders` at current line 121 / baseline line 114. That effect is unchanged. No new exception waiver added. Full production build is left to the coordinator's integration gate; no claim of a production fix deployment.
