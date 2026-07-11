# Media Retention Fail-Closed Hotfix Implementation Plan

> Execute with test-first red/green cycles. Stop after pushing and opening a PR; do not merge, deploy, apply cleanup, or purge.

## Task 1: Lock active-project behavior with failing graph tests

**Files:** `scripts/verify-media-reference-graph.ts`, `src/lib/media-reference-graph.ts`

- Add expired job/video fixtures referenced by non-archived and archived projects.
- Assert exact-owned active/export/latest primary and derived keys receive an always-protecting project reference.
- Assert archived and owner-mismatched pointers do not receive containment protection.
- Run the verifier and observe the expected RED failure.
- Add project status selection and minimal pointer protection; rerun GREEN.

## Task 2: Lock critical reference semantics

**Files:** `scripts/verify-media-reference-graph.ts`, `src/lib/media-retention.ts`, `src/lib/media-reference-graph.ts`

- Assert only direct final outputs are marked critical, including duplicate refs found recursively.
- Observe RED, then add conservative reference metadata merging and final-output tagging.
- Rerun graph verifier GREEN.

## Task 3: Add missing inventory with exclusive categories

**Files:** `scripts/verify-media-quarantine.ts`, `src/lib/media-cleanup.ts`

- Seed missing final, primary, and derived references and assert exact inventory categories and total invariant.
- Assert planner summary does not expose inventory.
- Observe RED, implement the pure classifier, and rerun GREEN.

## Task 4: Separate sanitized metrics and private review inventory

**Files:** `scripts/verify-media-quarantine.ts`, `src/lib/media-quarantine.ts`

- Assert metrics include only aggregate category counts and no owner/key/path data.
- Assert the mode-0600 review artifact contains the read-only inventory without absolute paths.
- Observe RED, add serialization fields, and rerun GREEN.

## Task 5: Regression verification and PR

- Run reference graph, quarantine, retention, cleanup-mode, rollout-safety, purge-disabled, project-media-state, and deploy-permission verifiers.
- Run TypeScript typecheck and a production build against an isolated temporary SQLite database.
- Review diff and confirm no production mutation command was introduced or executed.
- Commit, push `mew/media-retention-failclosed-hotfix`, open a PR with safety scope and verification evidence, and wait for CI. Do not merge or deploy.
