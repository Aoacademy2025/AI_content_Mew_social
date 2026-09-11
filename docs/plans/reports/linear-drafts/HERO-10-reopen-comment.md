Reopen — same root cause, measured again read-only on production 2026-09-11 20:47 → 21:05 UTC (Bangkok 2026-09-12 03:47 → 04:05), prod HEAD `84e4d8c2`. Source: Task A1 of the 2026-09-12 performance audit (`docs/plans/reports/2026-09-12-A1-prod-measurement.md`, §A1.1 / §A1.8).

## Why this reopens

The acceptance criterion was *contention signatures in the PM2 error logs < 5 per day for 7 consecutive days at current traffic*. It is not met, on either counting method.

**Window caveat, stated honestly:** a 7-day census is not possible. PM2 only began writing a leading ISO timestamp on 2026-09-09T11:31:07 UTC, and the `[prisma-slow-tx]` instrumentation (`src/lib/prisma.ts:101`) landed in the same deploy. Lines before that cannot be bucketed to a Bangkok day at all. **The measured window is 2026-09-09 18:31 BKK → 2026-09-12 04:05 BKK = 2.40 days.** Nothing below is extrapolated to 7 days.

### Slow transactions on `ai-content`, per Bangkok day (A1 §A1.1)

| Bangkok day | slow transactions | of which ≥ 5,000 ms | p50 (ms) | p90 (ms) | max (ms) |
|---|---:|---:|---:|---:|---:|
| 2026-09-09 (from 18:31) | 42 | 42 | 29,497 | 39,215 | 45,572 |
| 2026-09-10 | 99 | 98 | 20,241 | 30,147 | 46,302 |
| 2026-09-11 | 72 | 71 | 27,035 | 30,137 | 45,284 |
| 2026-09-12 (to 03:47) | 4 | 4 | 20,701 | 30,062 | 30,089 |

Pooled over the window (n = 217): min 2,004 · **p50 25,166 ms** · p75 30,093 · **p90 30,191 ms** · p95 37,280 · **max 46,302 ms**.

`[prisma-slow-tx]` emits exactly one line per event, so these are event counts, not stack lines. **42 / 98 / 71 events ≥ 5 s per day against a target of < 5/day.**

### Contention signatures in the PM2 error log (the criterion's own metric), per Bangkok day

| marker (ai-content) | 09-09 | 09-10 | 09-11 |
|---|---:|---:|---:|
| `Socket timeout` | 17 | 11 | 5 |
| `Transaction already closed` | 2 | 4 | 1 |
| `P1008` | 7 | 3 | 3 |
| **total lines** | **26** | **18** | **9** |

The earlier note that one failure emits the message on 2–3 stack lines still applies; even deflating by 3× the window gives ≈ 8.7 / 6.0 / 3.0 events per day, so two of the three full-or-partial days are still at or above the target, and the unambiguous one-line-per-event metric (slow transactions ≥ 5 s) is 8–20× the target.

`story-film-system-worker` carries a further **102 events** of `lease failed` + `Socket timeout` + `P1008` (the same 102 multi-line errors), a flat **25 / 24 / 25 per Bangkok day**, plus 152 slow transactions of its own ≥ 5 s.

### Customer-visible fallout inside the same window

- 54 of 219 ai-content slow transactions (25 %) have a `P1008` / `Socket timeout` / `Transaction already closed` / transient-SQLite line within ±2 s — i.e. the wait ended in an error a request had to return, not in a slow success.
- The 09-11 watch note's two named consequences (three `Socket timeout` on `prisma.user.update()` behind `user/api-keys`; one `creditLedger.create()` lost to `Transaction already closed` during AI-image reconciliation) are the same class and are still occurring.

## What the new measurement adds

**150 of 219 events (68.5 %) land within ±500 ms of a configured timeout** — 83 at the 20 s `socket_timeout`, 67 at the 30 s transaction timeout. PR #462 did not remove the wait; it lengthened the ceiling the wait runs into, so a blocked request now occupies a Node slot for 20–40 s instead of failing at 5 s. That is why the *error* counts fell while the *stall* counts did not.

**A named structural holder now exists**, which the original issue listed as unknown: `leaseStoryFilmGenerationJobs` (`src/lib/story-film-generation-queue.server.ts:224`) opens an interactive `prisma.$transaction` whose **first statement is a write** (`requeueExpiredLeases`), then a `count`, a `findMany` with a relation filter and an `updateMany` — on every poll, every `POLL_MS = 4000` ms (`scripts/story-film-system-worker.ts:41,473`). That is **≈ 21,600 write transactions per day against a 114-row table**. Its log lines are the most enriched tag inside slow-transaction windows: **65.2 % of them fall inside one, 36× the 1.81 % baseline**.

**Ruled out by measurement** (so these need not be re-investigated): the `/api/admin/storage` disk walk (0.072 s), the nightly `VACUUM INTO` (0 of 217 windows overlap), `cleanup-videos`, Remotion render progress logging (0.97× baseline), render-worker DB pressure (0 slow transactions across both instances), host CPU/RAM/disk (load ≤ 1.09 on 8 vCPU, 26.9 GB free, event-loop p95 2.26 ms), and freelist bloat (0.47 %). The box is idle while requests wait — this is queueing on one writer, not slow work.

**The third acceptance criterion is also unmet.** `TelemetryEvent` is **149.41 MB = 28.3 %** of the 527.52 MB live database, 305,452 rows, **203,002 of them (66 %) older than 30 days**; no retention job exists in `ecosystem.config.js`. WAL high-water is 35.2 MB = **8.54×** the 4.12 MB autocheckpoint threshold, with `journal_size_limit = -1`, so the file never truncates.

## Suggested next state

`Triage`, to be re-scoped against the audit's follow-up tasks rather than re-opened straight into the original track-1 scope. The audit's ranked causes are in §A1.8 of the report above; the umbrella issue for the audit is drafted alongside this comment.

Re-verification metric for the next window, so the counting method stops being the argument: **`[prisma-slow-tx]` events ≥ 5,000 ms per Bangkok day on `ai-content` and on `story-film-system-worker`** (one line per event, no stack-line inflation), plus the WAL high-water multiple. Target stays < 5/day for 7 consecutive days.
