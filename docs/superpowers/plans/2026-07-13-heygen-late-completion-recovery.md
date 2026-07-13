# HeyGen Late-Completion Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HeyGen avatar generation resumable across long provider waits and worker restarts without duplicate provider spend, add fail-closed recovery tooling, and enforce an empty-queue production deploy gate.

**Architecture:** Persist a versioned avatar checkpoint on `VideoJob`, park non-terminal provider work in an internal `waiting_provider` state, and atomically reclaim due waits for one bounded status/composite step. Shared status/drain helpers keep APIs, cancellation, retention, and queue accounting consistent; a dry-run-first recovery command reactivates only legacy jobs that have no newer successful duplicate.

**Tech Stack:** Next.js 15 App Router, TypeScript, Prisma 6 + SQLite/WAL, PM2 workers, existing `tsx` verification scripts, HeyGen REST API, Nginx.

## Global Constraints

- Production has exactly one `mcp-video-worker` process; keep in-process concurrency and guarded claims, not PM2 multi-instance orchestration.
- Never retry a HeyGen generate request whose outcome may have spent credits.
- Never log API keys or signed HeyGen video URLs.
- `waiting_provider` counts as in-flight internally but is returned as `processing` to existing clients.
- Preserve current clip/minute/credit accounting; resume must not reserve or refund the base render twice.
- Add only nullable SQLite columns; `prisma db push` must remain additive without `--accept-data-loss`.
- Production restart is forbidden while `VideoJob` has `queued|processing|waiting_provider` rows or `RenderJob` has `QUEUED|RUNNING` rows.
- Never cancel user work to make a deployment queue empty.
- The three audited `sumawad` timeout rows are superseded retries of the same project/script and must receive zero recovery writes.
- Keep unrelated untracked workspace files untouched.

## File Structure

- Create `src/lib/mcp/avatar-provider-checkpoint.ts`: versioned checkpoint types, parser, provider backoff, input fingerprint.
- Create `src/lib/mcp/avatar-provider-resume.ts`: one-step HeyGen wait/tail/composite state machine with injected I/O.
- Create `src/lib/render-deploy-drain.ts`: shared DB-backed drain guard and typed error.
- Create `src/lib/mcp/legacy-avatar-recovery.ts`: validated legacy reconstruction and superseded detection.
- Create `scripts/verify-avatar-provider-checkpoint.ts`: pure checkpoint/backoff/fingerprint verifier.
- Create `scripts/verify-avatar-provider-resume.ts`: fake-provider no-regeneration/restart/cancel verifier.
- Create `scripts/verify-render-deploy-drain.ts`: temporary-SQLite drain and exact-refund verifier.
- Create `scripts/verify-legacy-avatar-recovery.ts`: dry-run, ownership, media, superseded, idempotency verifier.
- Create `scripts/set-render-deploy-drain.ts`: production operator `status|on|off` command.
- Create `scripts/check-empty-render-queues.ts`: fail-closed queue-zero command.
- Create `docs/ops/heygen-late-completion-rollout.md`: first-rollout Nginx bootstrap, deploy, rollback, and incident verification.
- Modify `prisma/schema.prisma`: nullable checkpoint and next-poll fields.
- Modify `src/lib/mcp/video-job.ts`: waiting lifecycle, guarded claim/park, restart recovery, public normalization, finish cleanup.
- Modify `src/lib/mcp/avatar-steps.ts`: expose bounded generate/status/audio/composite primitives without changing provider error mapping.
- Modify `src/lib/mcp/orchestrator.ts`: write prepared checkpoint, park after one generate, resume from checkpoint, share post-avatar finalization.
- Modify `scripts/mcp-video-worker.ts`: claim queued or due-provider work without occupying a slot while parked.
- Modify `src/app/api/videos/jobs/[id]/route.ts`, `src/app/api/videos/jobs/route.ts`, and `src/app/api/[transport]/route.ts`: normalized status, cancellation, in-flight/drain behavior.
- Modify `src/lib/render/job-store.ts` and `src/app/api/videos/render/route.ts`: authoritative drain checks around reservation/enqueue.
- Modify `src/lib/media-reference-graph.ts` and `src/app/api/admin/insights/route.ts`: waiting-provider retention and reporting.
- Modify `deploy/nginx.conf`, `deploy/deploy.sh`, `package.json`, and relevant existing verify scripts.

---

### Task 1: Versioned checkpoint contract and additive schema

**Files:**
- Create: `src/lib/mcp/avatar-provider-checkpoint.ts`
- Create: `scripts/verify-avatar-provider-checkpoint.ts`
- Modify: `prisma/schema.prisma`
- Modify: `package.json`

**Interfaces:**
- Produces: `AvatarProviderCheckpointV1`, `parseAvatarProviderCheckpoint(raw)`, `serializeAvatarProviderCheckpoint(value)`, `providerPollDelayMs(startedAtMs, nowMs, retryAfterSec?)`, and `videoJobInputFingerprint(inputJson)`.
- Consumes: `OrchCaption` from `src/lib/mcp/orchestrator-steps.ts`; no database I/O.

- [ ] **Step 1: Write the failing pure verifier**

Create fixtures for a valid wait checkpoint, malformed JSON, a wait phase missing its required
provider ID, a valid `intro_generate` checkpoint without an ID, three backoff bands, and stable
input fingerprints independent of JSON key order:

```ts
import assert from "node:assert/strict";
import {
  parseAvatarProviderCheckpoint,
  providerPollDelayMs,
  videoJobInputFingerprint,
} from "../src/lib/mcp/avatar-provider-checkpoint";

const valid = JSON.stringify({
  version: 1,
  provider: "heygen",
  phase: "intro_wait",
  providerStartedAt: "2026-07-13T08:00:00.000Z",
  providerDeadlineAt: "2026-07-13T10:00:00.000Z",
  baseUrl: "/api/renders/base.mp4",
  voiceUrl: "/api/renders/voice.mp3",
  audioDurationMs: 90000,
  captions: [{ text: "ทดสอบ", startMs: 0, endMs: 900 }],
  words: [],
  fullText: "ทดสอบ",
  baseConfig: { voiceFile: "/api/renders/voice.mp3" },
  avatar: { mode: "full", id: "avatar-1", introSecs: 5, tailSecs: 5,
    layout: { scale: 1, offsetX: 0, offsetY: 0 }, introVideoId: "hg-1" },
});

assert.equal(parseAvatarProviderCheckpoint(valid)?.avatar.introVideoId, "hg-1");
assert.equal(parseAvatarProviderCheckpoint("{"), null);
assert.equal(parseAvatarProviderCheckpoint(JSON.stringify({ version: 1 })), null);
assert.equal(providerPollDelayMs(0, 9 * 60_000), 15_000);
assert.equal(providerPollDelayMs(0, 20 * 60_000), 30_000);
assert.equal(providerPollDelayMs(0, 40 * 60_000), 60_000);
assert.equal(providerPollDelayMs(0, 1_000, 120), 120_000);
assert.equal(videoJobInputFingerprint('{"script":"x","avatarMode":"full"}'),
  videoJobInputFingerprint('{"avatarMode":"full","script":"x"}'));
console.log("ALL PASS");
```

- [ ] **Step 2: Run the verifier and confirm the red state**

Run: `npx tsx scripts/verify-avatar-provider-checkpoint.ts`

Expected: FAIL with `Cannot find module '../src/lib/mcp/avatar-provider-checkpoint'`.

- [ ] **Step 3: Add the nullable schema fields and checkpoint implementation**

Add to `VideoJob`:

```prisma
providerCheckpointJson String?
providerNextPollAt     DateTime?
```

Implement strict structural parsing rather than unsafe casts. Canonicalize fingerprint input by
recursively sorting object keys before SHA-256 hashing; include the complete normalized `inputJson`
so retries with different avatar/layout settings are not treated as duplicates.

```ts
export function providerPollDelayMs(startedAtMs: number, nowMs: number, retryAfterSec?: number): number {
  const age = Math.max(0, nowMs - startedAtMs);
  const scheduled = age < 10 * 60_000 ? 15_000 : age < 30 * 60_000 ? 30_000 : 60_000;
  const retry = Number.isFinite(retryAfterSec) && Number(retryAfterSec) > 0
    ? Math.min(120_000, Math.round(Number(retryAfterSec) * 1000)) : 0;
  return Math.max(scheduled, retry);
}
```

- [ ] **Step 4: Generate Prisma client and verify green**

Run:

```bash
npx prisma generate
npx tsx scripts/verify-avatar-provider-checkpoint.ts
```

Expected: Prisma generation exits 0 and verifier prints `ALL PASS`.

- [ ] **Step 5: Add the package command and commit**

Add `"verify:avatar-provider-checkpoint": "tsx scripts/verify-avatar-provider-checkpoint.ts"`.

```bash
git add prisma/schema.prisma src/lib/mcp/avatar-provider-checkpoint.ts scripts/verify-avatar-provider-checkpoint.ts package.json
git commit -m "feat: add durable avatar provider checkpoint"
```

---

### Task 2: Waiting-provider lifecycle and worker claims

**Files:**
- Modify: `src/lib/mcp/video-job.ts`
- Modify: `scripts/mcp-video-worker.ts`
- Modify: `scripts/verify-mcp-videojob.ts`

**Interfaces:**
- Consumes: checkpoint parser/serializer from Task 1.
- Produces: `VIDEO_JOB_INFLIGHT_STATUSES`, `toPublicVideoJobStatus(status)`, `saveProviderCheckpoint(id, checkpoint)`, `parkProviderJob(id, checkpoint, nextPollAt)`, and `claimNextRunnableJob(now?)`.

- [ ] **Step 1: Extend the DB verifier with waiting/claim/restart/finish cases**

Add assertions that:

```ts
const waiting = await createVideoJob(u.id, { script: "avatar" });
await claimNextRunnableJob();
await parkProviderJob(waiting.id, checkpoint, new Date("2026-07-13T09:00:00.000Z"));
assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: waiting.id } })).status, "waiting_provider");
assert.equal(await claimNextRunnableJob(new Date("2026-07-13T08:59:59.000Z")), null);
const resumed = await claimNextRunnableJob(new Date("2026-07-13T09:00:00.000Z"));
assert.equal(resumed?.id, waiting.id);
assert.equal(resumed?.status, "processing");
await finishJob(waiting.id, { videoUrl: "/api/renders/final.mp4" });
const finished = await prisma.videoJob.findUniqueOrThrow({ where: { id: waiting.id } });
assert.equal(finished.providerCheckpointJson, null);
assert.equal(finished.providerNextPollAt, null);
```

Also prove boot recovery parks a `processing` avatar/composite row with a valid wait/composite
checkpoint, fails a stranded generate phase with the explicit unknown-outcome error, and still
fails a post-render row without a checkpoint.

- [ ] **Step 2: Run the focused DB verifier red**

Run:

```bash
ROOT="$(pwd)"
rm -f prisma/test-mcp-provider.db
DATABASE_URL="file:$ROOT/prisma/test-mcp-provider.db" npx prisma db push --skip-generate
DATABASE_URL="file:$ROOT/prisma/test-mcp-provider.db?connection_limit=1" npx tsx scripts/verify-mcp-videojob.ts
```

Expected: FAIL because waiting lifecycle exports do not exist.

- [ ] **Step 3: Implement guarded lifecycle transitions**

Use these exact public contracts:

```ts
export const VIDEO_JOB_INFLIGHT_STATUSES = ["queued", "processing", "waiting_provider"] as const;

export function toPublicVideoJobStatus(status: string): string {
  return status === "waiting_provider" ? "processing" : status;
}

export async function saveProviderCheckpoint(id: string, checkpoint: AvatarProviderCheckpointV1) {
  return prisma.videoJob.updateMany({
    where: { id, status: "processing" },
    data: { providerCheckpointJson: serializeAvatarProviderCheckpoint(checkpoint) },
  });
}

export async function parkProviderJob(id: string, checkpoint: AvatarProviderCheckpointV1, nextPollAt: Date) {
  return prisma.videoJob.updateMany({
    where: { id, status: "processing" },
    data: { status: "waiting_provider", currentStep: "avatar", progress: 84,
      providerCheckpointJson: serializeAvatarProviderCheckpoint(checkpoint), providerNextPollAt: nextPollAt },
  });
}
```

`claimNextRunnableJob(now)` checks due `waiting_provider` first, then `queued`, and claims with an
`updateMany` guard. `finishJob` clears both provider fields in its existing terminal transaction.
Boot recovery converts only valid wait/composite checkpointed processing rows to
`waiting_provider`. A generate phase without its provider ID fails as unknown outcome and never
regenerates. Existing fail-closed behavior remains untouched for all other billable stages.

- [ ] **Step 4: Switch the worker dispatcher to the runnable claim**

Replace the queued-only import/call with `claimNextRunnableJob`. Keep sequential claims and the
existing `active` promise set. A parked orchestrator returns normally, freeing its slot.

- [ ] **Step 5: Run the DB verifier green**

Repeat the Step 2 commands.

Expected: all existing and new assertions print checkmarks and exit 0.

- [ ] **Step 6: Commit lifecycle support**

```bash
git add src/lib/mcp/video-job.ts scripts/mcp-video-worker.ts scripts/verify-mcp-videojob.ts
git commit -m "feat: add resumable provider wait lifecycle"
```

---

### Task 3: One-step HeyGen resume engine and orchestrator integration

**Files:**
- Create: `src/lib/mcp/avatar-provider-resume.ts`
- Create: `scripts/verify-avatar-provider-resume.ts`
- Modify: `src/lib/mcp/avatar-steps.ts`
- Modify: `src/lib/mcp/orchestrator.ts`
- Modify: `scripts/verify-preview-mode.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 checkpoint and Task 2 save/park/finish functions.
- Produces: `advanceAvatarProvider(checkpoint, deps)` returning `{ kind: "waiting"; checkpoint; retryAfterSec? }`, `{ kind: "ready"; checkpoint; compositeUrl }`, or `{ kind: "failed"; message }`.

- [ ] **Step 1: Write a fake-provider verifier**

Use injected functions and counters to prove a pending intro parks, a later completion resumes, a
worker restart does not call generate again, `bookend-both` generates the tail exactly once, and a
canceled save guard cannot reach composite:

```ts
let generateCalls = 0;
let compositeCalls = 0;
const deps = {
  now: () => new Date("2026-07-13T09:20:00.000Z"),
  generate: async () => { generateCalls++; return "hg-intro"; },
  poll: async (id: string) => id === "hg-intro"
    ? { status: "completed", videoUrl: "https://files2.heygen.ai/intro.mp4", errorMsg: null }
    : { status: "processing", videoUrl: null, errorMsg: null },
  composite: async () => { compositeCalls++; return "/api/renders/composite.mp4"; },
};
```

The verifier must assert `generateCalls === 0` when the checkpoint already contains
`introVideoId`, and `compositeCalls === 1` only after all required URLs are present.

- [ ] **Step 2: Run the provider verifier red**

Run: `npx tsx scripts/verify-avatar-provider-resume.ts`

Expected: FAIL with missing `avatar-provider-resume` module.

- [ ] **Step 3: Split bounded HeyGen primitives from the old long poll helper**

Export non-retrying `generateAvatarVideo`, one-request `pollAvatarOnce`, audio preparation, and
`compositeAvatarVideo` from `avatar-steps.ts`. Preserve `mapHeygenPollResponse` behavior and keep
the existing `runAvatarComposite` wrapper for callers not yet migrated.

```ts
export type AvatarPollOnce = {
  status: string;
  videoUrl: string | null;
  errorMsg: string | null;
  retryAfterSec?: number;
};
```

- [ ] **Step 4: Implement the one-step state machine**

`advanceAvatarProvider` must never call generate when the relevant ID is already present. Before a
fresh intro/tail generate, the caller persists `intro_generate`/`tail_generate`; the returned ID is
then persisted with the matching wait phase. A resumed generate phase without an ID is an
unknown-outcome terminal error and must not call generate. The engine checks the absolute two-hour
deadline, persists intro/tail URLs in the returned checkpoint, and advances to composite only when
the mode's required URLs exist. Provider `failed` returns the existing error text;
pending/network/rate-limit returns `waiting`.

- [ ] **Step 5: Refactor orchestrator preparation and finalization**

At `runOrchestrator` entry, parse `job.providerCheckpointJson`. A valid checkpoint skips TTS,
stock, config, base render, quota refund, and HeyGen generate, then runs one advance step. For a
fresh avatar path:

1. Complete base render and existing one-time accounting.
2. Build/persist the prepared checkpoint with all post-avatar finalization data.
3. Persist `intro_generate`, generate once, then persist the first HeyGen ID with `intro_wait`.
4. Park immediately with the computed next poll time and return.

Extract the current preview/full code after avatar into one `finishPreparedVideoJob` helper used by
fresh and resumed paths. Do not call base refund, `/api/videos/render`, or HeyGen generate from the
resume path.

- [ ] **Step 6: Prove red-to-green and preview parity**

Run:

```bash
npx tsx scripts/verify-avatar-provider-resume.ts
DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-preview-mode.ts
```

Expected: provider verifier prints `ALL PASS`; existing preview-mode scenarios pass with no
duplicate render/generate calls.

- [ ] **Step 7: Add package command and commit**

Add `"verify:avatar-provider-resume": "tsx scripts/verify-avatar-provider-resume.ts"`.

```bash
git add src/lib/mcp/avatar-provider-resume.ts src/lib/mcp/avatar-steps.ts src/lib/mcp/orchestrator.ts scripts/verify-avatar-provider-resume.ts scripts/verify-preview-mode.ts package.json
git commit -m "feat: resume delayed HeyGen avatar jobs"
```

---

### Task 4: Public status, cancellation, limits, retention, and insights

**Files:**
- Modify: `src/app/api/videos/jobs/[id]/route.ts`
- Modify: `src/app/api/videos/jobs/route.ts`
- Modify: `src/app/api/[transport]/route.ts`
- Modify: `src/lib/media-reference-graph.ts`
- Modify: `src/app/api/admin/insights/route.ts`
- Modify: `scripts/verify-video-job-expiry.ts`
- Modify: `scripts/verify-media-reference-graph.ts`
- Modify: `scripts/verify-mcp-audit-status.ts`

**Interfaces:**
- Consumes: `VIDEO_JOB_INFLIGHT_STATUSES` and `toPublicVideoJobStatus` from Task 2.
- Produces: no new public API fields; existing clients continue to receive `processing`.

- [ ] **Step 1: Add failing waiting-provider surface/race assertions**

Cover:

- GET and MCP status normalize `waiting_provider` to `processing`.
- DELETE accepts `waiting_provider` and atomically moves it to `canceled`.
- late `parkProviderJob` and `finishJob` calls cannot resurrect cancellation.
- all per-user in-flight counts include waiting rows.
- media reference graph protects checkpoint base/voice/provider media while waiting.
- admin current processing count includes waiting rows without counting them as failures.

- [ ] **Step 2: Run the focused suites red**

Run:

```bash
DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-video-job-expiry.ts
DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-media-reference-graph.ts
npx tsx scripts/verify-mcp-audit-status.ts
```

Expected: at least one new waiting-provider assertion fails.

- [ ] **Step 3: Replace duplicated status literals with the shared constant**

Use `status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES] }` for the three jobs-route limits and MCP
limit. Normalize only at response boundaries. Extend DELETE's guarded predicate to include
`waiting_provider`; preserve the project rollback logic and checkpoint for audit.

- [ ] **Step 4: Protect checkpoint media and update insights**

Parse valid checkpoints in `media-reference-graph.ts` and add `baseUrl`, `voiceUrl`, intro URL, and
tail URL as exact owner keys. Include `waiting_provider` in the in-flight fallback query. In admin
insights, count it as processing/waiting, never failed; add a separate `waitingProvider` count so
operations can distinguish external wait from CPU render work.

- [ ] **Step 5: Run the focused suites green and commit**

Repeat Step 2. Expected: all scripts exit 0.

```bash
git add src/app/api/videos/jobs/[id]/route.ts src/app/api/videos/jobs/route.ts src/app/api/[transport]/route.ts src/lib/media-reference-graph.ts src/app/api/admin/insights/route.ts scripts/verify-video-job-expiry.ts scripts/verify-media-reference-graph.ts scripts/verify-mcp-audit-status.ts
git commit -m "fix: integrate provider waits with job consumers"
```

---

### Task 5: DB-backed render drain and fail-closed queue gate

**Files:**
- Create: `src/lib/render-deploy-drain.ts`
- Create: `scripts/verify-render-deploy-drain.ts`
- Create: `scripts/set-render-deploy-drain.ts`
- Create: `scripts/check-empty-render-queues.ts`
- Modify: `src/lib/mcp/video-job.ts`
- Modify: `src/lib/render/job-store.ts`
- Modify: `src/app/api/videos/jobs/route.ts`
- Modify: `src/app/api/[transport]/route.ts`
- Modify: `src/app/api/videos/render/route.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `RENDER_DEPLOY_DRAIN_KEY`, `RenderDeployDrainError`, `assertRenderEnqueueOpen(client?)`, `readRenderQueueCounts(client?)`.
- Consumes: Task 2 in-flight status constant.

- [ ] **Step 1: Write the drain verifier red**

Against a temporary SQLite DB, assert:

```ts
await prisma.siteConfig.upsert({
  where: { key: "render_deploy_drain" },
  update: { value: "1" },
  create: { key: "render_deploy_drain", value: "1" },
});
await assert.rejects(() => createVideoJob(user.id, { script: "blocked" }),
  (e: unknown) => e instanceof RenderDeployDrainError);
await assert.rejects(() => enqueueRenderJob({ userId: user.id, type: "RENDER", payload: { shortVideoConfig: {} } }),
  (e: unknown) => e instanceof RenderDeployDrainError);
assert.equal(await prisma.videoJob.count(), 0);
assert.equal(await prisma.renderJob.count(), 0);
```

Also assert queue check exits nonzero for each active status and zero only when both queues are
empty. Prove a drain race after an already-recorded reservation executes the exact existing refund
once.

- [ ] **Step 2: Run red**

Run: `DATABASE_URL="file:$(pwd)/prisma/test-render-drain.db" npx tsx scripts/verify-render-deploy-drain.ts`

Expected: FAIL with missing drain module.

- [ ] **Step 3: Implement the shared guard and operator commands**

Use the exact key `render_deploy_drain`. `assertRenderEnqueueOpen` reads `SiteConfig` on every
enqueue and throws a typed error with code `render_deploy_drain`. `readRenderQueueCounts` returns:

```ts
type RenderQueueCounts = {
  videoJobs: number;
  renderJobs: number;
  empty: boolean;
};
```

`set-render-deploy-drain.ts` accepts only `status`, `on`, or `off`; it prints no environment values.
`check-empty-render-queues.ts` prints counts and exits 2 when either count is nonzero.

- [ ] **Step 4: Guard every enqueue before charge and before insert**

Call the guard before quota checks in Web/MCP/render routes and again inside `createVideoJob` and
`enqueueRenderJob`. Map the typed error to HTTP 503 with `{ error: "render_maintenance",
retryable: true }`, and to the equivalent MCP in-band error. If the second render guard wins after
a reservation race, reuse `refundReservation` with `reservedMinutes`, `creditsSpent`, and
`creditsFromGranted`, then mark the typed error as refunded so outer catches do not refund again.

- [ ] **Step 5: Run green and commit**

Run:

```bash
DATABASE_URL="file:$(pwd)/prisma/test-render-drain.db" npx prisma db push --skip-generate
DATABASE_URL="file:$(pwd)/prisma/test-render-drain.db?connection_limit=1" npx tsx scripts/verify-render-deploy-drain.ts
```

Expected: `ALL PASS`, including exact-refund and queue-exit assertions.

Add package commands `verify:render-deploy-drain`, `ops:render-drain`, and
`ops:check-render-queues`, then commit:

```bash
git add src/lib/render-deploy-drain.ts src/lib/mcp/video-job.ts src/lib/render/job-store.ts src/app/api/videos/jobs/route.ts src/app/api/[transport]/route.ts src/app/api/videos/render/route.ts scripts/verify-render-deploy-drain.ts scripts/set-render-deploy-drain.ts scripts/check-empty-render-queues.ts package.json
git commit -m "feat: add empty-queue production drain gate"
```

---

### Task 6: Dry-run-first legacy recovery with superseded guard

**Files:**
- Create: `src/lib/mcp/legacy-avatar-recovery.ts`
- Create: `scripts/recover-heygen-timeout.ts`
- Create: `scripts/verify-legacy-avatar-recovery.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: checkpoint parser/fingerprint, direct HeyGen poll mapping, `parkProviderJob` lifecycle.
- Produces: `inspectLegacyAvatarRecovery(input, deps)` returning `recoverable|pending|superseded|rejected`, and `applyLegacyAvatarRecovery` guarded by the inspection receipt.

- [ ] **Step 1: Write recovery fixtures red**

Create temporary DB/media fixtures covering:

- dry-run makes zero writes;
- wrong owner/status/error/provider ID is rejected;
- missing base file or required render payload is rejected;
- newer `done` same-project/same-fingerprint row returns `superseded`;
- completed non-superseded fixture becomes `waiting_provider` exactly once under `--apply`;
- re-running apply is idempotent;
- logs contain no key or signed URL.

- [ ] **Step 2: Run red**

Run: `DATABASE_URL="file:$(pwd)/prisma/test-legacy-avatar-recovery.db" npx tsx scripts/verify-legacy-avatar-recovery.ts`

Expected: FAIL with missing recovery module.

- [ ] **Step 3: Implement inspection and apply as separate operations**

Require explicit pairs in the CLI:

```text
export JOB_ID="cmr-example-job-id"
export HEYGEN_VIDEO_ID="example-provider-video-id"
npx tsx scripts/recover-heygen-timeout.ts --job-id "$JOB_ID" --heygen-video-id "$HEYGEN_VIDEO_ID"
npx tsx scripts/recover-heygen-timeout.ts --apply --job-id "$JOB_ID" --heygen-video-id "$HEYGEN_VIDEO_ID"
```

Inspection reads only masked/provider-status fields, validates same-user `RenderJob`, checks local
media containment/existence, reconstructs only when `resolvedShortConfig`, `captionsData`, and voice
media are sufficient, and checks a newer successful fingerprint before provider/media work. Apply
uses one `updateMany` guard matching `failed`, `currentStep=avatar`, exact timeout error, and null
checkpoint. It writes a checkpoint and `waiting_provider`; it never calls HeyGen generate,
reserves quota, or moves `EditorProject` pointers directly.

- [ ] **Step 4: Run green and commit**

Repeat Step 2. Expected: `ALL PASS` and zero-write superseded fixture.

Add `"verify:legacy-avatar-recovery"` and `"ops:recover-heygen-timeout"`, then commit:

```bash
git add src/lib/mcp/legacy-avatar-recovery.ts scripts/recover-heygen-timeout.ts scripts/verify-legacy-avatar-recovery.ts package.json
git commit -m "feat: add guarded late HeyGen recovery tool"
```

---

### Task 7: Deployment bootstrap, automated restart gate, and ops runbook

**Files:**
- Modify: `deploy/nginx.conf`
- Modify: `deploy/deploy.sh`
- Create: `docs/ops/heygen-late-completion-rollout.md`
- Create: `scripts/verify-deploy-render-gate.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 5 queue checker/drain command.
- Produces: `REQUIRE_EMPTY_RENDER_QUEUES=1` deploy behavior and first-rollout maintenance marker instructions.

- [ ] **Step 1: Write source/fixture checks red**

The verifier loads fixture shell/config text and asserts the deploy script:

- checks queues immediately before `.next` swap/PM2 restart when the env flag is 1;
- aborts before restart on nonzero/unknown counts;
- never cancels jobs;
- leaves the old `.next` live on gate failure;
- documents how to clear both Nginx marker and DB drain after failure.

Run: `npx tsx scripts/verify-deploy-render-gate.ts`

Expected: FAIL because the deploy gate is absent.

- [ ] **Step 2: Add first-rollout Nginx marker guard**

Add a server-level guard to the maintained template:

```nginx
if (-f /var/www/ai-content/.deploy-maintenance) {
    return 503;
}
```

Document backing up and patching the active site config, running `nginx -t`, reloading, touching the
marker only after the queues first read zero, and rechecking zero after external traffic is blocked.
Internal worker traffic to `127.0.0.1:3000` bypasses Nginx.

- [ ] **Step 3: Gate the atomic swap/restart in deploy.sh**

When `REQUIRE_EMPTY_RENDER_QUEUES=1`, call
`npx tsx scripts/check-empty-render-queues.ts` after a successful staging build but before replacing
`.next`. If it exits nonzero, remove only `.next-staging`, print both counts, and exit without
swapping or restarting. The operator keeps drain/maintenance visible until explicitly cleared.

- [ ] **Step 4: Write exact rollout and rollback runbook**

Include commands for: production SHA, direct queue query, Nginx marker bootstrap, DB backup and
`PRAGMA quick_check`, deploy env, schema verification, PM2 health, drain clearing, read-only status
verification, recovery dry-run, and `.next.old` rollback. State explicitly that the audited
`sumawad` jobs must print `superseded` and receive no apply command.

- [ ] **Step 5: Run verifier green and commit**

Run: `npx tsx scripts/verify-deploy-render-gate.ts`

Expected: `ALL PASS`.

```bash
git add deploy/nginx.conf deploy/deploy.sh docs/ops/heygen-late-completion-rollout.md scripts/verify-deploy-render-gate.ts package.json
git commit -m "ops: gate deploys on empty render queues"
```

---

### Task 8: Full verification, review, integration, and production rollout

**Files:**
- Verify all files changed in Tasks 1–7.
- Production writes only after merge/deploy gates pass.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: reviewed branch, deployed resumable provider wait, and an incident dry-run record.

- [ ] **Step 1: Run focused new verifiers**

```bash
npm run verify:avatar-provider-checkpoint
npm run verify:avatar-provider-resume
npm run verify:render-deploy-drain
npm run verify:legacy-avatar-recovery
npx tsx scripts/verify-deploy-render-gate.ts
```

Expected: every command exits 0 with `ALL PASS`.

- [ ] **Step 2: Run existing regression suites**

Use a disposable SQLite database where required:

```bash
npm run verify:render-queue
DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-mcp-videojob.ts
DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-preview-mode.ts
DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-editor-projects.ts
DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-video-job-expiry.ts
DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-media-reference-graph.ts
npx tsx scripts/verify-heygen-poll-map.ts
npx tsc --noEmit
```

Expected: all scripts pass and TypeScript exits 0.

- [ ] **Step 3: Run production build**

Run: `BUILD_NO_LINT=1 npm run build`

Expected: exit 0 and `.next/BUILD_ID` exists.

- [ ] **Step 4: Review branch diff and request code review**

Run:

```bash
git diff --check origin/main...HEAD
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors, only scoped tracked changes, and unrelated untracked files remain
unmodified. Invoke `superpowers:requesting-code-review`, address findings with
`superpowers:receiving-code-review`, and rerun affected tests.

- [ ] **Step 5: Push branch, open PR, and merge only after checks**

```bash
git push -u origin mew/heygen-late-completion-recovery
gh pr create --base main --head mew/heygen-late-completion-recovery \
  --title "Make delayed HeyGen avatar jobs resumable" \
  --body "Adds durable HeyGen checkpoints, provider-wait resume, guarded legacy recovery, and an empty-queue production deploy gate."
```

Expected: PR checks green. Merge using the repository's normal reviewed flow; do not push directly
to `main`.

- [ ] **Step 6: Execute the first production queue-zero bootstrap**

Follow `docs/ops/heygen-late-completion-rollout.md` exactly:

1. Wait until both queue counts are zero; do not cancel jobs.
2. Enable the Nginx maintenance marker and recheck both counts are zero.
3. Back up SQLite and require `PRAGMA quick_check` = `ok`.
4. Deploy with `REQUIRE_EMPTY_RENDER_QUEUES=1`.
5. Verify schema, PM2 web/MCP/render workers, queue counts, and status API.
6. Remove Nginx marker and ensure DB drain is off.

Expected: no restart occurs unless both queue counts are zero.

- [ ] **Step 7: Run incident recovery in dry-run mode only**

Run the operator command for each audited mapping without `--apply`.

Expected: all three `sumawad` timeout rows report `superseded` by the newer successful same-project
retry; database status/output/project pointers remain unchanged. Do not run apply for these rows.

- [ ] **Step 8: Observe and close**

For at least one new delayed-provider fixture or real job, verify the DB transitions
`processing -> waiting_provider -> processing -> done`, only one HeyGen video ID is recorded, and
no terminal timeout occurs at ten minutes. Record sanitized job IDs/status/timing in the rollout
notes, then mark the incident resolved.
