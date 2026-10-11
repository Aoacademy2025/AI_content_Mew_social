# Task 4 — image failure classification and RunPod cost coverage

Status: scoped code correction verified locally; no production change. Baseline `149efd96`, branch `codex/image-cost-fix-20261011`.

## Findings and issue disposition

**HERO-78:** The video scene catch in `src/app/api/videos/fetch-stock/route.ts` mapped any `isSqliteWriteContentionError` result to `PROVIDER_POLL_FAILED`. A real callback replay with a synthetic Prisma P1008/Socket timeout reproduced the wrong telemetry code (exit 1 against `origin/main`). The one-line correction reports `DB_CONTENTION`; true `HeroImageGenerationError("PROVIDER_POLL_FAILED")` still carries `RUNPOD_FAILED` and stops the batch. Scene retry selection, generation, charges, refunds and fallback are untouched. This corrects the error taxonomy, **not** the underlying SQLite contention. HERO-10/HERO-70 remain the relevant root-cause work.

Production read-only metadata at investigation time: 137 `PROVIDER_POLL_FAILED` scene telemetry events in seven days had `providerErrorCode=null`; 112 belonged to parents now done, 20 to two failed parents, five to one canceled parent. The code has another missing-provider-identity branch with the same code, so the events cannot each be proven SQLite solely from telemetry. The present callback mapping, absence of provider error codes, and recorded endpoints make local errors the leading explanation. These are events, not 137 distinct failed jobs or provider outages.

Seven-day durable image attempts: 324 public-route attempts, 254 completed with provider IDs and reported costs (1,270,000 USD micros), 69 failed/refunded without IDs or `submittedAt` (58 `PARENT_VIDEO_TERMINAL`, 11 `PARENT_VIDEO_FAILED`), and one parent-terminal failed/refunded attempt with a provider ID but no reported cost. The 69 are parent-terminal accounting rows without durable submission evidence. The old image path does not populate `dispatchIntentAt`/`submissionDisposition`, so an accepted request with a lost response cannot be ruled out for every no-ID row. No negative wallets or pending refunds were found by the audit.

**HERO-75:** The audited BillingSync mismatch is expected for the current `runpod-public` Z-Image route. Production web and the shared worker have the public route enabled; public model selection uses the model's default endpoint while the hourly billing cron reads the configured private endpoint. Endpoint hashes differ (`d06ed654ef94` active public attempts, `4a01c644891c` BillingSync); no endpoint identifiers or keys are recorded here. Public COGS comes from `AiGenerationAttempt.providerReportedCostUsdMicros`, not `RunpodBillingSync`. Do **not** repoint the private-endpoint billing cron to the public endpoint or interpret its zero rows as zero production image cost. No production config correction is supported.

The direct production read-only call to `getActiveRunpodImageCostSnapshot({windowDays:30})` returned `providerRoute=runpod-public`, `costSource=provider_reported_attempts`, 2,121 priced of 2,289 finished attempts, 2,088 delivered images, `costCoverage=partial`, `status=healthy`, `admitted=true`. Of 168 unpriced attempts, 20 have provider IDs; their actual costs remain unknown. The accounting helper makes image P&L `totalBaht=null` when coverage is partial. The active-route `healthy` assessment uses observed prices and must not be read as complete COGS. Do not exclude uncertain no-ID rows merely to make coverage green.

**Recommended HERO-75 disposition:** cancel the initial endpoint-sync defect claim as disproven. The existing `partial`/unknown P&L is conservative and correct under current snapshot policy. If complete provider cost attribution is needed, retain or retitle HERO-75 as a **Backlog investigation** limited to the 20 provider-ID attempts without cost, with a provider-side read-only billability check as its acceptance evidence. That investigation does not justify a speculative code or configuration change today.

## Feedback loop and verification

- `VERIFY_BASELINE_ROUTE=1 node --import tsx scripts/verify-hero-image-scene-error.ts`: exit **1**, expected `DB_CONTENTION`, actual `PROVIDER_POLL_FAILED` from the extracted real scene callback.
- `node --import tsx scripts/verify-hero-image-scene-error.ts`: exit **0**. It checks SQLite, true provider poll, unrelated local failure, and normal success/one-charge paths through that callback.
- `node --import tsx scripts/verify-hero-image-scene-retry.ts`: exit **0**.
- `node --conditions=react-server --import tsx scripts/verify-ai-image-reconcile.ts`: exit **0**; isolated SQLite and stub provider verify settle/refund exactly once, late cost preservation, no-ID refund, and retry accounting.
- `node --import tsx scripts/verify-runpod-image-cost-db.ts`: exit **0**; isolated DB covers active public cost aggregation, partial coverage for unpriced attempts, and custom billing.
- `node --conditions=react-server --import tsx scripts/verify-hero-image-price.ts`: exit **0**; scoped funding and refund checks.
- `DATABASE_URL=file:/tmp/hero-task4-types.db npx tsc --noEmit`: exit **0**.
- `npx eslint src/app/api/videos/fetch-stock/route.ts scripts/verify-hero-image-scene-error.ts`: exit **0**, zero errors, two unrelated existing route warnings at lines 3112/3781.
- `git diff --check`: exit **0**.

Local setup: `npm ci` exited **0**; the first `npx prisma generate` exited **1** because `DATABASE_URL` was absent, and the retry with `DATABASE_URL=file:/tmp/hero-task4-prisma-generate.db` exited **0**. The first read-only production getter invocation exited **1** from a test wrapper import-shape error (`$disconnect` was undefined); using CommonJS `require` returned the snapshot above and exited **0**. Neither failed setup command changed production state.

The production commands were read-only: SQLite `mode=ro` with `pragma query_only=ON`, filtered PM2 metadata, and the active-cost snapshot getter. No generation, cancellation, deployment, restart, config, credit or database mutation was performed. Local tests used only synthetic data and throwaway SQLite databases.

## Remaining diagnostic question

The telemetry does not retain the inner error class or failed stage, so the exact fraction of 137 events caused by local DB contention is unprovable from existing rows. After the taxonomy fix is released, separate `DB_CONTENTION` from genuine `PROVIDER_POLL_FAILED` at the scene event and correlate with HERO-70's production SQLite metrics. For the 20 thirty-day submitted unpriced attempts, use provider-side read-only cost evidence keyed to durable job IDs before making any completeness or reimbursement claim; do not issue provider requests that generate or cancel jobs.
