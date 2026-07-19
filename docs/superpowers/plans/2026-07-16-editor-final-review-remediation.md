# Editor Final-Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the final whole-branch editor blockers without changing normal editor semantics: block input during project initialization, retain and atomically restore recoverable Logo assets, and harden conflict history/default-save async ownership.

**Architecture:** Project initialization becomes an explicit generation-owned lifecycle shared by the hook and shell. Brand assets use nullable retirement plus an optimistic lifecycle revision; project draft writes validate and restore an owned retired Logo in the same transaction as the project CAS. History and default-save fixes remain separate, independently reviewed lifecycle tasks.

**Tech Stack:** Next.js 15 App Router, React 19 hooks, TypeScript, Prisma 6/SQLite verifier fixtures, Node private filesystem storage, Puppeteer/esbuild runtime harnesses.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-16-editor-final-review-remediation-design.md` exactly.
- Use strict RED → verify RED → minimal GREEN → verify GREEN for every behavior change.
- Existing assets remain active: `retiredAt = null`, `lifecycleRevision = 0`.
- Retired Logo rows/files stay private and retained until account hard deletion; no purge or recycle-bin UI.
- A project draft must never commit a missing, cross-owner, or physically unavailable Logo id.
- A failed project CAS must not restore an asset; a failed asset lifecycle CAS must roll back the project write.
- Keep preview/export path containment and immutable staging unchanged.
- Preserve exact local conflict candidates and journals on recoverable failure.
- No raw asset id, Clerk id, email, local path, or storage key in new logs/telemetry.
- Keep the approved portable Linux/macOS filesystem trust boundary; no native addon.
- Preserve old editor, payment, admin boolean, webhook signature, media, and clip-charge contracts.
- Do not merge, push, deploy, or run a production schema change.

---

### Task 1: Own blank bootstrap and Reset initialization

**Files:**

- Modify: `src/app/(dashboard)/video-editor/_v2/useV2Project.ts`
- Modify: `src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx`
- Modify: `scripts/editor-project-recovery-hook-runtime-harness.ts`
- Modify: `scripts/verify-editor-project-recovery-hook.ts`
- Modify: `scripts/verify-editor-project-conflict-ui.ts`

**Interfaces:**

- Produces:

```ts
export type ProjectInitializationState =
  | "loading-defaults"
  | "creating-project"
  | "ready"
  | "error";

// Added to V2Project return value:
projectInitialization: ProjectInitializationState;
```

- `useUserDraftState` gains a synchronous `canAcceptUserMutation(): boolean` guard.
- `EditorV2Shell` blocks its single editor subtree when initialization is not ready or recovery is active.

- [ ] **Step 1: Add deferred-default RED cases to the actual hook harness**

Add runtime cases for blank bootstrap and Reset. The harness must hold the account-default response, call a real user setter during the wait, and assert the hook is blocked and the attempted value never becomes the created/reset draft:

```ts
const defaults = deferredJsonResponse({ defaultLogo: null });
runtime.fetchRoute("GET", "/api/user/brand-assets", defaults.response);

const hook = runtime.mountUseV2Project();
assert.equal(hook.current.projectInitialization, "loading-defaults");
assert.equal(hook.current.projectReady, false);
hook.current.setScript("must-not-survive-bootstrap");
defaults.resolve();
await runtime.flushAll();
assert.equal(hook.current.projectInitialization, "ready");
assert.notEqual(hook.current.script, "must-not-survive-bootstrap");
assert.equal(runtime.createdProjects[0]?.draft.script, "");
```

Reset case:

```ts
const reset = hook.current.resetProject();
assert.equal(hook.current.projectInitialization, "loading-defaults");
assert.equal(hook.current.projectReady, false);
hook.current.setProjectTitle("must-not-survive-reset");
resetDefaults.resolve();
await reset;
assert.equal(hook.current.projectInitialization, "ready");
assert.equal(hook.current.projectTitle, "New Project");
```

Also cover superseded Reset, unmount, default failure, and server-project creation failure. Non-abort failure must expose `recovery.status === "load-error"` and `projectInitialization === "error"`.

- [ ] **Step 2: Run the hook verifier and confirm the intended RED**

Run:

```bash
npx tsx scripts/verify-editor-project-recovery-hook.ts
```

Expected: exit 1 because the current hook has no `projectInitialization`, accepts the setter, and applies/reset-overwrites after the deferred default.

- [ ] **Step 3: Add the source/JSX RED contract**

Update `verifyShell()` so the inert owner uses one computed boundary and the loading status is outside it:

```ts
assert.match(source, /const editorBlocked = p\.projectInitialization !== "ready" \|\| p\.recovery\.status !== "none"/);
assert.equal(attributeText(wrapper, "inert", root), "{editorBlocked ? true : undefined}");
assert.equal(attributeText(wrapper, "aria-hidden", root), '{editorBlocked ? "true" : undefined}');
assert.match(source, /role="status"/);
assert.match(source, /กำลังเตรียมโปรเจกต์/);
```

Run:

```bash
npx tsx scripts/verify-editor-project-conflict-ui.ts
```

Expected: exit 1 because shell inertness currently considers only recovery.

- [ ] **Step 4: Implement the minimal initialization lifecycle**

In `useV2Project.ts`, add state/ref ownership:

```ts
export type ProjectInitializationState =
  | "loading-defaults"
  | "creating-project"
  | "ready"
  | "error";

const [projectInitialization, setProjectInitializationRaw] =
  useState<ProjectInitializationState>("loading-defaults");
const projectInitializationRef = useRef<ProjectInitializationState>("loading-defaults");
const setProjectInitialization = useCallback((next: ProjectInitializationState) => {
  projectInitializationRef.current = next;
  setProjectInitializationRaw(next);
}, []);
const canAcceptUserMutation = useCallback(
  () => projectInitializationRef.current === "ready" && projectReadyRef.current,
  [],
);
```

Extend `useUserDraftState` without changing synchronized/raw application:

```ts
function useUserDraftState<T>(
  initial: T,
  field: keyof V2Draft,
  effectiveDraftRef: MutableRefObject<V2Draft>,
  canAcceptUserMutation: () => boolean,
  markUserMutation: () => void,
): [T, SetState<T>, SetState<T>] {
  // existing raw/synchronized state
  const setFromUser = useCallback<SetState<T>>((next) => {
    if (!canAcceptUserMutation()) return;
    setSynchronized(next);
    markUserMutation();
  }, [canAcceptUserMutation, markUserMutation, setSynchronized]);
  return [value, setFromUser, setSynchronized];
}
```

Pass the guard to every `useUserDraftState` call. Guard composite user setters such as `setClipUrl` and `setMixPreset` before any raw setter.

At the beginning of Reset, before `loadAccountLogoDefault()`:

```ts
setProjectReady(false);
setProjectInitialization("loading-defaults");
```

After the owned default resolves and before POST, set `"creating-project"`. Only the exact owned `createServerProject` success and lineage initialization set `projectReady=true` and `"ready"`. Non-abort failures set `projectReady=false`, `"error"`, and the existing visible load-error.

Blank bootstrap follows the same transitions. Late/superseded completions check generation/controller/mount before state changes.

In `EditorV2Shell.tsx`:

```tsx
const editorBlocked = p.projectInitialization !== "ready"
  || p.recovery.status !== "none";

{p.projectInitialization !== "ready" && p.recovery.status === "none" ? (
  <div role="status" aria-live="polite" className="sr-only">
    กำลังเตรียมโปรเจกต์
  </div>
) : null}

<div
  inert={editorBlocked ? true : undefined}
  aria-hidden={editorBlocked ? "true" : undefined}
  className="contents"
>
```

- [ ] **Step 5: Run focused GREEN and controlled mutants**

Run:

```bash
npx tsx scripts/verify-editor-project-recovery-hook.ts
npx tsx scripts/verify-editor-project-conflict-ui.ts
npx tsx scripts/verify-editor-project-autosave-lineage.ts
npx tsx scripts/verify-editor-project-save-queue.ts
```

Expected: all exit 0.

Temporarily mutate and restore:

- move `setProjectReady(false)` after the default await;
- remove `canAcceptUserMutation()` from `setFromUser`;
- let a superseded default completion set `"ready"`.

Expected: each mutation makes the hook verifier exit 1 for its exact deferred case.

- [ ] **Step 6: Commit Task 1**

```bash
git add 'src/app/(dashboard)/video-editor/_v2/useV2Project.ts' \
  'src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx' \
  scripts/editor-project-recovery-hook-runtime-harness.ts \
  scripts/verify-editor-project-recovery-hook.ts \
  scripts/verify-editor-project-conflict-ui.ts
git commit -m "fix: block editor during project initialization"
```

---

### Task 2: Retire unreferenced Logo assets without deleting recovery data

**Files:**

- Modify: `prisma/schema.prisma`
- Modify: `src/lib/brand-assets.server.ts`
- Modify: `src/lib/brand-asset-api.server.ts`
- Modify: `scripts/verify-brand-assets.ts`
- Modify: `scripts/verify-brand-asset-api.ts`

**Interfaces:**

- Prisma fields:

```prisma
retiredAt          DateTime?
lifecycleRevision Int       @default(0)
```

- Produces:

```ts
export type RecoverableBrandAssetFence = {
  id: string;
  storageKey: string;
  lifecycleRevision: number;
  retiredAt: Date | null;
};

export async function getRecoverableBrandAssetFence(
  userId: string,
  assetId: string,
): Promise<RecoverableBrandAssetFence | null>;

export async function getOwnedRecoverableBrandAsset(
  userId: string,
  assetId: string,
): Promise<BrandAssetView | null>;

export async function getRecoverableBrandAssetPath(
  userId: string,
  assetId: string,
): Promise<string | null>;
```

- `deleteBrandAssetIfUnreferenced` keeps its public boolean/error contract but success now retires the row and preserves the file.

- [ ] **Step 1: Write RED retirement and visibility integration cases**

In `verify-brand-assets.ts`, replace physical-delete expectations only for the new approved behavior and add direct recovery checks:

```ts
const pathBeforeRetire = await service.getBrandAssetPath(USER_A, resizedAsset.id);
assert.equal(await service.deleteBrandAssetIfUnreferenced(USER_A, resizedAsset.id), true);
const retired = await prisma.brandAsset.findUnique({ where: { id: resizedAsset.id } });
assert.ok(retired?.retiredAt);
assert.equal(retired?.lifecycleRevision, 1);
assert.equal(existsSync(pathBeforeRetire!), true);
assert.equal(await service.getOwnedBrandAsset(USER_A, resizedAsset.id), null);
assert.equal((await service.getOwnedRecoverableBrandAsset(USER_A, resizedAsset.id))?.id, resizedAsset.id);
assert.equal(await service.getBrandAssetPath(USER_A, resizedAsset.id), null);
assert.equal(await service.getRecoverableBrandAssetPath(USER_A, resizedAsset.id), pathBeforeRetire);
```

Add cases for active collection filtering, default selection rejection, repeated delete hidden as not found, cross-owner recovery hidden, and account deletion removing both active and retired rows/files.

- [ ] **Step 2: Run schema/service RED**

Run on a fresh fixture:

```bash
DATABASE_URL=file:/tmp/heroai-retired-logo-red.db npx prisma db push --skip-generate --accept-data-loss
DATABASE_URL=file:/tmp/heroai-retired-logo-red.db BRAND_ASSET_ROOT=/tmp/heroai-retired-logo-red-assets npx tsx scripts/verify-brand-assets.ts
```

Expected: compile/schema or assertion failure because `retiredAt`, `lifecycleRevision`, and recoverable lookup do not exist and current deletion unlinks the file.

- [ ] **Step 3: Add schema fields and active/recoverable query boundaries**

Add the two fields to `BrandAsset`. Update active queries:

```ts
const ACTIVE_ASSET_WHERE = { retiredAt: null } as const;

export async function getOwnedBrandAsset(userId: string, assetId: string) {
  const asset = await prisma.brandAsset.findFirst({
    where: { id: assetId, userId, retiredAt: null },
  });
  return asset ? toBrandAssetView(asset) : null;
}

export async function getOwnedRecoverableBrandAsset(userId: string, assetId: string) {
  const asset = await prisma.brandAsset.findFirst({ where: { id: assetId, userId } });
  return asset ? toBrandAssetView(asset) : null;
}
```

Collection, `getOwnedBrandAsset`, `getBrandAssetPath`, and default-setting queries require
`retiredAt:null`. Same-owner direct item/image recovery explicitly uses
`getOwnedRecoverableBrandAsset` and `getRecoverableBrandAssetPath`. No collection response
exposes retirement fields. This keeps export on the active-only path while allowing an
owned conflict preview to display the retained local candidate.

- [ ] **Step 4: Implement revision-fenced retirement**

Inside the existing transaction:

```ts
const asset = await tx.brandAsset.findFirst({
  where: { id: assetId, userId, retiredAt: null },
  select: { lifecycleRevision: true },
});
if (!asset) return false;

// existing default/global project draft checks

const retired = await tx.brandAsset.updateMany({
  where: {
    id: assetId,
    userId,
    retiredAt: null,
    lifecycleRevision: asset.lifecycleRevision,
  },
  data: {
    retiredAt: new Date(),
    lifecycleRevision: { increment: 1 },
  },
});
if (retired.count !== 1) throw new BrandAssetError("asset_in_use", 409);
return true;
```

Do not call `unlinkIfPresent` after successful retirement. Keep hard account-directory cleanup unchanged.

- [ ] **Step 5: Verify GREEN and retirement mutants**

Run:

```bash
DATABASE_URL=file:/tmp/heroai-retired-logo-green.db npx prisma db push --skip-generate --accept-data-loss
DATABASE_URL=file:/tmp/heroai-retired-logo-green.db BRAND_ASSET_ROOT=/tmp/heroai-retired-logo-green-assets npx tsx scripts/verify-brand-assets.ts
DATABASE_URL=file:/tmp/heroai-retired-logo-green.db BRAND_ASSET_ROOT=/tmp/heroai-retired-logo-green-assets npx tsx scripts/verify-brand-asset-api.ts
```

Expected: both exit 0.

Mutate and restore:

- delete the row/file instead of setting `retiredAt`;
- omit active filtering from collection/default queries;
- remove the retirement `lifecycleRevision` predicate;
- expose cross-owner retired metadata.

Expected: each mutant exits 1.

- [ ] **Step 6: Commit Task 2**

```bash
git add prisma/schema.prisma src/lib/brand-assets.server.ts \
  src/lib/brand-asset-api.server.ts scripts/verify-brand-assets.ts \
  scripts/verify-brand-asset-api.ts
git commit -m "feat: retain recoverable logo assets"
```

---

### Task 3: Validate and atomically restore draft Logo assets during project CAS

**Files:**

- Create: `src/lib/editor-project-brand-asset.server.ts`
- Modify: `src/lib/editor-projects.ts`
- Modify: `src/lib/editor-project-patch.ts`
- Modify: `src/app/api/editor-projects/route.ts`
- Modify: `src/app/(dashboard)/video-editor/_v2/useV2Project.ts`
- Modify: `scripts/verify-editor-projects.ts`
- Modify: `scripts/verify-brand-assets.ts`
- Modify: `scripts/editor-project-recovery-hook-runtime-harness.ts`
- Modify: `scripts/verify-editor-project-recovery-hook.ts`
- Modify: `scripts/verify-logo-export.ts`

**Interfaces:**

```ts
export type EditorProjectBrandAssetFence = {
  assetId: string;
  lifecycleRevision: number;
};

export class EditorProjectBrandAssetError extends Error {
  code: "brand_asset_unavailable" | "brand_asset_lifecycle_conflict";
}

export async function prepareEditorProjectBrandAsset(
  userId: string,
  draftJson: string | null | undefined,
): Promise<EditorProjectBrandAssetFence | null>;

export async function advanceEditorProjectBrandAsset(
  tx: Prisma.TransactionClient,
  userId: string,
  fence: EditorProjectBrandAssetFence | null,
): Promise<void>;
```

- `brand_asset_unavailable` maps to HTTP 422 without a project payload.
- `brand_asset_lifecycle_conflict` maps to HTTP 409 without acknowledging a write.

- [ ] **Step 1: Write the cross-subsystem stale-journal RED**

Using a disposable DB/root in `verify-editor-projects.ts`:

```ts
const staleLocal = { logoOverlay: { enabled: true, assetId: asset.id, position: "top-right", sizePct: 18, opacity: 0.9 } };
await service.deleteBrandAssetIfUnreferenced(user.id, asset.id);
const response = await patchEditorProjectForUser(user.id, project.id, {
  draft: staleLocal,
  draftRevision: 2,
  expectedDraftRevision: 1,
});
assert.equal(response.status, 200);
const restored = await prisma.brandAsset.findUnique({ where: { id: asset.id } });
assert.equal(restored?.retiredAt, null);
assert.equal((await projects.getEditorProject(user.id, project.id))?.draft.logoOverlay.assetId, asset.id);
assert.ok(await service.getBrandAssetPath(user.id, asset.id));
```

Add RED cases for missing row/file, cross-owner id, stale project CAS, server choice, and a controlled retire-vs-recovery barrier. A stale project CAS must leave `retiredAt` and `lifecycleRevision` unchanged.

- [ ] **Step 2: Run the project/service RED**

```bash
DATABASE_URL=file:/tmp/heroai-logo-recovery-cas-red.db npx prisma db push --skip-generate --accept-data-loss
DATABASE_URL=file:/tmp/heroai-logo-recovery-cas-red.db BRAND_ASSET_ROOT=/tmp/heroai-logo-recovery-cas-red-assets npx tsx scripts/verify-editor-projects.ts
```

Expected: exit 1 because the current project PATCH persists the retired/missing id without validation or restoration.

- [ ] **Step 3: Implement the focused server asset fence module**

Extract the normalized Logo id from encoded JSON using `normalizeLogoOverlayConfig`. Resolve only a same-owner row and verify its trusted file is a regular file under `BRAND_ASSET_ROOT`:

```ts
export async function prepareEditorProjectBrandAsset(userId: string, draftJson: string | null | undefined) {
  const assetId = draftLogoAssetId(draftJson);
  if (!assetId) return null;
  const asset = await getRecoverableBrandAssetFence(userId, assetId);
  if (!asset || !await recoverableBrandAssetFileExists(asset.storageKey)) {
    throw new EditorProjectBrandAssetError("brand_asset_unavailable");
  }
  return { assetId, lifecycleRevision: asset.lifecycleRevision };
}

export async function advanceEditorProjectBrandAsset(tx, userId, fence) {
  if (!fence) return;
  const advanced = await tx.brandAsset.updateMany({
    where: {
      id: fence.assetId,
      userId,
      lifecycleRevision: fence.lifecycleRevision,
    },
    data: { retiredAt: null, lifecycleRevision: { increment: 1 } },
  });
  if (advanced.count !== 1) {
    throw new EditorProjectBrandAssetError("brand_asset_lifecycle_conflict");
  }
}
```

No raw identifiers appear in thrown messages or logs.

- [ ] **Step 4: Make create/update project writes transactional with the asset fence**

For draft-bearing create/update:

```ts
const draftJson = encodeEditorProjectDraft(input.draft);
const assetFence = await prepareEditorProjectBrandAsset(userId, draftJson);

const project = await prisma.$transaction(async (tx) => {
  const created = await tx.editorProject.create({ data: { /* existing fields */ draftJson } });
  await advanceEditorProjectBrandAsset(tx, userId, assetFence);
  return created;
});
```

For PATCH, keep all existing bundled metadata and revision predicates inside one transaction. If `updateMany` returns zero, throw an internal stale marker before advancing the asset; outside the transaction fetch the authoritative project and throw the existing `stale_revision`. If asset advancement throws, Prisma rolls back the project update.

Metadata-only PATCHes do not touch asset lifecycle state.

- [ ] **Step 5: Map recoverable errors without closing conflict**

In both project route seams:

```ts
if (code === "brand_asset_unavailable") {
  return NextResponse.json(
    { error: "brand_asset_unavailable", message: "ไม่พบไฟล์โลโก้ กรุณาอัปโหลดใหม่" },
    { status: 422 },
  );
}
if (code === "brand_asset_lifecycle_conflict") {
  return NextResponse.json({ error: "brand_asset_lifecycle_conflict" }, { status: 409 });
}
```

In `chooseLocalProjectDraft`, before generic acknowledgement/ambiguity handling:

```ts
if (res.status === 422 && payload?.error === "brand_asset_unavailable") {
  setRecoveryState({
    ...conflict,
    resolving: false,
    error: "ไม่พบไฟล์โลโก้เดิม กรุณาอัปโหลดโลโก้ใหม่แล้วเลือกอีกครั้ง",
  });
  return;
}
```

The conflict candidates and journal remain unchanged. A lifecycle 409 follows the existing authoritative GET reconciliation and never acknowledges the local choice.

- [ ] **Step 6: Verify GREEN, export viability, and CAS mutants**

Run:

```bash
DATABASE_URL=file:/tmp/heroai-logo-recovery-cas-green.db npx prisma db push --skip-generate --accept-data-loss
DATABASE_URL=file:/tmp/heroai-logo-recovery-cas-green.db BRAND_ASSET_ROOT=/tmp/heroai-logo-recovery-cas-green-assets npx tsx scripts/verify-editor-projects.ts
DATABASE_URL=file:/tmp/heroai-logo-recovery-cas-green.db BRAND_ASSET_ROOT=/tmp/heroai-logo-recovery-cas-green-assets npx tsx scripts/verify-brand-assets.ts
DATABASE_URL=file:/tmp/heroai-logo-recovery-cas-green.db BRAND_ASSET_ROOT=/tmp/heroai-logo-recovery-cas-green-assets npx tsx scripts/verify-logo-export.ts
npx tsx scripts/verify-editor-project-recovery-hook.ts
```

Expected: all exit 0.

Mutate and restore:

- omit same-owner or physical-file validation;
- restore the asset before the project transaction;
- remove asset lifecycle revision from project or retirement CAS;
- acknowledge 422 and clear the journal;
- let a stale project CAS restore the asset.

Expected: each mutant exits 1.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/lib/editor-project-brand-asset.server.ts src/lib/editor-projects.ts \
  src/lib/editor-project-patch.ts src/app/api/editor-projects/route.ts \
  'src/app/(dashboard)/video-editor/_v2/useV2Project.ts' \
  scripts/verify-editor-projects.ts scripts/verify-brand-assets.ts \
  scripts/editor-project-recovery-hook-runtime-harness.ts \
  scripts/verify-editor-project-recovery-hook.ts scripts/verify-logo-export.ts
git commit -m "fix: restore recoverable logos with project cas"
```

---

### Task 4: Remove the owned conflict history guard after resolution

**Files:**

- Modify: `src/lib/editor-project-conflict-history.ts`
- Modify: `scripts/verify-editor-project-conflict-ui.ts`

**Interfaces:**

- Preserve `createBlockingDialogHistory(input).activate(): () => void`.
- Only the current owned same-URL guard may be popped.

- [ ] **Step 1: Add RED history stack cases**

Extend the browser-backed history harness:

```ts
history.pushState({ route: "before-editor" }, "", "/dashboard");
history.pushState({ route: "editor" }, "", "/video-editor?ui=v2");
const cleanup = historyGuard.activate();
assert.equal(history.length, initialLength + 1);
cleanup();
await nextPopState();
assert.equal(location.pathname, "/video-editor");
history.back();
await nextPopState();
assert.equal(location.pathname, "/dashboard");
```

Add pending-Back, double cleanup, nested owner, foreign state, and unmount cases.

- [ ] **Step 2: Run the RED**

```bash
npx tsx scripts/verify-editor-project-conflict-ui.ts
```

Expected: exit 1 because cleanup currently replaces the guard tag in place and leaves the duplicate entry.

- [ ] **Step 3: Pop only the current owned guard under cleanup ownership**

Add a cleanup generation/pending-pop flag. When the final owner cleans up and the current state is the owned guard, remove the blocking listener, install a one-shot cleanup pop listener, and call `history.back()`. The listener restores nothing because the prior entry was never modified:

```ts
if (isOwnedState(readState()) && !pendingPop) {
  pendingPop = true;
  const cleanupGeneration = ++generation;
  removeStrandedTagListener = input.addPopStateListener(() => {
    if (generation !== cleanupGeneration) return;
    pendingPop = false;
    removeStrandedListener();
  });
  input.history.back();
  return;
}
```

If Back is already pending or the current entry is foreign, do not issue another navigation. Keep the stranded-tag repair only for an owned tag that becomes current through a late pop race.

- [ ] **Step 4: Run GREEN and the no-pop mutant**

```bash
npx tsx scripts/verify-editor-project-conflict-ui.ts
npx tsx scripts/verify-editor-project-recovery-hook.ts
```

Expected: both exit 0. Replacing the cleanup `back()` with the old in-place replace must make the normal-Back case exit 1; restore it.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/lib/editor-project-conflict-history.ts scripts/verify-editor-project-conflict-ui.ts
git commit -m "fix: remove resolved conflict history guard"
```

---

### Task 5: Bind `saveAsDefault` completion to the current Logo operation

**Files:**

- Modify: `src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor.ts`
- Modify: `scripts/logo-overlay-editor-runtime-harness.ts`
- Modify: `scripts/verify-logo-client-contract.ts`

**Interfaces:**

```ts
type LogoMutationOwner = {
  token: symbol;
  kind: "upload" | "default-save";
  projectId: string;
  assetId: string | null;
  surface: LogoEditorSurface;
  requestGeneration: number;
};
```

- A newer upload owns shared `saving` state and aborts an older default save.
- A newer default save supersedes an older default save.
- `saveAsDefault` returns `false` without starting while an upload owns the mutation lane.
- Project switch/unmount invalidates both.

- [ ] **Step 1: Add runtime RED ownership cases**

In the real hook harness:

```ts
const first = deferredFetch("PATCH", "/api/user/brand-assets/asset-a");
const save = hook.current.saveAsDefault();
runtime.rerender({ projectId: "project-b", assetId: "asset-b" });
const upload = hook.current.upload(fileB);
first.reject(new Error("late default failure"));
await runtime.flushAll();
assert.equal(hook.current.saving, true, "late default finally cannot clear upload ownership");
assert.equal(hook.current.error, null);
assert.equal(runtime.events.includes("logo_overlay_default_saved"), false);
uploadResponse.resolve(successAssetB);
await upload;
assert.equal(hook.current.saving, false);
```

Also test newer default save, project switch without upload, unmount, late success telemetry, and late invalid JSON.

- [ ] **Step 2: Run the RED**

```bash
npx tsx scripts/verify-logo-client-contract.ts
```

Expected: exit 1 because current `saveAsDefault` has no generation/controller/current-project checks and its `finally` always clears `saving`.

- [ ] **Step 3: Implement token-owned mutation state**

Add refs:

```ts
const defaultSaveGenerationRef = useRef(0);
const activeDefaultSaveControllerRef = useRef<AbortController | null>(null);
const activeMutationOwnerRef = useRef<LogoMutationOwner | null>(null);

const ownsMutation = (owner: LogoMutationOwner) =>
  activeMutationOwnerRef.current?.token === owner.token
  && currentProjectIdRef.current === owner.projectId
  && (owner.kind !== "default-save"
    || currentLogoAssetIdRef.current === owner.assetId);
```

At default-save start, return `false` if the current owner is an upload. Otherwise,
invalidate/abort the older default request, capture project/asset/surface/generation,
install a new owner, and pass `signal`. After every await and before
error/telemetry/return-state mutation, call `ownsMutation(owner)`.

At upload start, abort/invalidate the default save and replace the shared mutation owner
with the upload owner. On an asset-id change, invalidate a current default-save owner but
do not invalidate an upload owner applying its own successful result. Project switch and
unmount abort both and clear the owner. In every `finally`:

```ts
if (ownsMutation(owner)) {
  activeMutationOwnerRef.current = null;
  setSaving(false);
}
```

Stale callbacks return false without error or telemetry.

- [ ] **Step 4: Run GREEN and late-finally mutants**

```bash
npx tsx scripts/verify-logo-client-contract.ts
npx tsx scripts/verify-logo-project-default.ts
npx tsx scripts/verify-logo-overlay.ts
```

Expected: all exit 0.

Mutate and restore:

- remove the project/asset ownership check after response JSON;
- let default-save `finally` unconditionally call `setSaving(false)`;
- fail to abort default-save when upload B starts.

Expected: each mutant exits 1 in its runtime case.

- [ ] **Step 5: Commit Task 5**

```bash
git add 'src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor.ts' \
  scripts/logo-overlay-editor-runtime-harness.ts scripts/verify-logo-client-contract.ts
git commit -m "fix: bind logo default saves to operation ownership"
```

---

### Task 6: Repeat release verification, independent review, and QA handoff

**Files:**

- Update ignored evidence: `.superpowers/sdd/editor-release-blocker-final-report.md`
- Update ignored ledger: `.superpowers/sdd/progress.md`

**Interfaces:**

- No production interface. This task proves and hands off the branch.

- [ ] **Step 1: Run Prisma and the complete 18-verifier gate on new fixtures**

Create a new disposable DB/root and run:

```bash
npx tsx scripts/verify-editor-project-autosave-lineage.ts
npx tsx scripts/verify-editor-project-recovery.ts
npx tsx scripts/verify-editor-project-save-queue.ts
npx tsx scripts/verify-editor-project-recovery-hook.ts
npx tsx scripts/verify-editor-project-conflict-ui.ts
DATABASE_URL=file:/tmp/heroai-editor-final-remediation.db npx tsx scripts/verify-editor-projects.ts
npx tsx scripts/verify-logo-overlay.ts
DATABASE_URL=file:/tmp/heroai-editor-final-remediation.db BRAND_ASSET_ROOT=/tmp/heroai-editor-final-remediation-assets npx tsx scripts/verify-brand-assets.ts
DATABASE_URL=file:/tmp/heroai-editor-final-remediation.db BRAND_ASSET_ROOT=/tmp/heroai-editor-final-remediation-assets npx tsx scripts/verify-brand-asset-api.ts
npx tsx scripts/verify-logo-project-default.ts
DATABASE_URL=file:/tmp/heroai-editor-final-remediation.db BRAND_ASSET_ROOT=/tmp/heroai-editor-final-remediation-assets npx tsx scripts/verify-logo-export.ts
npx tsx scripts/verify-logo-render.ts
npx tsx scripts/verify-logo-client-contract.ts
npx tsx scripts/verify-mobile-sheet.ts
npx tsx scripts/verify-render-duration-bill.ts
npx tsx scripts/verify-clip-charge.ts
npx tsx scripts/verify-media-reference-graph.ts
npx tsx scripts/verify-media-cleanup-mode.ts
```

Expected: 18/18 exit 0. Remove all disposable fixtures afterward.

- [ ] **Step 2: Run generation/build/typecheck**

```bash
npx prisma generate
npm run build
npx tsc --noEmit --pretty false
git diff --check
```

Expected: Prisma/build/diff-check exit 0; build reports 139 pages or the current intentional page count. TypeScript may report only the unchanged checkout metadata baseline at `src/app/api/payments/checkout/route.ts:129`; no changed-file diagnostic is allowed.

- [ ] **Step 3: Request focused and merge-base independent review**

Review every task after its commit, then review `f749c44..HEAD` against:

- responsive Logo Overlay plan/spec;
- conflict-resolution plan/spec;
- release-blocker remediation plan/spec;
- trusted Clerk cleanup plan/spec; and
- `2026-07-16-editor-final-review-remediation-design.md`.

Fix and re-review every Critical/Important finding. Minor findings are recorded with an explicit release decision.

- [ ] **Step 4: Refresh only the worktree-owned QA server**

Verify port/process ownership before replacement. Start current HEAD on `0.0.0.0:3007`, then record:

- Tailscale URL;
- branch and full SHA;
- environment variable names only;
- signed-out redirect/login results; and
- authenticated desktop/mobile/preview/export results when a non-production session exists.

If no authenticated session exists, mark only protected QA as environment-blocked; do not claim it passed.

- [ ] **Step 5: Finish without integration**

Use `superpowers:verification-before-completion` and `superpowers:finishing-a-development-branch`. Present merge/PR/keep/cleanup choices. Do not merge, push, deploy, or apply the production schema without explicit user approval.

---

## Plan self-review checklist

- Each design requirement maps to Task 1–6.
- Initialization, asset retirement, project restoration, history, and default-save ownership are independently testable/reviewable.
- Asset retirement and project restoration share the exact `lifecycleRevision` names and CAS semantics.
- Project error names are exactly `brand_asset_unavailable` and `brand_asset_lifecycle_conflict`.
- Every production change has a prior failing runtime/integration test and a controlled mutant.
- No task requires End Scene, ElevenLabs, payment, irreversible asset purge, or production deployment.
