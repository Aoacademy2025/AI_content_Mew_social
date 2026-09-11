# Performance audit, error summary and admin re-organisation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `mew-kickoff execute` (Claude adapter → superpowers:subagent-driven-development). Steps use checkbox (`- [ ]`) syntax for tracking. Read `CONTEXT.md` (Operations & Admin, Growth & Conversion, Credit Economy) and ADR 0062 before any task.

Date: 2026-09-12 · Interviewed by the session model with Mew (3 rounds, all decisions locked) · Pre-flight critic rounds 1+2 applied (reports: `docs/plans/reports/2026-09-12-performance-audit-admin-reorg-critic.md`, `…-critic-round2.md`) · Language: technical English; Thai copy blocks are the production asset.

**Goal:** Remove the perceived delay ("ง่วง") on `/admin`, `/dashboard`, `/admin/insights` and `/video-editor`, prove every number those pages show, summarise 14 days of production errors, and re-organise the admin area into five groups with daily trend cards — without changing any rendered video output.

**Architecture:** Three phases in one plan. **Phase A** measures production read-only and audits code, numbers and errors into one report (`docs/audits/2026-09-12-performance-audit.md`) reviewed under ultracode. **Phase B** ships the "safe quick win" fixes Mew pre-approved (caching, batched reads, auth query diet, font scoping, retention) plus the DB-contention remedy chosen from A1's evidence. **Phase C** rebuilds `/admin` as the North Star overview with trend cards, splits the old tabs into routes, regroups navigation, and consolidates money onto `/admin/revenue` (ADR 0062). Every code task is a tracer bullet with its own verify script; render-path files are never touched.

**Tech Stack (verified from `package.json` on `main` `51396286`, 2026-09-12 — `CLAUDE.md`'s "Next.js 15" line is stale):** Next.js `^16.3.0` (App Router, webpack build via `scripts/build.js`), React `19.2.3`, Prisma `^6.19.2` on SQLite (WAL, epoch-ms `DateTime`), Clerk `^7.4.1`, PM2 on the Hostinger KVM8 (Kuala Lumpur), Sentry `hero-studio-web`, Linear team `HERO`, the team's `scripts/verify-*.ts` temp-SQLite test pattern, CI `.github/workflows/ci.yml`.

**Spec:** this file (interview decisions §0) + `CONTEXT.md` + ADR 0062. Prior art that must not be re-derived: `docs/audits/2026-07-07-system-optimization-audit.md` (July baseline — numbers stale, method reusable), `docs/plans/2026-07-07-system-optimization-master-plan.md` (P0/P1/P3 shipped; P2 shipped in commit `e79a2d15`), HERO-10 history (PRs #462, #465).

**Re-locate rule (applies to every task):** file paths, line numbers and symbol names below were verified on `main` `51396286` on 2026-09-12. Re-locate by the quoted heading, identifier or string if lines drifted. If a referenced file, export or column is absent, **stop and report** in the task result — never improvise a substitute.

---

## 0. Decisions locked in the interview (do not re-open)

| # | Decision |
|---|----------|
| Q1 | Scope = web + API + DB, infra, client bundle; render pipeline **read-only review only** (A3 Step 7 → report §6). No render tuning. |
| Q2 | Pages that feel slow: `/admin`, `/dashboard`, `/video-editor`, `/admin/insights`. Mew also distrusts the numbers shown → accuracy audit is in scope. Objective = the Subscription North Star (MAPC). |
| Q3 | Targets: `/admin` usable ≤ 2.0 s, `/dashboard` and `/videos` ≤ 1.5 s, `/video-editor` open ≤ 3.0 s, `/admin/insights` ≤ 2.5 s (Mac Chrome, office network, warm session, 3-run median); API median < 350 ms and max < 500 ms over 20 runs on every endpoint those pages call; `[prisma-slow-tx]` held ≥ 5 s = 0/day and `Socket timeout` = 0/day for 7 consecutive days; rendered video output byte-for-byte unchanged in settings. |
| Q4 | Production access for the execute session = **read-only SSH** + `EXPLAIN QUERY PLAN` + read-only `PRAGMA`. No writes, no restarts, no synthetic load, no DB copy off-box, no reading `.env` values. Every command run on prod is logged in the report. |
| Q5 | Deliverables: audit report with a 2-minute Thai summary + English detail + before/after table; 14-day error summary as a Thai table (class → count → who is affected → แก้ / เฝ้าดู / noise); Linear issues as **drafts only** (no `--apply`). |
| Q6 | One plan, phases A→B→C. "Safe quick win" policy (ship without per-item approval): cache/lazy-load, additive indexes, fewer duplicate queries, per-route fonts, log/telemetry retention. **Ask Mew first, every time:** anything that changes render output, billing/quota *outcomes*, removes a column, or runs `VACUUM`/maintenance on prod. |
| Q7 | Telemetry retention 90 → 60 days + one `VACUUM` run by Mew off-peak — only if A1 confirms `TelemetryEvent` is the bulk of the ~480 MB DB. |
| Q8 | Reopen **HERO-10** as the canonical DB-contention issue (same cause) + one new umbrella issue for the audit. Both as drafts until Mew says sync. |
| Q9 | Admin tabs load per page; disk numbers cached 10 min server-side; the existing refresh button bypasses the cache. |
| Q10 | Error window = 14 days. |
| Q11 | North Star = MAPC. `CONTEXT.md` reconciled 2026-09-12 (the Growth section's "North Star" is now *Trial Conversion Rate*). |
| Q12 | All admin numbers get verified; admin menus get re-categorised (Q17). |
| Q13 | Trend cards live on `/admin` (overview). |
| Q14 | "สร้างคลิป/วัน" shows **two series**: Base Render สำเร็จ + Export สำเร็จ, editor and MCP together, failures overlaid in red. |
| Q15 | Error card = video-job failures by Job Failure Class (ฝั่งเรา vs ฝั่งลูกค้า); server-error notifications and `frontend_error` telemetry as small secondary numbers. |
| Q16 | A "จ่ายจริง/วัน" series (count of `Payment.status = PAID` by `paidAt`; never amounts). |
| Q17 | Admin IA option **(A)**: five Thai groups, each former tab becomes its own route (exact tree in Task C3; the single-item group ภาพรวม is deliberate — the group header doubles as the section title). |
| Q18 | Menu labels Thai everywhere (URLs unchanged/English). |
| Q19 | Admin is used mostly on Mac, sometimes phone → charts default to 14 days under 640 px; groups collapsible on mobile. |
| Effort | Interview/plan at `xhigh`; execute at `high`; Mew switches to `ultracode` when the session says so (report review, Task A6). |

## Global Constraints
- **Render output is untouchable.** No task modifies `ecosystem.config.js` render/stock env objects, `src/lib/run-render.ts`, anything under `src/remotion/**` (`src/components/remotion/` named in `CLAUDE.md` does not exist), ffmpeg arguments anywhere, or `RENDER_*`/`STOCK_*` values. Render fonts are loaded by the Remotion bundle itself (`src/remotion/captionStyles.ts:219`, `src/remotion/SubtitleOverlayComposition.tsx:12`, `src/remotion/VideoComposition.tsx:7`), not by `src/app/layout.tsx`. A PR touching those files is rejected at review.
- **Production is read-only in this plan.** Allowed on the VPS (`ssh -i ~/.ssh/hostinger_heroai_codex root@72.62.196.230`, app `/var/www/ai-content`, DB `prisma/dev.db`): `sqlite3 -readonly`, `EXPLAIN QUERY PLAN`, read-only `PRAGMA` (`journal_mode`, `wal_autocheckpoint`, `page_count`, `page_size`, `freelist_count`, `cache_size`, `compile_options`), `pm2 status|describe|logs --nostream`, `ls du df stat wc grep sed awk zcat sort uniq head tail free uptime nproc`. Forbidden: any write, `VACUUM`, write `PRAGMA`, `pm2 restart|stop|start`, editing files, `cat`/`grep` of `.env` values (key **names** only via `cut -d= -f1 .env | sort`), copying `dev.db` off the box, running `deploy.sh`, synthetic load. Only Mew deploys, and only when she says so in that message.
- **No customer identity anywhere**: no emails, names, scripts, prompts, media URLs in any report, log excerpt, Linear draft; **no screenshots are saved in the repo or reports at all** — numbers only. Support tickets by internal id prefix only. Route names and counts are fine.
- **Day boundaries are Asia/Bangkok** for every daily series, every "today" figure and every log census: SQLite `date(col/1000,'unixepoch','+7 hours')`; in JS `new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok'}).format(d)` for `YYYY-MM-DD`; log lines by their own ISO timestamp shifted +7 h, never by the log file's name.
- **Job Failure Class** (CONTEXT.md: system / byok / quota / noise) is the only taxonomy for *video-job* failures; implemented once in `src/lib/job-failure-class.ts` (Task C1) and imported everywhere. The 14-day error summary (A5) uses a separate **Error Source Class** for browser/server/third-party errors (defined in A5).
- **Money renders only on `/admin/revenue`** (ADR 0062); money on `/admin` is limited to the paid-count trend (จ่ายจริง/วัน — counts, never amounts); `/admin/insights` shows no revenue block and no money chips.
- **Menu copy is Thai**; URLs stay as listed in Task C3. Design tokens: single-accent violet `#8B5CF6`, existing `var(--ui-*)` card surface, Bai Jamjuree headings — no new UI library, no chart library (inline SVG).
- **Schema changes are additive only** (`@@index`, new columns) — deploy runs `prisma db push`. No column removal or rename.
- **Every code task has a verify script** (`scripts/verify-<name>.ts`, temp SQLite via the team pattern, wired into `package.json` and `.github/workflows/ci.yml`) that fails before the change and passes after. CI must be green before merge; `gh pr merge --auto` merges immediately on this repo, so wait for the check first. Report-only helpers (A3's query counter) are snippets inside the report, not scripts.
- **Workspace:** `orca worktree create --repo name:AI_content_Mew_social --name <slug> --agent claude` from latest `origin/main`; branch `mew/<slug>`; in the worktree run `cp ../AI_content_Mew_social/.env .env && npm ci && npx prisma generate` (the root `node_modules` is empty — never symlink). One task = one worktree = one PR. Two tasks never hold PRs open on the same file (see Blocked-by).
- **Editor harness gotcha:** `verify:editor-job-runtime` and the media-keys harness replay source against hand-written symbol tables; a new import in `src/app/api/videos/jobs/route.ts` or the media-keys files fails CI while `tsc` stays green. No task below touches those files.
- **Sentry filter:** never add `failed_to_load_clerk_js` or any sign-in/sign-up error to `beforeSend`.
- **Linear:** `node .agents/skills/hero-studio-ops/scripts/linear.mjs` read commands only; every mutation stays a preview (no `--apply`) in this plan. Draft formats: new issues = one `*.json` per issue in the `create --file` schema of `.agents/skills/hero-studio-ops/references/linear-api.md` (`title, description, state, priority, assignee, labels`); the HERO-10 reopen = `HERO-10-reopen-comment.md` (a `comment --file` body) plus the intended `transition HERO-10 "Triage"` command written in the report.

## Assurance and Budget
- Profile: **high-assurance** for B3 (entitlement hot path), B6 (DB maintenance/contention), C5 (numbers that describe money); **standard** for everything else.
- Risk: **medium** overall — read-only measurement, reversible web changes; the three high-assurance tasks touch billing-adjacent code, the production DB file, or money reporting.
- Automatic fix rounds per task: 2 (standard) | 5 (high-assurance).
- Maximum subagent runs: 48. Caps written at Gate A: B6 ≤ 3 rows, C5 ≤ 6 fixes; anything beyond becomes a follow-up plan.
- Concurrency: fill only live harness slots. A1, A1b, A4, A5 share the single read-only SSH audit trail → A1 first, then A1b, then A4 ‖ A5. A2 ‖ A3 run alongside A1.
- Usage checkpoints: before execute, after Phase A (Gate A), after Phase B (Gate B), before the final gate.
- Effort: execute session `high`; Mew switches to `ultracode` for the A6 report review and back to `high` after; `max` before the Tier-2 gate.

---

## Phase A — Measure and audit (read-only)

### Task A1: Production measurement (read-only SSH)

**Files:**
- Create: `docs/plans/reports/2026-09-12-A1-prod-measurement.md`
- Read on prod: `/root/.pm2/logs/*.log*`, `/var/www/ai-content/prisma/dev.db` (readonly), `/var/www/ai-content/ecosystem.config.js`. Not `.env` (key names, if needed, only via `cut -d= -f1 .env | sort`).

**Interfaces:**
- Produces: §A1.1 slow-tx census, §A1.2 lock-holder table, §A1.3 DB anatomy, §A1.4 WAL/backup interplay, §A1.6 disk-walk timing, §A1.7 process profile, §A1.8 ranked causes — B6's decision table keys off §A1.2–§A1.4 and A1b's §A1.5.

- [ ] **Step 1: Open the audit trail.** Create the report with a "Commands run on production" section; append every SSH command verbatim as you go.
- [ ] **Step 2: Slow-transaction census (7 Bangkok days).** Read every `ai-content-error__*.log{,.gz}` and `ai-content-out__*` whose content covers the last 7 days (a file may straddle two Bangkok days — bucket by the line's own timestamp, never by file name). Per Bangkok day: count `[prisma-slow-tx]` lines, extract the hold time, report p50/p90/max and the count ≥ 5000 ms; count `Socket timeout`, `Transaction already closed`, `P1008`, `SQLITE_BUSY`, `database is locked`. Repeat for `mcp-video-worker`, `story-film-system-worker`, `render-worker`. Bucket slow-tx by Bangkok hour too. Also report the count of `prisma-slow-tx` lines that lack a leading ISO timestamp (`grep -c 'prisma-slow-tx'` minus the timestamped count) — a non-zero count means the log format differs from the assumption: stop and report before drawing conclusions. Portable extraction (no gawk-only `match(...,m)`):
  ```bash
  zcat -f /root/.pm2/logs/ai-content-error__*.log* \
    | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*prisma-slow-tx.*held [0-9]+ms' \
    | sed -nE 's/^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})[^ ]*.*held ([0-9]+)ms.*/\1 \2/p' \
    | awk '{ cmd="date -u -d \""$1"Z +7 hours\" +%Y-%m-%d_%H"; cmd | getline bkk; close(cmd); print bkk, $2 }' \
    | sort | awk '{ n[$1]++; if ($2>=5000) big[$1]++ } END { for (d in n) print d, n[d], big[d]+0 }' | sort
  ```
- [ ] **Step 3: Lock-holder correlation.** For each slow-tx ≥ 5 s at timestamp `T` with hold `H`, print every timestamped line from all PM2 logs in `[T−H−2 s, T]`; identify the route/job step active (`[orchestrator]`, `[story-film]`, `[render-worker]`, `[cron]`, admin routes) and whether `db-backup`'s `VACUUM INTO` (02:00) or `cleanup-videos` (03:00) overlaps. Table: window → candidate holder → confidence (high/medium/low) → evidence line (sanitised).
- [ ] **Step 4: DB anatomy.** `PRAGMA page_size; PRAGMA page_count; PRAGMA freelist_count; PRAGMA journal_mode; PRAGMA wal_autocheckpoint; PRAGMA compile_options;` then per-table size: if `ENABLE_DBSTAT_VTAB` is in `compile_options`, `SELECT name, SUM(pgsize)/1048576.0 mb FROM dbstat GROUP BY name ORDER BY mb DESC LIMIT 25;` else `SELECT count(*)` for `TelemetryEvent, Notification, RenderJob, VideoJob, ToolCallAudit, StoryFilmArtifact, StoryFilmGenerationJob, BrandLookPreviewItem, ContentPreflight, User, Payment, Video, SupportTicket` plus `avg(length(payload))` on RenderJob and `avg(length(properties))` on TelemetryEvent. Sample `ls -l prisma/dev.db*` three times one hour apart (WAL size). Count stale backups `ls prisma/ | grep -c 'dev.db\.'` and `du -sh prisma/ /var/backups/heroai`.
- [ ] **Step 5: Backup/checkpoint interplay.** `pm2 describe db-backup`, `pm2 logs db-backup --lines 300 --nostream`: duration of each nightly `VACUUM INTO`; WAL size around 02:00–02:30 vs 09:00. State whether `wal_autocheckpoint` (default 1000 pages ≈ `page_size × 1000`, i.e. ≈ 4 MB at the usual 4 KiB page) is starved by long readers (backup, insights scans) — evidence: WAL ≫ 4 MB for hours.
- [ ] **Step 6: Disk-walk timing.** `time du -sk public/renders stocks .tmp public/music` and `find <dir> -type f | wc -l` for each — this is what `/api/admin/storage` executes per admin open.
- [ ] **Step 7: Process profile.** `pm2 status`, `pm2 describe ai-content` (restarts, memory, uptime, env **key names** — note whether `TZ`, `PRISMA_*`, `SQLITE_*` are set), `free -m`, `uptime`, `nproc`, `df -h`. No load testing.
- [ ] **Step 8: Rank causes.** Close with "Top causes of delay, ranked by evidence" (≤ 5 items, each with its measured number) and the B6 inputs (§A1.2–§A1.4 verdicts). Numbers only.

### Task A1b: Query plans on production (Blocked by A1, A3)

**Files:** Append to `docs/plans/reports/2026-09-12-A1-prod-measurement.md` §A1.5.
**Interfaces:** Consumes A3 §A3.7 (the exact SQL strings Prisma emits). Produces §A1.5: one row per query — SQL (parameter placeholders), `EXPLAIN QUERY PLAN` output, table row count, `SCAN`/`SEARCH` verdict.
- [ ] Run `EXPLAIN QUERY PLAN <sql>` readonly on prod for every SQL in A3 §A3.7; flag every `SCAN` on a table with > 10 000 rows (row counts from A1 §A1.3). Append commands to the audit trail.

### Task A2: Browser measurement of the five pages

**Files:**
- Create: `docs/plans/reports/2026-09-12-A2-browser-measurement.md`

**Interfaces:**
- Consumes: Mew's logged-in Chrome (admin account) via the `chrome-devtools` MCP tools (`performance_start_trace`/`performance_stop_trace`, `list_network_requests`, `lighthouse_audit`) — requires Mew present; fall back to `mcp__claude-in-chrome__read_network_requests`.
- Produces: per-page table (cold ×3, warm ×3): time-to-usable, request count, per-XHR TTFB/duration/size, LCP/INP/CLS, JS transferred, render-blocking CSS (`fonts.googleapis.com` stylesheet time), long tasks; per-endpoint timings (n = 20: p50, p95, max); the captured API JSON for A4 (numbers only, saved as `docs/plans/reports/2026-09-12-A2-api-json/<route>.json` after stripping any `email`/`name`/`script`/`prompt`/`url` fields).

- [ ] **Step 1:** Pages: `/admin`, `/dashboard`, `/videos`, `/admin/insights?days=30`, `/video-editor` (open an existing project). Each: 3 hard reloads (cold) and 3 sidebar navigations (warm). "Usable" = main numbers/list visible. No screenshots are saved anywhere; record numbers only.
- [ ] **Step 2:** From the page console, time each API 20× (`performance.now()` around `fetch`), report p50/p95/max **separately for warm calls (runs 2–20) and the first cold call (run 1)** — `/api/admin/storage`, `/api/admin/cleanup?…` and `/api/admin/insights?days=30` are expected to be slow cold (disk walk / scan) and the cold number is recorded as a known cost: `/api/user/me`, `/api/updates?summary=1`, `/api/notifications`, `/api/admin/stats`, `/api/admin/settings`, `/api/admin/storage`, `/api/admin/cleanup?…` (the default params the page sends), `/api/admin/support?status=OPEN`, `/api/admin/music`, `/api/admin/insights?days=30`, `/api/user/stats`, `/api/videos`, `/api/editor-projects`, `/api/admin/revenue`. Save one response body per route (sanitised as above) for A4.
- [ ] **Step 3:** Lighthouse (performance category only) on `/admin` and `/dashboard`; note "Eliminate render-blocking resources" and "Reduce unused JavaScript" byte counts.
- [ ] **Step 4:** Write the table + the three worst offenders per page, each with a one-line pointer to the A3 cause.

### Task A3: Code audit — request fan-out, DB work per request, render pipeline read-only review

**Files:**
- Create: `docs/plans/reports/2026-09-12-A3-code-audit.md` (the query counter is a snippet inside §A3.1, not a repo script)

**Interfaces:**
- Produces: §A3.1 query/write count per endpoint (local run), §A3.2 `getCurrentUser` chain diagram, §A3.3 table of all `$transaction(async` sites with "awaits external I/O inside? / max plausible hold", §A3.4 font consumers by route **excluding `src/remotion/**`**, §A3.5 per-route First Load JS from `next build`, §A3.6 render-pipeline read-only review, §A3.7 the exact SQL strings for A1b, §A3.8 ranked code-level causes with expected saving per page.

- [ ] **Step 1:** Worktree + `npm ci` + `npx prisma generate`; seed a local admin (Clerk dev keys; the local QA rig is login `mewtest` / OTP `424242` per project memory) with a few videos/jobs/tickets.
- [ ] **Step 2:** Run `DEBUG="prisma:query" npm run dev`; hit each endpoint from A2 Step 2 once; count queries and writes (`INSERT|UPDATE|DELETE`) per request; record the exact SQL of the ten queries listed in A1b's scope (revenue-cohorts user scan, insights `telemetryEvent` by `name`/`createdAt`, `videoJob` createdAt range, `renderJob` by `status,type`, `supportTicket` by status, `user` by `clerkId`, `siteConfig` key `IN`, `notification` by `userId,read`, `productUpdate` summary, `bundleEntitlement` by email) into §A3.7. Expected finding to confirm or refute: `getCurrentUser()` + `syncUserEntitlement()` ≈ 5–8 queries per authed request; `/api/user/me` ≈ 15–20.
- [ ] **Step 3:** `grep -rln '\$transaction(async' src scripts --include='*.ts'` → for each site list what is awaited inside the callback; mark any `fetch`/`axios`/provider SDK/ffmpeg/`fs` I/O inside as **holder candidate**.
- [ ] **Step 4:** Fonts: `grep -rn "Mitr\|Kanit\|Sarabun\|Prompt\|Noto Sans Thai\|IBM Plex Sans Thai\|Chakra Petch\|Chonburi\|Fahkwang\|K2D\|Charm\|Bai Jamjuree\|Krub\|Pridi\|Itim\|Sriracha\|Bangers\|Bebas Neue\|Oswald\|Anton\|Righteous\|Playfair\|Pacifico\|Lobster" src --include='*.tsx' --include='*.ts' --include='*.css' | grep -v '^src/remotion/'` and map each hit to the route(s) that render it (the in-editor Remotion Player preview renders under `/video-editor`). Separately confirm and record that `src/remotion/**` loads its own font URLs (the three files named in Global Constraints) and imports nothing from `src/app/layout.tsx`. This list is B4's contract.
- [ ] **Step 5:** `npm run build` in the worktree; copy the route table (First Load JS per route) into §A3.5; count `next/dynamic` usages (`grep -rn "next/dynamic" src | wc -l`) and record the number.
- [ ] **Step 6:** Static review of `src/app/api/user/me/route.ts`, `src/lib/clerk-auth.ts`, `src/lib/entitlements.ts`, `src/lib/bundle-entitlement.ts`, `src/lib/paid-equivalent-entitlement.server.ts`, `src/lib/usage-limits.ts`: draw the per-request chain (§A3.2) with the query each step issues and which are duplicates of a row already loaded — this is B3's contract.
- [ ] **Step 7 (render pipeline, read-only):** Read `src/lib/run-render.ts`, `scripts/mcp-video-worker.ts`, the `render-worker` script, and the render/stock env objects in `ecosystem.config.js`; record concurrency settings, timeouts, and anything that could hold the SQLite write lock or block the web process. Findings only, filed as follow-ups in §A3.6 — **no change proposals enter Phase B/C**.
- [ ] **Step 8:** Rank code-level causes (§A3.8); each maps to B1–B6 or "out of scope: code-splitting editor" with the measured size.

### Task A4: Number-accuracy audit (Blocked by A1, A2)

**Files:**
- Create: `docs/plans/reports/2026-09-12-A4-number-accuracy.md`

**Interfaces:**
- Consumes: A1's SSH audit trail (append commands there), A2's sanitised API JSON.
- Produces: one row per number: surface · label · shown value · code definition (file:line + the SQL Prisma runs) · independent read-only SQL · actual · match Y/N · cause · fix task (C5) or "definition is right, label is misleading". Covers the **pre-change** surfaces; the new `/admin` numbers are covered by `verify-admin-trends` plus rows added at C2 time (see Acceptance Criteria).

- [ ] **Step 1:** Enumerate every number on `/admin` overview cards (`/api/admin/stats`), `/admin/revenue` (`getRevenueGrowthDashboard`), `/admin/insights` all nine sections (`/api/admin/insights?days=30`, incl. `CostMarginPanel`), `/dashboard` for Mew's account (`/api/user/stats`, `/api/user/me` usage figures).
- [ ] **Step 2:** For each, read the code path to its definition, then write an independent SQL (readonly on prod) and compare. Mandatory checks: MAPC vs the CONTEXT.md definition (recurring paid entitlement + ≥ 1 Core Creation Outcome in trailing 30 d; `NorthStarDailySnapshot.snapshotDate` freshness); จ่ายจริง/MRR vs `src/lib/revenue-cash.ts` (Stripe truth, not `Payment.amount`; revenue was overstated three ways in August); `totalVideos` (`Video` rows) vs `RenderJob DONE` vs `VideoJob done` — say which one "วิดีโอที่สร้าง" should mean; `newToday`/`newThisWeek` day boundary (`src/app/api/admin/stats/route.ts:15-20` uses `setHours(0,0,0,0)` in server TZ — with A1 §A1.7's `TZ` finding, state whether "today" is off by 7 h); funnel counts (VideoJob vs telemetry) for double counting; "Status stuck" thresholds.
- [ ] **Step 3:** Write the table and a short Thai paragraph per mismatch ("ตัวเลขนี้หมายถึงอะไรจริง ๆ").

### Task A5: 14-day error summary + Linear drafts (Blocked by A1)

**Files:**
- Create: `docs/plans/reports/2026-09-12-A5-error-summary.md`, `docs/plans/reports/linear-drafts/HERO-10-reopen-comment.md`, `docs/plans/reports/linear-drafts/perf-audit-umbrella.json`, one `linear-drafts/<slug>.json` per new actionable class.

**Interfaces:**
- Consumes: A1 log census, Mew's logged-in Sentry in Chrome (issues list, project `hero-studio-web`, `is:unresolved environment:production`, last 14 d), `SupportTicket` (readonly SQL, internal id prefixes only), `TelemetryEvent` `name='frontend_error'` last 14 d grouped by sanitised message, existing Linear issues via `node .agents/skills/hero-studio-ops/scripts/linear.mjs list` (read-only).
- Produces: Thai table — กลุ่ม error · แหล่ง (Sentry/PM2/ticket/telemetry) · จำนวน 14 วัน · กระทบ (ผู้ใช้/ticket) · **Error Source Class** · แนะนำ (แก้ / เฝ้าดู / noise) · Linear ที่มี หรือ ร่างใหม่. **Error Source Class** values (distinct from Job Failure Class): `ours` (our code, any runtime), `customer-key` (BYOK key/credit), `third-party-noise` (extensions, in-app WebViews, injected scripts), `clerk-network` (visitor cannot reach Clerk's CDN), `unclassified`.

- [ ] **Step 1:** Sentry: record group title, culprit, events, users, first/last seen, release; classify with the rules `docs/ops/linear-sentry-observability.md` uses (Remotion shutdown noise, third-party browser noise, Clerk `/touch` network noise are already filtered — anything still visible is a candidate). Cross-check counts against A1's PM2 census (Sentry undercounts).
- [ ] **Step 2:** Tickets: `SELECT substr(id,1,8), category, severity, status, createdAt FROM SupportTicket WHERE createdAt >= <14d epoch ms>`; group by category.
- [ ] **Step 3:** Correlate: one root cause = one row; link existing HERO issues; write the HERO-10 reopen comment quoting **A1 §A1.1's measured** 7-day p50/p90/max hold times and the per-day counts ≥ 5 s (same-cause regression after PRs #462/#465, whose criterion was < 5/day); if A1's numbers are already below that target, do not draft a reopen — record why instead and the umbrella issue JSON (`Improvement`, `Area / Infra`, `Execution / Agent-ready`, `Risk / Production`). No `--apply`.
- [ ] **Step 4:** Write the table; every row has a recommendation.

### Task A6: Assemble the audit report (session model, inline) → Gate A

**Files:**
- Create: `docs/audits/2026-09-12-performance-audit.md`

- [ ] **Step 1:** Structure: **สรุปไทย (อ่าน 2 นาที)** · 1 Baseline measured (A1 + A2 tables) · 2 Causes ranked (A1 §A1.8 ⨉ A3 §A3.8) · 3 Number accuracy (A4 table) · 4 Error summary 14 days (A5 Thai table) · 5 Fix map (cause → task B/C → expected gain) · 6 Render pipeline read-only review (A3 §A3.6, follow-ups only) · 7 Positives (do not touch) · 8 Before/after (filled at Gate B and after the 7-day watch) · 9 Commands run on production (verbatim).
- [ ] **Step 2:** Tell Mew to switch `/effort ultracode`; dispatch `mew-critic` (plan + Acceptance Criteria + report) and `mew-reviewer` with `model: opus` (report vs raw A1–A5 evidence: every number traceable). Fix findings.
- [ ] **Step 3:** Session writes the concrete B6 rows (≤ 3) and the C5 fix list (≤ 6) into this plan from A1/A4 evidence. **🛑 Gate A:** present report + chosen B6/C5 to Mew; wait. Mew switches effort back to `high`.

---

## Phase B — Safe quick wins (policy-approved) + DB remedy

### Task B1: Cache storage health; keep the refresh button honest

**Files:**
- Modify: `src/lib/storage-health.ts` (`getStorageHealth`; also `export` the existing `readDisk` for C1), `src/app/api/admin/storage/route.ts`
- Modify: the storage refresh handler — `loadStorageHealth` in `src/app/(dashboard)/admin/page.tsx` (search `fetch("/api/admin/storage"`) → `fetch("/api/admin/storage?refresh=1", { cache: "no-store" })`; C3 later moves this handler verbatim
- Test: `scripts/verify-storage-health.ts` (exists — extend)

**Interfaces:**
- Produces: `getStorageHealth(cwd?: string, opts?: { force?: boolean; now?: number; ttlMs?: number }): Promise<StorageHealth>`; response gains `cachedAt: string | null` (ISO) so the UI can show "อัปเดตเมื่อ HH:mm"; `export async function readDisk(mount: string)` (unchanged body, now exported).

- [ ] **Step 1: Failing test.** Add to `verify-storage-health.ts`: with a stub `runDu` counter, call `getStorageHealth(dir, { now: 0 })` twice → `runDu` called once per directory total; `{ force: true, now: 0 }` → called again; `{ now: 11 * 60 * 1000 }` → called again (TTL 10 min); a different `cwd` → its own cache slot. Run `npm run verify:storage-health` → FAIL (no `opts`).
- [ ] **Step 2: Implement.** Module-level `const cache = new Map<string, { value: StorageHealth; at: number }>()` keyed by `cwd`; `const now = opts?.now ?? Date.now()`; `const ttl = opts?.ttlMs ?? Number(process.env.STORAGE_HEALTH_CACHE_MS ?? 600_000)`; return the slot's value when `!opts?.force && slot && now - slot.at < ttl`; otherwise compute, store `{ value, at: now }`, return with `cachedAt`. Route: `const force = new URL(req.url).searchParams.get("refresh") === "1"`. Export `readDisk`.
- [ ] **Step 3:** Test PASS; `npx tsc --noEmit`; commit `perf(admin): cache storage health for 10 minutes; refresh=1 bypasses`.

### Task B2: One query for all SiteConfig keys

**Files:**
- Modify: the module exporting `getConfig` (locate: `grep -rn "export async function getConfig\|export const getConfig\|export function getConfig" src` — report if not found), `src/app/api/admin/settings/route.ts` (the line `const results = await Promise.all(KEYS.map(async k => [k, await getConfig(k)] as const));`), `src/lib/plan-config.ts`, `src/lib/load-stripe-config.ts`, `src/app/api/plans/route.ts` (wherever several keys are read in a loop)
- Test: `scripts/verify-site-config-batch.ts` (new; temp SQLite; counts queries with `prisma.$on("query")`)

**Interfaces:**
- Produces: `getConfigs(keys: readonly string[]): Promise<Record<string, string | null>>` — one `siteConfig.findMany({ where: { key: { in: [...keys] } } })`; missing keys → `null`. `getConfig(key)` keeps its signature (delegates to `getConfigs([key])`). **No in-memory cache** — admin edits must be visible on the next request.

- [ ] **Step 1: Failing test.** Seed 5 keys; assert `getConfigs(32 keys)` issues exactly 1 SELECT and returns `null` for the 27 unknown keys. Run → FAIL.
- [ ] **Step 2: Implement** `getConfigs`; replace the `Promise.all(KEYS.map(getConfig))` in admin/settings GET with `getConfigs(KEYS)`; same in the plan-config / stripe-config loaders where they read multiple keys.
- [ ] **Step 3:** Test PASS; `verify:pricing-defaults`, `verify:marketing-pricing`, `verify:hero-script-payment` green. Commit `perf(config): read all SiteConfig keys in one query`.
- Note (A3 §A3.2 / A1b §A1.5 #8, 2026-09-12): Prisma already batches the 32 same-tick `findUnique` calls into one `IN` query on prod, so **no latency win is expected** — B2 stays as a code-clarity quick-win that makes the single query explicit; do not claim a timing gain in the PR.

### Task B3: Auth hot-path query diet — pass the loaded row, change no outcome (high-assurance)

**Files:**
- Modify: `src/lib/clerk-auth.ts` (`getCurrentUserForClerkId`), `src/lib/entitlements.ts` (`syncUserEntitlement`), `src/lib/bundle-entitlement.ts` (`syncStoredBundleEntitlementForUser`), `src/lib/paid-equivalent-entitlement.server.ts` (`resolvePaidEquivalentEntitlement`), `src/app/api/user/me/route.ts`
- Test: `scripts/verify-auth-query-budget.ts` (new) + existing suites `verify:preserve-trial-on-convert`, `verify:first-clip-convert`, `verify:hero-script-payment`, `verify:promotional-credits`, `verify:coupon-pro-entitlements`, `verify:trial-first-clip-path`

**Interfaces:**
- Consumes: A3 §A3.2 (the duplicate-read map).
- Produces: `syncUserEntitlement(userId: string, now?: Date, preloaded?: User)`, `syncStoredBundleEntitlementForUser(userId, now?, options?, preloaded?: User)`, `resolvePaidEquivalentEntitlement(userId, now?, preloaded?: User)` — when `preloaded` (the full Prisma `User` row `getCurrentUserForClerkId` already fetched) is given, the function skips **only its own initial `prisma.user.findUnique`**; every other query and every decision stays exactly as today (the bundle function still looks up `BundleEntitlement` by email — that lookup is how a first activation is discovered, so it is never skipped). `/api/user/me` drops its second `prisma.user.findUnique` and reads the same fields from `authUser` (keep stripping `stripeSubscriptionId`). **No decision logic changes; therefore no Q6 "ask Mew" is triggered — the test proves outcome equality.**

- [ ] **Step 1: Failing test.** Temp DB with five fixtures: FREE; PRO trial (`trialEndsAt` future); PRO Stripe (`stripeSubscriptionId`, `subStatus="active"`); **bundle-active** (a `BundleEntitlement` row `status="ACTIVE"`, `accessEndsAt` future, `lastEventId` ≠ `user.bundleLastEventId`, user otherwise FREE); **bundle-expired** (`accessEndsAt` past, user `bundlePrimary=true`). For each: snapshot the `User` row after calling the **current** code path once (golden), reset, then assert (a) the new path yields a byte-identical `User` row and identical return values, (b) `$on("query")` shows no second `SELECT … FROM "User" WHERE "id" = ?` within one `getCurrentUserForClerkId` call, (c) 0 writes on a second consecutive call (steady state) for every fixture, (d) `/api/user/me` handler in steady state issues exactly `(A3 §A3.2 measured count − the duplicate reads §A3.2 proves)` SELECTs — written into the test as a literal constant at B3 time, both numbers recorded in the PR description — and 0 writes. Run → FAIL (duplicate reads present).
- [ ] **Step 2: Implement** the `preloaded` parameters and the `/api/user/me` change only. Do not add early returns or skips.
- [ ] **Step 3:** All suites green; `npx tsc --noEmit`; commit `perf(auth): reuse the loaded user row across entitlement checks (no outcome change)`. Review: `mew-reviewer` with `model: opus` + `security-review` skill.

### Task B4: Load the subtitle font set only where subtitles render (Blocked by A3)

**Files:**
- Modify: `src/app/layout.tsx` (remove the `GOOGLE_FONTS_URL` `<link>` + the two `preconnect` links; keep `Inter`)
- Create: `src/components/subtitle-fonts.tsx` — server component rendering the two `<link rel="preconnect">` + `<link href={GOOGLE_FONTS_URL} rel="stylesheet" />` (the constant moves here, byte-identical)
- Create: `src/app/(dashboard)/video-editor/layout.tsx`, `src/app/(dashboard)/video-creator/layout.tsx` — each `export default function Layout({ children }: { children: React.ReactNode }) { return <><SubtitleFonts />{children}</>; }`; add the same layout to every other route A3 §A3.4 proves renders one of the families (candidates: `brands`, `style`, `ai-studio/story-film`)
- Modify: `src/app/page.tsx` — the sale page keeps its own minimal `<link>` for `Bai+Jamjuree:wght@400;600;700` only; same for `src/components/marketing/auth-shell.tsx` routes if A3 lists them
- Never: any file under `src/remotion/**` (excluded from the contract; it loads its own fonts)
- Test: `scripts/verify-subtitle-fonts-scope.ts` (new, source-level): `src/app/layout.tsx` contains no `fonts.googleapis.com`; every file in the A3 §A3.4 list sits under a route whose `layout.tsx` or `page.tsx` renders `<SubtitleFonts />` or its own link; no file under `src/remotion/` is modified (git diff name check in the PR review).

**Interfaces:**
- Consumes: A3 §A3.4. If `src/app/globals.css` applies a Thai display family globally (e.g. headings in Bai Jamjuree), keep **only that family** in the root layout link and move the other families.

- [ ] **Step 0:** Re-prove in the worktree: `grep -rn "fonts.googleapis" src/remotion` shows the three self-loading sites; `grep -rn "app/layout" src/remotion` is empty. Record both outputs in the PR description.
- [ ] **Step 1:** Source-level test → FAIL. **Step 2:** Move the link; add layouts. **Step 3:** Test PASS; `npm run build`; dev-server check: editor subtitle preview (Kanit 900 default), `/brands` sample cards, sale-page headings, `/dashboard` headings render the same family as before (state the computed `font-family` from DevTools in the PR description — no screenshots). Commit `perf(fonts): scope the 25-family subtitle font sheet to the routes that draw subtitles`.

### Task B5: Fetch the updates summary once per session

**Files:**
- Modify: `src/components/layout/sidebar.tsx` — the effect containing `fetch("/api/updates?summary=1"` (deps `[sessionLoaded, pathname]` → `[sessionLoaded]`; keep the `product-updates-read` listener)
- Test: `scripts/verify-sidebar-updates-summary-once.ts` (new, source-level, pattern of `scripts/verify-support-ticket-ui-regressions.ts`): the effect that fetches `/api/updates?summary=1` has a dependency array without `pathname`.

- [ ] Steps: failing source test → edit → PASS → commit `perf(shell): stop refetching the updates summary on every navigation`.

### Task B6: DB-contention remedy (rows chosen at Gate A from A1/A1b evidence; ≤ 3 rows; high-assurance)

**Files:** per row. **Test:** `scripts/verify-prisma-slow-tx.ts` (exists) extended per row + 24 h production log count after each deploy.

Decision table — the session copies the matching row(s) into "Chosen rows" after A1/A1b; execute never guesses:

| A1 evidence | Remedy (files) | Verify |
|---|---|---|
| WAL stays ≫ 4 MB for hours; slow-tx clusters around the 02:00 backup or insights scans (§A1.4) | `scripts/backup-db.ts`: after the snapshot succeeds run `sqlite3 <db> "PRAGMA wal_checkpoint(TRUNCATE);"`; `src/lib/prisma.ts`: issue `PRAGMA wal_autocheckpoint = 1000` beside `busy_timeout` | `verify-prisma-slow-tx` asserts the PRAGMA is issued; prod WAL ≤ 10 MB at 09:00 for 3 days |
| A `$transaction(async …)` awaits network/ffmpeg/fs inside (§A1.2 + A3 §A3.3) | Split that site: do the I/O before, keep only the writes in the transaction (pattern of PR #462) | site-specific verify script; slow-tx from that holder = 0 for 24 h |
| `TelemetryEvent` > 50 % of DB bytes (§A1.3: `dbstat` mb when available, else the estimate `count(*) × (avg(length(properties)) + 120)` bytes compared with `page_count × page_size`; the report states which method produced the number) | `src/app/api/cron/cleanup-videos/route.ts`: retention 90 → 60 days (the `cutoff` used by the `telemetryEvent.deleteMany`); then a one-time `VACUUM` in an **announced maintenance window** run by Mew: `VACUUM` holds an exclusive lock for its whole duration, and the web process's busy timeout is 20 s (`src/lib/prisma-options.ts` `BUSY_TIMEOUT_DEFAULT_SEC`), so writes arriving after 20 s would fail with `SQLITE_BUSY` — therefore the web is **stopped**, not kept up. Procedure: (1) measure first — copy the latest `/var/backups/heroai/*.db` snapshot to `/tmp` and time `sqlite3 /tmp/copy.db "VACUUM;"` (touches nothing live; gives the real duration); (2) at 02:30 (after the 02:00 backup): `npm run ops:render-drain`, wait for 0 running renders, `pm2 stop ai-content mcp-video-worker story-film-system-worker render-worker`, `sqlite3 /var/www/ai-content/prisma/dev.db "VACUUM;"`, `pm2 start ecosystem.config.js --only ai-content,mcp-video-worker,story-film-system-worker,render-worker --update-env`, undrain; downtime = measured VACUUM time + ~30 s restart; rollback = the 02:00 snapshot. Presented to Mew at Gate A **as downtime**, never as zero-impact | measured duration from step (1), DB size before/after, downtime actually taken — all in report §8; `/api/admin/insights?days=30` payload unchanged |
| A `SCAN` on a > 10 k-row table serving a page endpoint (A1b §A1.5) | `prisma/schema.prisma`: add the `@@index` (additive) | `EXPLAIN` shows `SEARCH … USING INDEX`; `prisma db push` on deploy |
| `story-film-system-worker` P1008 / own 5 s defaults (§A1.1) | worker bootstrap uses `withSqliteConnectionParams` + `transactionOptionsFromEnv` from `src/lib/prisma-options.ts` | worker log P1008 = 0 for 24 h |
| Stale `prisma/dev.db.*` backups measured in GB (§A1.3) | Mew deletes them by hand (list in report); not a code task | `du -sh prisma/` |
| **Evidence matches none of the above** | Stop. No code change. The session presents the ranked cause to Mew at Gate A with a proposed remedy as a *new* interview item. | — |

**Chosen rows** (written by the session 2026-09-12 from A1 §A1.2–§A1.4, A1b §A1.5/§A1.5b, A3 §A3.1/§A3.3 — **rows 2 and 3 await Mew's yes at Gate A**; row 1 is policy-approved):

1. **Additive index on `Notification`** (decision-table row "SCAN on a > 10 k-row table"): A1b §A1.5 shows `/api/notifications` doing a full SCAN of 16,537 rows (PK only). Add the `@@index` matching the route's `where`/`orderBy` shape (A3 §A3.7 item 9). Verify: `EXPLAIN` on a temp DB shows `SEARCH … USING INDEX`; `prisma db push` on deploy. Safe quick-win (Q6).
2. **`story-film-system-worker` read-first poll** — *new remedy, not in the table*: A1 §A1.8 #2 measured ≈ 21,600 write-first interactive transactions/day from `leaseStoryFilmGenerationJobs` on a 114-row table, 25 `P1008` lease failures/day, 65 % of the worker's lines inside slow-tx windows. Remedy: one cheap read-only pre-check (`count` of expired leases + queued jobs) outside the transaction; open the existing write transaction only when it is non-zero; transaction body and `POLL_MS` unchanged. Verify: extended `verify-prisma-slow-tx` (idle poll issues 0 writes; a queued job is still leased within one poll); prod `P1008` in the worker log = 0 for 24 h. Does not touch render output or billing.
3. **No-op write elimination in `syncUserEntitlement`** — *conflicts with B3's "no early returns" text, so Mew rules*: A3 §A3.1 + A1b §A1.5b: 107 / 249 PRO/BUSINESS accounts (43 %) run `BEGIN IMMEDIATE; UPDATE User … (0 rows); COMMIT` on every authenticated request (twice on `/api/user/me`, even on 403). Remedy: compute as today, then skip the `UPDATE` when every field it would write equals the stored value — the stored outcome is byte-identical by construction. Folded into B3 with a **sixth golden fixture** (PRO, `subStatus="active"`, no qualifying `Payment` row) and test (c) extended to it. Reviewed on opus + security review like the rest of B3.

Not chosen, with the evidence: WAL row — WAL steady at 35 MB (8.5× threshold) but flat across three samples and slow-tx do **not** cluster around the 02:00 backup → advisory only (`wal_checkpoint(TRUNCATE)` after backup is cheap; Mew may add it later). TelemetryEvent row — 28.3 % of the DB, below the 50 % trigger → **no retention change and no VACUUM** (Q7). `$transaction` I/O row — refuted for the hot path (A3 §A3.3: 122 sites, the only network-inside-transaction site is the non-hot-path canary review). Stale snapshots — 64 files / 19 GB listed in A1 §A1.3 for Mew's hand.

- [ ] Steps per chosen row: failing verify → change → PASS → its own PR → Mew deploys (D3.n) → session reads prod logs 24 h later (read-only) and records slow-tx/socket-timeout counts in report §8 → next row only after the count moved.

**🛑 Gate B:** after B1–B6 are deployed, A2 is re-run (same method, all five pages; the `/admin` figure here still describes the old five-tab page and is labelled so) and report §8 gets its first "after" column. Present to Mew.

---

## Phase C — Admin overview, trend cards, routes, revenue consolidation

(Tasks are listed in dependency order — C1, C3, C2, C4, C5, C6 — not numeric order; the numbers are the interview's, the order is the build's.)

### Task C1: Daily trends API + the shared Job Failure Class module (Blocked by Gate A, B1)

**Files:**
- Create: `src/lib/job-failure-class.ts` — move `classifyJobError(message: string | null, managed: boolean)`, `quotaReasonFromText`, `byokReasonFromText` out of `src/app/api/admin/insights/route.ts` (the block starting `// Classify a VideoJob failure.`); insights imports them; behaviour identical
- Create: `src/lib/admin-trends.server.ts`, `src/app/api/admin/trends/route.ts`
- Read (already exported by B1): `readDisk` from `src/lib/storage-health.ts`
- Test: `scripts/verify-admin-trends.ts` (new; temp SQLite), `scripts/verify-job-failure-class.ts` (new; pure)

**Where renders live (verified):** every render — editor (`src/app/api/videos/render/route.ts` → `enqueueRenderJob`) and orchestrated/MCP (`src/lib/render/job-store.ts` writes `parentJobId = VideoJob.id`) — is one `RenderJob` row. `VideoJob` is the orchestration parent and has no separate success population, so success series read `RenderJob` **only, counting every row once, children included**; the failure series reads both tables and guards against counting an orchestrated failure twice.

**Interfaces (Produces):**
```ts
export type JobFailureClass = "system" | "byok" | "quota" | "noise";
export function classifyJobError(message: string | null, managed: boolean): JobFailureClass;

export type TrendDay = { date: string; signups: number; rendersDone: number; exportsDone: number; failedSystem: number; failedCustomer: number; paidPayments: number };
export type TrendTotals = Omit<TrendDay, "date">;
export type AdminTrends = {
  days: 14 | 30;
  timezone: "Asia/Bangkok";
  series: TrendDay[];                                  // ascending, zero-filled, length === days
  totals: { current: TrendTotals; previous: TrendTotals };
  secondary: { serverErrorNotifications: number; frontendErrors: number };
  northStar: { snapshotDate: string; activeCreators: number; activePayingCustomers: number; deltaActiveCreatorsVs30d: number | null } | null;
  queue: { renderQueued: number; videoJobsQueued: number };
  openTickets: number;
  diskUsedPercent: number | null;                      // readDisk("/") only — never du
};
export async function getAdminTrends(days: 14 | 30, now?: Date): Promise<AdminTrends>;
export function defaultTrendDays(viewportWidth: number): 14 | 30;   // < 640 → 14, else 30 (pure; C2 uses it)
```
- Route: `GET /api/admin/trends?days=30|14` (default 30; any other value → 30); auth = `getCurrentUser()` + `role === "ADMIN"` exactly like `admin/stats`.
- Queries (raw, parameterised `$queryRaw` tagged templates; `d = date(col/1000,'unixepoch','+7 hours')`): signups `User WHERE createdAt >= ? AND lower(email) NOT LIKE '%@aoacademy%'` (the same team exclusion the insights funnel applies at `src/app/api/admin/insights/route.ts` — `includes("@aoacademy")` — so the card matches CONTEXT.md's Signup Cohort; record this as an A4 row at C2 time); rendersDone `RenderJob WHERE type='RENDER' AND status='DONE' AND COALESCE(finishedAt, updatedAt) >= ?` bucket by `COALESCE(finishedAt, updatedAt)` (no `parentJobId` filter); exportsDone same with `type='BURN'`; paidPayments `Payment WHERE status='PAID' AND paidAt >= ?` by `paidAt`; failures: `VideoJob WHERE status='failed' AND COALESCE(finishedAt, updatedAt) >= ?` select `{finishedAt, updatedAt, errorMessage}` **plus** `RenderJob WHERE status='FAILED' AND parentJobId IS NULL AND COALESCE(finishedAt, updatedAt) >= ?` select `{finishedAt, updatedAt, error}` — classify in JS with `classifyJobError(text, process.env.MANAGED_GEMINI === "1")`; `noise` dropped, `system` → `failedSystem`, `byok|quota` → `failedCustomer`; bucket by `COALESCE(finishedAt, updatedAt)`. Previous period = the same queries shifted by `days`. Secondary: `Notification WHERE type='ERROR_SYSTEM'` count, `TelemetryEvent WHERE name='frontend_error'` count (current window). North Star: latest `NorthStarDailySnapshot` + the row whose `snapshotDate` is 30 days earlier (delta `null` if absent). Queue: `renderJob.count({ where: { status: "QUEUED" } })`, `videoJob.count({ where: { status: "queued" } })`. Tickets: `supportTicket.count({ where: { status: "OPEN" } })`. Disk: `readDisk("/")`.

- [ ] **Step 0: Literal check.** Read the exact string literals from `prisma/schema.prisma` comments and the writing call-sites before writing a query: `RenderJob.type` (`RENDER`/`BURN`), `RenderJob.status` (`QUEUED`/`DONE`/`FAILED`), `VideoJob.status` (lowercase `queued`/`done`/`failed`, written in `src/lib/mcp/video-job.ts`), `Notification.type` (`ERROR_SYSTEM`), `TelemetryEvent.name` (`frontend_error`, written in `src/components/telemetry/telemetry-provider.tsx`), `NorthStarDailySnapshot` columns (`snapshotDate`, `activeCreators`, `activePayingCustomers`). If any differs, stop and report — a wrong literal renders an all-zero chart, not an error.
- [ ] **Step 1: Failing tests.** `verify-job-failure-class`: 6 fixtures (superseded → noise; quota text → quota; 429 with managed=true → system, managed=false → byok; provider-key text → byok; unknown → system). `verify-admin-trends`: (a) rows at `2026-09-10T16:59:00Z` (→ `2026-09-10`) and `2026-09-10T17:00:00Z` (→ `2026-09-11`) for each series; (b) one **editor** render (RenderJob RENDER DONE, `parentJobId` null) and one **MCP** video (VideoJob `done` + child RenderJob RENDER DONE + child RenderJob BURN DONE) → `rendersDone = 2`, `exportsDone = 1`; (c) one orchestrated failure (VideoJob `failed` with a system message + its child RenderJob FAILED) → counted **once** in `failedSystem`; one editor failure (RenderJob FAILED, `parentJobId` null, BYOK text) → `failedCustomer = 1`; a superseded failure → not counted; (d) a failed VideoJob with `finishedAt` null and `updatedAt` inside the window → counted; (e) zero-fill, ascending order, previous totals, `days` coercion, `defaultTrendDays(639) === 14`, `defaultTrendDays(640) === 30`. Run both → FAIL.
- [ ] **Step 2: Implement** module + route; make insights import from `job-failure-class.ts` (delete the local copies). **Step 3:** Tests PASS; `verify:admin-insights-revenue` still green; add both scripts to `package.json` + CI. Commit `feat(admin): daily trends API on Bangkok day boundaries`.

### Task C3: Split the old tabs into routes; regroup navigation (Blocked by B1)

**Files:**
- Create: `src/app/(dashboard)/admin/support/page.tsx` (from `admin/page.tsx`: the Support tab JSX, `fetchTickets` + the 15 s visibility-aware poll, reply/close handlers), `admin/storage/page.tsx` (Storage tab JSX, `loadStorageHealth` (B1's `?refresh=1` version), `loadCleanupInfo`, `runCleanup`), `admin/music/page.tsx` (`Music Library` heading block, `loadTracks`, upload/delete), `admin/settings/page.tsx` (`Stripe Payment`, `Plan Configuration`, `Support Email`, `Cost Rates (ต้นทุน)` heading blocks + `loadSettings` and the save handlers). Locate each by its heading string; move code **verbatim** (state, handlers, JSX); fix imports; each page is `"use client"` and uses the same `cardStyle`/tokens. `ManualPaymentPanel` moves to `/admin/revenue` in C4, not here.
- Modify: `src/components/layout/sidebar.tsx` (`adminAdminItems` → the grouped list below, rendered with the existing `SectionLabel`), `src/components/layout/mobile-sidebar.tsx` (same groups, each a collapsible `<details open>` on phone), `src/app/(dashboard)/admin/page.tsx` (remove the moved tabs, the `AdminTab` state and Quick Actions; C2 rebuilds the page)
- Test: `scripts/verify-admin-navigation.ts` (new): every `href` in the groups has a `page.tsx` under `src/app/(dashboard)`; group labels are exactly the five Thai strings; `admin/page.tsx` no longer contains `AdminTab`.

**Navigation (Thai copy; icons from lucide-react already imported in the sidebar):**
```ts
const adminGroups: Array<{ label: string; items: SidebarNavItem[] }> = [
  { label: "ภาพรวม",         items: [{ title: "ภาพรวม",            href: "/admin",           icon: BarChart3, exact: true }] },
  { label: "รายได้",          items: [{ title: "รายได้",             href: "/admin/revenue",   icon: TrendingUp }] },
  { label: "ลูกค้า",          items: [{ title: "จัดการผู้ใช้",       href: "/admin/users",     icon: Users },
                                      { title: "Ticket ช่วยเหลือ",   href: "/admin/support",   icon: Ticket },
                                      { title: "คูปอง",              href: "/admin/coupons",   icon: Tag }] },
  { label: "คุณภาพระบบ",      items: [{ title: "ตัวชี้วัดการใช้งาน", href: "/admin/insights",  icon: Activity },
                                      { title: "คำตัดซับ",           href: "/admin/loanwords", icon: Languages }] },
  { label: "ตั้งค่า & ระบบ",   items: [{ title: "ตั้งค่าระบบ",        href: "/admin/settings",  icon: Settings },
                                      { title: "พื้นที่ดิสก์",        href: "/admin/storage",   icon: HardDrive },
                                      { title: "คลังเพลง",           href: "/admin/music",     icon: Music },
                                      { title: "ประกาศอัปเดต",       href: "/admin/updates",   icon: Megaphone }] },
];
```
- Existing pages `admin/users`, `admin/coupons`, `admin/loanwords`, `admin/updates`, `admin/insights`, `admin/revenue` exist on `main` (verified) — confirm in the worktree before writing the test.
- Any internal link that pointed at an `/admin` tab (grep `"/admin"` in `src/components/layout/notification-bell.tsx`, `src/app/(dashboard)/admin/users/page.tsx`, `src/components/layout/product-update-banner.tsx`, `src/lib/api-error.ts` notification `link`) → point at the new route (`/admin/support` for ticket notifications).

- [ ] **Step 1:** failing `verify-admin-navigation` → **Step 2:** move code, regroup → **Step 3:** PASS; `npm run build`; click through every route in the dev server; the support page polls only while mounted. Commit `refactor(admin): one route per admin task; five Thai menu groups`.

### Task C2: `/admin` overview = North Star + trend cards (Blocked by C1, C3)

**Files:**
- Rewrite: `src/app/(dashboard)/admin/page.tsx` → thin client page (≤ 150 lines) rendering the components below
- Create: `src/app/(dashboard)/admin/_components/overview/NorthStarHeadline.tsx`, `TrendCards.tsx`, `TrendBarChart.tsx` (inline SVG, no library), `TodayStrip.tsx`, `HealthPills.tsx`
- Read only: `src/app/api/admin/stats/route.ts` (unchanged; `/admin/revenue` keeps using it)
- Test: `scripts/verify-admin-overview.ts` (new): source-level — `admin/page.tsx` and `_components/overview/**` fetch only `/api/admin/trends`; none of the strings `"/api/admin/storage"`, `"/api/admin/settings"`, `"/api/admin/music"`, `"/api/admin/cleanup"`, `"/api/admin/support?"`, `"/api/admin/stats"`, `MRR`, `จ่ายจริง (จ่ายเงินสด)` appear; `defaultTrendDays` (C1) is imported and called inside a `useEffect` (not during render); render `TrendCards` with a fixture `AdminTrends` and assert the four card titles and the `—` fallback.

**Copy (Thai, production asset):**
- H1: `ภาพรวมวันนี้` · sub: the Bangkok date, e.g. `วันจันทร์ 14 ก.ย. 2569`
- North Star card title: `ลูกค้าจ่ายที่กลับมาสร้างคลิป (MAPC)` · value `activeCreators` · sub `จาก {activePayingCustomers} คนที่จ่ายอยู่ · {rate}%` where `rate = activePayingCustomers > 0 ? Math.round(100 * activeCreators / activePayingCustomers) : null`, rendered `—` when `null` or when `northStar` is `null` (then the whole card shows `ยังไม่มี snapshot`) · delta chip `▲ +3 เทียบ 30 วันก่อน` / `▼ −2 …` / `— ยังไม่มีข้อมูลเทียบ` · footnote `อัปเดตทุกคืน 00:15 · นิยาม: จ่ายแบบต่ออายุ + สร้างงานสำเร็จอย่างน้อย 1 ชิ้นใน 30 วัน`
- Trend cards (4, in this order): `สมัครใหม่/วัน` · `สร้างคลิป/วัน` (legend `เรนเดอร์สำเร็จ` violet, `ส่งออกสำเร็จ` violet-light, `ล้มเหลว` red overlay; footnote `สำเร็จนับต่อไฟล์ที่เรนเดอร์ · ล้มเหลวนับต่องาน (งาน 1 ชิ้นล้มครั้งเดียว)`) · `จ่ายจริง/วัน` (footnote `นับจำนวนครั้งที่จ่าย ไม่ใช่ยอดเงิน — ยอดเงินดูที่ รายได้`) · `งานล้มเหลว/วัน` (legend `ฝั่งเรา` red, `ฝั่งลูกค้า` amber; footnote `ฝั่งลูกค้า = คีย์/เครดิตของลูกค้า หรือชนเพดานแผน`). Each card header: total current window, `เทียบ {days} วันก่อน {±n} ({±p}%)` (`p` rendered `—` when the previous total is 0). One toggle `14 วัน · 30 วัน` for all four; state initialised to `30`, then set to `defaultTrendDays(window.innerWidth)` inside a `useEffect` on mount (client components are still prerendered on the server — `window` must never be read during render).
- Today strip: `วันนี้ · สมัคร {n} · เรนเดอร์ {n} · ส่งออก {n} · จ่าย {n} · ล้มเหลว {n}` (last element of `series`)
- Health pills: `Ticket ค้าง {n}` → `/admin/support` · `ดิสก์ {p}%` (`—` when null) → `/admin/storage` · `คิวเรนเดอร์ {renderQueued + videoJobsQueued}` · `แจ้งเตือน error ระบบ {n} ({days} วัน)` with tooltip `นับจาก notification ERROR_SYSTEM (รวมซ้ำทุก 5 นาทีต่อ route) และ frontend_error {n}`
- Loading: skeleton bars; error: `โหลดแนวโน้มไม่สำเร็จ · ลองใหม่`

**Chart spec (use the `dataviz` skill when building `TrendBarChart`):** one SVG per card, responsive `viewBox`, one bar per day for the current window; hover/tap tooltip `จ 14 ก.ย. · เรนเดอร์ 12 · ส่งออก 9 · ล้มเหลว 1`; y-axis 3 gridlines with integer labels; x-axis label every 7th day (`14 ก.ย.`); colours: primary `#8B5CF6`, secondary `#B9A6FF`, failure `#EF4444`, customer-side `#F59E0B`, grid `var(--ui-card-border)`; `role="img"` + `aria-label` summarising totals; no animation.

- [ ] **Step 1:** failing `verify-admin-overview` → **Step 2:** build components → **Step 3:** PASS; `npm run build`; dev-server check at Mac width and 390 px (initial 14 days). Add one row per new `/admin` number to the A4 table (definition = the C1 query). Commit `feat(admin): overview page answers "how is today going"`.

### Task C4: Money lives on `/admin/revenue`; insights keeps activation, loses money (Blocked by C3)

**Files:**
- Modify: `src/app/(dashboard)/admin/revenue/page.tsx` (5 lines → page composing, top to bottom: the four stat cards `จ่ายจริง (จ่ายเงินสด)`, `Trial (ทดลอง)`, `Comped (แจกสิทธิ์)`, `MRR (รายได้/เดือน)` moved verbatim from `admin/page.tsx` fed by `/api/admin/stats`; `<CostMarginPanel days={days} />` moved from insights with its own `days` control (30 default); `RevenueGrowthDashboard`; `ManualPaymentPanel`)
- Modify: `src/app/(dashboard)/admin/insights/page.tsx` — delete the line `<CostMarginPanel days={days} />` (section 1) and its import; in section 2 keep the activation headline (`{signups} สมัคร → {completedFirstVideo} …`) but delete the three-chip grid (`จ่ายจริง` / `Trial` / `Comped`), the `payingCanceling`/MRR warning paragraph, and the footnote that starts `หมายเหตุ: "จ่ายจริง"`; rename the section label from `North Star · Activation` to `Activation (คลิปแรกออก)` (CONTEXT.md: Activation; North Star is MAPC)
- Not modified: `src/app/api/admin/insights/route.ts` (its payload stays byte-identical in this task; pruning unused revenue fields is a follow-up)
- Test: `scripts/verify-admin-insights-revenue-clarity.ts` keeps passing unchanged (it reads `cost-margin-panel.tsx`, which does not change); new `scripts/verify-money-only-on-revenue.ts` (source-level): `admin/insights/page.tsx` and `admin/page.tsx` contain none of the exact strings `MRR (รายได้/เดือน)`, `จ่ายจริง (จ่ายเงินสด)`, `Comped (แจกสิทธิ์)`, `CostMarginPanel`; `admin/revenue/page.tsx` contains all four.

- [ ] Steps: failing test → move → PASS; `verify:revenue-growth` green; commit `refactor(admin): revenue is the only money page (ADR 0062)`.

### Task C5: Number-accuracy fixes (list written at Gate A from A4; ≤ 6; high-assurance)

**Files:** per fix. **Test:** one `scripts/verify-admin-number-<slug>.ts` per fix, each encoding the agreed definition as SQL against a temp DB with fixtures that straddle the Bangkok midnight and each cohort boundary.

Pre-registered suspects (A4 confirms or clears each): `todayStart`/`weekStart` computed with `setHours(0,0,0,0)` in server TZ (`src/app/api/admin/stats/route.ts:15-20`); `totalVideos = prisma.video.count()` vs delivered renders; MAPC snapshot staleness when the `north-star-snapshot` cron misses a night; MRR from `Payment.amount` anywhere outside `revenue-cash.ts`; funnel double counting between VideoJob and telemetry.

**Chosen fixes** (written by the session 2026-09-12 from A4 §9; each is one PR with its own verify script; **awaiting Mew's yes at Gate A** because every one changes a number Mew reads):

1. **`จ่ายจริง` = cash only** — `revenue-cohorts.ts` requires `amount > 0` for cash evidence (the North Star already does) → 39 becomes 28 and the two figures on `/admin/revenue` agree. Verify: a PRO user whose only `Payment` is ฿0 is excluded from `payingTotal`.
2. **MRR never falls back to list price** — `computeRevenueCohorts` contributes 0 for a payer with no `monthlyRevenueByUser` entry → removes ฿6,389.33 of fiction from MRR, `prepaidMrr`, `deferredRevenue`, margin, break-even. Verify: the ฿0 fixture contributes 0 to every derived figure.
3. **Bangkok day boundaries in code** — `admin/stats` `newToday`/`newThisWeek` (true 7-day window) and `costs/route.ts` `dateLabel` use the existing `bangkokDate()` helper. Verify: fixtures at 16:59 Z / 17:00 Z straddle the boundary. *Ops half for Mew's hand (not code):* the north-star cron fires 07:15 Bangkok, not 00:15 — change `cron_restart` (`15 17 * * *`) or set `TZ` on the cron app; both are `ecosystem.config.js` edits outside this plan's code tasks.
4. **Bound the insights telemetry queries** — replace the `take: 20_000` sample (102,501 rows in 30 d; previous window unordered) with server-side aggregation per window, or at minimum `orderBy` on both windows plus a `truncated: true` flag the UI renders. Verify: 25,000 fixture rows → counts equal the full-window truth. Also fixes cause 5 (826 ms).
5. **One money source in `CostMarginPanel`** — stop counting ฿0 `Payment` rows in `newPayers`/`repeatPayers`; label the internal ledger explicitly as ledger (Stripe truth stays on `/admin/revenue`, ADR 0062). Verify: ฿0 fixture excluded; label string present.
6. **Definitions cluster (one PR)** — "Video completed" tile and Health Score video terms read `VideoJob` (since `Video` is 100 % `COMPLETED` by construction); add `canceled` to `jobOutcomes`; remove the dead `เนื้อหาทั้งหมด` card and `Styles` tile. Verify: fixtures with canceled jobs are counted; the removed strings are absent.

Deferred with reason (report §3.9, one row each): #79/#80 funnel create+export mix and #101 BURN in the render counter (surface rebuilt by C1, pruned in the insights follow-up); #102 "active creators" definition (Growth term → Mew); #116 dead `usageCount`/`usageLimit` in `/api/user/me` (with B3 if the reviewer clears it); #55, #84, #98 definition duplicates (A5 umbrella). MAPC denominator — the shipped number is exact; CONTEXT.md:202 wording is reconciled in C6 instead, and the numerator tightening (`Script` drafts, `Video.updatedAt`) is a **North Star definition change → Mew decides** separately. Three "internal team" rules, 300 vs 365-day thresholds, `failAfterHours` 3 vs 24 — follow-up issue (A5 umbrella).

- [ ] Steps per fix: failing verify → fix → PASS → commit `fix(admin): <number> means <definition>`.

### Task C6: Docs and closure (mew-worker-mech)

**Files:**
- Modify: `CLAUDE.md` "Key directories" line for `(dashboard)/admin` (new routes; remove the nonexistent `src/components/remotion/` mention; Next.js version line) + a one-line pointer to ADR 0062; `docs/audits/2026-09-12-performance-audit.md` §8 (Gate B + 7-day watch numbers, `/admin` re-measured after D5); `docs/ops/linear-sentry-observability.md` gains a paragraph "The daily error card on /admin counts ERROR_SYSTEM notifications and frontend_error telemetry; Sentry stays the evidence source".
- [ ] Steps: edit → `npm run verify:sentry-config` still green (doc-only) → commit `docs(admin): record the admin re-organisation and the audit outcome`.

---

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| A1 | Production measurement (read-only) | mew-worker-heavy | subagent | — | session (audit trail complete, no customer identity) |
| A2 | Browser measurement, 5 pages | mew-worker | subagent | — | session |
| A3 | Code audit + render read-only review | mew-worker-heavy | subagent | — | session |
| A1b | Query plans on production | mew-worker | subagent | A1, A3 | session |
| A4 | Number-accuracy audit | mew-worker-heavy | subagent | A1, A2 | session; critic vs CONTEXT.md definitions |
| A5 | 14-day error summary + Linear drafts | mew-worker-heavy | subagent | A1 | session (no `--apply`) |
| A6 | Audit report + 🛑 Gate A | (session model) | inline | A1–A5, A1b | mew-critic + mew-reviewer `model: opus` under ultracode |
| B1 | Storage-health cache (+ export `readDisk`) | mew-worker | subagent | Gate A | build+test, code review |
| B2 | SiteConfig batch read | mew-worker | subagent | Gate A | build+test, code review |
| B3 | Auth hot-path query diet | mew-worker-heavy | subagent | Gate A, A3 | build+test, code review (opus), security review |
| B4 | Font scoping | mew-worker | subagent | Gate A, A3 | build+test, code review, computed-font check |
| B5 | Updates summary once | mew-worker | subagent | Gate A | build+test, code review |
| B6 | DB-contention remedy (chosen rows) | mew-worker-heavy | subagent | Gate A, A1b (+ Mew's VACUUM if chosen) | build+test, code review (opus), 24 h prod count per row |
| B-gate | Re-measure + 🛑 Gate B | (session model) | inline | B1–B6 deployed | session; report §8 |
| C1 | Trends API + Job Failure Class module | mew-worker-heavy | subagent | Gate A, B1 | build+test, code review |
| C3 | Route split + navigation | mew-worker | subagent | B1 | build+test, code review, click-through |
| C2 | Overview page + trend cards | mew-worker | subagent | C1, C3 | build+test, code review, visual (Mac + 390 px) |
| C4 | Revenue consolidation | mew-worker | subagent | C3 | build+test, code review |
| C5 | Number-accuracy fixes | mew-worker-heavy | subagent | A4, Gate A | build+test, code review (opus) |
| C-gate | Re-measure the new `/admin` after D5 (A2 Step 1 method, Mew present in Chrome) → report §8 | (session model) | inline | D5 deployed | session |
| C6 | Docs + closure | mew-worker-mech | subagent | C-gate, 7-day watch | session |

Deploy sequencing (Mew deploys, one message per deploy): **D1** = B1+B2+B4+B5 (one or two PRs) → measure 24 h; **D2** = B3; **D3.1…D3.n** = one B6 row per deploy, 24 h apart; **D4** = C1+C3+C2; **D5** = C4+C5. Never mix a Phase B DB change with a Phase C UI change in one deploy. **If no B6 row is chosen, "after D3.n" means "after D2"** and AC3's 7-day window starts the day after D2.

## Acceptance Criteria
- [ ] `docs/audits/2026-09-12-performance-audit.md` exists with the Thai 2-minute summary, sections 1–9 (§8 before/after filled at Gate B and after the 7-day watch), and every production command listed verbatim; no customer identity and no screenshots anywhere in `docs/plans/reports/` or the audit.
- [ ] Measured with the A2 method (Mac Chrome, office network, warm session, 3-run median): **after D3.n** — `/dashboard` ≤ 1.5 s, `/videos` ≤ 1.5 s, `/admin/insights` ≤ 2.5 s, `/video-editor` open ≤ 3.0 s; **after D5** — the new `/admin` overview ≤ 2.0 s usable (the old `/admin` after D3.n is recorded for reference only). APIs in A2 Step 2: **warm** calls (runs 2–20) median < 350 ms and max < 500 ms; the cold first call of `/api/admin/storage`, `/api/admin/cleanup` and `/api/admin/insights` is recorded in §8 as a known cost that `/admin` no longer pays (ADR 0062), not judged against the threshold. If `/video-editor` misses only because of JS size (A3 §A3.5), the miss is recorded and code-splitting is filed as a follow-up plan — not silently absorbed here.
- [ ] Production logs for 7 consecutive days after D3.n: `[prisma-slow-tx]` held ≥ 5 000 ms = 0/day and `Socket timeout` = 0/day in `ai-content`; `P1008` = 0/day in every PM2 app. A residual class whose holder lies outside the chosen B6 rows is recorded in report §8 with its holder and filed as a follow-up — it does not block closure, but it is never hidden.
- [ ] No PR in this plan touches `ecosystem.config.js` render/stock env objects, `src/lib/run-render.ts`, `src/remotion/**`, or ffmpeg arguments (reviewer checks the diff file list).
- [ ] Error summary table covers Sentry + PM2 + tickets + `frontend_error` for the 14 days ending the day A5 runs; every row carries an Error Source Class and แก้ / เฝ้าดู / noise; the HERO-10 reopen comment + umbrella issue JSON exist under `docs/plans/reports/linear-drafts/`; nothing was applied to Linear.
- [ ] Number-accuracy table covers every number on the pre-change `/admin`, `/admin/revenue`, `/admin/insights`, `/dashboard`; each mismatch is fixed by a C5 verify-backed change or explicitly deferred with a reason in the report; the new `/admin` numbers each have a row added at C2 time whose definition is the C1 query and whose proof is `verify-admin-trends`.
- [ ] Admin navigation shows exactly the five Thai groups and eleven items of Task C3; every former tab is reachable at its new URL; `verify-admin-navigation` green.
- [ ] `/admin` overview issues no request to storage/settings/music/cleanup/support-list/stats endpoints (`verify-admin-overview` green) and renders the MAPC headline, four trend cards, today strip and health pills with the exact Thai copy of Task C2; the 14/30 toggle works; initial 14 days under 640 px via `defaultTrendDays`.
- [ ] `verify-admin-trends` proves Bangkok day buckets, zero-fill, previous-period totals, the Job Failure Class split, that every `RenderJob` success row counts once (children included), and that an orchestrated failure counts once.
- [ ] The exact money labels (`MRR (รายได้/เดือน)`, `จ่ายจริง (จ่ายเงินสด)`, `Comped (แจกสิทธิ์)`) and `CostMarginPanel` appear only in `admin/revenue/page.tsx` (`verify-money-only-on-revenue` green); insights has no money chips and its section label reads `Activation (คลิปแรกออก)`.
- [ ] CI green on every PR; every new `verify:*` script is in `package.json` and `.github/workflows/ci.yml`; B3/B6/C5 reviewed on `model: opus`, `security-review` run for B3; B3's five-fixture golden test proves outcome equality.
- [ ] Mew's sign-off on prod after D5: "ไม่ง่วง" on the four pages and the trend cards answer "สมัครเพิ่ม → ใช้จริงเพิ่มไหม" at a glance.

## Out of scope
- Render tuning of any kind (concurrency, presets, JPEG, cache) — Q1(e) declined; the pipeline is reviewed read-only (A3 Step 7) and reported in §6 only.
- Code-splitting the 5,276-line `video-editor` and 4,170-line `video-creator` pages — measured in A3/A2; if it is the reason the editor misses 3 s it becomes its own plan.
- Postgres migration, Redis/BullMQ, Remotion Lambda, a second box — scale-ladder rungs 3–4 (`docs/scale-upgrade-plan.md`), not a page-load problem.
- Sentry API automation and an nginx `$request_time` log format — both need production config changes outside the read-only rule; proposed as follow-ups in the report.
- Pruning the insights API payload after C4 — follow-up.
- Applying anything to Linear, replying to or closing support tickets — each needs Mew's explicit request under `hero-studio-ops`.
- A mobile-first redesign of admin beyond collapsible groups and the 14-day default.
- Deleting stale `prisma/dev.db.*` backups on prod — Mew's hand, listed in the report.

## Status
interviewed 2026-09-12 | approved: 2026-09-12 (Mew: "execute", overnight run) | executed: 2026-09-12 (Phase A complete; 🛑 Gate A presented 2026-09-12, awaiting Mew on B6 rows 2–3 + C5 fixes) | delivered: -
