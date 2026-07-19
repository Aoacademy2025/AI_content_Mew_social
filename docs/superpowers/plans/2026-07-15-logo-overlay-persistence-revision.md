# Logo Overlay Persistence Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Editor v2 draft persistence durable against late/out-of-order PATCHes and couple logo asset cleanup to actual completion of the relevant project save lane.

**Architecture:** Add a monotonic `draftRevision` compare-and-set boundary to `EditorProject`, then make one shared client coordinator allocate revisions, time out stuck requests, and expose per-project idleness across remounts. Bootstrap waits for that lane before reading server state; cleanup waits for the same lane after the existing debounce window before asking the authoritative server to delete an unreferenced asset.

**Tech Stack:** Prisma/SQLite, Next.js route handlers, TypeScript, React hooks, Node `assert` verifier scripts.

## Global Constraints

- Keep the approved malformed-logo export fix unchanged.
- Preserve the one-second draft debounce and new-project/default-logo semantics.
- Existing project callers without a revision and old rows with revision `0` remain compatible.
- Never rely on AbortController alone for ordering; the server revision check is authoritative.
- Same-project work is ordered; different projects never block one another.
- Cleanup remains fail-open for UX and never bypasses server 409 reference protection.
- Use `apply_patch` for every repository edit and create narrow commits.
- If implementation exposes another distinct coupling failure, stop instead of layering a third timing patch.

---

### Task 1: Durable monotonic draft revision

**Files:**

- Modify: `prisma/schema.prisma`
- Modify: `src/lib/editor-projects.ts`
- Modify: `src/app/api/editor-projects/[id]/route.ts`
- Modify: `scripts/verify-editor-projects.ts`
- Modify: `scripts/verify-logo-project-default.ts`

**Interfaces:**

- Produces `EditorProject.draftRevision Int @default(0)` and includes `draftRevision` in create/GET/PATCH response objects.
- Extends `updateEditorProject(..., { draftRevision?: unknown })` so a supplied positive integer revision is accepted only when `stored draftRevision < supplied revision`; an existing row that fails the condition throws `code: "stale_revision"` without mutation.
- Keeps revision-less calls on the existing compatibility path.
- PATCH forwards an own `draftRevision` property and maps stale/invalid revisions to explicit 409/400 responses.

- [ ] **Step 1: Write the failing database/API contract**

Extend `scripts/verify-editor-projects.ts` to assert revision `0` on create/read; apply revision 2 before delayed revision 1 and prove revision 1 cannot overwrite; race equal revisions and prove one acceptance; retry at revision 3 and prove it wins; then perform a revision-less metadata update and prove existing behavior remains.

- [ ] **Step 2: Run the verifier to observe RED**

Run: `npx tsx scripts/verify-editor-projects.ts`

Expected: failure because `draftRevision` is absent and conditional stale protection does not exist.

- [ ] **Step 3: Add the schema and atomic service contract**

Add `draftRevision Int @default(0)`. Parse supplied revisions as positive safe integers within Prisma `Int`; include `draftRevision` in the update data and add `draftRevision: { lt: supplied }` to the same `updateMany` predicate. If the conditional update affects zero rows, distinguish missing ownership from a stale existing row without performing a write.

- [ ] **Step 4: Wire and map the PATCH contract**

Forward only an own `draftRevision` field. Return 409 `{ error: "stale_revision", project }` for a stale existing project and 400 `{ error: "invalid_draft_revision" }` for invalid supplied revisions. Preserve current 404 and revision-less responses.

- [ ] **Step 5: Verify GREEN and adjacent no-logo behavior**

Run:

```bash
npx tsx scripts/verify-editor-projects.ts
npx tsx scripts/verify-logo-project-default.ts
```

Expected: both pass, including legacy/no-logo draft behavior.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma src/lib/editor-projects.ts 'src/app/api/editor-projects/[id]/route.ts' scripts/verify-editor-projects.ts scripts/verify-logo-project-default.ts
git commit -m "fix: reject stale editor draft revisions"
```

---

### Task 2: Timeout-safe shared save lanes and bootstrap

**Files:**

- Modify: `src/lib/editor-project-save-queue.ts`
- Modify: `src/app/(dashboard)/video-editor/_v2/useV2Project.ts`
- Modify: `scripts/verify-editor-project-save-queue.ts`
- Modify: `scripts/verify-logo-project-default.ts`

**Interfaces:**

- The shared coordinator exposes `seedRevision(projectId, revision)`, `enqueue({ projectId, save, ... })`, `whenIdle(projectId)`, and a lane-count inspection seam for deterministic verification.
- `save` receives `{ revision, signal }`; the queue allocates a strictly increasing per-project revision above every observed server revision.
- Default request timeout is 10 seconds. Timeout aborts the fetch and releases the lane; a late server request remains harmless because Task 1 rejects its lower revision.
- Idle lanes discard request/draft/observer closures while retaining only the numeric revision watermark needed for later allocations.

- [ ] **Step 1: Extend the pure queue verifier for RED**

Add deterministic timer seams. Cover a never-settling A timing out so latest B starts; late A completion after B; revision seeding across remount; error followed by a newer retry revision; separate project lanes; idle lane eviction; and same-project bootstrap waiting for lane idle before GET/apply.

- [ ] **Step 2: Run the queue verifier to observe RED**

Run: `npx tsx scripts/verify-editor-project-save-queue.ts`

Expected: failures for timeout, seed/watermark, eviction, and bootstrap source contracts.

- [ ] **Step 3: Implement timeout, revision watermarks, and eviction**

Race every save against the injected/default timeout, abort at timeout, consume late promise rejection, and continue draining the coalesced latest request. Allocate revisions per project from `max(observed watermark, last allocated) + 1`. Remove the idle lane after resolving waiters so request closures are released.

- [ ] **Step 4: Integrate revisioned PATCH and safe bootstrap**

Send `{ draftRevision: revision }` with each PATCH and pass the coordinator signal to `fetch`. Seed revision `0` from POST and the returned revision from GET. For an existing project, await `whenIdle(existingProjectId)` before issuing GET; apply only the post-idle server response, then seed its revision. Keep `buildDraft()` inside the one-second timer and retain existing retry/new-project behavior.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx tsx scripts/verify-editor-project-save-queue.ts
npx tsx scripts/verify-editor-projects.ts
npx tsx scripts/verify-logo-project-default.ts
```

Expected: all pass; a timed-out A cannot overwrite B and stale bootstrap data is not requeued.

- [ ] **Step 6: Commit**

```bash
git add src/lib/editor-project-save-queue.ts 'src/app/(dashboard)/video-editor/_v2/useV2Project.ts' scripts/verify-editor-project-save-queue.ts scripts/verify-logo-project-default.ts
git commit -m "fix: make editor save lanes revision aware"
```

---

### Task 3: Couple asset cleanup to project lane idleness

**Files:**

- Modify: `src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor.ts`
- Modify: `scripts/verify-logo-client-contract.ts`

**Interfaces:**

- `scheduleLogoAssetCleanup(assetId, projectId, dependencies?)` waits until the debounce has had time to enqueue, then awaits the actual shared `whenIdle(projectId)` signal before DELETE.
- DELETE retry remains bounded and is limited to network rejection, 429, 5xx, and a rare post-idle 409 race.

- [ ] **Step 1: Replace timing-only cleanup checks with RED coordination checks**

Use the real queue factory plus a virtual scheduler. Assert that cleanup scheduled after the debounce does not DELETE while a PATCH is pending at virtual 8 seconds or just below the 10-second timeout, then succeeds immediately after lane idle. Cover timeout release, remount survival, transient response retry, and continuing 409 for default/other-project references.

- [ ] **Step 2: Run the client verifier to observe RED**

Run: `npx tsx scripts/verify-logo-client-contract.ts`

Expected: failure because cleanup does not accept a project id or await the project lane.

- [ ] **Step 3: Integrate the shared idle signal**

Keep the 1,100 ms initial detached schedule, call the injected/shared `whenIdle` before the first DELETE, pass the current project id from replacement/removal call sites, and retain a small finite retry path only for genuine transient outcomes.

- [ ] **Step 4: Verify GREEN and server protection**

Run:

```bash
npx tsx scripts/verify-logo-client-contract.ts
npx tsx scripts/verify-brand-assets.ts
npx tsx scripts/verify-brand-asset-api.ts
```

Expected: cleanup waits for long saves, transient retries work, and authoritative persistent 409 protection remains.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor.ts' scripts/verify-logo-client-contract.ts
git commit -m "fix: wait for project saves before logo cleanup"
```

---

### Task 4: Fresh full verification and report

**Files:**

- Modify ignored report: `.superpowers/sdd/logo-overlay-final-fix-report.md`

- [ ] **Step 1: Run the fresh feature and adjacent suites**

Create a fresh disposable SQLite database, run all Logo Overlay verifiers including the new queue verifier, then run editor-project, billing, media-reference, and cleanup-mode adjacent verifiers.

- [ ] **Step 2: Generate, build, and type-check**

Run `npx prisma generate`, `npm run build`, and `npx tsc --noEmit`. Accept only the documented unrelated checkout error at `src/app/api/payments/checkout/route.ts:129`.

- [ ] **Step 3: Update the ignored evidence report**

Record the revised root causes, exact RED/GREEN observations, commits, fresh test outcomes, build outcome, and known TypeScript baseline. Confirm the QA server was not stopped.

- [ ] **Step 4: Inspect final repository state**

Run `git diff --check`, `git status --short`, and `git log --oneline --max-count=8`. Expected: no uncommitted tracked implementation changes and only the in-scope narrow commits after the approved export fix.
