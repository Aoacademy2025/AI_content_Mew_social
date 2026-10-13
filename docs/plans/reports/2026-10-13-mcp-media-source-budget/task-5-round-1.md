# Task 5 — final review fix round 1

Candidate parent: `aad67fbbe00e0923a6327f9413216649686600c0`. Same isolated Task 5 worktree, no env restoration, no production/provider calls. All commands importing application code used `DATABASE_URL=file:/tmp/mcp-task5-bootstrap.db`; runtime fixtures replace it with their own temporary SQLite and pass that environment to Prisma subprocesses.

## Confirmed failures and changes

- **B1 security, actual public render POST:** an approved external root with missing required imports was refused by shared export but accepted by `/api/videos/render` as `BURN/QUEUED` (200), including a free reservation. Own red log `/tmp/task5-round1-external-red.log`, exit 1: `200 !== 409`. The route now resolves the actual owned source by canonical render URL against persisted VideoJob outputs and RenderJob parents, then applies the existing required-slot/import validator before any burn enqueue. Caller project/root/policy fields cannot waive it. Initial non-burn previews remain allowed. Both script and presenter tests reject project-ID, omitted-ID and absolute `/renders/` alias requests with 409 and no added render; actual public burns of applied imported previews still queue free.
- **B2 correctness, actual registered status callback:** after a real restart recovery parks an export child, polling its root returned `processing` (auto) / `exporting` (held). Own red `/tmp/task5-round1-status-red.log`: `processing !== confirmation_required`. Shared status projection now resolves the active chain row and returns `confirmation_required`, `heldJobId`, retained marker, reason and owner-scoped quote/action when present. Unknown outcomes retain support/reconciliation guidance and have no invented approval. Direct-root approval remains visible, foreign roots remain not-found. The transport requested-ID shortcut was removed so all paths share the projection.
- **B3 correctness, late durable BURN:** a held export with a subsequently completed owned BURN returned `resume_unavailable`. Own red `/tmp/task5-round1-late-burn-red.log`, exit 1. Existing durable resume now recognizes export `burn`/`BURN` as well as base `render`/`RENDER`. It queues the same child under consumed approval; existing worker output reuse and completion/CAS remain unchanged. Registered prepare callback rejects unknown, foreign-owner and wrong-type results. AutoMix and Hero Image real worker fixtures now reach FINAL after restart→late BURN→resume, asserting unchanged render/provider attempts, TTS, quote count, wallet and minutes. No new billing mechanism.
- Updated public create description to all four sources and the prepare→owner Studio approval→consume contract, with validated presenter import. New registered-callback fixture checks those terms. Its verification is wired into CI. The linkage harness admits the new real external-policy dependency (no policy mock).

## Verification

Command prefix below: `DATABASE_URL=file:/tmp/mcp-task5-bootstrap.db node --import ./scripts/register-server-only-node.mjs --import tsx scripts/`. All final commands exit **0**. Thirteen final scoped invocations (12 distinct scripts; orchestrator run for both image sources), no repeated broad sweep.

| Script / variant | Result | Log under `/tmp/` |
|---|---|---|
| verify-mcp-held-chain-status.ts | 5 PASS groups; actual registered callbacks, auto/held, owner isolation, known/unknown burns | task5-round1-verify-mcp-held-chain-status.ts.log |
| verify-mcp-external-media.ts | 83 PASS lines plus 6 direct public denial assertions and 2 valid public free burns | task5-round1-external-final.log |
| verify-mcp-budget-orchestrator.ts | 7 PASS groups; ordinary USER AutoMix FINAL with late-BURN recovery | task5-round1-orchestrator.log |
| `BUDGET_FIXTURE_SOURCE=hero-ai-image` verify-mcp-budget-orchestrator.ts | 7 PASS groups; ordinary USER Hero FINAL with late-BURN recovery | task5-round1-hero.log |
| verify-mcp-spending-summary.ts | 7 PASS groups | task5-round1-verify-mcp-spending-summary.ts.log |
| verify-mcp-chain-export.ts | 147 passed, 0 failed | task5-round1-verify-mcp-chain-export.ts.log |
| verify-mcp-chain-linkage.ts | 99 passed, 0 failed | task5-round1-verify-mcp-chain-linkage.ts.log |
| verify-mcp-billing-receipt.ts | 4 passed | task5-round1-verify-mcp-billing-receipt.ts.log |
| verify-mcp-budget.ts | 7 PASS groups | task5-round1-verify-mcp-budget.ts.log |
| verify-mcp-video-quote.ts | PASS owner/auth/expiry/input/price/zero-spend/presenter | task5-round1-verify-mcp-video-quote.ts.log |
| verify-external-media-policy.ts | 4 PASS groups | task5-round1-verify-external-media-policy.ts.log |
| verify-clip-charge.ts | 22 passed | task5-round1-verify-clip-charge.ts.log |
| verify-mcp-ci-coverage.ts | 51 matching scripts covered or validly excluded | task5-round1-verify-mcp-ci-coverage.ts.log |

`DATABASE_URL=file:/tmp/mcp-task5-bootstrap.db ./node_modules/.bin/tsc --noEmit`: exit 0 (`/tmp/task5-round1-tsc.log`).
`DATABASE_URL=file:/tmp/mcp-task5-bootstrap.db npm run build`: exit 0; production compile, TypeScript, 193 generated pages (`/tmp/task5-round1-build.log`). Sentry release upload skipped without auth; no release/deploy performed.
Baseline-wide lint: `eslint` on all 78 changed existing TS/TSX/JS/MJS files since `4c2461805dcc2633675996a82ce391cfe706ff60` including the new script: exit 0, same 15 pre-existing warnings, no introduced warnings (`/tmp/task5-round1-lint-final.log`). Final linkage harness import edit additionally linted exit 0 (`/tmp/task5-round1-linkage-lint.log`). `git diff --check`: exit 0.

Intermediate fixture-only failures resolved: duplicate local `recoverProcessingJobsAfterWorkerRestart` declaration caused orchestrator transform exit 1, removed duplicate; linkage strict import harness rejected new `@/lib/external-media.server`, loaded actual module and reran99pass. Initial scoped lint reported newly unused transport `prisma` after removing shortcut; removed import. No production workaround or assertion suppression. One requested nonexistent filename `verify-mcp-held-preview.ts` was skipped by runner; real held-chain coverage is the new registered callback fixture and existing99-check linkage suite. Python batch runners report each child exit; their wrapper exit alone is not used as test evidence.

## Remaining gate and limits

Independent correctness recheck pending this commit. Independent security reviewer terminated after B1; **no final security PASS**. Root owns any bounded review extension and delivery decision; no replacement reviewer spawned. Providers/full rendered bytes remain synthetic, actual import normalization/DB/route/worker logic exercised. No live Clerk/proxy or production readiness claim. Original rollout/rollback constraints and HERO-70 exclusion remain.
