# Task 1 — HERO-10 SQLite discriminating probe

## Summary (115 words)

The Prisma slow-transaction diagnostic now retains the generated caller column
alongside its sanitized bundle/source path and line, allowing the deployed
source map to select an exact original callsite. Transaction options, timing,
results, and exceptions are unchanged. A separate standard-library Linux CLI
observes only bounded POSIX locks for the selected WAL database and `-shm`
inode, binds optional fixed PM2 classes to PID start times, and emits private
numeric/static lock evidence with UTC and monotonic-relative intervals. It
fails closed on non-WAL databases, unknown targeted formats/ranges, identity
changes, or bounds violations. A disposable Linux regression proved actual
writer, read-only, checkpoint, and Unix deadman-switch interpretations. No
production database, application process, natural observation, deploy, schema,
or transaction policy was changed.

## Scope and review package

- `src/lib/prisma.ts`: preserve the already captured numeric generated column
  in sanitized `source=...:line:column` values.
- `scripts/verify-prisma-slow-tx.ts`: exact-column and privacy/semantics
  regression at the existing diagnostic seam.
- `scripts/observe-sqlite-locks.py`: standalone read-only observer with a
  0.01–300 second duration, 10–10,000 ms sampling interval, and 1,000-interval
  output cap.
- `scripts/verify-sqlite-lock-observer.py`: cross-platform parser, privacy,
  interval, PID identity, WAL mode, bounds, and fail-closed fixtures.
- `scripts/verify-sqlite-lock-observer-linux.py`: actual disposable Linux WAL
  writer/read-only/checkpoint regression.
- `docs/ops/sqlite-lock-observer.md` and the existing guardrails runbook:
  interpretation limits and reviewed-use gate.

No dependency, schema, application transaction, timeout, retry, or process
configuration changed. The observer is not integrated into application or
deployment startup.

## RED → GREEN evidence

1. The existing diagnostic regression expected
   `app/api/videos/route.js:1:42` and failed with the old
   `app/api/videos/route.js:1`. The two-field extraction change made the full
   semantics/privacy suite pass.
2. The observer fixture initially failed because the CLI did not exist. After
   the minimal implementation it passed its known lock and fail-closed cases.
3. The first serialized Linux run failed closed on shared-memory byte 128.
   Upstream SQLite `os_unix.c` identifies exactly byte 128 as
   `UNIX_SHM_DMS`, the deadman switch. The observer added that one fixed role;
   all other unknown shared-memory ranges still fail closed. The rerun passed.

## Verification

| Check | Result |
| --- | --- |
| `env -i … npm run verify:prisma-slow-tx` with explicit disposable `/tmp` DB | PASS |
| `env -i … python3 scripts/verify-sqlite-lock-observer.py` | PASS |
| Serialized blank-environment Linux `verify-sqlite-lock-observer-linux.py`, 30 s outer timeout | PASS; temporary DB removed |
| `env -i … ./node_modules/.bin/tsc --noEmit` | PASS |
| Python compile check for observer and both verifiers | PASS |
| `git diff --check` | PASS |

The Linux fixture held an actual `BEGIN IMMEDIATE` writer and observed that
PID on WAL byte 120; held an actual read-only transaction and observed a reader
slot without a writer role; and ran an actual truncate checkpoint behind the
reader and observed its PID on byte 121. No production or natural lock
observation ran.

## Interpretation and limits

The evidence identifies an OS lock holder PID, stable PID start time, fixed
process class (or `unknown`), target, mode, and exact SQLite role during the
reported sampled interval. WAL write lock byte 120 can also be held during
recovery; checkpoint byte 121 can also be held during recovery; main-file and
deadman-switch locks do not identify a writer. None of these identifies a
request, SQL statement, transaction caller, customer, or business operation.
The Prisma generated callsite belongs to the waiting or completing call and is
not assigned to an observed holder without separate in-flight correlation.

The observer reads only the 20-byte SQLite header, file metadata,
`/proc/locks`, and numeric `/proc/<pid>/stat` start time. Output omits database
paths, device/inode identifiers, process command lines, environment, SQL,
arguments, model/row data, logs, and customer content. Unsupported targeted
state produces a fixed error and no partial records. Zero events is a valid
no-holder finding only for the sampled instants.

Natural production use remains gated on independent review and root-serialized
host scheduling. This task performed no deploy and requests no automatic
production observation.

## Primary references

- SQLite [WAL-index lock format](https://www.sqlite.org/walformat.html#wal_locks)
- SQLite Unix VFS [`UNIX_SHM_BASE` and `UNIX_SHM_DMS`](https://sqlite.org/src/artifact/410185df49)
- Linux [`proc_locks(5)`](https://www.man7.org/linux/man-pages/man5/proc_locks.5.html)
