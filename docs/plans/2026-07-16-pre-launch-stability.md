# Pre-Launch Stability Audit & Fixes (launch event Sat 2026-07-18)

> **สรุปไทย:** เก็บข้อมูลการใช้งานจริง 7 วันจาก prod แล้ว (raw: scratchpad `prod-audit-raw-2026-07-16.md`, จะ formalize เป็น `docs/audits/2026-07-16-pre-launch-audit.md`). ระบบโดยรวมแข็งแรง — คิวไม่ตัน (p95 4 วิ), RenderJob สำเร็จ 98.4%, disk/RAM เหลือเฟือ. งานที่เหลือคือ: ปิดความเสี่ยง 503 ตอน restart (ความเสี่ยงอันดับ 1 ของวันงาน), ไล่ disposition error ทุก pattern ที่เจอ, formalize ค่า concurrency ที่ drift, ประเมินโหลดวันเสาร์เป็นตัวเลข, และ runbook วันงาน. **Deploy ก้อนสุดท้าย ≤ ศุกร์ 07-17 เที่ยง แล้ว freeze.** ไม่ทำ feature ใหม่, ไม่แตะ render quality (P2.3/P2.4 คงเลื่อนตามเดิม).

**Source data:** scratchpad `prod-audit-raw-2026-07-16.md` (11 sections, referenced below as §N — not restated).
**Context:** `CONTEXT.md`; master plan `docs/plans/2026-07-07-system-optimization-master-plan.md` (P0/P1/P3 merged; P2 code merged @ `e79a2d1`, gated); ADR 0001.
**Constraints (locked in interview 07-16):** read-only prod access for agents; Mew deploys; no new features; no render-quality changes; last deploy Fri 07-17 noon then freeze (critical hotfix only).

## Findings snapshot (7d, 07-09→07-16)

- VideoJob 202 done / 59 failed (76.5%) — ~34% of failures are user BYOK key issues. RenderJob 251/4 (98.4%). Queue-wait p95 ≈ 4 s. System healthy (§1–3).
- 🔴 **Nginx 503 spikes** 07-13 (229×) + 07-16 (233×) during single-instance restarts; hit polling endpoints AND render-worker's own media fetches → 2 render failures + 1 support ticket (§5, §10).
- 🟠 `ไม่มี subtitle timing จาก TTS` ×11 — largest single platform-side failure bucket (§3).
- 🟠 Payments: 15 FAILED vs 1 PAID vs 67 new trials (§9) — cause unknown (no failure-reason column).
- 🟠 Puppeteer `Target closed` ×19 in render-worker; avatar timeout ×6; stale HeyGen look ×3 (§3, §5).
- 🟡 Stale-bundle-after-deploy: `Failed to find Server Action` ×18 + stale CSS 404s (§5, §10).
- 🟡 Drift: `MCP_WORKER_CONCURRENCY=2` live via pm2 dump only; git file says gate=1 (§11). Intentional (Mew set it post-KVM8) but unrecorded; a file-based restart would silently revert to 1.
- 🟡 Ops gaps: backups local-only (no `BACKUP_RSYNC_TARGET`), `ADMIN_EMAILS` unset, `ALERT_WEBHOOK_URL` lives inline in crontab, `media-cleanup` heartbeat stale 5 d (§6–7).

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | **503-on-restart mitigation**: root-cause confirmed (§10) — design + implement lowest-risk zero/near-zero-downtime restart for `ai-content` (evaluate: pm2 cluster-mode reload vs wait_ready vs nginx retry/grace; pick ONE, justify; must not change app behavior). If no low-risk option fits pre-launch, deliver "restart hygiene" procedure for runbook instead + defer code change | mew-worker-heavy | subagent | — | build+test, Tier-1 review, session final |
| 2 | **Subtitle-timing failures ×11**: root-cause `ไม่มี subtitle timing จาก TTS` — which TTS path/provider, which job configs; read subtitle-timing memory + `src/lib/tts-timing.ts` docs FIRST (minefield: never re-mainline transcribe). Fix if platform bug; disposition otherwise | mew-worker-heavy | subagent | — | build+test, Tier-1 review, session final |
| 3 | **Payment failures 15/16**: investigate Payment rows detail (read-only DB via SSH allowed), webhook logs, checkout flow; classify: abandoned PromptPay/expired intents (benign) vs real bug. Disposition with evidence | mew-worker | subagent | — | Tier-1 review (analysis), session final; security-review only if code changes |
| 4 | **Render-worker errors**: Puppeteer `Target closed` ×19 (how many caused user-visible failure vs recovered?), ffmpeg /tmp cleanup race (03:00 cron vs long renders), `EncodingError` — root-cause + fix or disposition each | mew-worker | subagent | — | build+test, Tier-1 review |
| 5 | **Avatar failures**: timeout ×6 + stale HeyGen look ×3; check unmerged branch `mew/heygen-late-completion-recovery` — does it address this, is it safe to ship pre-launch? Recommend ship/defer | mew-worker | subagent | — | build+test, Tier-1 review, session final |
| 6 | **Formalize concurrency**: `ecosystem.config.js` mcp-video-worker default → "2", rewrite stale gate comment to record the KVM8 decision + verified-in-prod status; confirm render-worker's effective `RENDER_CONCURRENCY` source (.env=3) and document one authoritative place | mew-worker | subagent | — | build, Tier-1 review |
| 7 | **BYOK error fast-fail/UX**: ElevenLabs 401-scope + Pexels 401 = 20 failures/wk. Verify the user-facing message is actionable Thai; add cheap preflight key check at job submit ONLY if it's a small guard (no new UI). Disposition otherwise | mew-worker | subagent | — | build+test, Tier-1 review |
| 8 | **Stale-bundle mitigation**: `Failed to find Server Action` ×18 + stale CSS 404 — evaluate Next 15 `deploymentId`/skew-protection or client reload-on-stale handling; smallest safe fix or disposition to runbook note | mew-worker | subagent | — | build+test, Tier-1 review |
| 9 | **Load assessment** (numbers for Saturday): capacity model from §3 durations × live concurrency (2 orchestrator slots, 2 render workers); scenarios (10/30/60 renders in 1 h), first bottleneck, verdict on keeping concurrency=2, expected queue depth + wait | (session) | inline | — | criteria check |
| 10 | **Audit report** `docs/audits/2026-07-16-pre-launch-audit.md`: formalize raw data + task 1–8 dispositions; every error pattern gets cause + disposition | (session) | inline | 1–8 | criteria check |
| 11 | **Runbook** `docs/runbooks/2026-07-18-launch-event.md` (Thai, 1 page, phone-readable): pre-event checklist, monitoring commands, incident playbooks (503 storm / queue stuck / render failing / rollback), ops-gap one-liners for Mew (ADMIN_EMAILS, ALERT_WEBHOOK_URL→.env, off-box backup decision, media-cleanup heartbeat) | (session) | inline | 1, 9 | criteria check |
| 12 | **Deploy + verify**: Mew merges/deploys ≤ Fri noon; then post-deploy log check proves fixed patterns stopped (read-only SSH) | (session + Mew) | inline | 1–8 | prod log evidence |

Notes: tasks 1–8 are independent → dispatch in parallel. Prod = read-only for all agents; any prod config step goes into the runbook for Mew. New fixes discovered by investigations that exceed "small guard" size get listed to Mew before implementation (scope gate), not silently built.

## Acceptance Criteria

- [ ] Audit report answers: who used what, success/failure rates, every error pattern grouped with cause — no "unknown" left unexplained.
- [ ] Every bug dispositioned: fixed (PR + test + review) / deferred with reason / not-a-bug — no ambiguous leftovers.
- [ ] Deployed fixes verified on prod logs post-deploy (pattern stopped), not just build-green.
- [ ] Saturday load readiness quantified (concurrent renders, queue length under X users/hr, first bottleneck) incl. 503-restart risk plan + concurrency verdict.
- [ ] Runbook short enough to follow from a phone.
- [ ] Last deploy ≤ Fri 07-17 noon; freeze after (critical hotfix only).

## Out of scope

- New features (incl. the "ปิด B-roll" support request 07-16 — feature request, post-launch).
- Render-quality tuning P2.3/P2.4 (needs joint clip-QA session — unchanged from master plan).
- Raising concurrency beyond current live values before the event.
- Stripe conversion-rate optimization (only the *reliability* question is in scope via task 3).

## Status
interviewed 2026-07-16/17 | approved: 2026-07-17 (execute) | executed: 2026-07-17 ALL 12 tasks done — deployed prod b8c2451 + smoke verified, FREEZE in effect | delivered: PR #192 (merged) + audit report + runbook + 4h monitor cron
