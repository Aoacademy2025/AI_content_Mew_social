# Cloudflare R2 media rollout

Status: production reads R2 first with local fallback; copy reconciliation is
continuous. R2 deletion remains disabled.

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
catalog transitions cannot overlap eviction. The daily job is capped at 250
objects and 20 GiB per run. Keep `MEDIA_R2_DELETE=0`; lifecycle deletion from R2
is a separate future policy and is not required to protect VPS disk capacity.

Cloudflare references:

- https://developers.cloudflare.com/r2/api/s3/api/
- https://developers.cloudflare.com/r2/api/tokens/
- https://developers.cloudflare.com/r2/reference/consistency/
- https://developers.cloudflare.com/r2/objects/upload-objects/
