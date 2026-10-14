# Task 2 — approved execution, authoritative ceilings and retained checkpoints

Worktree: `mcp-budget-task2`; branch: `codex/mcp-budget-task2`; baseline: `2a8bbd7a2d7bf9a4c49f0c3d3ca4980b8ead6e44`. No production writes, external providers, copied environment, or shared databases. Dependencies installed locally with `npm ci --ignore-scripts`; integration fixtures create and remove throwaway SQLite databases.

## Implemented

- Public create now prepares a confirmation when unquoted. Quote-ID-only execution uses the protected execution snapshot. Optional changed work fails. Quote consumption, project/root creation, and existing render funding share one transaction; transport idempotency keys cannot create another root. Current owner, expiry, prices, account suspension, MCP/image/voice entitlement and wallet funding are checked before consuming. Replays return the owned original job's actual state.
- Persisted quote references on video/image rows establish authority. Descendants inherit through owner-checked source jobs. Root locking serializes image admission and actual-duration top-ups; reserved and settled exposure are disjoint. Count, image credits, render credits, and total ceilings apply at the existing image reservation and render funding boundaries. Existing wallet/allowance/ledger logic is reused. Client hints and idempotency/root strings cannot raise ceilings.
- The existing AutoMix receipt guard stays intact. Approved input carries its numeric count. Hero-only jobs cannot silently demote to stock; approved AutoMix may. External source maps to no stock; full import/window work belongs Task 3.
- Narration, caption/planning calls and completed media selections have persistent checkpoints. A budget hold preserves funding and artifacts, excludes automatic worker claiming and deploy-drain runnable counts, and exposes confirmation-required status. Recovery parks uncertain in-flight quote jobs rather than generically replaying them. Incremental receipts link immutable original approval, retained job and checkpoint revision/hash; they distinguish additional ceiling from cumulative exposure. Expired/rejected incremental quotes can be renewed through `prepare_video_job({resumeJobId})`.
- Unknown image/TTS submission outcomes fail closed. Generic failure/cancel cleanup cannot refund ambiguous image reservations. Known provider terminal outcomes permit reconciliation; pending-refund flags converge through settlement retry. Cancellation stays idempotent. Existing historical jobs without a quote reference retain their prior behavior.
- ElevenLabs submission reads the server-persisted approved voice/model; a changed account model cannot alter a job mid-flight. Shared render transfer cannot fall back to a fresh charge on quote-bound jobs. Shared broll rerolls refuse unapproved new creative work.
- Additive Prisma columns/indexes only; no migration/deployment executed. `prisma generate` and fixture `db push` ran locally. Runtime rollout requires normal schema rollout before new code.

## Tests-first evidence and layers

`verify-mcp-budget.ts` first executes the real source-extracted receipt guard with the real worker source mapping: ordinary USER returns `render_receipt_required` when maxAiImages is missing; ADMIN bypasses it. This is guard-level evidence, not full provider integration. Its initial atomic-consume test failed because the new service did not exist, before implementing it. A regression then proved generic image refund incorrectly released an ambiguous submitting attempt; the authority seam now retains it. Final entitlement verification initially failed at `assert.ok("jobId" in first)` / `plan_required`: the fixture had only a plan label, so existing synchronization downgraded it. The fixture now supplies actual PAID evidence and an active term; a paired revoked-entitlement test verifies refusal without consumption.

The same script uses real Prisma, quote approval/consumption, image reservation, existing credit ledger, render funding and cancellation/reconciliation against SQLite. It verifies unquoted zero-job behavior, approval/hash/owner/expiry checks, replay under different keys, concurrent consume, exact and over image ceilings, final-wallet concurrency, descendants, unapproved rerolls, trial allowance, shared total image-versus-duration race, retained TTS/planning/media across fresh callers, unknown TTS restart refusal, incremental approval/renewal, ambiguous cancellation and eventual pending-refund convergence.

`verify-mcp-budget-orchestrator.ts` runs an ordinary paid USER's prepare/approve/consume and the real orchestrator through held preview. Media/provider and render HTTP endpoints are stubs; the render stub executes the actual funding transfer and charged-clip recording. It asserts numeric AutoMix cap propagation, retained preview and settled funding once. Its initial red exposed protected `avatarMode: "none"` being treated as a presenter request; fixed by excluding `none` from the presenter branch.

## Verification

Commands run locally, exit 0 unless the intentional red failures above are noted:

- `npm ci --ignore-scripts`
- `DATABASE_URL=file:/tmp/task2-generate-only.db npx prisma generate`
- `npx tsc --noEmit --pretty false`
- Scoped ESLint across every changed/new TypeScript file (warnings only in existing route/worker code; no errors).
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-budget.ts`
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-budget-orchestrator.ts`
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-video-quote.ts`
- `npx tsx scripts/verify-mcp-create-input.ts` (17 cases)
- `npx tsx scripts/verify-render-receipt.ts`
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-minute-credits.ts` (9 cases)
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-render-reservation-settlement.ts`
- `git diff --check`

## Explicit limits / downstream composition

No paid provider was called. Full real-fetch-stock → AutoMix final-export HTTP/browser composition and full build/suite remain Task 5; the new fixture demonstrates the real worker through held preview with provider stubs, not full end-to-end export. Task 3 must implement complete external import/window composition. Task 4 owns complete public guidance, billing summaries and broader Studio status presentation; basic hold status/receipt/resume hooks are present.

Unknown submissions without a provider ID remain retained for support reconciliation; incremental approval never authorizes implicitly retrying them. A known-outcome reconciliation can settle/refund image exposure, but no automatic resume is supplied for an unknown-outcome hold. Likewise an uncertain render transfer crash parks rather than initiating another paid render. A shared creative reroll outside the protected work refuses and requires a new workflow; this task does not add a creative-reroll quote UI. These fail-closed limits preserve ceilings but require review against desired recovery UX. No screenshot/visual claim is made for the small incremental receipt paragraph.

## Review fix round 1 — B1/B2/B3

Independent review reproduced three blocking defects in the first commit. Added failing assertions in the existing isolated fixtures before changing these seams:

- **B1:** actual shared render POST with trusted service root but omitted request `parentJobId` returned 200 instead of 409, allowing an unbound debit. Service identity now supplies the parent regardless of body omission; a conflicting body parent refuses. Owned browser derivative `rerenderOf.sourceJobId`, project active job, and persisted video linkage retain their budget. Known quote context can no longer fall through to independent normal charging. Tests call the actual route, mocking only authentication/service resolution and public-directory staging: correct, missing and forged service IDs refuse; owned web source/project charge fallback refuses; an eligible web edit remains free and linked.
- **B2:** startup recovery with a known DONE base RenderJob and retained narration/media returned `confirmation_required` rather than queued. Recovery now verifies durable queued/running/completed render evidence and requeues; the checkpoint caller adopts/polls the existing render ID rather than submitting again. Explicit resume also adopts a known durable child from a previously parked hold under the original consumed quote. A render submission with neither a durable child nor a stored result remains uncertain and cannot be replayed.
- **B3:** a held image poll followed by successful `completeImageJob` left the parent held. Completion now transactionally checks the original approval, absence of a new approval hold/unknown narration, and completion/settlement/output of every image in that parent's exact persisted batch. Only then does it queue the retained parent. The same image reservation/ID is reused; no additional debit is made. Ordinary active workers are not requeued by image settlement. Unknown images, incomplete sibling images and fresh approval holds remain held.

Round-1 red runs exited 1 with `200 !== 409`, known-completed base `confirmation_required !== queued`, and known-completed image `confirmation_required !== queued`, respectively. The positive free-render fixture initially lacked any visual coverage and correctly received existing `broll_coverage_incomplete` 422; using an explicit solid background made it a valid edit without changing production coverage rules.

The final round reruns include both budget scripts, TypeScript, scoped ESLint, existing render-reservation settlement checks and diff validation. No paid endpoint, production database, full build or full suite used.

### Remaining advisory and workflow limits

Review's image-parent mismatch advisory remains tracked: direct internal reservation callers can supply conflicting JSON and idempotency parents; current public fetch-stock constructs both together, so reviewer established no public reachability. This round did not expand into that separate advisory.

Creative per-window reroll returns HTTP 409, `error`/`code: confirmation_required`, with next `ขอใบยืนยันสำหรับการสร้างภาพใหม่ใน Studio ก่อนลองอีกครั้ง`. This is **not** a supported retained-root per-window approval workflow: existing incremental quotes authorize the paused original pipeline work, not arbitrary new creative edits. A fresh creation quote is a separate job. Task 4 must make that limitation actionable and accurate; per-window creative quote UI remains unimplemented, explicitly not claimed complete. Truly unknown/no-ID provider outcomes still require reconciliation; unlike B2/B3, they cannot yet prove reusable output.

Final round-1 evidence (all exit 0):

- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-budget.ts` — includes known-image completion/reuse plus existing unknown-exposure, cancellation, ceiling and concurrency checks.
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-budget-orchestrator.ts` — actual shared render route B1 denial cases; eligible web B-roll edit and already-paid web/service subtitle exports each return 200 with `reservedQuota:false`, retained parent and unchanged wallet; real worker startup and explicit resume reuse DONE base with no additional render/TTS/media submission.
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-render-reservation-settlement.ts` — historical settlement compatibility.
- `npx tsc --noEmit --pretty false`.
- Scoped ESLint on changed TypeScript — zero errors, one pre-existing `_bundleCache` warning.
- `git diff --check`.

Actual route fixtures use synthetic local media under a temporary working directory and enqueue only; no renderer/provider process executes. The free-edit fixture's initial missing-voice 500 was corrected by supplying its synthetic local voice file, preserving the real asset-existence guard.

A final focused regression distinguished a definite render admission refusal from an unknown render submission. The initial new checkpoint implementation incorrectly retained the refusal as `render_outcome_unknown` (red exit 1). It now clears only a definitive local budget refusal / structured HTTP 409 confirmation-required entry, allowing approved continuation; transport uncertainty remains held. The extended budget script, TypeScript and focused lint reruns exit 0.

## Review fix round 2 — HTTP hold semantics and browser execution authority

Two additional integrated regressions were reproduced before fixing:

1. A real orchestrator call whose synthetic fetch-stock HTTP 409 is decoded by the actual `decodePipelineResponse` produced terminal `failed` instead of `confirmation_required` (red exit 1). The terminal error included `หา B-roll ไม่สำเร็จ (confirmation_required): POST /api/videos/fetch-stock → 409`. The generic error-detail extractor preferred `body.reason` over the canonical code, so the outer budget branch never matched. It also discarded the typed reason used by reconciliation.
2. Actual render POST with no service context, an owned still-queued quote root in body `parentJobId`, and different scenes returned 200 (red exit 1, expected 409), transferring the original reservation into arbitrary work. Owner association constrained accounting but did not authorize executing that immutable work.

Fixes preserve `confirmation_required` as the canonical pipeline code and carry its separate `reason` and finite nonnegative additional ceilings into the outer hold handler. Other historical error extraction remains unchanged. The orchestrator now persists `image_poll_unknown`, `image_submission_unknown`, or `image_ceiling` rather than flattening them to a generic failure. Browser source/project hints constrain the budget but cannot consume original execution funding; only trusted worker context or a verified already-paid eligible derivative can proceed.

The extended real-orchestrator fixture now starts with decoded HTTP `image_poll_unknown`, verifies reserved funding/no terminal refund, settles the known image, then actually runs the same root to held preview. It verifies one TTS call, the same image ID and row, and unchanged image wallet debit. A separate decoded HTTP no-provider-ID submission remains held with reserved exposure and no approval-based resume. An ordinary image-ceiling HTTP response creates a linked incremental quote for exactly one image/two credits without terminal failure/refund. The actual route fixture rejects browser arbitrary execution against a still-queued quote and leaves its reservation intact; free eligible web rerender and already-paid web/service exports still pass.

Final targeted commands all exit 0:

- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-budget-orchestrator.ts`
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-budget.ts`
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-pipeline-retry.ts` (6 assertions)
- `node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-pipeline-error-specificity.ts`
- `npx tsc --noEmit --pretty false`
- Scoped ESLint of the four changed TypeScript files: no errors, two existing unused-variable warnings.
- `git diff --check`

The error-specificity compatibility script initially exited 1 under `react-server` (`React.createContext is not a function`) and exited 1 without its server-marker harness (`This module cannot be imported from a Client Component module`). A temporary equivalent marker shim passed; the final recorded rerun uses the repository's existing `register-server-only-node.mjs` and passes. No production behavior was changed for test imports. HTTP response/media/provider simulation remains explicitly scoped; no paid provider, real renderer, production write, full build or broad suite was used. Previously documented creative-reroll workflow and image-parent mismatch advisory remain unchanged.

## Session-directed bounded correction — retired image attempts

Authorized separately after the two automatic rounds: only the image-resume readiness predicate and its regressions changed. The actual orchestrator HTTP fixture first reproduced a confirmed failed/refunded predecessor plus a completed/settled retry staying `confirmation_required` (exit 1, expected `queued`).

Production diff is two lines replacing the prior `images.every(...)` condition: remove only rows whose durable state is BOTH `status: failed` and `chargeState: refunded`; require at least one remaining row; require every remaining row completed, settled and output-bearing. Owner, consumed approval, hold-quote, narration ambiguity and parent-status checks remain intact. No wallet/refund semantics changed.

Regression evidence covers all three required states:

- Real HTTP hold → known completed retry with a failed/refunded predecessor → same-root continuation to held preview, stable retry image ID, one settled image, one refunded predecessor, unchanged wallet after settlement/resume and one TTS call. Uses provider-attempt/scene-retry keys and runs with both AutoMix and Hero-only quotes.
- A completed image plus a still-reserved/submitting/no-ID sibling stays held and cannot renew into resume. Confirming/refunding that sibling then allows continuation using the existing completed image.
- A batch containing only confirmed-refunded failures has no completed output and remains held.

The first Hero-only variant reached the corrected continuation successfully but a later pre-existing synthetic cap scenario failed because the fixture compared a different script's cap against the first root's image count. The fixture now reads each active root's own approved count; no production change was needed.

Targeted final verification: `verify-mcp-budget.ts`; `verify-mcp-budget-orchestrator.ts` with default AutoMix and with `BUDGET_FIXTURE_SOURCE=hero-ai-image` (all using `NODE_OPTIONS=--conditions=react-server`); TypeScript; scoped lint for the predicate and two fixtures; and `git diff --check`. Exit codes recorded with the commit handoff. No new provider, deployment, broad feature or billing change.

Final bounded-correction exit codes: budget DB fixture 0; AutoMix orchestrator fixture 0; Hero-only orchestrator fixture 0; TypeScript 0; scoped ESLint 0 (no warnings); diff check 0. Initial red recovery assertion exited 1 as recorded above.
