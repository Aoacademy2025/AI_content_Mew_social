# Subscription-first AI implementation verification

Date: 2026-08-13
Status: code-complete for a separately approved Paid Soft Launch; not deployed.

## Implemented contract

- One canonical Paid-Equivalent resolver authorizes active paid subscriptions
  and terms, paid Bundle, active GRANT coupon, and audited Administrator Grant.
  A raw `User.plan`, Trial, FREE, or DISCOUNT coupon alone fails closed.
- Administrator Grants require plan, reason, and timed expiry or explicit
  permanent choice; grants and revocations retain actor and reason history.
- Conversion Trial is seven days and Hero AI Image only, with eight delivered
  images once. Reservations settle on delivery and restore on failure. It never
  renews every 30 days.
- Hero Script is preview-only for FREE/Trial and full for internal or
  Paid-Equivalent cohorts.
- Brand Visual rolls out only within the paid cohort; paid rollout-wait accounts
  see an honest waiting state and never an upgrade paywall.
- Locked Hero Image, AutoMix, Hero Script, and Brand Visual remain visible and
  lead to contextual monthly/annual pricing where an upgrade is applicable.
- `/api/user/me` returns source-aware feature decisions for UI disclosure; APIs
  independently re-resolve authorization before provider work or reservation.
- Insights now leads with MAPC and Thai Metric Help. Daily history stores counts
  only, with no user identifiers, prompts, or media URLs.

## MAPC contract

`MAPC = unique active cash-backed monthly/annual recurring customers with ≥1
durable Core Creation Outcome in trailing 30 days`.

Durable outcomes are completed video with output, saved Script, or settled Hero
AI Image from `hero_video`, `automix`, or `scene_reroll`. Internal/Admin,
FREE/Trial, coupon-only, grant-only, previews, failures, cancellations, and
retries are excluded.

## Migration rehearsal

A disposable empty SQLite database was migrated through all five migrations.
`PRAGMA integrity_check` returned `ok`, foreign-key check returned no violations,
and Prisma reported no migration/schema difference. Both backfill tools then
completed in dry-run mode with zero unresolved reservations.

The rehearsal found and closed an existing migration-history gap for Bundle
columns/table through the additive `20260813114500_bundle_schema_catchup`
migration. Production still uses the repository's normal backup-first additive
`prisma db push` path; no production database command was run.

## Green verification set

- TypeScript, ESLint, and Next 16.3 production build.
- Full npm audit and production-only npm audit: zero findings.
- Hero Image gate, disclosure, price/reservation/refund resilience.
- Hero Script service, payment, coupon, and Paid-Equivalent access.
- Full Brand Visual system and rollout suite.
- Paid-Equivalent, Administrator Grant, one-time Trial allowance, and MAPC
  disposable-DB integrations.

## Remaining launch gates

- Production backup, dry-run counts, migration apply, smoke checks, and flag
  changes require a separate approval.
- Production must provide `KEY_ENC_SECRET` before accepting BYOK/provider keys;
  existing keys must be migrated with `scripts/encrypt-existing-keys.ts` so no
  reversible base64 value remains at rest.
- Hero Script repaired Hooks and Brand Visual paid cohort still need real
  production soak. Start with Paid Soft Launch and Brand Visual 10%, then use
  explicit reliability/cost thresholds before 50% and 100%.
