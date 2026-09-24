# HERO-41 natural cleanup follow-up — 2026-09-24

Status: **safe busy-yield verified; remaining runtime mechanism strongly identified,
direct operation timing still required before a performance change**

Observed at approximately 12:34 UTC, after the natural 16:35 Bangkok timer run had
finished. Production HEAD was
`fdc4b984a64592a15f35821023d7dbdb8655f2f9`; tracked-file status was clean.

## Scope and method

This was read-only production inspection under the approved follow-up. No cleanup was
started, no service or timer was changed, and no workload, database mutation, media
read, provider request, restart, deploy, or configuration action occurred.

The inspection used:

- allowlisted `systemctl show` service/timer timestamps, result, exit status, CPU,
  active state and schedule fields;
- the existing cleanup journal from 09:00 UTC, parsed from journal JSON into only
  timestamps, lifecycle event names, aggregate cleanup counters and skip categories;
- `git show origin/main` locally to trace the deployed runner and integrity path.

Raw journal messages were never printed. Customer identifiers, media paths, manifest
hashes, environment values, SQL arguments and row data were omitted.

## Verified natural outcome

The timer triggered at 09:35:06 UTC. The service exited successfully at 10:15:23 UTC:

| Signal | Observed |
| --- | ---: |
| Unit result / exit | success / 0 |
| Unit wall time | 2,417 s (40m17s) |
| Accounted CPU time | 2,366.397737 s (39m26.397s) |
| CPU time / wall time | 97.9% |
| Cleanup result | `customer_media_active` |
| Candidate records scanned | 19,719 |
| Catalog-unverified | 18,403 |
| Eligible / selected | 500 / 6,417,771,589 bytes |
| Deferred by object limit | 816 |
| Evicted before yield | 130 / 2,751,447,444 bytes |
| Errors | 0 |

All reported `remote_unverified`, `changed`, `quarantine_skipped`,
`catalog_changed`, `restore_failed` and `operation_failed` counters were zero.
These are runner outcomes, not an independent byte-integrity audit.

Missing-local reconciliation scanned 60,165 catalog rows. It found zero eligible,
selected or reconciled rows and zero errors:

| Missing-local category | Count |
| --- | ---: |
| not verified-present | 40,070 |
| invalid catalog | 8 |
| local present | 20,087 |
| quarantined / stat error / limit / remote-unverified / catalog-changed | 0 |

The service was inactive/success at the read. The next scheduled timer was
13:35:56 UTC.

## Coarse phase boundaries

The deployed code has no explicit per-phase timer. Two content-free timestamps still
give a bounded split:

- missing-local reconciliation began at 09:35:07.234 UTC;
- the eviction report was created at 09:35:39.729 UTC, after reconciliation and
  cleanup planning had completed;
- the final aggregate summary reached the journal at approximately 10:15:22 UTC.

Therefore:

| Coarse phase | Approximate duration |
| --- | ---: |
| Missing-local reconciliation + cleanup planning | 32.495 s |
| Eviction selection + apply | 2,382.271 s (39m42.271s) |
| Unit wrapper before/after those boundaries | about 2.2 s |

This split cannot separate reconciliation from planning, or selection from apply.

## Busy-yield acceptance

The post-release safe-boundary behavior worked naturally:

1. Cleanup began on an idle-enough box and selected 500 objects.
2. Customer work became observable during the apply run.
3. The current object completed.
4. Before object 131 began, the forced safe-boundary activity check returned true.
5. The service reported `customer_media_active`, exited 0, and left no reported
   quarantine, restore, catalog-CAS or operation failure.

The journal records only the boolean mid-run result, so it cannot distinguish whether
the triggering aggregate was a processing VideoJob, a queued/running RenderJob, or
both. It also cannot say exactly when that state first became active. The acceptance
claim is limited to safe deferral at a complete-object boundary.

## Why runs approach the 90-minute budget

The natural rate remains nearly linear by completed object:

| Natural run | Wall time | Evicted | Approx. wall / eviction |
| --- | ---: | ---: | ---: |
| Sep 23 21:39–23:09 UTC | 5,413 s | 341 | 15.9 s |
| Sep 24 01:38–03:10 UTC | 5,490 s | 307 | 17.9 s |
| Sep 24 09:35–10:15 UTC | 2,382 s in eviction phase | 130 | 18.3 s |

At the latest rate, processing all 500 selected objects would take approximately
153 minutes. A 90-minute budget would complete roughly 295 objects, the same order as
the prior 307 and 341 outcomes. The safe-yield release changes when cleanup stops for
customer work; it does not reduce this per-object cost.

The deployed source reveals the leading mechanism:

```text
runLocalMediaEviction
  -> evictOne for each selected object
     -> singleRecordPlan
     -> quarantineMediaCleanupPlan(..., batchSize: 1)
        -> buildMediaReferenceGraph
```

`quarantineMediaCleanupPlan` rebuilds the full reference graph once per batch.
Because `evictOne` supplies exactly one record and a batch size of one, every
successfully evicted object performs a fresh full graph build. This natural run
therefore performed 130 full graph rebuilds during apply, in addition to the planner's
initial graph.

Each graph build issues broad reads for Videos, done/waiting and in-flight VideoJobs,
EditorProjects with plan data, active RenderJobs, GeneratedImages and completed AI
generation jobs. It then parses and walks their direct and JSON media references and
may inspect remote-only catalog state for missing project media. This work grows with
the full ownership graph, not with the one object being evicted.

Other known work in this run was:

- 99 batched local-eviction catalog inventory reads for 19,719 candidates;
- 500 selection-time R2 metadata verifications;
- for each of 130 applied objects: catalog re-inspection, quarantine and manifest
  work, one local SHA-256 pass, a second R2 metadata verification, catalog CAS, unlink
  and empty-run cleanup;
- 2.751 GB of staged local media hashed, averaging 20.18 MiB per eviction.

CPU time was 97.9% of unit wall time, while observed effective media throughput was
only about 1.10 MiB/s. That makes pure network waiting an unlikely explanation for
most of this sample. The repeated full graph parsing and the local SHA pass are the
principal CPU candidates. The source proves the graph was rebuilt 130 times and the
stable seconds-per-object rate supports it as the dominant explanation, but no direct
timer or CPU profile separates graph building from hashing. It should not yet be
assigned an exact percentage.

## Transaction timing correlation

Cleanup exited at 10:15:23 UTC. The supplied slow transaction events occurred later:

- fetch-stock at 10:17:05 UTC;
- jobs callback at 10:59:46 UTC.

The first event was logged about 102 seconds after cleanup exited. Subtracting its
approximately 30-second elapsed time places invocation around 10:16:35 UTC, about
72 seconds after cleanup exited; the second event was much later. Their measured
intervals do not overlap this cleanup unit. The customer job
state that triggered cleanup's yield might belong to work that later emitted a slow
transaction, but the cleanup journal carries no identity or activity-type breakdown.
Timing alone cannot connect them or identify any lock holder.

## Minimum remaining evidence

Before changing the integrity path, add content-free cumulative counters/timers for one
natural pass:

1. missing-local inventory/scan/apply;
2. cleanup graph build and filesystem plan scan;
3. eviction selection catalog reads and R2 HEAD verification;
4. per-object cumulative graph rebuild count/time;
5. local SHA-256 count, bytes and time;
6. apply-time R2 HEAD, catalog inspect/CAS, quarantine/manifest and unlink time;
7. sanitized active RenderJob/VideoJob counts only when a busy yield fires.

One natural run with those totals can confirm the time share without exposing content
or weakening graph freshness. A production change should then target the measured
repeated work while preserving per-object reference freshness, checksum verification,
remote pre/post verification, catalog CAS, quarantine/restore and the safe yield
boundary. Reusing a stale graph across 500 objects is not justified by this report.

HERO-41 now has natural evidence for the safe-yield fix, but the parent should remain
open until direct operation timing supports a reviewed performance change and a later
natural run demonstrates acceptable runtime without harming customer work.
