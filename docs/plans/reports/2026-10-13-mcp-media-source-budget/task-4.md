# Task 4 — Complete receipts and conversational guidance

Implemented on `codex/mcp-budget-task4`, Orca worktree `mcp-budget-task4`, based on accepted Task 3 `f62f532aa1c2495ba5ca43f18093d83fcd39116e`. Worker: gpt-6-astra, medium. No subagents. This report accompanies the implementation commit; use the commit containing this file as the review head.

## Result and boundaries

`getVideoJobCostReceipt` reads an owner-scoped, current database snapshot, rather than repeating a cached output receipt. The existing `getVideoJobBillingReceipt` / chain release invariant remains intact, with its calculation extracted into a private function. Successful receipt fields stay compatible; the additive summary reports consumed approval ceilings, actual image/render credits, included minutes, settled total, disjoint outstanding reservations, trial units, confirmed refunds, pending reconciliation, and the current available wallet. Ordinary unfunded/in-progress/refunded lifecycle states do not falsely claim a missing render is an unexpected billing failure. Multiple active charges and delivered-job release failures remain errors.

The summary resolves owned quote roots, historical auto-chain keys, and same-project held descendants. It counts database rows once, includes every matching descendant (no newest-20 reporting limit), excludes unrelated same-project rows and foreign owners, and treats transferred/settled root funding as a mirror when the charge belongs to a root render **or a descendant burn**. A parent mirror with cleared render flags but no proved refund remains conservative outstanding exposure, rather than being invented as returned money. This change is a reporting layer; it does not reserve, settle, refund or authorize work.

All three job-status paths now expose the current receipt. The transport's early `confirmation_required` reply also includes it while preserving its existing quote, retained-checkpoint and next-action fields. That was a two-line route change authorized by the coordinator after finding the early-return gap. Read installed Next route-handler documentation first (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`).

Guidance and video options now ask the exact four-source Thai question, preserve omitted-field stock compatibility, explain current catalog prices and stock/external render usage, disclose external charges and unavailable tools verbatim, and teach prepare → authenticated Studio confirmation → observe → create with quoteId → edit/import → export. There is no agent boolean/approval tool. Presenter duration must come from a validated owned import. Budget holds/insufficient funds/expiry/changed prices retain actionable instructions. Existing receipt-specific structured errors are not reclassified. Creative per-window reroll approval is explicitly unsupported; checkpoint increments cannot authorize creative changes. Use supported replacement imports or a separately approved new creation.

## Durable evidence and interpretation

- Image accounting uses owner-scoped `AiGenerationJob.budgetQuoteId` or the persisted `video:<owned-job-id>:` reservation key, never tool counts. `reserved` and `settled` are disjoint. `starter_allowance` contributes zero wallet credits even when nominal `creditCost` is nonzero; consumed/reserved/refunded allowance units are separate.
- Render actuals use the active RenderJob funding record. Mixed funding separates included minutes from credit-funded minutes using the approval's minute rate, with the shared current catalog as the historical fallback. Existing render receipt fields remain unchanged.
- Confirmed credit returns require positive owner-scoped refund ledger entries under the existing exact image/root/render/queue refund action namespaces. A root funding mirror is not added as another refund. Trim refunds are reported once without subtracting them again from already-reconciled active funding.
- A durable root `reservationRefundPending` marker does **not** prove an exact future refund amount. Thus `pendingRefundCredits` is `null` when reconciliation is pending, and `pendingRefundExposureCredits` is the exposed upper bound, explicitly **not a promise that all of it will be returned**. Without that marker, `pendingRefundCredits` is zero; ambiguous reserved provider outcomes remain outstanding reservations.
- Wallet availability reads granted + purchased + currently unexpired promotional balance. Those balances already reflect reservation debits; outstanding reservations are never subtracted twice.
- Incremental storage was checked in `video-budget-checkpoint.ts`: persisted image/render/total ceiling columns are **additions**. Only `receiptJson.cumulativeHeroCreditCeiling` is cumulative. The summary sums the consumed persisted additions once, excludes draft/unconsumed increments, and exposes per-approval pricing and lineage. It never sums cumulative receipt snapshots.
- Unknown provider results and unallocated pending refunds retain uncertainty. No full external-service charge amount can be inferred from Hero's ledger; the receipt gives the stored external-cost disclosure instead.

## Tests first and reproduced gaps

`verify-mcp-spending-summary.ts` was written before the receipt implementation. Its intended first red exited 1 with `TypeError: getVideoJobCostReceipt is not a function`. Its fixture setup was corrected beforehand for required user names and the existing grant helper's `purchase` enum. The added onboarding checks failed at `ask all four sources before creation` (exit 1) before production copy changed.

Later targeted red checks preceded their fixes:

- Actual registered transport callback on a budget hold: `budget hold early return must include current durable billing receipt` (missing field, exit 1).
- Root transferred funding + charge moved to descendant burn: `2 !== 0` reserved render duplication (exit 1).
- Settled parent mirror + descendant burn: `4 !== 2` settled render duplication (exit 1).

The new fixture uses a throwaway SQLite and real `grantCredits`, `spendCredits`, `createReservedImageJob`, `completeImageJob`, `failAndRefundAiJob`, and `refundVideoJobFunding` helpers. It covers a settled image, a pending image, a confirmed image refund, separate nominal-cost trial units, initial/incremental/draft approvals, root/descendant funding transfers, repeated free exports, unrelated project rows, foreign forged quote linkage, failed pending refunds, actual cancellation refund, current wallet, mixed included/credit render funding, external zero image credits plus included render minutes, actual status helper output, and the registered route early hold return. The route callback test stubs only MCP/Clerk transport registration; it does not claim a new live Clerk/PAT authorization test.

## Verification evidence

Final scoped checks exited **0**:

- `DATABASE_URL=file:/tmp/mcp-task4-script-bootstrap.db NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-spending-summary.ts` (script immediately replaces the bootstrap URL with its own mkdtemp SQLite before importing app code).
- Same disposable environment: `scripts/verify-mcp-billing-receipt.ts` — original 4 release-invariant checks passed.
- `DATABASE_URL=file:/tmp/mcp-task4-static-verification.db NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-onboarding.ts` — 118 assertions, including managed/BYOK child-process branches.
- Same disposable environment: `scripts/verify-video-options.ts` — 28 assertions. Existing `any` casts in this touched fixture were replaced with explicit shapes to satisfy scoped lint.
- `scripts/verify-mcp-external-media.ts` — 81 PASS assertions, exit 0. Existing real import/shared editor/worker composition with stubbed provider/render endpoints; no live paid call. Ran before the final mirror-only accounting correction; that correction has direct targeted fixture coverage.
- `DATABASE_URL=file:/tmp/mcp-task4-static-verification.db npx tsc --noEmit --pretty false`.
- Scoped ESLint over billing-receipt, tools, onboarding, video-options, transport route, and the three changed/new verify scripts — exit 0, no warnings/errors.
- `git diff --check` — exit 0.
- Setup: `npm ci --ignore-scripts` and Prisma generation with an explicit disposable URL — exit 0.

Broader existing fixture checks were also run once, with these **known failures retained for Task 5** rather than silently weakened:

- `verify-mcp-chain-export.ts`: exit **1**, **145 passed / 2 failed**. Failures are source-string expectations at lines 306/308: `route: create_video_job goes through createMcpVideoJob` and `route: reserved key maps to the existing duplicate copy`. Task 2 moved creation/refusal routing to `requestVideoJob`; the behavioral chain/billing/status cases passed. Local log: `/tmp/mcp-task4-chain.log`.
- `verify-mcp-audit-status.ts`: exit **1** at line 93, `MCP in-flight limit includes provider waits`, which checks `mcpRoute.includes("...VIDEO_JOB_INFLIGHT_STATUSES")`; Task 2 moved this guard into the shared consuming service. Local log: `/tmp/mcp-task4-status.log`. This script exits at its first failure, so no claim is made about later assertions.

Task 5 must wire **`scripts/verify-mcp-spending-summary.ts`** into CI, retain onboarding/video-options/legacy receipt checks, migrate the above stale fixture expectations and the previously reported Task 3 legacy edit fixtures, then perform full build/full suites and independent review. No production build/full-CI claim is made here.

## Environment incident and limits

Orca copied `.env` and `.env.r2.production` into the new worktree despite `--setup skip`. The copies were removed from **this worktree only**, without printing their contents, once discovered. Early onboarding imports observed managed flags from that environment. Inspection of the existing import path showed `managed-stock.server → prisma`, whose module initialization starts busy-timeout/cache-size PRAGMAs. Therefore **startup PRAGMAs may have opened the copied environment's configured database connection before removal; zero database access cannot be claimed**. No deliberate application data operation or provider request was invoked through that onboarding check. Billing fixtures always replaced DATABASE_URL with a throwaway SQLite before importing app code; generation also had an explicit disposable URL. All subsequent application-import commands used explicit disposable DATABASE_URL. The old environment was not reread/reconnected for investigation.

No provider generation, deployment, restart, production cleanup, customer messages, Linear changes or publishing was performed. No intentional production data mutation was part of this work; the startup-PRAGMA uncertainty above remains disclosed. HERO-70 locking risk and live auth/browser readiness remain separate from these regression results.

## Review fix round 1 — B1: authoritative render refunds and funding mirrors

Independent review reproduced a successful two-minute terminal refund that restored `User.minutesUsed` from 2 to 0 but left the parent's `fundingState=transferred`. The new receipt reconstructed that old mirror as two outstanding minutes. The reviewer also independently confirmed the related mixed-funding defect in the existing settlement seam: a three-minute reservation funded by two included minutes plus one credit minute returned credits but left the two included minutes consumed.

Before production edits, added actual-helper regressions to `verify-mcp-spending-summary.ts`. The red run exited **1** with three failures: included refund receipt `2 !== 0`, mixed actual quota refund `2 !== 0`, and descendant refund receipt `2 !== 0`. Existing rollback and historical-ambiguity controls already passed.

The bounded correction reuses `refundReservationInTransaction` in the existing terminal render-settlement transaction for minute/credit funding. This restores both parts of mixed funding through the canonical bucket-aware refund logic. The existing legacy clip-funded `usageCount` branch is retained. No new wallet, schema, price or reservation mechanism was added.

After a successful exact refund, that same transaction resolves the owned direct/quote/held/auto-chain funding root and marks its transferred/settled mirror `refunded` **only when** the refunded reservation's original minute/credit quantities match the complete mirror and no active reservation remains in that owned chain. A running render, failed refund, partial/mismatched amount, unrelated project row or another owner's row cannot certify the whole mirror as returned. The existing flag claim, actual quota/credit return, mirror update and charged-clip deletion all roll back together on failure.

Already-cleared historical flags are deliberately not backfilled as successful refunds. A transferred mirror with unresolved exposure now carries `fundingReconciliationRequired=true` and `settlementStatus=reconciliation_required`, retaining conservative exposure rather than claiming money returned or a render still running. Guidance explains this state and calls for reconciliation. A partial mismatch likewise remains explicitly unresolved; the exposed quantities are an upper bound, not proof of an active exact reservation or a guaranteed refund.

Final targeted fixture cases all pass:

- Pure included-minute completion and idempotent retry: actual used minutes zero, no reconstructed reservation, refunded receipt, retry refunds zero rows.
- Mixed included/credit completion: actual used minutes zero, exact positive refund ledger, wallet restored, no reserved minutes/credits.
- Descendant burn transfer: RUNNING remains in flight and keeps the root mirror; FAILED→successful refund settles the root mirror, with the free base render excluded.
- Real refund failure using a missing original promotional grant: exception rolls back quota changes, render flags and mirror; no confirmed refund is reported.
- Partial/mismatched reservation: only its actual one minute returns; the full two-minute mirror is not falsely marked refunded, and reconciliation is explicit.
- Historical already-cleared flags: no new refund occurs, no mirror is invented as refunded, unresolved exposure remains.

Final commands (explicit disposable DATABASE_URL before every app import), all exit **0**:

- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-spending-summary.ts` — existing fixture plus six refund regressions above.
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-render-reservation-settlement.ts` — existing historical minute/credit/clip, attribution, failure and retry settlement checks.
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-billing-receipt.ts` — original four release checks.
- `npx tsc --noEmit --pretty false`.
- Scoped ESLint: `src/lib/render/reservation-settlement.ts`, `src/lib/mcp/billing-receipt.ts`, `src/lib/mcp/onboarding.ts`, `scripts/verify-mcp-spending-summary.ts`.
- `git diff --check`.

No broad suite rerun, no production action and no new agent. Earlier stale chain-export/audit-status fixture failures remain explicitly unclaimed and assigned to Task 5. The existing spending-summary script now includes these regressions; no additional CI script entry is needed.
