# Final correctness review — Tasks 1, 2, and 4

## Summary (126 words)

The exact integration diff `fdc4b984...720106d0` is cleared for the reviewed
probe scope. Both reproduced lifecycle blockers are fixed: the build sampler
rejects root PID reuse during a later child read, and the SQLite observer
rejects database or shared-memory identity changes during the final
`/proc/locks` snapshot. The observer now enforces its 1,000-event bound while
streaming and while adding continuous intervals. Compiler heap reporting
follows Node command-line precedence over `NODE_OPTIONS`, accepts supported
hyphen and underscore spellings, ignores script arguments, and emits null for
ambiguous explicit forms. Cleanup cost attribution and Prisma caller semantics
remain correct. Scoped blank-environment tests, direct FIFO reproductions,
Python compilation, and diff checks passed. One pre-existing verifier timing
case failed once under concurrent test startup and passed alone; this is a
nonblocking test-harness reliability advisory.

## Scope

- Base: `fdc4b984a64592a15f35821023d7dbdb8655f2f9`
- Reviewed head: `720106d068f8183a00c4da50dd8e805bd4fe8830`
- Final fix commits: `35ef0fbc` for the SQLite observer and `95d58803`
  for the build sampler
- Spec: `docs/plans/2026-09-24-hero-discriminating-probes.md`
- No source edits, SSH, production access, customer data, diagnostic build, or
  broad build occurred during review.

## Final fix review

### SQLite target lifecycle and boundedness — cleared

`scripts/observe-sqlite-locks.py` now streams `/proc/locks` line by line
and checks capacity before retaining each parsed event. A snapshot can contain
at most 1,000 targeted events. The observer also enforces
`len(closed) + len(active) <= 1000` while opening intervals, so repeated
appear/disappear cycles cannot bypass the bound.

Both database and `-shm` identities are checked before and after every
snapshot. Events are incorporated only after the second check, including on
the final duration-limited iteration. The original FIFO reproduction now
raises the fixed `database lock target identity changed` error instead of
returning a summary. Existing WAL role/range interpretation, static errors,
PID/process-class meaning, zero-event semantics, and buffered no-partial-output
behavior are unchanged.

### Sampler root lifecycle — cleared

`scripts/build_memory_sampler.py` now rereads the root stat after all
process rows are collected. A missing root raises `RootProcessExited`; a
different start time raises `RootPidReused` before the sample can be
returned or written. The exact FIFO fixture that reused the root during a later
child command-line read now raises `RootPidReused`. Child exit/reuse rows
remain explicit with null memory, and incomplete tree totals remain null
rather than becoming zero.

### Effective compiler heap — cleared

The sampler derives the heap setting only for the recognized webpack compiler
role. It parses both `--max-old-space-size` and
`--max_old_space_size`, with `=N` or separate `N` values. The last
valid `NODE_OPTIONS` heap value supplies the baseline; a recognized
command-line heap before `processChild.js` overrides it. Values after the
worker entrypoint are script arguments and do not affect the result.
Unsupported or ambiguous explicit command forms produce null instead of
falling back to a misleading environment value. Raw command lines and
environment values remain absent from output.

### Combined semantics — cleared

- Prisma adds only the generated numeric column to the existing sanitized
  source. It does not infer a holder from callback duration, a caller, or a
  sampled PID.
- Cleanup counts/times include failed operations and recovery
  `markLocalPresent`. Graph freshness, local hash verification, remote
  pre/post verification, catalog CAS, quarantine/restore, and busy-yield
  ordering remain intact.
- Memory records distinguish RSS, PSS, private memory, swap, and host
  `MemAvailable`; RSS is not described as physical memory.

## Verification

| Check | Result |
| --- | --- |
| Blank-env `python3 -m unittest scripts.test_build_memory_sampler` | PASS, 14/14 |
| Blank-env `python3 scripts/verify-sqlite-lock-observer.py` | PASS when run alone |
| Direct original sampler FIFO reproduction | PASS, `RootPidReused` |
| Direct original observer FIFO reproduction | PASS, fixed identity error |
| Blank-env `py_compile` for observer/sampler and tests | PASS |
| `git diff --check fdc4b984...720106d0` | PASS |

No Linux lock integration rerun or combined application build was needed for
these Python-only corrective commits.

## Advisory

The existing disappearance/reappearance test in
`verify-sqlite-lock-observer.py` starts its mutation thread before spawning
the observer subprocess. During the first parallel review run, subprocess
startup exceeded the fixture's 100 ms lead and the observer missed the initial
interval, failing the expected-two-interval assertion. The same blank-env suite
passed immediately when run alone. This does not indicate an observer
regression, but the fixture should use an explicit observer-ready handshake
instead of wall-clock startup timing to avoid intermittent CI failures.
