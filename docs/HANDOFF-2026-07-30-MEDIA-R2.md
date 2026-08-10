# Handoff — Media storage / Cloudflare R2 rollout

Last updated: 2026-07-31 12:25 Asia/Bangkok

## Update — 2026-07-31 full-GC activation

The 10-object physical-deletion canary passed every acceptance criterion:

- canary service: `deleted=10`, `missingFinalized=0`, `errors=0`;
- catalog: zero canary rows remain `delete_pending`;
- direct R2 HEAD: all 10 reviewed physical keys are absent;
- a verified remote-only object with no local file returned HTTP 206 and
  exactly 1,024 bytes;
- app and workers remained online; and
- the reference graph, catalog consistency, checksum, operation, and
  media-serving checks reported no new errors.

Backfill reached zero in both the normal reconciliation service and a separate
locked dry-run:

```json
{
  "scanned": 19730,
  "candidates": 0,
  "alreadyVerified": 13254,
  "failed": 0,
  "conflicts": 0,
  "skippedInvalid": 6476
}
```

Six stale `UnsafeMediaFileError` observations were reconciled with
`scripts/reconcile-media-catalog.ts`. The bounded manifest required all six
local paths to be missing, every reference set to be empty, all remote receipt
fields to be null, and the reference graph to have zero errors. A compare-and-set
transition preserved the audit rows as `remoteState=abandoned`,
`localState=missing`; no catalog rows were deleted. The reviewed manifest was:

```text
e1e126fb722b4d25dc3e8e552b1153e3918ada48e9d52f3362d7b08c90efbc14
```

Backup before that transition:

```text
/var/www/ai-content/prisma/backups/dev.db.before-catalog-reconcile-20260731T0504Z.bak
```

One additional verified local-eviction batch completed:

```json
{
  "eligible": { "count": 250, "sizeBytes": 4547789034 },
  "evicted": { "count": 250, "sizeBytes": 4547789034 },
  "errors": 0
}
```

VPS disk moved from 80% to 79%, and a newly evicted object passed a 1 KiB
Range request from R2.

The full reference-aware GC service and timer are now installed and enabled.
The old pending-only canary timer is installed but disabled. The first full
automated run succeeded:

```json
{
  "eligible": { "count": 3063, "sizeBytes": 58601099138 },
  "selected": { "count": 250, "sizeBytes": 7807111600 },
  "staged": { "count": 250, "sizeBytes": 7807111600 },
  "deleted": { "count": 0, "sizeBytes": 0 },
  "missingFinalized": { "count": 0, "sizeBytes": 0 },
  "errors": 0
}
```

Those 250 objects are `delete_pending` until
2026-08-01 12:23:16 Asia/Bangkok. The daily full timer runs around 05:30 with
up to 10 minutes of randomized delay, so its 2026-08-01 run is before that
grace deadline and must not delete this first batch. The first scheduled run
that can physically delete it is approximately 2026-08-02 05:30–05:40.

Current catalog snapshot:

| Remote state | Local state | Objects | Catalog bytes |
| --- | --- | ---: | ---: |
| `abandoned` | `missing` | 6 | 173.0 MiB |
| `delete_pending` | `evicted` | 250 | 7,445.4 MiB |
| `deleted` | `evicted` | 10 | 297.6 MiB |
| `verified` | `evicted` | 3,285 | 55,492.7 MiB |
| `verified` | `present` | 13,291 | 247,069.2 MiB |

Post-stage dry-run:

```json
{
  "eligible": { "count": 2813, "sizeBytes": 50793987538 },
  "pending_grace": 250,
  "catalog_inconsistent": 0,
  "checksum_mismatch": 0,
  "operation_failed": 0,
  "errors": 0
}
```

Next session priorities:

1. Inspect the 2026-08-01 full-GC journal and require `deleted=0` for the first
   batch because its grace deadline is later that day.
2. After the first batch passes grace, inspect its first physical-deletion run:
   require `deleted + missingFinalized=250`, `errors=0`, zero overdue pending
   aliases, absent R2 HEADs, healthy Range playback, and healthy app/workers.
3. Continue bounded daily draining only while catalog/checksum/graph errors
   remain zero.
4. Add the alerts listed later in this handoff and complete the seven-day
   error-free soak.

The older snapshot and first-session instructions below are retained as rollout
history; this update is authoritative for current state.

## Objective

Complete the permanent media-storage rollout without customer-visible downtime:

1. finish local-to-R2 backfill;
2. evict expired media from the VPS only after the R2 replica is verified;
3. physically delete expired/unreferenced R2 objects with reference-aware GC;
4. reconcile legacy/orphan R2 objects only after the backfill reaches zero; and
5. leave disk, R2 growth, errors, and overdue GC under monitoring.

The product retention policy remains 3/7/14 days. Do not add a blanket
age-based lifecycle rule to `media/v1/` or `media/v2/`.

## Production access

- App directory: `/var/www/ai-content`
- VPS access is documented in `docs/runbooks/2026-07-18-launch-event.md`.
- R2 credentials are stored only in the protected production environment:
  `/var/www/ai-content/.env.r2.production`.
- Never print, copy, or paste R2 credentials into chat or logs.

Production currently uses:

```text
MEDIA_WRITE_MODE=local
MEDIA_READ_MODE=r2-local
MEDIA_LOCAL_EVICTION=0   # individual systemd units override this when required
MEDIA_R2_DELETE=0        # only the guarded GC unit overrides this
```

## Current production health

Snapshot at 2026-07-30 01:08 Asia/Bangkok:

- `ai-content`: online
- `mcp-video-worker`: online
- RAM available: approximately 29 GiB
- Swap used: approximately 72 MiB
- VPS disk: 388 GiB total, 306 GiB used, 83 GiB available, 79%
- `heroai-r2-reconcile.timer`: active
- `heroai-media-local-eviction.timer`: active
- `heroai-r2-remote-gc-canary.timer`: active
- Last completed reconciliation, local-eviction, and canary service results:
  success / exit status 0

## Current catalog and backlog

Latest catalog snapshot:

| Remote state | Local state | Objects | Catalog bytes |
| --- | --- | ---: | ---: |
| `delete_pending` | `evicted` | 10 | 297.6 MiB |
| `failed` | `present` | 1 | 48.5 MiB |
| `verified` | `evicted` | 2,813 | 49,565.1 MiB |
| `verified` | `present` | 12,667 | 237,307.4 MiB |

Latest read-only backfill result:

```json
{
  "scanned": 19475,
  "candidates": 621,
  "alreadyVerified": 12609,
  "failed": 0,
  "conflicts": 0,
  "skippedInvalid": 6245
}
```

This is approximately 95.3% complete among verified + remaining candidates.
The reconciliation timer processes at most 100 uploads per run.

One catalog row is currently `remoteState=failed`:

```text
renders/composite-1785320700336.mp4
lastErrorCode=UnsafeMediaFileError
attempts=1
```

Let the normal retry run first. Inspect the local file and catalog observation
read-only if it remains failed after the backfill otherwise reaches zero.

Latest local-eviction dry-run:

```json
{
  "scanned": 2168,
  "eligible": {
    "count": 362,
    "sizeBytes": 6395614125
  },
  "catalog_unverified": 1806,
  "remote_unverified": 0,
  "errors": 0
}
```

The daily local-eviction unit is capped at 250 objects and 20 GiB.

Latest full R2-GC dry-run, excluding the pending canary:

```json
{
  "eligible": {
    "count": 2542,
    "sizeBytes": 47779842627
  },
  "pending_grace": 10,
  "catalog_inconsistent": 0,
  "errors": 0
}
```

Total known catalog-led R2 reclaim including the canary is 2,552 physical
objects and 48,091,860,575 bytes (about 48.09 GB decimal / 44.79 GiB).

## R2 Remote GC implementation

The following local files contain the new implementation:

- `src/lib/media-remote-gc.ts`
- `src/lib/media-catalog.ts`
- `scripts/gc-r2-media.ts`
- `scripts/verify-media-remote-gc.ts`
- `scripts/verify-media-catalog.ts`
- `deploy/systemd/heroai-r2-remote-gc.service`
- `deploy/systemd/heroai-r2-remote-gc.timer`
- `deploy/systemd/heroai-r2-remote-gc-canary.service`
- `deploy/systemd/heroai-r2-remote-gc-canary.timer`
- `docs/ops/cloudflare-r2-media-rollout.md`

These exact source files were copied to production. The full automated R2-GC
timer was not installed at the time of the original snapshot. See the
2026-07-31 update above for its current enabled state.

The module was designed as one deep module: callers provide a mode and bounded
limits; the implementation owns grouping logical aliases by physical object,
reference checks, SHA verification, manifest gating, catalog compare-and-set,
delete grace, retry, crash recovery, and restoration when a reference becomes
live.

Safety gates for apply:

```text
MEDIA_LOCAL_EVICTION=1
MEDIA_R2_DELETE=1
R2_REMOTE_GC_ENABLED=1
MEDIA_READ_MODE=r2-local or r2
```

Automated apply additionally requires both:

```text
--automated
R2_REMOTE_GC_AUTOMATED=1
```

Manual apply requires the exact reviewed `manifestSha256`. The canary service
uses `--pendingOnly`, so it cannot stage a new object.

## Canary status

Ten reviewed R2 objects totaling 312,017,948 bytes (297.6 MiB) were staged as
`delete_pending` at approximately 2026-07-30 01:01 Asia/Bangkok.

No R2 object bytes were deleted during staging.

Checks already passed:

- stage result: 10 objects, errors 0;
- catalog inconsistencies: 0;
- active remote-only media Range request: HTTP 206, 1,024 bytes;
- pending expired canary request: HTTP 404;
- canary service ran before grace, selected 0, deleted 0, errors 0;
- `stage_disabled=2542`, proving the pending-only unit did not expand rollout.

The timer runs daily at about 01:30 Asia/Bangkok. The first run before the grace
deadline is harmless. The canary becomes physically deletable after its
24-hour grace, so the expected deletion run is approximately:

```text
2026-07-31 01:30–01:32 Asia/Bangkok
```

Before the canary stage, a SQLite backup was created:

```text
/var/www/ai-content/prisma/backups/dev.db.before-r2-gc-canary-20260730T0110Z.bak
```

The production source backup is:

```text
/var/www/ai-content/backups/remote-gc-20260730T0105Z/
```

## Verification already passed locally

- `npx tsx scripts/verify-media-remote-gc.ts`
- `npx tsx scripts/verify-media-catalog.ts`
- `npx tsx scripts/verify-media-local-eviction.ts`
- `npx tsx scripts/verify-media-storage-foundation.ts`
- `npx tsx scripts/verify-media-storage-r2.ts`
- `npx tsx scripts/verify-media-reference-graph.ts`
- `npx tsx scripts/verify-media-cleanup-mode.ts`
- `npx tsx scripts/verify-media-serving.ts`
- `npx tsx scripts/verify-media-storage-rollout.ts`
- `npx tsx scripts/verify-media-backfill-versioning.ts`
- `npx tsx scripts/verify-media-render-versioning.ts`
- `npx tsx scripts/verify-media-stock-versioning.ts`
- `npx tsc --noEmit`
- `git diff --check`

Some existing verifier processes print a non-fatal Prisma `DATABASE_URL`
initialization warning when run without an environment. The verifiers still
pass; the new remote-GC verifier sets an in-memory URL and does not emit it.

## First actions in the next session

All checks must be read-only until the current state is understood.

1. Read this entire handoff and
   `docs/ops/cloudflare-r2-media-rollout.md`.
2. Check current Bangkok time and service/timer status.
3. Read the latest journals for reconciliation, local eviction, and canary GC.
4. Query catalog state counts.
5. Run bounded backfill, local-eviction, and R2-GC dry-runs under the shared
   media-storage lock.
6. If the canary deletion deadline has passed, verify the result before enabling
   any broader GC.

Suggested status command:

```sh
cd /var/www/ai-content
systemctl show \
  heroai-r2-reconcile.timer \
  heroai-media-local-eviction.timer \
  heroai-r2-remote-gc-canary.timer \
  heroai-r2-reconcile.service \
  heroai-media-local-eviction.service \
  heroai-r2-remote-gc-canary.service \
  -p Id -p ActiveState -p SubState -p Result -p ExecMainStatus \
  --no-pager

journalctl \
  -u heroai-r2-reconcile.service \
  -u heroai-media-local-eviction.service \
  -u heroai-r2-remote-gc-canary.service \
  -n 100 --no-pager

sqlite3 -header -column prisma/dev.db \
  "SELECT remoteState,localState,COUNT(*) AS objects,
   ROUND(SUM(sizeBytes)/1024.0/1024.0,1) AS MiB
   FROM MediaObject
   GROUP BY remoteState,localState
   ORDER BY remoteState,localState;"
```

Read-only backfill:

```sh
DOTENV_CONFIG_PATH=.env.r2.production \
R2_BACKFILL_MAX_OBJECTS=1000 \
npx tsx scripts/backfill-media-r2.ts --dry-run
```

Read-only local eviction:

```sh
DOTENV_CONFIG_PATH=.env.r2.production \
npx tsx scripts/evict-local-media.ts \
  --olderThanDays=3 --includeStocks \
  --maxObjects=500 --maxBytesMb=51200
```

Read-only R2 GC:

```sh
DOTENV_CONFIG_PATH=.env.r2.production \
npx tsx scripts/gc-r2-media.ts \
  --summary --maxObjects=500 --maxBytesMb=51200 --graceHours=24
```

Use `/usr/bin/flock --exclusive --wait 3600
/run/lock/heroai-media-storage.lock` around production dry-runs when a consistent
catalog snapshot is required.

## Canary acceptance criteria

Do not enable the full R2-GC timer until all are true:

1. The canary service reports `deleted + missingFinalized = 10`.
2. `errors=0`.
3. Catalog has no canary rows stuck in `delete_pending`.
4. R2 HEAD confirms the ten physical keys are absent.
5. A known active remote-only media object still returns HTTP 206 for a Range
   request.
6. App and worker remain online.
7. No new media-serving, graph, checksum, or catalog errors appear.

If the canary fails, leave the full timer disabled. Do not bulk-delete or add an
age-only bucket lifecycle rule.

## Remaining work to reach 100%

1. Finish the remaining backfill and resolve the single failed row.
2. Re-run local-eviction dry-run after backfill reaches zero.
3. Classify any residual `catalog_unverified` retention candidates; do not delete
   them by filesystem age alone.
4. Verify the physical deletion canary.
5. Enable the full R2-GC timer only after all canary acceptance criteria pass.
6. Drain the catalog-led R2 backlog in bounded batches.
7. After backfill is zero, list R2 objects and compare physical keys with the
   catalog. Audit old `media/v1` duplicates/orphans before a separate canary.
8. Add alerts for:
   - disk usage above 80%;
   - backfill failures/conflicts;
   - remote-GC errors;
   - `delete_pending` older than 48 hours;
   - unexpected R2 growth;
   - catalog inconsistencies.
9. Require at least a seven-day error-free soak before declaring the rollout
   complete.

## Do not do

- Do not set a blanket 3/7/14-day R2 lifecycle on `media/v1` or `media/v2`.
- Do not delete R2 objects that have no catalog row while backfill candidates
  remain.
- Do not enable the full R2-GC timer before the ten-object canary is verified.
- Do not combine local eviction and R2 deletion in one operation.
- Do not bypass the shared flock.
- Do not expose R2 credentials.
- Do not overwrite or clean unrelated local or production worktree changes.

## Local worktree note

The local worktree was already dirty with unrelated user changes before this
work. Preserve them. The media/R2 files listed above are the intended changes
for this rollout; do not reset, clean, or overwrite other paths.
