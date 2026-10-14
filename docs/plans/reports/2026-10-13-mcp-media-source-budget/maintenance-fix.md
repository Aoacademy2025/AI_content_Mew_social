# Approved public creation maintenance correction

Date: 2026-10-14. Worktree: `mcp-budget-maintenance`; base `314fe70a`.

## Change and root cause

`create_video_job` delegated approved execution to the quote transaction, whose authoritative `assertRenderEnqueueOpen(tx)` throws `RenderDeployDrainError`. The public route's generic catch flattened that exception into `internal_error`. Commit `bcb7d198` catches only that typed exception at the create callback and returns `render_maintenance`, `retryable: true`, the shared Thai customer message and a next step to retry `create_video_job` with the same `quoteId`. All other exceptions retain the existing wrapper handling. No transactional, funding, schema or provider logic changed. The customer-copy source assertion remains intact.

The existing CI-covered actual-public-route integration test now uses an ordinary USER, prepares and approves a stock quote, enables the database drain, and checks the specific error/copy/retry guidance. A snapshot proves unchanged quote, wallet, minute/ledger/reservation counters, jobs and projects. After clearing the drain, the same approval creates exactly one job and replay returns its identity. Providers remain stubbed; this is no production-readiness claim.

## Failing-before evidence

`DATABASE_URL=file:/tmp/mcp-maintenance-unused.db node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-mcp-edit-draft.ts` exited **1** before production edits: **127 passed, 3 failed**. The failures were classification/retryability, shared copy, and actionable next. Actual reply:

```json
{"error":"internal_error","message":"เกิดข้อผิดพลาดภายใน ลองใหม่อีกครั้ง"}
```

Rollback and retry identity already passed. Log: `/tmp/mcp-maintenance-red.log`.

## Targeted verification

All app commands used explicit disposable `DATABASE_URL`; copied `.env` and `.env.r2.production` were removed without reading before imports. `node_modules` links to the task5 dependency installation; no shared database is used.

| Command (all prefixed with disposable DATABASE_URL) | Exit / evidence |
| --- | --- |
| `node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-mcp-edit-draft.ts` | 0; 130 passed, 0 failed; `/tmp/mcp-maintenance-green.log` |
| `node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-mcp-video-quote.ts` | 0; owner/auth/expiry/input/price/zero-spend/presenter checks |
| `node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-mcp-budget.ts` | 0; atomic consume, concurrency, approval, balances, entitlements, recovery |
| `npm run verify:customer-error-copy` | 0; ALL PASS |
| `node_modules/.bin/tsc --noEmit` | 0, both initial and after test-only corrections |
| `node_modules/.bin/eslint 'src/app/api/[transport]/route.ts' scripts/verify-mcp-edit-draft.ts` | 0 |
| `node --import tsx scripts/verify-mcp-ci-coverage.ts` | 0; 51 matching scripts covered or validly excluded |
| `npm run verify:render-deploy-drain` | 1 initially: disposable DB had no schema (`P2021 main.RenderJob`); after `prisma db push --skip-generate` (0), rerun 0 / ALL PASS |
| `npm run verify:render-plan-preflight` | 1 before test path correction; 0 after; scoped ESLint 0 |
| `npm run verify:hero-image-scene-retry` and `npm run verify:hero-image-scene-coverage` | 0 after harness dependency correction; scoped ESLint 0 |

## Later CI harness corrections

The locally executed CI tail revealed two stale source-harness assumptions beyond the original failure:

- `5a141bb4`: `verify-render-plan-preflight.ts` searched the former route location for `voiceProviderPlanViolation`, causing two failed assertions. It now checks the actual approved-consumption service, `video-budget.server.ts`; the web gate assertion is unchanged. Actual quote and budget behavior suites also pass.
- `6a08095a`: `verify-hero-image-scene-error.ts` executes an extracted worker callback. Its dependency injection lacked the newly referenced `VideoBudgetHoldError`, producing `ReferenceError` before classifying other failures. It now injects the real class and additionally proves the identical budget exception propagates for approval handling. Existing provider/local error checks remain.

No production code changed in either correction.

## Broader verification

Executed all **73 command groups** following the failed customer-copy gate, including the two workflow-specific database initialization groups and all ffmpeg/media commands (using installed local ffmpeg/ffprobe, without Linux package-manager commands). **70 passed immediately**. The two stale harness corrections above passed exact reruns; the upload runtime correction below also passed. Additional `npm run lint:brands` exited **0**, with one existing `@next/next/no-img-element` warning in `AdvancedSettings.tsx:335`. The generated hero-script desktop screenshot was restored; no generated artifact change is included.

The direct upload test originally failed before its tests with `Invariant: AsyncLocalStorage accessed in runtime where it is not available`. The alternate existing server-only preload also failed identically. Next's real `node-environment-baseline.js` supplies its required AsyncLocalStorage global before matcher compilation; adding that preload to only `verify:media-import-upload` preserves the existing `--conditions=react-server` and all fixture checks. The corrected direct command passed **161/161**, exit **0**. Package-only commit `7c41e149` updates that invocation. The exact `DATABASE_URL=file:/tmp/mcp-maintenance-upload-final.db npm run verify:media-import-upload` rerun also exited **0**, **161/161** (`/tmp/mcp-maintenance-upload-final.log`).

All runner commands inherited an explicit `DATABASE_URL=file:<mkdtemp mcp-maintenance-later-…>/test.db`; fixture suites that provision their own disposable SQLite retain that behavior. Raw output remains in `/tmp/mcp-maintenance-later-N.log`, and the initial ledger is `/tmp/mcp-maintenance-later-summary.txt`. The following table records every command and initial result; corrected reruns are identified without erasing failures.

Build intentionally left to final hosted CI per coordinator direction. Prior accepted candidate build evidence belongs to the existing Task 5 report; **no new build was run here**. No push, merge, deploy or production action.

| Group | Command | Initial exit | Corrected rerun |
| --- | --- | --- | --- |
| 0 | `npm run verify:customer-error-copy` | 0 | — |
| 1 | `npm run verify:task2-transport` | 0 | — |
| 2 | `npm run verify:quota-error-shape` | 0 | — |
| 3 | `npm run verify:founding-copy-truth` | 0 | — |
| 4 | `./node_modules/.bin/prisma db push --skip-generate && npm run verify:founding-member-upgrade` | 0 | — |
| 5 | `npm run verify:arr-revenue-shape` | 0 | — |
| 6 | `npm run verify:plan-cash-vs-credits` | 0 | — |
| 7 | `npm run verify:renewal-receipts` | 0 | — |
| 8 | `npm run verify:payment-ledger-repair` | 0 | — |
| 9 | `npm run verify:standard-annual-switch` | 0 | — |
| 10 | `npm run verify:render-plan-preflight` | 1 | 0 |
| 11 | `npm run verify:content-preflight-thai-name` | 0 | — |
| 12 | `npm run verify:admin-error-notify` | 0 | — |
| 13 | `npm run verify:hero-script-launch` | 0 | — |
| 14 | `npm run verify:hero-script-workspace` | 0 | — |
| 15 | `npm run verify:admin-insights-revenue` | 0 | — |
| 16 | `npm run verify:admin-insights-range` | 0 | — |
| 17 | `npm run verify:job-failure-class` | 0 | — |
| 18 | `npm run verify:admin-trends` | 0 | — |
| 19 | `npm run verify:admin-overview` | 0 | — |
| 20 | `npm run verify:admin-number-telemetry-window` | 0 | — |
| 21 | `npm run verify:admin-number-video-completed` | 0 | — |
| 22 | `npm run verify:revenue-growth` | 0 | — |
| 23 | `npm run verify:money-only-on-revenue` | 0 | — |
| 24 | `npm run verify:admin-number-paying-cash-only` | 0 | — |
| 25 | `npm run verify:admin-number-mrr-actual-cash` | 0 | — |
| 26 | `npm run verify:admin-number-bangkok-day` | 0 | — |
| 27 | `npm run verify:admin-number-ledger-source` | 0 | — |
| 28 | `npm run verify:admin-number-mapc-definition && npm run verify:north-star` | 0 | — |
| 29 | `npm run verify:admin-number-committed-trialing` | 0 | — |
| 30 | `npm run verify:runpod-image-cost` | 0 | — |
| 31 | `./node_modules/.bin/prisma db push --skip-generate && npm run verify:runpod-image-cost-runtime && npm run verify:cost-margin` | 0 | — |
| 32 | `npm run verify:ai-image-reconcile` | 0 | — |
| 33 | `npm run verify:prisma-options && npm run verify:prisma-transient-retry && npm run verify:hero-image-scene-retry && npm run verify:hero-image-scene-coverage` | 1 | 0 |
| 34 | `npm run verify:omnivoice && npm run verify:hero-voice-clone && npx tsx scripts/verify-hero-voice-durable.ts` | 0 | — |
| 35 | `npm run verify:managed-stock` | 0 | — |
| 36 | `npm run verify:brands-mobile` | 0 | — |
| 37 | `npm run verify:brands-ci` | 0 | — |
| 38 | `npm run verify:prisma-options && npm run verify:prisma-slow-tx` | 0 | — |
| 39 | `npm run verify:prisma-slow-query` | 0 | — |
| 40 | `npm run verify:credit-balance-read-under-lock` | 0 | — |
| 41 | `npm run verify:notification-index` | 0 | — |
| 42 | `npm run verify:story-film-lease-poll` | 0 | — |
| 43 | `npm run verify:media-stream` | 0 | — |
| 44 | `npm run verify:sentry-config` | 0 | — |
| 45 | `npm run verify:editor-diagnostics-privacy && npm run verify:editor-diagnostics-behavior && npm run verify:editor-script-loop` | 0 | — |
| 46 | `npm run verify:editor-panel-resize` | 0 | — |
| 47 | `npm run verify:frontend-error-noise` | 0 | — |
| 48 | `npm run verify:dashboard-stats-fetch-catch` | 0 | — |
| 49 | `npm run verify:sentry-line-alert` | 0 | — |
| 50 | `npm run verify:cron-route` | 0 | — |
| 51 | `npm run verify:safe-fetch` | 0 | — |
| 52 | `npm run verify:media-import-fetch` | 0 | — |
| 53 | `npm run verify:media-import-capacity` | 0 | — |
| 54 | `npm run verify:support-observability-links` | 0 | — |
| 55 | `npm run verify:sidebar-updates-summary-once` | 0 | — |
| 56 | `npm run verify:storage-health` | 0 | — |
| 57 | `npm run verify:subtitle-fonts-scope` | 0 | — |
| 58 | `npm run verify:admin-navigation` | 0 | — |
| 59 | `npm run verify:db-backup-r2` | 0 | — |
| 60 | `npm run verify:upload-probe-whitelist` | 0 | — |
| 61 | `npm run verify:ffmpeg-input-hardening` | 0 | — |
| 62 | `npm run verify:media-import-broll-pipeline` | 0 | — |
| 63 | `npm run verify:broll-upload-color-levels` | 0 | — |
| 64 | `npm run verify:media-import-presenter-checks` | 0 | — |
| 65 | `npm run verify:media-import-upload` | 1 | 0; direct + exact npm, each 161/161 |
| 66 | `npm run verify:media-import-lane` | 0 | — |
| 67 | `npm run verify:mcp-broll-window-edits` | 0 | — |
| 68 | `npm run verify:broll-window-style-render` | 0 | — |
| 69 | `npm run verify:mcp-preview-frame` | 0 | — |
| 70 | `npm run verify:mcp-clip-import-job` | 0 | — |
| 71 | `npm run verify:mcp-approved-media` | 0 | — |
| 72 | `npm run verify:export-audio-sync` | 0 | — |

## Delivery

Production/regression commit `bcb7d198`; test-only followups `5a141bb4`, `6a08095a`, `7c41e149`. TypeScript after the TypeScript test changes exited 0 (`/tmp/mcp-maintenance-final-tsc.log`); all changed TypeScript files passed scoped ESLint. The final package-only preload does not change TypeScript source. Independent reviews and hosted CI are coordinator-owned and are not asserted as worker results here. Worktree has no remaining source changes or generated screenshot changes.
