# HERO-10 transaction diagnostics

Date: 2026-09-20

## Scope and result

This branch provides investigation provenance only. It does not change SQLite
transaction policy, retries, queueing, schema, provider calls, or application
outcomes. The exact remaining SQLite write-lock holder is still unknown.

`[prisma-slow-tx]` now reports the elapsed Prisma transaction-call duration and
a sanitized static source location. The elapsed duration includes time waiting
to start a transaction, so it is not a write-lock duration and source is not a
holder claim.

## Base and diff

- Base: `origin/main` at `b9d0d574b0ae71e99cdf3aaaca5889ed1cf55f43`.
- Branch: `codex/hero-10-diagnostics`.
- Changed: `src/lib/prisma.ts`, `scripts/verify-prisma-slow-tx.ts`,
  `package.json`, and `docs/ops/ops-guardrails-runbook.md`.
- Diagnostic output: `[prisma-slow-tx] #<sequence> elapsed <milliseconds>ms source=<static-location>`.

The source parser keeps only `src/...:line`, `scripts/...:line`, or a
route-relative `app/.../route.js:line` from a Next server bundle. Any other
frame is `unknown`. It never emits an absolute path, transaction arguments,
SQL, model names, or row data. A bundled route maps back to `src/app/.../route.ts`
at the deployed Git revision.

## RED then GREEN

The pre-existing `verify:prisma-slow-tx` seam was extended before the
implementation. Its required behavior is a data-free `elapsed … source=…`
line for slow calls, including a rejected transaction that preserves the exact
original exception. It also verifies a representative production Next frame
becomes `app/api/videos/route.js:1` without its absolute path.

RED:

```text
AssertionError: unexpected shape: [prisma-slow-tx] #2 held 1253ms
```

GREEN:

```text
verify-prisma-slow-tx: ALL PASS
```

The verify threshold changed from 50 ms to 1,000 ms because a fresh Prisma
client can take several hundred milliseconds to initialize. The slow test
still crosses the threshold deterministically, while the fast control no
longer treats startup overhead as a slow transaction.

## Evidence and hypotheses

1. A contending SQLite writer elsewhere remains the leading hypothesis. The
   audit confirmed recurring slow transaction and timeout symptoms, but the
   old marker had no transaction source.
2. The prior story-film lease correlation remains only a candidate: historical
   enrichment is not current direct attribution. New source values can support
   or weaken that candidate after deployment.
3. Queue and transaction timeout waits account for part of the elapsed marker:
   the timer starts before `$transaction` and observed values cluster near
   configured timeouts. A source may therefore identify a victim rather than a
   holder.
4. Nearby route or provider log lines remain non-evidence; log adjacency does
   not establish causation.

Operator use: group `source` values inside timestamped slow windows, compare
with timeout errors at the same timestamps, then investigate a repeated source
with a new discriminating probe. Do not fix a source merely because it appears
in this marker.

## 14-day retention readiness

The runbook records the approved minimal PM2 change: `retain` from 5 to 14
while preserving the observed `max_size=50M`, compression, daily rotation, and
30-second worker interval. `pm2-logrotate` retains files rather than elapsed
days, so the oldest timestamp must be checked at the end of the observation
period; missing history cannot be recreated and extra size rotations can make
14 retained files cover less than 14 days.

The root session applied the authorized production setting on 2026-09-20.
Only `pm2-logrotate:retain` changed from 5 to 14. Read-only process checks
confirmed that `ai-content`, MCP, both render workers, and story-film workers
kept their PIDs, restart counts, and statuses; only the logrotate module
reloaded. This branch made no production configuration change, restart, or
deployment.

## Validation

- `npm run verify:prisma-slow-tx` — pass.
- `npm run verify:prisma-options` — pass.
- `npx tsc --noEmit` — pass.
- `npm run build` — pass; `.next/BUILD_ID` was produced.
- `git diff --check` — pass.

The production build contains the new `elapsed … source=…` marker, and the
behavioral check covers the `.next/server/app/...` stack-frame form.

## Limitations and rollback

- Source is invocation provenance, never proof of a write-lock holder.
- A minified or non-application stack resolves to `unknown`; this signals a
  need for another probe, not a negative result.
- No production transaction is reproduced locally, and no proposed query,
  timeout, retry, or concurrency change is justified by this branch.
- Roll back code by reverting this commit. The retention setting has its
  separate operator rollback in the runbook (`retain=5`); it cannot restore
  archives that a prior setting pruned.

## PR draft

Title: `chore(observability): add safe HERO-10 transaction provenance`

Body:

> Slow transaction logs previously reported only a counter and a duration
> labeled as a hold. This change reports elapsed transaction-call time with a
> sanitized static source, so operators can investigate repeated invocation
> candidates without logging SQL, arguments, model names, row data, or absolute
> paths. It preserves transaction results and exceptions.
>
> The PM2 runbook records the 14-file retention readiness and its coverage
> limitation: file count is not a substitute for verifying timestamp coverage.
> No holder is claimed and no transaction, timeout, retry, queue, schema, or
> provider behavior changes.
>
> Validation: `npm run verify:prisma-slow-tx`,
> `npm run verify:prisma-options`, `npx tsc --noEmit`, and `npm run build`.
