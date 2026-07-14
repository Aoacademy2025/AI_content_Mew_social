# Editor Draft Bootstrap Recovery Design

Date: 2026-07-15

## Scope

Close the four remaining editor-draft persistence repros without adding another
timing heuristic or changing the local-storage format. Recovery is limited to an
ordinary module-preserving React remount, using the existing valid local draft and
the shared queue's in-memory per-project revision watermark.

## Server revision boundary

A PATCH that writes a draft without supplying `draftRevision` remains compatible,
but atomically increments the stored revision in the same `updateMany`. A metadata-
only revision-less PATCH does not increment. Revision-bearing writes retain the
`storedRevision < suppliedRevision` compare-and-set predicate, so a revision issued
before a legacy draft write cannot later overwrite it.

PATCH JSON must be a non-null, non-array object. `null`, arrays, and primitive JSON
return the existing HTTP 400 `no_fields` response through the export-safe adjacent
PATCH seam, never HTTP 500.

## Client bootstrap decision boundary

The shared save coordinator exposes a read-only `revisionWatermark(projectId)`.
After the project lane is idle, bootstrap GET is resolved by a pure decision:

- Apply server when it is not older than the local watermark and no local edit was
  made while bootstrap was pending or failed.
- Recover the existing valid local draft when the server is older than the watermark,
  or when the user edited locally while bootstrap was unresolved. Seed the server
  revision without lowering the watermark, mark the project ready, and submit the
  recovered draft at the next allocated revision.
- If the server is older than the watermark and no valid local recovery draft exists,
  keep the project unready, surface a recoverable save/bootstrap error, and perform no
  PATCH until Retry observes safe server state or valid local recovery.

Local draft parsing accepts only non-null, non-array JSON objects. Missing or corrupt
storage is never converted into an empty/default draft during recovery.

## Failure, local edits, and retry

Network and non-404 GET failures for an existing id apply a valid local draft for
continued editing, but keep `projectReady=false` and `saveStatus="error"`. They never
fall through to account-default loading or project creation. While unready, the
debounced persistence effect writes the current draft locally, marks local work dirty,
and preserves the error status; it never publishes `saved` or sends PATCH.

The existing Retry action retries bootstrap while unready and retries autosave while
ready. After a successful retry, locally dirty work wins over the fetched server draft
and is submitted at the next monotonic revision. No duplicate project is created for
an existing id.

## Verification

- Database tests cover revision-bearing 2, legacy draft increment to 3, late revision
  3 rejection, metadata stability, and concurrent legacy increments.
- API tests cover null, array, and primitive PATCH bodies returning 400 `no_fields`.
- Queue/bootstrap tests cover timeout A revision 1, idle GET revision 0, local user-new,
  remount save revision 2, and late A completing before or after revision 2.
- Bootstrap tests cover GET failure, local edit during error, no unready PATCH/saved
  status, Retry reconciliation, missing/corrupt local recovery, and no duplicate POST.
- The full logo and adjacent suites, production build, known TypeScript baseline, and
  ignored final report are refreshed on the final commit.
