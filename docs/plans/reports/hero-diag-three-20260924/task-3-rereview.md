# Tier 1 re-review — HERO-51 fix round 1

Reviewed incremental head `431ce583a424b4e5267e0b9f6f2d28efba87bbc5` over `2f1a1df0d6d8d49c3fb7d7666c5ca3a570aabc15`.

## Result

**Clear: the prior medium finding is fixed.** `is_aligned_result` now requires pinned identity, monotonicity, duration tolerance, exact ordered eligible-span completion, and nonempty complete known boundaries. Raw `coveragePermille` is retained only as a metric; the status predicate compares the emitted span list to the eligible span set, so omissions, duplicates, and unexpected spans cannot pass by rounding to 1000.

The public child-process regression exercises the original seam: valid identity, hashes, and duration with one of six spans and one of two boundaries now returns `invalid`. Tests separately cover missing, duplicate, and no-known-boundary evidence. The stored all-case report remains consistent with the strengthened predicate: character/eligible and boundary/matrix-manifest counts are exactly 72/72/1, 1440/1440/20, 2376/2376/33, 3240/3240/45, and 3600/3600/50; each is monotonic.

## Independent verification

| Command | Exit | Result |
| --- | ---: | --- |
| system `python3 scripts/subtitle-alignment/test_long_benchmark.py` | 0 | 7 tests passed. |
| prepared-runtime same command | 0 | 7 tests passed. |
| `python3 -m py_compile` changed Python files | 0 | Passed. |
| `npm run verify:acoustic-subtitle-clock` | 0 | All four verifiers passed. |
| `git diff --check <prior-head> <fix-head>` | 0 | Passed. |

No production code, budget, fixture, engine, or privacy behaviour changed. The earlier direct-child-only cancellation/descendant note remains advisory; this fix does not expand process behaviour.
