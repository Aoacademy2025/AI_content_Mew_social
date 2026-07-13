# HeyGen Late-Completion Recovery Design

**Date:** 2026-07-13
**Status:** Approved design, pending implementation plan
**Production baseline:** `b37d6e3` on Hostinger VPS, Next.js + PM2 + SQLite/WAL

## 1. Incident and root cause

On 2026-07-13, five Editor v2 avatar jobs from two users failed with
`avatar generation timed out`. Every associated base `RenderJob` completed successfully.
Direct HeyGen status checks later showed four of those timed-out videos as `completed` with a
usable `video_url`; one was still `processing` more than 38 minutes after submission. Two of the
late-completed videos were only about five seconds long, so this was not limited to long videos or
one account.

The shared avatar helper polls HeyGen every five seconds but has a hard ten-minute deadline. When
that deadline expires, the orchestrator marks the `VideoJob` failed and discards the HeyGen video
ID. HeyGen continues processing, but the application has no durable state from which to resume the
composite step. Retrying from the UI starts a new HeyGen generation and spends the user's credits
again.

The ten-minute limit has existed since 2026-06-14. This incident exposed a latent state-management
gap; it was not a render-worker failure or a same-day application regression.

## 2. Goals

1. Never mark a healthy, still-processing HeyGen job failed merely because it exceeds ten minutes.
2. Persist enough state to resume an avatar job after provider delay or worker restart without
   creating another HeyGen video.
3. Release MCP worker capacity while HeyGen is processing instead of occupying a worker slot for
   tens of minutes.
4. Preserve cancellation, ownership, quota, project linkage, and existing terminal provider-error
   behavior.
5. Provide a guarded, dry-run-first operator tool to recover the affected legacy timeout jobs.
6. Guarantee that production deployment only restarts workers after both the `VideoJob` and
   `RenderJob` queues are empty, without canceling user work to create an empty queue.

## 3. Non-goals

- Do not replace HeyGen or move rendering to a new service.
- Do not build a general external-provider queue framework in this hotfix.
- Do not regenerate HeyGen videos during recovery.
- Do not change clip/minute accounting or attempt to refund third-party HeyGen credits.
- Do not make the synchronous composite route a separately persisted render queue in this change.
- Do not recover a legacy job when required media or reconstruction data is missing; abort safely
  and report the missing prerequisite.

## 4. Considered approaches

### A. Increase the in-memory timeout

Changing ten minutes to 45–60 minutes is small, but it holds an MCP worker slot throughout the
provider wait, still loses state on deploy/restart, and still cannot recover late completions after
the new deadline. It is only a temporary symptom reduction.

### B. Durable provider checkpoint and resumable wait — selected

Persist the provider ID and completion context, release the worker slot while the provider is
pending, and atomically reclaim due provider waits for one status check or the next stage. This
prevents duplicate HeyGen spend and survives restarts with bounded scope.

### C. Dedicated provider queue/service

A separate queue with leases and provider-specific workers is the strongest long-term design, but
it adds infrastructure and operational surface that are disproportionate to this incident.

## 5. State model

`VideoJob.status` remains a string and gains one internal value:

```text
queued -> processing -> waiting_provider -> processing -> done
                    \-> failed
                    \-> canceled
waiting_provider --------------------------> canceled
```

`waiting_provider` means the application owns a valid external provider job that is not terminal.
It is an in-flight job for user limits, project state, admin insights, deploy gating, and
cancellation. Public job APIs normalize it to `processing` so existing clients continue to poll
without requiring a new UI state. The response may include a non-breaking wait message such as
"HeyGen กำลังประมวลผล — ระบบจะทำต่อให้อัตโนมัติ".

Add these nullable columns to `VideoJob`:

```prisma
providerCheckpointJson String?
providerNextPollAt     DateTime?
```

No lease column is required because production deliberately runs one MCP worker process. A due
provider wait is claimed with an atomic guarded transition from `waiting_provider` to `processing`,
the same lost-race protection used for queued jobs. In-process concurrency may claim sequentially
and execute concurrently as it does today.

`providerCheckpointJson` is versioned. Version 1 contains only server-produced data:

```ts
type AvatarProviderCheckpointV1 = {
  version: 1;
  provider: "heygen";
  phase: "intro_generate" | "intro_wait" | "tail_generate" | "tail_wait" | "composite";
  providerStartedAt: string;
  providerDeadlineAt: string;
  baseUrl: string;
  voiceUrl: string;
  audioDurationMs: number;
  captions: OrchCaption[];
  words: TimedWord[];
  fullText: string;
  baseConfig: Record<string, unknown>;
  avatar: {
    mode: "full" | "bookend" | "bookend-both";
    id: string;
    introSecs: number;
    tailSecs: number;
    layout: { scale: number; offsetX: number; offsetY: number };
    introVideoId?: string;
    introVideoUrl?: string;
    tailVideoId?: string;
    tailVideoUrl?: string;
  };
};
```

The original `inputJson` remains authoritative for script, preview/full mode, provider choice, and
project/job type. The checkpoint stores the expensive pre-avatar results that otherwise exist only
in orchestrator memory.

## 6. Processing flow

### 6.1 Initial generation

1. Run TTS, captions, stock, config, and base render exactly as today.
2. Write the prepared avatar checkpoint with `phase=intro_generate` before calling HeyGen.
3. Generate the intro HeyGen video once.
4. Persist `introVideoId` and advance to `phase=intro_wait` immediately after the successful
   generate response.
5. Set `status=waiting_provider`, `currentStep=avatar`, `progress=84`, and
   `providerNextPollAt` in one guarded update, then return the worker slot.

The generate request remains non-retried because it spends external credits. A transport failure
whose outcome is unknowable remains a terminal error rather than risking a duplicate generation.
Likewise, a restart that finds `intro_generate` or `tail_generate` without a persisted provider ID
fails closed as an unknown generate outcome; it never guesses that the external request was absent
and never generates again.

### 6.2 Provider polling and resume

The MCP worker dispatcher claims due `waiting_provider` rows before ordinary queued work, using a
guarded status transition. Each claim performs one bounded provider check:

- `completed` with URL: persist the URL and advance the checkpoint.
- `processing`, `pending`, rate-limit, network timeout, or HeyGen 5xx: return the row to
  `waiting_provider` with the next poll time.
- Invalid key, insufficient credit, not found, or provider-declared `failed`: use the existing
  structured terminal error mapping and fail the job.

Poll cadence is 15 seconds for the first ten minutes, 30 seconds until 30 minutes, then 60 seconds.
Honor a larger valid `Retry-After` up to 120 seconds. The absolute provider deadline is two hours.
At that deadline the job becomes failed with an explicit provider-wait timeout, but its checkpoint
is preserved for operator recovery if HeyGen completes later.

For `bookend-both`, completion of the intro first persists `phase=tail_generate`, then performs tail
generation. The tail ID and `phase=tail_wait` are persisted before waiting again. No transition may
regenerate an ID already present in the checkpoint, and a stranded generate phase without an ID
uses the same fail-closed unknown-outcome rule.

When all required HeyGen URLs exist, advance to `phase=composite`, call the existing composite
route, and continue the current preview or full-video finalization path. A restart during composite
may repeat local composite CPU work, but it must never repeat HeyGen generation or platform quota
reservation. This trade-off keeps the hotfix bounded while protecting paid external work.

On successful `finishJob`, clear both provider fields in the same transaction that writes final
output and updates the project. On terminal failure, preserve the checkpoint; on cancellation,
preserve it for audit but never auto-resume it.

## 7. Restart and race safety

`recoverProcessingJobsAfterWorkerRestart` changes only for jobs with a valid avatar checkpoint:

- `processing` at `avatar` or `composite` with a valid wait/composite checkpoint becomes
  `waiting_provider` and resumes from the saved phase.
- `intro_generate` or `tail_generate` without its persisted provider ID fails with the explicit
  unknown-generate-outcome error and is never requeued or regenerated.
- An invalid checkpoint follows the existing fail-closed behavior.
- Other post-billable processing jobs retain the current no-replay behavior.

All state transitions use `updateMany` guards on the expected prior status. Cancellation winning a
race prevents a provider poll, composite, or finish operation from resurrecting the job.
`waiting_provider` is included in:

- per-user in-flight caps;
- cancel API predicates;
- project active-job handling;
- admin/telemetry in-flight classifications;
- media retention/reference protection;
- production queue checks.

Public status readers return `processing` for `waiting_provider`; internal/operator queries retain
the exact state.

## 8. Legacy timeout recovery

Add `scripts/recover-heygen-timeout.ts` with dry-run as the default. Applying requires both
`--apply` and explicit `--job-id`/`--heygen-video-id` pairs.

For every pair, the script must verify:

1. The `VideoJob` exists, is `failed`, stopped at `avatar`, and has an approved timeout error.
2. The HeyGen video is accessible with that job owner's key; never print the key or signed URL.
3. The corresponding base `RenderJob` belongs to the same user, is `DONE`, was created within the
   VideoJob execution window, has a video URL, and the local file still exists.
4. The render payload contains the captions/config/audio data required to reconstruct a valid
   version-2 preview checkpoint. Missing data aborts that row; it is never guessed.
5. The target project still belongs to the same user.
6. No newer `done` job in the same project has the same normalized input fingerprint. A matching
   successful retry supersedes the timed-out row; recovery must report it and make no write.

The apply path writes a legacy-reconstructed checkpoint and atomically moves only the matching
failed job to `waiting_provider`. The normal worker then performs provider validation, composite,
and `finishJob`, preserving one completion path. A provider video that is still processing remains
waiting; a completed video proceeds without regeneration.

For the 2026-07-13 incident, operator mappings are taken from the audited production logs. IDs and
signed URLs are not committed to the repository. The three `sumawad` timeout rows share the same
project and script fingerprint as a newer successful retry, so the expected production action for
those rows is a dry-run `superseded` result and zero recovery writes. Each genuinely recoverable
job is verified in its project before moving to the next.

## 9. Production drain and deploy gate

The deployment must not cancel work to create an empty queue. To prevent a race where a new job is
submitted after the first queue check, use a DB-backed drain flag in `SiteConfig`:

```text
render_deploy_drain = "1" | absent
```

When enabled, job-creation/render-enqueue routes return HTTP 503 with a retryable maintenance
message before reserving quota or inserting a job. Existing jobs continue. Read-only status,
cancellation, provider polling, and completion remain available.

Enforce the flag through one shared guard. Web Editor v2, MCP `create_video_job`, and legacy render
call it before quota reservation; `createVideoJob` and `enqueueRenderJob` call it again immediately
before row insertion as defense in depth. Future callers therefore cannot bypass drain
accidentally. HTTP/MCP surfaces translate the typed drain result into their existing response
shape. If the second guard detects a drain race after an earlier reservation, the caller follows
the existing exact-refund path before returning the maintenance response.

The first rollout cannot rely on this flag because the old production build does not understand
it yet. Bootstrap that deployment as follows: wait for both queues to reach zero, enable a temporary
Nginx maintenance response for external traffic, recheck both queues after the Nginx reload, and
only then back up/deploy/restart. Existing workers call the app directly on `127.0.0.1` and are not
routed through external Nginx, so they can finish work before maintenance is enabled. If either
queue is nonzero on the recheck, do not deploy. Remove the temporary maintenance response after
the new build passes health checks. Subsequent deployments use the DB drain flag.

The steady-state production runbook after this bootstrap is:

1. Enable drain mode and verify new enqueue requests are blocked without charging.
2. Poll until both counts are zero:
   - `VideoJob.status IN ('queued','processing','waiting_provider')`
   - `RenderJob.status IN ('QUEUED','RUNNING')`
3. If either count is nonzero, wait. Do not cancel jobs and do not restart PM2.
4. Create and integrity-check the SQLite backup.
5. Deploy additive schema/code, build, and restart web/MCP/render workers.
6. Verify PM2 health, schema columns, queue counts, and a read-only job-status request.
7. Disable drain mode even if recovery is postponed. A failure trap/runbook command must make the
   flag visible and removable; never leave production silently drained.
8. Run legacy recovery in dry-run mode, review output, then apply one job at a time.

If deploy fails before the new code is healthy, keep the old application running where possible,
disable drain mode, and do not apply recovery writes.

## 10. Testing

Add focused verification scripts/tests that prove:

- checkpoint parsing rejects corrupt, wrong-version, or incomplete JSON;
- HeyGen generation ID is persisted before waiting;
- pending status releases the slot and schedules the correct backoff;
- completed intro/tail states resume without a second generate call;
- terminal provider errors fail immediately;
- two-hour deadline preserves the checkpoint while failing explicitly;
- worker restart converts valid checkpointed work back to resumable wait;
- invalid/non-avatar post-billable work retains current fail-closed restart behavior;
- cancellation wins every waiting/claim/composite/finish race and cannot be resurrected;
- `waiting_provider` counts toward in-flight limits and is normalized for public APIs;
- finish clears provider fields atomically and updates the EditorProject once;
- recovery defaults to dry-run, rejects ownership/status/media mismatches and newer successful
  duplicates, and is idempotent;
- drain mode blocks every enqueue boundary before quota reservation while allowing status/cancel;
- queue-zero deploy check fails closed when either queue is active.

Run the relevant existing suites (`verify-mcp-videojob`, `verify-preview-mode`,
`verify-editor-projects`, render queue/accounting/cancellation/media-retention verifiers), TypeScript,
and the production build before deployment.

## 11. Observability and acceptance criteria

Log sanitized transitions containing application job ID, provider, checkpoint phase, wait age, and
next poll delay. Do not log API keys or signed provider URLs. Admin failure summaries distinguish
terminal provider failure from provider-wait timeout.

The change is accepted when:

1. A simulated HeyGen completion after ten minutes reaches composite and `done` without another
   generate request.
2. The same job survives MCP worker restart and completes once.
3. A canceled waiting job never resumes.
4. Production deployment does not begin its restart phase until both queues are empty under drain.
5. The `sumawad` timeout rows are identified as superseded by the newer successful retry and
   receive no production write; a non-superseded recovery fixture finishes from existing
   HeyGen/base-render assets without new HeyGen generation or clip reservation.
6. No existing non-avatar render, export, quota, project-resume, or media-retention verification
   regresses.
