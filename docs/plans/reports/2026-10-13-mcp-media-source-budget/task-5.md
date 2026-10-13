# Task 5 — integrated delivery candidate

Integration base: `2430fab9b08177c1f2d38962329c3ab537572468`; review baseline: `4c2461805dcc2633675996a82ce391cfe706ff60`. Worktree: `/Users/mewsocialmacmini/orca/workspaces/AI_content_Mew_social/mcp-budget-task5`; branch: `codex/mcp-budget-task5`. Candidate SHA is supplied in the commit notification (this report is part of that commit).

## Result

All 56 regression invocations have passing final results: 44 passed on the single broad sweep, and 12 obsolete fixtures passed after scoped migrations/reruns. These are 55 script paths plus the Hero AI Image variant of the budget orchestrator. The suite does not count an ADMIN exemption as ordinary-user success. TypeScript, changed-file lint, production build, CI coverage and diff hygiene pass. Independent whole-branch correctness/security gates are pending; no PR was pushed/opened or production operation performed by this worker.

Full exact-command table, red excerpts, counts, limitations and local raw-log locations: [task-5-verification.md](task-5-verification.md). Rollout/rollback: [mcp-media-approval-rollout.md](../../../ops/mcp-media-approval-rollout.md). PR draft: [task-5-pr-body.md](task-5-pr-body.md), title in `task-5-pr-title.txt`.

## Changes

- Migrated edit/background-music/B-roll/persistence/preview fixtures through actual public create→quote→owner decision→consume. Existing assertions continue to check shared edits, free export, CAS, ownership and real still-frame pixels.
- Historical waiting-import fixtures explicitly seed retained shared historical cores; the current public route separately refuses unknown-duration URLs before creating a job. External validated owned presenter imports go through real approved creation and final export.
- Replaced obsolete direct-create/in-flight source assertions with approval/no-job and actual waiting-provider overlap-cap behavior. Updated moved source-location checks and fixed the read-only receipt fixture to include an actual settled RenderJob reservation, rather than trusting cached output JSON.
- Added final export to ordinary USER AutoMix and Hero AI Image budget-orchestrator variants; the same root and quote survive known image settlement/resume. Export adds no wallet or minute debit.
- Added actual public HTTP forged image-parent/provenance denial test. Internal mismatch remains an explicitly bounded defense-in-depth advisory for final security review, not a proven public exploit.
- Fixed reproduced mounted web lifecycle defect: when successful export clears `pendingEdit`, reset the retired CAS revision and hydration guard before the next Apply. The failing browser assertion was `7 !== undefined`; the actual hook remains mounted through draft→null→new edit.
- Fixed reproduced public failure-envelope omission: unquoted `confirmation_required` now includes an actionable Thai `message`. It still returns the same prepared receipt and requires owner approval.
- Wired every new verification script through `verify:mcp-approved-media` in CI **after** system ffmpeg installation. The CI guard also covers external-policy/native-upload scripts without an MCP prefix. The existing CI `verify:broll-apply-recovery` step runs the new mounted-hook regression.

## Four ordinary USER outcomes and paid-stub boundary

| Source | Actual exercised path | Result |
|---|---|---|
| Stock | Real MCP transport/auth fixture → prepared receipt → owner approval service → consume → orchestrator held root → edit/export worker | FINAL; edit suite122, chain suite147; free eligible export preserved |
| AutoMix | USER receipt-guard reproduction (paired ADMIN control), prepare/approve/consume, actual image reservation/settlement, retained HTTP uncertainty/resume, export tool and worker | FINAL; numeric approved image cap; no repeated TTS/image debit or export debit |
| Hero AI Image | Same real quote/funding/orchestrator/export path using `BUDGET_FIXTURE_SOURCE=hero-ai-image` | FINAL; approved count/credit/total limits retained |
| External | USER script and presenter quote/consume; actual URL/upload image+video ffmpeg normalization; shared MCP/web pending edits, required-slot guards, stale activation refusal, rerender/export | FINAL for both modes;81 assertions, no stock or Hero image-provider call; zero image-generation credits |

Paid TTS, image provider HTTP endpoints, render/composite output media and gallery transport are synthetic in the end-to-end fixtures. Database billing, funding transfer, approval, import normalization, orchestrator control flow and shared export are real. Preview-frame tests additionally perform real local Remotion still rendering of synthetic files. This is not a real-provider or production readiness rehearsal.

## UI evidence and isolation

All work occurred in one new Orca worktree. Removed only its copied `.env`/`.env.r2.production` before any imports; `npm ci --ignore-scripts`; explicit disposable database URLs for generation, commands and subprocesses. No production DB, provider charge, deployment, restart, customer reply or Linear mutation.

Production confirmation component + HTTP adapter were exercised at desktop1280 and mobile390 widths using explicit localhost fixture identities. Signed-out/wrong-owner denial and owner approve/reject worked; inspected screenshots are alongside this report (`task-5-approve.png`, `task-5-rejected-mobile.png`, `task-5-signed-out.png`, `task-5-wrong-owner.png`). Real Clerk/proxy integration remains unverified. The shared editor lifecycle browser test uses a separate fixture auth-fetch stub and the actual hook; production auth is untouched.

## Remaining review focus and limits

- Direct internal `admitBudgetImage` with mismatched key-parent versus historical JSON-parent returned null before checking mismatch; the public route rejects a browser/PAT's forged service provenance and fields before reservation, and known service callers derive both values from one ID. No reachable public bypass was reproduced. See verification report for exact evidence; independent security review remains required.
- All caps/recovery operate on exact approved work. There is no per-window creative-reroll quote UI; changed creation needs a new approved job, while imported replacement remains supported.
- HERO-70 SQLite contention remains separate and unresolved. No live-load claim.
- The inherited CI exclusion for pre-ADR0056 subtitle-quality blocking assertions remains unchanged. Current budget/orchestrator/export regression selections run and pass.
- Baseline-wide lint warnings are documented separately in the verification report; no lint errors remain.

Worker remains active for independent final review and up to two confirmed-blocker fix rounds. Root owns plan/progress integration and authorized PR delivery.
