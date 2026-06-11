# Video Editor & Render Pipeline Optimization — Design

- **Date:** 2026-06-10
- **Author:** Mew (+ Claude), reviewer: wao
- **Status:** Approved design, pending implementation plan
- **Scope decision:** Approach B — Phase 1 quick wins (this week) + Phase 2 durable queue & render-worker split (2–4 weeks). Phase 3 (Player preview, page.tsx decomposition) documented but NOT committed; re-decide after Phase 2 is stable.

## 1. Problem

The video editor / render pipeline works but is chronically unstable and slow. Evidence gathered 2026-06-10 (code audit of all 5 subsystems, prod VPS logs/DB, and the full 616-commit history):

**Production (last ~2 days):**
- 3 kernel OOM kills of the node process (~15.5GB RSS on a 15.6GB box); each takes down web + all in-flight renders at once.
- 26 PM2 restarts in 41h; every restart silently kills in-flight renders. 1 video stuck PROCESSING (age 2.4h) right now; 8 all-time. Stale detection takes 180 minutes.
- 25 burn failures **today** from a single cause: plan limit is checked at the final burn step, after the full render already consumed CPU.
- Render queue waits up to 21.2 min (renders strictly serialized); fetch-stock spiked to 50 min; p95 render 21.6 min.
- 414MB / 9.7M-line PM2 error log; disk 59GB media and growing; deploy-in-place caused a 1,014-line `.next not found` crash loop.

**History:** 402/616 commits are fixes. Chronic themes: subtitle timing (~182 commits), Gemini fragility (~105), B-roll/stock (~88), render stuck/timeout/polling (~76, stale timeout flip-flopped 6+ times), OOM (~31), disk/cache bloat (~39). The "stuck job" class alone has been re-patched 15+ times — these are symptoms of architecture, not isolated bugs.

**Root causes (ranked):**
1. **One process does everything** — Next.js web server, Remotion/Chromium render, and ffmpeg burn share one Node process on 4 vCPU/15.6GB. Render OOM kills the app; render CPU starves interactive traffic. Web heap is set to 12GB *only because* renders run inside it, which in turn makes deploys OOM/swap.
2. **No durable job state** — in-memory FIFO + `.tmp/render-jobs` progress files. Restart ⇒ queue and cancel maps vanish, quota leaks, rows stay PROCESSING.
3. **The browser orchestrates the pipeline** — sequential fetches + client polling loops. Tab close/refresh kills work (refresh even auto-cancels by design). Burn polling has NO stale timeout (can show "Burning…" forever); `poll-avatar` masks HeyGen 401/404 as `unknown` and spins 30 min (the kapokja mechanism — still open at HEAD).
4. **Editor monolith** — `src/app/(dashboard)/video-editor/page.tsx` is 4,115 lines with 91 useState; a rAF loop calls `setCurrentMs` ~60×/sec during playback re-rendering the entire tree (page.tsx:516-565), plus a duplicate `onTimeUpdate` handler (page.tsx:3334-3341). Direct cause of "laggy editor".
5. **Unguarded external calls** — most HeyGen/ElevenLabs/Gemini/Pexels/Pixabay fetches have no timeout; `tts-gemini` installs a process-wide undici dispatcher with 600s phases; 429s are invisible; BYOK key errors don't consistently trigger the fix-your-key UX.
6. **Wasted CPU** — Burn is a full second Remotion render per video; every deploy invalidates the Remotion webpack bundle (first render after deploy stalls 2–5 min and serializes everyone); Remotion `offthreadVideoCacheSizeInBytes` defaults to **half of free system RAM**.

## 2. Goals (measurable)

| Metric | Today | Target |
|---|---|---|
| Videos stuck PROCESSING with no terminal state | 8 all-time, 1 live | **0** |
| Dead-job detection time | 180 min | **< 2 min** |
| Renders surviving deploy/restart | die silently | **100% requeued** |
| Kernel OOM kills of the web process | 3 in 2 days | **0** (worker dies first, self-recovers) |
| Burn failures from plan limits | 25/day | **0** (pre-checked) |
| Whole-page re-renders during playback | ~60/sec | **none** (leaf updates only) |

## 3. Non-goals

- No new monthly infrastructure spend: no Redis, no Postgres, no R2, no second server. (Those remain `docs/scale-upgrade-plan.md` for when budget exists; this design is deliberately its compatible precursor — the Phase 2 job model maps 1:1 onto BullMQ later.)
- No Player preview / no big-bang rewrite of page.tsx (Phase 3, re-decided later).
- No user-visible flow changes except strict improvements (e.g., refresh no longer kills renders).
- TTS/transcribe/stock steps stay browser-orchestrated in Phase 2 (moving them is Phase 3 material).

## 4. Research basis (fact-checked 2026-06-10)

- **Remotion official guidance:** rendering inside Next.js is an explicit anti-pattern; the sanctioned architecture is a separate long-lived render process that calls `ensureBrowser()` + `bundle()` once at startup, runs a FIFO queue, reports `onProgress`, cancels via `makeCancelSignal()` (template-render-server). Maps 1:1 to a second PM2 app + SQLite queue. `offthreadVideoCacheSizeInBytes` defaults to half of free RAM and must be capped on a shared box; `concurrency` ≈ 2 on 4 threads; `gl: 'swangle'` for no-GPU.
- **Industry:** no surveyed product (Descript, VEED, Kapwing, Opus Clip, Runway) server-renders an editable preview — preview is always client-side; export is always an async durable job with a state machine (QUEUED/RUNNING/STALLED/FAILED/DONE + attempts). VEED/Descript run every third-party call as a retryable activity (Temporal); the one-box equivalent is a SQLite jobs table with atomic claims. Progress UX is polling a durable record (not SSE) with jitter and hard stop on fatal errors.
- **Single-box mechanics:** SQLite is a proven queue substrate **iff** WAL + `busy_timeout` + `BEGIN IMMEDIATE`/`UPDATE…RETURNING` claims. Prisma can't set busy_timeout → worker talks to the same db via better-sqlite3 (or Prisma driver adapter). PM2 `max_memory_restart` doesn't see Chromium/ffmpeg children and `nice` is neutralized by kernel autogrouping — real containment is cgroups v2 (CPUWeight/MemoryMax) + `oom_score_adj` steering.
- **HeyGen:** webhooks confirmed (`avatar_video.success/fail`, HMAC `Heygen-Signature`, retries up to 24h). Error codes map cleanly to terminal-vs-retryable (401 invalid key / 402 credit / 404 not found = fail fast; 429 honors Retry-After; 5xx retryable). BYOK nuance: webhooks register per HeyGen account → register idempotently per user key. ⚠️ v1 API sunsets 2026-10-31 — audit our usage during PR-10.
- **Editor perf:** the universal timeline-editor rule is *currentTime never lives in React state* — rAF + refs + direct DOM writes (or external store with granular subscriptions). React Compiler helps cascades but cannot fix a 60Hz setState at the root. `useEffectEvent` is stable on our React 19.2.3.

## 5. Phase 1 — Quick wins (5 independent PRs, this week)

Deploy order: **PR-4 → PR-1 → PR-2 → PR-5 → PR-3** (machine guardrails first; the riskiest-to-test last). Each is independently revertible.

### PR-1: Fail-fast quota + close the kapokja hole (low risk)
- Move `reserveClipUsage` / plan-limit check to **before** render/burn starts in `src/app/api/videos/render/route.ts`; reply 403 `quota_exceeded` immediately; frontend shows clear message + pricing link.
- `src/app/api/videos/poll-avatar/route.ts`: check `res.ok` and map HeyGen codes — 401/400112 → `invalid_key` (terminal, "fix your HeyGen key in Settings"), 404 → `not_found` (terminal), 402 → `insufficient_credit`; only 5xx/timeouts continue polling. Client loops (`runAvatarPipeline` page.tsx:~1850, `runAvatarTail` page.tsx:~1813) honor the new terminal statuses.

### PR-2: Polling can never hang forever (medium risk — full flow test before merge)
- One shared poll helper for render/burn/avatar: stale-timeout (no progress change for 10 min ⇒ fail with "check gallery" action — conservative enough to survive the 2–5 min post-deploy bundle stall; Phase 2's 90s heartbeat supersedes it), max attempts, exponential backoff on transient errors, tolerate non-JSON bodies (Nginx 502 HTML must NOT be treated as job failure — today it makes users retry and stack duplicate burns), single in-flight request guard.
- Collapse the 3 concurrent poll loops (600ms + 3s + 2s×2 ≈ 4.3 req/s per user at peak load) into one 1.5–2s loop + 10s status fallback.
- `useEffect` cleanup on unmount: clear all intervals, abort controllers, stop the 30-min HeyGen loop (today they leak across SPA navigation).

### PR-3: Editor lag fix (medium risk)
- Playhead, time label, and active-caption highlight move to rAF + refs + direct DOM writes (`transform`/`textContent`); `currentMs` state remains but updates coarsely (pause/seek) so existing logic is untouched.
- Remove the duplicate `<video>` time handlers (page.tsx:3334-3341); module-level `Intl.Segmenter` singleton (today constructed per call, renderSubtitle.tsx:41-55); `content-visibility: auto` on caption rows + preset cards; `useDeferredValue` for the 17 preset cards.
- Acceptance: React DevTools profiler shows no whole-tree re-renders during playback; play/pause/scrub/edit-while-playing behave identically.

### PR-4: Ops guardrails (low risk — mostly config)
- `pm2-logrotate` (50MB × 5) + remove per-poll verbose logging in render routes.
- SQLite `PRAGMA journal_mode=WAL` (persistent) + busy_timeout — also a Phase 2 prerequisite.
- `deploy/deploy.sh`: build into a temp dir, atomically swap `.next` on success — closes the crash-loop window. Build RAM profile unchanged (same heap caps, same OOM-retry env). **wao review point.**
- Set `offthreadVideoCacheSizeInBytes` explicitly (~1–2GB).
- Stock normalize: realistic timeout; on failure drop the clip and substitute a fallback instead of silently keeping a broken file (today: SIGKILL at 120s ⇒ un-normalized clip ⇒ Remotion "Invalid data" later).
- Note: deploy-OOM root cause (web heap 12GB + build 4.5GB > 15.6GB) is fixed in Phase 2 PR-8 when the web heap drops to ~3GB. Optional follow-up (needs wao buy-in): build on GitHub Actions and ship artifacts.

### PR-5: External-call armor (low-medium risk)
- `fetchWithBudget(url, opts, {timeoutMs, retries})`: per-call AbortSignal, retry only retryable errors (429 honors Retry-After, 5xx) with jittered backoff + wall-clock cap.
- Remove the global undici dispatcher override in `tts-gemini` (today it lets EVERY fetch in the process hang 10 min per phase); use a per-request dispatcher for the one call that needs it.
- Error taxonomy (shared type): `invalid_key | quota | rate_limit | transient | fatal` with `{code, provider, message, userAction, retryable}` — all video routes return this shape; UI maps to the right action.

## 6. Phase 2 — Durable queue + render worker (5 PRs, weeks 2–4)

### 6.1 `RenderJob` table (PR-6 — **wao review point: prisma/schema.prisma**)

```prisma
model RenderJob {
  id              String   @id @default(cuid())
  videoId         String?
  userId          String
  type            String   // RENDER | BURN | COMPOSITE | AVATAR_POLL
  status          String   // QUEUED | RUNNING | DONE | FAILED | CANCELLED
  attempts        Int      @default(0)
  maxAttempts     Int      @default(2)
  payload         String   // JSON: full render config — no in-memory dependence
  progress        Float    @default(0)
  phase           String?  // bundling | rendering | encoding
  heartbeatAt     DateTime?
  cancelRequested Boolean  @default(false)
  error           String?  // JSON, PR-5 taxonomy
  idempotencyKey  String?  @unique
  createdAt       DateTime @default(now())
  startedAt       DateTime?
  finishedAt      DateTime?
  @@index([status, type])
  @@index([userId, createdAt])
}
```

Additive migration only — `deploy.sh` already runs `prisma db push` before restart.

### 6.2 `render-worker` (PR-7 — **wao review point: ecosystem.config.js**)

New PM2 fork app (same pattern as the 4 existing cron apps, but long-lived):
- Boot: `ensureBrowser()` + `bundle()` **once**, bundle dir keyed by build SHA (fixes the 2–5 min post-deploy bundle stall + bundle-lock serialization).
- Loop: atomic claim via better-sqlite3 `UPDATE … RETURNING` (WAL from PR-4); one job at a time; `renderMedia` concurrency 2, `gl:'swangle'`, capped offthread cache; `onProgress` → row update ~1/s; checks `cancelRequested` each tick → `makeCancelSignal()`.
- Heartbeat: `heartbeatAt` every 10–15s.
- Graceful shutdown: SIGINT ⇒ stop claiming, cancel current render, set job back to QUEUED (deploy-cancel does not consume an attempt), exit; PM2 `kill_timeout` 30s + `wait_ready`.

### 6.3 Sweeper (PR-7, repurposes `reconcile-processing` cron)

`RUNNING` with `heartbeatAt` older than 90s ⇒ worker is dead ⇒ `attempts < maxAttempts` ? requeue : FAIL + **refund clip quota** + mark gallery Video FAILED. Detection in ~1 min instead of 180. Poison jobs (crash the worker twice) go FAILED permanently with a log marker.

### 6.4 Thin web routes (PR-7 behind flag, PR-9 cutover)

- `POST /api/videos/render` → validate + quota (PR-1) + INSERT job + return `jobId` in ms.
- `render-progress`/`render-status` → read the DB row (no `.tmp` files, no in-memory maps).
- `render-cancel` → set `cancelRequested=true` (works cross-process, cross-restart).
- **Refresh/close-tab = work continues.** Remove the mount-time auto-cancel (page.tsx:444-448) and the sendBeacon cancel-on-unload; on reload, re-attach to the active job by jobId and resume progress display.

### 6.5 RAM/CPU containment (PR-8)

- Web process heap 12GB → ~3GB (possible only once renders leave the process; this also fixes deploy OOM/swap: 3 + 4.5 build ≪ 15.6).
- Worker: heap ~4GB; `oom_score_adj` high (worker tree) / low (web) — kernel kills the worker first, sweeper requeues, web never dies.
- CPU: worker under a cgroup v2 slice with low `CPUWeight` — renders use idle CPU fully but yield instantly to web traffic. (`nice` and `cpulimit` are documented non-solutions.)

### 6.6 Avatar via webhooks + server-side polling (PR-10)

- Register HeyGen webhook per user key (idempotent; store per-user secret; verify HMAC `Heygen-Signature`; 2xx within 10s). Events update the job/video directly; composite chains server-side — close-the-tab freedom for avatar flows.
- Fallback `AVATAR_POLL` job in the worker (backoff + wall-clock cap) for missed webhooks.
- Circuit breaker per (userId, provider) — repeated 401 trips immediately to the fix-your-key UX; no hammering.
- Audit HeyGen API version usage; migrate off v1 (sunset 2026-10-31).

### 6.7 Rollout flags

| PR | Content | Rollback |
|---|---|---|
| 6 | RenderJob migration (additive) | none needed |
| 7 | worker + queue behind `RENDER_VIA_QUEUE=1`; legacy path intact | flip env |
| 8 | enable flag on prod, then shrink web heap + oom_score_adj + cgroup | flip env |
| 9 | refresh-resume UX + remove legacy render path | revert PR |
| 10 | HeyGen webhook + AVATAR_POLL behind `HEYGEN_WEBHOOK=1` | flip env |

## 7. Phase 3 — documented, NOT committed (re-decide after Phase 2)

1. **Remotion `<Player>` preview** — replace the server-rendered preview MP4 with the same composition playing client-side: instant preview, ~half the server CPU per video, true WYSIWYG (kills the preview/burn-mismatch bug class). Needs: same-origin asset serving, Thai font loading parity (`@remotion/google-fonts`), low-end Android testing, feature flag + parallel path. OffthreadVideo preview is ±1-frame best-effort vs burn (acceptable: B-roll background only; subtitle timing is frame-driven, unaffected).
2. **Cheap-burn alternative** (if Player is deferred): render only the subtitle layer as a transparent overlay and ffmpeg-composite onto the existing MP4 — burn cost collapses without changing the preview flow.
3. **page.tsx strangler-fig decomposition** — extract memoized leaf components into `_components/` incrementally (never big-bang); external store (zustand/useSyncExternalStore) for playback state; virtualize transcript; consider React Compiler.
4. Move TTS/transcribe/stock into the job system with per-step records + content-hash caching (same TTS for same script+voice, etc.).

## 8. Error handling (system-wide contract)

All user-facing errors: `{ code, provider, message, userAction, retryable }`.

| code | UI | System behavior |
|---|---|---|
| `invalid_key` | "Key ใช้ไม่ได้ — แก้ที่ Settings" + link | breaker opens for (user, provider); no retries |
| `quota` | plan limit + pricing link | rejected BEFORE work starts |
| `rate_limit` | "provider asks to wait" | auto-retry per Retry-After |
| `transient` | invisible if retry succeeds | silent retry + backoff within budget |
| `fatal` | generic error, logged marker | job → FAILED, never stuck |

Invariants: every job reaches a terminal state; FAILED always refunds quota and marks the gallery Video FAILED; poison jobs stop after maxAttempts.

## 9. Testing

- **Logic:** `scripts/verify-render-queue.ts` (repo's verify-* pattern, throwaway SQLite): all state transitions; concurrent-claim atomicity (two claimers, no double-claim); sweeper requeue/fail+refund; idempotency keys.
- **Flow (every PR, dev):** render (avatar full/bookend/none) → edit subtitles → burn → cancel mid-flight → refresh and resume.
- **Chaos (prod, off-peak — Phase 2 acceptance criteria):**
  1. `kill -9` the worker mid-render ⇒ job back to QUEUED ≤ 90s and completes without user action.
  2. Deploy mid-render ⇒ graceful drain + requeue, zero lost jobs.
  3. Memory pressure ⇒ worker dies first, web keeps serving 200s.
- **Editor:** profiler before/after (no whole-tree re-renders during playback); low-end Android device test.

## 10. Metrics & reporting

Add `pipelineRunId` to existing telemetry (closes the known attribution gap). `scripts/ops-report.ts` prints weekly: stuck-PROCESSING count, requeue count, OOM kills, p50/p95 queue wait + render duration, burn failures by error code.

## 11. Coordination with wao

- Shared-file review points: `prisma/schema.prisma` (PR-6), `ecosystem.config.js` (PR-7), `deploy/deploy.sh` (PR-4) — tagged explicitly in PR descriptions.
- This design deliberately implements the first rungs of `docs/scale-upgrade-plan.md` (job model is BullMQ-compatible) and the `VideoJob` state-machine idea from `docs/heroai-mcp-server-plan.md` — no conflict, no duplication.
- Mew implements all PRs; wao reviews each before merge. Never push to main directly.

## 12. Risks

| Risk | Mitigation |
|---|---|
| SQLite contention web↔worker | WAL + busy_timeout (PR-4); single writer-worker; claims are single-statement |
| Worker bundle drift vs deployed app | bundle dir keyed by build SHA; worker restarts on deploy (graceful drain) |
| Flag-period divergence (two render paths) | flag window kept short; legacy path removed in PR-9 after chaos tests pass |
| cgroup/oom_score_adj misconfig on Hostinger kernel | verify cgroup v2 availability first; oom_score_adj alone already prevents web death |
| HeyGen webhook deliverability (BYOK accounts) | fallback AVATAR_POLL job always on; webhook is an optimization, not a dependency |
