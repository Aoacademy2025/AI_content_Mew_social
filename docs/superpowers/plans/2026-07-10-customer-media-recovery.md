# Customer Media Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover and restore media removed by the unsafe cleanup paths wherever retained local inputs make recovery possible, without charging customers, repeating paid generation, or overwriting newer working outputs.

**Architecture:** A read-only inventory creates a hashed, reviewable recovery report. Each missing asset receives a stable recovery key and one of four classifications: relink, local render/recomposite, render from stored config, or unrecoverable. Apply accepts only reviewed keys, records an idempotent recovery row, validates output, and uses compare-and-swap database updates. Recovery render jobs use a dedicated non-billable type and never touch quota/credit functions.

**Tech Stack:** Prisma/SQLite, TypeScript/tsx, existing RenderJob worker and Remotion core, ffprobe, Node filesystem APIs, internal HTTP health checks.

## Global Constraints

- Start only after containment is complete and the media reference graph is deployed in dry-run mode.
- Discovery is strictly read-only. No URL, file, quota, credit, notification, or status mutation may occur in discovery.
- Recovery never calls Kie, HeyGen generation, ElevenLabs, Gemini TTS, or any paid generation endpoint. Existing source assets may be locally rendered/composited.
- Recovery never reserves/refunds clips or minutes, changes `usageCount`/`minutesUsed`, spends credits, creates a `CreditLedger`, or creates a `ChargedClip`.
- Never overwrite a working newer output. Database updates compare the exact missing URL and captured row version (`updatedAt`).
- Do not notify customers until a recovery item has reached verified `recovered` or reviewed `unrecoverable` status.
- Do not rotate, replace, print, or change the Discord webhook.

---

### Task 1: Add a durable idempotent recovery ledger

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `src/lib/media-recovery-types.ts`
- Create: `scripts/verify-media-recovery-ledger.ts`

- [ ] Add an additive model. Keep the affected record as strings rather than a foreign key so the audit remains after a customer deletes a Video/project.

```prisma
model MediaRecovery {
  id             String   @id @default(cuid())
  recoveryKey    String   @unique
  userId         String
  affectedKind   String   // video | video-job
  affectedId     String
  missingUrl     String
  classification String   // relink | local-recomposite | config-render | unrecoverable
  status         String   @default("planned") // planned|queued|rendering|recovered|unrecoverable|failed
  sourceUrl      String?
  recoveredUrl   String?
  renderJobId    String?
  reportSha256   String
  error          String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  finishedAt     DateTime?

  @@index([userId, status])
  @@index([affectedKind, affectedId])
}
```

- [ ] Define discriminated report items in `media-recovery-types.ts` so classification-specific fields cannot be omitted.

```ts
export type RecoveryItem =
  | { recoveryKey: string; classification: "relink"; affected: AffectedMedia; candidateUrl: string }
  | { recoveryKey: string; classification: "local-recomposite" | "config-render"; affected: AffectedMedia; renderPayload: unknown; requiredUrls: string[] }
  | { recoveryKey: string; classification: "unrecoverable"; affected: AffectedMedia; missingRequiredUrls: string[]; reason: string };
```

- [ ] The ledger verifier must prove `recoveryKey` uniqueness, status transitions, and persistence after the affected Video row is deleted.

- [ ] Run:

```bash
rm -f /tmp/heroai-media-recovery.db
DATABASE_URL=file:/tmp/heroai-media-recovery.db npx prisma db push --skip-generate
DATABASE_URL=file:/tmp/heroai-media-recovery.db npx tsx scripts/verify-media-recovery-ledger.ts
npx tsc --noEmit
```

- [ ] Commit: `git commit -m "feat(recovery): add idempotent media recovery ledger"`.

### Task 2: Build read-only missing-media discovery

**Files:**

- Create: `src/lib/media-recovery-discovery.ts`
- Create: `scripts/media-recovery.ts`
- Create: `scripts/verify-media-recovery-discovery.ts`

- [ ] Reuse the canonical media URL/path resolver from `media-reference-graph.ts`; do not add a second permissive path parser.

- [ ] Inspect only:

  - local `Video.videoUrl`, `audioUrl`, `avatarVideoUrl`, `thumbnail`, and nested configs;
  - done `VideoJob.outputJson`, especially preview `videoUrl`, `voiceUrl`, `avatarVideoUrl`, `compositeBaseUrl`, `tailAvatarUrl`, and config source URLs;
  - `RenderJob.videoUrl` and payloads linked by `videoId` or `parentJobId`;
  - on-disk render/stock files and quarantine manifests.

- [ ] Apply retention eligibility before classification. A file missing after its effective 3/7/14-day expiry is a normal expired-media record, not a recovery candidate. Only `missingBeforeExpiry` incident items enter the recoverable/unrecoverable report; if an item expires before apply, mark it `skipped-expired` and do not restore it beyond plan retention.

- [ ] Build `recoveryKey = sha256(affectedKind + "\0" + affectedId + "\0" + field + "\0" + missingUrl)`. Sort report items by key before hashing the whole canonical JSON report.

- [ ] Classification must be deterministic:

  1. `relink` when another owned DB row or quarantine entry points to a valid equivalent file for the same `videoId`, `parentJobId`, or project output;
  2. `local-recomposite` when the final/avatar output is missing but the stored base render, voice, avatar source, captions, and composite parameters exist;
  3. `config-render` when a serializable stored render config exists and every referenced local input exists;
  4. `unrecoverable` when any paid source (voice/avatar/generated image/stock input) needed for the render is missing.

- [ ] The default CLI accepts `--since=2026-07-03 --until=2026-07-10 --output=<path>`, rejects `--apply` unless Task 5 is implemented, and prints counts only to stdout. The detailed report goes to a mode-600 file and contains user IDs but no API keys, credentials, or webhook URLs.

- [ ] Tests snapshot all DB table counts and filesystem mtimes before/after discovery and assert byte-identical state. Include all four classifications, normal expired media exclusion, an item expiring between discovery/apply, malformed JSON, and path traversal; malformed rows become unrecoverable report items, never an exception that loses the rest of the inventory.

- [ ] Run `DATABASE_URL=file:/tmp/heroai-media-recovery.db npx tsx scripts/verify-media-recovery-discovery.ts && npx tsc --noEmit`.

- [ ] Commit: `git commit -m "feat(recovery): add read-only missing media discovery"`.

### Task 3: Add reusable media validation

**Files:**

- Create: `src/lib/media-validation.ts`
- Create: `scripts/verify-media-validation.ts`

- [ ] Implement validation with injected filesystem/probe/fetch dependencies so tests do not need production HTTP. A valid recovery output must pass all checks in order:

  1. URL resolves inside the expected local root;
  2. `lstat` is a regular non-symlink file;
  3. size is greater than zero;
  4. `ffprobe -v error -show_entries format=duration -of json` returns finite duration > 0;
  5. internal GET with `Range: bytes=0-0` returns 200 or 206.

```ts
export type MediaValidation =
  | { ok: true; sizeBytes: number; durationSec: number }
  | { ok: false; code: "unsafe_path" | "missing" | "empty" | "ffprobe_failed" | "http_failed"; detail: string };
```

- [ ] Tests cover valid file, zero bytes, truncated/non-video content, symlink, traversal, ffprobe timeout, HTTP 404, and HTTP 206 success.

- [ ] Run: `npx tsx scripts/verify-media-validation.ts && npx tsc --noEmit`.

- [ ] Commit: `git commit -m "feat(recovery): validate recovered media before relink"`.

### Task 4: Add a non-billable recovery render path

**Files:**

- Modify: `src/lib/render/types.ts:3`
- Modify: `prisma/schema.prisma:563-594` comment only
- Modify: `src/lib/render/job-store.ts:30-113`
- Modify: `scripts/render-worker.ts:120-128`
- Create: `src/lib/media-recovery-render.ts`
- Modify: `src/app/api/heygen/composite/route.ts`
- Modify: `scripts/verify-render-queue.ts`
- Create: `scripts/verify-recovery-render-no-charge.ts`

- [ ] Extend the internal type only.

```ts
export type RenderJobType = "RENDER" | "BURN" | "RECOVERY";
```

- [ ] Define a recovery-only payload separate from the normal `RenderPayload`:

```ts
export type RecoveryRenderPayload =
  | { kind: "remotion"; input: RenderPayload }
  | { kind: "local-composite"; avatarVideoUrl: string; bgVideoUrl: string; tailAvatarVideoUrl?: string; mode: "full" | "bookend" | "bookend-both" | "cutaway"; personRanges?: Array<{ start: number; end: number }> };
```

- [ ] Extract the existing local ffmpeg/chroma composite core from `src/app/api/heygen/composite/route.ts` into `runLocalRecoveryRender()` dependencies without moving authentication, charging, or HTTP response logic. The existing route calls the same extracted local function and retains current behavior.

- [ ] In `render-worker`, branch on `job.type === "RECOVERY"`: validate/parse `RecoveryRenderPayload`, run Remotion for `kind: "remotion"` or the extracted local composite for `kind: "local-composite"`, then use the existing `finishRenderJob`. Normal RENDER/BURN parsing remains unchanged.

- [ ] Add `enqueueRecoveryRenderJob()` rather than exposing `RECOVERY` through the customer render route. It must set a `media-recovery:<recoveryKey>` idempotency key, `reservedQuota: false`, all reservation/credit fields null, and reject any payload that contains external provider task IDs or non-local unresolved sources.

- [ ] Keep the worker charge condition exactly restricted to base customer renders.

```ts
if (job.type === "RENDER") {
  await recordChargedClip(job.userId, result.videoUrl, job.reservedMinutes ?? undefined, job.creditsSpent ?? undefined);
}
```

- [ ] Add queue tests proving duplicate recovery enqueue returns the existing RenderJob, both recovery payload kinds run locally, RECOVERY completion never inserts `ChargedClip`, failure never calls any refund path, and existing route/RENDER/BURN behavior is unchanged.

- [ ] The no-charge test snapshots and compares: `User.usageCount`, `User.minutesUsed`, `CreditBalance`, `CreditLedger` count/sum, and `ChargedClip` count before and after successful and failed recovery jobs.

- [ ] Run:

```bash
DATABASE_URL=file:/tmp/heroai-recovery-render.db npx prisma db push --skip-generate
DATABASE_URL=file:/tmp/heroai-recovery-render.db npx tsx scripts/verify-recovery-render-no-charge.ts
npx tsx scripts/verify-render-queue.ts
npx tsc --noEmit
```

- [ ] Commit: `git commit -m "feat(recovery): add non-billable recovery render jobs"`.

### Task 5: Implement reviewed, idempotent apply

**Files:**

- Create: `src/lib/media-recovery-apply.ts`
- Modify: `scripts/media-recovery.ts`
- Create: `scripts/verify-media-recovery-apply.ts`

- [ ] Require all three apply controls: `--apply`, `--report=<path>`, and `--report-sha256=<reviewed-hash>`. Optionally accept repeated `--key=<recoveryKey>`; without keys, refuse to apply the whole report.

- [ ] At start, recompute canonical report hash, create/find `MediaRecovery` rows by key, and return an already-recovered result for completed keys. A conflicting key with different missing URL/report data is a hard failure.

- [ ] Before mutation, re-read the affected row and assert both the missing URL and captured `updatedAt` match. If the current URL is now valid or changed, mark `skipped-newer-output`; do not overwrite it.

- [ ] `relink`: validate the candidate, then use `updateMany` with exact URL and `updatedAt` guards in a transaction with the recovery status update.

- [ ] `local-recomposite` / `config-render`: enqueue the dedicated recovery job and leave the recovery row `rendering`. A resume invocation finds the existing job, validates a DONE output, performs the same compare-and-swap URL update, and marks recovered. FAILED remains retryable only by explicit operator command.

- [ ] `unrecoverable`: never render. Persist the reviewed reason and missing required URLs, with no customer notification in this task.

- [ ] After every item, re-read quota/credit snapshots. Any mutation to customer billing state stops the batch and marks the item failed; it must not attempt an automatic credit correction.

- [ ] Tests cover discovery/apply separation, same key applied twice, crash after enqueue and resume, candidate failing validation, newer output guard, two concurrent apply processes, and invariant billing snapshots.

- [ ] Run `DATABASE_URL=file:/tmp/heroai-media-recovery.db npx tsx scripts/verify-media-recovery-apply.ts && npx tsc --noEmit`.

- [ ] Commit: `git commit -m "feat(recovery): apply reviewed media recovery idempotently"`.

### Task 6: Controlled production recovery

**Files:**

- Produce outside repository: `/root/heroai-recovery/<timestamp>/report.json`
- Produce outside repository: `/root/heroai-recovery/<timestamp>/results.json`

- [ ] Run discovery against the audit window and reconcile totals with the known baseline (80 missing local Gallery finals; 12/29 post projects affected; 7 missing core preview videos and voice files). Differences require explanation, not forced equality, because customer data may have changed since the audit.

- [ ] Review every `relink` and the input list for every local render. Exclude all records whose required voice/avatar/stock source is missing or whose current DB URL changed.

- [ ] Apply one key from each recoverable class. Wait for completion and verify filesystem, ffprobe, internal HTTP, UI playback, DB URL, and billing snapshots.

- [ ] Apply batches of at most five recovery keys. Stop on the first validation, compare-and-swap, billing-invariant, queue, or health failure.

- [ ] After all recoverable items, re-run discovery. Expected: recovered items disappear from missing results, unrecoverable keys remain stable, and no new missing-media records appear.

### Task 7: Review customer communication separately

**Files:**

- No code change in this task unless separately approved.

- [ ] Prepare counts of recovered, unrecoverable, skipped-newer, and failed by user without exposing one user's data to another.
- [ ] Draft notifications only after recovery outcomes are final. Recovered copy must not claim a rerender charge; unrecoverable copy must explain the normal 3/7/14 policy separately from the system-deletion incident.
- [ ] Obtain explicit approval before sending any customer notification. Sending is not authorized by this implementation plan.

## Final Verification

- [ ] Run Prisma validation/generation, TypeScript, recovery-focused scripts, and existing render queue tests.
- [ ] Inspect code paths to confirm no recovery module imports `reserveClipUsage`, `reserveMinutes`, credit-spend/refund functions, TTS, Kie, or HeyGen generation clients.
- [ ] Run `git diff --check` and a secret scan limited to changed files; do not print secret values.
- [ ] Acceptance: discovery is read-only, apply is idempotent, verified recovered URLs are valid, newer outputs are untouched, and all customer usage/credit ledgers are unchanged.
