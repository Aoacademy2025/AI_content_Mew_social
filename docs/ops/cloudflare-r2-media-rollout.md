# Cloudflare R2 media rollout

Status: code-ready, production remains local-only.

This migration keeps `/api/renders/*` and `/api/stocks/*` stable. The application
proxies private R2 objects, so the bucket does not need public access or a custom
domain.

## Safety invariants

- Local storage remains the required copy until R2 upload and SHA-256 metadata
  verification succeed.
- R2 writes use `If-None-Match: *`, `Content-MD5`, and immutable object keys.
- Backfill is idempotent, lease-based, bounded per run, and disabled unless both
  the command flag and environment gate are present.
- `MEDIA_LOCAL_EVICTION` and `MEDIA_R2_DELETE` stay off during migration.
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

## Stop point before disk eviction

Do not enable `MEDIA_LOCAL_EVICTION=1` or `MEDIA_R2_DELETE=1` yet. Local cache
eviction and retention-driven R2 deletion require their own reviewed apply path
and production canary evidence. The current rollout coordinator blocks mixed-mode
deletion intentionally.

Cloudflare references:

- https://developers.cloudflare.com/r2/api/s3/api/
- https://developers.cloudflare.com/r2/api/tokens/
- https://developers.cloudflare.com/r2/reference/consistency/
- https://developers.cloudflare.com/r2/objects/upload-objects/
