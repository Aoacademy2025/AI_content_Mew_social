# Hero Script duration target — 2026-09-06

## Approved scope and acceptance

The selected 30/60/90 seconds is a narration target with ±10% tolerance (30 → 27–33 seconds). Control the script before TTS, then measure Gemini audio on 3–5 stories. This branch prepares a reviewable PR; merge and deployment remain a separate decision.

- Count the complete spoken script, including the fixed hook and CTA.
- Use one shared estimate in prompts, server screening and the Script editor. Show the estimate as approximate; actual generated audio remains authoritative.
- On an out-of-range generated script, request at most one text correction. It shares the existing correction allowance with banned words and does not add a nested retry loop.
- Preserve the selected hook verbatim during full generation. Section regeneration changes only the requested section. Normalize an echoed hook before counting delivered text.
- Retain valid output and show a warning if correction remains out of range or yields invalid JSON. Recompute visible feedback for manual edits and reopened drafts; saving and editor handoff remain available.
- Preserve narration, subtitle and export contracts (ADR 0056): no new TTS regeneration, speed change, clipping, alignment call or quality gate.

## Reproduced defect

The existing production generation guard accepted complete scripts of 179 and 189 words with a 30-second target and the old 120-word budget. JSON validity and banned-word screening did not check duration. The new regression first failed with 525 passed / 2 failed before implementing the correction.

A retained production video requested at 30 seconds measured 43.178667 seconds with ffprobe. This is measurement of a retained artifact, not a fresh generation.

Fresh local Gemini audio of two saved synthetic Script QA outputs measured 70.330958 seconds (179 words, Kore) and 62.890958 seconds (189 words, Aoede). Both used one chunk and gemini-2.5-flash-preview-tts. A separate diagnostic holding legacy text/voice constant but replacing newlines with spaces measured 58.770958 seconds. This single stochastic comparison suggests pause/layout sensitivity; it does not isolate an exact causal pause penalty. No production audio was edited.

## Implementation

Hero Script now starts from 3 words/second including narration pauses, replacing its use of the legacy content generator's 4 words/second. The estimate is a writing aid, not an audio guarantee. Full generation and section regeneration share one combined duration/banned-word correction. The correction states the measured Thai word count, fixed-section budget and required percentage change in editable text.

The provider-call ceiling and billing reservation remain unchanged: at most two guard callbacks, each using the existing two-attempt JSON validator. Existing provider transport retries are also unchanged. No schema changes.

## Local provider measurement

Calibration used five predefined synthetic scenarios, then validation used five different, predefined scenarios. Each produced one audio take per final script; all outcomes are retained, including failures. Text generation used the locally configured Gemini `gemini-pro-latest`; production’s effective provider/model has not been verified. Speech used the actual Gemini TTS provider function with Kore/Aoede. Multi-chunk results concatenate unchanged PCM at one sample rate with a pinned model. This is local service/provider QA, not a Browser E2E, production route, billing or render test.

Calibration (initial 2.8 words/second estimate, before the percentage-based correction note):

| Scenario | Target | Words | Text warning | Actual seconds | Within ±10% |
|---|---:|---:|---|---:|---|
| desk-30 (Kore) | 30 | 83 | no | 26.130958 | FAIL |
| coffee-30 (Aoede) | 30 | 109 | yes | 37.610958 | FAIL |
| backup-30 (Kore) | 30 | 91 | no | 28.250958 | PASS |
| plant-60 (Kore) | 60 | 216 | yes | 65.581917 | PASS |
| umbrella-90 (Aoede) | 90 | 310 | yes | 85.141917 | PASS |

Validation (3 words/second and percentage-based correction, five new stories frozen before generation):

| Scenario | Target | Words | Text warning | Actual seconds | Within ±10% |
|---|---:|---:|---|---:|---|
| keys-30 (Kore) | 30 | 94 | no | 26.890958 | FAIL |
| lunch-30 (Aoede) | 30 | 104 | yes | 39.850958 | FAIL |
| files-30 (Kore) | 30 | 82 | no | 27.570958 | PASS |
| bag-60 (Kore) | 60 | 166 | no | 54.610958 | PASS |
| book-90 (Aoede) | 90 | 314 | yes | 111.981917 | FAIL |

Validation passed **2/5** actual-duration targets. Keys-30 is a strict failure even though it misses the lower bound by only 0.109042 seconds; no rounding into a pass. Lunch and Book remain over the word budget after correction and correctly return warnings. Keys shows that an in-range word count is not sufficient to guarantee audio duration. Calibration and validation used different stories, so their pass rates are not a controlled before/after comparison.

All 13 local audio artifacts are retained: two baseline outputs, one newline diagnostic, five calibration outputs, five validation outputs. Multi-chunk synthesis used 16 successful provider invocations in total, each on the first provider attempt. No audio take was discarded or regenerated to meet duration. The original retained production video is additional evidence, not one of these local generations.

## Readiness and next investigation

**Keep PR #449 in Draft. Do not merge or deploy this as a completed audio-duration fix.** The deterministic screening/correction behavior is implemented, but measured narration still misses the target in 3/5 validation stories. Neither passing code checks nor warnings close this QA gap.

The remaining work has two separate signals: Thai text correction sometimes still exceeds the requested word band (104 vs maximum 99; 314 vs maximum 297), and narration pacing varies enough that an in-band script can miss the audio band. The next experiment should first verify stronger text-budget compliance without increasing the correction allowance, then isolate narration pacing using fixed compliant scripts across the chosen voices. Hero Script does not know the final voice selected in the Editor, so a voice-specific duration promise cannot be justified at this stage. Avoid fitting a per-voice estimate to one stochastic take or widening tolerance to hide failures.

This PR has not been merged or deployed. No Linear or Sentry records changed; the earlier MP4 incident remains tracked separately as HERO-7.


## Verification

- `npm run verify:hero-script` on Node 22.22.2: 541 passed / 0 failed, plus access verification passed. Covers word boundaries, combined-retry limits, fallback, fixed sections and echoed hooks.
- TypeScript `--noEmit` passed on the final code. Node 22.22.2 local production build passed before the last echoed-hook extraction refinement; GitHub CI checks the final commit separately.
- Scoped lint found six existing React compiler purity/ref findings in ScriptEditorStep. The untouched base version produces the same six findings. No new lint finding in the changed server/prompt/helper/test files.
- Standards review: 0 blocking / 0 advisory findings. Spec code review: 0 blocking / 0 advisory findings. Both distinguish code conformance from the failed actual-audio target.
- No human listening, pronunciation scoring, subtitle synchronization or image relevance QA is claimed by this duration measurement.

Local evidence: `/Users/mewsocialmacmini/orca/artifacts/hero-script-duration-2026-09-06` (raw synthetic scripts/audio, calibration/validation manifests, regression red/green logs and build/check logs). No provider credentials or customer content are included in this document.

Provider evidence correction: the earlier production audit explicitly states that effective text-provider configuration was not read (`hero-sentry-audit-2026-09-06/PRODUCTION-LOG-FINDINGS.md`, line 19). The claim that production uses OpenRouter is withdrawn. Repository support for OpenRouter does not establish which provider production currently uses, and OpenRouter access is not a prerequisite for the independent narration measurements.

## Follow-up: fixed-script voice comparison

Two additional diagnostic takes kept script text, Gemini model and single-chunk flow fixed, and changed only the selected voice:

| Script | Words | Previous voice / seconds | Alternate voice / seconds |
|---|---:|---|---|
| lunch-30 | 104 | Aoede / 39.850958 | Kore / 29.890958 |
| keys-30 | 94 | Kore / 26.890958 | Aoede / 27.210958 |

Independent ffprobe measurements confirm the new PCM durations. This is exploratory evidence from one take per condition: stochastic generation remains a confounder, and these differences are not a calibrated per-voice coefficient. The results show why word count alone cannot certify audio duration. They do not establish that OpenRouter is involved, nor justify silently changing a creator's voice.

These two takes are retained in addition to the earlier thirteen artifacts. The original five-story validation remains 2/5; alternate voices are not substituted into that score. No additional production code changes were made in this follow-up. The next controlled duration experiment can proceed independently of any OpenRouter access.

## Approved continuation: correction options and Editor preflight

Mew approved continuing the rewrite fix, measuring narration pace using fixed scripts, checking the target with the selected voice before TTS, a new five-story QA run, and review/CI before proposing merge/deploy. No merge, deploy or production SSH is authorized by this continuation.

- Duration correction now requests three complete drafts in the existing single correction callback. The server validates each independently and selects by banned-word safety, then measured distance from the word budget. The original remains eligible so a worse correction cannot replace it. No sentences or sections are spliced between candidates. Invalid correction output retains the first valid result and its warning.
- Callback count stays bounded: one initial generation plus at most one correction, each using the existing JSON validator. The correction output cap is 4,096 tokens for 30 seconds and 8,192 for 60/90 seconds. Provider token cost can increase, although the application call reservation and number of provider round-trips are unchanged.
- Hero Script's selected duration was previously lost at Editor handoff. It now travels as nullable `scriptTargetDurationSec` inside the existing draft JSON, survives edits/autosave/reopen, and clears on a new project. No database schema migration. Uploaded media duration remains independent.
- The voice-selection step shows an advisory target notice that follows the current script and voice. It never calls TTS, changes text/voice, blocks submission or changes billing estimates. Old drafts without a target show no invented target.
- Fixed-script voice comparison now covers all five prior validation scripts with Kore and Aoede. Rounded empirical pace centers/envelopes are Kore 3 words/s (2.9–3.5) and Aoede 2.8 words/s (2.5–3.5). These are approximate observations, not confidence intervals or guarantees. They apply only to predominantly Thai, direct Gemini narration; other voices, languages and avatar narration receive an explicit unknown estimate.

### New validation set

Five different scenarios were frozen before generation. Each used the local configured Gemini writing model and one audio take per resulting script, with the same production generation/guard/validator/TTS helpers. This is local service integration QA, not production Browser E2E. No effective production writing-provider claim is made.

| Scenario | Target | Words | Word band | Actual seconds | ±10% audio |
|---|---:|---:|---|---:|---|
| laundry-30 (Kore) | 30 | 102 | FAIL | 31.210958 | PASS |
| train-30 (Aoede) | 30 | 97 | PASS | 34.370958 | FAIL |
| photo-30 (Kore) | 30 | 92 | PASS | 28.330958 | PASS |
| fridge-60 (Kore) | 60 | 195 | PASS | 56.490958 | PASS |
| bench-90 (Aoede) | 90 | 253 | PASS | 71.501917 | FAIL |

Word-band compliance is 4/5; actual narration is 3/5. Laundry exceeds the 99-word ceiling with 102 words; the two audio failures remain failures. The earlier prose incorrectly reported 5/5 word-band compliance; the table and retained measurements were correct. A separate, unprompted ASR check against all five files yields 98.1–100% ordered character coverage after punctuation/combining-mark normalization. It provides no evidence of a large missing passage in the short 90-second story. ASR is not human listening, pronunciation certification or proof of word-perfect coverage, and it triggers no TTS regeneration.

The earlier validation score is not replaced. All 23 local audio files are retained across the baseline, calibration, validation and crossover experiments. The new five-story results do not demonstrate a reliable ±10% audio guarantee. PR449 remains Draft pending the remaining narration-duration acceptance question.

### Continuation verification

Regression tests first failed for correction selection (541 passed / 2 failed) and for lost handoff duration (543 passed / 1 failed). Final Hero Script verification passes 552 assertions plus access checks. Coverage includes complete-candidate selection, callback bounds, invalid/worse-candidate fallback, real SQLite handoff, selected-voice feedback and unknown calibration.

The real Editor hook harness exposed a second persistence bug: React state held the target, but explicit script edits staged an effective draft without that metadata. The private hydration/reset setter now synchronizes both stores. The previously failing runtime suite passes hydration, editing/autosave, reopening and reset. TypeScript passes. Scoped lint adds no diagnostics relative to `c7b72089`; existing hook/compiler and harness findings remain. These are not represented as a clean full-repository lint run.

Browser QA mounts the actual `NarrationTargetNotice` component in a local React fixture. Changing Kore to Aoede updates the estimate and warning; editing the script updates it again; unmeasured voices show an unknown estimate; absent targets hide the notice. This does not exercise authentication, the complete Editor page, rendering or production. Standards review reports no blocking findings and one advisory about duplicated correction-call policy; final Spec review reports no findings after the incorrect aggregate and persistence issue were corrected. Build/CI results are recorded for the final head in the PR body and local artifact directory.
