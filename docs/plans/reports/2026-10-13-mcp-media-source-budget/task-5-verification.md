# Task 5 verification evidence

Baseline: `4c2461805dcc2633675996a82ce391cfe706ff60`. Integration base: `2430fab9b08177c1f2d38962329c3ab537572468`.

All commands ran in the Task 5 Orca worktree with its copied `.env` and `.env.r2.production` removed before imports. Every application-importing invocation had an explicit disposable `DATABASE_URL`; the sweep propagated a unique `/tmp/task5-suite-*.db` URL to every subprocess and initialized its schema. Individual integration fixtures further allocate their own isolated SQLite files. No production credentials or DB were used.

## Once-through regression selection

56 child invocations (55 distinct scripts/source configurations plus the separate Hero variant): 44 initially passed; 12 stale fixtures failed. All 12 received scoped reruns. The table records the original and final exit codes. No full regression sweep was repeated.

Command prefix `N` below is exactly `node --experimental-test-module-mocks --import ./scripts/register-server-only-node.mjs --import tsx`. The Hero variant used the same marker/tsx imports without `--experimental-test-module-mocks`, prefixed `BUDGET_FIXTURE_SOURCE=hero-ai-image`. Reruns used the same marker/tsx imports; unused experimental mocks were omitted in the final targeted set.

| Command | First exit | Final exit | Final script output |
|---|---:|---:|---|
| `N scripts/verify-mcp-audit-client-capture.ts` | 0 | 0 | ✅ MCP audit client capture: all checks passed |
| `N scripts/verify-mcp-audit-status.ts` | 0 | 0 | 34 assertions passed ✅ |
| `N scripts/verify-mcp-avatar-duration-guard.ts` | 0 | 0 | ✅ MCP avatar duration admission guards passed |
| `N scripts/verify-mcp-avatar-input.ts` | 0 | 0 | 21 assertions passed ✅ |
| `N scripts/verify-mcp-background-music.ts` | 1 | 0 | OK: background music change + ducking: all checks passed |
| `N scripts/verify-mcp-billing-receipt.ts` | 0 | 0 | ✅ ALL 4 MCP BILLING RECEIPT CHECKS PASSED |
| `N scripts/verify-mcp-broll-window-edits.ts` | 1 | 0 | MCP B-roll window edits: all checks passed |
| `N scripts/verify-mcp-budget-orchestrator.ts` | 0 | 0 | PASS ordinary USER approved automix through real orchestrator to held preview; numeric cap propagated; authoritative funding transferred once (media/render providers stubbed) |
| `N scripts/verify-mcp-budget.ts` | 0 | 0 | PASS atomic approved consume, immutable work, entitlement revocation and different-key replay |
| `N scripts/verify-mcp-cancel.ts` | 0 | 0 | 93 passed, 0 failed |
| `N scripts/verify-mcp-chain-export.ts` | 0 | 0 | 147 passed, 0 failed |
| `N scripts/verify-mcp-chain-linkage.ts` | 1 | 0 | 99 passed, 0 failed |
| `N scripts/verify-mcp-ci-coverage.ts` | 0 | 0 | ✅ ALL MCP CI-COVERAGE CHECKS PASSED |
| `N scripts/verify-mcp-clip-import-job.ts` | 1 | 0 | MCP clip import job: all checks passed |
| `N scripts/verify-mcp-create-input.ts` | 0 | 0 | ✅ ALL 17 MCP CREATE INPUT CHECKS PASSED |
| `N scripts/verify-mcp-database-busy.ts` | 0 | 0 | verify-mcp-database-busy: ALL PASS |
| `N scripts/verify-mcp-edit-draft.ts` | 0 | 0 | ✅ MCP edit draft: all checks passed |
| `N scripts/verify-mcp-edit-persist-export.ts` | 1 | 0 | ✅ MCP edit persistence across export: all checks passed |
| `N scripts/verify-mcp-edit-tools.ts` | 1 | 0 | ✅ MCP edit tools: all checks passed |
| `N scripts/verify-mcp-external-media.ts` | 0 | 0 | PASS zero image-generation ledger |
| `N scripts/verify-mcp-failure-fields.ts` | 0 | 0 | ✅ ALL 76 MCP FAILURE-FIELDS CHECKS PASSED |
| `N scripts/verify-mcp-gemini-voice-style.ts` | 1 | 0 | ✅ ALL 15 MCP geminiVoiceStyle FORWARDING CHECKS PASSED |
| `N scripts/verify-mcp-hotfix-policies.ts` | 0 | 0 | ✅ MCP hotfix policy checks passed |
| `N scripts/verify-mcp-image-parent-boundary.ts` | 0 | 0 | PASS actual fetch-stock HTTP refuses forged body provenance/parent/key before image reservation; ordinary USER, owned historical and foreign IDs |
| `N scripts/verify-mcp-onboarding.ts` | 0 | 0 | 118 assertions passed ✅ |
| `N scripts/verify-mcp-orchestrator-steps.ts` | 0 | 0 | ✅ ALL 19 ORCHESTRATOR-STEP CHECKS PASSED |
| `N scripts/verify-mcp-parity.ts` | 0 | 0 | ✅ MCP parity (split-script sentence cards + b-roll windows): all passed |
| `N scripts/verify-mcp-pipeline-timeout.ts` | 0 | 0 | ✅ ALL PIPELINE-TIMEOUT CHECKS PASSED |
| `N scripts/verify-mcp-preview-frame.ts` | 1 | 0 | 104 passed, 0 failed |
| `N scripts/verify-mcp-release-gates.ts` | 0 | 0 | ✅ MCP RELEASE GATE CHECK PASSED |
| `N scripts/verify-mcp-spending-summary.ts` | 0 | 0 | PASS spending summary: durable images/refund helpers, transferred render, trial, approvals, descendant, pending, ownership |
| `N scripts/verify-mcp-stock-gate.ts` | 1 | 0 | ✅ ALL MCP STOCK GATE CHECKS PASSED |
| `N scripts/verify-mcp-subtitle-style.ts` | 1 | 0 | ✅ MCP subtitle style: all checks passed |
| `N scripts/verify-mcp-token.ts` | 0 | 0 | ✅ ALL 22 MCP TOKEN CHECKS PASSED |
| `N scripts/verify-mcp-tool-gating.ts` | 0 | 0 | ✅ MCP tool gating: all checks passed |
| `N scripts/verify-mcp-tools.ts` | 1 | 0 | ✅ ALL 19 MCP TOOLS CHECKS PASSED |
| `N scripts/verify-mcp-transport-disconnect.ts` | 0 | 0 | verify-mcp-transport-disconnect: 18 passed, 0 failed |
| `N scripts/verify-mcp-video-edit-link.ts` | 0 | 0 | 30 passed, 0 failed |
| `N scripts/verify-mcp-video-quote.ts` | 0 | 0 | PASS quote owner/auth/expiry/input/price/zero-spend and presenter checks |
| `N scripts/verify-mcp-videojob.ts` | 0 | 0 | ✅ ALL 52 VIDEOJOB CHECKS PASSED |
| `N scripts/verify-external-media-policy.ts` | 0 | 0 | PASS maximum public duration at normal/fast/minimum cadence and oversized-caption splitting fits bounded edits |
| `N scripts/verify-external-web-upload.ts` | 0 | 0 | PASS native upload: validation/admission retained; only successful server-normalized output mints owner-scoped ready identity; hostile form fields ignored |
| `N scripts/verify-render-receipt.ts` | 0 | 0 | All render-receipt checks passed. |
| `N scripts/verify-render-reservation-settlement.ts` | 0 | 0 | ALL PASS |
| `N scripts/verify-safe-fetch.ts` | 0 | 0 | verify-safe-fetch: 409/409 passed |
| `N scripts/verify-media-import-fetch.ts` | 0 | 0 | ✅ ALL 814 MEDIA IMPORT FETCH CHECKS PASSED |
| `N scripts/verify-media-import-upload.ts` | 0 | 0 | 161 passed, 0 failed |
| `N scripts/verify-media-import-capacity.ts` | 0 | 0 | 73 passed, 0 failed |
| `N scripts/verify-media-import-lane.ts` | 0 | 0 | 149 passed, 0 failed |
| `N scripts/verify-broll-rerender.ts` | 0 | 0 | ALL 146 BROLL-RERENDER CHECKS PASSED |
| `N scripts/verify-broll-apply-recovery.tsx` | 0 | 0 | PASS: staged transition/fit + project default reach the request, lock during apply, survive refresh, clear on adopt |
| `N scripts/verify-hero-image-namespace-guard.ts` | 1 | 0 | ALL PASS |
| `N scripts/verify-pipeline-error-specificity.ts` | 0 | 0 | ✅ verify-pipeline-error-specificity PASSED |
| `N scripts/verify-video-failure-credit-settlement.ts` | 0 | 0 | verify-video-failure-credit-settlement: ALL PASS |
| `N scripts/verify-video-options.ts` | 0 | 0 | 28 assertions passed ✅ |
| `BUDGET_FIXTURE_SOURCE=hero-ai-image N scripts/verify-mcp-budget-orchestrator.ts` | 0 | 0 | PASS ordinary USER approved hero-ai-image through real orchestrator to held preview; numeric cap propagated; authoritative funding transferred once (media/render providers stubbed) |

## Toolchain / browser commands

| Command | Exit / evidence |
|---|---|
| `DATABASE_URL=file:/tmp/mcp-task5-bootstrap.db npm ci --ignore-scripts` | 0 |
| `DATABASE_URL=file:/tmp/mcp-task5-bootstrap.db npx prisma generate` | 0 |
| `DATABASE_URL=file:/tmp/mcp-task5-bootstrap.db npx tsc --noEmit` | 0, final rerun after fixture edits |
| `DATABASE_URL=file:/tmp/mcp-task5-build.db npx prisma db push --skip-generate` | 0; isolated build schema only |
| `DATABASE_URL=file:/tmp/mcp-task5-build.db NEXT_TELEMETRY_DISABLED=1 npm run build` | 0 twice; initial build, then necessary rebuild after reproduced missing confirmation message fix; 193 static pages |
| `node_modules/.bin/eslint <all changed .ts/.tsx/.mts/.mjs since baseline, including untracked fixture>` | 0; 77 files, 0 errors / 15 warnings |
| `DATABASE_URL=file:/tmp/mcp-task5-bootstrap.db node --import tsx scripts/verify-mcp-ci-coverage.ts` | 0; 50 matched scripts reachable/excluded correctly |
| `git diff --check` | 0 |
| `DATABASE_URL=file:/tmp/mcp-task5-bootstrap.db node --import tsx scripts/verify-broll-apply-recovery.tsx` | red 1 (`7 !== undefined`); green 0 (full existing recovery/browser checks plus mounted-null regression) |
| `DATABASE_URL=file:/tmp/mcp-task5-bootstrap.db node --import ./scripts/register-server-only-node.mjs --import tsx scripts/serve-mcp-video-quote-fixture.ts` | local-only fixture server; Puppeteer desktop1280/mobile390 signed-out/foreign/approve/reject checks exit0; stopped after capture |

Browser automation used local Chrome against localhost only. It loaded the production confirmation component and HTTP adapter with test-only identities. Screenshots `task-5-approve.png`, `task-5-rejected-mobile.png`, `task-5-signed-out.png`, `task-5-wrong-owner.png` were inspected; the mobile document width was390px without horizontal overflow. Approval and rejection responses were read after clicking. This does **not** verify real Clerk/proxy integration.

## Recorded red evidence and resolution

- `verify-mcp-edit-draft`: original `21 passed, 13 failed`; unquoted create returned `confirmation_required`. Real route prepare→owner decide→consume now preserves edit/export assertions (`122 passed, 0 failed`).
- Mounted lifecycle: `AssertionError: cleared server draft must not send its retired revision with the next Apply`, `7 !== undefined`. Reset the CAS revision and hydration guard on null; no component remount was used. Full existing browser recovery checks pass.
- New confirmation response: `assert.equal(typeof unapproved.message, "string")` failed (`undefined` versus `string`). Added the actionable Thai message without changing approval/consume logic. Budget/quote/chain checks and production rebuild pass.
- Background music, B-roll windows, edit tools/persistence and preview-frame fixtures likewise expected unquoted creation. They now pass through actual approval. Preview-frame subsequently exposed an invalid historical fixture path: `/api/renders/preview-red.mp4` was correctly refused by the normalized B-roll import resolver; changed the fixture to `/api/stocks/preview-red.mp4` and real Remotion pixel assertions pass (104).
- Historical clip-import fixture now explicitly seeds legacy jobs through retained `parseClipJobArgs`/`startClipImport`/`createMcpVideoJob`/`settleClipImportJobSafely` cores. It retains actual import lane/worker/ownership/cancel/expiry assertions. New public remote-presenter refusal is separately exercised before those historical cases. The public validated owned-import success path remains in quote/external tests. No legacy route is restored in production.
- Chain-linkage mock needed the real newly imported budget-admission module; funding/provider spies remain. Voice-style, subtitle-style, stock and namespace source-location checks were updated for quote normalization/shared authorization; persisted quote voice behavior is exercised.
- Read-only tool fixture previously embedded fictional settled billing JSON without any RenderJob. It now supplies a real DONE render reservation (1minute/2credits), matching the authoritative reader. Receipt/refund tests independently cover actual ledger transitions.
- Lint initially found the new fixture variable `module` (renamed `routeModule`) and two pre-existing `any` uses in a now-changed subtitle test (typed generic stubs). Final lint has no errors.

## Internal parent advisory (not a demonstrated public exploit)

A disposable direct call to `admitBudgetImage` with a quote-bound `video:<root>:scene:0` key but an owned historical `inputJson.videoJobId` returned `null` before the mismatch check; no reservation was invoked. This reproduces the internal defense-in-depth weakness. The actual compiled fetch-stock HTTP route, with an ordinary USER identity and no private service credential, rejects forged `fromRenderPipeline`, `confirmed`, `parentJobId`, `inputJson` and `idempotencyKey` for owned historical and foreign IDs with403 `pipeline_only`, zero image rows and zero credit ledger rows. Production `generateHeroImageForVideo` receives both the key and parent from the same route-derived videoJobId; no current public caller-controlled pair was found. No public bypass is claimed or waived; final independent security review should examine this boundary.

Full local raw logs: `/tmp/task5-regression/`, `/tmp/task5-*-red.log`, `/tmp/task5-build-final.log`, `/tmp/task5-lint-final2.log`, `/tmp/task5-tsc-final2.log`. The table and excerpts above are the committed evidence. Existing CI exclusion `verify-mcp-orchestrator.ts` is unchanged (obsolete pre-ADR0056 subtitle quality gate); all current orchestrator/budget/export selections listed above run.

## Lint warning classification

All15 final warnings predate this branch's baseline (checked with `git show 4c2461805dcc2633675996a82ce391cfe706ff60:<file>` piped to `eslint --stdin --stdin-filename <file>` for the8 affected files). No newly introduced warning remains.13 are unused identifiers: B-roll-window test2, editor hook2, render route1, edit-tools5, orchestrator1, pending-draft1, Hero image service1. The other2 are unused eslint-disable directives in the hook and fetch-stock route. Baseline source checks also expose an existing React ref lint error in the old hook; the final whole-file lint run has0errors. Comparison output: `/tmp/task5-lint-baseline-warnings.log`.
