# Tier 1 review — HERO-51 offline long acoustic evaluation

Reviewed exact head `2f1a1df0d6d8d49c3fb7d7666c5ca3a570aabc15` against base `3d2c27a65a96f88435bc4e9df45c26b493df0b35`, the approved follow-up, and `review-criteria.md`.

## Result

**Block: one medium-confidence finding.** The new harness is appropriately offline-only, uses synthetic noncustomer media, retains the 60-second deadline and does not alter the production worker, thresholds, fallback/export behaviour, or acoustic budgets. It bounds its direct child, captures only fixed/numeric report fields, rejects invalid identity/hash/error output, and documents that its repeated OS voice and machine boundaries cannot establish human Thai timing quality. CI exercises only algorithm/harness tests and does not acquire weights.

The actual-model claim is reproducible on the prepared private runtime: one independent `long-120` offline run completed in 13,416 ms under 60,000 ms, with 3,314,106,368-byte sampled peak RSS, all 20 known boundaries, 1,000 permille coverage, and 14 ms maximum cumulative boundary drift. That is operational evidence on this host only.

## Finding

- **Medium — `scripts/subtitle-alignment/long_benchmark.py:212`: incomplete timings are reported as `aligned`.** `validate_result` calculates raw `coveragePermille` and `boundariesComplete`, but the final status requires only pinned identity, monotonicity, and duration tolerance. Reproduction: pass text `"แมว แมว"`, two expected boundaries, and one otherwise-valid first-character timing to `validate_result`; it returns `coveragePermille=167`, `boundariesComplete=false`, while the line-212 predicate is true. This violates the task's required coverage/boundary output invariants and means a coverage/boundary regression will not fail meaningfully. Preserve the raw metrics, but derive a separate completion boolean by comparing the emitted spans exactly with the eligible-span set and rejecting duplicates/omissions; require that boolean and `boundariesComplete` in the `aligned` predicate. Add negative tests for missing, duplicate, and absent-boundary output. Do not use rounded percentage as acceptance.

## Independent verification

| Command | Exit | Result |
| --- | ---: | --- |
| `python3 scripts/subtitle-alignment/test_prepare_long_fixtures.py` | 0 | 1 fixture test passed. |
| `python3 scripts/subtitle-alignment/test_long_benchmark.py` | 0 | 3 harness tests passed. |
| prepared-runtime `test_engine.py`, `test_prepare_long_fixtures.py`, `test_long_benchmark.py` | 0 | 5 engine, 1 fixture, and 3 harness tests passed. |
| `npm run verify:acoustic-subtitle-clock` | 0 | Four acoustic clock/worker verifiers passed. |
| `npm run verify:subtitle-audio-sync` | 0 | 108 assertions passed. The author's corrected report records the earlier broad-suite failure as transient; it does not recur at this exact head or at the disposable-base verifier. |
| one 120-second actual-engine offline case | 0 | Bounded actual-model run completed; no matrix rerun. |
| `git diff --check <base> <head>` | 0 | Passed. |

## Limits

The harness kills and waits for its direct engine process. It does not create a process group, so descendant cleanup is not demonstrated for an engine that forks. The current engine does not intentionally do so; treat that as an advisory unless the harness is expanded to arbitrary engine executables. No production access, full build, customer media, or production code change was reviewed or performed.
