# Editor Release-Blocker Remediation Design

**Status:** Approved architecture, pending implementation plan  
**Date:** 2026-07-15  
**Branch:** `mew/responsive-logo-overlay`

## Purpose

This design closes the release blockers found by the final whole-branch review of
Responsive Logo Overlay and editor conflict recovery. It amends:

- `2026-07-14-logo-overlay-responsive-design.md`
- `2026-07-15-editor-project-conflict-resolution-design.md`

Where this document is more specific, it governs. The design deliberately keeps the
existing database schema and extends the observed-revision recovery architecture. It
must never trade silent data loss for a smoother retry.

## Release Blockers

1. Ordinary Editor v2 autosaves send a newly allocated `draftRevision` without
   `expectedDraftRevision`. A losing tab can receive 409, allocate a higher number,
   and silently overwrite a newer server draft.
2. If an explicit local-choice PATCH is ambiguous and the authoritative GET also
   fails, the conflict dialog remains disabled with no in-dialog retry.
3. A logo upload started for project A can complete after Reset/project navigation
   and apply its result to project B.
4. Account deletion lists asset paths before deleting the user. A concurrent upload
   can create a file after the list and before the cascading database delete, leaving
   a private orphan.

## Global Constraints

- No database schema or migration is added.
- Existing non-v2 and revision-less editor-project callers remain backward compatible.
- Every Editor v2 autosave is conditional on a server revision that this tab actually
  observed or safely acknowledged through an immutable same-lane snapshot.
- Revision numbers alone never prove lineage.
- Ambiguous outcomes are reconciled before the save lane starts another network write.
- An unprovable outcome blocks the editor and requires explicit conflict resolution.
- Programmatic hydration still cannot create recovery provenance.
- Logo upload completion can mutate only the project/request generation that started it.
- Account deletion removes only the server-controlled directory for the exact user id.
- No merge or deployment is permitted while Critical or Important review findings remain.

## 1. Autosave CAS and Same-Lane Lineage

### 1.1 Immutable save snapshots

Each save that actually starts network I/O owns an immutable snapshot:

```ts
export type EditorProjectAutosaveSnapshot = {
  projectId: string;
  expectedDraftRevision: number;
  draftRevision: number;
  draft: Readonly<Record<string, unknown>>;
  fingerprint: string;
};
```

The draft is passed through the existing strict recovery-draft materializer before it
is stored. The fingerprint is deterministic over JSON object keys, array order,
primitives, and null. It rejects the same unsafe values as the recovery journal.

The hook owns one project-scoped lineage tracker:

```ts
export type EditorProjectAutosaveLineage = {
  projectId: string;
  confirmed: RecoveryCandidate;
  issued: ReadonlyMap<number, EditorProjectAutosaveSnapshot>;
  latestLocal: RecoveryCandidate | null;
  blocked: boolean;
  generation: number;
};
```

`confirmed` changes only after a definite PATCH acknowledgement or an authoritative
GET that proves a known snapshot. `issued` contains every request that started, even
when the request timed out or its UI status was suppressed by coalescing. The tracker
is reset on project change, Reset, explicit conflict choice, and unmount.

### 1.2 Dispatch semantics

The queue continues to allocate strictly increasing `draftRevision` values. At the
moment a request starts—not when it was enqueued—it reads the tracker's confirmed
revision as `expectedDraftRevision`, registers its immutable issued snapshot, and
sends both revisions:

```json
{
  "draftRevision": 12,
  "expectedDraftRevision": 11,
  "draft": {}
}
```

This dispatch-time read is required because a preceding coalesced request may have
been acknowledged after the pending draft was enqueued. Every successful request
updates the confirmed tracker immediately, even when only a later request is allowed
to publish the visible `saved` status. Journal clearing remains limited to the latest
acknowledged queued draft.

### 1.3 Backward-compatible queue outcomes

The save queue adds structured outcomes while retaining boolean support for existing
callers/tests:

```ts
export type EditorProjectSaveOutcome =
  | { kind: "saved" }
  | { kind: "error" }
  | { kind: "ambiguous" }
  | { kind: "blocked" };

export type EditorProjectSaveInput = {
  projectId: string;
  save: (context: EditorProjectSaveContext) =>
    Promise<boolean | EditorProjectSaveOutcome>;
  reconcile?: (context: EditorProjectSaveContext) =>
    Promise<EditorProjectSaveOutcome>;
  onBlocked?: (event: EditorProjectSaveEvent) => void;
  isActive?: () => boolean;
  onStatus?: (event: EditorProjectSaveEvent) => void;
};
```

Legacy `true` normalizes to `saved`; legacy `false` normalizes to `error`.

- A network error returns `ambiguous`.
- A queue timeout aborts the PATCH and enters `reconcile` with a fresh signal.
- `reconcile` is itself bounded by the queue timeout.
- The queue does not start the pending request until reconciliation settles.
- A reconciliation timeout/error becomes `blocked`, calls `onBlocked`, drops the
  pending request, and releases the lane without another PATCH.
- A hook callback whose PATCH signal is already aborted must not mutate acknowledgement
  state; only the winning queue/reconciliation path may do so.

The queue preserves existing `whenIdle`, lane eviction, revision watermark, status
suppression, and project-isolation behavior.

### 1.4 Authoritative observation decision

A pure decision module compares an authoritative server candidate with the current
attempt, the confirmed candidate, and known issued snapshots. Exactly four decisions
are permitted:

1. **Saved:** server revision and fingerprint equal the current attempt. The PATCH
   committed even if the response was lost.
2. **Retry from confirmed base:** server revision still equals the current confirmed
   revision. The current attempt did not commit and may retry once using CAS.
3. **Advance through known same-lane snapshot:** server revision/fingerprint equal a
   previously issued snapshot from this lane. That snapshot becomes confirmed and the
   current attempt may retry once from it.
4. **Conflict:** the server candidate does not match any safe case. The lane blocks;
   numeric revision order alone never selects an automatic rebase.

The retry is limited to one reconciliation cycle. A second ambiguous result becomes a
locked conflict requiring the GET-only retry described below.

Canonical equality intentionally treats two independently produced but identical
drafts as equivalent because continuing cannot remove any distinct server content.

### 1.5 Materializing an autosave conflict

On `Conflict`, the hook:

- sets the lineage tracker to `blocked` before any pending callback can run;
- sets `projectReady` false;
- uses the latest immutable explicit-user local snapshot, not the older request that
  happened to discover the conflict;
- uses the validated authoritative server candidate;
- preserves the recovery journal;
- clears/drops queued pending network writes; and
- enters the existing blocking conflict dialog with `resolving: false`.

Only explicit Use local/Use server resolution can unblock autosave. Use local keeps the
existing observed-revision CAS. Use server sends no draft PATCH.

## 2. Retryable Fail-Closed Conflict Refresh

The conflict state adds a refresh requirement without pretending that a failed GET is
still running:

```ts
type ConflictRecoveryState = {
  status: "conflict";
  local: RecoveryCandidate;
  server: RecoveryCandidate;
  resolving: false | "local" | "server" | "refresh";
  requiresServerRefresh: boolean;
  error: string | null;
};
```

When an ambiguous PATCH cannot be followed by a successful authoritative GET:

- `resolving` returns to `false`;
- `requiresServerRefresh` becomes true;
- both destructive choices remain disabled;
- the immutable local candidate and last validated server candidate remain unchanged;
- the dialog shows `ตรวจสอบเวอร์ชันล่าสุดอีกครั้ง`.

That action performs a GET only. While it runs, `resolving` is `"refresh"`. Success
replaces only the server candidate, clears the refresh requirement, and re-enables the
two choices. Failure returns to the same retryable locked state. Project change,
Reset, or unmount invalidates the refresh generation and prevents stale callbacks.

## 3. Project-Scoped Logo Upload Ownership

`useLogoOverlayEditor` owns a monotonically increasing upload generation, the current
project id ref, and the active upload `AbortController`.

- Starting a new upload aborts the prior upload and claims a new generation.
- Project-id change and unmount synchronously invalidate the generation and abort.
- The starting project id and generation are checked after every await and before
  `setAsset`, `onChange`, prior-asset cleanup, telemetry success, error state, or
  `saving=false`.
- A stale completion never changes the new project's configuration and never deletes
  the new project's previously selected asset.
- If a stale successful response has already exposed the newly created asset id, the
  hook may schedule best-effort deletion of that new unreferenced asset using only the
  starting project id. This orphan cleanup is not allowed to touch either project's
  selected asset.
- A response lost because the request was aborted is treated as cancelled, not as an
  error on the new project.

Normal same-project upload, replacement cleanup, default selection, and telemetry
allowlisting stay unchanged.

## 4. Concurrent-Safe Account Asset Deletion

Pre-listing individual file paths is removed from account hard deletion. After the
database user delete attempt, the helper always removes the exact server-controlled
user asset directory recursively and idempotently, including when the user row was
already absent on a retry.

The directory helper:

- accepts a single non-empty basename user id (no separators, `.` or `..`);
- resolves only `<BRAND_ASSET_ROOT>/<userId>`;
- verifies the resolved directory is a strict descendant of the configured root;
- uses recursive, forced removal; and
- never accepts a client path or storage key.

If an upload writes before the database delete, the post-delete directory removal
removes its file. If it writes after the user/project cascade, its foreign-key insert
fails and the upload's existing catch path unlinks its temporary/final files. An empty
recreated directory is acceptable; an orphan private file is not.

Admin deletion and Clerk `user.deleted` continue to delegate to the same shared
helper. Cleanup failures remain server-logged and can be repaired by an idempotent
deletion retry.

## 5. Verification Design

### Autosave/CAS

- Two independent clients load revision 0. A wins revision 1. B's stale revision-1
  PATCH receives 409; B Retry/next edit performs no advancing PATCH and opens conflict.
- A timeout that committed is recognized only when GET revision/fingerprint match the
  issued snapshot.
- A timeout that did not commit retries once from unchanged confirmed base.
- Another tab occupying the same numeric revision with a different fingerprint opens
  conflict.
- A coalesced intermediate save updates confirmed lineage even when its `saved` UI
  event is suppressed.
- A pending request never starts while timeout reconciliation is unresolved.
- Project switch/Reset/unmount invalidates late PATCH/GET outcomes.
- Mutations that omit `expectedDraftRevision`, accept numeric-only lineage, or continue
  the lane after conflict must fail.

### Conflict retry

- Ambiguous PATCH plus failed GET produces a locked but non-spinning dialog.
- Repeated GET-only retries send no PATCH and preserve local object identity.
- Successful retry refreshes only the server candidate and re-enables both choices.
- Duplicate retry/choice actions cannot start duplicate network writes.

### Logo upload

- Deferred project-A upload followed by Reset/project-B change cannot call B's
  `onChange`, cannot overwrite B's asset, and cannot run prior-asset cleanup for B.
- Same-project upload still applies exactly once.
- A second upload cancels the first; stale `finally` cannot clear the second upload's
  saving state.

### Account deletion

- A file/asset created before deletion is removed by directory cleanup.
- An upload paused before file creation, resumed after user deletion, fails its DB
  insert and leaves no file.
- Unknown-user/idempotent retry removes a pre-existing safe user directory while still
  returning the existing missing-user result.
- Separator/traversal user ids are rejected and cannot remove sibling/root data.

### Final gate

Run the full editor recovery, save-queue, editor-project, Logo Overlay, brand asset,
export/render, billing/media, Prisma generation, production build, and TypeScript
baseline suites. Repeat an independent whole-branch review. Authenticated protected
desktop/mobile QA and one real preview/export parity check remain required release
evidence and must be reported as blocked if no non-production session is available.

## Non-Goals

- No database writer token or lineage columns.
- No collaborative real-time editing or automatic draft merge.
- No background asset-library cleanup service.
- No changes to payments, subscriptions, ElevenLabs, render billing, or Editor v1.
- No timing-based History API cleanup is reintroduced.
