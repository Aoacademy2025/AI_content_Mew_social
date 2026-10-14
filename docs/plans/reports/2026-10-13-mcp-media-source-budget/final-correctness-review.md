# Independent whole-branch correctness and specification review

Status: **PASS — whole-branch correctness/specification code review.** Confirmed B2/B3 are independently reproduced and resolved. B1 functional correction/regression checks also pass. No unresolved correctness blocker remains. **Separate final security gate is incomplete and is not certified by this report; AC9 delivery is not complete.**

Baseline: `4c2461805dcc2633675996a82ce391cfe706ff60`.
Initial candidate reviewed: `aad67fbbe00e0923a6327f9413216649686600c0`.
Final corrected candidate: `24a7b170` (review-worktree cherry-pick `e0beaa84`; `git diff 24a7b170 HEAD --stat` is empty).
Reviewer worktree: `/Users/mewsocialmacmini/orca/workspaces/AI_content_Mew_social/mcp-budget-final-correctness`.

## Isolation and method

Independent read of the approved plan, all changed application modules and schema/CI/rollout changes, with detailed review of quote resolution/consumption, immutable settings, image and render admission, durable checkpoints/recovery, external planning/import/shared editor enforcement, web CAS activation, and receipt settlement. Test migrations were compared against their original assertions; shifted new creation tests now use approval while historical import behavior remains explicitly isolated.

Orca's copied `.env` and `.env.r2.production` were removed from this worktree before setup or application imports. Every application command used explicit disposable `DATABASE_URL`; database tests create their own throwaway SQLite. `npm ci --ignore-scripts` and Prisma generation each exited 0. No production writes, providers, deployment, real session rehearsal or external messages. No production files edited.

## Resolved blocker B2 — public root polling hides paused export descendant

Severity: medium; blocking AC5/AC8 truthful actionable recovery.

Locations at original candidate: `src/app/api/[transport]/route.ts:130` checks only requested ID for `confirmation_required`; `src/lib/mcp/tools.ts:190` maps an auto export descendant to processing, and `src/lib/mcp/tools.ts:305` maps a held descendant to exporting/rerendering via the in-flight set.

Trigger: an approved root finishes its preview, its inherited export child reaches burn submission, and the worker restarts while the render outcome has no known durable child. The actual `recoverProcessingJobsAfterWorkerRestart` parks that quote-bound child in `confirmation_required`. The caller continues polling the original root job ID as directed by the public contract.

Expected: resolved active-chain status reports `confirmation_required`, identifies the paused job and provides truthful reconciliation instructions (or an owner-scoped incremental quote when appropriate). Unknown outcome must not fabricate an approval URL.

Actual: registered `get_video_status` callback returns `processing` for the automatic root or `exporting` for the held root, with no next action or retained-checkpoint marker; directly querying the child returns the correct held response. This can cause indefinite polling of work the worker will never claim.

Evidence: `scripts/review-final-status-probe.ts` executes the actual registered callback with only MCP/Clerk transport stubbed, real approved creation/consumption, inherited export creation and actual restart recovery. It uses a synthetic completed preview and interrupted render checkpoint, no provider output. `/tmp/mcp-final-correctness-evidence/status-probe.log`, exit 0, records both variants. Direct root approval-hold assertions pass and expose the incremental quote correctly.

Smallest correction: derive the active owner-scoped chain row before rendering confirmation status and share its hold projection for direct and root/descendant alias polling. Preserve ordinary historical processing statuses and no-repeat-spend behavior.

An earlier suspicion that direct root approval holds omitted the quote was retracted: the public transport already handles that case. Only the independently reproduced descendant/root mismatch above is a finding.

## Resolved blocker B3 — known late export burn cannot resume

Severity: medium; blocking AC5 known-result recovery without repeated work.

Location: `src/lib/mcp/video-budget-checkpoint.ts:134` recognizes `currentStep === "render"` and looks for `type: "RENDER"` only. `recoverProcessingJobsAfterWorkerRestart` handles known BURN rows while a job is processing, but its initial query does not reconsider confirmation-held rows.

Trigger: same actual interrupted export fixture as B2; after recovery parks the descendant at `currentStep: "burn"`, the pending HTTP render request completes and supplies a durable BURN row in DONE state with a nonempty output URL. This is a now-known result under the existing approval.

Expected: `prepare_video_job({resumeJobId: child.id})` requeues the same child using the durable burn. No new approval, provider or render should be necessary. Unknown render requests must remain held.

Actual: actual `prepareVideoQuote` returns `resume_unavailable`, and the child remains `confirmation_required`, for automatic and held chains. Independent probe log records both.

Smallest correction: teach known-result recovery the same export/BURN identity and save-safety invariants already used by restart recovery; permit exact retained child continuation only when a durable eligible result exists. Test late result after the initial park, not only result present before restart.

## Independently executed checks

Logs in `/tmp/mcp-final-correctness-evidence/`.

| Check | Exit | Scope |
|---|---:|---|
| `verify-mcp-budget.ts` | 0 | Ordinary USER original AutoMix receipt reproduction, atomic consume/replay, cap races, incremental continuation, trial, unknown exposure and known image recovery |
| `verify-mcp-spending-summary.ts` | 0 | Current durable image/render/trial totals, chain transfer, actual refund helpers, mixed minutes/credits, rollback on failure, partial/historical reconciliation |
| `verify-mcp-external-media.ts` | 0 | Real import normalization and shared editor/export flows, script/presenter required slots and ownership; paid providers/render output stubbed |
| `verify-mcp-budget-orchestrator.ts` | 0 | Ordinary USER AutoMix final export, retained narration/media, known render restart, free web/service exports and authoritative route guards |
| `BUDGET_FIXTURE_SOURCE=hero-ai-image verify-mcp-budget-orchestrator.ts` | 0 | Ordinary USER Hero AI Image final export and same funding/recovery assertions |
| `verify-mcp-ci-coverage.ts` | 0 | New source-specific checks reachable from CI after ffmpeg setup |
| `verify-mcp-video-quote.ts` | 0 | Owner/auth/expiry/input/pricing/default pinning and no-work quote preparation |
| `review-final-status-probe.ts` | 0 | Reproduces B2/B3 with real registered public status callback, actual restart recovery and actual prepare/resume |
| `verify-broll-apply-recovery.tsx` | 0 | Mounted pending draft revision → null → new Apply plus existing interruption/remount/race checks |

Full worker evidence (56 invocations, build, tsc, changed-file lint, CI coverage) was reviewed but not represented as independently rerun. Focused checks above are separate reviewer executions.

## Round 1 independent correction recheck

Read the entire 13-file correction delta and its worker evidence. The original independent reviewer probe was retained in `/tmp/mcp-final-correctness-evidence/status-probe-before-fix.ts` and its red-behavior output in `status-probe-before-fix.log`. Only expected assertions were changed for the fix recheck; the same real registered callback, actual restart recovery and actual resume paths now pass for both auto and held chains.

All commands below used explicit disposable `DATABASE_URL`, server-only marker loader and tsx. Each command was executed directly and exited **0**:

| Recheck | Log in `/tmp/mcp-final-correctness-evidence/` |
|---|---|
| Original reviewer B2/B3 probe | `status-probe-after-fix.log` |
| `verify-mcp-held-chain-status.ts` | `held-chain-after-fix.log` |
| `verify-mcp-external-media.ts` | `external-after-fix.log` |
| `verify-mcp-budget-orchestrator.ts` AutoMix | `orchestrator-after-fix.log` |
| Same orchestrator with `BUDGET_FIXTURE_SOURCE=hero-ai-image` | `orchestrator-hero-after-fix.log` |
| `verify-mcp-spending-summary.ts` | `spending-after-fix.log` |
| `git diff --check 4c246180..HEAD` | tool output, exit 0 |

B2: the shared active-chain projection now reports confirmation-required through the root and exposes `heldJobId`, reason, retained marker and correct owner-scoped next action. Direct-root approval retains its quote URL; unknown outcomes have no invented quote. Foreign-owner and wrong-result cases remain refused.

B3: a later owned BURN result resumes the same export child under the original consumed quote. The real orchestrator fixtures complete final export with unchanged render count, provider-render invocation counter, TTS count, quote count, wallet and minutes. Wrong-type/foreign-owner/no-known-child cases remain held.

B1 functional recheck: script and presenter public burn requests with incomplete required imports refuse before creating a render, including requests omitting IDs and equivalent canonical URL aliases. Applied owned external media still queues a free BURN. Initial previews, shared import/edit/export and required-slot ownership checks still pass. This is functional verification of the reported correction, not a replacement whole-branch security verdict.

Worker-reported round-1 production build, TypeScript, baseline-wide lint and 13 scoped checks were reviewed, not independently repeated. No new evidence justified another full build. The changed create tool description now accurately includes all four sources, preparation/Studio approval and validated presenter import; the prior copy advisory is resolved.

## Review conclusions

- AC1–4: source choice and separate charges are disclosed; quote preparation does not enqueue work or reserve money; approval uses Clerk browser adapter and same-origin POST; execution retains normalized work/defaults and quote idempotency. AutoMix USER cap and receipt guards verified.
- AC5: server admission uses shared transactional billing and root budgets; known results retain existing attempts; B2/B3 recovery/status defects are resolved and independently rechecked.
- AC6: external ownership/required slots, import identity, MCP/web edit parity and atomic final activation are implemented; the separate security reviewer identified direct render route enforcement gap B1. Its correction and functional regressions were independently checked here without certifying the separate security gate.
- AC7: refund correction reuses mixed reservation helper and only marks the exact matching mirror refunded after actual atomic full return. Partial/historical cleared flags deliberately remain reconciliation-required. Verified independently.
- AC8: historical jobs remain quote-free, and eligible free exports retain one render charge. Imported replacements are supported; there is no per-window creative-reroll receipt workflow.
- AC9: rollout and rollback notes preserve additive schema/enforcement and explicitly exclude live readiness. Separate security review completion and reviewed PR remain coordinator obligations.

Live Clerk/proxy behavior and actual paid provider readiness remain unverified. HERO-70 database contention is explicitly separate and unresolved.
