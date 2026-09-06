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

Calibration used five predefined synthetic scenarios, then validation used five different, predefined scenarios. Each produced one audio take per final script; all outcomes are retained, including failures. Text generation used the locally configured Gemini `gemini-pro-latest`, not the production OpenRouter configuration; speech used the actual Gemini TTS provider function with Kore/Aoede. Multi-chunk results concatenate unchanged PCM at one sample rate with a pinned model. This is local service/provider QA, not a Browser E2E, production route, billing or render test.

**Measurement is still running. Final results and readiness will be recorded before the PR is handed over.**

## Verification

- Regression, boundary, combined-retry, fallback, fixed-section and echoed-hook verification: recorded in the local artifact directory.
- TypeScript check passed before the last prompt-only refinement; final build/check pending.
- Scoped lint found six existing React compiler purity/ref findings in ScriptEditorStep. The untouched base version produces the same six findings. No new lint finding in the changed server/prompt/helper/test files.
- No human listening, pronunciation scoring, subtitle synchronization or image relevance QA is claimed by this duration measurement.

Local evidence: `/Users/mewsocialmacmini/orca/artifacts/hero-script-duration-2026-09-06` (raw synthetic scripts/audio, calibration/validation manifests, regression red/green logs and build/check logs). No provider credentials or customer content are included in this document.
