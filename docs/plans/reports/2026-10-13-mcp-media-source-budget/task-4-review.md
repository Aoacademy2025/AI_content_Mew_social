# Task 4 independent review

Final verdict: **PASS at `2430fab9b08177c1f2d38962329c3ab537572468` after fix round 1.** The original confirmed blocker below is resolved; no remaining blocker found in this scoped review.

Reviewed `f62f532a..16dfb9eb01cce1a56fd975d6507448a3f430e3a9` independently in Orca worktree `mcp-budget-review4`. No production files were edited. No agents were spawned.

## B1 — refunded included minutes are reported as still reserved

**Blocking, medium severity.** `src/lib/mcp/billing-receipt.ts:216–230`, especially the fallback at lines 228–230, reconstructs a reservation from the transferred parent even after the authoritative terminal render-refund helper has successfully returned its included minutes.

A normal failed/canceled video may already have transferred funding to its render. `refundVideoJobTerminalRenderReservations` (called by orchestrator failure/cancel, cancel core, and pending-refund reconciliation) clears the render reservation and restores quota atomically, but does not update the parent's transferred funding mirror. Included-minute refunds produce no positive CreditLedger row. Therefore the new receipt treats the stale mirror as an outstanding reservation forever.

Reproduction uses the real helper against throwaway SQLite; no settlement function is mocked. Fixture: failed root, transferred funding of two included minutes, DONE base render holding that reservation, user minutesUsed=2. Exact evidence:

```text
BEFORE FLAGS
parent: fundingState=transferred, fundedMeteredMinutes=2,
        fundedCreditsSpent=0, reservationRefundPending=false
render: status=DONE, reservedQuota=true, reservedMinutes=2, creditsSpent=null
REAL REFUND { kind: 'settled', candidateJobs: 1, refundedJobs: 1 }
AFTER FLAGS
parent: fundingState=transferred, fundedMeteredMinutes=2,
        fundedCreditsSpent=0, reservationRefundPending=false
render: status=DONE, reservedQuota=false, reservedMinutes=null, creditsSpent=null
ACTUAL MINUTES 0
RECEIPT: reservedIncludedRenderMinutes=2, settlementStatus=in_progress,
         status=in_progress, renderChargeCount=0, refundPending=false
AssertionError: fully refunded minutes must not remain reserved
2 !== 0
```

Expected: zero outstanding included minutes and a refunded terminal receipt. This is a newly introduced reporting error; the actual quota refund succeeds. It violates Task 4/AC7 reconciliation, including zero-credit work.

Reproducer retained at `scripts/review4-refund-probe.ts`; it extends the supplied isolated fixture with the case above. Run:

```sh
DATABASE_URL=file:/tmp/mcp-review4-bootstrap.db NODE_OPTIONS=--conditions=react-server npx tsx scripts/review4-refund-probe.ts
```

Exit **1**, twice. Full log: `/tmp/mcp-review4-refund-probe.log`.

Smallest correction seam: ensure authoritative successful render settlement also records the corresponding parent/chain mirror as refunded, atomically with the refund where possible, or expose equivalent durable settlement evidence consumed by the receipt. Do not simply remove all transferred fallback accounting: the existing job-store failure path can clear flags before an unsuccessful refund, so unknown exposure must remain outstanding. Handle funding transferred to a descendant as well as a render under the root; marking only the descendant's unfunded VideoJob will not settle the root mirror. Add real-helper regression for pure included-minute terminal refund and its retry, a descendant transfer refund, and failed/ambiguous refund retention. Existing rows with already-cleared flags also need deliberate treatment rather than assuming every cleared reservation is a successful refund.

## Other reviewed behavior

No other blocker confirmed. Owner-scoped reads prevent foreign quote/ledger inclusion. Consumed initial/incremental quote columns are summed as additions; drafts excluded. Active descendant charge suppresses transferred/settled root mirrors; existing free export tests remain green. Image credit, allowance-unit, confirmed-refund and uncertain-exposure reporting are separated. Current available wallet includes promotional balances without subtracting reservations again. Legacy release receipt checks remain intact. The held status callback adds a current receipt while retaining existing checkpoint/next behavior. Guidance contains the exact four-source question, Studio human approval sequence, truthful external availability and render disclosure, and explicitly disclaims unsupported per-window reroll quotes.

## Independently executed checks

All application imports used explicit disposable DATABASE_URL. Orca-copied `.env` and `.env.r2.production` were removed from this review worktree before dependency setup/imports; contents never printed. Dependencies isolated via `npm ci --ignore-scripts` (exit **0**), Prisma generation with disposable URL (exit **0**).

- `verify-mcp-spending-summary.ts`: exit **0**, durable spending summary including route-held callback.
- `verify-mcp-billing-receipt.ts`: exit **0**, original 4 checks.
- `verify-mcp-onboarding.ts`: exit **0**, 118 assertions.
- `verify-video-options.ts`: exit **0**, 28 assertions.
- Independent real-refund probe above: exit **1**, reproduced blocker.

No full suite/build or provider calls executed. Task 5 still owes CI wiring, stale chain-export/audit-status source-fixture migration, full build/regressions and whole-branch security/correctness review. Prior live auth/browser advisories and HERO-70 remain outside this scoped verdict. No production deployment, restart, cleanup, customer communication or Linear mutation occurred.


## Fix round 1 — independent recheck

Candidate `2430fab9b08177c1f2d38962329c3ab537572468` was cherry-picked into the isolated review worktree as `2c71e5f0` (same patch). Reviewed the settlement, receipt, guidance and test diff independently. The original B1 description is retained above as audit evidence, not an outstanding finding.

A closely related mixed-funding defect was independently reproduced before the correction: 3 total render minutes funded by 2 included minutes plus 2 credits; the real terminal helper returned the 2 credits but left User.minutesUsed=2. `scripts/review4-mixed-refund-probe.ts` exited **1**, with `mixed terminal refund must restore its included minutes: 2 !== 0`; log `/tmp/mcp-review4-mixed-refund-probe.log`.

The correction reuses canonical bucket-aware `refundReservationInTransaction`, preserving the legacy clip branch. It records the owned root funding mirror as refunded inside the same transaction only for an exact matching full reservation and after confirming no remaining active chain reservation. Descendant ownership resolves through stored owner-scoped lineage. A failed refund rolls back the reservation claim, quota change and mirror together. Partial/mismatched or historical cleared reservations remain conservatively exposed with explicit `fundingReconciliationRequired` / `reconciliation_required`, rather than claiming a refund.

Both original independent probes were rerun unchanged against the correction:

- Pure included-minute probe: exit **0**. Parent becomes `refunded`; `reservedIncludedRenderMinutes=0`; `settlementStatus=refunded`; User.minutesUsed=0. Log `/tmp/mcp-review4-pure-fixed.log`.
- Mixed included/credit probe: exit **0**. Parent becomes `refunded`; confirmedRefundCredits=2; reserved credits/minutes=0; `settlementStatus=refunded`; User.minutesUsed=0. Log `/tmp/mcp-review4-mixed-fixed.log`.
- Updated `verify-mcp-spending-summary.ts`: exit **0**. Actual-helper pure refund/retry, mixed funding, descendant running→failed→refunded, failing promotional refund transaction rollback, partial mismatch and historical ambiguity all passed, as did prior receipt/held-route assertions. Log `/tmp/mcp-review4-summary-fixed.log`.
- `verify-render-reservation-settlement.ts`: exit **0**, `ALL PASS`, preserving existing minute/credit/clip and settlement behavior. Log `/tmp/mcp-review4-settlement-fixed.log`.
- Original `verify-mcp-billing-receipt.ts`: exit **0**, all 4 checks.
- Correction diff whitespace check: exit **0**.

No additional blocker confirmed. Full build/CI and whole-branch review remain Task 5 obligations; historical ambiguity is explicitly retained for reconciliation, not silently migrated or refunded. No production operation was performed during correction verification.
