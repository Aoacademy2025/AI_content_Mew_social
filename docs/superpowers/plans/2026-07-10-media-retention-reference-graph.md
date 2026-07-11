# Media Retention, Reference Graph, Quarantine, and Expired Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce FREE/PRO/BUSINESS media retention as 3/7/14 days across Gallery, VideoJob previews, project drafts, and render work without allowing a filesystem-age rule to delete live media.

**Architecture:** Persist immutable expiry on completed VideoJobs, build one fail-closed reference graph from all database owners, resolve each file's effective expiry as the latest valid owner expiry, and replace direct deletion with rechecked quarantine plus a 24-hour purge. APIs expose a typed media state so the editor displays expired or unexpectedly missing previews without rendering a broken player.

**Tech Stack:** Prisma/SQLite, TypeScript, Node filesystem APIs, Next.js route handlers, React editor v2, tsx verification scripts.

## Global Constraints

- This plan starts only after the production containment plan passes. `media-cleanup` remains dry-run throughout implementation and the first reviewed production cycle.
- Retention is fixed at FREE 3, PRO 7, BUSINESS 14 days via `storageDaysForPlan()` / `videoExpiryFor()`.
- Project activity, save, or open time never renews media. `VideoJob.mediaExpiresAt` is frozen at job completion.
- `Video.expiresAt` stays authoritative for Gallery media. A null expiry is protected until the reviewed backfill assigns one.
- Apply mode aborts on any DB query, JSON parse, path validation, or scan error; zero files move on an incomplete graph.
- Do not rotate, replace, print, or change the Discord webhook.
- No permanent deletion occurs less than 24 hours after quarantine, and no production apply is enabled by this code plan alone.

---

### Task 1: Persist canonical VideoJob expiry

**Files:**

- Modify: `prisma/schema.prisma:193-218`
- Create: `src/lib/media-retention.ts`
- Create: `scripts/verify-media-retention.ts`

- [ ] Add the nullable indexed expiry field.

```prisma
model VideoJob {
  // existing fields
  mediaExpiresAt DateTime?

  @@index([mediaExpiresAt])
}
```

- [ ] Write failing pure assertions in `scripts/verify-media-retention.ts` for all plan boundaries, null expiry protection, and multiple-owner effective expiry.

```ts
import assert from "node:assert/strict";
import { effectiveMediaExpiry, mediaReferenceIsLive } from "../src/lib/media-retention";

const from = new Date("2026-07-01T00:00:00.000Z");
assert.equal(effectiveMediaExpiry([{ expiresAt: new Date("2026-07-04T00:00:00Z") }])?.toISOString(), "2026-07-04T00:00:00.000Z");
assert.equal(effectiveMediaExpiry([{ expiresAt: new Date("2026-07-04T00:00:00Z") }, { expiresAt: new Date("2026-07-15T00:00:00Z") }])?.toISOString(), "2026-07-15T00:00:00.000Z");
assert.equal(effectiveMediaExpiry([{ expiresAt: null }]), null, "null means conservatively protected");
assert.equal(mediaReferenceIsLive({ expiresAt: new Date(from.getTime() + 3 * 86_400_000) }, from), true);
console.log("PASS media retention resolver");
```

- [ ] Run: `npx tsx scripts/verify-media-retention.ts`

Expected: module-not-found failure for `src/lib/media-retention.ts`.

- [ ] Implement focused, side-effect-free types and helpers. Null expiry must mean protected/unknown, not expired.

```ts
import { storageDaysForPlan, videoExpiryFor } from "@/lib/plan-limits";

export type MediaReference = {
  ownerKind: "video" | "video-job" | "project-draft" | "render-job" | "generated-image";
  ownerId: string;
  expiresAt: Date | null;
  alwaysProtect?: boolean;
};

export function expiryForMedia(plan: string, producedAt: Date): Date {
  return videoExpiryFor(plan, producedAt);
}

export function effectiveMediaExpiry(refs: Array<Pick<MediaReference, "expiresAt" | "alwaysProtect">>): Date | null {
  if (refs.some((ref) => ref.alwaysProtect || ref.expiresAt === null)) return null;
  return refs.reduce<Date | null>((latest, ref) => !latest || ref.expiresAt! > latest ? ref.expiresAt : latest, null);
}

export function mediaReferenceIsLive(ref: Pick<MediaReference, "expiresAt" | "alwaysProtect">, now = new Date()): boolean {
  return ref.alwaysProtect === true || ref.expiresAt === null || ref.expiresAt.getTime() >= now.getTime();
}

export { storageDaysForPlan };
```

- [ ] Run `npx prisma generate && npx tsx scripts/verify-media-retention.ts && npx tsc --noEmit`.

Expected: PASS and exit 0.

- [ ] Commit: `git commit -m "feat(media): add canonical VideoJob media expiry"`.

### Task 2: Stamp expiry atomically when a VideoJob finishes

**Files:**

- Modify: `src/lib/mcp/video-job.ts:51-79`
- Create: `scripts/verify-video-job-expiry.ts`

- [ ] Create a temporary SQLite database and write an integration assertion that a FREE job finishing at a fixed clock gets exactly three days, a BUSINESS job gets fourteen days, and later plan changes do not update the stored value.

Run setup:

```bash
rm -f /tmp/heroai-video-job-expiry.db
DATABASE_URL=file:/tmp/heroai-video-job-expiry.db npx prisma db push --skip-generate
DATABASE_URL=file:/tmp/heroai-video-job-expiry.db npx tsx scripts/verify-video-job-expiry.ts
```

Expected before implementation: assertion failure because `mediaExpiresAt` remains null.

- [ ] Change `finishJob` to accept an injected clock for deterministic tests, read the owner plan, calculate once, and write `finishedAt` and `mediaExpiresAt` in the same update.

```ts
export async function finishJob(
  id: string,
  output: { videoUrl: string; videoId?: string } & Record<string, unknown>,
  opts: { now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  const owner = await prisma.videoJob.findUnique({
    where: { id },
    select: { user: { select: { plan: true } } },
  });
  if (!owner) throw new Error("video_job_not_found");
  const mediaExpiresAt = videoExpiryFor(owner.user.plan, now);
  const job = await prisma.videoJob.update({
    where: { id },
    data: {
      status: "done",
      progress: 100,
      outputJson: JSON.stringify(output),
      videoId: output.videoId ?? null,
      finishedAt: now,
      mediaExpiresAt,
    },
  });
  // existing project update follows unchanged
}
```

- [ ] Run the integration assertion twice to prove rerunning the verifier cleans up its rows and produces the same result, then run `npx tsc --noEmit`.

- [ ] Commit: `git commit -m "feat(media): stamp preview expiry at job completion"`.

### Task 3: Add conservative, report-first expiry backfill

**Files:**

- Create: `src/lib/media-expiry-backfill.ts`
- Create: `scripts/backfill-media-expiry.ts`
- Create: `scripts/verify-media-expiry-backfill.ts`

- [ ] Implement a pure planner returning rows with `ownerPlan`, `baseAt`, `calculatedExpiresAt`, `alreadyExpired`, and `reason`. For legacy VideoJobs, base time priority is `finishedAt ?? updatedAt ?? createdAt`. For Videos, base time is `createdAt`.

- [ ] Make the CLI default to JSON dry-run. Require both `--apply` and `--report-sha256=<hash-of-reviewed-dry-run>` before update. Backfill only null fields and use `updateMany({ where: { id, mediaExpiresAt: null } })` so concurrent changes are not overwritten.

```ts
if (!apply) {
  process.stdout.write(JSON.stringify({ mode: "dry-run", rows, sha256 }, null, 2));
  return;
}
if (expectedHash !== sha256) throw new Error("reviewed report hash does not match current plan");
```

- [ ] Tests must prove: dry-run changes zero rows; current plan is used only as the documented historical fallback; already-expired rows are reported; apply writes expiry but deletes no row/file; a second apply updates zero rows.

- [ ] Run:

```bash
DATABASE_URL=file:/tmp/heroai-media-backfill.db npx prisma db push --skip-generate
DATABASE_URL=file:/tmp/heroai-media-backfill.db npx tsx scripts/verify-media-expiry-backfill.ts
npx tsc --noEmit
```

- [ ] Commit: `git commit -m "feat(media): add reviewed expiry backfill"`.

### Task 4: Build the complete fail-closed reference graph

**Files:**

- Create: `src/lib/media-reference-graph.ts`
- Create: `scripts/verify-media-reference-graph.ts`
- Modify: `src/lib/media-cleanup.ts`

- [ ] Extract and export canonical URL parsing/collection from `media-cleanup.ts`. Use keys of the form `renders/<filename>` and `stocks/<filename>`; reject encoded traversal, separators in a basename, symlinks, and paths outside the configured roots.

- [ ] Define the graph contract.

```ts
export type MediaGraph = {
  refs: Map<string, MediaReference[]>;
  errors: Array<{ ownerKind: MediaReference["ownerKind"]; ownerId: string; field: string; code: string }>;
  scannedOwners: Record<MediaReference["ownerKind"], number>;
};

export async function buildMediaReferenceGraph(now = new Date()): Promise<MediaGraph>;
```

- [ ] Query and collect these owners with explicit `select` clauses:

  - all `Video` media fields/nested configs, with `expiresAt`; null means protected;
  - done `VideoJob.outputJson`, with `mediaExpiresAt`; null means protected;
  - `EditorProject.draftJson`, using owner plan and each direct file's mtime plus 3/7/14 days; active/latest job references use the job expiry instead;
  - QUEUED/RUNNING `RenderJob.payload` and `videoUrl` with `alwaysProtect: true`;
  - `GeneratedImage.url` with `alwaysProtect: true`;
  - low-resolution preview filenames and `.normalized` stock companions as derived references.

- [ ] Do not silently return null on malformed JSON. Add a graph error for the owning row. Dry-run reports it; apply must reject the whole graph.

- [ ] The verification script must cover all locked cases: FREE/PRO/BUSINESS boundary, old mtime overridden by live Gallery expiry, opening/saving project does not extend expiry, two owners use later expiry, queued/running render always protected, derived previews/normalized files protected, malformed JSON creates an error.

- [ ] Run: `npx tsx scripts/verify-media-reference-graph.ts && npx tsc --noEmit`.

- [ ] Commit: `git commit -m "feat(media): build complete retention reference graph"`.

### Task 5: Replace direct deletion with manifest and quarantine

**Files:**

- Modify: `src/lib/media-cleanup.ts`
- Modify: `scripts/media-cleanup.ts`
- Modify: `src/app/api/admin/cleanup/route.ts`
- Create: `src/lib/media-quarantine.ts`
- Create: `scripts/verify-media-quarantine.ts`

- [ ] Replace `FileCandidate` with a stable manifest record containing `key`, `absolutePath`, `sizeBytes`, `mtimeMs`, `effectiveExpiresAt`, `reason`, and `fingerprint` (`sha256` over key/size/mtime, not file contents).

- [ ] Eligibility rules:

  - at least one reference: eligible only when every reference is expired;
  - zero references: eligible only after 14 days, the maximum plan window, never the old 3-day global default;
  - unknown/null expiry, active RenderJob, graph error, lstat error, symlink, or out-of-root path: protected/skipped;
  - `tmp` cleanup remains a separate explicitly selected path and never shares customer-media apply logic.

- [ ] Make `getMediaCleanupPlan()` return the graph error list and manifest hash. `applyMediaCleanupPlan()` becomes async and must rebuild the graph immediately before each batch, require the reviewed hash, re-lstat each candidate, and move eligible files with `fs.rename` into `.media-quarantine/<runId>/<area>/`.

```ts
if (graph.errors.length > 0) throw new Error(`media graph incomplete: ${graph.errors.length} error(s)`);
if (reviewedHash !== plan.manifestSha256) throw new Error("reviewed manifest hash mismatch");
```

- [ ] Write a quarantine manifest atomically after all moves. If manifest write fails, restore moved files before returning failure. Record counts/bytes for scanned, protected, expired, quarantined, restored, purged, skipped, and errors.

- [ ] After a successful dry-run or apply, atomically write `.ops-metrics/media-health.json` with sanitized counts only: `generatedAt`, `missingBeforeExpiry`, `expired`, `protected`, `candidates`, and `graphErrors`. Do not include user IDs, paths, URLs, or owner data. A failed/incomplete graph must not replace the last good metrics file.

- [ ] Add `--purge-quarantine` as a separate command. It deletes only entries older than 24 hours whose current graph remains unreferenced/expired and whose quarantine fingerprint still matches. Add `--restore-run=<runId>` for reversible restore; collision must skip and report rather than overwrite.

- [ ] Change the admin DELETE route to require `{ apply: true, manifestSha256 }`; dry-run remains GET/default. The route must never invoke permanent purge.

- [ ] In `scripts/media-cleanup.ts`, call `writeCronHeartbeat("media-cleanup")` only after the full dry-run/apply and metrics write succeed. An incomplete graph, quarantine rollback, or metrics failure exits non-zero without advancing the heartbeat.

- [ ] Tests use a temporary cwd and prove: default dry-run mutates zero files; malformed JSON yields zero moves; reviewed hash mismatch yields zero moves; reference added after planning prevents move; symlink/traversal is rejected; restore works; purge before 24 hours deletes nothing; purge after 24 hours only deletes unchanged unreferenced entries.

- [ ] Run: `npx tsx scripts/verify-media-quarantine.ts && npx tsc --noEmit && git diff --check`.

- [ ] Commit: `git commit -m "feat(media): quarantine cleanup with recheck and restore"`.

### Task 6: Expose machine-readable media state

**Files:**

- Modify: `src/lib/media-retention.ts`
- Modify: `src/app/api/videos/jobs/[id]/route.ts:18-56`
- Modify: `src/lib/editor-projects.ts`
- Modify: `src/app/api/editor-projects/[id]/route.ts:23-36`
- Create: `scripts/verify-project-media-state.ts`

- [ ] Add the shared response type and pure resolver. Expiry wins over filesystem missing after the timestamp; missing before expiry is an incident state.

```ts
export type ProjectMediaState =
  | { status: "available"; expiresAt: string }
  | { status: "expired"; expiredAt: string; canRerender: true }
  | { status: "missing"; canRerender: boolean; supportCode: string };
```

- [ ] For local `/api/renders/` and `/renders/` URLs, resolve only under `public/renders` and use `lstat().isFile()` with non-zero size. External URLs are not synchronously fetched by the hot poll; report availability by expiry and leave remote health to telemetry/recovery discovery.

- [ ] Add `mediaExpiresAt` to the narrow VideoJob select and return `mediaState` on done jobs. Do not add `inputJson` to the hot poll.

- [ ] A legacy done job with null `mediaExpiresAt` is never called expired. Until backfill completes, return `{ status: "missing", canRerender: true, supportCode: "MEDIA_EXPIRY_UNKNOWN" }` and do not render its player; Task 8 orders backfill before this API/UI is enabled so this should be an exception-only support state.

- [ ] Add `getEditorProjectWithMediaState(userId, projectId)` that resolves `activeExportJobId ?? activeJobId` and returns `previewMediaState`; use it only for detail GET, not the project-list query.

- [ ] Verify available, exact-boundary expired, missing-before-expiry, missing-after-expiry, traversal URL, and owner isolation. Run `npx tsx scripts/verify-project-media-state.ts && npx tsc --noEmit`.

- [ ] Commit: `git commit -m "feat(media): expose project preview media state"`.

### Task 7: Render explicit expired and missing states in editor v2

**Files:**

- Modify: `src/app/(dashboard)/video-editor/_v2/useV2Job.ts`
- Modify: `src/app/(dashboard)/video-editor/_v2/useV2Project.ts`
- Modify: `src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx`
- Create: `src/app/(dashboard)/video-editor/_v2/ExpiredPreviewView.tsx`
- Modify: `src/app/(dashboard)/video-editor/_v2/PostPhase.tsx`
- Modify: `src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx`
- Create: `scripts/verify-expired-preview-ui.ts`

- [ ] Add `mediaState: ProjectMediaState | null` to `V2JobState` and propagate it through every full state assignment. Do not overload `phase`; a completed job remains done while its media state explains availability.

- [ ] In `EditorV2Shell`, branch before `PostPhase`/`ExportedView`:

```tsx
if (job.phase === "done" && job.mediaState?.status !== "available") {
  return <ExpiredPreviewView state={job.mediaState} onRerender={() => { reset(); setStep(1); }} />;
}
```

- [ ] Exact expired copy: `ไฟล์ Preview หมดอายุแล้วตามระยะเวลาของแพ็กเกจ กดสร้าง Preview ใหม่ได้`. CTA: `สร้าง Preview ใหม่`. Preserve the draft/script/settings state; the action must not submit until the user confirms the normal render flow.

- [ ] Missing-before-expiry copy must state that the file is unexpectedly unavailable, show `supportCode`, and offer both rerender and support actions. Never label it normal expiry.

- [ ] Add a defensive `onError` transition around preview `<video>` elements so a file disappearing after the API response swaps to missing state instead of leaving a broken player.

- [ ] The UI verification script should render the state-selection pure helper or server-render the view and assert the expired copy, support code, no `<video>` for unavailable states, and rerender callback presence.

- [ ] Run `npx tsx scripts/verify-expired-preview-ui.ts && npx tsc --noEmit`.

- [ ] Commit: `git commit -m "feat(editor): show expired and missing preview states"`.

### Task 8: Production dry-run rollout and apply gate

**Files:**

- Modify only after review: production schema and PM2 process list
- Produce outside repository: `/root/heroai-media-rollout/<timestamp>/`

- [ ] Ship Tasks 1–3 as the first reviewed PR: additive schema, finish-time stamping, and report-first backfill only. Keep the new API/UI/reference graph undeployed and `media-cleanup` paused/dry-run.

- [ ] Deploy that PR, run the backfill dry-run, store its hash, and review counts/already-expired rows before `--apply`.

- [ ] Apply only the nullable expiry backfill with the reviewed report hash. Re-run discovery and confirm zero null completed-job expiries except rows explicitly reported as invalid.

- [ ] Ship Tasks 4–7 as the second reviewed PR only after the backfill check passes. Deploy the reference graph/API/UI with `media-cleanup` still dry-run.

- [ ] Run one complete scheduled dry-run cycle. Manually sample every owner kind and all candidates whose effective expiry is within one hour of now. Any graph error or reference mismatch blocks apply.

- [ ] Enable quarantine apply in a separate reviewed change by restoring `--apply` plus the reviewed-manifest mechanism. Monitor one full 14-day retention cycle while permanent purge remains disabled.

- [ ] Enable 24-hour purge only after restore testing on a production copy and a clean cycle. Never combine the first quarantine move and first purge in the same window.

## Final Verification

- [ ] Run `npx prisma validate && npx prisma generate && npx tsc --noEmit`.
- [ ] Run all new focused verification scripts twice against clean temp databases/directories.
- [ ] Run existing regression checks: `npx tsx scripts/verify-render-queue.ts`, editor-project verification scripts, subtitle invariant verification, and render-receipt verification.
- [ ] Run `git diff --check` and confirm no media-cleanup apply flag is enabled in the containment branch.
- [ ] Acceptance: no unexpired owner is selected; 3/7/14 boundaries pass; active-project saves do not renew media; quarantine restores; unavailable previews never render a broken player.
