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

## Reviewer follow-up: executable hook regressions

The review exposed race paths that the original source-only checks did not execute.
`scripts/editor-project-recovery-hook-runtime-harness.ts` now transpiles and evaluates
the real `useV2Project` hook with a deterministic React-hook dispatcher, mocked fetch
and storage, the real hook-facing save-queue contract, and fake timers. It adds no
runtime dependency to the application.

Before the reviewer fixes, the harness reproduced these failures:

```text
settings-after-GET: late avatar, voice, and mix defaults replaced the selected server draft
equal-revision-resume: PATCH contained live/default state instead of the exact journal draft
reset-during-GET: the obsolete project GET applied after reset began
project-switching: the B recovery journal was absent because logoOverlay: undefined was not JSON-safe
ambiguous-local-choice: only the bootstrap GET ran; no authoritative refresh GET followed the failed PATCH
ambiguous-refresh-failure: resolving became false, re-enabling unsafe choices
revision-exhaustion: reserveRevisionAbove threw out of the conflict action
```

The pre-fix harness already passed functional public setters (including stable setter
identity plus clip/mix coupling), failed journal writes continuing to autosave, and
StrictMode setup/cleanup. Keeping these cases in the final suite prevents those
existing guarantees from regressing while the races are fixed.

The production fixes make existing-project selection fail closed:

- Existing-project bootstrap synchronously disables account draft defaults; delayed
  `/video-settings` and account-profile responses can still update system state but
  cannot overwrite the selected server or recovery draft.
- Equal-revision resume retains a frozen trusted recovery snapshot until its PATCH
  succeeds. Autosave canonicalizes that exact snapshot instead of rebuilding from
  later live/default state.
- Reset and bootstrap use generation ownership plus abort signals, with every
  post-await mutation and storage write guarded by the active generation.
- An ambiguous local-choice PATCH failure always performs an authoritative GET before
  choices can be re-enabled. If that refresh also fails, the conflict stays locked;
  choosing server remains PATCH-free.
- Revision reservation is inside the guarded conflict action. Exhaustion restores the
  immutable local/server candidates with an actionable error.
- Autosave canonicalizes the draft before recovery journaling, so optional undefined
  logo fields cannot invalidate a project-scoped journal. The project-switch case
  asserts B's journal has `projectId=switch-b`, `baseRevision=7`, and B's draft while
  preserving A's journal.

The final runtime suite covers ten cases:

```text
settings-after-GET
equal-revision-resume exact immutable PATCH
reset-during-GET
functional setters, stable identity, clip coupling, and mix coupling
failed journal write still autosaves
project switching with project-scoped journal identity and revision
StrictMode setup/cleanup: one POST and one PATCH
ambiguous local choice performs a refresh GET
failed ambiguous refresh stays locked and server choice cannot act
revision exhaustion restores the immutable conflict
```

`verify-editor-project-recovery-hook.ts` also mutation-tests the runtime harness:

1. Removing the existing-project account-default guard must fail the
   settings-after-GET case.
2. Removing trusted-resume snapshot selection must fail the exact resume-PATCH case.

These run alongside the original public-setter and programmatic-apply source mutations.

Fresh post-review verification:

```text
$ npx tsx scripts/verify-editor-project-recovery.ts
editor-project-recovery: all checks passed

$ npx tsx scripts/verify-editor-project-recovery-hook.ts
editor-project-recovery-hook: all checks passed

$ npx tsx scripts/verify-editor-project-save-queue.ts
editor-project-save-queue: all checks passed

$ npx tsx scripts/verify-logo-project-default.ts
logo-project-default: all checks passed

$ npx tsx scripts/verify-editor-projects.ts
ALL 59 EDITOR-PROJECT CHECKS PASSED

$ npx tsx scripts/verify-logo-overlay.ts
logo-overlay: all checks passed

$ npx tsx scripts/verify-logo-render.ts
logo-render: all checks passed

$ npx tsx scripts/verify-logo-client-contract.ts
logo-client-contract: all checks passed
```

The fresh post-review typecheck retains only the same unrelated checkout baseline:

```text
$ npx tsc --noEmit --pretty false
src/app/api/payments/checkout/route.ts(129,9): error TS2322: ...
Property 'ref_code' is incompatible with index signature.
Type 'undefined' is not assignable to type 'string | number | null'.
```

The fresh post-review production build passed:

```text
$ npm run build
✓ Compiled successfully in 10.0s
✓ Generating static pages (139/139)
Finalizing page optimization ...
exit 0
```

As before, page collection logged non-fatal Prisma warnings because `DATABASE_URL` is
not configured in this worktree; the build continued and exited successfully.

## Final re-review: unmount ownership and malformed 409 validation

The final re-review identified one remaining lifecycle owner outside the bootstrap
effect's captured cleanup. `resetProject` replaces the bootstrap controller and
generation, so unmounting only the captured bootstrap controller did not invalidate
the newer reset owner. The direct 409 path also treated a structurally valid candidate
with a `null` revision as authoritative, while the refresh path correctly required a
concrete revision.

The runtime harness now records storage operations and queue seed operations. Its
fetch double records each request's real `AbortSignal` and races every queued or
default response against that signal, rejecting with `AbortError` when cancelled.
The pending-POST regression proves cancellation settles the reset promise before the
deferred response is released; it then releases the late response and verifies it has
no effect.

### RED evidence

The production source was unchanged when these cases were added. The focused hook
verifier failed with the intended behavior differences:

```text
$ npx tsx scripts/verify-editor-project-recovery-hook.ts
exit=1

reset-unmount-during-brand:
late project POST count actual 1, expected 0

reset-unmount-during-POST:
abortedOnUnmount actual false, expected true
queueSeedDelta actual 1, expected 0
storageOperationDelta actual 2, expected 0
state changed from projectId=null/projectReady=false
to projectId=reset-post-b/projectReady=true

malformed-409-refresh:
missing draftRevision: authoritative GET count actual 1, expected 2
invalid string draftRevision: authoritative GET count actual 1, expected 2
```

The wrong-project-ID and negative-revision matrix entries already refreshed
authoritatively. The RED failures isolated the remaining null-revision acceptance and
confirmed that the reset controller, queue seed, state, and storage all survived
component unmount.

### GREEN implementation

The mounted-owner cleanup now synchronously performs all lifecycle invalidation:

- marks the hook unmounted;
- increments the shared bootstrap/reset generation;
- aborts the current controller, including a controller installed by reset; and
- clears the controller reference.

Both reset and bootstrap ownership predicates also require `mountedRef.current`, so
every post-await mutation remains owned by the mounted hook. The direct 409 path now
accepts a candidate only when `server.revision !== null`; missing, wrong-ID, string,
and negative revisions all use an authoritative GET before choices reopen.

The executable hook contract now has thirteen top-level cases, including both unmount
timings and a four-entry malformed-409 matrix. Runtime mutation checks additionally:

1. remove the unmount generation/abort cleanup and require the pending-reset test to
   fail; and
2. restore nullable direct-409 acceptance and require the malformed matrix to fail.

These run with the existing late-default, exact-resume, public-setter, and
programmatic-apply mutations.

### Final verification

```text
$ npx tsx scripts/verify-editor-project-recovery.ts
editor-project-recovery: all checks passed

$ npx tsx scripts/verify-editor-project-recovery-hook.ts
editor-project-recovery-hook: all checks passed

$ npx tsx scripts/verify-editor-project-save-queue.ts
editor-project-save-queue: all checks passed

$ npx tsx scripts/verify-logo-project-default.ts
logo-project-default: all checks passed

$ npx tsx scripts/verify-editor-projects.ts
ALL 59 EDITOR-PROJECT CHECKS PASSED

$ npx tsx scripts/verify-logo-overlay.ts
logo-overlay: all checks passed

$ npx tsx scripts/verify-logo-render.ts
logo-render: all checks passed

$ npx tsx scripts/verify-logo-client-contract.ts
logo-client-contract: all checks passed

$ npx tsc --noEmit --pretty false
exit=2
src/app/api/payments/checkout/route.ts(129,9): error TS2322: ...
Property 'ref_code' is incompatible with index signature.
Type 'undefined' is not assignable to type 'string | number | null'.

$ npm run build
✓ Compiled successfully in 10.0s
✓ Generating static pages (139/139)
exit 0
```

No Task 3 file reports a TypeScript error. The build again logs only the non-fatal
missing-`DATABASE_URL` Prisma warning during page collection.
