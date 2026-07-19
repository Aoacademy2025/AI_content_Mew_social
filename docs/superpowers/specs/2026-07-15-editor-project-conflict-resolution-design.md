# Editor Project Conflict Resolution Design

Date: 2026-07-15

Status: Approved in conversation; awaiting written-spec review

## Context

The Logo Overlay work depends on editor-project autosave surviving reloads without
silently replacing a newer draft. Server-side monotonic `draftRevision`, serialized
client save lanes, request timeouts, and cleanup-after-save coordination now prevent
the known ordering races. The remaining unsafe boundary is provenance: the current
bootstrap recovery code cannot reliably distinguish a real user edit from stale local
storage, default state, hydration, or asynchronous settings initialization.

Automatic local recovery is therefore removed. When the client cannot prove that one
draft safely supersedes the other, the editor fails closed and asks the user to choose.
The system never selects a conflicting draft on the user's behalf.

This design supersedes the automatic-local-recovery behavior in
`2026-07-15-editor-bootstrap-recovery-design.md`. Its server revision and queue safety
boundaries remain in force.

## Goals

- Never silently overwrite a newer server draft with stale, default, hydrated, or
  programmatically generated client state.
- Record local recovery data only when it originates from an explicit user action.
- Continue automatically when the client can prove that the local draft is based on
  the currently stored server revision.
- Block editing and saving while an existing project cannot be loaded or while a
  conflict is unresolved.
- Give desktop and mobile users the same explicit choice between the local and server
  drafts.
- Preserve the existing Logo Overlay save queue, immutable export snapshot, billing,
  and privacy boundaries.

## Non-goals

- A general offline editor or background synchronization system.
- Field-by-field or collaborative merging.
- Displaying a textual diff of scripts, subtitles, or logo settings.
- Recovering arbitrary legacy local-storage objects automatically.
- Changing project export, quota, or billing behavior.

## Trusted local-edit journal

Each existing project may have one versioned recovery journal in local storage:

```ts
type EditorProjectRecoveryJournalV1 = {
  version: 1;
  projectId: string;
  baseRevision: number;
  editedAt: string;
  draft: EditorProjectDraft;
};
```

The journal is written only through user-intent mutation boundaries exposed by
`useV2Project`. Public setters and actions used by editor controls mark the resulting
draft as user-authored. Internal hydration, server/default application, account
settings loading, preview bookkeeping, and conflict resolution use separate internal
setters and never create or refresh the journal.

The journal is project-scoped and structurally validated before use. A project-id
mismatch, invalid timestamp, invalid base revision, non-object draft, or unsupported
version is not automatically applied. A legacy unverified local draft may be shown as
an explicit conflict choice, but it never wins automatically.

The journal records the last confirmed server revision on which the user's edit was
based. It is refreshed on subsequent user edits and cleared only after a durable save
of that draft succeeds or after the user explicitly chooses the server draft.

If writing the journal fails, the editor must not claim that local recovery is
available. A ready project may still attempt its normal server autosave. An unready
existing project remains locked, so new edits cannot be created without a recoverable
provenance record.

## Server concurrency contract

The existing `draftRevision` rules remain:

- Revision-bearing writes use an atomic compare-and-set boundary.
- Revision-less legacy draft writes atomically increment the stored revision.
- Revision-less metadata-only writes leave the revision unchanged.
- Stale/equal conflicting writes cannot overwrite a newer revision.

Conflict resolution adds an optional `expectedDraftRevision` to revision-bearing
draft writes. A write chosen from a displayed server revision succeeds only when the
stored revision still equals that observed revision. If another client saves before
the choice is committed, the server returns `409` with current project metadata. The
client reloads both candidates and presents the conflict again; it does not retry an
overwrite against an unseen revision.

## Bootstrap state machine

An existing project starts in `loading` and is not editable until bootstrap reaches
`ready`.

### Load failure

Network errors and non-404 responses enter `load-error`. The editor remains locked,
keeps any validated journal untouched, and shows `ลองใหม่`. Retry performs a new GET;
it does not write the current/default draft, mark local state as dirty, or create a
new project.

### Successful load without a journal

The server draft is applied and the editor becomes `ready`. Unverified default,
hydrated, or programmatic client state is discarded.

### Successful load with a trusted journal

- If `serverRevision === journal.baseRevision`, the local draft is based on the
  observed server state. It may be restored and saved with the next revision without
  showing a conflict.
- If `serverRevision > journal.baseRevision`, the server changed after the local edit.
  Enter `conflict` and require an explicit choice.
- If `serverRevision < journal.baseRevision`, the server response is inconsistent
  with previously confirmed state or a timed-out request may still be unresolved.
  Enter a recoverable locked error and re-fetch; never lower the watermark or apply
  either draft automatically.

### Successful load with unverified legacy local data

If a usable legacy local draft exists but lacks trusted provenance, enter `conflict`.
The dialog labels its timestamp as unavailable when necessary. Invalid or unrelated
legacy data is ignored and never converted into an empty/default draft.

## Conflict resolution

`conflict` stores immutable snapshots of the local candidate, the server candidate,
and the observed server revision. The underlying editor remains inert.

### Use local draft

1. Keep the dialog open and disable both choices.
2. Submit the displayed local snapshot with a new revision and
   `expectedDraftRevision` equal to the displayed server revision.
3. On success, apply the saved project, update the queue watermark, clear the journal,
   mark the editor ready, and close the dialog.
4. On network failure, keep the same conflict and show a retryable error.
5. On `409`, fetch the new server candidate and present the conflict again.

### Use server draft

1. Apply exactly the displayed server snapshot.
2. Seed the save coordinator with its revision.
3. Clear the local journal and related legacy recovery data for that project.
4. Mark the editor ready and close the dialog without sending a draft PATCH.

Neither action is preselected. Clicking the backdrop, pressing Escape, or pressing
browser Back does not dismiss the unresolved conflict. A tagged same-URL history entry
is used so Back is consumed without leaving the editor or creating duplicate history
entries. Normal navigation resumes after resolution.

## Responsive dialog

The existing accessible `AlertDialog` primitives are reused in `EditorV2Shell`.
Desktop and mobile share one component and state contract.

Copy:

- Title: `พบข้อมูลโปรเจกต์ 2 เวอร์ชัน`
- Description: `โปรเจกต์นี้มีการแก้ไขในเครื่องที่ยังไม่ตรงกับข้อมูลบนระบบ กรุณาเลือกเวอร์ชันที่ต้องการใช้`
- Candidate labels: `ฉบับในเครื่อง` and `ฉบับบนระบบ`
- Actions: `ใช้ฉบับในเครื่อง` and `ใช้ฉบับบนระบบ`

Each candidate shows its last-known time. The two choices have equal visual weight and
state clearly that the other candidate will be replaced. The dialog has no close
button, traps focus, announces errors, and keeps both actions disabled while resolving.
Initial focus goes to the dialog heading rather than either destructive choice.

On mobile, the dialog fits within safe-area insets, uses the available width with
16-pixel outer gutters, scrolls internally when necessary, and never introduces
horizontal overflow at 360, 375, 390, or 430 pixels. The underlying preview, sheets,
export footer, and controls are inert and cannot receive pointer or keyboard input.

## Hook and component boundaries

`useV2Project` exposes a narrow recovery contract in addition to the existing editor
state:

```ts
type EditorProjectRecoveryState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "load-error"; message: string }
  | {
      status: "conflict";
      local: RecoveryCandidate;
      server: RecoveryCandidate;
      resolving: false | "local" | "server";
      error: string | null;
    };

retryProjectBootstrap(): void;
chooseLocalProjectDraft(): Promise<void>;
chooseServerProjectDraft(): void;
```

The hook owns data decisions and journal lifecycle. A dedicated
`EditorProjectConflictDialog` owns only presentation, focus/history containment, and
calling the three actions. `EditorV2Shell` renders the dialog once so desktop and
mobile cannot create competing recovery owners.

## Failure handling

- Existing-project load failure: locked editor and explicit Retry.
- Journal parse/provenance failure: never auto-apply; conflict only when a usable
  candidate exists.
- Journal write failure while ready: server autosave may continue, but local recovery
  is not advertised.
- Local-choice network failure: conflict stays open with retryable error.
- Local-choice `409`: reload server candidate and ask again.
- Server-choice action: no server write; local cleanup failure is best-effort and does
  not change the selected server draft.
- Telemetry, if added, contains only the chosen source and normalized error code; no
  draft content, asset ID, filename, URL, or storage path.

## Verification

Pure and integration tests must demonstrate:

- Only explicit user mutations create or refresh the journal.
- Hydration, defaults, settings initialization, retry, StrictMode, and programmatic
  setters never fabricate local provenance.
- No-edit Retry chooses a newer server draft rather than stale local data.
- A failed journal write cannot reload an older cache over a newer in-memory edit.
- Load failure keeps the editor unready, performs no POST/PATCH, and never reports
  `saved`.
- Trusted local with the same base revision resumes safely.
- Trusted local against a newer server opens a conflict.
- Missing/corrupt local data with an inconsistent watermark remains a locked error.
- Local and server choices produce the selected durable result.
- A `409` during local choice refreshes the conflict instead of overwriting.
- Back, Escape, backdrop, focus trap, and focus restoration behave correctly.
- The dialog fits desktop and the 360/375/390/430 mobile matrix without overflow.
- Existing Logo Overlay, project, cleanup, render, billing, and telemetry suites remain
  green; production build passes; only the documented unrelated checkout TypeScript
  baseline may remain.

Authenticated QA still requires a non-production test account/session. Automated
coverage does not replace that final protected-editor acceptance pass.

## Acceptance criteria

- An ambiguous local draft can never overwrite a newer server draft without an
  explicit user choice.
- A retry with no user edit can never manufacture local provenance.
- The editor is not interactive while an existing project is unloaded or conflicted.
- Both choices are deterministic, revision-safe, accessible, and responsive.
- Logo Overlay persistence, export, cleanup, billing, and privacy guarantees remain
  unchanged.
