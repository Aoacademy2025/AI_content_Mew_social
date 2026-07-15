# Editor Project Conflict Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unsafe automatic editor-draft recovery with provenance-aware local journals, revision-safe explicit conflict choices, and one blocking responsive dialog shared by desktop and mobile.

**Architecture:** A pure recovery domain validates project-scoped user-edit journals and decides whether bootstrap may apply server, safely resume local, show a conflict, or stay locked. `useV2Project` records only explicit user mutations, while the server adds an optional observed-revision compare-and-set for the local-choice write. `EditorV2Shell` renders a single accessible blocking dialog so no unresolved conflict can leak interaction to desktop or mobile editor surfaces.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Prisma 6/SQLite-compatible queries, Radix AlertDialog, Tailwind CSS, `tsx` verifier scripts, Puppeteer for responsive smoke where authentication permits.

## Global Constraints

- Never select a conflicting local or server draft automatically.
- Only explicit user mutations may create or refresh trusted local provenance.
- Existing-project load errors and unresolved conflicts keep the editor unready and inert.
- `ใช้ฉบับในเครื่อง` must use an observed server revision and refresh the conflict on `409`.
- `ใช้ฉบับบนระบบ` must not send a draft PATCH.
- Back, Escape, and backdrop interaction cannot dismiss an unresolved conflict.
- The dialog must fit 360, 375, 390, and 430 pixel mobile widths with safe-area padding and no horizontal overflow.
- No field-level merge, general offline editor, or new production dependency.
- Recovery telemetry must never contain draft content, asset identifiers, filenames, URLs, storage paths, or project content.
- Preserve Logo Overlay snapshot, render, billing, cleanup, plan-gating, and privacy behavior.
- Do not fix the unrelated TypeScript baseline at `src/app/api/payments/checkout/route.ts:129` in this branch.

---

### Task 1: Add the trusted journal and pure bootstrap decision boundary

**Files:**

- Create: `src/lib/editor-project-recovery-journal.ts`
- Rewrite: `src/lib/editor-project-bootstrap.ts`
- Create: `scripts/verify-editor-project-recovery.ts`
- Modify: `scripts/verify-editor-project-save-queue.ts`

**Interfaces:**

- Produces:

```ts
export type EditorProjectDraft = Record<string, unknown>;

export type EditorProjectRecoveryJournalV1 = {
  version: 1;
  projectId: string;
  baseRevision: number;
  editedAt: string;
  draft: EditorProjectDraft;
};

export type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function editorProjectRecoveryKey(projectId: string): string;
export function parseEditorProjectRecoveryJournal(
  value: unknown,
  projectId: string,
): EditorProjectRecoveryJournalV1 | null;
export function readEditorProjectRecoveryJournal(
  storage: RecoveryStorage | null,
  projectId: string,
): EditorProjectRecoveryJournalV1 | null;
export function writeEditorProjectRecoveryJournal(
  storage: RecoveryStorage | null,
  journal: EditorProjectRecoveryJournalV1,
): boolean;
export function clearEditorProjectRecoveryJournal(
  storage: RecoveryStorage | null,
  projectId: string,
): void;

export type EditorProjectBootstrapDecision =
  | { kind: "server" }
  | { kind: "resume-local"; journal: EditorProjectRecoveryJournalV1 }
  | {
      kind: "conflict";
      local: { draft: EditorProjectDraft; editedAt: string | null; trusted: boolean };
    }
  | { kind: "locked-error"; code: "server_behind" | "missing_recovery" };

export function decideEditorProjectBootstrap(input: {
  projectId: string;
  serverRevision: number;
  revisionWatermark: number;
  journal: EditorProjectRecoveryJournalV1 | null;
  legacyLocalDraft?: unknown;
}): EditorProjectBootstrapDecision;
```

- Consumes: existing `editorProjectSaveQueue.revisionWatermark(projectId)` from `src/lib/editor-project-save-queue.ts`.

- [ ] **Step 1: Write the failing pure verifier**

Add table-driven checks to `scripts/verify-editor-project-recovery.ts`:

```ts
const projectId = "project-a";
const localDraft = { script: "local-user-edit" };
const journal = {
  version: 1 as const,
  projectId,
  baseRevision: 4,
  editedAt: "2026-07-15T10:00:00.000Z",
  draft: localDraft,
};

assert.deepEqual(
  decideEditorProjectBootstrap({
    projectId,
    serverRevision: 4,
    revisionWatermark: 4,
    journal,
  }),
  { kind: "resume-local", journal },
);

assert.equal(
  decideEditorProjectBootstrap({
    projectId,
    serverRevision: 5,
    revisionWatermark: 5,
    journal,
  }).kind,
  "conflict",
);

assert.deepEqual(
  decideEditorProjectBootstrap({
    projectId,
    serverRevision: 3,
    revisionWatermark: 4,
    journal: null,
  }),
  { kind: "locked-error", code: "server_behind" },
);
```

Also prove:

- mismatched project ids, arrays, invalid dates, negative revisions, and unsupported versions parse as `null`;
- journal read/write/clear uses only `editor-v2-recovery:<projectId>`;
- storage exceptions return `false`/`null` and never fabricate a draft;
- a newer server plus a trusted or usable legacy candidate returns `conflict`;
- an invalid legacy object returns `server`, not an empty/default candidate;
- a retry flag or programmatic/default object cannot influence the pure decision.

- [ ] **Step 2: Run the verifier and capture RED**

Run:

```bash
npx tsx scripts/verify-editor-project-recovery.ts
```

Expected: exit 1 because `editor-project-recovery-journal.ts` and the new decision exports do not exist.

- [ ] **Step 3: Implement strict journal parsing and storage helpers**

Use one key per project and validate every field before returning a journal:

```ts
const JOURNAL_PREFIX = "editor-v2-recovery:";

export function editorProjectRecoveryKey(projectId: string): string {
  const id = projectId.trim();
  if (!id) throw new Error("projectId is required");
  return `${JOURNAL_PREFIX}${id}`;
}

export function parseEditorProjectRecoveryJournal(
  value: unknown,
  projectId: string,
): EditorProjectRecoveryJournalV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<EditorProjectRecoveryJournalV1>;
  if (candidate.version !== 1 || candidate.projectId !== projectId) return null;
  if (!Number.isInteger(candidate.baseRevision) || candidate.baseRevision! < 0) return null;
  if (typeof candidate.editedAt !== "string" || !Number.isFinite(Date.parse(candidate.editedAt))) return null;
  if (!candidate.draft || typeof candidate.draft !== "object" || Array.isArray(candidate.draft)) return null;
  return candidate as EditorProjectRecoveryJournalV1;
}
```

`writeEditorProjectRecoveryJournal` must catch quota/private-mode errors and return `false`; `clearEditorProjectRecoveryJournal` is best-effort and idempotent.

- [ ] **Step 4: Replace automatic-local bootstrap decisions**

Remove `localDirty`, `readLocalDraft`, and `isLocalDirty` from `resolveEditorProjectBootstrap`. Keep network loading separate from draft selection: the loader validates the response, then calls `decideEditorProjectBootstrap` with the validated journal, optional legacy candidate, server revision, and queue watermark.

Decision order must be exact:

```ts
if (serverRevision < revisionWatermark) {
  return { kind: "locked-error", code: journal ? "server_behind" : "missing_recovery" };
}
if (journal && serverRevision === journal.baseRevision) {
  return { kind: "resume-local", journal };
}
if (journal && serverRevision > journal.baseRevision) {
  return { kind: "conflict", local: toCandidate(journal, true) };
}
if (usableLegacyDraft) {
  return { kind: "conflict", local: toLegacyCandidate(usableLegacyDraft) };
}
return { kind: "server" };
```

Do not inspect a generic `dirty` boolean anywhere in this domain.

- [ ] **Step 5: Run focused and mutation checks**

Run:

```bash
npx tsx scripts/verify-editor-project-recovery.ts
npx tsx scripts/verify-editor-project-save-queue.ts
```

Expected:

```text
editor-project-recovery: all checks passed
editor-project-save-queue: all checks passed
```

Temporarily mutate the equal-revision branch to return `server`; the recovery verifier must fail the `resume-local` check. Restore the production code and rerun green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/editor-project-recovery-journal.ts src/lib/editor-project-bootstrap.ts scripts/verify-editor-project-recovery.ts scripts/verify-editor-project-save-queue.ts
git commit -m "feat: add trusted editor recovery decisions"
```

---

### Task 2: Add observed-revision compare-and-set for explicit local choice

**Files:**

- Modify: `src/lib/editor-projects.ts`
- Modify: `src/lib/editor-project-patch.ts`
- Modify: `scripts/verify-editor-projects.ts`

**Interfaces:**

- Extends `updateEditorProject` draft input with:

```ts
expectedDraftRevision?: unknown;
```

- PATCH request for local conflict choice:

```ts
{
  draft: EditorProjectDraft;
  draftRevision: number;
  expectedDraftRevision: number;
  touchLastOpened: true;
}
```

- A stale observed revision returns the existing `409` shape:

```ts
{ error: "stale_revision", project: EditorProjectResponse }
```

- [ ] **Step 1: Extend the fresh-database verifier before production code**

Add cases to `scripts/verify-editor-projects.ts`:

```ts
const observed = await updateEditorProject(userId, id, {
  draft: { script: "local-choice" },
  draftRevision: 7,
  expectedDraftRevision: 6,
});
assert.equal(observed?.draftRevision, 7);

await assert.rejects(
  updateEditorProject(userId, id, {
    draft: { script: "stale-choice" },
    draftRevision: 8,
    expectedDraftRevision: 6,
  }),
  (error: unknown) => (error as { code?: string }).code === "stale_revision",
);
assert.equal((await getEditorProject(userId, id))?.draft.script, "local-choice");
```

Also assert:

- `expectedDraftRevision` without `draft` and `draftRevision` returns `invalid_draft_revision`;
- negative, non-integer, and greater-than-current expected revisions return 400/409 without a write;
- ordinary autosave without expected revision retains the existing monotonic `< draftRevision` behavior;
- revision-less legacy draft updates still increment atomically;
- metadata-only writes do not change `draftRevision`.

- [ ] **Step 2: Run RED against a fresh database**

Run:

```bash
rm -f /tmp/heroai-editor-conflict-cas.db
DATABASE_URL=file:/tmp/heroai-editor-conflict-cas.db npx prisma db push --skip-generate --accept-data-loss
DATABASE_URL=file:/tmp/heroai-editor-conflict-cas.db npx tsx scripts/verify-editor-projects.ts
```

Expected: the observed-revision cases fail because the field is ignored.

- [ ] **Step 3: Implement strict expected-revision validation**

Parse `expectedDraftRevision` as an integer from 0 through `MAX_EDITOR_PROJECT_DRAFT_REVISION`. Require it only with a valid revision-bearing draft and require `draftRevision > expectedDraftRevision`.

Build the atomic update predicate as:

```ts
where: {
  id: projectId,
  userId,
  ...(expectedDraftRevision !== undefined
    ? { draftRevision: expectedDraftRevision }
    : draftRevision !== undefined
      ? { draftRevision: { lt: draftRevision } }
      : {}),
}
```

An update count of zero must fetch the current project and throw the existing `stale_revision` error with that current response.

- [ ] **Step 4: Forward the field through the export-safe PATCH seam**

In `patchEditorProjectForUser`, forward the property only when it is an own property:

```ts
...(Object.prototype.hasOwnProperty.call(fields, "expectedDraftRevision")
  ? { expectedDraftRevision: fields.expectedDraftRevision }
  : {}),
```

Keep the App Router route module limited to supported route exports.

- [ ] **Step 5: Run focused green verification**

Run the fresh-database command from Step 2 again.

Expected: `ALL 45 EDITOR-PROJECT CHECKS PASSED` or a larger exact count printed by the updated verifier, with zero failures.

Run:

```bash
npx tsx scripts/verify-logo-project-default.ts
```

Expected: `logo-project-default: all checks passed`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/editor-projects.ts src/lib/editor-project-patch.ts scripts/verify-editor-projects.ts
git commit -m "feat: guard explicit editor conflict writes"
```

---

### Task 3: Make `useV2Project` provenance-aware and fail closed

**Files:**

- Modify: `src/app/(dashboard)/video-editor/_v2/useV2Project.ts`
- Modify: `src/lib/editor-project-bootstrap.ts`
- Create: `scripts/verify-editor-project-recovery-hook.ts`
- Modify: `scripts/verify-logo-project-default.ts`

**Interfaces:**

- Produces from `useV2Project()`:

```ts
export type RecoveryCandidate = {
  draft: Record<string, unknown>;
  revision: number | null;
  updatedAt: string | null;
  trusted: boolean;
};

export type EditorProjectRecoveryState =
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

recovery: EditorProjectRecoveryState;
retryProjectBootstrap(): void;
chooseLocalProjectDraft(): Promise<void>;
chooseServerProjectDraft(): void;
```

- Consumes the Task 1 journal helpers and Task 2 `expectedDraftRevision` PATCH contract.

- [ ] **Step 1: Write a hook-contract verifier before editing the hook**

`scripts/verify-editor-project-recovery-hook.ts` must use TypeScript AST/source checks plus exported pure seams to prove:

- the old refs `bootstrapLocalDirtyRef` and `bootstrapLocalRecoveryValidRef` are absent;
- retry while unready only increments bootstrap retry and never writes a draft or journal;
- public user setters call one `markUserDraftMutation` boundary;
- `applyDraft`, default loading, `fetchMe`, server hydration, conflict resolution, and reset use raw setters;
- load error produces `load-error`, leaves `projectReady=false`, and performs no POST/PATCH;
- conflict leaves `projectReady=false`;
- local choice sends the immutable displayed local candidate with both revisions;
- server choice performs no PATCH and clears the journal;
- `409` refreshes the conflict instead of closing it;
- save success clears only the journal for the matching project/revision.

Include controlled source mutations that remove `markUserDraftMutation` from a public setter and add it to `applyDraft`; both mutations must make the verifier fail.

- [ ] **Step 2: Run RED**

Run:

```bash
npx tsx scripts/verify-editor-project-recovery-hook.ts
npx tsx scripts/verify-logo-project-default.ts
```

Expected: recovery-hook checks fail because the hook still uses generic dirty refs and exposes no conflict contract. Existing default checks may also fail after their expected source contract is updated.

- [ ] **Step 3: Introduce raw and user-intent setters**

Add a local helper before `useV2Project`:

```ts
import type { Dispatch, SetStateAction } from "react";

type SetState<T> = Dispatch<SetStateAction<T>>;

function useUserDraftState<T>(initial: T, markUserMutation: () => void): [T, SetState<T>, SetState<T>] {
  const [value, setRaw] = useState(initial);
  const setFromUser = useCallback<SetState<T>>((next) => {
    markUserMutation();
    setRaw(next);
  }, [markUserMutation]);
  return [value, setFromUser, setRaw];
}
```

`markUserMutation` increments a ref token only. After React applies the new state, the existing debounced persistence effect sees a newer user token, builds the complete current draft, and writes a trusted journal with:

```ts
{
  version: 1,
  projectId,
  baseRevision: confirmedServerRevisionRef.current,
  editedAt: new Date().toISOString(),
  draft,
}
```

Convert every draft-bearing public field to return the user setter while `applyDraft`, account/default hydration, reset, and conflict actions use the raw setter. Cover at least title, mode, script, uploaded clip fields, b-roll choices, voices, music, avatar fields, clip count, framing, image model/providers, region/style, mix preset, and `logoOverlay`.

System-only fields such as plan, usage, admin flags, avatar metadata, managed feature flags, project status, active job ids, and preview media state remain ordinary state and never mark user provenance.

- [ ] **Step 4: Replace bootstrap with fail-closed recovery states**

For an existing project:

1. Set `recovery={status:"loading"}` and `projectReady=false`.
2. Wait for `editorProjectSaveQueue.whenIdle(projectId)`.
3. GET the project.
4. On network/non-404 failure, set `load-error`, keep the validated journal untouched, and return without POST/PATCH.
5. On 404, preserve the existing explicit missing-project behavior; never fall through to new-project creation for a URL/stored existing id.
6. Validate the current journal after the GET and call `decideEditorProjectBootstrap`.
7. Apply `server` or `resume-local`, or create immutable `conflict` candidates; `locked-error` becomes `load-error` with Thai retry copy.

Retry must only increment `bootstrapRetryRevision`:

```ts
const retryProjectBootstrap = useCallback(() => {
  if (recoveryRef.current.status === "load-error") {
    setBootstrapRetryRevision((value) => value + 1);
  }
}, []);
```

It must not write storage, mark a user mutation, copy default state, or allocate a revision.

- [ ] **Step 5: Implement both conflict actions**

Local choice:

```ts
const expected = conflict.server.revision;
const revision = editorProjectSaveQueue.reserveRevisionAbove(projectId, expected);
const res = await fetch(`/api/editor-projects/${encodeURIComponent(projectId)}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    draft: conflict.local.draft,
    draftRevision: revision,
    expectedDraftRevision: expected,
    touchLastOpened: true,
  }),
});
```

If the current queue lacks `reserveRevisionAbove`, add it to `editor-project-save-queue.ts` as:

```ts
function reserveRevisionAbove(projectId: string, observed: number): number {
  seedRevision(projectId, observed);
  return nextRevision(normalizedProjectId(projectId));
}
```

On success, apply the returned project, clear journal/legacy data, seed revision, set ready, and clear recovery. On `409`, parse the current project, update the server candidate, keep the same immutable local candidate, and leave the dialog open.

Server choice applies the immutable server candidate, seeds its revision, clears journal/legacy data, sets ready, and sends no PATCH.

- [ ] **Step 6: Make autosave journal lifecycle revision-safe**

- Before enqueueing a user-authored draft, write the journal. If storage fails, continue normal server autosave but do not claim recoverability.
- When queue status reports `saved` for the latest matching revision and project, update `confirmedServerRevisionRef` and clear that project's journal.
- Programmatic-only renders do not write a journal and do not start an autosave.
- Existing new-project creation and account-default inheritance remain unchanged.

- [ ] **Step 7: Run focused GREEN and mutation verification**

Run:

```bash
npx tsx scripts/verify-editor-project-recovery.ts
npx tsx scripts/verify-editor-project-recovery-hook.ts
npx tsx scripts/verify-editor-project-save-queue.ts
npx tsx scripts/verify-logo-project-default.ts
```

Expected: all four print their named `all checks passed` lines.

Also rerun the exact reviewer regressions encoded in the hook verifier:

- no-edit Retry against server revision 5 chooses server;
- missing journal plus watermark 1 never turns defaults into local recovery;
- failed journal write cannot reload cached A over in-memory B;
- async settings initialization cannot create a journal;
- StrictMode setup/cleanup does not duplicate POST/PATCH or conflict actions.

- [ ] **Step 8: Commit**

```bash
git add 'src/app/(dashboard)/video-editor/_v2/useV2Project.ts' src/lib/editor-project-bootstrap.ts src/lib/editor-project-save-queue.ts scripts/verify-editor-project-recovery-hook.ts scripts/verify-logo-project-default.ts
git commit -m "feat: fail closed on editor draft conflicts"
```

---

### Task 4: Add the blocking responsive conflict dialog

**Files:**

- Create: `src/lib/editor-project-conflict-history.ts`
- Create: `src/app/(dashboard)/video-editor/_v2/EditorProjectRecoveryDialog.tsx`
- Modify: `src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx`
- Create: `scripts/verify-editor-project-conflict-ui.ts`

**Interfaces:**

- `EditorProjectRecoveryDialog`:

```ts
export function EditorProjectRecoveryDialog(props: {
  recovery: EditorProjectRecoveryState;
  onRetryLoad: () => void;
  onChooseLocal: () => Promise<void>;
  onChooseServer: () => void;
}): React.ReactNode;
```

- History helper:

```ts
export function createBlockingDialogHistory(input: {
  history: Pick<History, "state" | "pushState" | "back">;
  addPopStateListener: (listener: () => void) => () => void;
}): {
  activate(): () => void;
};
```

- [ ] **Step 1: Write UI/history source and pure contract tests first**

`scripts/verify-editor-project-conflict-ui.ts` must assert:

- one dialog instance is rendered by `EditorV2Shell` after the editor content;
- loading, load-error, and conflict make the editor content `inert` and `aria-hidden`;
- conflict copy and both exact Thai action labels exist;
- local/server candidate timestamps are rendered without draft content;
- AlertDialog has no close action and prevents Escape, pointer-down-outside, and interact-outside dismissal;
- initial focus targets the heading, not either choice;
- both buttons disable during either resolving state;
- the conflict component has 16-pixel mobile gutters, safe-area bottom padding, internal overflow, and a desktop max width;
- history activation pushes one tagged same-URL entry, repeated renders do not duplicate it, Back while active preserves the dialog, and cleanup consumes only its own tag;
- no telemetry or DOM text includes serialized draft content.

Use TypeScript AST for parent/prop/linkage checks and controlled broken fixtures for missing `inert`, an Escape close handler, and duplicate history pushes.

- [ ] **Step 2: Run RED**

Run:

```bash
npx tsx scripts/verify-editor-project-conflict-ui.ts
```

Expected: exit 1 because the dialog and history helper do not exist.

- [ ] **Step 3: Implement the tagged history helper**

Use one module token such as `__heroEditorConflict`. `activate()` pushes only when the top entry is not already tagged. A pop while active re-establishes the same URL tag without calling a close callback. Cleanup removes the listener and backs out only when its tag is topmost. Swallow History API errors so browser quirks cannot resolve or dismiss the data conflict.

- [ ] **Step 4: Implement `EditorProjectRecoveryDialog` with existing tokens**

Use the repository `AlertDialog` primitives and `_v2` color/font tokens. Required structure:

```tsx
<AlertDialog open={blocking}>
  <AlertDialogContent
    onEscapeKeyDown={(event) => event.preventDefault()}
    onPointerDownOutside={(event) => event.preventDefault()}
    onInteractOutside={(event) => event.preventDefault()}
    className="max-h-[calc(100dvh-32px-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-[calc(100vw-32px)] max-w-[560px] overflow-y-auto"
    style={{ paddingBottom: "calc(20px + env(safe-area-inset-bottom))" }}
  >
```

Conflict copy is exact from the spec. Render two candidate rows with labels and formatted timestamps; show `ไม่ทราบเวลา` when unavailable. Do not render draft text, file names, logo IDs, or URLs.

Use equal-weight secondary-style actions in DOM order local then server. Add explanatory text under each action stating which candidate it replaces. During resolution, show a spinner only on the selected action and disable both. Errors use `role="alert"`.

Load-error uses the same blocking shell with title `โหลดโปรเจกต์ไม่สำเร็จ`, explanatory copy, and one `ลองใหม่` action. Loading uses `role="status"` and no action.

- [ ] **Step 5: Integrate exactly once in `EditorV2Shell`**

Wrap the existing editor chrome/content in a sibling container:

```tsx
<div
  inert={p.recovery.status !== "none" ? true : undefined}
  aria-hidden={p.recovery.status !== "none" ? "true" : undefined}
  className="contents"
>
  {/* existing shell content */}
</div>
<EditorProjectRecoveryDialog
  recovery={p.recovery}
  onRetryLoad={p.retryProjectBootstrap}
  onChooseLocal={p.chooseLocalProjectDraft}
  onChooseServer={p.chooseServerProjectDraft}
/>
```

Do not render a second instance inside `PostPhase` or `PostPhaseMobile`. Disable project navigation/new-project/delete actions through the inert parent while blocking.

- [ ] **Step 6: Run focused UI verification**

Run:

```bash
npx tsx scripts/verify-editor-project-conflict-ui.ts
npx tsx scripts/verify-logo-client-contract.ts
npx tsc --noEmit --pretty false
```

Expected: both focused verifiers pass. TypeScript may exit nonzero only for the documented unrelated checkout metadata error; there must be no recovery dialog, shell, hook, or history diagnostic.

- [ ] **Step 7: Responsive browser smoke**

Start a disposable dev environment after applying the current schema:

```bash
rm -f /tmp/heroai-editor-conflict-qa.db
DATABASE_URL=file:/tmp/heroai-editor-conflict-qa.db npx prisma db push --skip-generate --accept-data-loss
DATABASE_URL=file:/tmp/heroai-editor-conflict-qa.db BRAND_ASSET_ROOT=/tmp/heroai-editor-conflict-assets npm run dev -- --hostname 0.0.0.0 --port 3007
```

With a non-production authenticated test session, exercise 360, 375, 390, 430, 1023, and 1024 pixels. Verify no horizontal overflow; focus stays in the dialog; Tab reaches both actions; Escape/back/backdrop do not dismiss; underlying export/editor controls receive no pointer events; each choice resolves only after the server response.

If authentication is unavailable, record these interactions as environment-blocked and do not represent source contracts as equivalent browser proof.

- [ ] **Step 8: Commit**

```bash
git add src/lib/editor-project-conflict-history.ts 'src/app/(dashboard)/video-editor/_v2/EditorProjectRecoveryDialog.tsx' 'src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx' scripts/verify-editor-project-conflict-ui.ts
git commit -m "feat: add blocking editor conflict dialog"
```

---

### Task 5: Run full regression, adversarial review, and QA handoff

**Files:**

- Modify only if a conflict-resolution or Logo Overlay regression is reproduced: files named in Tasks 1–4 or the existing Logo Overlay plan.
- Update ignored evidence: `.superpowers/sdd/editor-project-conflict-final-report.md`

**Interfaces:**

- Consumes every verifier and runtime contract from Tasks 1–4.
- Produces a clean, reviewed feature branch or an explicit environment/architecture blocker without merging automatically.

- [ ] **Step 1: Start from a clean tracked worktree**

Run:

```bash
git status --short
git diff --check
```

Expected: no tracked changes and no whitespace errors.

- [ ] **Step 2: Run the complete recovery and Logo Overlay feature suite on a fresh database**

Run:

```bash
rm -f /tmp/heroai-editor-conflict-final.db
rm -rf /tmp/heroai-editor-conflict-assets-final
DATABASE_URL=file:/tmp/heroai-editor-conflict-final.db npx prisma db push --skip-generate --accept-data-loss
DATABASE_URL=file:/tmp/heroai-editor-conflict-final.db npx tsx scripts/verify-editor-projects.ts
npx tsx scripts/verify-editor-project-recovery.ts
npx tsx scripts/verify-editor-project-recovery-hook.ts
npx tsx scripts/verify-editor-project-save-queue.ts
npx tsx scripts/verify-editor-project-conflict-ui.ts
npx tsx scripts/verify-logo-overlay.ts
DATABASE_URL=file:/tmp/heroai-editor-conflict-final.db BRAND_ASSET_ROOT=/tmp/heroai-editor-conflict-assets-final npx tsx scripts/verify-brand-assets.ts
DATABASE_URL=file:/tmp/heroai-editor-conflict-final.db BRAND_ASSET_ROOT=/tmp/heroai-editor-conflict-assets-final npx tsx scripts/verify-brand-asset-api.ts
npx tsx scripts/verify-logo-project-default.ts
DATABASE_URL=file:/tmp/heroai-editor-conflict-final.db BRAND_ASSET_ROOT=/tmp/heroai-editor-conflict-assets-final npx tsx scripts/verify-logo-export.ts
npx tsx scripts/verify-logo-render.ts
npx tsx scripts/verify-logo-client-contract.ts
npx tsx scripts/verify-mobile-sheet.ts
```

Expected: every script prints its named all-checks-passed line with zero failures.

- [ ] **Step 3: Run adjacent regressions, generation, build, and typecheck**

Run:

```bash
npx tsx scripts/verify-editor-projects.ts
npx tsx scripts/verify-render-duration-bill.ts
npx tsx scripts/verify-clip-charge.ts
npx tsx scripts/verify-media-reference-graph.ts
npx tsx scripts/verify-media-cleanup-mode.ts
DATABASE_URL=file:/tmp/heroai-editor-conflict-final.db npx prisma generate
DATABASE_URL=file:/tmp/heroai-editor-conflict-final.db npm run build
npx tsc --noEmit --pretty false
```

Expected: regression scripts, Prisma generation, and build pass. The only accepted TypeScript failure is `src/app/api/payments/checkout/route.ts:129`.

- [ ] **Step 4: Replay adversarial persistence scenarios**

The final report must include observed outputs for:

- network failure with stale local/no user edit, then server revision 5: server wins;
- missing/corrupt journal with watermark 1: editor stays locked and never applies defaults;
- trusted local at base 4 and server 5: dialog opens;
- choose local while another tab advances server: first PATCH gets 409 and dialog refreshes;
- choose server: zero draft PATCH calls and journal cleared;
- failed journal write: no older cache replaces a newer in-memory edit;
- async settings/default hydration: no journal created;
- StrictMode remount: no duplicate POST, PATCH, history tag, or choice action;
- editor controls remain inert until bootstrap/choice completes.

- [ ] **Step 5: Request independent full-branch review**

Review the merge-base-to-HEAD diff against:

- `docs/superpowers/specs/2026-07-15-editor-project-conflict-resolution-design.md`
- `docs/superpowers/plans/2026-07-15-editor-project-conflict-resolution.md`
- the original Responsive Logo Overlay spec and plan.

Critical and Important findings must be fixed with a new RED regression and re-reviewed. A genuinely new persistence architecture failure after the prior three-attempt stop condition must be reported to the user instead of receiving another speculative patch.

- [ ] **Step 6: Refresh QA/Tailscale handoff**

Run the current branch on `0.0.0.0:3007`, obtain the Tailscale IPv4 from `tailscale ip -4` or a verified active Tailscale interface if the CLI retains its known registry crash, and report:

- URL `/video-editor?ui=v2`;
- branch and commit SHA;
- disposable environment-variable names only;
- authenticated fixture scope;
- which browser/device interactions passed and which remain environment-blocked.

Never expose credentials, private asset paths, or production data.

- [ ] **Step 7: Finish without automatic deployment**

Use `superpowers:verification-before-completion`, then `superpowers:finishing-a-development-branch`. Present merge, PR, keep, and discard choices only after fresh verification and clean review. Do not deploy or merge without the user's explicit selection.

---

## Plan self-review coverage map

- Trusted user-only provenance: Tasks 1 and 3.
- Server observed-revision safety: Task 2 and Task 3 local choice.
- Fail-closed loading and explicit Retry: Task 3.
- Local/server explicit actions and 409 refresh: Task 3.
- Blocking accessible desktop/mobile dialog and history containment: Task 4.
- No draft-content telemetry or UI leakage: Tasks 1, 3, and 4.
- Logo Overlay/billing/privacy regressions and authenticated QA caveat: Task 5.
