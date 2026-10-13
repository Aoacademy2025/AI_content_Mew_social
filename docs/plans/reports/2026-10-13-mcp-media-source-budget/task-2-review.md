# Task 2 independent review — changes required

Reviewed base `2a8bbd7a2d7bf9a4c49f0c3d3ca4980b8ead6e44` to head `4509eb01dd05cdefba0a3afe2bdea8464eff0012`, fixed throughout this review. Reviewer: gpt-6-astra, medium. Isolated detached Orca worktree `/Users/mewsocialmacmini/orca/workspaces/AI_content_Mew_social/mcp-budget-review2`; independent npm install and generated Prisma client. Read approved plan, task package, worker report and funding reconnaissance. No application source edits, providers, production operations or other checkout mutations. Probe files are review evidence only; do not integrate them as production tests without adapting their absolute imports.

## Blocking findings

### B1 — P1: stripping request parent identity bypasses the quote render ceiling

Location: `src/app/api/videos/render/route.ts:297` and `:587`.

The render route has a server-authenticated job context from `resolveServiceVideoJobId`, but uses it only when the body supplies the same `parentJobId`. Omission/mismatch makes `verifiedParentJobId` undefined. That bypasses both transfer and the new quote-bound refusal, enters ordinary `reserveMinutesOrCredits`, and enqueues a render with no parent attribution. The quote exposure aggregate cannot see this charge.

Independent reproduction calls the actual render POST with an ordinary USER, a consumed quote with render-credit ceiling 0, and authenticated service context bound to that root. Auth/context and Remotion public-directory staging are stubbed; actual route logic, SQLite, wallet, funding transfer/refusal, reservation and durable render enqueue run. No rendering/provider runs.

- Correct body parent: HTTP 409, `render_funding_transfer_required`.
- Identical context, body parent omitted: HTTP 200; durable RenderJob has `parentJobId: null`; wallet debited 2 credits while root ceiling remains 0.

This demonstrates an internal shared-route boundary bypass, not an assertion that an unauthenticated internet caller can mint a service credential. The requested invariant explicitly requires server-derived roots and fail-closed missing/edited root hints. Derive authoritative identity from authenticated context independently of body presence; reject conflicting hints and retain root attribution through admission. Add omission/mismatch tests against this real route.

Evidence: `review2-recovery-render-probe.ts`, exit 0, asserted observed behavior.

### B2 — P2: known-completed base renders remain permanently held after restart

Location: `src/lib/mcp/video-job.ts:934`.

The new recovery branch treats all late quote-bound stages with checkpoints as ambiguous, without consulting durable base RenderJob state. A restart after successful base render but before parent save therefore strands known completed work. No hold quote is created, and `prepare_video_job({resumeJobId})` returns `resume_unavailable`.

The probe first runs the real orchestrator through held preview with synthetic media/render endpoints, producing a real durable DONE base RenderJob and retained narration/media checkpoint. It reconstructs the interruption immediately before parent save (`processing`, step `render`, funding `transferred`, no parent output/video) and calls real startup recovery. Result: `{inspected:1,requeued:0,parked:1,failed:0}`, parent `confirmation_required`, then `resume_unavailable`.

This is distinct from the accepted uncertain-transfer gap: the durable successful render and its output are present. Recovery must adopt/poll/reuse the existing render and preserve once-per-video payment, through either safe automatic continuation or a supported resume action. Do not merely requeue into a new render call.

Evidence: `review2-recovery-render-probe.ts`, exit 0.

### B3 — P2: successful image reconciliation has no supported continuation

Locations: `src/lib/mcp/video-budget-checkpoint.ts:51`, `:103`; integration with `completeImageJob` / image reconciliation.

A poll outage produces `image_poll_unknown` with no additional spend, so hold stores no incremental quote. Later known successful image completion settles and preserves the image, but does not make the parent resumable. Renewal requires an existing hold quote and returns null. Replaying original consumed quote only reports the held root.

Independent authoritative-function probe: create an approved ordinary USER image root; reserve an image and persist a submitted provider ID; call real `holdVideoBudget(image_poll_unknown)`; reconcile known successful output via real `completeImageJob`. Image becomes `completed` / `settled`, parent stays `confirmation_required`, and real `prepareVideoQuote({resumeJobId})` returns `resume_unavailable`. This uses real SQLite and ledger functions; provider completion is synthetic, with no external polling.

Unknown submission with no provider ID may safely remain held. Once an exact provider result is durably complete, however, a supported transition must reuse it, retained narration and planning. The current response directs users to a new receipt that cannot be prepared. Add a reconciliation-to-resume test; reapproval must never imply replaying the known paid operation.

Evidence: `review2-image-recovery-probe.ts`, exit 0.

## Advisories and scope boundaries

- Image admission checks conflicting `inputJson.videoJobId` versus the `video:` key only **after** resolving the JSON-selected budget (`video-budget-admission.ts:43–48`). A nonexistent/historical JSON parent returns null before conflict detection. Direct authoritative-seam probing successfully reserves beyond the exhausted linked root with `budgetQuoteId:null`. Current fetch-stock caller constructs both fields from the same variable, so I did not establish a reachable public-route attack and classify this as defense-in-depth advisory, not a fourth blocker. Check mismatch first and derive identity from persisted trusted parent context.
- The receipt reproduction executes source-extracted guard code, not the whole fetch-stock endpoint. The ordinary USER positive fixture runs the real orchestrator but replaces fetch-stock and render endpoints. These are useful scoped checks and accurately described by the worker, but do not prove full AutoMix final-export integration; that remains Task 5.
- Trial nominal `creditCost` is correctly excluded from wallet-credit exposure while image count remains counted. The scoped trial fixture passed. Incremental receipts preserve original input and display additional plus cumulative ceilings; expiry renewal and checkpoint binding tests passed. No broader reroll scope is introduced by incremental consumption.
- Creative rerolls currently refuse rather than provide a supported retained-root quote/consume workflow. This safely prevents unapproved work; the instruction to request a new Studio receipt is not itself an implemented per-window receipt flow. Keep this limitation explicit in Task 4 guidance and final acceptance rather than claiming completed reroll authorization UX. I do not require a new UI in this task.
- Unknown submission/no ID and genuinely uncertain render transfer can remain held for reconciliation, as explicitly allowed. Those limits are not B2/B3: both blockers use known durable completed results.
- Full external windows/import (Task 3), comprehensive billing/guidance (Task 4), full build/broad suite/final browser and export integration (Task 5) are not charged as Task 2 blockers.

## Verification performed

All listed commands exited 0 unless stated otherwise. Fixture scripts create/delete independent temporary SQLite databases; no copied `.env` or shared database was used.

1. `npm ci --ignore-scripts` — independent install; npm reports existing dependency audit findings, not evaluated as feature regressions.
2. `DATABASE_URL=file:/tmp/review2-generate-only.db npx prisma generate` — generated local client only.
3. `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-budget.ts` — atomic consume/replay, owner/hash/expiry, no preapproval job, exact/over image cap, ambiguous cancel exposure, credit and total races, descendants, trial, incremental renewal/checkpoint reuse.
4. `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-budget-orchestrator.ts` — ordinary USER approved AutoMix through real orchestrator to held preview, media/render endpoints stubbed.
5. `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-video-quote.ts` — owner/auth/expiry/input/price/zero-spend/presenter checks.
6. `NODE_OPTIONS=--conditions=react-server npx tsx docs/plans/reports/2026-10-13-mcp-media-source-budget/review2-recovery-render-probe.ts` — B1/B2 actual-function reproductions. First draft exited 1 due to a probe string-replacement typo (`Invalid assignment target`), corrected before execution; final asserted rerun exited 0.
7. `NODE_OPTIONS=--conditions=react-server npx tsx docs/plans/reports/2026-10-13-mcp-media-source-budget/review2-image-recovery-probe.ts` — B3 and image-attribution advisory actual-function reproductions.

No production build or broad suite run, per dispatch. No live-readiness claim. Verdict: resolve B1–B3 and independently recheck before accepting Task 2.

## Fix round 1 re-review — bb28fe71 — changes still required

Advanced only this review worktree to `bb28fe71bd392c99f6ecf93d77a0e8a3dc3b5e59`; existing reports/probes retained. Read fix diff and updated worker report. No source changes, broad suite, build or paid calls.

### Resolved in this round

- **B1's original omission/mismatch bypass is fixed.** Independent adapted actual-POST probe now gets 409 for both correct and omitted service parent, with zero wallet change and no escaped render. Updated worker test also passes forged service parent, web source/project fallback denials and free eligible web edit/already-paid web and service subtitle exports.
- **B2 is fixed for the reproduced known-DONE case.** Independent adapted interruption (parent `processing/render`, funding `transferred`, no output/video, durable DONE base) is requeued by actual restart recovery. Running the real orchestrator again completes from cached narration/media and the existing render, with no additional render submission. Updated worker test covers explicit resume from a previously parked known result.
- **B3's direct-helper case now passes**, but B3 is **not resolved at the production HTTP boundary**, below. The direct completion hook queues the parent and reuses the exact reservation when the hold reason was written directly with `VideoBudgetHoldError("image_poll_unknown")`.

### Still blocking: B3 HTTP image holds become terminal failures

Locations: `orchestrator.ts:3176–3177`, `pipeline-client.ts:153`, and the new `video-budget-checkpoint.ts:130` reason-specific unpark.

The actual fetch-stock response carries `{error:"confirmation_required",code:"confirmation_required",reason:"image_poll_unknown",additional:{}}`. `pipelineFailureDetails` chooses `reason` ahead of `code`. Therefore the orchestrator's `pipelineFailureDetails(e)?.code === "confirmation_required"` check is false and it executes terminal failure/refund handling instead of holding. Even an envelope with no reason would store the generic `downstream_budget` reason, which the new completed-image recovery helper does not recognize.

Independent `review2-round1-image-http-probe.ts` runs real prepare/approve/consume/orchestrator/checkpoint functions, reserves an actual image in SQLite, persists a known provider ID, then substitutes the exact fetch-stock HTTP error envelope using `PipelineApiError`. Observed parent status **failed**, expected **confirmation_required**, with error `หา B-roll ไม่สำเร็จ (confirmation_required): synthetic status outage`. Exit **1**, reproducibly. This is an end-to-end orchestration boundary test with synthetic HTTP/provider responses, not an actual fetch-stock/provider integration test.

The issue also affects actual image-ceiling responses (same code/reason envelope), so it prevents incremental receipt creation and retained work instead of merely delaying late completion. Preserve the authoritative structured code and reason separately, then demonstrate real orchestrator hold → known exact image settlement → queued resume with no repeated TTS/media debit. Unknown unresolved provider states and actual approval holds must remain parked.

### New B4 — P2: browser parent hints can consume original queued execution funding

Locations: `src/app/api/videos/render/route.ts:309–316` and `:575–581`.

The B1 fix promotes owner-scoped browser hints into `verifiedParentJobId`, then permits that browser-derived value to transfer a queued quote root's original funding. Owning a job ID establishes association, but does not prove that arbitrary submitted scenes are the exact approved root work or an eligible free derivative.

Independent actual-POST probe: approved/consumed ordinary USER root is still `queued` / funding `reserved`; auth returns its owner and **service context is null**. POST supplies the root `parentJobId` with entirely different scene content and no eligible rerender/BURN context. Observed **HTTP 200**, durable linked RenderJob with `reservedQuota:true`; original root remains queued but funding becomes **transferred**. Expected refusal; probe exits **1**. No provider/renderer is executed.

Besides accepting different work under the immutable original receipt, the new render checkpoint lookup can subsequently adopt this unrelated render for the original root. Retain browser attribution for enforcing ceilings/refusing charge fallback, but require server-authenticated execution authority for consuming original funding. Preserve verified eligible free browser edits and paid exports. Evidence: `review2-round1-browser-pending-probe.ts`.

### Round 1 commands / exit codes

- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-budget.ts` — **0**.
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-budget-orchestrator.ts` — **0** (includes actual route/free derivative checks and real known-render recovery).
- `NODE_OPTIONS=--conditions=react-server npx tsx docs/plans/reports/2026-10-13-mcp-media-source-budget/review2-round1-recovery-render-probe.ts` — **0**, independently adapted B1/B2 expectations, no repeated render/TTS/media.
- `NODE_OPTIONS=--conditions=react-server npx tsx docs/plans/reports/2026-10-13-mcp-media-source-budget/review2-round1-direct-image-probe.ts` — **0**, direct-helper B3 case fixed, exact image identity reused; original image-parent mismatch advisory unchanged.
- `NODE_OPTIONS=--conditions=react-server npx tsx docs/plans/reports/2026-10-13-mcp-media-source-budget/review2-round1-image-http-probe.ts` — **1**, actual `failed` versus expected `confirmation_required`. First diagnostic run had the same failure without the expanded error-message assertion; repeat supplied the exact failure above.
- `NODE_OPTIONS=--conditions=react-server npx tsx docs/plans/reports/2026-10-13-mcp-media-source-budget/review2-round1-browser-pending-probe.ts` — **1**, HTTP `200 !== 409`.

The scoped budget suite still passes unknown TTS/render repeat refusal, ambiguous image cancellation exposure and incremental approval binding. No claim that these test every sibling/parallel provider completion interleaving. Final fix round should address B3 and B4 before acceptance. B1/B2 remain closed for their independently reproduced cases; image-parent mismatch remains advisory and creative per-window quote UX is not claimed.

## Fix round 2 final scoped re-review — e9224268 — one P2 blocker remains

Advanced this worktree to `e9224268` and read the bounded fix diff/worker report. No source edits, extra agents, providers, production activity, full build or broad suite. Two planned automatic fix rounds are exhausted; this report does not waive the remaining issue or dispatch another fix.

### Confirmed resolved / passing

- **B1 remains fixed:** scoped actual-route tests deny missing/forged service parent charge fallback and retain quote association; legitimate free web rerender and already-paid web/service exports succeed without debiting again.
- **B2 remains fixed:** the real orchestrator recovers known DONE base render through held preview without new render/TTS/media submissions.
- **B3 HTTP code/reason defect is fixed:** independent `review2-round2-image-http-probe.ts` uses the production-shaped PipelineApiError envelope through real orchestrator/checkpoint/ledger functions. Parent holds with `image_poll_unknown`; known image completion queues the same root; running it again completes held preview. No additional narration call, image row or wallet debit. The worker's extended fixture separately uses the actual HTTP decoder and reaches the same outcome.
- **B4 is fixed:** the original browser-pending-root probe now returns 409 `render_execution_requires_worker`, leaving root `queued/reserved` and no render row. Independent `review2-round2-browser-service-probe.ts` then switches only the trusted service context and verifies actual POST succeeds with the same original reservation and retained parent.
- **Usable incremental receipt:** independent extended `review2-round2-cap-consume-probe.ts` approves and consumes the exact quote emitted by a real orchestrator image-ceiling HTTP hold, then runs the same retained root to completion without repeated narration. The fixture also confirms no-provider-ID uncertainty remains held, reserved, and cannot be resumed by requesting approval.

### Remaining B3 retry edge — P2: a confirmed refunded predecessor permanently blocks successful replacement resume

Location: `src/lib/mcp/video-budget-checkpoint.ts:130–132`.

The new image recovery query selects **every** historical generation row under the parent prefix, then requires all of them to be `completed` / `settled` with an output. A known failed and fully refunded attempt is permanent history; it can never satisfy that condition, even after its successful replacement has a durable settled output. Consequently a later poll interruption of the replacement strands the otherwise complete work.

Independent `review2-round2-refunded-retry-probe.ts` uses an ordinary USER Hero AI Image quote, real approval/consumption, image reservation/refund/completion, and real orchestrator HTTP hold handling:

1. Reserve original `video:<root>:scene:0:provider-attempt:0`; confirm its failure and refund using the authoritative refund function with known outcome.
2. Reserve the replacement `...:scene-retry:1` under the existing ceiling; persist its known provider ID.
3. Return the exact `confirmation_required` / `image_poll_unknown` HTTP envelope through the orchestrator.
4. Settle the replacement successfully with `completeImageJob`.
5. Observe historical rows `{status:"failed",chargeState:"refunded",outputUrl:null}` and `{status:"completed",chargeState:"settled",outputUrl:"/api/ai-images/fixture.png"}`. Parent remains **confirmation_required**; explicit `prepare_video_job({resumeJobId})` returns **resume_unavailable**.

Exit **1** at `known refunded predecessor must not strand completed retry`: actual `confirmation_required`, expected `queued`. This is known successful paid work plus a known refunded predecessor, not unresolved provider ambiguity. It exercises the existing Hero per-scene retry key shape. The first equivalent AutoMix-shaped variant also reproduced the issue; the retained final probe uses Hero-only production retry naming.

Recovery must distinguish confirmed retired/refunded attempts from required live work and prove the needed replacement outcomes, while still holding genuinely unknown or incomplete siblings. Simply treating every historical row as required completion prevents the approved retry/restart criterion. The original task explicitly requires technical retries, confirmed refund accounting, and resuming completed work; classify this as a remaining blocker, not an advisory.

### Final scoped commands / evidence

All probe paths below are under `docs/plans/reports/2026-10-13-mcp-media-source-budget/` in this review worktree. Database fixtures remain throwaway and independent.

| Command | Exit | Result |
| --- | --- | --- |
| `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-budget-orchestrator.ts` | 0 | HTTP hold/known completion/no-ID hold, incremental receipt, actual route identity/free derivatives, known render recovery |
| `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-budget.ts` | 0 | Scoped atomic budgets, trial, races, unknown exposure, direct known image completion, incremental binding |
| `NODE_OPTIONS=--conditions=react-server npx tsx …/review2-round1-browser-pending-probe.ts` | 0 | Original B4 now denied, original funding intact |
| `NODE_OPTIONS=--conditions=react-server npx tsx …/review2-round2-browser-service-probe.ts` | 0 | Browser denied; trusted service original render accepted using existing funding |
| `NODE_OPTIONS=--conditions=react-server npx tsx …/review2-round2-image-http-probe.ts` | 0 | Independent original B3 HTTP → settlement → same-root preview; no repeated narration/debit |
| `NODE_OPTIONS=--conditions=react-server npx tsx …/review2-round2-cap-consume-probe.ts` | 0 | Incremental HTTP receipt is actually approvable/consumable; retained root completes |
| `NODE_OPTIONS=--conditions=react-server npx tsx …/review2-round2-refunded-retry-probe.ts` | **1** | Remaining known-refunded predecessor blocks completed replacement resume |
| `DATABASE_URL=file:/tmp/review2-pipeline-retry-only.db NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-pipeline-retry.ts` | 0 | Six retry/structured-error checks |
| `node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-pipeline-error-specificity.ts` | 0 | Existing pipeline error specificity compatibility |

The first retry-script invocation omitted DATABASE_URL: all six assertions passed and exit was 0, but Prisma initialization emitted missing-environment diagnostics. Rerun with the explicit throwaway URL above was clean. No feature conclusion relies on those diagnostics.

**Final Task 2 verdict: changes still required for the single remaining P2 B3 retry/recovery edge.** B1, B2, original B3 HTTP path and B4 are independently closed. Image-parent mismatch remains separately tracked advisory; creative per-window quote UX remains explicitly unimplemented. No live-readiness/full-export claim.

## Session-directed bounded correction re-review — 23039d07 — Task 2 accepted within reviewed scope

Reviewed `23039d07f37410c2c3874510eeb4c560c1757f2a` atop `e9224268` under the explicit session ruling, without resetting automatic fix rounds. Scope was only the remaining confirmed-refund readiness predicate and its direct effects. No new general sweep, source edits, subagents, broad suite, build or provider/production activity.

The production change excludes only rows with both `status === "failed"` and `chargeState === "refunded"` from readiness. At least one live image is still required, and every live image must be completed, settled and output-bearing. The existing owner-scoped lookup, consumed original approval, parent status, approval-quote hold and unknown narration checks are unchanged.

### Independent reproduction and negative checks

`review2-bounded-refunded-retry-probe.ts` retains the exact original Hero image HTTP/orchestrator reproduction and corrects only expected post-fix history counts (one retired failed/refunded row plus one completed/settled replacement). It passes:

- Actual authoritative reservation and confirmed refund of the original Hero per-scene attempt.
- Actual replacement reservation, known provider ID and production-shaped HTTP poll-uncertainty hold through the real orchestrator.
- Known image settlement automatically queues the same retained root; rerunning the orchestrator completes held preview.
- Exact replacement image ID unchanged, exactly two historical rows (one retired and one live), no repeated TTS call, wallet unchanged during continuation.
- Independent sibling fixture: one completed live image plus a reserved/submitting sibling with no provider ID remains held; explicit resume returns `resume_unavailable`. Generic failure without a known provider outcome does not release it.
- Independent all-refunded fixture: confirmed failed/refunded history alone remains held; it does not satisfy completion vacuously.

The probe's diagnostic `prepare_video_job(resumeJobId)` call after successful automatic requeue returns `resume_unavailable` because the job is already queued; this does not block continuation, which the probe executes successfully.

### Commands and exits

- `NODE_OPTIONS=--conditions=react-server npx tsx docs/plans/reports/2026-10-13-mcp-media-source-budget/review2-bounded-refunded-retry-probe.ts` — **0**.
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-budget.ts` — **0**, including worker negative sibling/all-refunded cases and existing authoritative budget/approval/race/uncertainty checks.
- `git diff e9224268 23039d07 --check` — **0**.

**Final verdict: all identified Task 2 blocking findings B1–B4, including B3's confirmed-refund retry edge, are resolved in the reviewed scope. Task 2 may be accepted.** The earlier independently verified route/recovery behavior remains applicable; this correction changes only image readiness filtering. The image-parent mismatch remains a separately documented advisory with no established public-route reachability. Creative per-window receipt UX is still explicitly unimplemented. Full fetch-stock/provider/final-export composition, broad CI/build, full billing/guidance and external-window work remain the already assigned downstream tasks; this is not a production-readiness claim.
