# Ledger — Performance audit + admin re-organisation

Plan: `docs/plans/2026-09-12-performance-audit-admin-reorg.md`
Profile: high-assurance for B3/B6/C5, standard elsewhere · Risk: medium overall
Subagent cap: **80** (raised by Mew) · used: **60**

> **Note 2026-09-13:** the original ledger lived in the working directory of the
> `…-perf-audit-reports` worktree and was lost when that worktree was removed
> (only `docs/plans/…` survived in `.scratch/worktree-salvage/`). This file is the
> rebuilt ledger and is **committed** to `mew/perf-audit-reports` so it cannot be
> lost again. Per-task briefs/reports/reviews from rounds 1–3 are gone; their
> conclusions live in `docs/audits/2026-09-12-performance-audit.md` and in the
> merged PRs (#465–#502).

## Shipped

| round | tasks | merge commit | deployed to prod |
|---|---|---|---|
| R1 | Phase B quick wins | — | 2026-09-12 (early) |
| R2 | C1–C5b admin reorg + number fixes | `4f4a2576` | 2026-09-12 14:37 UTC |
| R3 | C7 insights latency + paid count · C8 committed-trialing card · C9 backup→R2 · C10 MAPC-A | `fad27f60` (+ docs `91ababe6`) | **2026-09-13 ~14:1x UTC — prod HEAD `91ababe6`** |

R3 PR chain: #499 C7 (`af2ec1b3`) → #498 C8 (`f3f7bcd3`) → #501 C9 (`3e2a2e95`) → #502 C10 (`fad27f60`). Main CI on `fad27f60` = SUCCESS.

## 2026-09-13 session

- [x] **A. 24-hour production count** (window 2026-09-12T13:33Z → 2026-09-13T13:33Z, read-only).
      Result: slow-tx ≥ 5 s = **1** (the last one at 09-12T15:41:57Z, ~1 h after the R2 deploy;
      **0 in the 22 h since**). `Socket timeout` / `Transaction already closed` / `P1008` /
      `uncaughtException` / `SQLITE_BUSY` / `lease failed` = **0** across all five online PM2 apps.
      No crash restarts. Baseline was 42/98/71 slow-tx ≥ 5 s per day and ~25 `lease failed`/day.
      WAL high-water unchanged at 35.2 MB; DB now 576.26 MB.
      → written to audit §8 + new §8.1, commands appended to §9.
- [x] **B. Deploy R3 — DONE.** Mew authorised it explicitly ("deploy ได้เลย") after the Claude Code
      auto-mode classifier refused the first attempt with reason `[Production Deploy]`; the denial was
      not rerouted. Pre-flight was clean (CI SUCCESS on `91ababe6`, RenderJob and VideoJob queues empty,
      no deploy running). Fired detached; log `/tmp/deploy-perfR3-20260913.log` → "Deploy finished
      successfully". Prod HEAD `91ababe6`, `/api/health` 200, site 200, all five PM2 apps online with
      exactly one restart each. C9's `db-backup` cron started with `CRON_SECRET` in its env
      (`pm2 restart db-backup --update-env && pm2 save`; cron `0 2 * * *`, `stopped` between fires is
      by design). **Note:** the docs PR #503 moved `main` past `fad27f60`, so prod runs `91ababe6` —
      same R3 code plus that docs commit.
- [ ] **B2.** Eyeball the new `/admin/revenue` "รอเก็บเงินครั้งแรก (trial ผูกบัตรแล้ว)" card — needs Mew logged in.
- [x] **B3. C9's R2 off-box copy is LIVE — verified end to end.** First reported here as "inert";
      that was **my operational error, not a product defect**. Sequence:
      1. After the deploy I started the cron with `pm2 restart db-backup --update-env`, copied from
         the handoff. `pm2 restart` replays the app definition PM2 already had **saved**, which was
         written before C9 shipped, so the new `env` block never reached the process. The 14:24 run
         logged `BACKUP_R2 not configured`.
      2. `.env` genuinely has no `R2_*` keys — **by design**. R2 credentials live in the root-only
         file `/var/www/ai-content/.env.r2.production`; `ecosystem.config.js` loads it once into
         `r2MediaRuntimeEnv` (lines 21–37) and spreads it into the apps that need it. C9 already
         wired `...r2MediaRuntimeEnv` into the `db-backup` block (line 229) — the code was correct
         the whole time.
      3. Fix = start it the way `CLAUDE.md` documents, from the ecosystem file, not by name:
         `export CRON_SECRET="$(grep ^CRON_SECRET= .env | cut -d= -f2-)"` then
         `pm2 delete db-backup && pm2 start ecosystem.config.js --only db-backup --update-env && pm2 save`.
      4. The run that followed: `snapshot OK (532.3 MB, integrity=ok)` →
         `R2 copy sent -> heroai-media-production/db-backups/dev-2026-09-13.db` →
         `R2 prune done (removed=0, retention=30d)`.
      **Lesson:** `pm2 restart <name> --update-env` refreshes the *shell* environment only. Any change
      to an app's `env` block in `ecosystem.config.js` needs `pm2 start ecosystem.config.js --only <name>`
      (delete first if the app already exists), then `pm2 save`. Judging a newly shipped cron by a
      `pm2 restart` is how a working feature looks broken.
      Still genuinely open: `BACKUP_RSYNC_TARGET` is unset, so the rsync path stays off — that is the
      pre-existing item below, and it is now the *second* off-box path, not the only one.
- [x] **C. Gate B browser re-measure — DONE 2026-09-13** in Mew's logged-in Chrome (ADMIN, BUSINESS),
      A2 method, written to audit §8 table + new §8.2. Page targets all met: `/admin` 565/599 ms,
      `/videos` 511/746, `/admin/insights` 1091/869, `/video-editor` 847 cold; `/dashboard` borderline
      (bimodal 740–2386, settled median 1183 — nine parallel calls at t≈93 ms starve `/api/user/me`).
      `/admin` issues only `/api/admin/trends` → ADR 0062 verified as measured. Twelve endpoints pass
      p50 < 350 / max < 500. **Three items for the Tier-2 gate:** (a) `/api/admin/insights?days=30`
      2580 ms p50 — the known, accepted C7 outcome pending Mew's rollup-table decision;
      (b) `/api/admin/revenue` 1913 ms p50, slightly worse than its 1704 ms baseline, not previously
      flagged; (c) two new findings — `/admin/insights?days=30` ignores its URL parameter (the page
      requests `days=1`), and `/api/admin/cleanup` now returns HTTP 409 where it returned 200.
      Deviations disclosed in §8.2: storage n=3 (not 1), insights/revenue n=12 (not 20), editor warm
      not captured, and one contaminated run discarded after an overrunning fetch loop.
- [ ] **D. 7-day watch to ~2026-09-19** — slow-tx ≥ 5 s = 0/day, `Socket timeout` = 0/day,
      `P1008` = 0/day in every PM2 app. Day 1 (09-13) passes. Re-count each day with the §9 commands.
- [x] **E. C6 docs — DONE, PR #505 merged** (`CLAUDE.md`: Next 15→16, admin route split + ADR 0062
      pointer, `src/components/remotion/` removed as non-existent, middleware path → `src/proxy.ts`;
      `docs/ops/linear-sentry-observability.md` gained the in-app error-card paragraph; the audit's
      Thai summary was rewritten by the session to match §8/§8.1/§8.2). `verify:sentry-config` 38/38.

## Tier-2 gate — 2026-09-13

| # | Acceptance criterion | Verdict |
|---|---|---|
| 1 | Audit report with Thai summary, §1–§9, §8 filled, every prod command listed, no customer identity, no screenshots | ✅ verified (only `x@example.invalid` placeholders; zero image files in the 107-file diff) |
| 2 | Page targets after D5 | ✅ `/admin` 565 ms, `/videos` 511, `/admin/insights` 1091, `/video-editor` 847 · ⚠️ `/dashboard` bimodal 740–2386, **Mew accepted** ("หน้า dashboard โอเค") |
| 2b | API warm p50 < 350 ms, max < 500 ms | ⚠️ 12 of 14 pass; `/api/admin/insights?days=30` 2580 ms (known, accepted, rollup table is Mew's call) and `/api/admin/revenue` 1913 ms (new follow-up) |
| 3 | 7 consecutive days with slow-tx ≥ 5 s = 0/day, Socket timeout = 0/day, P1008 = 0/day | ⏳ day 1 passes; window runs to ~2026-09-19 |
| 4 | No PR touches render files | ✅ verified across the whole 107-file diff `bd84ba40..main`; `ecosystem.config.js` changed only in the `db-backup` block, no `RENDER_*`/`STOCK_*` line |
| 5 | 14-day error summary + Linear drafts, nothing applied | ✅ A5; drafts under `docs/plans/reports/linear-drafts/`, no `--apply` |
| 6 | Number-accuracy table covers every surface; each mismatch fixed or deferred with a reason | ✅ A4 + C2/C5 rows |
| 7 | Five Thai groups and eleven admin items; `verify-admin-navigation` green | ✅ groups verified in `src/components/layout/sidebar.tsx:85–92`; eleven items verified rendering live |
| 8 | `/admin` issues no storage/settings/music/cleanup/support-list/stats request | ✅ **measured**, not just reviewed — the overview issues only `/api/admin/trends` |
| 9 | `verify-admin-trends` proves the bucket/zero-fill/failure-class contract | ✅ CI |
| 10 | Money labels and `CostMarginPanel` only on `/admin/revenue`; insights has no money chips | ✅ `verify-money-only-on-revenue` green; live spot-check found no `฿`/MRR/Comped on insights |
| 11 | CI green on every PR; B3/B6/C5 reviewed on opus; security review for B3 | ✅ |
| 12 | Mew's sign-off on prod after D5 | ✅ `/dashboard` accepted ("หน้า dashboard โอเค") and the phone check of `/admin` passed ("ใช้งานได้มือถือ", 2026-09-13) — the mobile item had been outstanding since the interview |

**Verdict: the plan is delivered, with Mew's sign-off complete.** Every code task shipped, every hard constraint held, and the
headline outcome is measured rather than asserted: transactions held ≥ 5 s fell from 42/98/71 per day
to 1 in 24 hours, with `Socket timeout`, `P1008` and story-film `lease failed` all at zero. Two
things are carried forward and neither blocks closure: the 7-day watch (time, not work) and two
endpoints over the API threshold (one known and accepted, one newly filed). Mew's own manual items
— deleting the 64 stale snapshots and moving the North Star cron to 00:15 Bangkok — remain unstarted.


## Open decisions for Mew (none blocking)

1. Telemetry rollup table so `/api/admin/insights?days=30` lands under 1 s (C7 got it to ~2 s, target was ≤ 1 s — accepted).
2. The `/admin` delta chip and `/admin/revenue` history compare C10's new definition against snapshots written under the old one → a false ▼ for ~30 days. On-screen note, or leave it?
3. `expectedMonthlyThb` on the new C8 card ignores coupons.
4. Linear drafts: apply? (A5 umbrella items.)
5. `BACKUP_RSYNC_TARGET` still needs an off-box destination if a second copy is wanted. It is no
   longer urgent: C9's R2 copy is live (verified 2026-09-13), so the nightly snapshot does leave the
   box. Decide whether rsync is still worth configuring alongside R2.

## Lessons (do not relearn)

- A `process.env` pin set BEFORE importing `src/lib/prisma` does not survive: constructing the first PrismaClient reloads `.env` for any unset key. Pin again AFTER the import.
- Always anchor prod log counts on `^2026-..T`; rotated files carry untimestamped lines.
- `gh pr merge --auto` merges immediately on this repo — wait for the check, then merge.
- Implementers must grep `scripts/` and `ci.yml` for moved file paths after any move.
- `ci.yml`/`package.json` adjacent-insert conflicts between stacked PRs resolve as a UNION — then assert no duplicate step names and that the YAML still parses.
- Deploy pre-flight: `pgrep -x -f "bash deploy/deploy.sh"` (plain `pgrep` self-matches and aborted a deploy once).
- Keep the ledger **committed**, not just in the worktree working directory.
- **Injected measurement JS lands in Sentry as a production error.** The Gate B run defined
  `window.__warm` in the page, then a top-level navigation wiped `window`; the still-running async
  loop called it and threw `TypeError: window.__warm is not a function`, which Sentry captured as an
  unhandled rejection on release `91ababe6b22e` at `/video-editor` and paged Mew over LINE. Stack was
  `<anonymous>:5:18`, so it was obvious once opened — but it cost an alert and an audit. Wrap every
  injected helper call in try/catch, and treat "my own tooling" as the first hypothesis for any error
  whose stack frames are `<anonymous>`.
