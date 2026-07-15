# Editor Release-Blocker Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent cross-tab Editor v2 autosave data loss, make ambiguous conflict recovery retryable, stop stale logo-upload mutations, and close the concurrent account-deletion file race without a database migration.

**Architecture:** Add a strict pure lineage decision layer and extend the existing per-project save queue with backward-compatible structured outcomes plus bounded reconciliation. Editor v2 sends observed-revision CAS for every autosave and blocks into the existing immutable conflict flow when lineage cannot be proved. Separate generation/abort ownership protects logo uploads, while account deletion removes the exact server-controlled user directory after the database delete.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Prisma/SQLite, Radix AlertDialog, existing `tsx` verifiers, dependency-free hook harnesses, esbuild/Puppeteer Chromium checks.

## Global Constraints

- Approved design is the source of truth: `docs/superpowers/specs/2026-07-15-editor-release-blocker-remediation-design.md`.
- No database schema or migration is added.
- Existing non-v2 and revision-less editor-project callers remain backward compatible.
- Every Editor v2 autosave is conditional on a server revision that this tab actually observed or safely acknowledged through an immutable same-lane snapshot.
- Revision numbers alone never prove lineage.
- Ambiguous outcomes are reconciled before the save lane starts another network write.
- An unprovable outcome blocks the editor and requires explicit conflict resolution.
- Programmatic hydration still cannot create recovery provenance.
- Logo upload completion can mutate only the project/request generation that started it.
- Account deletion removes only the server-controlled directory for the exact user id.
- Add no new test framework or runtime dependency.
- The only accepted typecheck failure remains `src/app/api/payments/checkout/route.ts:129` (`ref_code` versus Stripe `MetadataParam`).
- Each task uses RED → GREEN, commits narrowly, and receives an independent spec/code-quality review before the next task.
- Do not merge, deploy, push, or use production data.

## File and Responsibility Map

| Responsibility | Files |
|---|---|
| Strict draft materialization, fingerprint, lineage decision | `src/lib/editor-project-recovery-journal.ts`, `src/lib/editor-project-autosave-lineage.ts`, `scripts/verify-editor-project-autosave-lineage.ts` |
| Structured save outcomes, bounded reconciliation, lane blocking | `src/lib/editor-project-save-queue.ts`, `scripts/verify-editor-project-save-queue.ts` |
| Editor v2 CAS orchestration and two-client runtime behavior | `src/app/(dashboard)/video-editor/_v2/useV2Project.ts`, `scripts/editor-project-recovery-hook-runtime-harness.ts`, `scripts/verify-editor-project-recovery-hook.ts`, `scripts/verify-editor-projects.ts`, `scripts/verify-logo-project-default.ts` |
| GET-only conflict retry UI | `src/app/(dashboard)/video-editor/_v2/EditorProjectRecoveryDialog.tsx`, `src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx`, `scripts/verify-editor-project-conflict-ui.ts` |
| Project/request-scoped logo upload | `src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor.ts`, `scripts/logo-overlay-editor-runtime-harness.ts`, `scripts/verify-logo-client-contract.ts` |
| Concurrent-safe account asset deletion | `src/lib/brand-assets.server.ts`, `src/lib/account-hard-delete.server.ts`, `scripts/verify-brand-assets.ts`, `scripts/verify-brand-asset-api.ts` |
| Final regression/review/QA evidence | `.superpowers/sdd/editor-release-blocker-final-report.md` (ignored) |

---

### Task 1: Add strict autosave snapshot and lineage decisions

**Files:**

- Modify: `src/lib/editor-project-recovery-journal.ts`
- Create: `src/lib/editor-project-autosave-lineage.ts`
- Create: `scripts/verify-editor-project-autosave-lineage.ts`

**Interfaces:**

```ts
export function materializeEditorProjectDraft(value: unknown): EditorProjectDraft | null;

export type EditorProjectAutosaveCandidate = {
  projectId: string;
  revision: number;
  draft: EditorProjectDraft;
  fingerprint: string;
};

export type EditorProjectAutosaveSnapshot = EditorProjectAutosaveCandidate & {
  expectedDraftRevision: number;
};

export type EditorProjectAutosaveObservationDecision =
  | { kind: "saved"; confirmed: EditorProjectAutosaveCandidate }
  | { kind: "retry"; confirmed: EditorProjectAutosaveCandidate }
  | { kind: "conflict"; server: EditorProjectAutosaveCandidate };

export function createEditorProjectAutosaveCandidate(input: {
  projectId: string;
  revision: number;
  draft: unknown;
}): EditorProjectAutosaveCandidate | null;

export function createEditorProjectAutosaveSnapshot(input: {
  projectId: string;
  expectedDraftRevision: number;
  revision: number;
  draft: unknown;
}): EditorProjectAutosaveSnapshot | null;

export function decideEditorProjectAutosaveObservation(input: {
  attempt: EditorProjectAutosaveSnapshot;
  confirmed: EditorProjectAutosaveCandidate;
  issued: ReadonlyMap<number, EditorProjectAutosaveCandidate>;
  observed: EditorProjectAutosaveCandidate;
}): EditorProjectAutosaveObservationDecision;
```

- [ ] **Step 1: Write strict materialization and fingerprint RED tests**

Add verifier cases proving that reordered object keys produce the same fingerprint,
array order remains significant, and nested input mutation cannot change a candidate.
Reuse the journal attack matrix for accessors, inherited properties, class instances,
cycles, sparse/extended arrays, symbols, `undefined`, bigint, and non-finite numbers.

- [ ] **Step 2: Write lineage-decision RED tests**

Cover these exact decisions:

```ts
assert.equal(decide({ attempt: rev1A, confirmed: rev0, issued, observed: rev1A }).kind, "saved");
assert.equal(decide({ attempt: rev1A, confirmed: rev0, issued, observed: rev0 }).kind, "retry");
assert.equal(decide({ attempt: rev2B, confirmed: rev0, issued: new Map([[1, rev1A]]), observed: rev1A }).kind, "retry");
assert.equal(decide({ attempt: rev1B, confirmed: rev0, issued: new Map([[1, rev1B]]), observed: rev1A }).kind, "conflict");
```

Also reject project mismatch, invalid revisions, an attempt revision not above its
expected revision, and an issued map whose key disagrees with its candidate revision.

- [ ] **Step 3: Run RED**

Run:

```bash
npx tsx scripts/verify-editor-project-autosave-lineage.ts
```

Expected: exit 1 because the autosave lineage module/export does not exist.

- [ ] **Step 4: Export the existing strict draft materializer**

Rename the private journal `materializeDraft` function to
`materializeEditorProjectDraft`, export it, and keep
`parseEditorProjectRecoveryJournal` calling the same function. Do not weaken any
journal validation.

- [ ] **Step 5: Implement deterministic prototype-safe fingerprints and decisions**

Materialize before fingerprinting. Recursively sort object keys, preserve array order,
and serialize only the strict JSON graph. Validate project ids and revisions in every
public constructor. The decision order is current-attempt match → confirmed revision
unchanged → matching known issued revision/fingerprint → conflict.

- [ ] **Step 6: Prove mutation sensitivity**

Run controlled source mutations that make numeric revision alone count as a known
snapshot and that make object insertion order affect the fingerprint. Both must make
the verifier exit nonzero; restore production source afterward.

- [ ] **Step 7: Run GREEN and regressions**

```bash
npx tsx scripts/verify-editor-project-autosave-lineage.ts
npx tsx scripts/verify-editor-project-recovery.ts
npx tsc --noEmit --pretty false
```

Expected: both verifiers pass; typecheck has only the documented checkout baseline.

- [ ] **Step 8: Commit**

```bash
git add src/lib/editor-project-recovery-journal.ts src/lib/editor-project-autosave-lineage.ts scripts/verify-editor-project-autosave-lineage.ts
git commit -m "feat: add editor autosave lineage decisions"
```

---

### Task 2: Make save-queue reconciliation bounded and blocking

**Files:**

- Modify: `src/lib/editor-project-save-queue.ts`
- Modify: `scripts/verify-editor-project-save-queue.ts`

**Interfaces:**

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

- [ ] **Step 1: Extend verifier types and add RED outcome cases**

Add deterministic fake-timer cases proving:

- legacy booleans preserve existing behavior;
- `{kind:"ambiguous"}` invokes `reconcile` before pending B starts;
- primary timeout aborts PATCH and invokes reconciliation with a fresh non-aborted signal;
- a legacy timeout/ambiguous result without `reconcile` keeps the existing error-and-
  continue behavior;
- reconciliation timeout produces one `onBlocked`, drops B without calling B.save, and releases `whenIdle`;
- `{kind:"blocked"}` drops pending work immediately;
- only latest UI status publishes, while reconciliation still completes;
- late primary resolution/rejection after timeout is consumed and cannot publish status.

- [ ] **Step 2: Run RED**

```bash
npx tsx scripts/verify-editor-project-save-queue.ts
```

Expected: exit 1 because structured outcomes/reconciliation are unsupported.

- [ ] **Step 3: Normalize boolean and structured outcomes**

Add a single normalization seam: `true → saved`, `false → error`; reject malformed
objects as `error`. Preserve all existing public methods.

- [ ] **Step 4: Add two bounded phases**

The primary save and optional reconciliation each get their own AbortController and
the configured `requestTimeoutMs`. Primary `ambiguous` or timeout enters reconciliation
when supplied; without it, preserve the legacy error-and-continue behavior.
Reconciliation `ambiguous`, `error`, `blocked`, throw, or timeout becomes blocked.
No pending request starts between phases.

- [ ] **Step 5: Block and drain safely**

On blocked outcome, clear `lane.pending`, publish latest `error`, call `onBlocked` once
when active, then release the lane and idle waiters. Do not lower revision watermarks.

- [ ] **Step 6: Mutation checks**

Mutate the queue to start pending B before reconciliation and to retain pending B after
blocked. Each mutant must fail a deterministic assertion.

- [ ] **Step 7: Run GREEN and adjacent contracts**

```bash
npx tsx scripts/verify-editor-project-save-queue.ts
npx tsx scripts/verify-logo-client-contract.ts
npx tsx scripts/verify-editor-project-recovery-hook.ts
npx tsc --noEmit --pretty false
```

- [ ] **Step 8: Commit**

```bash
git add src/lib/editor-project-save-queue.ts scripts/verify-editor-project-save-queue.ts
git commit -m "feat: reconcile ambiguous editor save lanes"
```

---

### Task 3: Bind every Editor v2 autosave to observed server state

**Files:**

- Modify: `src/app/(dashboard)/video-editor/_v2/useV2Project.ts`
- Modify: `scripts/editor-project-recovery-hook-runtime-harness.ts`
- Modify: `scripts/verify-editor-project-recovery-hook.ts`
- Modify: `scripts/verify-editor-projects.ts`
- Modify: `scripts/verify-logo-project-default.ts`

**Interfaces:**

- `saveEditorProjectDraft` sends `expectedDraftRevision` and returns a structured
  attempt result without mutating queue watermarks on 409.
- The hook owns project-scoped confirmed/issued/latest-local lineage refs from Task 1.
- `EditorProjectRecoveryState.conflict` adds `requiresServerRefresh: boolean` and
  accepts `resolving: false | "local" | "server" | "refresh"`.
- The hook returns `retryConflictServerRefresh(): Promise<void>` for Task 4.

- [ ] **Step 1: Add the two-client Critical reproduction first**

Extend the runtime hook harness with two independent hook clients sharing one mocked
server:

1. both GET revision 0;
2. A explicit edit PATCHes revision 1 with `expectedDraftRevision:0` and wins;
3. B explicit edit PATCHes revision 1 with `expectedDraftRevision:0` and receives 409;
4. B Retry/next edit may not send an advancing PATCH;
5. B reaches blocking conflict with immutable latest local B and server A.

Assert every Editor v2 autosave PATCH contains integer `expectedDraftRevision` and
`draftRevision > expectedDraftRevision`.

- [ ] **Step 2: Add timeout lineage RED cases**

Runtime cases must cover:

- timeout committed: GET matches the issued revision/fingerprint and counts as saved;
- timeout not committed: GET remains at confirmed base and one CAS retry succeeds;
- another tab occupies the same numeric revision with different content: conflict;
- intermediate A acknowledgement updates the confirmed base before coalesced B starts;
- reconciliation pending means B has zero PATCH calls;
- project switch/Reset/unmount ignores late PATCH/GET callbacks.

- [ ] **Step 3: Correct the service-verifier safety story**

Replace the blind `retry with a newer revision succeeds` scenario with:

```ts
await assert.rejects(
  updateWithRevision(userId, projectId, {
    draft: losingDraft,
    draftRevision: 2,
    expectedDraftRevision: 0,
  }),
  hasCode("stale_revision"),
);
```

Then GET the winning revision and prove an explicitly observed conditional update can
succeed. Keep one clearly labelled legacy revision-only compatibility test elsewhere.

- [ ] **Step 4: Run RED**

```bash
npx tsx scripts/verify-editor-project-recovery-hook.ts
DATABASE_URL=file:/tmp/heroai-editor-cas-red.db npx tsx scripts/verify-editor-projects.ts
```

Expected: the hook verifier fails because ordinary autosave omits expected revision
and seeds the winner watermark on 409.

- [ ] **Step 5: Initialize/reset lineage at every ownership boundary**

On existing GET, POST creation, explicit local/server choice, Reset, project switch,
and unmount, create or invalidate the project-scoped tracker. Store the last validated
server candidate, not only its number. Set the blocked flag synchronously before any
conflict state update.

- [ ] **Step 6: Capture latest local and dispatch snapshots**

At the autosave effect activation, before scheduling the one-second debounce,
materialize the immutable latest explicit-user draft and update the latest-local ref.
This ensures an in-flight older request cannot surface a conflict that omits a newer
edit still inside the debounce window. Inside the queue `save` callback, read the current confirmed base,
construct/register the issued snapshot with the allocated revision, and PATCH both
revisions. Pending callbacks must return `{kind:"blocked"}` without fetch once the
tracker is blocked.

- [ ] **Step 7: Apply definite acknowledgements immediately**

Validate the response project/candidate and signal ownership. Update confirmed
candidate/issued lineage inside the save/reconcile path for every acknowledged request,
not only in latest `onStatus`. Keep latest-only journal clearing and visible save status.

- [ ] **Step 8: Implement one-cycle authoritative reconciliation**

On network ambiguity or queue timeout, GET with `cache:"no-store"`, call Task 1's pure
decision, and either acknowledge, retry the same immutable attempt once with the
decision's confirmed revision, or materialize conflict. A second ambiguous result sets
`requiresServerRefresh:true` and returns blocked. Never seed a server revision solely
because a 409 payload contains a higher number.

- [ ] **Step 9: Materialize conflicts from latest local**

Use the latest immutable explicit-user candidate and validated server candidate,
preserve the journal, set `projectReady:false`, and enter conflict. Drop pending lane
writes through Task 2's blocked outcome. Use local/server choice to reset lineage only
after explicit resolution.

- [ ] **Step 10: Add mutation sensitivity**

Required rejected mutants:

- remove `expectedDraftRevision` from autosave body;
- replace fingerprint match with numeric-only match;
- update confirmed only in `onStatus`;
- seed watermark and continue after 409;
- allow pending fetch while blocked.

- [ ] **Step 11: Run GREEN and focused regressions**

```bash
npx tsx scripts/verify-editor-project-autosave-lineage.ts
npx tsx scripts/verify-editor-project-save-queue.ts
npx tsx scripts/verify-editor-project-recovery-hook.ts
DATABASE_URL=file:/tmp/heroai-editor-cas-green.db npx tsx scripts/verify-editor-projects.ts
npx tsx scripts/verify-logo-project-default.ts
npx tsx scripts/verify-logo-client-contract.ts
npm run build
npx tsc --noEmit --pretty false
```

- [ ] **Step 12: Commit**

```bash
git add 'src/app/(dashboard)/video-editor/_v2/useV2Project.ts' scripts/editor-project-recovery-hook-runtime-harness.ts scripts/verify-editor-project-recovery-hook.ts scripts/verify-editor-projects.ts scripts/verify-logo-project-default.ts
git commit -m "fix: bind editor autosaves to observed revisions"
```

---

### Task 4: Add GET-only retry to the blocking conflict dialog

**Files:**

- Modify: `src/app/(dashboard)/video-editor/_v2/EditorProjectRecoveryDialog.tsx`
- Modify: `src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx`
- Modify: `scripts/verify-editor-project-conflict-ui.ts`
- Modify: `scripts/editor-project-recovery-hook-runtime-harness.ts`
- Modify: `scripts/verify-editor-project-recovery-hook.ts`

**Interfaces:**

```ts
export function EditorProjectRecoveryDialog(props: {
  recovery: EditorProjectRecoveryState;
  onRetryLoad: () => void;
  onRetryConflictRefresh: () => Promise<void>;
  onChooseLocal: () => Promise<void>;
  onChooseServer: () => void;
}): React.ReactNode;
```

- [ ] **Step 1: Write complete network-failure → retry RED runtime cases**

Drive an ambiguous local-choice PATCH, fail the authoritative GET, and assert:

- conflict remains open with identical local object identity;
- `resolving:false`, `requiresServerRefresh:true`;
- local/server choices disabled and no choice spinner runs;
- `ตรวจสอบเวอร์ชันล่าสุดอีกครั้ง` is enabled;
- repeated retry failures send GET only and remain retryable;
- successful retry replaces server only, clears the requirement, and enables choices;
- rapid double Retry starts one GET.

- [ ] **Step 2: Run RED**

```bash
npx tsx scripts/verify-editor-project-recovery-hook.ts
npx tsx scripts/verify-editor-project-conflict-ui.ts
```

Expected: missing retry handler/action and old permanently resolving state fail.

- [ ] **Step 3: Implement the hook retry action**

Reuse the authoritative refresh helper with generation/current-candidate guards. The
new action performs no PATCH, never changes local, and can be called repeatedly after
failure. Project change, Reset, and unmount invalidate it.

- [ ] **Step 4: Render the retry-only locked state**

When `requiresServerRefresh` is true, disable both choices independently of
`resolving`, render one full-width secondary action labelled exactly
`ตรวจสอบเวอร์ชันล่าสุดอีกครั้ง`, and show its spinner only for `resolving:"refresh"`.
Keep history/focus/inert/privacy/mobile safe-area contracts unchanged.

- [ ] **Step 5: Integrate exactly once in the shell**

Pass `p.retryConflictServerRefresh` to the single shared dialog. Do not add dialog
instances to desktop/mobile post phases.

- [ ] **Step 6: Mutation and GREEN checks**

Mutate Retry to call either choice/PATCH and mutate failed refresh back to
`resolving:"local"`; both must fail. Then run:

```bash
npx tsx scripts/verify-editor-project-recovery-hook.ts
npx tsx scripts/verify-editor-project-conflict-ui.ts
npx tsx scripts/verify-logo-client-contract.ts
npm run build
npx tsc --noEmit --pretty false
```

- [ ] **Step 7: Commit**

```bash
git add 'src/app/(dashboard)/video-editor/_v2/useV2Project.ts' 'src/app/(dashboard)/video-editor/_v2/EditorProjectRecoveryDialog.tsx' 'src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx' scripts/editor-project-recovery-hook-runtime-harness.ts scripts/verify-editor-project-recovery-hook.ts scripts/verify-editor-project-conflict-ui.ts
git commit -m "feat: add retryable editor conflict refresh"
```

---

### Task 5: Scope logo uploads to project/request ownership

**Files:**

- Modify: `src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor.ts`
- Create: `scripts/logo-overlay-editor-runtime-harness.ts`
- Modify: `scripts/verify-logo-client-contract.ts`

**Interfaces:**

- No public UI interface changes.
- The hook owns `currentProjectIdRef`, `uploadGenerationRef`, and
  `activeUploadControllerRef`.

- [ ] **Step 1: Build a dependency-free actual-hook runtime harness**

Transpile the production hook and supply the same minimal React dispatcher pattern as
the editor recovery harness. Mock storage/fetch/telemetry/cleanup and expose deferred
upload responses and project-prop rerenders.

- [ ] **Step 2: Write stale-upload RED cases**

Cover:

- project A upload resolves after rerender to B: zero B `onChange`, zero B asset
  mutation, zero previous-asset cleanup, zero success telemetry for B;
- unmount aborts upload and late resolution mutates nothing;
- second same-project upload aborts first; first `finally` cannot clear second saving;
- ordinary same-project success applies exactly once and retains replacement cleanup;
- stale success with a known newly-created asset may clean only that orphan using A.

- [ ] **Step 3: Run RED**

```bash
npx tsx scripts/verify-logo-client-contract.ts
```

Expected: project-A deferred completion currently invokes the shared B `onChange`.

- [ ] **Step 4: Add generation and AbortController ownership**

Invalidate synchronously on project change/unmount and before a newer upload. Capture
starting project/generation per call and check after every await and before every state,
callback, cleanup, or telemetry effect. A stale `finally` must not change current
saving state.

- [ ] **Step 5: Prove source mutations and run GREEN**

Remove the post-response ownership check and remove project-change abort; each mutation
must fail the runtime harness. Then run:

```bash
npx tsx scripts/verify-logo-client-contract.ts
npx tsx scripts/verify-logo-overlay.ts
npx tsx scripts/verify-editor-project-recovery-hook.ts
npm run build
npx tsc --noEmit --pretty false
```

- [ ] **Step 6: Commit**

```bash
git add 'src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor.ts' scripts/logo-overlay-editor-runtime-harness.ts scripts/verify-logo-client-contract.ts
git commit -m "fix: scope logo uploads to project generation"
```

---

### Task 6: Remove the exact account asset directory after deletion

**Files:**

- Modify: `src/lib/brand-assets.server.ts`
- Modify: `src/lib/account-hard-delete.server.ts`
- Modify: `scripts/verify-brand-assets.ts`
- Modify: `scripts/verify-brand-asset-api.ts`

**Interfaces:**

```ts
export async function removeBrandAssetDirectoryForUser(userId: string): Promise<void>;

export async function deleteUserAndBrandAssetDirectory(
  userId: string,
  dependencies: {
    deleteUser: (userId: string) => Promise<boolean>;
    removeUserDirectory: (userId: string) => Promise<void>;
    reportCleanupFailure: () => void;
  },
): Promise<boolean>;
```

- [ ] **Step 1: Write path-containment RED tests**

On a disposable asset root, require a valid exact-user directory to be removed
recursively. Reject empty, `.`, `..`, slash/backslash-separated, absolute, and sibling
escape ids without touching root/sibling sentinel files.

- [ ] **Step 2: Write barrier-controlled deletion RED tests**

Use a barrier-controlled orchestration seam plus real Prisma/filesystem operations:

- in the injected `deleteUser` dependency, create a new file after deletion has been
  requested but before it reports success; prove post-delete directory removal deletes
  that file and runs after the delete dependency;
- run the production wrapper against real Prisma with an existing user/file; row and
  directory disappear;
- start `saveBrandAsset` with a deferred `File.arrayBuffer()`, delete the user, then
  release the upload; its insert fails and no temporary/final file remains;
- create a safe orphan directory for an already missing user; hard-delete retry returns
  false but still removes the directory;
- admin and Clerk paths continue using the shared helper.

- [ ] **Step 3: Run RED**

```bash
rm -f /tmp/heroai-account-delete-race.db
rm -rf /tmp/heroai-account-delete-assets
DATABASE_URL=file:/tmp/heroai-account-delete-race.db BRAND_ASSET_ROOT=/tmp/heroai-account-delete-assets npx tsx scripts/verify-brand-asset-api.ts
```

Expected: the orchestration/directory exports do not exist and the idempotent orphan
directory case survives under the old pre-list implementation.

- [ ] **Step 4: Implement exact-user directory removal**

Validate a single basename user id, resolve `<root>/<userId>`, re-check strict root
containment, and call `rm(directory,{recursive:true,force:true})`. Never accept a
client path/storage key. Keep individual asset deletion behavior unchanged.

- [ ] **Step 5: Change hard delete ordering**

Implement `deleteUserAndBrandAssetDirectory` as a production orchestration boundary,
not a test-only branch. It awaits `deleteUser` first, then always awaits exact-user
directory removal even when the row was already absent, reports cleanup failure once,
and returns only the database deletion boolean. `hardDeleteUserWithBrandAssets` passes
the real Prisma/delete/filesystem/logging dependencies. Remove pre-listing and preserve
the existing public boolean meaning.

- [ ] **Step 6: Mutation and GREEN checks**

Move directory removal before DB delete and weaken basename validation; both mutants
must fail. Then run:

```bash
DATABASE_URL=file:/tmp/heroai-account-delete-race.db BRAND_ASSET_ROOT=/tmp/heroai-account-delete-assets npx tsx scripts/verify-brand-assets.ts
DATABASE_URL=file:/tmp/heroai-account-delete-race.db BRAND_ASSET_ROOT=/tmp/heroai-account-delete-assets npx tsx scripts/verify-brand-asset-api.ts
DATABASE_URL=file:/tmp/heroai-account-delete-race.db BRAND_ASSET_ROOT=/tmp/heroai-account-delete-assets npx tsx scripts/verify-logo-export.ts
DATABASE_URL=file:/tmp/heroai-account-delete-race.db npm run build
npx tsc --noEmit --pretty false
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/brand-assets.server.ts src/lib/account-hard-delete.server.ts scripts/verify-brand-assets.ts scripts/verify-brand-asset-api.ts
git commit -m "fix: close account brand asset deletion race"
```

---

### Task 7: Repeat the release gate and broad review

**Files:**

- Modify only if a regression is reproduced: Task 1–6 files.
- Update ignored evidence: `.superpowers/sdd/editor-release-blocker-final-report.md`

- [ ] **Step 1: Start clean**

```bash
git status --short
git diff --check
```

- [ ] **Step 2: Run the complete fresh-database feature suite**

```bash
rm -f /tmp/heroai-editor-release-final.db
rm -rf /tmp/heroai-editor-release-assets
DATABASE_URL=file:/tmp/heroai-editor-release-final.db npx prisma db push --skip-generate --accept-data-loss
npx tsx scripts/verify-editor-project-autosave-lineage.ts
npx tsx scripts/verify-editor-project-recovery.ts
npx tsx scripts/verify-editor-project-save-queue.ts
npx tsx scripts/verify-editor-project-recovery-hook.ts
npx tsx scripts/verify-editor-project-conflict-ui.ts
DATABASE_URL=file:/tmp/heroai-editor-release-final.db npx tsx scripts/verify-editor-projects.ts
npx tsx scripts/verify-logo-overlay.ts
DATABASE_URL=file:/tmp/heroai-editor-release-final.db BRAND_ASSET_ROOT=/tmp/heroai-editor-release-assets npx tsx scripts/verify-brand-assets.ts
DATABASE_URL=file:/tmp/heroai-editor-release-final.db BRAND_ASSET_ROOT=/tmp/heroai-editor-release-assets npx tsx scripts/verify-brand-asset-api.ts
npx tsx scripts/verify-logo-project-default.ts
DATABASE_URL=file:/tmp/heroai-editor-release-final.db BRAND_ASSET_ROOT=/tmp/heroai-editor-release-assets npx tsx scripts/verify-logo-export.ts
npx tsx scripts/verify-logo-render.ts
npx tsx scripts/verify-logo-client-contract.ts
npx tsx scripts/verify-mobile-sheet.ts
npx tsx scripts/verify-render-duration-bill.ts
npx tsx scripts/verify-clip-charge.ts
npx tsx scripts/verify-media-reference-graph.ts
npx tsx scripts/verify-media-cleanup-mode.ts
```

- [ ] **Step 3: Generate, build, and typecheck**

```bash
DATABASE_URL=file:/tmp/heroai-editor-release-final.db npx prisma generate
DATABASE_URL=file:/tmp/heroai-editor-release-final.db npm run build
npx tsc --noEmit --pretty false
```

- [ ] **Step 4: Replay release-blocker scenarios**

Record observed runtime output for the two-client stale autosave, all three timeout
lineage branches, GET-only repeated retry, stale project upload, and both account-delete
barriers. Source/AST contracts do not count as runtime evidence.

- [ ] **Step 5: Request independent merge-base-to-HEAD review**

Review against the Responsive Logo Overlay spec, conflict-resolution spec, and this
remediation spec. Fix every Critical/Important finding with a new RED regression and
re-review. Do not attempt a fourth speculative persistence patch; escalate a new
architecture failure.

- [ ] **Step 6: Refresh Tailscale QA handoff**

Restart the disposable `0.0.0.0:3007` server from current HEAD only after verifying
process ownership. Report Tailscale URL, branch/SHA, env-var names only, fixture scope,
and exact authenticated device/browser results. If no non-production authenticated
session exists, keep protected app QA explicitly environment-blocked.

- [ ] **Step 7: Finish without automatic integration**

Use `superpowers:verification-before-completion` and
`superpowers:finishing-a-development-branch`. Do not merge/deploy/push without the
user's explicit final selection.

---

## Plan Self-Review Coverage Map

- Critical two-tab overwrite: Tasks 1–3 and Task 7 runtime replay.
- Timeout committed/not committed/foreign same revision: Tasks 1–3.
- Intermediate acknowledgement under coalescing: Tasks 2–3.
- GET-only retryable fail-closed dialog: Task 4.
- Stale project upload and stale `finally`: Task 5.
- Concurrent account deletion and path containment: Task 6.
- Backward compatibility, full Logo Overlay/render/billing regressions: Task 7.
- Authenticated protected QA caveat: Task 7.
