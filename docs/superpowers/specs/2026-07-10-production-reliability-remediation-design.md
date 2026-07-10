# Production Reliability Remediation Design

**Date:** 2026-07-10

**Status:** Approved in conversation; awaiting written-spec review

**Production baseline:** `c1a1b7a` on Hostinger KVM8 (8 vCPU / 31 GiB), Next.js + PM2 + Nginx + SQLite/WAL

## 1. Objective

Stop unintended media deletion immediately, restore recoverable customer media without charging users twice, and then harden media retention, TTS fallback, deploy reliability, scheduling, observability, and backup as separate rollback-safe changes.

This design follows a containment-first sequence. Production operations, media lifecycle, recovery, TTS behavior, deploy behavior, and performance work must not be bundled into one release.

## 2. Locked Decisions

1. Media retention remains the existing plan policy:
   - FREE: 3 days
   - PRO: 7 days
   - BUSINESS: 14 days
2. An active project does not make generated media permanent. The project record, script, and settings persist, while its generated media expires according to the plan retention in force when that media was produced.
3. After project media expires, the editor must show an explicit expired-preview state and allow a new render. It must not leave a broken player or unexplained 404.
4. `Video.expiresAt` remains authoritative for Gallery videos.
5. The legacy root cron that deletes every render older than 3 days must be removed. No filesystem-wide age rule may bypass plan retention or database ownership.
6. Cleanup is dry-run first, reference-aware, fail-safe, and reversible through quarantine before permanent deletion.
7. Recovery work must not consume the affected user's clips, minutes, credits, or third-party generation budget unless the user explicitly starts a new generation.
8. The existing Discord webhook credential is not rotated or replaced in this scope. Its value and endpoint must remain unchanged. Commands and logs must not print it again.
9. Deployments continue from `main`, but each remediation subsystem ships as its own reviewed branch/PR and independently reversible deploy.

## 3. Current Failure Model

Two cleanup mechanisms currently violate the intended product rules:

- A root crontab command deletes every file under `public/renders` older than 3 days. This ignores PRO/BUSINESS retention and `Video.expiresAt`.
- `media-cleanup` protects references from `Video` and `GeneratedImage`, but not from `VideoJob.outputJson`, active project output, or project draft data. It can therefore classify live preview assets as orphans.

The audit found:

- 80 of 166 Gallery rows with local final-video URLs point to missing files.
- 12 of 29 projects in `post` state contain missing media references.
- 7 `post` projects are missing a core preview video and 7 are missing the associated voice file.
- Nine VideoJobs from five users failed because the orchestrator received no usable TTS timing and threw instead of following the documented transcribe fallback.
- The MCP worker crash-looped 16 times on 2026-07-07 when `MCP_SERVICE_SECRET` was absent at process start.
- Builds caused severe memory/swap pressure during the audit window, while frequent restarts produced deployment-related 502 responses.

## 4. Workstream Boundaries

### 4.1 Production Containment

Containment is an operations change and precedes every code change.

- Remove the root cron command that runs `find ... public/renders ... -mtime +3 -delete`.
- Remove the obsolete root cron request to `/api/cron/cleanup-videos` that has no bearer secret and returns 401.
- Pause the PM2 `media-cleanup --apply` job. It may run in dry-run mode only until the new protection logic is deployed and verified.
- Keep the PM2 `cleanup-videos` job that deletes `Video` rows and their owned files according to `Video.expiresAt`.
- Keep database backup, disk-watch, watchdog, billing, founding, trial, and renewal jobs enabled.
- Capture a read-only media manifest and a copy of the current cron/PM2 configuration before changing schedules.
- Preserve the Discord webhook value exactly. Do not rotate, replace, echo, or include it in an audit artifact.

Containment is successful when the next cleanup window deletes no media outside `Video.expiresAt`, all health checks remain green, and the dry-run candidate report is retained for review.

### 4.2 Canonical Media Retention Model

The product needs one retention resolver instead of independent filesystem rules.

The canonical source remains `storageDaysForPlan()` from `src/lib/plan-limits.ts`. A new focused media-retention module will expose plan-based expiration and ownership information to cleanup, API responses, and recovery tooling.

#### Gallery media

- `Video.expiresAt` is the authoritative expiry.
- A referenced Gallery file is protected until that timestamp, even when its filesystem mtime is older.
- Rows with `expiresAt = null` are protected during containment and recovery discovery. After review, a backfill assigns `createdAt + storageDaysForPlan(currentOwnerPlan)` because historical plan-at-creation is unavailable. Rows whose calculated expiry is already past are reported as expired first; their files are not deleted in the same backfill transaction.

#### VideoJob output media

- Add nullable `VideoJob.mediaExpiresAt`.
- Set it when `finishJob()` persists output, using the user's plan at completion time and the same `videoExpiryFor()` calculation used for Gallery videos.
- Once stored, the expiry is frozen. A later plan change does not silently rewrite historical media retention, matching current `Video.expiresAt` semantics.
- For legacy completed jobs, backfill conservatively from `finishedAt`, falling back to `updatedAt` and then `createdAt`, using the owner's current plan because historical plan-at-completion is unavailable.
- The backfill runs only after the missing-media inventory is captured and cleanup remains paused.

#### Project draft media

- The `EditorProject` row, title, script, and draft configuration remain until user deletion/archive policy removes the project.
- Media URLs embedded directly in `draftJson` use the media file's production time/mtime plus the owner's 3/7/14-day retention. For legacy direct-draft files without plan-at-production metadata, the owner's current plan is the conservative fallback; newly produced preview media uses `VideoJob.mediaExpiresAt`.
- Saving or opening a project does not renew old media indefinitely.
- Media referenced by the active/latest VideoJob uses that job's `mediaExpiresAt` rather than project `updatedAt`.
- After expiry, the project returns an explicit `previewExpired: true` state while retaining enough non-media configuration to render again.

#### Multiple references

One physical file may have more than one owner. The effective expiry is the latest valid expiry among all references. Cleanup may select the file only when every reference has expired.

### 4.3 Reference Graph and Cleanup Pipeline

The protected reference graph must include:

- Non-expired `Video` media fields and nested render configuration.
- Non-expired `VideoJob.outputJson` media.
- `EditorProject.draftJson` direct media references under plan retention.
- Active/latest project VideoJobs until their `mediaExpiresAt`; project activity alone does not extend retention.
- QUEUED and RUNNING `RenderJob` payloads and outputs, regardless of age.
- Non-expired completed `RenderJob` outputs when still referenced by a job/project/video.
- `GeneratedImage` URLs.
- Low-resolution preview variants derived from protected render filenames.
- Stock `.normalized` companions for protected stock assets.

Cleanup becomes a staged pipeline:

```text
Build complete reference graph
  -> abort on DB/JSON/scan failure
  -> scan media directories
  -> calculate effective expiry per file
  -> produce dry-run manifest
  -> re-check references immediately before mutation
  -> move eligible files to quarantine
  -> retain quarantine for 24 hours
  -> permanently delete only unchanged, still-unreferenced entries
```

Safety rules:

- If the reference graph cannot be built completely, apply mode aborts and deletes nothing.
- A malformed JSON field causes its owning row to be recorded as an error and protected conservatively.
- Paths must be contained under the expected media root and must not follow symlinks.
- Every apply run writes counts and bytes for scanned, protected, expired, quarantined, restored, deleted, and skipped files.
- Cleanup writes a heartbeat only after the full run completes successfully.
- Apply mode requires an explicit flag; the default remains dry-run.

### 4.4 Customer Media Recovery

Recovery uses a read-only discovery phase followed by an explicit apply phase.

The discovery report classifies each missing final/preview asset as:

1. Recoverable by relinking an equivalent existing file.
2. Recoverable by a local recomposite/burn from retained source media.
3. Recoverable by a render from stored configuration without repeating paid AI generation.
4. Not recoverable because required voice/avatar/stock source media is also missing.

Recovery mutations must use a stable idempotency key derived from the affected row and missing output. A rerun must return the existing recovery result rather than create another video or ledger entry.

Recovery must not:

- Reserve clips or minutes.
- Spend or refund customer credits.
- Regenerate paid Kie/HeyGen/ElevenLabs assets automatically.
- Replace a working newer output with an older recovered output.
- Notify the customer until the recovery outcome is known.

Each recovered file must pass existence, non-zero size, `ffprobe`, and HTTP 200 checks before its database URL is updated.

### 4.5 TTS Timing Fail-Open

The orchestrator must match the documented web-editor behavior:

```text
TTS succeeds with valid timing
  -> build captions from TTS timing

TTS succeeds without valid timing
  -> transcribe the generated voice URL
  -> validate transcription timing
  -> continue with transcribed captions

Both timing and transcription fail
  -> fail the job once with a retryable, actionable error
```

Requirements:

- The fallback uses the already-created `tts.voiceUrl`; it does not synthesize audio twice.
- Minute/credit reservation remains single-charge.
- HTTP 4xx business/auth errors are not retried blindly.
- Only 408, 429, network errors, and 5xx responses receive bounded backoff retries.
- Emit `tts_timing_fallback_started`, `tts_timing_fallback_done`, or `tts_timing_fallback_error` telemetry.
- Preserve the script text invariant where TTS timing exists. When transcription is required, surface the fallback source in output metadata for support diagnostics.

### 4.6 Deploy and Process Reliability

Deployment preflight must validate required runtime state before pulling/building/restarting:

- Required secret presence and minimum lengths.
- Database availability and WAL mode.
- Disk and memory headroom.
- Schema application success.
- Staged build `BUILD_ID` existence.

`ecosystem.config.js` must load the production `.env` before evaluating app `env` blocks so a fresh `pm2 start` does not turn a present `.env` secret into an empty process variable. This applies to MCP and cron secrets. The Discord webhook value is excluded from migration or rotation and remains unchanged in its current alerting configuration.

Process requirements:

- Add crash-loop guards to `mcp-video-worker` matching the web/render workers.
- Stop new MCP claims before shutdown and let safe in-flight stages drain or requeue.
- Keep render-worker graceful requeue behavior.
- Pin the known-safe production build profile as deploy defaults: main heap 4096 MB, worker heap 512 MB, low fallback 3072/512 MB.
- Prevent Next's staging build from leaving a tracked `tsconfig.json` modification by tracking the required staging types include intentionally and verifying a clean worktree after build.
- Run post-restart health, worker-count, queue-orphan, and schema checks. Restore `.next.old` and restart the previous release if health fails.

### 4.7 Scheduling and Performance

The server remains on UTC. Cron expressions are changed to explicit UTC equivalents of Bangkok business rules:

| Job | Bangkok target | UTC cron |
|---|---:|---:|
| DB backup | 02:00 | `0 19 * * *` |
| Video cleanup | 03:00 | `0 20 * * *` |
| Media cleanup | 03:30 | `30 20 * * *` |
| Loanword mining | 04:10 | `10 21 * * *` |
| Trial expiry | 08:00 | `0 1 * * *` |
| Renewal reminder | 09:00 | `0 2 * * *` |

Observability changes:

- Add Nginx `$request_time`, `$upstream_response_time`, and request ID fields.
- Retain PM2 logs for 14 days.
- Check both render-worker instances, not merely the first process matching the name.
- Add database-backup and media-cleanup heartbeats.
- Alert on rising missing-media counts, stale queues, failed backups, and 5xx rate.
- Preserve the current Discord webhook credential unchanged and prevent commands from printing it.

Application performance changes:

- Make notification and job polling visibility-aware with idle backoff.
- Use fast polling only while an active job exists.
- Reset Web Vital collection per navigation and discard invalid duration outliers.
- Add the same 500 MB client-side avatar-upload guard and upload progress to the legacy creator path.

### 4.8 Backup and Restore

- Keep daily integrity-checked SQLite snapshots.
- Add an off-box database copy with failure heartbeat/alerting.
- Store a daily media manifest off-box.
- Back up final media within its 3/7/14-day retention window or place final media in storage with equivalent durability.
- Run a restore drill against a copy at least monthly.
- Target database RPO <= 24 hours and RTO <= 2 hours.

A full object-storage migration is not required for this remediation. It may be designed separately if local-plus-off-box retention is insufficient.

## 5. UI Behavior

When preview media is expired or missing, the editor must not render a broken `<video>` element as if the project were healthy.

The project/job API returns a machine-readable state:

```ts
type ProjectMediaState =
  | { status: "available"; expiresAt: string }
  | { status: "expired"; expiredAt: string; canRerender: true }
  | { status: "missing"; canRerender: boolean; supportCode: string };
```

The editor displays:

- Available: current preview and its expiry.
- Expired: “ไฟล์ Preview หมดอายุแล้วตามระยะเวลาของแพ็กเกจ กดสร้าง Preview ใหม่ได้” and a rerender action.
- Unexpectedly missing before expiry: a recovery/support state, not an expiry message.

Project script, styling, subtitle edits, and other non-media draft data remain accessible in every state.

## 6. Error Handling

- Cleanup and recovery are fail-closed for destructive actions.
- Telemetry, notification, and support metadata are fail-open and must not break rendering.
- Customer quota/auth/provider 4xx errors remain explicit and are not classified as infrastructure retries.
- TTS timing absence is recoverable through transcription; only failure of both paths terminates the job.
- Deploy preflight failure leaves the old release running.
- Post-deploy health failure rolls back the application build without rolling back an additive database schema.

## 7. Test Strategy

### Media retention tests

- FREE media is protected before 3 days and eligible after 3 days when all references expired.
- PRO media is protected before 7 days.
- BUSINESS media is protected before 14 days.
- A Gallery `Video.expiresAt` overrides old file mtime.
- Active project output is protected until `VideoJob.mediaExpiresAt`.
- Opening/saving a project does not extend old media.
- A file with two owners is kept until the later expiry.
- Malformed JSON aborts apply mode with zero mutations.
- QUEUED/RUNNING RenderJob files are always protected.
- Quarantined media can be restored and is not permanently deleted before 24 hours.

### Recovery tests

- Discovery does not mutate the DB or filesystem.
- Apply is idempotent.
- Recovery does not change usage, minute, or credit ledgers.
- Invalid media fails validation before URL replacement.
- Working newer output cannot be overwritten.

### TTS tests

- Valid TTS timing stays on the existing path.
- Missing timing invokes transcription and completes.
- Failed transcription produces one actionable retryable failure.
- 4xx responses do not retry.
- 5xx responses retry only to the configured bound.

### Deploy/operations tests

- Fresh PM2 start from a clean shell loads required secrets from `.env`.
- Missing required secret fails preflight before restart.
- Build completes without modifying tracked files.
- Failed health check restores the prior `.next` build.
- Watchdog detects one missing render-worker instance.
- Cron schedule assertions map UTC expressions to the intended Bangkok time.

## 8. Rollout Sequence

1. **Ops containment:** stop unsafe deletion, preserve current alert credential, capture manifests.
2. **Media retention code in dry-run:** schema addition, resolver, reference graph, UI media state, tests.
3. **One full dry-run cycle:** compare candidates against DB/project/job references; no deletion.
4. **Recovery discovery and review:** produce affected/recoverable/unrecoverable counts.
5. **Controlled recovery:** small verified batch, then remaining recoverable records.
6. **Enable quarantine apply:** monitor one full retention cycle before permanent deletion.
7. **TTS fallback:** deploy independently and monitor fallback/failure telemetry.
8. **Deploy hardening:** preflight, env loading, drain, rollback, clean-worktree gate.
9. **Cron/performance/observability:** Bangkok schedule, request timing, polling, Web Vitals, upload guard.
10. **Off-box backup and restore drill.**

Every stage has its own rollback. Media deletion remains paused if any candidate/reference mismatch is observed.

## 9. Acceptance Criteria

- No file referenced by an unexpired owner is selected by cleanup.
- FREE/PRO/BUSINESS media remains available for at least 3/7/14 days respectively.
- Expired project media produces an explicit rerender state instead of a broken URL.
- Recoverable affected videos are restored without customer quota or credit mutation.
- `ไม่มี subtitle timing จาก TTS` produces a transcribe fallback rather than immediate failure.
- A clean-shell deploy cannot start MCP without its configured secret and cannot enter a silent crash-loop.
- Deploy-related 502s are eliminated or confined to an announced maintenance window.
- Production builds leave a clean tracked worktree.
- Heavy cleanup runs at the intended Bangkok off-peak time.
- PM2 raw logs cover at least 14 days and Nginx logs contain request/upstream timing.
- Database backup exists off-box and a restore drill passes.
- The Discord webhook credential and endpoint remain unchanged.

## 10. Non-Goals

- Rotating or replacing the Discord webhook credential.
- Making project media permanent beyond plan retention.
- Recharging users to recover system-deleted media.
- Combining all remediation into one production deploy.
- Rebuilding the editor UI beyond the media-expired/missing state.
- Migrating all media to object storage as a prerequisite.

## 11. Implementation Decomposition

After written-spec approval, implementation planning is split into independently executable plans:

1. Production containment and cron safety.
2. Media retention, reference graph, quarantine, and expired-preview UI.
3. Customer media recovery discovery and controlled apply.
4. TTS timing fallback and provider retry classification.
5. Deploy/process hardening, Bangkok scheduling, observability, polling, and backup.

Plans 1–3 are ordered and must complete in that sequence. Plan 4 is code-independent after containment and may ship before or after recovery. Plan 5 follows the destructive-path fixes so operational changes cannot obscure recovery evidence.
