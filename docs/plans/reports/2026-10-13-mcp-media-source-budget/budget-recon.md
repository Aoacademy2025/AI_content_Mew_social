# Task 2 funding and recovery reconnaissance

Read-only source investigation, baseline `4c2461805dcc2633675996a82ce391cfe706ff60`. No application implementation, DB, provider calls, production reads/writes, or tests/build were performed. All references are baseline paths/symbols. Reviewed CLAUDE.md, CONTEXT.md, approved plan, ADRs 0009, 0063, 0064, 0065 and 0066-one-edit-model-two-front-ends.

## Findings that determine implementation scope

1. Durable image funding already exists; enforce at `createReservedImageJob`, not only at the AutoMix numeric cap. It already atomically debits credits/allowance and creates the image job and first provider attempt.
2. Render funding admission, transfer, and persisted RenderJob creation are currently separate boundaries. Quote consumption must share the admission/create transaction; a wrapper around public `createVideoJob` would nest/fragment transactions.
3. There is no general durable checkpoint after Gemini/ElevenLabs TTS or before image planning. Current duration confirmation errors become terminal failure/refund. A budget stop needs a dedicated nonterminal checkpoint and resume branch. Existing in-memory retry is insufficient after process restart.
4. Descendant identity is currently encoded in server-controlled keys and JSON, not a relational root budget field. An additive durable budget/root reference must propagate through shared web/MCP enqueue paths, not just public MCP create.
5. `refundSettledVideoImageBatch` currently refunds reserved images, including possible provider-in-flight work, on whole-batch failure. This conflicts with the new quote rule if refunded exposure immediately authorizes replacement work while provider outcome is ambiguous.

## Authoritative funding seams

| Stage | Baseline reference | Boundary / implication |
|---|---|---|
| Root enqueue | `src/lib/mcp/video-job.ts:createVideoJob` (84–171) | Compiles narration input, syncs minute window before transaction, then `assertRenderEnqueueOpen`, optional minute/credit reservation and VideoJob insert in one transaction. Needs a transaction-taking internal variant or extraction for atomic quote CAS + project/root creation + existing funding. |
| Render debit | `src/lib/minute-credits.ts:reserveMinutesOrCreditsInTransaction` (67) | Reads current included minutes, computes only overflow with `creditCostFor("minute")`, invokes existing credit debit, updates counters in same transaction. Quote cap must be tested against the actual computed overflow here or in a transaction-local caller before committing. Caller must sync minute window beforehand. |
| Actual duration | `src/lib/mcp/video-job-funding.ts:reconcileVideoJobFunding` (156) | Own transaction. For growth calls `reserveMinutesOrCreditsInTransaction`, merges exact bucket debits; shortage returns confirmation without discarding original reserve. For shrink restores tail buckets/minutes. Quote-bound branch must check render + total limits before top-up; historical branch stays unchanged. |
| Transfer | `src/lib/mcp/video-job-funding.ts:transferVideoJobFundingToRender` (290) | Reconciles first, then separate transaction CAS `reserved → transferred`, returns snapshot. This is ownership transfer of one debit, not a new charge. |
| Render admission | `src/app/api/videos/render/route.ts:POST` (550–610) | Verified parent may transfer existing funding. Otherwise standalone `reserveMinutesOrCredits` or legacy clip reserve. `burnAlreadyPaid` / `rerenderSkipCharge` skip charging. Quote checks must protect fallback reserve as well as transfer; a failed transfer cannot silently create extra quote-bound spend. |
| Durable render record | Same route (1143–1188) | After admission, creates durable RenderJob with `parentJobId`, `reservedQuota`, minutes and exact credit funding snapshot. There is a transfer-to-RenderJob persistence gap to handle/recover; do not count both owners during transfer. |
| Root success | `src/lib/mcp/video-job.ts:finishJobWithTransition` (295) | Finish/project transition transaction mirrors transferred funding as settled. RenderJob remains monetary truth. |
| Pre-render refund | `src/lib/mcp/video-job-funding.ts:refundVideoJobFunding` (330) | Atomic CAS, restore minutes/bucket funding, refund ledger. Only reserved state; render owner handles transferred amounts. |
| Render refund | `src/lib/render/reservation-settlement.ts:refundVideoJobBaseReservation`, `refundVideoJobTerminalRenderReservations`, `refundRenderReservationById`, `retryPendingVideoJobReservationRefunds` | Claim reservation and restore funding in transaction, returns in-flight when appropriate; pending refunds retried. `markTransferredVideoJobFundingRefunded` mirrors, does not refund twice. |

Wallet remains `src/lib/credits.ts:spendCreditsInTransaction`, `refundCreditsInTransaction`, funding serializer/parser. Preserve promotional grant IDs and exact ordered bucket funding. A ceiling is an admission constraint against these records, not another wallet.

### Image admission, settlement and retry

`src/lib/video-hero-image.server.ts:prepareHeroImageReservation` resolves existing Hero entitlement/rollout and current provider quote, then calls `createReservedImageJob`; `reserveHeroImageForVideo` reserves without provider submission; `generateHeroImageForVideo` adopts the same reservation on replay. Model/provider pricing comes through `prepareImageGeneration` / `describeImageOffer`, not an MCP-local constant. The durable AiGenerationJob stores `creditCost`, `quoteVersion`, `fundingSource`, allowance units/window, exact funding JSON, charge state, and attempt records.

`src/lib/ai-generation-jobs.server.ts:createReservedImageJob` (154) runs a single Prisma transaction:

- `claimLiveParentVideoJob` owner-checks the `video:<jobId>:` parent and obtains a no-op row-write lock; terminal known parents fail. Missing legacy parents remain accepted for compatibility, so a quote-bound missing root must separately fail closed.
- Replays existing `(userId,idempotencyKey)` before new debit; another generation kind is refused.
- Ensures wallet row; optional daily-limit no-op wallet lock serializes count/create. Every attempt counts for operational rate limits, even refunded ones.
- Reserves Starter allowance or uses shared `spendCreditsInTransaction`.
- Inserts AiGenerationJob and sequence-1 AiGenerationAttempt together.

Place root resolution, locked durable aggregate exposure, approved provider/price/source check, count/credit/total admission within this same transaction before allowance/debit. Returning a budget refusal must not accidentally commit an allowance reservation. Trial rows carry nominal `creditCost` but actual credit spend is zero when `fundingSource === "starter_allowance"`; count images and allowance separately.

`claimPlannedImageAttemptSubmission`, `markImageAttemptSubmitted`, `markImageAttemptProgress`, `replaceCanceledImageAttempt` provide durable attempts and CAS claims. Same-job provider retry retains one reservation. A second attempt is permitted only after confirmed cancellation in the orphan queue path; failed cancellation and status outages retain reservation/provider identity. `completeImageJob` (772) records provider expense before its delivery transaction, checks live parent, and settles once. `failAndRefundAiJob` (706) transactionally restores allowance or exact credit buckets once.

Important ambiguous-outcome edges in `generateHeroImageForVideo`: submission exceptions currently call `failAndRefundAiJob`; repeated poll failure retains reservation; unknown submit outcome must not become budget capacity for a new paid retry. Audit the submission exception and timeout/cancel distinction specifically for quote-bound work. Provider COGS and customer Hero credits are distinct records; do not interpret attempt COGS as a second user debit.

`src/lib/video-image-batch-settlement.ts:refundSettledVideoImageJob` refunds one delivered derivative failure; `refundSettledVideoImageBatch` transactionally claims both reserved and settled rows under `video:<videoJobId>:`. Orchestrator failure/cancel and fetch-stock partial batch failure call it. New budget hold must bypass these terminal failure paths, retain successful images, and retain unresolved provider exposure. Ordinary historical behavior must remain unchanged.

### Fetch-stock guard and retries

`src/app/api/videos/fetch-stock/route.ts` parses `maxAiImages` at 1095. AutoMix guard at 1694 refuses ordinary USER download with AI slots and no numeric cap (`render_receipt_required`); ADMIN bypasses it. At 1716 excess generated slots are demoted. The approved cap should be passed, but this guard is request-local, lacks price/total protection, and does not cover Hero-only images.

Hero-only generation calls `generateHeroImageForVideo` around 2526 under `video:<jobId>:scene:<index>`; AutoMix calls it around 3826 under `video:<jobId>:automix:<index>`. Failed/refunded batch/scene retries use fresh suffix namespaces; all remain discoverable under the parent prefix. `fetchStockWithHeroProviderRetry` in orchestrator (933) retries only stock while preserving voice/captions/keyword data **in memory**, and disables generic POST retries for AI generation. Local provider choice must continue honoring the selected engine and the `authorizeHeroVideoMint` pipeline/owner/live-job guard.

## Root and descendant attribution

`src/lib/mcp/chain-export.ts` has two root families:

- Normal preview → export uses unique server key `mcp-chain:<previewJobId>`; `enqueueMcpChainExport` (603) delegates to shared `enqueueEditorExport` after committed preview completion. Unique index supplies idempotency even after status/watchdog re-entry.
- Held Preview (`mcpHold:true`) descendants use `inputJson.mcpRootJobId`, same owner/project, with `mcp-rerender:<root>:<revision>` / `mcp-export:<root>:<revision>`. Lookup functions parse JSON after candidate filtering; JSON contains alone is not authorization.

`RenderJob.parentJobId` identifies the immediate VideoJob, not the root. Images identify immediate VideoJob via refundable key and `inputJson.videoJobId`. Scene rerolls also use `broll-window:` nonrefundable namespaces and can run through web shared editor surfaces. Durable budget reference propagation must include shared export/rerender/creative image enqueue; client-supplied root fields cannot grant authority. Creative rerolls outside approved exact work require an incremental receipt, even if their render/export is free.

`src/lib/mcp/billing-receipt.ts:getVideoJobChainBillingReceipt` counts owner-scoped RenderJobs with `reservedQuota:true`, requiring exactly one and DONE. Preserve this invariant. It currently excludes images and reports `chargedMinutes:0` for credit/mixed funding, so new complete-cost summaries should expose included-minute component separately using durable reservation snapshots. Do not sum root funded amounts and transferred RenderJob amounts as independent charges.

## Existing durable checkpoints and actual gaps

| Existing state | What resumes safely | Limitation |
|---|---|---|
| AiGenerationJob + attempts | Completed image reused for identical key; submitted job polled; planned submission CAS | No persisted full stock selection/planning or narration state; regenerated planning must not map same index/key to different creative work. |
| `HeroVoiceProviderCheckpointV1` | References durable OmniVoice AiGenerationJob; recovery parks waiting provider and reuses result | This checkpoint covers pending Hero Voice, not general Gemini/ElevenLabs narration or downstream planning. |
| `AvatarProviderCheckpointV1` | Carries voice URL, duration, captions, words, full text, base config and provider IDs; avoids repeat provider submission | Created late after base render, so cannot be reused as the early generic narration budget checkpoint. |
| Completed VideoJob `outputJson.preview`, gallery video, EditorProject draft | Held preview and shared Pending Edit Draft retain finished assets; free rerender/export | Not available before the initial base render/image batch. |
| Export durable RenderJob child | `recoverProcessingJobsAfterWorkerRestart` requeues only to poll/reuse an existing free BURN | Does not establish safe replay for all paid stages. |

Actual reconciliation happens after uploaded duration (~orchestrator 2067), generated TTS measurement (~2425), and again during transfer. At generated TTS reconciliation, audio is still a local variable. The default catch (~3194 onward) settles terminal failures; restart logic replays early phases and deliberately refuses many late phases. Thus the approved incremental-resume requirement is **new durable state**, not already satisfied by Held Preview.

## Candidate minimal interfaces (design suggestions, not implementation)

1. Extract `createVideoJobInTransaction(tx, owner, preparedInput, opts)`; outer consumption performs approved quote CAS, immutable owner/pricing/input checks, root/project insert and current existing funding in that transaction. Perform local normalization and window synchronization before opening it; no provider/network calls inside.
2. `resolveVideoBudgetInTransaction(tx, ownerId, immediateJobId)` returns no budget for historical jobs, otherwise verified immutable root/current approval; descendant propagation occurs server-side at shared enqueue.
3. `assertVideoBudgetAdmissionInTransaction(tx, context, proposed)` checks new image count + actual credit delta + total exposure under root lock, after idempotent replay lookup and before debit. Existing image rows and current render funding owner are authoritative; reserved and settled are disjoint state, refunds counted only once confirmed. Include approved image rate/version and allowance source.
4. Durable versioned pre-spend checkpoint with narration result/timing, planning identity, completed asset references, resume phase, and pending incremental quote link. Park nonterminal `confirmation_required`; worker must not claim until approval atomically updates allowed budget and queues the same retained work. Never route this through terminal fail/refund. Resolve incremental-quote relationship explicitly; initial quote immutable input alone is insufficient to express resume revision.

These are admission/recovery helpers over existing ledger, not a second financial subsystem.

## Plan tensions and verification targets

- Quote consumption says reserve once. Current MCP chain create calls `createVideoJob` without funding while web can pass funding; consumption must wire existing funding and avoid the later render fallback charging twice.
- Incremental approval must add a durable approval chain/relationship while preserving original immutable ceiling evidence. The plan names one additive quote model but does not specify revision/resume linkage. This is an implementation detail to settle explicitly, not permission to mutate an approved snapshot.
- AutoMix current demotion uses omit; the plan allows stock degradation only if disclosed/approved. Do not assume the current request-local cap establishes that consent.
- Ambiguous batch refund currently conflicts with retained-exposure guarantee; add quote-specific protection without rewriting historical web policy.
- Owner/project checks and source restrictions must apply even to direct authenticated shared routes; otherwise quote-bound descendants can bypass MCP entry gate.
- Verify races for two new images, image versus render top-up, changed idempotency keys, transfer crash/retry, simultaneous cancellation/completion, confirmed versus ambiguous refund, trial allowance exhaustion, price changes, and restart at each hold point. These are suggested tests, not executed evidence.

## Work log

Created isolated worktree/branch as explicitly permitted in dispatch (`git worktree add`, exit 0). CLAUDE.md subsequently read contains Orca-only convention; parent dispatch explicitly allowed git fallback and pinned baseline. All source inspection commands exited 0 except an exploratory `rg` included nonexistent `src/lib/ai-image-service.ts` (reported missing); corrected discovery located `video-hero-image.server.ts`. No builds or broad tests were run, as requested. Report is the only file written in this checkout.
