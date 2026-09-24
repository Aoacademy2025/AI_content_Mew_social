# Task 2 — HERO-41 cleanup cost and safe deferral

Status: implementation complete; ready for independent review  
Branch: `codex/hero41-cleanup-phases-20260924`  
Base: `3d2c27a65a96f88435bc4e9df45c26b493df0b35`  
Head: `f75ff386ae011873cba2733488cb0ee52e286c0f`  
Commit: `fix(cleanup): yield between apply objects (HERO-41)`

## Scope and production evidence

This task followed the approved Task 2 seam: the actual cleanup planner and runner,
disposable SQLite, real local files, and fake remote verification. No production SSH,
cleanup, provider, deployment, configuration, or customer-media operation was run.

The evidence refresh shows two post-release cleanup rounds still exhausting the
90-minute budget:

| UTC interval | Wall / CPU | Scanned | Evicted / eligible | Outcome |
| --- | --- | ---: | ---: | --- |
| Sep 23 21:39:05–23:09:18 | 90m13s / 93m02s | 19,450 | 341 / 500 | runtime_budget, errors 0 |
| Sep 24 01:38:42–03:10:13 | 91m30s / 89m27s | 19,287 | 307 / 500 | runtime_budget, errors 0 |

The second round overlaps a Gemini create interval from 02:17:16–02:41:39 UTC.
That overlap motivated the busy-yield test but does not prove the historical activity
query was positive or that cleanup caused the job duration. The 90-minute production
cost remains unattributed.

ADR 0006 remains binding. The implementation does not alter checksum checks, remote
pre/post verification, catalog compare-and-set, quarantine, restore, scope, retention,
object/byte caps, or the runtime-budget precedence in the yield gate.

## RED loop and hypotheses

The first red-capable loop was the existing actual planner/runner integration verifier,
with its forced test cadence removed:

```text
npm run verify:media-local-eviction
AssertionError: actual undefined; expected "customer_media_active"
at scripts/verify-media-local-eviction.ts:631
```

The fixture uses disposable SQLite catalog rows, two real old local files, the real
cleanup planner/runner/quarantine/hash/catalog code, and a fake remote verifier. The
activity predicate becomes true inside object 1. Under default polling the predicate
was not called at the safe boundary, so no deferral was reported and object 2 began.

A second RED covered the runner's preceding missing-local reconciliation stage:

```text
npx tsx scripts/verify-media-local-missing-reconcile.ts
AssertionError: actual undefined; expected "customer_media_active"
at scripts/verify-media-local-missing-reconcile.ts:170
```

Its first real catalog compare-and-set completed, but default polling did not observe
the now-active predicate before the next selected row.

Ranked hypotheses before implementation were:

1. The apply loops used the default 200-item cadence at object boundaries. Prediction:
   forcing the existing gate between complete objects would defer after object 1.
2. Selection-phase remote verification could dominate and delay observation.
   Prediction: selection timing or remote timing would dominate the fixture.
3. Serialized quarantine, stat/hash, remote verify, catalog CAS, and unlink work could
   dominate apply. Prediction: apply would exceed selection after subtracting DB calls.
4. Planner filesystem inventory could dominate at approximately 19k files. Prediction:
   planner timing would exceed reconciliation and selection.
5. Missing-local full inventory could add a material pre-planner cost. Prediction:
   reconciliation would be comparable with planner time.

Hypothesis 1 was confirmed by both RED loops. The local profile supports hypotheses 3
and 4 for this small-file fixture, rejects 5 for the all-present fixture, and cannot
evaluate real remote latency in hypothesis 2.

## Fix

Both apply loops now call the existing yield gate with `force: true` immediately
before each independently recoverable object/row:

- local eviction checks before `evictOne`;
- missing-local reconciliation checks before its absent-path recheck and catalog CAS.

A customer job that becomes observable during one object therefore lets that object
finish with all quarantine/restore guarantees intact, then prevents the next object
from starting. A deadline and customer activity arriving together still report
`runtime_budget`, because the unchanged gate checks the deadline first.

No mid-object cancellation, new timeout, new dependency, production profiler, or
cleanup budget change was added.

## GREEN

```text
npm run verify:media-local-eviction
PASS verified local media eviction, rollback, busy-yield and exit code

npx tsx scripts/verify-media-local-missing-reconcile.ts
PASS missing local catalog reconciliation is checksum-gated and fail-closed
```

The eviction regression uses default `yieldEveryItems` and
`yieldMinIntervalMs`; the earlier forced test values were removed. It proves one
in-flight object completes and exactly one file remains. The missing-local regression
proves one completed catalog transition stays committed and the next row remains
`present`.

## Benchmark

Command:

```bash
npx tsx scripts/benchmark-media-local-eviction.ts
```

Fixture:

- 18,865 real 4 KiB old files;
- 938 verified-present SQLite catalog rows;
- 326 selected evictions;
- real missing-local reconciliation, reference graph/planner, selection, quarantine,
  SHA-256, catalog inspect/CAS, unlink, and activity count queries;
- zero-latency fake remote verification;
- three runs; output assertions require 18,865 scanned, 17,927 catalog-unverified,
  612 limited, 326 evicted, and zero errors.

The benchmark simulates the pre-fix default polling policy by running SQLite activity
queries during selection and returning false without SQLite at the newly added safe
apply boundaries. It then restores the exact files/catalog state and runs fixed
safe-boundary polling. The two cleanup reports must be deeply equal.

| Phase / operation | Three-run result |
| --- | ---: |
| Missing-local reconciliation | 13–17 ms |
| Cleanup planning | 962–977 ms |
| Selection dry run | 82–89 ms |
| Pre-fix default-poll simulation | 616–653 ms |
| Fixed safe-boundary polling | 657–694 ms |
| Fixed minus simulation wall time | 6, 78, 7 ms |
| Fixed actual runner path (reconcile + plan + apply) | 1,646–1,669 ms |
| Existing selection activity queries | 190; 19.0–21.2 ms total |
| Added safe-boundary activity queries | 326; 32.2–35.4 ms total |
| Added query average / max | 0.099–0.109 ms / 0.9 ms |
| 95 batched catalog inventory reads | 54.2–57.0 ms total |
| 326 catalog inspections | 34.0–36.3 ms total |
| 326 catalog CAS writes | 104.2–115.9 ms total |
| 652 fake remote verifications | about 0.1 ms total |

The local wall comparison is noisy, so the direct activity-query timing is the useful
overhead measurement. The remaining approximately 403–434 ms in the fixed apply pass
includes local selection/orchestration plus quarantine manifests, stat/hash, hard-link,
unlink, and cleanup. It is not a precise split among those operations.

This fixture is not production latency evidence. Its files are 4 KiB, the fake remote
has zero latency, the filesystem is local, SQLite has no production contention, and
the missing-local stage has no absent candidates. It establishes operation shape,
safety, and bounded local overhead only. It neither explains nor resolves the observed
90-minute production runs.

## Verification

All commands passed on head:

```bash
npm run verify:media-local-eviction
npm run verify:media-storage
npx tsc --noEmit
npx eslint src/lib/media-local-eviction.ts src/lib/media-local-missing-reconcile.ts \
  scripts/verify-media-local-eviction.ts \
  scripts/verify-media-local-missing-reconcile.ts \
  scripts/benchmark-media-local-eviction.ts
git diff --check
npx tsx scripts/benchmark-media-local-eviction.ts
```

`verify:media-storage` passed stream cancellation, storage foundation/R2/rollout,
serving, catalog, missing-local reconciliation, remote GC recovery, and orphan-GC
manifest/SHA suites. Its expected fixture log
`[media-serving] renders remote unavailable` was followed by PASS.

The full build was intentionally not run in this task worktree. The root coordinator
reserved one combined build slot after integrating all three issue heads.

## Files and review package

Changed files:

- `src/lib/media-local-eviction.ts`
- `src/lib/media-local-missing-reconcile.ts`
- `scripts/verify-media-local-eviction.ts`
- `scripts/verify-media-local-missing-reconcile.ts`
- `scripts/benchmark-media-local-eviction.ts`

Review range: `3d2c27a65a96f88435bc4e9df45c26b493df0b35..f75ff386ae011873cba2733488cb0ee52e286c0f`.

The reviewer should verify:

1. the forced poll occurs only between independent apply objects/rows;
2. no path can return while an object is quarantined or a restore is pending;
3. runtime-budget precedence and latched yield behavior remain unchanged;
4. remote pre/post verification, checksums, CAS, quarantine, restore, limits, and
   fail-closed behavior are unchanged;
5. the extra activity reads are acceptable at the 500-object cap;
6. benchmark language does not promote local fixture results to production claims.

No push or PR was created. The next gate is independent Tier 1 review, followed by the
profile-required final correctness/security review and the coordinator's combined
build. HERO-41 should remain open until natural production runs establish acceptance.
