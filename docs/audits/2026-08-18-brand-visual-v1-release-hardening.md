# Brand Visual V1 release-hardening audit

Date: 2026-08-18
Scope: uncommitted Brand Visual/Treatment V1 worktree at
`0d924cc7690fc3db77a6623028ad3aa89cd9ce61` plus current changes
Disposition: code gates are green for the existing Paid Public Launch; production backup,
migration apply, environment confirmation, smoke checks, and deploy/flag changes
remain separately authorized operations. No deployment or paid image generation
was performed in this audit.

## Product decision frozen

- Z-Image remains the only default V1 image engine. The measured application
  cost assumption remains approximately ฿0.175 per delivered image including
  serverless overhead.
- Initial generation creates one image per AI B-roll window. There is no hidden
  quality retry, generic fallback, or automatic engine switch.
- Scene Reroll is an explicit new paid request: two credits under the existing
  price contract. Replaying the same request cannot charge twice; a failed
  delivery restores its exact allowance/credit buckets.
- Scene Reroll has no separate internal-only cohort. Existing eligible users
  retain access, including cash-paying discounted annual and Founding Price
  buyers; price discounts do not reduce product capability.
- A rerolled image is only a candidate until the creator deliberately applies
  it and the child B-roll render succeeds. Before Apply, the prior Visual Beat
  remains reusable and authoritative.

The durable decision record is
[ADR 0023](../adr/0023-z-image-remains-default-with-creator-paid-scene-reroll.md).

## Review findings and resolution

| Finding | Resolution | Regression evidence |
|---|---|---|
| Scene Reroll eagerly replaced the reusable Visual Beat or could lose its job binding during a staged swap | Persist the exact server-created MP4 derivative binding; Apply discovers a ready candidate from the server-owned unique `src`, fails closed on missing/mismatched client metadata, validates job/owner/settlement/source scene, then consumes the derivative, promotes the Beat and marks the child job done in one transaction. The editor requires Apply before moving a staged paid candidate; an already-applied derivative becomes reusable same-owner media without a second promotion. | `verify:scene-reroll-apply` (included in `verify:broll-rerender`) |
| Stock AutoMix edits could be counted as rejected first-pass AI | Derive rejection only from the original source window's AI provider/asset identity | `verify:broll-rerender` |
| Legacy Brand Preview replay replaced its saved Treatment | Missing legacy `previewTreatment` replays `payload.visual.defaultTreatment`; malformed new snapshots fail closed | `verify-brand-look-preview` within the aggregate suite |
| Project/Beat identity could mutate before a losing VideoJob CAS | Visual Beat identity, project Treatment pin and VideoJob CAS now share one transaction | forced SQLite trigger rollback in `verify-project-look` |
| Concurrent exports could write duplicate first-export events | Add nullable unique `TelemetryEvent.dedupeKey`, use an atomic upsert, hash the marker key, then scrub identifiers/payload after 90 days while retaining only the sparse marker | 12 concurrent calls plus retention/privacy contract checks in `verify-first-pass-visual-acceptance-v1` |

No broad compiler refactor was made; immutable historical recipe replay remains
unchanged.

## Migration rehearsal

The additive migrations were exercised without the live database.

- Empty database: `prisma migrate deploy` applied all repository migrations;
  `PRAGMA integrity_check` returned `ok`, foreign-key check returned no rows,
  and both the telemetry dedupe key and Scene Reroll derivative binding exist.
- Prior-schema database: the exact new migration SQL was applied to a copy with
  an existing valid user/project row. Integrity and foreign-key checks passed,
  the project titled `Preserve me` remained, and the nullable dedupe column was
  added.
- Evidence directories:
  `/tmp/brand-visual-clean-migrate-v3.N7nWen` and
  `/tmp/brand-visual-upgrade-v3.8szyLf`.

## Verification evidence

Green on 2026-08-18:

- `npm run verify:brand-treatment-v1`
- `npm run verify:brand-visual-system`
- `npm run verify:broll-rerender`
- `npm run verify:broll-window-gen`
- `npm run verify:hero-image-price`
- `npm run verify:hero-image-resilience`
- `npm run verify:ai-image-reconcile`
- `npx prisma validate`
- `npx tsc --noEmit --pretty false --incremental false`
- `npm run build` (172 static pages; Next output-file-tracing-root warning only)
- `git diff --check`

The earlier paid qualification run remains 120/120 delivered images with no
provider failure or retry. Its strict visual disposition is superseded by the
approved pragmatic acceptance in ADR 0023; it was not rerun here.

## Known toolchain dispositions

### ESLint coverage

`npm run lint` exits zero, but representative touched files are ignored because
the flat config has no matching source configuration. This is not counted as a
successful lint gate. The issue predates this hardening pass; changing unrelated
lint rules or deleting generated worktrees is outside this release. TypeScript,
focused contract suites and the production build are the enforced local static
gates until lint coverage is restored.

### Prisma/deepmerge-ts advisory

`npm audit --omit=dev` reports three High entries for one chain:
`prisma -> @prisma/config -> deepmerge-ts@7.1.5`, advisory
[GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx).
The vulnerable behavior is stack exhaustion while merging crafted recursive
object graphs. Repository inspection found no request-time import of
`@prisma/config` or `deepmerge-ts`; only trusted developer/CLI configuration
loads `prisma/config`. The tested Prisma line has no supported patched
composition, so this release does not force npm's proposed downgrade or an
unverified deep dependency override. Re-evaluate before deploy and adopt the
first supported patched Prisma dependency set.

## Remaining production operations

1. Back up the production SQLite database and verify the backup is readable.
2. Record and preserve the current production Brand Visual flags; confirm
   required secrets/cron are present and render queues are safe for deployment.
3. Apply the additive migrations and run integrity/foreign-key checks.
4. Deploy code while preserving the current production Brand Visual flags and
   existing Paid Public Launch access.
5. Smoke-test existing Stock-only creation plus Brand draft → preview → publish
   → project pin → render → reopen, then one explicit Scene Reroll → Apply on
   desktop and mobile canaries. Any paid smoke generation needs explicit cost
   approval.
6. Monitor the existing eligible population with the rollout health gates.
   Scene Reroll does not add a new internal/10→50→100 cohort; any expansion of
   the broader Brand Visual population still requires separate approval.
