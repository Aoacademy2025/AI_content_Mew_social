# Execution ledger
Plan: docs/plans/2026-09-17-hero-script-workspace-ux.md
Profile: high-assurance (owner query and save/handoff boundaries)
Risk: medium overall
Automatic fix ceiling: 2/task; expansion to 5 only by explicit data-loss/ownership ruling
Agent-run ceiling: 18
Baseline: 8e7089f3
Usage baseline: token/dashboard accounting unavailable in harness; track dispatch runs.
Branch: mew/hero-script-workspace-ux

Ruling: approved status controls over stale “Approval pending” title — explicit dated approval and execute request — no new approval needed.
Ruling: current CONTEXT.md and plan govern MAPC; ADR 0008 has older wording — no metric implementation changes authorized — regressions required.
Ruling: approved plan specifies test seams (library route/service and mounted workspace behavior) — no repeated seam confirmation needed.
Ruling: 2 automatic fix rounds retained; high-assurance final branch and focused security review required — plan is more specific than generic profile defaults.
Ruling: deliver local branch; no external push required — no production side effects authorized.

Wave 1: Tasks 1 and 2 unblocked, disjoint file ownership.

Dispatch 1: writing_surface — adapter fallback worker, gpt-5.6-terra/high — Task 1.
Dispatch 2: script_library — adapter fallback worker, gpt-5.6-sol/xhigh — Task 2.
Native mew-worker role unavailable; adapter-authorized equivalent built-in roles used.
Usage before execute: dashboard unavailable; 2/18 agent runs dispatched, 0 fix rounds.

Dispatch 3: qa_environment — read-only explorer, Terra/medium — browser capability blocker.
Task 1 implementation d1b052d7, scoped checks pass; browser gate remains pending integrated QA.

Dispatch 4: review_surface — Terra/high independent Task 1 review.
Browser capability: local Chrome/Puppeteer works; in-app runtime unavailable. Ruling: Task 4 may bundle actual client components with isolated auth/navigation/network stubs for browser tests; use existing packages, no production auth bypass or server gate alteration. Approved plan explicitly calls for local stubs/fixtures.

Task 1 review BLOCK: delayed preference hydration context overwrite; missing progressive visibility; helper-only test insufficient. Fix round 1 dispatched to original implementer (run 5/18). Mounted component fixture harness authorized under plan, production auth unchanged.
Task 2 milestone: isolated 500-row API/UI race verifier GREEN, awaiting commit/scoped checks.

Task 2 committed 9e3dd720 with API/scoped regressions/type/lint passing. Dispatch 6: review_library — independent Terra/high scoped review.

Task 2 review BLOCK: archived-brand historical filter discovery and stale error after successful refresh. Fix round 1 dispatched (run 7/18). Owner/gate/pagination tests passed review; no security finding.
Task 1 mounted real-page harness now operational; focused fix verification in progress.

Task 1 fix 92bddd8d: real-page mounted browser test passes. Dispatch 8: review_surface scoped re-review round 1.
Ruling: additive read-only brandOptions in library response authorized to satisfy historical brand filtering; owner-scoped metadata only, no creation selector semantic changes.

Task 1 fix-1 review BLOCK: blank topic leaves stale selectedHook; required legacy/published profile and keyboard evidence incomplete. Dispatch 9: original worker fix round 2. Ruling: invalidate Hook context but preserve prior generated draft/save owner, per global data-preservation contract; full output need not disappear if it contains retained draft.
Budget checkpoint: 9/18 runs used. Remaining planned gates: Task 1 re-review, Task 2 re-review, Task 3 implementation/review, Task 4 implementation/review, final branch/security reviews (8 runs). One extra run reserved; further blockers require explicit session budget ruling.

Task 2 fix 311c7558: mounted Chromium and isolated SQLite pass. Dispatch 10: review_library scoped re-review.

Task 2 PASSED independent scoped re-review after fix round 1. API/library frontier complete. Task 1 fix round 2 still in progress.

Task 1 fix b1da15f0 committed. Dispatch 11: review_surface focused fix-2 re-review.

Wave 1 complete: Tasks 1 and 2 PASS. Task 1 used two fix rounds; Task 2 one. Browser runtime limitation resolved by isolated actual client-page fixture.
Usage checkpoint after wave 1: dashboard unavailable; 11/18 runs completed.
Wave 2: Task 3 unblocked. Dispatch 12 workspace_integration — Sol/xhigh heavy worker. Base b1da15f0.

Task 3 RED captured in mounted actual-page browser: explicit recent-draft shortcut absent; baseline fixture passed before adding assertion. Implementation in progress.

Task 3 mounted milestone: recent explicit recovery, historical/default-context separation, tab/save retention, pre-generation cancel/discard without rows, stale detail rejection, zero-POST existing project open, duplicate-click suppression, unavailable project, save-failure/handoff block, latest retry, delayed save/new and delete/detail race pass. Final inherited guide/profile fixture sequencing and failed-replacement discard coverage still pending; not accepted yet.

Task 3 committed ef9ab4f7; scoped mounted races, library regression, types/lint passed. Dispatch 13: review_integration — independent Terra/high.

Task 3 review BLOCK: unguarded generate/section-regenerate responses can replace/corrupt newer workspace. Data-loss finding accepted; fix round 1 dispatched to original heavy implementer (run 14/18). Mounted delayed generate/regen tests required.
Budget ruling: Task 4 is integrated QA/test artifact work; combine its scoped review with the fresh heavy whole-branch correctness review in one dispatch, retaining an independent focused security reviewer. This removes duplicate review setup without dropping any gate or acceptance criterion. Planned remaining runs: scoped Task 3 re-review (15), QA worker (16), combined Task 4/final correctness heavy (17), security heavy (18). Further blocker requires explicit budget replan, never a silent skip.

Task 3 fix 0ca3d4c8: RED stale generation overwrote New, GREEN guarded full/section success/failure/finalizers with deterministic response gates. Types/lint pass. Dispatch 15: review_integration scoped re-review.

Task 3 fix-1 review PASS: mounted delayed generation/regen ownership verified independently.
Wave 2 complete. Usage checkpoint: dashboard unavailable; 15/18 runs completed.
Wave 3: Task 4 integrated QA dispatched (run 16/18), Terra/high. Base 0ca3d4c8. Actual app CSS, scale/viewports, keyboard/preview, complete plan suite and build required. Root retains ledger ownership; QA owns acceptance evidence updates.

Wave 3 implementation complete: QA edb2fd09, required regressions/type/lint/build passed. Actual CSS/shell fixture screenshots reviewed by root. Native status-select keyboard limitation documented; keyboard brand/search/tabs/open/main pass.
Usage checkpoint after wave 3 / before Tier 2: dashboard unavailable; 16/18 runs used. Final parallel frontier: combined Task 4 + whole-branch correctness heavy (17), independent focused security heavy (18). All implementation waves: 3.

Dispatch 17: final_correctness — fresh Sol/xhigh, combined Task 4 scoped + whole-branch correctness. Dispatch 18: final_security — fresh Sol/xhigh, query/owner/save/handoff boundaries. Both running in parallel. Declared run ceiling reached: no automatic expansion; any blocking result requires root ruling on minimal correction and documented budget replan.

Final correctness: Task 4 PASS; whole branch BLOCK. Starting-snapshot persist can return success after newer visible edits, and open-existing links bypass workspace save/discard guard. AC7 reverted to blocked. Waiting for focused security result before one combined minimal fix dispatch. No automatic run expansion beyond ceiling yet.

Final security BLOCK: held handoff can mutate another draft/current workspace and navigate away after generation/regeneration/New/open races. Owner/API/account-pref boundaries PASS.
Ruling at 18-run ceiling: narrow final correction to the three concrete data-loss boundaries only; explicitly replan ceiling to 21 (one existing heavy implementer follow-up + two existing final reviewer scoped rechecks). This is completion of authorized preservation requirements, not feature expansion. Session does not write production code. Cost if wrong: three bounded runs; no new audits. One combined fix round is allowed by final review loop and data-loss assurance policy.
Dispatch 19: workspace_integration combined final correction. Required: behavioral RED for edits during save, guarded existing-project navigation, held handoff ownership; GREEN and affected full verification/build after fix. No additional optional QA expansion.

Combined final fix RED evidence captured on actual mounted real-CSS fixture: (1) typing after held save began lost newest snapshot before New; (2) open-existing navigated before held PUT completed; (3) held handoff navigated after New replaced its workspace. All three reproduced before their respective fixes. Save-drain first case now GREEN; remaining guard/ownership/failure coverage in progress.

Combined final fix 9d4293c5 committed. Mounted RED→GREEN covers latest edits during save, guarded project navigation, and handoff ownership across generate/regen/New/open. Required regressions, type/lint/build rerun after production changes and all PASS. Dispatches 20/21: original final correctness/security reviewers scoped rechecks in parallel. No broad suite repeat requested.

Security re-review PASS at 9d4293c5; correctness original findings PASS, but final branch BLOCK for non-active library create-new bypassing save/discard and shared handoff ownership.
Ruling at 21-run ceiling: prior correction brief did not enumerate all create-new callers. Narrow remaining work to this exact caller and shared handoff owner, with an explicit callsite inventory (active send, active create, library active create, library non-active create; both existing-project links; New/open replacements). No new feature/design. Replan ceiling to 24: original heavy worker + the same two scoped reviewers. This is the smallest safe completion of the existing global requirement; session never patches production itself.
Dispatch 22: final library handoff correction, root-cause caller coverage and mounted tests. Runs 23/24 reserved for focused final verification by the existing correctness/security reviewers.

Final library correction ae2d3deb: one page-owned handoff POST, current workspace save/discard for all callers, result invalidation separate from pending gate release. RED bypass reproduced; GREEN pending-save/failure, brief cancel/discard, editor↔library competition, held POST→New/open→second create stays one POST and stale navigation suppressed. Mounted/workspace/library/Hero-access/type/lint/build/diff pass. Dispatches 23/24 original final reviewers, scoped rechecks.

Final library correctness re-review: shared POST owner/gate and stale response cases PASS. Introduced save-failure dialog handoff-discard branch BLOCK: discard executes stale handoff.
Ruling at 24-run ceiling: specify exact action semantics rather than expand review: failed-save handoff offers retry/cancel only; discard continuation is allowed only for non-handoff workspace replacement/navigation. No POST may follow a failed handoff prerequisite save. This is a bounded branch fix to the plan's explicit save prerequisite, no product decision change. Ceiling replanned to 26: worker follow-up (25) + correctness scoped recheck (26); still-running security reviewer holds final verdict and checks this correction within run24.
Dispatch 25: original implementer, narrow save-failure dialog branch correction and behavioral proof; preserve all prior guards.

Security run24 held verdict and found concrete pre-POST ABA: invalidated saving operation can consume newer same-script operation because continuation matches scriptId only. Included in already-active run25 before commit. Ruling: carry exact immutable operation identity through pending action/closure; execute requires same current valid non-posting owner; finalization/release owner-specific. One held-save/context-invalidation/opposite-entry same-script regression. No additional run or feature scope.

Narrow prerequisite correction d19c1046: failed-save handoff retry/cancel only, continuation guard; immutable operation identity with current/valid/not-posting checks blocks pre-POST ABA. Mounted RED→GREEN for active/library discard and held-save context invalidation cross-entry same-script. Types/lint/build/diff pass. Dispatch26 final_correctness focused recheck; security run24 resumes its held review on this final hash.

Security PASS at d19c1046. Correctness success/discard paths PASS; failure-path ABA BLOCK: stale saving operation can publish recovery UI, whose unscoped close cancels newer operation.
Ruling at 26-run ceiling: exact remaining state-machine correction only, not another broad audit. Every asynchronous continuation including failed-save recovery must validate captured operation identity/validity; recovery close/retry/cancel affects that operation only and cannot invalidate a newer owner. Replan29 for original worker + scoped correctness/security rechecks. Required RED held-save A invalidated → B starts → A fails → B remains owned/one POST/navigation. No optional expansions.
Dispatch27: original heavy implementer, final failure-recovery ownership branch.

Recovery ownership correction 79c435c9: exact failure ABA RED→GREEN (A saving, invalidated, B current, A fails); no stale recovery and B one POST/navigation. Captured owner validated around save, recovery, execute and dialog callbacks. Mounted/type/lint/build/diff pass. Dispatches28/29 original final reviewers scoped to failure recovery ownership and introduced regressions.

## Tier 2 — final gate

PASS at reviewed production head `79c435c9`. Final correctness and security re-reviews independently passed with no residual medium-or-higher blockers. The session reviewed their verdicts, final verification evidence, AC1–11 index, and desktop/mobile/locked-preview screenshots. All approved deliverables are present on the local branch.

Implementation frontier waves: 3. Agent runs: 29 (budget adjustments and reasons above). Usage dashboard/token accounting unavailable; no invented token usage. All action/save/handoff findings are closed. Advisory limits are the isolated-auth browser harness and unverified headless status-select key mutation, recorded accurately in QA. No production action or external publication performed.

Delivery: 2026-09-17 — branch `mew/hero-script-workspace-ux`; final documentation commit follows. No remaining implementation work under this plan.
