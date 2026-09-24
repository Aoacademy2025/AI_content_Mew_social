# Execution ledger
Plan: docs/plans/2026-09-24-hero-diag-three.md
Profile: high-assurance; risk high; fix-round ceiling 5; maximum initial agent runs 15.
Usage baseline: dashboard unavailable. Worker frontier: 3 independent tasks. Base 3d2c27a6.
Ruling: execute the user-approved recommendations without a repeat interview/approval gate; task contract records binding scope. No new product decision or production mutation is inferred.
Ruling: test seams follow approved recommendations and existing public verifier boundaries; no extra seam-confirmation gate.
Ruling: scope permits preparing/pushing issue-scoped PRs; merge/deploy remain excluded.

Checkpoint 1: three worker agents dispatched with fresh context and isolated Orca worktrees. Named mew-worker-heavy role unavailable; used built-in worker with adapter-prescribed gpt-5.6-sol/xhigh. Agent runs 3/15. No production mutation.
Task 1 branch target codex/hero10-tx-phases-20260924; task 2 codex/hero41-cleanup-phases-20260924; task 3 codex/hero51-long-offline-20260924.
Main verified at 3d2c27a6; four unrelated open PRs untouched. ADR0056 and media lifecycle ADR0006 reviewed.

Task 2 RED observed: real verify:media-local-eviction default polling starts second object after customer work arrives during first. Worker testing safe per-object forced yield and phase costs.
Task 3 preparation: default Python lacks model dependencies, exact CTC model absent; cached Whisper is not an acceptable substitute. Ruling: approved actual offline experiment permits isolated dependency/model staging from official public sources; runtime inference remains offline. No extra approval required for this reversible necessary local preparation.

Checkpoint 2: HERO-10 RED observed for missing per-invocation phase diagnostics; worker separating actual connection queue from first-write waiting inside callback.
HERO-41 RED/GREEN observed for safe next-object yield in both eviction and missing-local reconciliation under default polling. Local operation-shape profile (~18,865 4KiB files, zero-latency fake remote): planner ~1s, run ~0.8s, added activity queries ~60ms; cannot explain production 90min.
HERO-51 dedicated Python/model preparation complete: pinned CTC revision 3155938c549b23eee16b1d4b55dcb161b7fe4bcf; local Thai Kanya synthetic fixtures; actual engine offline measurements in progress. Harness deadline/result regression observed RED/GREEN; no production algorithm changed.
Agent runs remain 3/15; no dashboard usage available.

Task 2 implemented f75ff386; Tier 1 independent review dispatched. Agent runs 4/15. Actual local benchmark cannot explain production wall time.

Task 1 head 9aec6657, Tier1 review dispatched. Agent runs 5/15. Draft PR #543 opened for diagnostics; cleanup Draft PR creation started, CI in parallel with review. No merge/deploy.
Task 3 actual offline model runs complete on Apple host: 121–302s synthetic Thai audio takes 11–28s, peak RSS ~3.4GB. No production timeout reproduced; no speculative chunking/clock change justified. Benchmark/harness deliverable proceeding.

Checkpoint 3: task1/task2 Tier1 reviews clear; task2 advisory: preFix benchmark arm is same-head polling-suppressed overhead control, explicitly qualified in final PR/report. Task3 Tier1 medium blocker: harness aligned predicate can accept incomplete spans/boundaries; author fix round1 dispatched, full build held.
Combined worktree b57d26ed integrates all three original heads; verification worker running scoped checks. Final security reviewer dispatched in parallel; final acoustic fix will receive scoped re-review. Draft PRs #543, #544, #545 live.

Task3 fix round1 at431ce583 integrated as e639dca1: semantic RED reproduces old run_case accepting1/6spans and1/2boundaries; new exact-span and nonempty-boundary checks reject. Python5+1+7 and scoped acoustic checks pass; Tier1 re-review active. Existing actual-model matrix revalidated without repeating inference. PR545 pushed to fix head for fresh CI.
Combined Prisma/subtitle/TypeScript/scoped-lint checks pass; full media chain reliably captured exit0 on rerun. Full build awaits Tier1 clearance. Final security reviewing integrated fix.

Checkpoint4: all Tier1 clear including Task3 scoped rereview. Combined exact-head build e639dca1 PASS once with captured exit0; full scoped suite/lint/types passed. Final security/privacy CLEAR, no medium+ blockers. Final correctness and PR545 final-head CI pending. PR543/544 exact heads CI PASS.
Ruling: accept nonblocking harness limits (library offline flags, direct-child timeout) for trusted repository engine; no claim of arbitrary-command sandboxing.

Final correctness CLEAR at e639dca1; final security CLEAR; integrated build/suites PASS. One implementation frontier wave (three independent tasks), one acoustic fix round and scoped rereview. Dispatch usage:9 initial agents+2 followups=11, within15 ceiling; no token dashboard available.
PR543 and544 marked Ready for review after exact-head CI+all gates. PR545 remains Draft pending final-head CI35962090913.
Fresh Linear reads: HERO10 InProgress, HERO41 ReadyToDeploy, HERO51 InProgress; no writes or parent Done transition. HERO41 existing shipped-verification status should not imply new PR544 is deployed.

Final gate: PR545 head431ce583 CI35962090913 PASS10m54s. All three exact issue heads CI PASS, task/whole-branch correctness/security reviews CLEAR and combined build/suites PASS. Main still3d2c27a6. PR545 ready transition authorized as part approved PR delivery. All acceptance criteria for this bounded follow-up complete; parent production outcomes remain unverified/open. No merge/deploy/production writes/Linear writes.
