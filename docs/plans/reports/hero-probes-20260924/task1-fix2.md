# Task 1 final correctness fix

## Summary (95 words)

The SQLite observer now revalidates both pinned database and shared-memory file
identities after every `/proc/locks` snapshot and before accepting its events or
ending successfully. A deterministic FIFO regression replaces the database
during the final blocked snapshot and now fails closed with no output. Snapshot
parsing is streamed and rejects the 1,001st targeted event before retaining it;
new continuous intervals also enforce the same 1,000-event bound while being
inserted. Secret-safe fixed CLI errors remain intact. Blank-environment scoped
tests pass. No production database, natural observation, deployment, process,
schema, transaction, or inode change was performed by this fix.

## RED → GREEN evidence

- RED: the FIFO fixture replaced the database inode during the only/final
  `/proc/locks` read; the old observer returned a successful summary.
- GREEN: the same fixture returns exit 2 with the fixed
  `database lock target identity changed` error, empty stdout, and no raw path.
- RED: 1,001 duplicate targeted lock records were all materialized by the old
  snapshot and deduplicated later, so the observer returned success.
- GREEN: parsing rejects the 1,001st targeted event with the fixed
  `observation event limit exceeded` error and empty stdout.

## Minimal implementation

`snapshot` now reads `/proc/locks` line by line and checks capacity before
extending its event list. `observe` performs exact database and `-shm`
identity checks both before and after that bounded read. It also checks
`len(closed intervals) + len(active intervals)` before inserting a new active
interval. Moving an interval from active to closed does not increase that
total. Existing WAL role interpretation, output fields, timing, PID binding,
privacy behavior, and transaction diagnostics are unchanged.

## Scoped verification

| Check | Result |
| --- | --- |
| Blank-environment `python3 scripts/verify-sqlite-lock-observer.py` | PASS |
| CLI secret-canary cases from privacy fix round | PASS |
| Final-snapshot FIFO target replacement | PASS, fixed error and no stdout |
| 1,001 targeted lock records | PASS, fixed limit error and no stdout |
| `git diff --check` | PASS |

No natural or production observer was started by this task. Independent
correctness/privacy review remains required before any such observation.
