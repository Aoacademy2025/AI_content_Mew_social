# Editor Draft Bootstrap Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the final revision-less write, timeout/remount recovery, existing-project bootstrap failure, and non-object PATCH repros without changing local-storage format.

**Architecture:** Advance every draft mutation through the same atomic server revision boundary. Expose the shared queue's per-project watermark and add a pure bootstrap resolver that selects server, valid local recovery, or explicit error; keep React responsible only for applying that outcome, tracking local edits while unready, and invoking the existing retry action.

**Tech Stack:** TypeScript, React 19 hooks, Next.js route handlers, Prisma/SQLite, Node `assert` verification scripts.

## Global Constraints

- Keep the approved malformed-logo export and cleanup behavior unchanged.
- Recovery is module-remount only, using the existing `editor-v2-project` draft and `editor-v2-project-id`; add no storage envelope or migration.
- Never apply server state older than the queue watermark.
- Missing, empty, array, primitive, or corrupt local recovery data cannot become an empty/default recovery draft.
- Existing-id network/non-404 failures never create another project.
- While an existing project is unready, local edits persist locally but never produce PATCH or `saved` status.
- Keep the route module export-safe.
- Stop and report if a distinct persistence coupling failure appears beyond the four specified repros.

---

### Task 1: Atomic compatibility revisions and PATCH body validation

**Files:**

- Modify: `scripts/verify-editor-projects.ts`
- Modify: `src/lib/editor-projects.ts`
- Modify: `src/lib/editor-project-patch.ts`
- Modify: `src/app/api/editor-projects/[id]/route.ts`

**Interfaces:**

- `updateEditorProject` increments `draftRevision` in the same `updateMany` whenever `draft` is present without `draftRevision`.
- Metadata-only revision-less updates leave `draftRevision` unchanged.
- `patchEditorProjectForUser(userId, id, body: unknown)` returns 400 `no_fields` unless `body` is a non-null, non-array object.

- [ ] **Step 1: Write the failing service/API regressions**

Extend the verifier with this exact sequence and assertions:

```ts
await updateWithRevision(userId, id, { draft: { script: "issued rev2" }, draftRevision: 2 });
const legacy = await projects.updateEditorProject(userId, id, { draft: { script: "legacy newer" } });
ok(legacy?.draftRevision === 3, "revision-less draft write atomically increments revision");
await assertRejectsCode(
  () => updateWithRevision(userId, id, { draft: { script: "late issued rev3" }, draftRevision: 3 }),
  "stale_revision",
);
```

Also race two revision-less draft updates and assert both succeed, the final revision
advances by exactly two, and the stored draft is one of the two concurrent writes;
prove a metadata-only update does not increment. (The compatibility response performs
a read after its atomic update, so concurrent callers are not required to observe
distinct intermediate revisions.) Call `patchEditorProjectForUser` with `null`, `[]`,
a string, and a number and require 400 `{error:"no_fields"}`.

- [ ] **Step 2: Run RED**

Run: `npx tsx scripts/verify-editor-projects.ts`

Expected: legacy draft remains revision 2; late revision 3 is accepted; non-object bodies throw or return 500-equivalent behavior.

- [ ] **Step 3: Implement the minimal atomic server behavior**

When `"draft" in input && draftRevision === undefined`, set:

```ts
data.draftRevision = { increment: 1 };
```

Update the local Prisma data type to accept `number | { increment: number }`. Keep the supplied-revision predicate unchanged. Validate `body` in `editor-project-patch.ts` before property inspection; change the route's parsed JSON variable to `unknown` and pass it unchanged to the adjacent seam.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
npx tsx scripts/verify-editor-projects.ts
npx tsx scripts/verify-logo-project-default.ts
git diff --check
```

Commit:

```bash
git add scripts/verify-editor-projects.ts src/lib/editor-projects.ts src/lib/editor-project-patch.ts 'src/app/api/editor-projects/[id]/route.ts'
git commit -m "fix: advance revisions for legacy draft writes"
```

---

### Task 2: Queue watermark and pure bootstrap resolution

**Files:**

- Create: `src/lib/editor-project-bootstrap.ts`
- Modify: `src/lib/editor-project-save-queue.ts`
- Modify: `scripts/verify-editor-project-save-queue.ts`

**Interfaces:**

- Queue adds `revisionWatermark(projectId: string): number` without creating a lane.
- `isEditorProjectRecoveryDraft(value)` accepts only non-empty, non-null, non-array objects.
- `resolveEditorProjectBootstrap(input)` returns one of:

```ts
{ kind: "server"; project: EditorProjectBootstrapProject }
{ kind: "local"; project: EditorProjectBootstrapProject; draft: Record<string, unknown> }
{ kind: "error"; recoveryDraft: Record<string, unknown> | null }
{ kind: "missing" }
```

It receives an injected `loadProject` so network, non-404, missing, stale, and retry behavior remain deterministic.

- [ ] **Step 1: Write the failing queue/bootstrap regressions**

Require watermark zero for an unseen project, one after timeout revision 1, and two after recovery enqueue. Simulate both server completion orders:

```text
A rev1 times out -> GET returns server rev0 -> valid local user-new -> enqueue B rev2
A writes rev1 then B writes rev2 => final user-new rev2
B writes rev2 then late A CAS fails => final user-new rev2
```

Require `serverRevision < watermark` plus missing/corrupt/empty local data to return `error`. Require network and non-404 loader failures to return `error` with the valid local recovery draft, while 404 returns `missing`. Require `localDirty=true` to select local even when server revision equals/exceeds the watermark.

- [ ] **Step 2: Run RED**

Run: `npx tsx scripts/verify-editor-project-save-queue.ts`

Expected: queue has no watermark accessor and the bootstrap resolver module is absent.

- [ ] **Step 3: Implement the pure boundary**

Return `revisionWatermarks.get(normalizedProjectId(projectId)) ?? 0` from the queue accessor. In the resolver, catch loader errors; distinguish 404; validate project id/revision; then choose local when `serverRevision < watermark || localDirty`, error if that choice lacks valid recovery, otherwise server.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
npx tsx scripts/verify-editor-project-save-queue.ts
npx tsx scripts/verify-editor-projects.ts
git diff --check
```

Commit:

```bash
git add src/lib/editor-project-bootstrap.ts src/lib/editor-project-save-queue.ts scripts/verify-editor-project-save-queue.ts
git commit -m "fix: resolve stale project bootstrap from local draft"
```

---

### Task 3: Existing-project error, local edits, and Retry integration

**Files:**

- Modify: `src/app/(dashboard)/video-editor/_v2/useV2Project.ts`
- Modify: `scripts/verify-logo-project-default.ts`

**Interfaces:**

- Existing-project bootstrap applies only a local draft associated by the existing `PROJECT_ID_KEY`.
- `bootstrapRetryRevision` reruns existing-project bootstrap.
- `bootstrapLocalDirtyRef` records a debounced user edit while an existing project is unready.
- `retryProjectSave()` increments bootstrap retry while unready and save retry while ready.

- [ ] **Step 1: Write failing hook integration contracts**

Extend the default verifier to require:

```text
valid associated local draft is applied before waiting/GET
resolveEditorProjectBootstrap receives queue watermark and localDirty
error outcome sets project id, projectReady false, saveStatus error, and returns
non-404/network path cannot reach account default or POST
unready existing-project persistence writes local only, marks dirty, and never sets saved/PATCHes
retry increments bootstrap retry when unready
local outcome applies local, seeds server revision, and becomes ready so next debounce enqueues next revision
```

Add negative source checks preventing `setSaveStatus("saved")` in the unready existing-project branch and preventing new-project creation from the resolver's `error` outcome.

- [ ] **Step 2: Run RED**

Run: `npx tsx scripts/verify-logo-project-default.ts`

Expected: bootstrap resolver, explicit error state, dirty tracking, and retry routing are absent.

- [ ] **Step 3: Implement minimal hook orchestration**

Parse local storage conservatively. Associate recovery only when stored and requested project ids match. Apply valid associated local state before awaiting the lane. Resolve GET through the pure boundary. For `error`, keep id/unready/error and return. For `local`, apply recovery and set ready after seeding server revision. For `server`, apply server and set ready. For `missing`, clear the existing-bootstrap marker and use the unchanged new-project path.

In the persistence timer, if an existing id is unready: skip the first hydration write; on later edits write local, mark dirty, preserve error/saving, and return before enqueue. Route Retry with a `projectReadyRef`.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
npx tsx scripts/verify-logo-project-default.ts
npx tsx scripts/verify-editor-project-save-queue.ts
npx tsx scripts/verify-logo-client-contract.ts
git diff --check
```

Commit:

```bash
git add 'src/app/(dashboard)/video-editor/_v2/useV2Project.ts' scripts/verify-logo-project-default.ts
git commit -m "fix: preserve local edits through bootstrap retry"
```

---

### Task 4: Final verification and ignored report

**Files:**

- Modify ignored: `.superpowers/sdd/logo-overlay-final-fix-report.md`

**Interfaces:** None.

- [ ] **Step 1: Run fresh focused and full verification**

Generate Prisma, create a fresh disposable SQLite database, and run the 9 logo suites plus editor projects, render billing, clip charge, media reference graph, and cleanup mode. Run `npm run build`, `npx tsc --noEmit --pretty false`, and `git diff --check`.

- [ ] **Step 2: Confirm the known type baseline**

Expected TypeScript output is exactly the unrelated `src/app/api/payments/checkout/route.ts:129` optional `ref_code` / `MetadataParam` error. Any touched-file error must be fixed through its own failing regression before completion.

- [ ] **Step 3: Refresh the ignored report**

Record exact RED failures, commit hashes, final disposable database, suite counts, build result, type baseline, clean tracked status, and that the QA server was not stopped.

- [ ] **Step 4: Final tracked-state check**

Run:

```bash
git status --short
git diff --check
git log --oneline -8
```

Expected: clean tracked status; only the ignored report is untracked from Git's perspective.
