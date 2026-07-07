# System Optimization — Master Plan (phased)

> **สรุปไทย:** แผนแก้ทั้งระบบจาก audit (`docs/audits/2026-07-07-system-optimization-audit.md`) จัดเป็น 4 เฟสตามลำดับความสำคัญที่ตกลงกัน: **P0 เงิน+ความปลอดภัย** (ห้ามพลาด — มีช่องโหว่ร้ายแรง 1 + เงิน/คีย์อีกหลายจุด) → **P1 ความเสถียร** (backup DB, กู้ระบบหลัง reboot, ระบบเตือนภัย) → **P2 ความเร็ว/คิว** (แก้คอขวด orchestrator, จูนเครื่องใหม่, UX คิว 0%, ยกคุณภาพวิดีโอให้เต็มเครื่องใหม่) → **P3 เก็บกวาด** (perf เล็ก ๆ, hygiene). ทุกงานที่แตะการเรนเดอร์ = ต้องให้มิวดูคลิป before/after ก่อน flip เสมอ. แต่ละเฟส deploy แยกก้อนได้ ปลอดภัย. เฟสไหนพร้อมก็สั่ง `/mew-kickoff execute docs/plans/2026-07-07-system-optimization-master-plan.md` เลือกทำทีละเฟส.

**Source of findings:** `docs/audits/2026-07-07-system-optimization-audit.md` (finding IDs referenced below, not restated). **Context terms:** `CONTEXT.md`. **Prior decisions:** ADR 0001 (VideoJob background pipeline), scale-upgrade-plan.md Rung 1/2.

## Priority principle (locked in interview)
P0 money+security → P1 stability → P2 speed/queue → P3 hygiene. **Output quality is a gate over every phase, not a phase.** Any change touching the render path ships only after Mew eyeballs a before/after clip. Launch date (07-18) is context, not a scheduler — execute by correctness order.

---

## Phase P0 — Money & Security (do first; mostly small, high-value)

Goal: close every way a user can steal data/keys or move money incorrectly. Security-sensitive → `mew-worker-heavy` + `/security-review`.

| # | Task | Finding | Agent | Review gates |
|---|------|---------|-------|--------------|
| P0.1 | Add `path.resolve` containment guard to `heygen-direct`, `create-avatar`, `heygen/composite`+`preview-*`, `generate-thumbnail` local-file branches (reuse the guard from `audio-duration`/`thumbnail`) | SEC-1, SEC-8, SEC-10 | mew-worker-heavy | build, security-review, session final |
| P0.2 | Encrypt BYOK keys at rest (AES-256-GCM, key from env; migration re-encrypts existing; rotate) + stop returning raw keys from `GET /api/user/api-keys` (return set/last-4) | SEC-2, SEC-3 | mew-worker-heavy | build, test (round-trip enc/dec), security-review, session final |
| P0.3 | Restrict `videos/upload`: ext+MIME allowlist to video, `randomUUID` filename, `Content-Disposition: attachment`+`nosniff` on `public/renders` serving | SEC-4 | mew-worker | build, security-review |
| P0.4 | Make all 6 cron routes fail-closed (`if(!secret||notEqual) 401`, `timingSafeStrEqual`) | SEC-5 | mew-worker | build, security-review |
| P0.5 | Stripe webhook durability: record `stripeWebhookEvent` only after handler success, or wrap event-record + handler in one `$transaction` so a failure lets Stripe retry heal it | MON-1 | mew-worker-heavy | build, test (simulate handler throw → retry re-processes), security-review, session final |
| P0.6 | Fix MCP orchestrator over-refund (non-avatar videos net 0 quota): drop the base-refund and let the base `ChargedClip` be the single charge, OR refund only when burn source ≠ base | MON-2 | mew-worker-heavy | build, test (verify-script: non-avatar MCP video nets exactly 1), session final |
| P0.7 | Drop Gemini `?key=` query param everywhere (header already sent); scrub URLs/keys in `api-error.ts buildAdminBody` | SEC-6 | mew-worker | build, security-review |
| P0.8 | SSRF hardening: disable auto-redirect + re-assert `assertSafeFetchUrl` per hop in all URL-fetch sites; guard `extract` PDF branch | SEC-7, SEC-9 | mew-worker | build, security-review |
| P0.9 | `spendCredits` retry-on-split-race; wrap credit balance+ledger writes in `$transaction`; TTS refund render-minutes on `saveWav` failure | MON-3, MON-4, MON-6 | mew-worker-heavy | build, test (credit verify suite), session final |
| P0.10 | Trial re-entry: soft-delete/anonymize on `user.deleted` keeping `trialStartedAt` (or used-email table) | MON-5 | mew-worker | build, test |
| P0.11 | Admin trust root: replace `@aoacademy.co` domain-grant with explicit allowlist / confirm email-verified precedes it | SEC-11 | mew-worker-heavy | build, security-review, session final |
| P0.12 | Mask admin secrets in `admin/settings` GET; add signed/expiring or ownership-checked `/api/renders` | SEC-12 | mew-worker | build, security-review |

**P0 deploy note:** P0.1–P0.7 are the "must-ship" core (CRITICAL + all HIGH). None touch the render *visual* path, so no clip-QA gate — but P0.2 (key encryption migration) needs a careful DB migration + `prisma db push` and a rollback plan; treat as its own deploy. Batch the rest into 1–2 deploys.

### ✅ P0 EXECUTED — branch `mew/p0-security-billing` (2026-07-07)
All 12 tasks implemented + 1 follow-up (webhook retry idempotency, surfaced by review). `tsc --noEmit` clean, `npm run build` exit 0, verify suites green (key-crypto 18/18, trial 17/17, MCP 23/23, preview 53/53, credits 39/39+34/34+52/52, +9/9 webhook idempotency proof). Tier-1 review PASS, `/security-review` clean (no findings ≥ bar). **Not committed/merged/deployed — that's Mew's step.**

**🛑 DEPLOY CHECKLIST (do in this order — SEC-2 is silent if skipped):**
1. **Set `KEY_ENC_SECRET`** in prod `.env` (`openssl rand -base64 48`) BEFORE deploy. Load-bearing forever once keys are encrypted — back it up like the DB; never rotate without re-encrypting. If unset, key storage silently stays base64 (degrades gracefully, but SEC-2 has no effect).
2. (Optional) Set `ADMIN_EMAILS=duckyhero@gmail.com` (comma-sep) — self-documenting admin allowlist beyond the verified `@aoacademy.co` domain. Owner stays admin via DB role regardless.
3. Deploy (`bash deploy/deploy.sh`) — `prisma db push` adds the additive `UsedTrialEmail` table (safe, no data loss).
4. **After deploy:** `npx tsx scripts/encrypt-existing-keys.ts` (dry-run) → then `--apply` to re-encrypt existing base64 keys to `v2:` AES.
5. Rollback: revert the branch + rebuild; `v2:` values become unreadable only if `KEY_ENC_SECRET` is lost (users re-enter keys) — so guard that secret.

**Behavior changes to know:** Settings "Test key" button now needs the key retyped (saved keys aren't sent to the browser anymore — intended, per SEC-3). `/api/renders` ownership/signing was deliberately NOT added (heterogeneous filenames, already enumeration-resistant) — documented deferral, revisit if needed.

**Residual (deferred, non-blocking):** MON-2's avatar refund still uses the clip bucket under minutes mode; per-file `safeFetchFollow` helpers could hoist into `safe-fetch.ts`; `videos/upload` route appears to have no caller (P3 delete candidate).

## Acceptance Criteria — P0
- [ ] SEC-1 unexploitable: a request with `mergedAudioUrl="/../prisma/dev.db"` is rejected, verified by test.
- [ ] BYOK keys are ciphertext in the DB (not base64); `GET /api/user/api-keys` never returns raw key material; existing keys migrated without breakage.
- [ ] Uploading `x.html` is rejected or served non-executable; no attacker JS can run on the app origin.
- [ ] Crons return 401 when `CRON_SECRET` is unset (fail-closed), verified by test.
- [ ] A Stripe webhook whose handler throws once is re-processed on retry and applies the plan/credits (test-proven).
- [ ] A non-avatar MCP/chat video charges exactly 1 clip/its minutes (verify-script).
- [ ] `/security-review` on the P0 diff surfaces no new HIGH+; every fix keeps existing behavior for legitimate requests.

---

## Phase P1 — Stability & Ops (make silent failure impossible)

Goal: the system announces its own problems and survives a reboot; data is recoverable.

| # | Task | Finding | Agent | Review gates |
|---|------|---------|-------|--------------|
| P1.1 | Daily SQLite backup: `VACUUM INTO` to a separate path, 14-day retention, rsync/upload off-box; add as a PM2 cron in `ecosystem.config.js` + document restore | STAB-3 | mew-worker | build, session (verify restore works on a copy) |
| P1.2 | Provision reboot resurrection properly: idempotent `pm2 startup systemd` in `deploy/setup.sh` + post-deploy `systemctl is-enabled pm2-root` self-check that fails loudly | STAB-1 | mew-worker-heavy | session (dry-run the check; do NOT reboot prod) |
| P1.3 | OS-level watchdog (`scripts/ops-watchdog.sh`, plain bash, root `crontab` — independent of PM2): checks pm2 process health, cron heartbeats (each cron touches a heartbeat file), disk, `/api/health` 5xx, queue depth; alerts via LINE Notify/Slack webhook `curl` with per-check rate-limit | STAB-2 | mew-worker-heavy | build, session |
| P1.4 | Trial-expiry defense-in-depth: inline demote if `trialEndsAt` past and `plan!==FREE` (backstop the cron) | STAB-4 | mew-worker | build, test |
| P1.5 | `TelemetryEvent` retention sweep (30–90 d) in cleanup cron; add missing indexes (`VideoJob`/`RenderJob` `createdAt`, `Payment` `status`) | DB-1 | mew-worker | build |
| P1.6 | PM2 crash-loop guard: explicit `max_restarts`/`min_uptime` on `ai-content`/`render-worker`; add `/api/health` endpoint if missing | STAB-LOW | mew-worker | build |

## Acceptance Criteria — P1
- [ ] A daily DB backup exists off-box; a restore was tested on a copy.
- [ ] The watchdog fires a real alert to Mew's phone when a cron heartbeat goes stale / disk crosses threshold / health probe 5xxs (proven by deliberately tripping one check).
- [ ] Reboot-resurrection is verified present (systemd unit enabled) — without rebooting prod.
- [ ] An expired trial user is demoted even if the cron is stopped (test).
- [ ] `TelemetryEvent` stops growing unbounded; admin/insights queries hit indexes.

---

## Phase P2 — Speed, Queue & Render Quality (what users feel)

Goal: shorter waits, clearer waiting, full use of the 8-core box, **higher** output quality. Every render-path task carries a Mew before/after clip gate.

| # | Task | Finding | Agent | Review gates |
|---|------|---------|-------|--------------|
| P2.1 | **Queue-status UX** (highest user-facing payoff): add a `QUEUED` branch + queue-position count to `render-progress` and `videos/jobs/[id]`; feed the already-built client "รอคิว #N" UI | PERF-APP-1 | mew-worker | build, session, **Mew eyeball on prod (queued clip shows position)** |
| P2.2 | **Orchestrator concurrency** (launch bottleneck): run 2 `mcp-video-worker` instances (claim is race-safe) or process 2 VideoJobs concurrently; size to the 2-render-worker CPU budget; verify no double-claim, no quota double-charge | CAP-1 | mew-worker-heavy | build, test (concurrent claim safety), session, load-check on prod, **Mew before/after clip (2 videos at once = same visual quality as 1)** |
| P2.3 | **Render concurrency tuning**: set explicit coordinated `RENDER_CONCURRENCY=4` (2×4=8 cores, no oversubscription); raise `RENDER_OFFTHREAD_CACHE_MB`→512; `STOCK_NORMALIZE_CONCURRENCY`→2 | RENDER-2 | mew-worker | build, session, **Mew before/after clip (quality unchanged, faster)** |
| P2.4 | **Render quality uplift** (aligns with Mew's core goal): reconcile prod `.env` for the new box — remove `RENDER_LOW_RESOURCE=1`, reconcile `RENDER_CONCURRENCY`/`JPEG`/`CACHE`/`KEN_BURNS` between `.env` and `ecosystem` so intent is explicit and un-shadowed; **preset `faster`→`medium` trades speed for quality** | RENDER-1 | mew-worker-heavy | build, session, **🛑 Mew before/after clip approval REQUIRED before flip** |
| P2.5 | Poll-route over-fetch: add `select` to `videos/jobs/[id]`, `getRenderJob()`, `videos/route.ts` gallery | PERF-APP-2 | mew-worker | build |
| P2.6 | Consolidate `video-creator` dual pollers into one visibility-aware poller | PERF-APP-3 | mew-worker | build, session |

**P2 sequencing:** P2.4 (quality) and P2.3 (concurrency) interact — do P2.3 first (pure speed, no quality change), render the before/after set, then P2.4 (quality, slower per-frame) and re-measure that queue-wait didn't regress past target. P2.2 (orchestrator) is the biggest launch-capacity win and is independent of the render tuning.

## Acceptance Criteria — P2

**Baseline-corrected targets** (measured baseline → target after P2; re-measure and document actuals):
| Metric | Measured baseline (2026-07-07) | Target after P2 |
|---|---|---|
| E2E queue-wait p95 (submit→start, video create) | 773 s (12.9 min) | **< 300 s (5 min)** — via orchestrator concurrency P2.2 |
| RenderJob queue-wait p95 | 272 s (4.5 min) | ≤ 240 s (hold/improve) |
| Render duration p50 / p95 | 207 s / 525 s | p50 ≤ 210 s, **p95 ≤ 480 s** (do not regress despite quality uplift) |
| Concurrent renders sustained | ~1–2 (2× oversubscribed at 2) | **2 clean** (load ≤ ~10, no OOM) |
| Output quality | LOW_RESOURCE preset "faster", JPEG effective 90 | **equal-or-better** (preset "medium"), Mew-approved |

- [ ] A queued render shows "รอคิว #N" (not a frozen 0%) on prod — the reported complaint is gone (Mew-confirmed).
- [ ] Two editor-v2/MCP videos are created concurrently (not serialized), no double-claim, correct quota — measured on prod.
- [ ] Render throughput uses the 8 cores without sustained load ≫8 per render pair; RAM stays comfortable.
- [ ] **Mew has approved before/after clips** (incl. P2.2's 2-at-once and P2.4's quality uplift) confirming quality is equal-or-better; queue-wait/duration p95 meet the table above.

---

## Phase P3 — Hygiene & Cleanup (batch, low risk)

Goal: pay down the LOW findings + dead code. One or two mechanical/worker passes.

| # | Task | Finding | Agent |
|---|------|---------|-------|
| P3.1 | Credit hygiene: `balance` GET no write-on-read; `@@unique([userId,action])` on ledger; `Payment` row for credit-pack sales; `settings loadPayments` `.catch`; founding `@@unique`/sweep-to-cron | MON-7..12 | mew-worker |
| P3.2 | Code-split `video-editor`/`video-creator` step-2/3 panels via `next/dynamic`; delete 2 unused Remotion-Player files | PERF-APP-4 | mew-worker |
| P3.3 | Delete dead NextAuth `auth/*` + `src/lib/auth.ts`; timing-safe cron compare; telemetry POST rate-limit; nginx gzip; `prisma db push` deploy failure banner | SEC-LOW, STAB-LOW | mew-worker |
| P3.4 | CLAUDE.md correction: `next.config.js` shadow gotcha is historical (removed `5fb76cb`); cron `stopped`=by-design note | — | mew-worker-mech |

## Acceptance Criteria — P3
- [ ] All LOW findings dispositioned (fixed or explicitly deferred with reason).
- [ ] Dead code removed; no behavior change (build + smoke).
- [ ] CLAUDE.md reflects current reality.

---

### ✅ P1+P3 EXECUTED — branch `mew/p1-p3-stability-hygiene` @ e3321e3 (stacked on P0)
tsc clean · build exit 0 · verify suites green (credits 39/34/52/27, founding 19/19, trial-cap 12/12, plan-change 11/11) · Tier-1 PASS · security-review clean. **Env to set on prod:** `ALERT_WEBHOOK_URL` (watchdog alerts — Slack/Discord webhook), `BACKUP_RSYNC_TARGET` (optional off-box backup). **Install watchdog:** root `crontab -e` line is in `scripts/ops-watchdog.sh` header (every 15 min, NOT pm2). **Start db-backup cron:** `pm2 start ecosystem.config.js --only db-backup --update-env && pm2 save`. Non-blocking notes: credit-pack purchases show as "{plan} · 0 วัน" in /payments/history until that route special-cases `note==="credits"`; `videos/upload` route has no caller (confirm before deleting).

## Cross-cutting rules
- Each phase is an independent, deployable batch — never mix P0 security fixes with P2 render tuning in one deploy.
- Build-verify every render-backend change before merge (hygiene per CLAUDE.md); Mew rebases + merges + deploys.
- No render-path change flips on prod without a Mew before/after clip.
- Re-run the relevant `verify-*` script for any money/credit change.

## Status
interviewed 2026-07-07 | approved: P0+P1+P3 2026-07-07 | executed: P0 DONE (branch `mew/p0-security-billing` @ 4c56f31) · P1+P3 DONE (branch `mew/p1-p3-stability-hygiene` @ e3321e3, stacked on P0) — both reviewed+build-green, awaiting Mew merge/deploy | P2: pending (needs clip-QA gates)
