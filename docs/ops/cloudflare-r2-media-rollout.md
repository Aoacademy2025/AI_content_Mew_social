# Cloudflare R2 media rollout

Status: production reads R2 first with local fallback; copy reconciliation is
continuous. The 10-object physical-deletion canary passed, and bounded
reference-aware R2 GC is enabled with a seven-day recovery grace. Blanket
age-based bucket lifecycle deletion remains prohibited.

This migration keeps `/api/renders/*` and `/api/stocks/*` stable. The application
proxies private R2 objects, so the bucket does not need public access or a custom
domain.

## Safety invariants

- Local storage remains the required copy until R2 upload and SHA-256 metadata
  verification succeed.
- R2 writes use `If-None-Match: *`, `Content-MD5`, and immutable object keys.
- Render and stock filenames are mutable logical aliases. New or changed bytes
  are stored under
  `media/v2/<area>/blobs/<sha-prefix>/sha256-<sha>.<ext>`, and the catalog
  publishes `remoteFilename` only after the physical object is verified.
- Backfill is idempotent, lease-based, bounded per run, and disabled unless both
  the command flag and environment gate are present.
- Local eviction is a separate verified workflow. It never deletes R2 objects.
- `MEDIA_R2_DELETE` stays off during migration and local eviction.
- Never paste R2 credentials into tickets, chat, commands, or logs.

## Required Cloudflare resources

Create a staging bucket whose name contains `staging` or `test`, then create two
bucket-scoped S3 API tokens:

- Object Read & Write for upload/backfill.
- Object Read only for playback.

Configure these through the host's protected environment:

```dotenv
R2_ACCOUNT_ID=
R2_BUCKET=heroai-media-staging
R2_WRITE_ACCESS_KEY_ID=
R2_WRITE_SECRET_ACCESS_KEY=
R2_READ_ACCESS_KEY_ID=
R2_READ_SECRET_ACCESS_KEY=

MEDIA_WRITE_MODE=local
MEDIA_READ_MODE=local
MEDIA_LOCAL_EVICTION=0
MEDIA_R2_DELETE=0
```

`R2_ENDPOINT` is optional. If supplied, the application accepts only the matching
Cloudflare R2 account endpoint, including `eu` and `fedramp` jurisdiction forms.

## Stage 1: isolated staging smoke

Run:

```sh
npm run smoke:r2-staging
```

The smoke test refuses a bucket without `staging` or `test` in its name. It
uploads a random small object, verifies full and Range reads, materializes it,
deletes exactly that object, and verifies absence.

Do not continue if this test fails.

## Stage 2: deploy with no behavior change

1. Back up SQLite.
2. Apply the additive Prisma schema with the normal deployment procedure.
3. Deploy the application with all four `MEDIA_*` values still set to local/off.
4. Verify health, playback, Range requests, render completion, disk, and error
   rate.

Rollback is an application rollback only; no customer media has moved or been
deleted in this stage.

## Stage 3: bounded production backfill

Use a separate production bucket and production-scoped tokens. First run the
read-only inventory:

```sh
R2_BACKFILL_MAX_OBJECTS=10 npm run backfill:r2
```

Then enable a small apply batch:

```sh
R2_BACKFILL_ENABLED=1 R2_BACKFILL_MAX_OBJECTS=10 npm run backfill:r2 -- --apply
```

Increase the batch size gradually only while failures and conflicts remain zero.
A failed upload retains the local file and is retried with backoff. A key
collision is fail-closed and requires review.

Legacy stock rows that were uploaded to mutable `media/v1/stocks/*` keys are
intentionally candidates again after the additive `remoteFilename` schema change.
The backfill hashes the current local bytes, uploads a new immutable v2 object,
and switches the logical alias only after verification. It does not overwrite or
delete the legacy object. Existing legacy collision rows can therefore recover
without discarding either byte version.

Verified, unchanged legacy renders may remain on their existing v1 objects.
New, changed, or collided renders use immutable v2 objects, so a producer that
reuses a logical render filename cannot overwrite or collide with an earlier
byte version.

After the 10- and 100-object canaries pass, install the non-overlapping
reconciliation timer. It keeps direct-to-local producer paths covered during the
migration and after future restarts:

```sh
install -m 0644 \
  deploy/systemd/heroai-r2-reconcile.service \
  /etc/systemd/system/heroai-r2-reconcile.service
install -m 0644 \
  deploy/systemd/heroai-r2-reconcile.timer \
  /etc/systemd/system/heroai-r2-reconcile.timer
systemctl daemon-reload
systemctl enable --now heroai-r2-reconcile.timer
```

The oneshot service uploads at most 100 new objects per run, never overlaps
itself, runs behind customer-facing work, and is capped at 4 GiB. The next run
starts 15 minutes after the previous run exits. Inspect it without exposing
credentials:

```sh
systemctl status heroai-r2-reconcile.timer
systemctl status heroai-r2-reconcile.service
journalctl -u heroai-r2-reconcile.service -n 100 --no-pager
```

The timer is copy-only. It does not authorize local eviction or R2 deletion.

## Stage 4: read canary

After a representative verified backfill, change only:

```dotenv
MEDIA_READ_MODE=r2-local
```

R2 is tried first and local remains the fallback. Missing or unavailable R2 does
not delete or mutate local media. Roll back immediately by returning
`MEDIA_READ_MODE=local`.

`local-r2` is available for local-first fallback testing, but it does not exercise
R2 while the local copy exists.

The edge must not terminate a missing local `/renders`, `/stocks`,
`/api/renders`, or `/api/stocks` request with an alias-only 404. Keep the static
Nginx fast path, but configure `try_files` to fall through to the
`@media_storage_fallback` named location in `deploy/nginx.conf`. That location
normalizes legacy media URLs to their `/api/...` route and proxies only the local
miss to the application's R2-aware reader. After every Nginx change, require
`nginx -t`, a zero-downtime reload, and successful 1 KiB Range canaries for:

- a local render and stock file;
- an evicted render and stock file; and
- both the `/api/...` and legacy non-API URL forms.

## Stage 5: verified local eviction

Local eviction is allowed only while reads use `r2-local` or `r2`. The workflow
starts from the retention/reference-graph cleanup plan and therefore selects only:

- media whose complete reference set has expired under its 3/7/14-day policy; or
- media with no reference and a local mtime older than 14 days.

Before removing each local copy it requires an unchanged catalog observation,
`remoteState=verified`, a matching immutable v2 alias (or immutable legacy render),
matching size/mtime/SHA-256, and a second R2 HEAD verification after the local file
has been atomically quarantined. The catalog state changes with a compare-and-set.
Any pre-delete failure restores the local path. R2 deletion is explicitly rejected.

Run a read-only bounded inventory:

```sh
DOTENV_CONFIG_PATH=.env.r2.production \
  npx tsx scripts/evict-local-media.ts \
  --olderThanDays=3 --includeStocks --maxObjects=10 --maxBytesMb=1024
```

Run a small canary only after the dry-run has zero errors:

```sh
MEDIA_LOCAL_EVICTION=1 DOTENV_CONFIG_PATH=.env.r2.production \
  npx tsx scripts/evict-local-media.ts \
  --apply --olderThanDays=3 --includeStocks --maxObjects=3 --maxBytesMb=256
```

Verify health, Range playback for an evicted identity, queue state, disk free
space, and logs before installing the daily timer:

```sh
install -m 0644 \
  deploy/systemd/heroai-media-local-eviction.service \
  /etc/systemd/system/heroai-media-local-eviction.service
install -m 0644 \
  deploy/systemd/heroai-media-local-eviction.timer \
  /etc/systemd/system/heroai-media-local-eviction.timer
install -m 0644 \
  deploy/systemd/heroai-r2-reconcile.service \
  /etc/systemd/system/heroai-r2-reconcile.service
systemctl daemon-reload
systemctl enable --now heroai-media-local-eviction.timer
```

The reconciliation and eviction services share an exclusive lock, so upload
catalog transitions cannot overlap eviction. The catch-up timer runs every four
hours and is capped at 500 objects and 50 GiB per run. Keep
`MEDIA_R2_DELETE=0`; lifecycle deletion from R2
is a separate future policy and is not required to protect VPS disk capacity.

## Stage 6: reference-aware R2 garbage collection

Do not add an age-only lifecycle rule to `media/v1/` or `media/v2/`. Object age
does not encode the complete 3/7/14-day reference policy, and one immutable v2
blob may be shared by several logical media aliases.

Remote GC is catalog-led and fail-closed. A physical R2 object is eligible only
when:

- every catalog alias that points at it is locally evicted;
- every alias has only expired references, or has no references and is at least
  14 days old;
- every alias is in the verified catalog state;
- the full media reference graph has zero errors; and
- R2 HEAD metadata still matches catalog size and SHA-256.

The first apply changes the aliases to `delete_pending` for seven days. Gallery
visibility has already ended at the tier expiry; this R2-only interval is an
internal recovery window. A later run rebuilds the reference graph before
deleting. If a live reference appears during
the grace period, the catalog alias is restored to `verified`. Physical deletion
is SHA-gated and idempotent; an already-missing object is finalized as deleted
so a crash between the R2 delete and catalog update can recover safely.

Run a bounded dry-run:

```sh
DOTENV_CONFIG_PATH=.env.r2.production \
  npx tsx scripts/gc-r2-media.ts \
  --maxObjects=10 --maxBytesMb=1024 --graceHours=168
```

Review the records and copy the exact `manifestSha256` from that run. Stage only
that reviewed manifest:

```sh
MEDIA_LOCAL_EVICTION=1 MEDIA_R2_DELETE=1 R2_REMOTE_GC_ENABLED=1 \
DOTENV_CONFIG_PATH=.env.r2.production \
  npx tsx scripts/gc-r2-media.ts \
  --apply --manifestSha256=<REVIEWED_SHA256> \
  --maxObjects=10 --maxBytesMb=1024 --graceHours=168
```

After the grace deadline, repeat dry-run and hash-gated apply to delete the
canary. Require zero errors, the expected `deleted`/`missingFinalized` count,
healthy Range playback, and no new media graph errors before automation.

The pending-only canary timer may be installed after a reviewed stage. It can
delete at most 10 already-pending objects and cannot stage a new object:

```sh
install -m 0644 \
  deploy/systemd/heroai-r2-remote-gc-canary.service \
  /etc/systemd/system/heroai-r2-remote-gc-canary.service
install -m 0644 \
  deploy/systemd/heroai-r2-remote-gc-canary.timer \
  /etc/systemd/system/heroai-r2-remote-gc-canary.timer
systemctl daemon-reload
systemctl enable --now heroai-r2-remote-gc-canary.timer
```

The automated unit has two additional gates (`--automated` and
`R2_REMOTE_GC_AUTOMATED=1`) and shares the same exclusive media-storage lock:

```sh
install -m 0644 \
  deploy/systemd/heroai-r2-remote-gc.service \
  /etc/systemd/system/heroai-r2-remote-gc.service
install -m 0644 \
  deploy/systemd/heroai-r2-remote-gc.timer \
  /etc/systemd/system/heroai-r2-remote-gc.timer
systemctl daemon-reload
systemctl enable --now heroai-r2-remote-gc.timer
```

After the full timer is verified active, disable the pending-only canary timer
so two automated GC schedules do not compete for the same pending backlog:

```sh
systemctl disable --now heroai-r2-remote-gc-canary.timer
```

If backfill leaves a failed catalog observation after its source path has
disappeared, do not delete it with ad-hoc SQL. Use the bounded catalog
reconciler in dry-run mode, review its exact manifest, back up SQLite, and apply
only while holding the shared media-storage lock:

```sh
/usr/bin/flock --exclusive --wait 3600 \
  /run/lock/heroai-media-storage.lock \
  env DOTENV_CONFIG_PATH=.env.r2.production \
  npx tsx scripts/reconcile-media-catalog.ts \
  --maxObjects=25 --olderThanMinutes=30

/usr/bin/flock --exclusive --wait 3600 \
  /run/lock/heroai-media-storage.lock \
  env MEDIA_CATALOG_RECONCILE=1 DOTENV_CONFIG_PATH=.env.r2.production \
  npx tsx scripts/reconcile-media-catalog.ts \
  --apply --manifestSha256=<REVIEWED_SHA256> \
  --maxObjects=25 --olderThanMinutes=30
```

The reconciler fails closed on graph errors, references, present local paths,
remote receipt fields, unsupported error codes, retry grace, manifest drift,
and catalog compare-and-set drift. It preserves eligible audit rows as
`abandoned/missing`; a file that later reappears can re-enter backfill.

The catalog retains the object key, SHA-256, size, `remoteState=deleted`, and
timestamp as the deletion audit record; it does not retain the media bytes.
Legacy R2 objects that have no catalog row are inventory-only until the
copy-reconciliation backlog is zero. Never bulk-delete those orphan candidates
during migration.

The bucket is private and the application proxies R2 reads. If a future custom
R2 domain or Cloudflare Cache Rule caches media directly, add a cache purge for
each deleted URL before treating physical deletion as complete.

Cloudflare references:

- https://developers.cloudflare.com/r2/api/s3/api/
- https://developers.cloudflare.com/r2/api/tokens/
- https://developers.cloudflare.com/r2/reference/consistency/
- https://developers.cloudflare.com/r2/objects/upload-objects/
