# Editor Final-Review Remediation Design

**Date:** 2026-07-16
**Status:** Approved
**Branch:** `mew/responsive-logo-overlay`

## 1. Context and decision

The merge-base-to-HEAD review found two release-blocking lifecycle gaps:

1. blank-project bootstrap and Reset leave the editor interactive while account Logo
   defaults are still loading, so accepted input can be silently overwritten; and
2. automatic Logo cleanup can physically delete an asset that still exists in a
   trusted browser recovery draft, after which **Use local** can persist a dangling
   asset id.

The approved direction is:

- make project initialization an explicit owned lifecycle and keep the editor inert
  until the server project and autosave lineage are ready; and
- retire unreferenced Logo assets into hidden recoverable storage instead of physically
  deleting them. A trusted project write that references an owned retired asset restores
  the same asset id atomically with the successful project write.

This preserves the existing contract that **Use local** applies the selected candidate
exactly. The accepted storage tradeoff is that retired Logo files remain private until
the account is hard-deleted. There is no time-based purge in this change because a local
recovery journal currently has no server-visible expiry that could prove a purge safe.

The two non-blocking final-review findings—history guard cleanup and stale
`saveAsDefault` ownership—are included as focused lifecycle hardening, without unrelated
refactoring.

## 2. Goals

- Never accept an editor mutation that can be silently overwritten by bootstrap or
  Reset.
- Keep UI, hook state, recovery journal, autosave lineage, and server project ownership
  aligned during initialization.
- Never persist a project draft whose Logo id is missing or belongs to another account.
- Allow a trusted stale recovery draft to restore the exact owned Logo id that automatic
  cleanup retired.
- Keep retired assets invisible in normal asset collection/default selection flows.
- Preserve current CAS, conflict, preview, export, privacy, mobile, admin deletion, and
  Clerk cleanup contracts.
- Restore normal browser Back behavior after conflict resolution.
- Prevent a stale default-save request from mutating UI state owned by a newer project,
  upload, or default-save request.

## 3. Non-goals

- End Scene support.
- ElevenLabs/BYOK diagnosis.
- Trial/checkout changes.
- A general-purpose asset recycle-bin UI.
- Time-based physical purging of retired assets.
- Server synchronization of the complete browser recovery journal.
- Refactoring unrelated editor, payment, or media systems.

## 4. Project initialization ownership

### 4.1 State and ownership

`useV2Project` owns an explicit initialization state:

```ts
type ProjectInitializationState =
  | "loading-defaults"
  | "creating-project"
  | "ready"
  | "error";
```

The initial state is `"loading-defaults"`. Before Reset performs any await, it
synchronously:

1. invalidates local-choice, autosave, and bootstrap ownership;
2. sets `projectReady` false and initialization to `"loading-defaults"`;
3. installs the new generation and abort controller; and
4. clears any ownership that could enqueue a save for the old project.

After the account default is resolved and the generation is still current, the hook
applies the canonical seed/reset draft and enters `"creating-project"`. It enters
`"ready"` only after the server project exists and autosave lineage is initialized for
that exact project. A failed non-abort load/create enters the existing visible load-error
recovery and initialization `"error"`; it never leaves an invisible permanently inert
screen.

Blank bootstrap follows the same state transitions. Existing-project bootstrap may not
briefly become ready before its trusted bootstrap/recovery decision is complete.

### 4.2 Interaction boundary

The editor shell is inert whenever either condition is true:

```text
initialization != ready OR recovery != none
```

The inert boundary covers desktop and mobile controls, project submission, Logo controls,
and keyboard shortcuts. A visible status outside the inert subtree announces that the
project is being prepared. The loading state is not marked `aria-hidden`; assistive
technology receives the status while editor controls remain unavailable.

Hook-level user mutation entry points also reject mutations while initialization is not
`"ready"`. This is defense in depth for imperative/test callers and prevents a future UI
surface from bypassing the inert shell. Programmatic application of a trusted seed draft
uses internal raw setters and is not blocked.

Reset may move the wizard to Step 0 immediately, but Step 0 remains inert until the new
project and lineage are ready. No intermediate old-project draft is journaled or saved as
the new project.

### 4.3 Async completion rules

Every await in default loading/project creation checks the captured generation,
controller, mounted state, and expected project ownership before side effects. A late
completion from a superseded Reset/bootstrap cannot change fields, readiness, recovery,
storage keys, lineage, or errors.

## 5. Recoverable Logo asset lifetime

### 5.1 Schema and retention

`BrandAsset` gains:

```prisma
retiredAt         DateTime?
lifecycleRevision Int      @default(0)
```

Existing and newly uploaded assets have `retiredAt = null`. Retiring an asset keeps its
database row, stable asset id, storage key, and private normalized file. It is not a
physical delete.

Retention lasts until account hard deletion. The existing Clerk/admin account deletion
paths still remove the user row and private asset directory, including retired assets.
No individual retired-asset sweeper is added.

### 5.2 Active versus recoverable queries

- Asset collections, account-default selection, and ordinary active-asset lookup expose
  only `retiredAt = null`.
- A direct same-owner recovery lookup may resolve a retired row and its file.
- Cross-owner lookup remains indistinguishable from not found.
- A retired asset cannot become an account default until a successful project write has
  restored it.
- Normal collection responses do not reveal retired metadata.

The implementation uses distinct active and recoverable lookup helpers so a caller must
choose the intended boundary explicitly.

### 5.3 Retirement

The existing unreferenced-delete transaction keeps its global checks:

- same owner;
- not the account default; and
- not referenced by any current database project draft.

If those checks pass, the transaction sets `retiredAt` instead of deleting the row. The
file is not unlinked. A currently active reference still returns `asset_in_use`. A
repeated normal delete of an already retired asset is hidden as not found/idempotent
according to the existing API contract.

This retirement rule applies to the automatic delayed cleanup used after replacement or
removal. It also applies to the current DELETE endpoint because the server cannot know
which private browser recovery journals still exist. A future irreversible-delete UI
would require an explicit recovery-invalidating contract and is out of scope.

### 5.4 Project write validation and restoration

All server project writes that include a draft—create, ordinary autosave, explicit local
conflict choice, and legacy revision-compatible writes—normalize the draft and extract
its Logo asset id before committing.

If a Logo id is present:

1. validate that the asset row belongs to the same user;
2. validate that the trusted file still exists inside the configured private root;
3. execute the project create/update CAS and an optimistic increment of the asset's
   `lifecycleRevision` in one database transaction;
4. clear `retiredAt` in that same conditional asset update when restoration is needed;
   and
5. restore only when the project write succeeds. A failed/stale CAS must not restore an
   asset as a side effect.

An active owned asset needs no status change, but its lifecycle revision still advances
inside the successful project transaction to fence a concurrent retirement. An owned
retired asset is restored with the same id and file; **Use local** can therefore preserve
the candidate exactly. A missing,
cross-owner, or physically unavailable asset fails with a stable
`brand_asset_unavailable` project error and does not mutate the project or close the
conflict. The client keeps the recovery journal/candidate visible and explains that the
Logo must be re-uploaded if recovery is genuinely impossible.

The database transaction plus `lifecycleRevision` prevents retirement from winning on a
stale reference scan. Retirement reads the asset revision, verifies current database
references, then conditionally sets `retiredAt` and increments the revision only if the
revision is unchanged. Every successful project draft write that references the asset
also conditionally increments the same revision inside its project transaction. If
either conditional asset update loses, its whole transaction aborts and returns a
retryable conflict; the project write cannot commit without its asset fence, and cleanup
cannot retire after a newer recovery write.

### 5.5 Read, preview, and export behavior

A trusted direct image request for a same-owner retired asset remains available so the
conflict preview can display the exact local candidate before resolution. Collection
listing remains hidden. After successful local recovery, the row is active again and
the existing preview/export staging path operates unchanged.

Export keeps its current fail-closed file snapshot validation. Retention does not weaken
path containment, ownership, mime validation, or immutable staging.

### 5.6 Storage and operations

Retired assets consume private storage until account deletion. This is intentional and
must be recorded in release notes/operations. The service may expose an aggregate count
or bytes metric later, but no user identifiers, filenames, or storage keys are added to
logs or telemetry by this change.

## 6. Conflict-history cleanup hardening

The conflict guard may push one same-URL history entry while recovery is active. On
resolution, if and only if the current entry is the owned guard and there is no pending
Back transition, cleanup pops that owned entry under a cleanup generation instead of
retagging it in place. The resulting current entry is the original editor entry, so the
next Back performs normal navigation.

If a Back/pop race is already pending, cleanup does not issue a second history movement.
Stale popstate callbacks are generation-gated. Foreign history state and foreign URLs are
never replaced or popped by ownership inference alone.

## 7. Default-save async ownership

`saveAsDefault` receives independent request generation and `AbortController` ownership.
The captured operation includes project id, asset id, surface, and request generation.

Project switch, unmount, a newer default save, or a new upload invalidates/aborts the old
default save. After every await and before error, telemetry, success, or final loading
state mutation, the callback proves ownership. Shared `saving` state is token-owned so an
old `finally` cannot set `saving=false` while a newer upload/default save is active.

An aborted/stale default save is inert and does not display an error or completion event.

## 8. API and error behavior

- Brand asset DELETE keeps its current public success/not-found/in-use shapes; success
  now means retired from active use, not physically purged.
- Editor project create/PATCH maps `brand_asset_unavailable` to a stable client error.
- A conflict local-choice failure caused by that error retains the conflict and trusted
  journal. It does not silently remove the Logo or fall back to the server candidate.
- No raw asset id, Clerk id, email, local path, or storage key is added to logs.
- Existing invalid signature, admin boolean, payment, and unrelated route behavior are
  unchanged.

## 9. Test design

### 9.1 Initialization RED/GREEN cases

Actual-hook tests use deferred account-default responses:

1. blank bootstrap is inert before the default resolves;
2. Reset synchronously becomes inert before the default await;
3. attempted user setters during either wait do not change the eventual draft;
4. the canonical default/reset draft is applied once;
5. project creation and lineage complete before interaction becomes ready;
6. superseded/unmounted loads are inert; and
7. non-abort failure becomes visible load-error rather than permanent loading.

### 9.2 Asset lifetime integration cases

Using a disposable database and private root:

1. unreferenced cleanup retires the row, preserves the file/id, and hides collection
   listing;
2. active default/global project references still block retirement;
3. stale recovery **Use local** restores the same retired id and produces a valid image,
   project draft, preview input, and export snapshot;
4. stale CAS does not restore the asset;
5. server-choice/refresh does not restore the asset;
6. missing file, missing row, and cross-owner id fail without project mutation;
7. concurrent retire versus CAS recovery has only two valid results: retirement loses
   and the project references an active asset, or recovery receives an explicit
   recoverable failure—never a committed dangling id; and
8. account hard deletion removes active and retired rows/files.

### 9.3 Minor lifecycle cases

- After conflict resolution, one Back leaves the editor normally; no duplicate same-URL
  entry remains.
- Pending Back cleanup does not navigate twice or touch foreign history.
- Default-save completion after project switch/new upload/newer default save is inert.
- Only the current mutation owner changes loading/error/telemetry state.

### 9.4 Mutation sensitivity

Tests must fail when controlled mutations:

- remove the pre-await initialization block;
- allow a user setter while initialization is not ready;
- physically delete a retired file/row;
- omit retired-asset restoration;
- restore before a CAS that later fails;
- omit the asset lifecycle-revision CAS from retirement or project recovery;
- skip same-owner/file validation;
- close conflict on `brand_asset_unavailable`;
- retain the same-URL history guard after resolution; or
- let a stale default-save `finally` clear a newer operation's loading state.

## 10. Verification and rollout

After focused RED/GREEN and mutation checks:

- run the affected recovery-hook, save-queue, logo client, brand asset, project service,
  export, media-reference, and account-cleanup verifiers;
- run the complete 18-verifier release gate on new disposable fixtures;
- run Prisma generation, production build, and TypeScript, keeping the unchanged checkout
  metadata baseline separate;
- request independent focused review, then repeat merge-base-to-HEAD review if any
  Critical/Important issue appears; and
- restart only the worktree-owned QA server at current HEAD, then perform protected
  desktop/mobile and preview/export QA when a non-production authenticated session is
  available.

Schema rollout adds nullable `retiredAt` plus non-null `lifecycleRevision` with default
zero; existing rows therefore remain active with revision zero. Deployment must apply
the Prisma schema before serving code that writes either field. No merge, push, schema
rollout, or deployment occurs without the user's explicit final choice.

## 11. Acceptance criteria

- No editable surface is active before project initialization and lineage are complete.
- Reset/bootstrap cannot silently discard accepted user input.
- A database project can never commit a missing or cross-owner Logo id.
- Trusted local recovery restores the exact retained same-owner Logo id atomically with
  a successful project write.
- Retired assets stay hidden from ordinary lists/default selection and remain private.
- Account deletion still removes all retained data.
- Conflict resolution leaves normal Back navigation.
- Stale default-save callbacks are inert.
- All focused and full release gates pass, with only the documented unchanged TypeScript
  baseline if it still exists.
