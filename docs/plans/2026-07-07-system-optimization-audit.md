# System Optimization Audit → Master Plan

> **สรุปไทย:** Audit ทั้งระบบรวดเดียวแบบ multi-agent (เงิน/security/render/app-speed/stability) + เก็บตัวเลขจริงจาก prod (read-only) + เรนเดอร์คลิปทดสอบ 5 แบบด้วยบัญชี duckyhero → ออกเป็น 2 ไฟล์: Audit Report (หลักฐาน+ตัวเลข baseline) และ Master Plan (แผนแก้เป็นเฟส P0→P3, คุณภาพงานเป็นเพดานกั้นทุกเฟส) ระหว่าง audit **ไม่แก้อะไรทั้งสิ้น** — การแก้ทั้งหมดรอมิว approve Master Plan ก่อน. วันเปิดตัว 18 ก.ค. เป็น context ประกอบเท่านั้น ไม่ใช่ตัวขับแผน.

## Goal

Produce a full-system audit of HERO AI Creator Studio (prod on the new KVM8: 8 vCPU / 32 GB) and synthesize it into a single prioritized **Master Plan** that later sessions execute phase-by-phase via `/mew-kickoff execute`.

**This engagement changes no code and no prod state.** Evidence collection only.

## Context (references — do not restate)

- Project facts: `CLAUDE.md` (stack, gotchas, deploy), `CONTEXT.md` (Render Minute, Credit, Render Receipt, Mix Preset, Background Render), ADR 0001 (VideoJob background pipeline), ADR 0002 (managed AI gen credits).
- Prior audit to build on, NOT redo: `docs/audits/2026-06-25-video-editor-audit.md` — its **deferred** items are audit inputs: Gemini key in `?key=` URLs, BYOK keys stored unencrypted, unsigned `/api/renders`, Tier-3 policy.
- Known open edges (from 2026-06-26 overnight report §3): `grantCreditsOnce` check-then-act dedup, `spendCredits` concurrency false-reject (fail-closed), balance GET write-on-read, settings `loadPayments` no `.catch`.
- Ops signals: crons observed **stopped** on prod (2026-07-07 memory); render worker ×2, 3rd instance + per-worker concurrency 2–3 previously HOLD on the smaller box — must be re-evaluated for KVM8.
- Real user pain (from Mew, 2026-07-07): users stuck at **0% "waiting in queue"** think the system is frozen (queue message too small) → support tickets. B-roll quality already addressed in recent commits (PRs #174–#176); overall satisfaction OK.
- Launch date 2026-07-18 is **context only** — capacity/spike readiness is an audit question, but the plan is prioritized by correctness, not calendar.

## Decisions locked in interview (2026-07-07)

1. **Shape:** one multi-agent audit sweep → one Master Plan. No fixes during audit.
2. **Prod access:** read-only for the whole audit (SSH read, DB read, logs, resource observation). No restarts, no config changes, no writes. Test renders allowed (see 6). Anything beyond read-only → ask Mew per case.
3. **Priority order for the Master Plan:** P0 money + security → P1 stability/ops (crons, monitoring, alerting) → P2 render throughput on KVM8 (workers/concurrency/b-roll+avatar pipeline cost) → P3 app/API speed. **Output quality is a gate over every phase**, not a phase: any render-path change ships only after Mew eyeballs a before/after clip.
4. **Provisional targets** (finalize after baseline): job starts ≤ ~1–2 min after submit in normal hours; normal clip ≤ ~5 min; ≥ 3–4 concurrent renders without OOM; render success ≥ 99% (excluding customer-key failures); all crons alive + alerted; dashboard/editor usable < 3 s; core API p95 < 1 s; money 100% auditable (no double-charge, no leak, verify-script provable).
5. **Scope IN:** all ~87 API routes; all 3 render paths (web editor, MCP, cutaway); render workers/queue/resource use; b-roll pipeline end-to-end (windows, stock fetch, LLM ranker, per-window edit, ffmpeg/Ken Burns cost); avatar pipeline (HeyGen, chroma, composite); crons/PM2/Nginx/deploy; every money path (Stripe webhooks, payments, credits, minutes); security (old deferred list + fresh sweep); SQLite growth/bottlenecks.
   **Scope OUT:** new features (MANAGED_KIE go-live, video gen), marketing/copy, big infra migrations (Postgres/GPU/cloud — record as proposals only), dead-code removal (list in appendix only).
6. **Baseline test set (5 clips, account `duckyhero` — has ElevenLabs + HeyGen keys), run in a quiet window (never during a user's generation):** normal clip · long/pause-heavy (subtitle timing) · avatar bookend · cutaway upload · per-window b-roll edit. This same set clears the outstanding pending-QA backlog in one Mew viewing session and becomes the quality baseline for later before/after comparisons.
7. **Deliverables:** English docs with a Thai summary header — `docs/audits/2026-07-07-system-optimization-audit.md` (evidence + findings + baselines) and `docs/plans/2026-07-07-system-optimization-master-plan.md` (phased execution plan, each phase runnable via `/mew-kickoff execute`); plus a Thai TL;DR in chat.
8. **No launch-date freeze windows.** Execute what the Master Plan says, when it says.

## Execution Directive

Audit agents investigate and report findings with evidence (`file:line`, queries, numbers). They do not modify code.

| # | Task | Agent | Mode | Review gates |
|---|------|-------|------|--------------|
| 1 | **Money-path audit**: Stripe webhooks, checkout, PromptPay, manual payments, credits (grant/spend/refund/packs), minutes reserve/refund, overflow, trial grant/revert — every path money or quota moves; race conditions; idempotency; verify known edges from overnight report §3 | mew-worker-heavy | subagent | session-model verification of each finding (adversarial re-check of HIGH+) |
| 2 | **Security sweep**: authz on all ~87 routes (IDOR), input handling, SSRF, key handling (incl. deferred: `?key=` URLs, BYOK plaintext, unsigned `/api/renders`), admin routes, MCP auth, cron auth, rate limiting | mew-worker-heavy | subagent | session-model verification (adversarial re-check of HIGH+) |
| 3 | **Render pipeline perf audit (code-level)**: worker loop, job pickup latency, TTS→b-roll→composite→burn stages, b-roll cost drivers (stock fetch, ranker, Ken Burns, ffmpeg flags), avatar composite cost, Remotion/Chromium settings vs 8-core box, cache use, temp-file hygiene | mew-worker-heavy | subagent | session-model verification |
| 4 | **App/API perf audit**: heavy routes, N+1 Prisma, payload sizes, polling frequency, client bundle/render blocking on dashboard+editor, queue-status UX path (the 0% stuck message) | mew-worker | subagent | session-model verification |
| 5 | **Stability/ops audit**: PM2 apps + crons (why stopped, restart policy, alerting gap), deploy.sh risks, disk/swap posture, log rotation, SQLite locking under concurrency, backup story | mew-worker | subagent | session-model verification |
| 6 | **Prod baseline measurement** (read-only SSH + DB): historical VideoJob/RenderJob durations + queue waits (p50/p95), success rates, failure taxonomy, current resource profile while rendering, API latency probes, DB size/hot tables | session model (needs prod-access judgment) | inline | numbers cross-checked against task 3/5 findings |
| 7 | **Baseline test renders** (5-clip set, duckyhero, quiet window) + timing/resource capture; hand clip links to Mew for the combined pending-QA + quality-baseline viewing | session model (coordinates; MCP/browser where possible) | inline | Mew eyeballs clips (async — does not block synthesis) |
| 8 | **Synthesis**: audit report + Master Plan (phased P0→P3 per decision 3, tasks with agents + gates + Mew checkpoints) | session model | inline | mew-critic against Acceptance Criteria, then session-model final gate |

Tasks 1–5 run in parallel; 6–7 run alongside them (session model); 8 last.

## Acceptance Criteria

- [ ] Baseline numbers are from real prod data, not estimates: render duration p50/p95 per clip type, queue wait p50/p95, success rate, resource profile under concurrent load, API latency for core routes, DB size + growth.
- [ ] Capacity question answered with evidence: how many concurrent renders the KVM8 box sustains now, recommended worker-count/concurrency config, and a spike playbook (what to turn up, what breaks first).
- [ ] Every finding has severity + `file:line` + concrete failure scenario; every HIGH+ money/security finding survived an adversarial re-verification.
- [ ] The known deferred/edge lists (video-editor audit deferrals, overnight-report §3) are each explicitly dispositioned: confirmed-still-open / already-fixed / not-reproducible.
- [ ] Queue-wait UX ("0% stuck, users think it's frozen") captured as an explicit prioritized item.
- [ ] Master Plan phases follow P0 money+security → P1 stability → P2 render throughput → P3 app speed; each phase independently deployable; every render-path-touching task carries a "Mew before/after clip approval" gate; provisional targets restated with baseline-corrected numbers.
- [ ] 5-clip baseline set rendered on duckyhero, links delivered to Mew, mapped to the pending-QA items they clear.
- [ ] Both docs have Thai summary headers; chat delivery includes a Thai TL;DR readable in ~2 minutes.
- [ ] No code changes, no prod writes, no restarts occurred during the audit.

## Status
interviewed 2026-07-07 | approved: 2026-07-07 | executed: 2026-07-07 | delivered: 2026-07-07 (audit report + master plan)
