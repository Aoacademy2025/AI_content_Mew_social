# Gemini acoustic subtitle pilot — 2026-09-05

**Release decision: NOT QUALIFIED. Default remains off.** This is an implementation and diagnostic screening result, not proof of production accuracy or render reliability. Production configuration, existing customer projects and support tickets were not changed.

## Why another timing change is needed

The read-only Sep 1–5 cohort audit found approximate clocks in 30 of 86 original completed Gemini creates across 19 accounts. That count is provenance, not a measured drift rate. Direct inspection of distinct-account samples corroborated approximately 1.5–5-second late source captions; a successfully aligned sample also had an approximately 0.5-second early boundary. Those source timings preceded creator edits.

PR #425 deliberately retained successful rendering when one bounded alignment attempt fails. That fixes render availability, but the fallback still distributes timing approximately and cannot guarantee synchronization. This pilot preserves that availability behavior while testing a better clock. Headline hiding and an absent music selection remain intentional behavior. Upload transcription and old edited-project repair are outside this Gemini pilot.

## Implementation

The exact generated WAV and narration feed a pinned Thai CTC aligner. Verified word spans keep their acoustic positions; weak or unsupported spans receive bounded approximate timing and phrase captions, with a visible preview review hint. A partial clock cannot replace an existing fully aligned clock. Preview and export retain the chosen timing/audio identity, and export makes no new alignment request.

The local worker uses offline weights, a cross-process lock, a wall-clock deadline, limited threads and a private seven-day content-addressed cache. Errors retain the legacy rendering path. Off/shadow/apply controls and a default-zero account rollout keep activation explicit. The legacy remote attempt remains concurrent during this evaluation, so no provider-cost reduction is claimed.

## Actual-audio screening

The diagnostic set contains 31 original Gemini previews: 16 approximate and 15 previously aligned clocks, from multiple accounts, about 3–298 seconds long. It emphasizes failure and duration coverage and is not a random population sample. A separate unprompted local Whisper pass supplied matching caption-start references; all **737 matched boundaries are automatic references, with zero human-reviewed references**. Unmatched or incorrect speech outside those matched boundaries is not evaluated.

| Absolute start difference from automatic reference | Existing clock | Proposed selection |
| --- | ---: | ---: |
| Median | 141 ms | 140 ms |
| p95 | 748 ms | 530 ms |
| p99 | 2,693 ms | 737 ms |
| Within 250 ms | 534/737 (72.5%) | 575/737 (78.0%) |
| Within 500 ms | 662/737 (89.8%) | 692/737 (93.9%) |
| Over 1 second | 20 | 1 |

These are projected word-start comparisons under the adoption policy, not final rendered-card measurements. They exclude card grouping, minimum-duration repair and encoded audio/video offsets. Even this proxy does not meet the proposed 95% within 250 ms / 99% within 500 ms thresholds. The set informed a decoder guard, so it is not held out.

The remaining >1-second screening outlier lies in an uncertain opening of a clip whose full-text ASR similarity is only 0.595. It needs human review; neither the reference nor the estimated opening should be treated as ground truth. Do not tune a global offset to this point.

One new regression was found and guarded: a high-confidence first character attached to the preceding phrase, separated from the rest of its word by 1.5 seconds. Independent transcription windows and an intervening silence favored the original timing. Words with an internal character gap above 500 ms now remain uncertain instead of becoming verified anchors. A regression test covers this case; broader held-out validation remains necessary.

## Runtime evidence and limits

The final 31-clip engine pass, under concurrent local transcription/build work, took median 11.306 s and maximum 42.431 s per clip with the model resident; peak process RSS was about 2.84 GB. This is development-machine evidence, not a production capacity estimate. An actual Node-to-Python cold smoke on a 64-second sample took 44.964 s, close to the default 45-second deadline; its validated cache hit took 15 ms. Repeated worker cold starts, lock contention and rendering competition must be measured on deployment hardware.

Automated verification passed for CTC path placement/repeats/UTF-16 offsets, detached character and pause regressions, immutable text, partial anchors, cache identity/expiry/privacy, path containment, process termination, off/shadow/apply orchestration, and preview/export identity without additional provider calls. The existing subtitle/audio synchronization suite, TypeScript, scoped lint and production build also passed after the final runtime changes. These checks do not establish a customer job-completion percentage.

## Required before activation

1. Freeze the candidate and label a separate 30–50-clip set by listening to the actual audio, including mixed language, numbers, long pauses and the known regressions. Measure start/end and phrase readability, not just matched starts.
2. Inspect final rendered videos for caption-frame and encoded audio offsets, including exports with creator edits. Confirm no new >1-second regression and meet the agreed human-reference thresholds.
3. Measure cold/warm latency, memory and concurrent render completion on deployment hardware. Resolve the near-deadline cold path before enabling a customer cohort; target at least 99% completion of admitted jobs with explicit denominators.
4. Run shadow, inspect timeout/unavailable/partial rates, then apply to a small account cohort only after qualification. Roll back future selection with `SUBTITLE_ACOUSTIC_MODE=off`.

See the [approved plan](../plans/2026-09-05-gemini-acoustic-caption-timing.md) and [engine setup and benchmark instructions](../../scripts/subtitle-alignment/README.md). Customer media, narration, transcripts and emails are deliberately excluded from repository artifacts.
