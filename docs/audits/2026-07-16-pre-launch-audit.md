# Pre-Launch Production Audit — 2026-07-16 (launch event Sat 2026-07-18)

> **สรุปไทย:** ตรวจการใช้งานจริง 7 วัน (07-09 → 07-16) ก่อนงานเปิดตัว. ระบบโดยรวม**แข็งแรง**: RenderJob สำเร็จ 98.4%, คิวไม่ตัน (p95 ≈ 4 วิ), เครื่องเหลือเฟือ (disk 41%, RAM ว่าง 26G). VideoJob สำเร็จ 76.5% แต่ ~1 ใน 3 ของที่ล้มเหลวคือ key ของผู้ใช้เอง. ทุก error pattern ถูกไล่จนได้สาเหตุ + disposition ครบ — bug ระบบจริงที่เจอและ**แก้แล้ว**: (1) งาน headless ล้มถาวรเมื่อ Gemini TTS ไม่คืน timing, (2) render ล้มเพราะ 503 ตอน app restart, (3) กัน BYOK key เสียก่อนเริ่มงาน, (4) แจ้งผู้ใช้เมื่อ bundle เก่าค้างหลัง deploy, (5) webhook เงินหายเงียบ → มี log+alert แล้ว. ที่เหลือเป็นการตั้งค่า/runbook. ความจุวันงาน: ~20 วิดีโอ/ชม. (มี lever ดันเป็น ~30).

Plan: `docs/plans/2026-07-16-pre-launch-stability.md` · Raw data: session scratchpad `prod-audit-raw-2026-07-16.md` (11 sections) · Task reports: scratchpad `sdd/stab-task-*.md`

## 1. Usage (7 days, 2026-07-09 → 07-16)

- **39 active users** created video jobs; top user 24 jobs/week (healthy power-user spread, no abuse pattern).
- **67 new signups**, all started the 7-day PRO trial (auto-grant working).
- VideoJob: **202 done / 59 failed / 3 canceled** (76.5% success of terminal jobs). RenderJob (render/burn queue): **251 done / 4 failed = 98.4%**.
- Queue health: VideoJob queue-wait p50 2.2s / p95 3.96s; RenderJob p50 1.0s / p95 2.9s. Retries barely used (3/255). **No queue bottleneck at current load.**
- Durations: VideoJob p50 244s / p95 1041s (matches documented ETAs); RenderJob p50 174s / p95 454s.
- System: disk 41% used (229G free), RAM 26G free, swap idle, no crash-loops (`unstable_restarts=0`), all crons on schedule (heartbeats verified).
- Payments: 15 FAILED / 1 PAID Payment rows (see §2.6 — the FAILEDs are abandoned checkouts, not bugs).

## 2. Error patterns → cause → disposition (nothing left unexplained)

| # | Pattern (7d count) | Root cause | Disposition |
|---|---|---|---|
| 2.1 | **Nginx 503 bursts** (07-13: 229×, 07-16: 233×) hitting polling endpoints AND render-worker's own media fetches → 2 render failures + 1 support ticket | Single PM2 fork instance of `ai-content`; every deploy `pm2 restart` leaves a no-upstream window; render-worker fetches `/api/music|stocks/*` through the public nginx hop | **FIXED (opt-in)** — `RENDER_INTERNAL_BASE_URL` loopback for render media (branch `mew/stab-1-render-loopback-media`), default-off, byte-identical when unset; + runbook drain-before-restart procedure. Deferred post-launch: pm2 cluster zero-downtime reload. ⚠️ Loopback is same-host-only (URL persisted in RenderJob payload) — enable only while render-worker is co-located |
| 2.2 | **`ไม่มี subtitle timing จาก TTS` ×11** — largest platform-side bucket; 2 of 4 affected users never recovered | Real bug: headless jobs (editor-v2 BG + MCP) had NO fallback when Gemini's segmented TTS fail-opens to a single uninstrumented call (timing omitted → orchestrator hard-throws); web foreground editor had a fallback, headless didn't | **FIXED** — `buildDegradedTtsTiming()` reconstructs a single-segment clock from exact audio duration + exact spoken text (branch `mew/stab-task2-mcp-tts-timing-fallback`); iron rule preserved (no transcribe, timing arithmetic untouched, success path byte-identical); degraded use emits a durable telemetry marker. Trade-off: degraded subs on pause-heavy long scripts drift more than real timing — a completed video instead of a hard failure; re-render restores precision |
| 2.3 | **User BYOK key failures ×20** (ElevenLabs 401 missing `text_to_speech` ×10 = 1 repeat user; Pexels 401 ×10 = 5 users) | User-side keys, but platform let jobs start and fail mid-pipeline (wasted time, looks like instability). Confirmed NOT a money bug (quota reserved after these steps) | **FIXED** — fail-open preflight at job submit, web + MCP (branch `mew/stab-task7-byok-preflight`): blocks only on definitive 401/403 (≤3s, never on network flakiness), Thai error pointing to Settings. Deferred: orchestrator's raw-JSON error-message truncation (larger-scope UX) |
| 2.4 | **Stale bundle after deploy** — `Failed to find Server Action` ×18 + old CSS chunk 404s | Open tabs from before a deploy hit new server / wiped assets; self-hosted Next 15 has no skew protection (verified in source: `deploymentId` needs multi-version routing we don't have) | **FIXED** — client stale-bundle detector (branch `mew/stab-8-stale-bundle`): one-time Thai toast "มีเวอร์ชันใหม่ — รีเฟรช" on the exact failure signatures only (tightened against network-flakiness false positives, 17/17 checks) |
| 2.5 | **Render-worker noise**: Puppeteer `Target closed` ×19, ffmpeg tmp error ×1, EncodingError ×1 | ALL trace to one incident (07-11 03:03): root crontab `rm -rf /tmp/remotion-*` (no age check) deleted the live compositor's scratch dir mid-render; job self-healed via requeue. 18/19 Target-closed = benign CDP teardown noise (zero adjacent job failures) | **NOT-A-BUG in code** — server fix = age-aware crontab line (in runbook §pre-event, mirrors already-tested `disk-watch` 12h sweep). App-side cleanup already age-aware |
| 2.6 | **Payments 15 FAILED vs 1 PAID** | All 15 = abandoned/expired checkouts (no `stripePaymentIntent` ever attached; `async_payment_failed` fired 0 times ever). No "paid but recorded FAILED" case | **NOT-A-BUG** (funnel signal, not reliability). Side-find: webhook silently no-ops `checkout.session.completed` w/o metadata — one real orphaned event 07-13 20:08 TH. **FIXED** (log + admin notify, branch `mew/stab-3b-webhook-noop-log`); orphaned 07-13 event checked by Mew 07-17: **her own test transaction, not a real customer** — case closed |
| 2.7 | **Avatar failures**: timeout ×6, stale HeyGen look ×3 | Timeouts: HeyGen completed late, video ID discarded — already fixed by PR #187/#188 (merged+deployed 07-13, all 6 failures pre-fix, zero since; refunds correct). Stale look: genuinely invalid per-user `look_id`, error message tells user to "retry" which can't help | Timeouts: **ALREADY FIXED**. Stale look: **DEFERRED post-launch** (small error-surfacing improvement; 1 affected user appears churned) |
| 2.8 | Expected/by-design: `tts-gemini 429` quota cap ×4, plan-duration 403 ×3, user cancels ×3, Gemini 503 upstream ×3, no-stock-found ×5, kie key unset ×2 | Plan limits + provider transients behaving as designed | **NOT-A-BUG** |
| 2.9 | `frontend_error` ×76 / `pipeline_step_error` ×66 telemetry events | Consistent with the buckets above (BYOK, 503 windows, provider transients); error category = ~1% of telemetry | Covered by fixes above; watch post-deploy |

## 3. Drift & ops findings

- **Concurrency drift (resolved):** prod ran `MCP_WORKER_CONCURRENCY=2` via pm2-dump only (intentional post-KVM8, unrecorded); git said gate=1. **FIXED** — `ecosystem.config.js` now records 2 + truthful comments; render-worker `RENDER_CONCURRENCY=3` made explicit (branch `mew/stab-6-concurrency-formalize`). Requires one-time `pm2 restart ... --update-env && pm2 save` at deploy (runbook).
- **Deploy gate default-OFF:** `REQUIRE_EMPTY_RENDER_QUEUES` unset → the empty-queue deploy gate everyone assumes is protecting renders is not active. Runbook sets it for launch-window deploys.
- **Backups local-only:** db-backup cron healthy (daily, integrity ok) but `BACKUP_RSYNC_TARGET` unset → disk incident loses backups too. **DECISION MEW** (off-box destination) — post-launch acceptable.
- **`ADMIN_EMAILS` unset** (P0 checklist leftover) + **`ALERT_WEBHOOK_URL` lives inline in root crontab** instead of `.env`. One-liners in runbook.
- **`media-cleanup` heartbeat stale 5 days** — confirm expected (not in ecosystem cron list; likely manual/legacy).
- **BYOK encryption migration: 100% complete** (all 531 stored keys across 6 columns are `v2:` — zero legacy). ✅
- **Pre-existing tsc error** `src/app/api/payments/checkout/route.ts:129` (Stripe MetadataParam) exists on main — does not block builds (`ignoreBuildErrors`), fix post-launch.

## 4. Saturday capacity (task 9 summary)

- Sustained throughput ≈ **20 videos/hour** (2 orchestrator slots × mean ~350s job; render stage has headroom at ~41/h). First bottleneck = orchestrator slots.
- 10 jobs/h arriving: no queueing. 20/h: at capacity, short queues. 30/h: tail waits 30–60+ min (burst of 30 in 15 min → last starts ~85 min). Queue-position UX ("รอคิว #N") already live.
- **Emergency lever** (mid-event, only if queue >10 AND 1-min load <5): `MCP_WORKER_CONCURRENCY=3` → ~30/h (+50%). Command + rollback in runbook. Do NOT pre-flip.
- Non-bottlenecks: signup/web/marketing traffic trivial vs render CPU.
- Biggest event-day risk remains **restart during the event** → freeze policy + runbook.

## 5. Deliverables & status

| Branch | Content | Review |
|---|---|---|
| `mew/stab-1-render-loopback-media` | 503→render fix (opt-in loopback) | PASS |
| `mew/stab-task2-mcp-tts-timing-fallback` | headless timing fallback | PASS (opus) + marker fix round |
| `mew/stab-3b-webhook-noop-log` | webhook silent no-op observability | PASS |
| `mew/stab-6-concurrency-formalize` | concurrency truth in git | PASS |
| `mew/stab-task7-byok-preflight` | BYOK preflight | PASS after 3 rounds (final behavior blocks the observed scoped-key class; probe costs only on broken-ish keys) |
| `mew/stab-8-stale-bundle` | stale-bundle toast | PASS after 1 fix round |
| (no code) tasks 3, 4, 5 | analysis dispositions | accepted |

**Integration verified & delivered as PR #192** (branch `mew/stab-integration`, 15 commits): clean merges, tsc = only the known pre-existing error, full production build exit 0, all new verify suites green (34/34, 27/27, 17/17, 20/20).

Runbook: `docs/runbooks/2026-07-18-launch-event.md`. Deploy deadline: Fri 07-17 noon, then freeze.

## 6. Deferred (post-launch backlog, explicit)

1. pm2 cluster-mode zero-downtime reload for `ai-content` (kills the 503 window class entirely).
2. `resolveStockUrl` pathname-only internal-URL predicate (pre-existing; tighten to origin check).
3. Stale HeyGen look error surfacing (2.7).
4. Orchestrator raw-JSON error truncation UX (2.3).
5. Off-box backup destination decision + `BACKUP_RSYNC_TARGET`.
6. `payments/checkout/route.ts:129` tsc error.
7. Credit-pack rows show "{plan} · 0 วัน" in /payments/history (pre-existing note from P1+P3).
