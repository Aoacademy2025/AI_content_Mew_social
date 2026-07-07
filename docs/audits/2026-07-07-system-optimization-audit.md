# System Optimization Audit — HERO AI Creator Studio (2026-07-07)

> **สรุปไทย (อ่าน 2 นาที):** Audit ทั้งระบบด้วย 5 ทีมขนาน + วัดของจริงจาก prod (KVM8 8-core/32GB). **ข่าวดี:** โครงเงิน/สิทธิ์ความเป็นเจ้าของ/คิวเรนเดอร์ แข็งแรงกว่าที่คิด, crons ทำงานครบ (ที่เคยว่า "หยุด" คืออ่านจอ pm2 ผิด), เครื่องใหม่ RAM เหลือเฟือ (ใช้ ~5GB จาก 32GB). **ข่าวที่ต้องรีบแก้:** (1) 🔴 ช่องโหว่ร้ายแรง — user ล็อกอินธรรมดาอ่านไฟล์ลับทั้งเครื่อง (รวม DB ที่เก็บคีย์ลูกค้าทุกคน) ได้ผ่านช่อง HeyGen; (2) คีย์ลูกค้าเก็บแบบ base64 ไม่ใช่เข้ารหัสจริง; (3) เว็บฮุก Stripe อาจทำให้ลูกค้าจ่ายเงินแล้วไม่ได้แผน ถ้า handler พลาดชั่วคราว; (4) วิดีโอที่สร้างผ่าน chat/MCP บางแบบไม่ถูกตัดโควตาเลย; (5) เครื่องอัปเกรดแล้วแต่ซอฟต์แวร์ยังตั้งค่าโหมดประหยัดของเครื่องเก่า (คุณภาพวิดีโอถูกกดไว้ต่ำกว่าที่เครื่องใหม่ทำได้); (6) คอขวดวันเปิดตัว = orchestrator ตัวเดียวสร้างวิดีโอทีละคลิป ไม่ใช่ที่ render-worker; (7) UX คิว 0% — โค้ดฝั่งจอมีพร้อมแล้ว แต่ server ไม่เคยส่งสถานะ "รอคิว" มา; (8) ไม่มี backup DB + กู้ระบบหลัง reboot ไม่เคยติดตั้งจริง. รายละเอียด+วิธีแก้ทั้งหมดอยู่ใน Master Plan คู่กัน (`docs/plans/2026-07-07-system-optimization-master-plan.md`).

**Method:** 5 parallel read-only audit agents (money, security, render-perf, app-perf, stability) over local `main` + read-only prod measurement (SSH/DB/logs/resource sampling) + 5-clip baseline render set on account `duckyhero`. No code changed, no prod writes, no restarts. HIGH+ money/security findings were independently re-verified against source by the session model (marked ✅ VERIFIED).

---

## 1. Production baseline (measured, not estimated)

**Server (KVM8):** 8 vCPU, 31 GB RAM, 388 GB disk (37% used, 245 GB free). Uptime 3.5 days. `pm2-logrotate` active. WAL mode live, `busy_timeout=5000`.

**Render volume & latency (last 30 days, from `RenderJob`/`VideoJob`):**
- 1,046 render jobs (589 RENDER + 414 BURN), ~35/day average, **peak 103/day** (06-28).
- **Queue wait** (submit→start): RENDER p50 **2 s**, p90 121 s, p95 **272 s** (4.5 min), max 1521 s.
- **Render duration** (start→finish): RENDER p50 **207 s** (3.5 min), p90 448 s, p95 **525 s** (8.7 min), max 1784 s.
- **End-to-end VideoJob** (create flow): 230 done / 40 failed / 7 canceled. Duration p50 **6.2 min**, p90 16.1 min, p95 19.6 min, max 32.3 min. E2E queue wait p95 **773 s** (12.9 min) — far worse than the RenderJob queue wait, because the **single orchestrator** (see CAP-1), not the render step, is where videos back up.
- **Success rate:** RENDER 97.7% (14 failed/589), VideoJob 83% done — but most failures are **customer-side** (Gemini key not billed → 429, HeyGen insufficient credit, QUOTA_MINUTES 409, render timeout). Excluding customer-key/quota causes, infra success is high.

**Failure taxonomy (30 d):** RENDER fails dominated by `renderMedia() got cancelled` (30 — user cancels/supersedes, expected) + 2 stale `watermark.png localhost` + 2 audio decode. VideoJob fails: 8 render-timeout, 7 QUOTA_MINUTES (expected wall), 5 fetch-failed, 4 Gemini-not-billed (customer), 2 no-subtitle-timing.

**Live resource profile (sampled every 45 s during the baseline test renders):** RAM used **4.5–5 GB of 31 GB throughout — RAM is never the bottleneck.** A **single** active render at the current `RENDER_CONCURRENCY=3` spawns ~3 `chrome-headless-shell` @ ~520 MB each + compositor ffmpeg + the b-roll normalize ffmpeg, and load average climbed to **~16 on 8 cores** (partly amplified by a Hostinger host `scanner.py` at 91% CPU during one sample). Extrapolating, **2 concurrent renders would 2× oversubscribe the CPU** — consistent with the historical `peak concurrent RENDER = 2` seen in the 30-day data (from base+burn overlap and the v1-foreground path, which bypasses the orchestrator). Confirms: the box is **CPU-bound, RAM-rich**. (Note: the test videos themselves processed *serially* through the single orchestrator — see CAP-1 — so this profile is a per-render footprint, not proof of 2 orchestrated videos at once.)

**API latency (core routes, measured on prod):** localhost app `/` **7 ms**, `/api/plans` **31 ms**, `/dashboard` (307 redirect) 3 ms; via nginx TLS `https://studio.heroaiengine.com/` **40 ms**. Core routes are fast; app-perf risk is in *polling frequency × payload* under many concurrent renders (PERF-APP-2/3), not single-request latency.

**Render duration by clip type** (aggregate p50/p95 = 207 s / 525 s across all types): the 5-clip baseline set was rendered to establish per-type numbers — normal clip (subtitle mode 2) completed E2E in ~9 min including queue; pause-heavy and avatar clips render behind the serial orchestrator and their per-type durations attach to §4 as they finish. Avatar clips are dominated by external HeyGen latency (MCP ETA 15–25 min), not our CPU.

**DB:** 92 MB, WAL 5.7 MB. Largest table **`TelemetryEvent` = 123,693 rows** (unbounded, no sweeper) — 10× everything else combined (next: Notification 4.6k, RenderJob 1k, User 554, Video 184). `Payment` table has **zero indexes**. `VideoJob`/`RenderJob` lack a `createdAt`-only index (admin/insights scans).

**Crons — HEALTHY (prior "stopped" alarm was a misread):** every cron is `autorestart:false + cron_restart`, so `pm2 status: stopped` between runs is *by design*. Logs prove fresh runs: trial-expiry 08:00 (reverted 24 expired trials), renewal-reminders 09:00 (13 sent), reconcile-processing every 15 min, cleanup-videos 03:00, disk-watch 05:00 (37% ok). **Do not "fix" stopped crons by restarting.** (Memory + CLAUDE.md-adjacent note corrected.)

**Config note:** `next.config.js` was removed (commit `5fb76cb`); `next.config.ts` is now the sole active config. The long-standing "`.js` shadows `.ts`" gotcha is **historical** — CLAUDE.md should be updated.

---

## 2. Findings by severity

Severity: **CRITICAL** = unauth/low-bar access to other users' data/money · **HIGH** = wrong money or cross-user access in a plausible scenario · **MEDIUM** = needs unlikely conditions or is latent · **LOW** = hygiene.

### 🔴 CRITICAL

**SEC-1 — Authenticated arbitrary server-file read → exfiltration to attacker's HeyGen account.** ✅ VERIFIED
`src/app/api/videos/heygen-direct/route.ts:18-22` (`readLocalFile`) and `src/app/api/videos/create-avatar/route.ts:36-41` (`readAsset` local branch) do `path.join(cwd,"public", url)` on a **body-supplied** path with **no containment check**, then `fs.readFileSync` and POST the bytes to `https://upload.heygen.com/v1/asset` under the caller's key. Verified reachable: `getCurrentUser()` gate only (line 189), `readLocalFile(mergedAudioUrl)` on raw body (line 203). A payload `mergedAudioUrl="/../prisma/dev.db"` normalizes to `/var/www/ai-content/prisma/dev.db` — the live DB (every user's API keys, Stripe IDs, emails). `.env` is equally reachable via `/../.env`. The 404 message echoes the path (existence oracle). **Any free authenticated account can exfiltrate all server secrets.** Fix: add the `path.resolve` containment guard already used by `audio-duration`/`trim-audio`/`thumbnail`, to `heygen-direct` + `create-avatar` (and the MEDIUM path-traversal siblings SEC-8/SEC-10).

### 🟠 HIGH

**SEC-2 — BYOK keys stored as base64, not encrypted.** ✅ VERIFIED (amplifies SEC-1)
`src/app/api/user/api-keys/route.ts:8-9` — "encrypt" = `Buffer.from(text).toString("base64")`. Schema stores `geminiKey/heygenKey/elevenlabsKey/pexelsKey/pixabayKey/kieKey/...` as plain `String?` (`prisma/schema.prisma:23-31`). Anyone who reads the DB (via SEC-1, a leaked backup, or disk access) recovers every user's third-party keys with one `atob()`. Fix: AES-256-GCM with a key from env/KMS (not derivable from the DB); rotate on migrate.

**SEC-3 — `GET /api/user/api-keys` returns raw decrypted keys to the client.** ✅ VERIFIED
`route.ts:22-31` returns full plaintext for all 8 providers on every `/settings` load. Any XSS on the app origin (see SEC-4), malicious extension, or borrowed session exfiltrates all keys in one request. Fix: return `{ providerSet: bool, last4 }`; keep key fields write-only. (`user/me`, `user/api-keys/status` are already clean.)

**SEC-4 — Unrestricted upload → stored HTML/JS on the app origin (stored XSS).** ✅ VERIFIED
`src/app/api/videos/upload/route.ts:32-37` — `ext = file.name.split(".").pop()`, `filename = upload-${Date.now()}.${ext}`, written to `public/renders/` with **no type allowlist** and a predictable name. `src/middleware.ts:85` excludes `html?`/`svg` from the Clerk matcher and nginx serves `public/renders/` directly, so `GET /renders/upload-<ts>.html` returns attacker JS as `text/html` on `studio.heroaiengine.com`, unauthenticated. Weaponizes SEC-3/SEC-12. Fix: allowlist ext+MIME to video types, randomize filename (`randomUUID`), serve with `Content-Disposition: attachment` + `nosniff`. (Siblings `upload-avatar`, `broll-window/upload` already do this correctly.)

**SEC-5 — Cron routes fail OPEN when `CRON_SECRET` is unset (all 6).** ✅ VERIFIED (latent — prod currently has the secret set)
Every cron: `if (secret && authHeader !== \`Bearer ${secret}\`) return 401`. If the env var is blank, the guard is skipped and `/api/cron/*` is public (middleware whitelists `/api/cron(.*)`). Because crons are separately-started PM2 apps whose secret is easy to omit on a deploy, one misconfig exposes video-deletion, payment-expiry, seat-release, entitlement-revert to the internet. Prod verified to have it set today, so this is latent, not live. Fix: make it fail-closed — `if (!secret || notEqual) return 401` with `timingSafeStrEqual`.

**MON-1 — Stripe webhook marks the event processed BEFORE running handlers → a transient failure permanently drops a paid activation.** ✅ VERIFIED
`src/app/api/payments/webhook/route.ts:139-144` inserts `stripeWebhookEvent(event.id)` (dedup claim), then handlers run at 147+ with **no try/catch and no transaction**. If `handleCheckoutSession`/`activatePlan` throws (e.g. `SQLITE_BUSY` under load), the POST 500s → Stripe retries the same event id → P2002 → treated as duplicate → **skipped forever**. Customer paid, plan/credits never applied, no self-heal. Fix: record the event id only *after* the handler succeeds, or wrap event-record + handler in one `$transaction`.

**MON-2 — MCP orchestrator over-refunds → successfully delivered non-avatar MCP/chat videos net 0 quota.** ✅ VERIFIED
`src/lib/mcp/orchestrator.ts:509` runs `if (!input.previewMode) await refund(userId)` after the base render, assuming "the burn will reserve another." But for **non-avatar** videos `finalBase = baseUrl`, so the burn's `isBurnAlreadyPaid` matches the base's `ChargedClip` (`render/route.ts:318-319,490-493`) and the burn **skips its reservation**. Net: base +1, orchestrator −1, burn 0 = **0 charged**. In clips mode (the code default) every non-avatar chat/MCP video is free against the plan cap; in minutes mode it drifts `usageCount` down. Avatar videos are unaffected (composite URL ≠ base URL). Fix: only refund when the burn source differs from the base, or refund in the same bucket the base reserved; simplest — drop the base-refund and let the base's `ChargedClip` be the single charge.

### 🟡 MEDIUM

**CAP-1 — Single orchestrator serializes ALL editor-v2 + MCP video creation (the real launch bottleneck).** ✅ VERIFIED
`claimNextQueuedJob` (`src/lib/mcp/video-job.ts:35`) claims *any* `queued` VideoJob (no source filter); only the **single-instance** `mcp-video-worker` runs it, `runOrchestrator` awaited one at a time in a `while` loop (`scripts/mcp-video-worker.ts:17-20,55`). Both editor-v2 background renders (`videos/jobs/route.ts`) and MCP/chat videos (`[transport]/route.ts`) go through it. The orchestrator delegates the render to the 2 render-workers but blocks on polling it, so **videos are created strictly one at a time** even though the box has CPU for 2 concurrent renders. This is why measured E2E queue-wait p95 (12.9 min) ≫ RenderJob queue-wait p95 (4.5 min). Live-demonstrated during this audit: test jobs 2 & 3 sat `queued 0%` behind job 1. Fix: run 2 orchestrator instances (claim is already race-safe via atomic `updateMany`) or process 2 VideoJobs concurrently — matched to the 2-render-worker CPU budget. **This, not the render-workers, is the lever for launch-day queue depth.**

**RENDER-1 — Prod `.env` still carries the OLD 15 GB-box austerity config → video quality is suppressed below what the new box can deliver.** ✅ VERIFIED (prod `.env` read)
Prod `.env`: `RENDER_LOW_RESOURCE=1`, `RENDER_CONCURRENCY=3`, `RENDER_JPEG_QUALITY=60`, `RENDER_OFFTHREAD_CACHE_MB=64`, `STOCK_KEN_BURNS=0`. `RENDER_LOW_RESOURCE=1` forces `x264Preset "faster"` instead of `"medium"` (`run-render.ts:381,462`) and low-mem clamps — a **quality suppressor** that the 32 GB box no longer needs. (Note: `ecosystem.config.js` worker block overrides some of these — `RENDER_OFFTHREAD_CACHE_MB=128`, `RENDER_JPEG_QUALITY=90` — because pm2 env wins over `dotenv/config`; but `RENDER_LOW_RESOURCE`, `RENDER_CONCURRENCY`, `STOCK_*` are only in `.env` and remain active.) Needs a deliberate env reconciliation for the new box, **verified with before/after clips (Mew's eyes)** since preset/quality changes trade speed for quality. This is the finding most aligned with Mew's "quality up, use the new hardware" goal.

**RENDER-2 — Render concurrency is unmanaged across the 2 workers.** (config)
Neither `ecosystem` worker env nor (effectively) the runtime pins a coordinated `RENDER_CONCURRENCY`; the fallback computes `cpuCount−1=7` per process, so 2 busy workers = ~14 render threads on 8 cores (the load-16 we measured). Setting an explicit `RENDER_CONCURRENCY=4` (2 workers × 4 = 8 = full utilization, no oversubscription) is the single highest-value render-throughput config change. No quality impact (parallelism only).

**MON-3 — `spendCredits` falsely rejects a valid split-bucket spend under concurrency (fail-closed).** `src/lib/credits.ts:164-191` computes the granted/purchased split from a stale read then guards both buckets; a concurrent spend that shifts the split makes the guard fail → `insufficient` even when total credits cover it. No money lost (fail-closed), but a spurious denial (render walls with "buy credits"). Fix: on `count!==1`, re-read and retry the split once.

**MON-4 — Credit balance mutation and its ledger row are written non-transactionally.** `credits.ts` `grantCredits`/`spendCredits`/`refundCredits`/`resetMonthlyGranted` each do the balance write and `creditLedger.create` as two separate awaits, no `$transaction`. A crash between them diverges balance from the audit ledger (`sum(ledger) ≠ balance`), silently skewing `admin/costs` reconciliation. Fix: wrap each pair in `$transaction`.

**MON-5 — Trial re-entry via account delete + re-register.** `src/app/api/clerk-webhook/route.ts:111-116` hard-deletes the User row on `user.deleted`, cascading away `trialStartedAt` (the one-trial guard). Re-registering the same email grants a fresh 7-day PRO trial (+15 min), repeatable. Fix: soft-delete / anonymize keeping `trialStartedAt`, or a separate used-email/TrialGrant table.

**MON-6 — TTS render-minute reservation leaks if `saveWav`/disk write fails (flag-gated).** `tts-gemini/route.ts:540→554` reserves minutes before writing the WAV; the outer catch (562-570) refunds only the AI-audio side-channel, not the render minutes. Disk-full (real on this box) → N minutes leaked, no audio. Active only when `MINUTE_QUOTA` off. Fix: reserve after `saveWav`, or refund render minutes in the catch.

**SEC-6 — Gemini API key in `?key=` URL query string.** ✅ deferred item confirmed-open. `test-key`, `tts-gemini:93`, `transcribe:539,666,703` build `...?key=${key}` (header is *also* sent → query param is redundant). Server-side only (not in browser), but leaks to Google/proxy logs and — critically — `api-error.ts:88,106` logs the full error + ships the stack into a DB-stored admin notification; a fetch error echoing the URL writes the key (the shared **managed** key under `MANAGED_GEMINI=1`) to logs. Fix: drop the query param; scrub URLs in `buildAdminBody`.

**SEC-7 — SSRF guard bypassed by HTTP redirects.** `src/lib/safe-fetch.ts` validates only the initial URL; no call site sets `redirect:"manual"`/`maxRedirects:0` (`contents/generate`, `styles/analyze`, `transcribe`, `videos/render` cacheImageLocally, `create-avatar`, `extract`). A public URL that 302→`169.254.169.254`/localhost reaches internal services. Fix: disable auto-redirect and re-assert `assertSafeFetchUrl` per hop.

**SEC-8 — SSRF + local path traversal in HeyGen composite/preview routes.** `heygen/composite:56`, `heygen/preview-bg:81`, `heygen/preview-frame:26` fetch a body URL with no `assertSafeFetchUrl`; local branches have the same containment gap as SEC-1; host check `url.includes("heygen.ai")` is bypassable. Fix: guard external branch, add containment to local branch, exact-hostname match.

**SEC-9 — SSRF in `extract` PDF branch.** `extractPDFContent` does `axios.get(url)` with no guard (the web-scrape branch is guarded). Fix: `assertSafeFetchUrl` at the top.

**SEC-10 — Path traversal in `generate-thumbnail`.** `generate-thumbnail/route.ts:31-37` derives a local path from body `videoUrl` with no containment (its sibling `thumbnail/route.ts:315` has one). Fix: add the guard.

**SEC-11 — Admin role auto-granted by `@aoacademy.co` email domain.** `src/lib/clerk-auth.ts:28-29` upgrades any account with that email domain to ADMIN — the single trust root behind 21 admin routes. Risk hinges on Clerk enforcing verified email before this path. Fix: explicit user-id/email allowlist or manually-set role; confirm verification precedes the check.

**SEC-13 — Tier-3 access policy (2026-06-25 deferral) — CONFIRMED NOT BUILT (LOW).** No per-tier resource ACL layer exists; authorization today is ownership-scope + plan-gate only. This is **adequate for the current surface** — no concrete exploit — but the deferred policy layer was never added. Disposition: leave deferred; revisit only if a future feature needs per-tier resource restrictions beyond plan gating.

**SEC-12 — Admin settings GET returns live secrets; `/api/renders` unsigned.** ✅ deferred item confirmed-open. `admin/settings/route.ts:86-100` returns `stripe_secret_key`, `stripe_webhook_secret`, `server_gemini_key` in plaintext to the admin browser (XSS/borrowed-session exfil). `renders/[filename]` is public with no ownership/expiry — traversal blocked + 128-bit random names make enumeration impractical, but URLs are unbound capabilities (leak via referrer/logs = permanent access). Fix: mask admin secrets (set/last-4); signed expiring URLs or ownership check for renders.

**STAB-1 — Reboot resurrection was never actually provisioned.** `deploy/setup.sh` never runs `pm2 startup`; `deploy.sh:141-142` calls `pm2 startup` non-interactively (prints a command a human must run once — no-op in a script). No verification the systemd unit exists. A VPS reboot (kernel update, host maintenance) → PM2 never restarts → **nothing** comes back (web, workers, crons). Fix: idempotent `pm2 startup systemd -u root --hp /root` in setup + a post-deploy `systemctl is-enabled` self-check.

**STAB-2 — No meta-monitoring: the only alert path (disk-watch) is itself a cron.** The sole automated alert is `disk-watch` (`notifyAdmins` + Resend email at 80% disk). Every other cron/worker only `console.log`s. If crons die, the alarm dies with them. If the web app 500s at 3am, Mew finds out from a customer. Fix: an OS-level (`crontab`, not pm2) watchdog that checks pm2 process health + cron heartbeats + disk + a `/api/health` 5xx probe + queue depth, alerting via a dependency-free channel (LINE Notify / Slack webhook `curl`).

**STAB-3 — No SQLite backup mechanism exists.** No backup cron, no off-box copy; `prisma/dev.db` (all users, payments, founding state) is a single file on a single VPS. The `.bak` files present are ad-hoc manual snapshots, mostly weeks old. Corruption/disk-failure/bad-migration = total data loss. Fix: daily `VACUUM INTO`/`.backup` to a separate path, ~14-day retention, rsync off-box. Cheapest high-value fix in the audit.

**STAB-4 — Trial-expiry has no secondary enforcement.** Plan-gating reads only the DB `plan` field, never `trialEndsAt` at request time; downgrade happens exclusively in the trial-expiry cron. If that cron is stopped/401ing for N days, every expired trial keeps PRO — a silent, compounding revenue leak with no error signal. Fix: a defense-in-depth inline check (if `trialEndsAt` past and `plan!==FREE`, demote) or at minimum heartbeat-alert this specific cron.

**PERF-APP-1 — Queue "0% stuck" UX: the client is built for it, the server never sends it.** ✅ (root cause of the reported complaint). `video-editor/page.tsx:2189-2199,4313` already renders "รอคิว #{queuePosition}", but in prod (`RENDER_VIA_QUEUE=1`) `render-progress/route.ts:16-52` maps a `QUEUED` job to `stage:"running", progress:0` with no `queuePosition` — identical to a stuck 0% render. No query computes "jobs ahead of you." Same gap on `videos/jobs/[id]/route.ts` (v2 badge/editor). Fix: add a `QUEUED` branch + queue-position count in both routes; no client change needed.

**DB-1 — `TelemetryEvent` grows unbounded (123k rows, no sweeper); missing indexes.** Add a retention sweep (e.g. keep 30–90 days) to the cleanup cron; add `@@index([createdAt])` to `VideoJob`/`RenderJob` and `@@index([status])` to `Payment` (admin/insights does full scans).

### 🟢 LOW (hygiene — batch later)

- **MON-7** credit `balance` GET writes on read (lazy grant) → duplicate `monthly-reset` ledger rows under concurrent GETs (balance itself idempotent). Move grant to POST/cron.
- **MON-8** `grantCreditsOnce` dedups on a non-unique ledger `action` (practically unreachable given webhook event-dedup). Add `@@unique([userId,action])`.
- **MON-9** credit-pack purchases create no `Payment` row → credit-sale cash invisible to จ่ายจริง/MRR. Add a `Payment(status=PAID, note="credits")`.
- **MON-10** manual-payment dedup is 60 s + exact-amount only; `FoundingReservation` has no per-user unique → concurrent/different-amount submits can double-count. Add `@@unique` / transaction.
- **MON-11** `settings` `loadPayments` has no `.catch` (unhandled rejection). Add `.catch`.
- **MON-12** `foundingStatus()` writes (stale-release sweep) on every public status read; seat can leak on crash between `claimSeat` and `attachReservation`. Move sweep to cron only; claim+attach in one transaction.
- **PERF-APP-2** poll routes over-fetch: `videos/jobs/[id]` and `getRenderJob()` hydrate full row (config/captions/payload) every tick; `videos/route.ts` gallery ships full script/JSON blobs per card. Add `select`.
- **PERF-APP-3** `video-creator/page.tsx` runs two overlapping render pollers (600 ms + 3000 ms), neither pauses on tab-hidden (avatar renders 10–25 min). Consolidate to one visibility-aware poller.
- **PERF-APP-4** `video-editor`/`video-creator` are 5180/4153-line client components; zero `next/dynamic` in the codebase. Code-split step-2/3 panels. (Larger lift.)
- **SEC-LOW** cron secret compares with `!==` (not timing-safe); `render-cancel` unauthenticated-by-design (128-bit jobId bearer); `transcribe:871` bounded traversal; `telemetry` POST unauth no rate-limit (row-bloat DoS); legacy NextAuth `auth/*` + `src/lib/auth.ts` dead but deployed (delete); two unused Remotion-Player files (delete).
- **STAB-LOW** no `max_restarts`/`min_uptime` on `ai-content`/`render-worker` (crash-loop → PM2 gives up silently after 15); `prisma db push` mid-deploy failure is uptime-safe but silent; nginx no gzip on static.

---

## 2b. Capacity answer & launch-spike playbook

**How many concurrent renders the KVM8 sustains now:** **~2 renders cleanly** at the CPU-optimal setting (2 workers × `RENDER_CONCURRENCY=4` = 8 render threads = full 8-core utilization, no oversubscription). RAM supports far more (each render ≈ 3.5–5 GB; 2 ≈ 8–10 GB + 3 GB web ≪ 32 GB), so **CPU is the ceiling, not RAM.** A 3rd worker is viable only with `RENDER_CONCURRENCY→2` (3×2=6 threads + 2 cores for web/ffmpeg), trading per-render efficiency for queue drain — do it only if queue-wait keeps growing *with* CPU headroom (scale-plan Rung 2).

**The real launch ceiling is CAP-1, not the render-workers.** Because editor-v2 + MCP video creation serializes through one orchestrator, adding render-workers alone won't help those flows — the orchestrator must go to 2 concurrent first (P2.2), then the 2 render-workers are actually fed.

**Spike playbook (launch-day, in order of what to turn up / what breaks first):**
1. **First bottleneck = orchestrator serialization (CAP-1).** Lever: run 2 `mcp-video-worker` instances (P2.2). Symptom before fix: E2E queue-wait climbs (p95 already 12.9 min) while render-workers sit partly idle.
2. **Second = render CPU.** Lever: keep `RENDER_CONCURRENCY=4` at 2 workers (P2.3); if wait still grows *with* CPU headroom, add a 3rd worker at concurrency 2. Symptom: load sustained >12–14, render p95 climbing.
3. **Third = b-roll normalize serialization** (`STOCK_NORMALIZE_CONCURRENCY=1`) starving cores when many users generate at once. Lever: raise to 2 (P2.3).
4. **Disk** (renders output already 41 GB): disk-watch sweeps at 80% (currently 37%); cleanup crons cover growth. Low risk near-term.
5. **What does NOT break first:** RAM (huge headroom), SQLite (WAL + atomic claims + tiny writes), single-request API latency (all <50 ms). Do not spend launch-prep effort here.

## 3. Positives confirmed (do NOT "fix" these)

- **Ownership model is strong:** ~all resource routes are `userId`-scoped via `findFirst`/`updateMany`/`deleteMany` guards. All 21 admin routes role-gated. MCP tokens SHA-256-hashed. Raw SQL is parameterized + userId-scoped (not injectable).
- **Render queue coordination is race-safe:** SQLite atomic `updateMany` claim, WAL + 5 s busy_timeout, tiny writes → not a contention bottleneck at 2–3 workers. Worker watchdog is solid: stall-cancel (120 s), wallclock cap (45 min), dead-worker sweep + requeue, graceful SIGTERM drain without burning a retry.
- **Money reservation is atomic & bucket-aware** on the live queue path: minutes/credits/clips persisted on `RenderJob`, refunded on every terminal path (fail/supersede/dead-sweep/shutdown) with granted/purchased split preserved. Overflow credits charged once, disclosed on the receipt.
- **Stripe webhook is fail-closed on signature + replay-protected** (the MON-1 gap is durability-ordering, not auth). Coupons race-safe. Manual-payment void cannot go negative.
- **Crons all fire on schedule.** Editor-v2 escape hatches intact.
- **RAM headroom is large** on the new box — enabling higher render quality/cache is affordable.

---

## 4. Baseline test clips (async QA — for Mew's eyes)

5-clip set to (a) establish a quality baseline for before/after comparison and (b) clear the pending-QA backlog in one viewing. **3 rendered now via MCP** (process serially through the single orchestrator — itself a live demonstration of CAP-1); **2 to render in Mew's QA session via the web editor** (they need the editor UI, not MCP):
- ✅ Normal clip (Time Blocking, subtitle mode 2) — `cmrafftsz003xlcty6e5rfxkr` → **DONE**, `/api/renders/render-1783415751717-08cd641f24aa8e91a781768ac6e566cf.mp4`
- ✅ Pause-heavy clip (subtitle-timing stress) — `cmrafgo4a0044lctyqp3m5gir` → **DONE**, `/api/renders/render-1783416349407-e14fcf8c6ef009cd0623d924e12d6fee.mp4`
- ✅ Avatar bookend (avatar quality) — `cmrafgvtb0047lctythlkizhs` → **DONE**, `/api/renders/render-1783417236245-9e8424205adb176df4c7f14fe957dbab.mp4`
- ▫️ Cutaway upload (via editor) — Mew's QA session
- ▫️ Per-window b-roll edit (via editor) — Mew's QA session

These clips are rendered under the **current** (LOW_RESOURCE) config — they are the "before" baseline. RENDER-1's "after" clips get compared against them.

---

*Audit complete. No code changed, no prod writes, no restarts. Remediation is sequenced in `docs/plans/2026-07-07-system-optimization-master-plan.md`.*
