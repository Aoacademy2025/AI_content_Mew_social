# Conflict Resolution Task 3 Report

Date: 2026-07-15

## Result

`useV2Project` now treats explicit public draft setters as the sole user-provenance
boundary. Existing-project bootstrap waits for the save lane, loads the server, reads
the project-scoped journal only after that GET, and uses the pure bootstrap decision
without the temporary async adapter. Load errors and conflicts remain unready.

Conflict actions are deterministic:

- Local choice sends the frozen displayed local candidate, a newly reserved revision,
  and the displayed server revision as `expectedDraftRevision`.
- A local-choice `409` retains the exact local candidate and replaces only the server
  candidate from the response.
- Server choice applies the frozen displayed server candidate, seeds the queue, clears
  recovery data, and performs no server write.

Autosave writes a trusted journal immediately before enqueueing a user-authored draft.
Programmatic initialization does not enqueue. A successful save confirms and clears
recovery only when its project and revision match the latest queued save.

## Files

- `src/app/(dashboard)/video-editor/_v2/useV2Project.ts`
- `src/lib/editor-project-bootstrap.ts`
- `src/lib/editor-project-save-queue.ts`
- `scripts/verify-editor-project-recovery-hook.ts`
- `scripts/verify-editor-project-save-queue.ts`
- `scripts/verify-logo-project-default.ts`

The save-queue verifier was migrated as directed at the Task 3 context checkpoint: it
retains ordering, timeout, remount, and lane-eviction coverage while replacing legacy
adapter expectations with the pure decision/journal contracts.

## TDD RED evidence

The hook/source/pure verifier and migrated contracts were written before production
changes.

```text
$ npx tsx scripts/verify-editor-project-recovery-hook.ts
status=1
AssertionError: source still contains bootstrapLocalDirtyRef / bootstrapLocalRecoveryValidRef

$ npx tsx scripts/verify-logo-project-default.ts
status=1
AssertionError: the temporary async bootstrap adapter is gone

$ npx tsx scripts/verify-editor-project-save-queue.ts
status=1
AssertionError: queue exposes conflict revision reservation
actual: undefined
expected: function
```

These failures were caused by the missing Task 3 behavior, not script syntax or setup.

## GREEN evidence

Fresh focused run after the final source changes:

```text
$ npx tsx scripts/verify-editor-project-recovery.ts && \
  npx tsx scripts/verify-editor-project-recovery-hook.ts && \
  npx tsx scripts/verify-editor-project-save-queue.ts && \
  npx tsx scripts/verify-logo-project-default.ts

editor-project-recovery: all checks passed
editor-project-recovery-hook: all checks passed
editor-project-save-queue: all checks passed
logo-project-default: all checks passed
```

## Controlled mutation evidence

`verify-editor-project-recovery-hook.ts` runs the source contract against two
controlled mutations after its normal checks:

1. It replaces the `projectTitle` public setter's `markUserDraftMutation` argument
   with a no-op. Verification must throw that the public setter lost its provenance
   boundary.
2. It injects `markUserDraftMutation()` into `applyDraft`. Verification must throw
   that programmatic draft application is manufacturing provenance.

The verifier reaches its `all checks passed` line only when both independently mutated
sources fail for the intended reason.

## Reviewer regressions

The hook verifier also executes or source-checks the requested regressions:

- No-edit Retry with server revision 5 and no journal returns `server`.
- Missing journal with watermark 1 returns `locked-error/missing_recovery`; defaults
  cannot become local recovery.
- A failed replacement journal write clears cached A, so reload cannot apply A over
  in-memory B.
- Settings and `fetchMe` initialization contain no user setter or mutation boundary.
- StrictMode cleanup yields before new-project POST and cancels the first autosave
  timeout before PATCH; conflict actions are callbacks, not setup effects.
- Retry in `load-error` only increments `bootstrapRetryRevision` and contains no
  storage, journal, user mutation, revision reservation, enqueue, or fetch operation.

## Broader regression evidence

```text
$ npx tsx scripts/verify-editor-projects.ts
ALL 59 EDITOR-PROJECT CHECKS PASSED

$ npx tsx scripts/verify-logo-overlay.ts
logo-overlay: all checks passed

$ npx tsx scripts/verify-logo-render.ts
logo-render: all checks passed

$ npx tsx scripts/verify-logo-client-contract.ts
logo-client-contract: all checks passed
```

Two optional DB-backed scripts (`verify-brand-assets.ts` and
`verify-logo-export.ts`) could not initialize because this worktree has no
`DATABASE_URL`. They stopped at Prisma initialization before assertions.

## Type evidence

```text
$ npx tsc --noEmit --pretty false
src/app/api/payments/checkout/route.ts(129,9): error TS2322: ...
Property 'ref_code' is incompatible with index signature.
Type 'undefined' is not assignable to type 'string | number | null'.
```

No Task 3 file reports a TypeScript error. The single remaining error is the documented
unrelated checkout baseline named in the approved design.

## Production build evidence

Fresh final build:

```text
$ npm run build
✓ Compiled successfully in 12.0s
✓ Generating static pages (139/139)
Finalizing page optimization ...
exit 0
```

The build logs non-fatal Prisma `DATABASE_URL` warnings while collecting pages, then
completes successfully.

## Preserved boundaries

- New-project creation and account logo-default inheritance still use the same
  canonical draft for local apply and POST; legacy cache is cleared after durable POST.
- Existing-project GET waits for the save queue to become idle.
- Autosaves remain serialized and retain the existing ten-second request timeout.
- Queue revision watermarks never decrease; conflict reservation is strictly above
  both the displayed observation and any higher local watermark.
- Logo draft canonicalization and recovery cleanup remain project-scoped.
- Plan, usage, admin/managed flags, avatar metadata, job IDs, project status, and
  preview media remain ordinary system state and never mark user provenance.
