# Scale & Server-Upgrade Plan

- **Date:** 2026-06-18
- **Author:** Mew (+ Claude)
- **Status:** Draft — locks the *direction* so today's work (Phase 2 queue) migrates upward without rework. Numbers marked **[confirm]** are proposed defaults for Mew to set.
- **Relationship:** This is the destination that [`docs/superpowers/specs/2026-06-10-video-editor-optimization-design.md`](superpowers/specs/2026-06-10-video-editor-optimization-design.md) Phase 2 is the *free precursor* of. Phase 2's job model maps 1:1 onto the higher rungs below — that 1:1 mapping is the whole point of this doc.

## 0. Guiding principle (Mew's rule)

> **Fix the architecture first; add hardware last.** More hardware only raises the ceiling — it does not fix a design where render and web share one process and heavy work runs unbounded per request. So we climb the ladder *in order*; we do not skip to "buy a bigger box" to paper over a structural problem.

Corollary: every rung must be reachable by **swapping a substrate behind a stable job interface** — never by rewriting the pipeline. If a proposed upgrade needs app-logic changes, it's the wrong rung.

## 1. Current capacity baseline (measured 2026-06-18)

| Resource | Value | Note |
|---|---|---|
| Box | 1× Hostinger VPS, 4 vCPU / 15 GB RAM, **no GPU** | Remotion renders on CPU (swiftshader); GPU does **not** help |
| Render | serial, **in the web process** (`renderMedia` in `ai-content`) | a big render can OOM-restart the whole web server |
| Normalize | serial (`STOCK_NORMALIZE_CONCURRENCY=1`), decode-bound | per-clip cost dominates, not clip count |
| Load | idle ~0.5, spikes to **~8.6 (2× cores)** under render | CPU is the bottleneck |
| Disk | 133 GB / 194 GB used (**69%**, 62 GB free) | stocks ~34 GB + renders ~32 GB = **regenerable** |
| DB | `prisma/dev.db` ≈ **23 MB**, WAL mode live | **the only non-regenerable asset — back up before any upgrade** |
| AI cost | **$0 to us** — BYOK (users supply Gemini/Pexels/ElevenLabs/HeyGen keys) | our infra cost = render CPU + storage + bandwidth only |

## 2. The scaling ladder (climb in order; each rung has a trigger)

**Rung 0 — Durable queue + render-worker isolation** *(= Phase 2, no new spend, DO FIRST)*
Render leaves the web process → a dedicated PM2 `render-worker` claims jobs from a SQLite `RenderJob` table (WAL); cgroup v2 + `oom_score_adj` keep the web alive. **This is the foundation every higher rung builds on.** Trigger: now.

**Rung 1 — Vertical: bigger CPU box** *(cheapest scale, when Rung 0 is saturated)*
Hostinger in-place plan upgrade 4 → **8 vCPU** (lowest-risk path; no migration). Worker render `concurrency` and a 2nd worker slot become affordable.
Trigger: p95 queue-wait > **10 min [confirm]** sustained, with a single worker already busy most of the day.

**Rung 2 — Horizontal on one box: N render workers**
2–3 `render-worker` PM2 instances under a cgroup slice (each claims independently; SQLite atomic claims already prevent double-claim). No new server, no new substrate.
Trigger: box has CPU headroom across cores but serial single-worker wait still grows (i.e., we're under-using parallelism, not out of CPU).

**Rung 3 — Substrate swap: SQLite → Redis/BullMQ + multi-box workers** *(first paid infra)*
When one box is genuinely saturated. The job interface stays identical; only the queue backend changes (better-sqlite3 adapter → BullMQ adapter). Render workers move to a 2nd cheap box pointed at the shared queue.
Trigger: one box maxed on CPU **and** Rung 2 exhausted; concurrent active renders regularly > workers.

**Rung 4 — Managed DB + object storage + CDN**
Postgres (managed) when DB write contention or multi-box access forces it; media (`stocks/`, `renders/`) → S3/R2 + CDN when disk or bandwidth is the limit (media is regenerable, so this is low-risk to migrate).
Trigger: DB lock contention across boxes, or disk > **85% [confirm]**, or egress bandwidth costs spike.

**Optional side-path — Remotion Lambda (serverless burst render)**
Instead of (or alongside) Rung 2/3, offload render to Remotion Lambda for elastic burst. Pay-per-render, no idle cost, but adds AWS dependency + per-render $ and cold-start latency. Consider only if traffic is **spiky** rather than steadily growing. **[confirm: do we want an AWS dependency at all?]**

## 3. Migration seams — what stays vs what changes per rung

The app **only ever calls a stable job interface** (`enqueue / claim / progress / cancel / sweep`). That is the contract that makes the ladder rework-free:

| Layer | Rung 0–2 (1 box, free) | Rung 3–4 (paid, multi-box) | App logic changes? |
|---|---|---|---|
| Job state machine (QUEUED/RUNNING/DONE/FAILED + attempts/heartbeat/idempotencyKey) | SQLite `RenderJob` | BullMQ job | **No** |
| enqueue/claim/progress/cancel/sweeper | better-sqlite3 atomic claim | BullMQ/Redis | **No** (adapter only) |
| Workers | 1 → N PM2 procs | N procs across boxes | **No** (add instances) |
| DB | SQLite WAL | managed Postgres | one migration |
| Media | local disk | S3/R2 + CDN | path/URL helper only |
| Containment | cgroup v2 + `oom_score_adj` | container/orchestrator limits | config, not logic |

**Rule that keeps the direction:** never let the pipeline import SQLite directly — go through the job interface. Then "scaling" = replacing what's *under* the interface.

## 4. How the B-roll quality work fits this direction

The B-roll goals (more distinct clips so they don't repeat/loop; CPU-heavy CLIP re-rank for "matches the content") **both add render/normalize CPU**. On today's in-process architecture that is the exact change that broke prod before (broll-quality-2). On Rung 0+ it is safe: render is isolated, serialized, and CPU-capped by cgroup. **So B-roll quality is a *consumer* of this ladder, not a parallel track** — it lands after Rung 0 and benefits from every rung above it.

## 5. Data safety & rollout (non-negotiable)

- **Back up `dev.db` before any upgrade/migration** (it's the only irreplaceable asset; stocks/renders regenerate). Backups already in `prisma/*.bak`.
- Every rung is **flag-gated with the legacy path intact** until chaos-tested off-peak (`kill -9` worker, deploy mid-render, memory pressure) — same gate as Phase 2 (`RENDER_VIA_QUEUE`).
- **Deploy only when the box is idle** (no active render).
- Verify cgroup v2 availability on the Hostinger kernel before relying on it; `oom_score_adj` alone already prevents web death as a fallback.

## 6. Decision points for Mew

1. Trigger thresholds marked **[confirm]** (queue-wait minutes, disk %).
2. Vertical-first (Rung 1, Hostinger 8 vCPU) vs jumping to Remotion Lambda for render — default here is **vertical-first** (matches the "hardware last, cheapest first" rule). Confirm or override.
3. Budget ceiling for "when budget exists" (Rungs 3–4) — used to pick the trigger to start paying.
