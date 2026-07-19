# Deploy, Process, Scheduling, Observability, Performance, and Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make clean-shell deploys fail safely before restart, stop MCP secret crash loops, run heavy jobs at intended Bangkok times, expose latency/process/backup failures, reduce idle client polling, and prove an off-box database restore.

**Architecture:** Load `.env` before PM2 config evaluation, gate deploy with a secret/DB/resource preflight, stage and health-check the new build with automatic `.next.old` restoration, and add bounded worker drain. Operations are verified through explicit UTC schedule assertions, Nginx timing logs, multi-instance watchdog checks, success/failure heartbeats, and off-box backup drills. Client polling uses one visibility-aware scheduler and Web Vitals reset per route.

**Tech Stack:** Bash, PM2, dotenv, Next.js, Prisma/SQLite WAL, Nginx, React, PerformanceObserver, rsync, ffprobe/HTTP, tsx verification scripts.

## Global Constraints

- Start this plan after destructive-path containment/reference fixes so deploy or schedule noise cannot obscure recovery evidence.
- Each task is a separate commit and independently reversible. Do not bundle all operations into one production change window.
- Server timezone remains UTC. Business intent is encoded as explicit UTC cron with Bangkok comments/tests.
- Build defaults are main heap 4096 MB, worker heap 512 MB, fallback 3072/512 MB.
- The current Discord webhook credential and endpoint remain unchanged. Do not rotate, replace, echo, diff, or print them. Alert tests use a local fake receiver or an injected sender.
- Never dump `pm2 jlist`/process environments into a report; test tools must redact or use fixture JSON.
- A preflight/build/health failure leaves or restores the old application build. Additive schema changes are not rolled back.

---

### Task 1: Load runtime environment before ecosystem evaluation

**Files:**

- Modify: `ecosystem.config.js:1`
- Create: `scripts/verify-ecosystem-env.ts`

- [ ] Write a verification script that creates a temporary env file containing dummy 32+ character `MCP_SERVICE_SECRET`, `CRON_SECRET`, `DATABASE_URL`, and `KEY_ENC_SECRET`, spawns a clean Node process with `HEROAI_ENV_FILE=<temp>`, requires `ecosystem.config.js`, and inspects only booleans/lengths—not values.

- [ ] Run `npx tsx scripts/verify-ecosystem-env.ts` and confirm failure because a clean process currently yields an empty MCP/cron secret.

- [ ] Load dotenv before `module.exports`.

```js
const path = require("node:path");
require("dotenv").config({
  path: process.env.HEROAI_ENV_FILE || path.join(__dirname, ".env"),
  override: false,
});
```

- [ ] Keep existing explicit PM2 env blocks, but make them consume the now-loaded variables. The test must assert secret length and equality to the dummy value internally while outputting only `PASS`; it must delete the temp file in `finally`.

- [ ] Run `npx tsx scripts/verify-ecosystem-env.ts && npx tsc --noEmit`.

- [ ] Commit: `git commit -m "fix(ops): load dotenv before PM2 app config"`.

### Task 2: Add deploy preflight and safe build profile

**Files:**

- Create: `scripts/deploy-preflight.ts`
- Create: `scripts/verify-deploy-preflight.ts`
- Modify: `deploy/deploy.sh:9-27,45-75`

- [ ] Implement preflight with injected process/filesystem probes. It returns structured checks but never values:

  - `.env` exists and is mode 600 or stricter;
  - `DATABASE_URL` resolves to an existing SQLite database;
  - `MCP_SERVICE_SECRET`, `CRON_SECRET`, and `KEY_ENC_SECRET` are at least 32 characters;
  - `PRAGMA quick_check` is `ok`, journal mode is `wal`, and a write transaction can obtain the configured busy timeout;
  - root filesystem has at least 20 GiB or 15% free, whichever is smaller;
  - MemAvailable plus free swap is at least 6 GiB before build;
  - tracked worktree is clean before pull/build.

- [ ] `deploy-preflight.ts --json` may print check names/status/numbers only. It must never include env values, URLs with credentials, or the webhook configuration.

- [ ] Add fixture tests for missing/short secrets, missing DB, quick-check failure, non-WAL, low disk, low memory, dirty worktree, and healthy state.

- [ ] Change heap defaults.

```bash
BUILD_HEAP_MB="${BUILD_HEAP_MB:-4096}"
BUILD_WORKER_HEAP_MB="${BUILD_WORKER_HEAP_MB:-512}"
BUILD_HEAP_MB_LOW="${BUILD_HEAP_MB_LOW:-3072}"
BUILD_WORKER_HEAP_MB_LOW="${BUILD_WORKER_HEAP_MB_LOW:-512}"
```

- [ ] Run preflight after `.env` preparation and before `prisma db push`, build, or PM2 restart. The old release continues serving if it fails.

- [ ] Add a lightweight tracked-worktree check before `git fetch`/`git pull`; a dirty production checkout aborts before changing branches. Run the full resource/secret/DB preflight after `.env` preparation.

- [ ] Run `npx tsx scripts/verify-deploy-preflight.ts && bash -n deploy/deploy.sh && npx tsc --noEmit`.

- [ ] Commit: `git commit -m "feat(deploy): preflight secrets database and build headroom"`.

### Task 3: Make staging builds clean and post-restart rollback automatic

**Files:**

- Modify: `tsconfig.json`
- Modify: `deploy/deploy.sh:75-175`
- Create: `scripts/verify-deploy-script.ts`

- [ ] Confirm the required staging type include is intentionally tracked. Add `.next-staging/types/**/*.ts` once to `tsconfig.json` if Next requires it; remove duplicate equivalent `.next` includes rather than letting the build rewrite the file.

- [ ] Before build, capture `git diff --name-only` for tracked files. After build, fail if the tracked diff changed. Ignore `.next*` build directories only because they are untracked/ignored artifacts.

```bash
TRACKED_STATUS_BEFORE="$(git status --porcelain --untracked-files=no)"
# run_next_build
test "$(git status --porcelain --untracked-files=no)" = "$TRACKED_STATUS_BEFORE" || {
  echo "ERROR: build modified tracked files" >&2
  exit 1
}
```

- [ ] After atomic swap/restart, wait up to 90 seconds for all gates:

  - `/api/health` HTTP 200;
  - exactly one online `ai-content`;
  - exactly one online `mcp-video-worker`;
  - exactly two online `render-worker` instances;
  - no `processing` VideoJob older than the deploy start without an active owner;
  - `PRAGMA quick_check` remains `ok` and required schema columns exist.

- [ ] On failure, stop the failed web process, move failed `.next` aside, restore `.next.old`, restart `ai-content`, and re-run health. Keep the additive schema. Exit non-zero and do not print environments.

```bash
rollback_web_build() {
  pm2 stop ai-content || true
  rm -rf "$APP_DIR/.next.failed"
  mv "$APP_DIR/.next" "$APP_DIR/.next.failed"
  mv "$APP_DIR/.next.old" "$APP_DIR/.next"
  pm2 restart ai-content
}
```

- [ ] Remove `pm2 startup` from routine deploy; setup owns systemd registration. Keep the existing `systemctl is-enabled pm2-root` self-check and `pm2 save`.

- [ ] `verify-deploy-script.ts` should inspect the shell file for exact heap defaults, preflight before restart, BUILD_ID gate, tracked-file gate, rollback function, health gates, and absence of routine `pm2 startup`.

- [ ] Run `npx tsx scripts/verify-deploy-script.ts && bash -n deploy/deploy.sh && git diff --check`.

- [ ] Commit: `git commit -m "feat(deploy): rollback failed staged releases"`.

### Task 4: Harden MCP startup and bounded drain

**Files:**

- Modify: `ecosystem.config.js:180-201`
- Modify: `scripts/mcp-video-worker.ts:31-112`
- Modify: `src/lib/mcp/video-job.ts`
- Create: `scripts/verify-mcp-worker-drain.ts`

- [ ] Add `max_restarts: 10`, `min_uptime: "20s"`, and `kill_timeout: 45000` to `mcp-video-worker`, matching the detectable crash-loop policy used by web/render workers.

- [ ] Replace the signal boolean-only handler with one idempotent shutdown promise. Signal handling immediately sets `acceptingClaims = false`; no new job is claimed after this point.

- [ ] Wait up to `MCP_DRAIN_TIMEOUT_MS` (default 35 seconds) for active jobs. If all finish, disconnect cleanly. At timeout, record active job IDs and current steps only, then exit; startup recovery may requeue only existing `SAFE_TO_REQUEUE_STEPS` and fails billable stages rather than replaying them.

- [ ] Add an atomic claim guard option or pre-claim check so a signal received between loop condition and DB update cannot claim a new job. The verifier drives that race explicitly.

- [ ] Tests prove: no claims after signal; safe active step that is cut off is requeued on simulated boot; render/avatar/burn step is not replayed; shutdown completes within deadline; two signals do not run cleanup twice.

- [ ] Run `DATABASE_URL=file:/tmp/heroai-mcp-drain.db npx prisma db push --skip-generate && DATABASE_URL=file:/tmp/heroai-mcp-drain.db npx tsx scripts/verify-mcp-worker-drain.ts && npx tsc --noEmit`.

- [ ] Commit: `git commit -m "fix(worker): guard MCP crash loops and drain claims"`.

### Task 5: Encode Bangkok schedules as tested UTC cron

**Files:**

- Modify: `ecosystem.config.js:60-165`
- Create: `scripts/verify-bangkok-cron.ts`

- [ ] Change only these expressions/comments:

| PM2 app | UTC cron | Bangkok |
|---|---|---|
| `db-backup` | `0 19 * * *` | 02:00 next day |
| `cleanup-videos` | `0 20 * * *` | 03:00 next day |
| `media-cleanup` | `30 20 * * *` | 03:30 next day |
| `mine-loanwords` | `10 21 * * *` | 04:10 next day |
| `trial-expiry` | `0 1 * * *` | 08:00 same day |
| `renewal-reminders` | `0 2 * * *` | 09:00 same day |

- [ ] The verifier loads ecosystem config, asserts exact expressions, converts the UTC hour/minute with `Intl.DateTimeFormat({ timeZone: "Asia/Bangkok" })`, and asserts intended local time. It also asserts media cleanup remains dry-run at this stage.

- [ ] Run `npx tsx scripts/verify-bangkok-cron.ts && npx tsx scripts/verify-media-cleanup-mode.ts`.

- [ ] Commit: `git commit -m "fix(ops): schedule heavy jobs for Bangkok off-peak"`.

### Task 6: Add request timing and 14-day-plus raw logs

**Files:**

- Modify: `deploy/nginx.conf`
- Modify: `docs/ops/ops-guardrails-runbook.md`
- Create: `scripts/verify-nginx-observability.ts`

- [ ] Add an HTTP-context log format containing ISO time, `$request_id`, method/URI, status, bytes, `$request_time`, `$upstream_response_time`, and upstream status. Add `X-Request-ID` to upstream and response.

```nginx
log_format heroai_timed '$time_iso8601 request_id=$request_id method=$request_method uri=$uri status=$status bytes=$body_bytes_sent request_time=$request_time upstream_time=$upstream_response_time upstream_status=$upstream_status';
access_log /var/log/nginx/heroai_access.log heroai_timed;
```

- [ ] Keep the inbound MCP auth header stripping unchanged. The verifier must fail if those two empty `proxy_set_header` lines disappear.

- [ ] Update the runbook to daily compressed PM2 rotation with at least 30 archives, providing more than the required 14-day window under normal rotation:

```bash
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
pm2 set pm2-logrotate:retain 30
pm2 set pm2-logrotate:max_size 1G
pm2 set pm2-logrotate:compress true
pm2 save
```

- [ ] Add a weekly check of the oldest compressed archive timestamp. If the observed window falls below 14 days despite the 30-file/1G policy, copy daily PM2 archives to the existing off-box backup target; do not increase unbounded local retention.

- [ ] Verify locally with `npx tsx scripts/verify-nginx-observability.ts`; on production copy config to the actual include path, run `nginx -t`, reload, then make one health request and confirm the new line has finite request/upstream times and a request ID.

- [ ] Commit: `git commit -m "feat(ops): log request ids and upstream latency"`.

### Task 7: Fix multi-instance watchdog and cron status coverage

**Files:**

- Modify: `scripts/ops-watchdog.sh`
- Modify: `src/lib/cron-heartbeat.ts`
- Modify: `scripts/backup-db.ts`
- Modify: `scripts/media-cleanup.ts`
- Modify: `scripts/cron-mine-loanwords.ts`
- Create: `scripts/verify-ops-watchdog.ts`

- [ ] Replace first-match PM2 status with expected instance counts: `ai-content:1`, `mcp-video-worker:1`, `render-worker:2`. Parse fixture `pm2 jlist` JSON inside the verifier; production watchdog still reads live JSON only into a shell variable and never writes/logs it.

- [ ] Alert when any instance is non-online, the count differs, or any PM2 app is errored. Tests cover first render worker online/second errored, one missing, two online, and duplicate unexpected instance.

- [ ] Add heartbeats for `db-backup`, `media-cleanup`, and `mine-loanwords`. Heartbeat writes occur only after the entire successful action—including configured off-box copy—finishes.

- [ ] Add `writeCronFailure(name, code)` that writes a fixed sanitized code to `<name>.failed`; never an exception string. The watchdog alerts immediately when a failure marker is newer than the success heartbeat.

- [ ] Add heartbeat intervals:

```text
db-backup:86400
media-cleanup:86400
mine-loanwords:86400
media-manifest:86400
```

- [ ] Add 5xx rate check from the last 1,000 `heroai_access.log` records, requiring at least 100 samples and alerting at >=5%. Parse only `status=`, never request headers/bodies.

- [ ] Consume a sanitized `.ops-metrics/media-health.json` count produced by the media reference plan/dry-run; alert if `missingBeforeExpiry` increases over the stored prior count. Write the baseline atomically only after parsing succeeds.

- [ ] Run `npx tsx scripts/verify-ops-watchdog.ts && bash -n scripts/ops-watchdog.sh && npx tsc --noEmit`.

- [ ] Commit: `git commit -m "feat(ops): watch every worker and cron outcome"`.

### Task 8: Make notification/job polling visibility-aware

**Files:**

- Create: `src/lib/client-polling.ts`
- Create: `scripts/verify-client-polling.ts`
- Modify: `src/components/layout/notification-bell.tsx`
- Modify: `src/app/(dashboard)/video-editor/_v2/useV2Job.ts`
- Modify: `src/components/v2-job-badge.tsx`

- [ ] Implement a single recursive timeout scheduler that never overlaps requests and accepts `isVisible`, `isActive`, `fastMs`, `idleMs`, `hiddenMs`, and injected timer/fetch callbacks. `stop()` aborts the in-flight fetch and clears the next timeout.

- [ ] Notification policy: fetch on mount/focus/open; while visible+closed poll every 60 seconds; visible+open every 15 seconds; hidden stop until `visibilitychange`; back off to five minutes after three consecutive network failures.

- [ ] Active VideoJob policy: visible active job every 5 seconds; hidden active job every 30 seconds; queued job may use 5 seconds; done/failed/canceled stops. No interval exists when no active job.

- [ ] `v2-job-badge` follows visible 15 seconds / hidden 60 seconds and stops when there is no relevant job.

- [ ] Tests use a fake clock to prove no overlap on slow fetch, pause/resume, active/idle intervals, failure backoff/reset, terminal stop, and unmount abort.

- [ ] Run `npx tsx scripts/verify-client-polling.ts && npx tsc --noEmit`.

- [ ] Commit: `git commit -m "perf(client): pause and back off idle polling"`.

### Task 9: Reset and bound route-level Web Vitals

**Files:**

- Modify: `src/components/telemetry/telemetry-provider.tsx`
- Create: `scripts/verify-web-vitals-guard.ts`

- [ ] Extract pure validation:

```ts
export function validWebVital(metric: "LCP" | "CLS" | "INP", value: number): boolean {
  if (!Number.isFinite(value) || value < 0) return false;
  if (metric === "CLS") return value <= 10;
  return value <= 120_000;
}
```

- [ ] Make the observer effect depend on `pathname`; capture the route and observer start time, disconnect/flush once on navigation, and ignore buffered entries older than that route observation. Include `path` in event properties.

- [ ] Guard `flushVitals` against duplicate visibility/pagehide/cleanup emission. Invalid values are discarded and optionally counted as a sanitized `web_vital_discarded` event without the raw value.

- [ ] Tests cover NaN/Infinity/negative/huge durations, CLS bound, duplicate flush, route reset, and old buffered entry exclusion.

- [ ] Run `npx tsx scripts/verify-web-vitals-guard.ts && npx tsc --noEmit`.

- [ ] Commit: `git commit -m "fix(telemetry): reset and bound Web Vitals per route"`.

### Task 10: Reuse the guarded avatar uploader in the legacy creator

**Files:**

- Modify: `src/app/(dashboard)/video-creator/page.tsx:3370-3391`
- Reuse: `src/app/(dashboard)/video-editor/_components/DirectAvatarUpload.tsx`
- Create: `scripts/verify-legacy-avatar-upload.ts`

- [ ] Replace the inline `fetch(FormData)` file input with `DirectAvatarUpload`. Preserve existing URL input and state behavior.

```tsx
<DirectAvatarUpload
  onUrl={(url) => {
    setAvatarDirectUrl(url);
    setDirectCompositeUrl("");
  }}
  label="อัปโหลดไฟล์วิดีโอ (mp4/mov/webm)"
  hint="สูงสุด 500 MB"
/>
```

- [ ] The verifier asserts the creator imports/reuses this component, has no direct `fetch("/api/videos/upload-avatar")` in the legacy page, and the shared component retains 500 MB client guard, XHR progress, auth/413/507 messages, and input reset.

- [ ] Run `npx tsx scripts/verify-legacy-avatar-upload.ts && npx tsc --noEmit`.

- [ ] Commit: `git commit -m "perf(upload): guard legacy avatar uploads with progress"`.

### Task 11: Require off-box backups and generate media manifests

**Files:**

- Modify: `scripts/backup-db.ts`
- Create: `scripts/backup-retained-media.ts`
- Create: `scripts/verify-backup-offbox.ts`
- Modify: `docs/ops/ops-guardrails-runbook.md`

- [ ] Add `REQUIRE_OFFBOX_BACKUP=1` production policy. When enabled, missing `BACKUP_RSYNC_TARGET`, missing rsync, or rsync failure writes `db-backup.failed`, does not write success heartbeat, and exits 2. Local development keeps optional behavior unless the flag is set.

- [ ] After snapshot `quick_check` and configured rsync succeed, write `db-backup` heartbeat. Never log the rsync target; log only `off-box copy sent`.

- [ ] `backup-retained-media.ts` builds from the complete reference graph, writes a canonical sorted manifest of live/protected relative path/bytes/mtime records, hashes it, then uses rsync `--files-from` with relative paths to copy only those retained files plus manifest/hash to `MEDIA_BACKUP_RSYNC_TARGET`. It must not copy expired/unreferenced candidates or include usernames/secrets.

- [ ] Require `MEDIA_BACKUP_RSYNC_TARGET` when `REQUIRE_OFFBOX_BACKUP=1`. Never log either rsync target. Write `media-manifest` heartbeat only after both the retained-media copy and manifest/hash copy succeed; write a sanitized failure marker otherwise.

- [ ] Add the manifest job to PM2 after cleanup, at UTC `0 22 * * *` (Bangkok 05:00), with no apply/delete capability. Extend `verify-bangkok-cron.ts` to assert this seventh schedule.

- [ ] Tests use a fake rsync executable/target directory and prove success heartbeat, configured failure marker/exit 2, missing-target failure under required mode, manifest hash check, only live referenced media is copied, no target value appears in captured logs, and local snapshot integrity.

- [ ] Run `npx tsx scripts/verify-backup-offbox.ts && npx tsc --noEmit`.

- [ ] Commit: `git commit -m "feat(backup): require off-box DB and media manifests"`.

### Task 12: Automate a monthly restore drill

**Files:**

- Create: `scripts/restore-drill.ts`
- Create: `scripts/verify-restore-drill.ts`
- Modify: `docs/ops/ops-guardrails-runbook.md`

- [ ] The drill always restores into a new temporary directory/database, never the live DB. It downloads/copies the selected off-box snapshot, validates SHA if available, runs `PRAGMA quick_check`, applies Prisma read-only smoke queries, checks core table counts are non-negative, restores a sample from the retained-media manifest, validates its size/hash/ffprobe result, and records elapsed time.

- [ ] Require explicit `--snapshot=<path>` and `--work-dir=<empty-dir>`. Reject the live DB path, app Prisma directory, non-empty work dir, symlinks, and paths outside the operator-selected root.

- [ ] Output a sanitized JSON result with snapshot basename, size, quick-check result, schema checks, row counts, and elapsed seconds. Target RTO is <=2 hours; RPO is <=24 hours based on snapshot timestamp.

- [ ] Tests cover valid restore, corrupt DB, stale snapshot, missing checksum, live-path rejection, symlink rejection, and non-empty work directory.

- [ ] Run `npx tsx scripts/verify-restore-drill.ts && npx tsc --noEmit`.

- [ ] Document a monthly operator reminder; do not schedule an automatic production restore or swap.

- [ ] Commit: `git commit -m "feat(backup): verify off-box restore without touching live DB"`.

### Task 13: Staged production rollout

**Files:**

- Production config only after each reviewed code commit lands on `main`.

- [ ] Window A: deploy env/preflight/build rollback/MCP drain. Test a clean-shell PM2 restart, an intentionally missing dummy-required-secret fixture outside production processes, one controlled deploy rollback, and process counts.
- [ ] Window B: apply UTC schedules and Nginx timing config. Validate Bangkok conversions, `nginx -t`, log fields, and next heartbeat times.
- [ ] Window C: deploy watchdog/polling/Web Vitals/avatar guard. Compare request rate, notification/job poll traffic, frontend metric outliers, and 5xx rate for 24 hours.
- [ ] Window D: configure off-box target without printing it, run one DB backup and media manifest, verify remote hashes, then run restore drill against a copy.
- [ ] Roll back the affected window only on failure. Do not roll back additive schema or re-enable unsafe media deletion.

## Final Verification

- [ ] Run all new focused verification scripts, `npx prisma validate`, `npx prisma generate`, `npx tsc --noEmit`, `bash -n deploy/deploy.sh`, `bash -n scripts/ops-watchdog.sh`, and `git diff --check`.
- [ ] Run existing render queue, editor project, subtitle invariant, render receipt, and MCP pipeline timeout regressions.
- [ ] Verify a production build leaves tracked `git status --short` clean, all expected PM2 instances online, and health/schema/queue gates green.
- [ ] Verify Nginx timing/request IDs, at least 14 days of log retention policy, current cron heartbeats, successful off-box backup, and a passing isolated restore drill.
- [ ] Acceptance: no secret-start crash loop, no failed build replaces the old app, Bangkok schedules are correct, idle polling drops, invalid Web Vitals disappear, and DB RPO/RTO targets are evidenced.
