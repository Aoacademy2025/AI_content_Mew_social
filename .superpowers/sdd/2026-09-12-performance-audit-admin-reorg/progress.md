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
- [!] **B3. C9's off-box copy is INERT on prod — found in the post-deploy check.** The cron ran at
      14:24 UTC and the snapshot itself is healthy (`/var/backups/heroai/dev-2026-09-13.db`,
      532.2 MB, `integrity=ok`), but the log says both
      `BACKUP_RSYNC_TARGET not set` and `BACKUP_R2 not configured — off-box copy NOT configured
      (local backup only)`. Cause: prod `.env` has **no** `R2_*` or `BACKUP_*` keys at all
      (checked by key name only: `cut -d= -f1 .env | grep -iE "r2|backup|cloudflare|s3"` → empty,
      120 keys total). `backupR2ConfigFromEnv` returns `null` on missing/invalid env and the caller
      treats that as "not configured", never as an error — so the run reports success while the
      backup never leaves the box it is backing up.
      To activate C9, prod `.env` needs: `R2_ACCOUNT_ID` (32 hex), `R2_BUCKET` (or
      `BACKUP_R2_BUCKET`), `R2_WRITE_ACCESS_KEY_ID`, `R2_WRITE_SECRET_ACCESS_KEY` (≥ 16 chars),
      optionally `R2_ENDPOINT` and `BACKUP_R2_RETENTION_DAYS` (default 30).
      Also note the local prune runs at `BACKUP_RETENTION_DAYS` **default 14**, not 30 — 30 days is
      the R2 retention only. **Mew's call: supply the R2 credentials, or accept local-only backups.**
- [ ] **C. Gate B browser re-measure** — needs Mew logged in. A2 method; `/api/admin/cleanup`
      and `/api/admin/storage` stay at n=1 (a 20× loop degraded the prod admin API for 2–3 min).
- [ ] **D. 7-day watch to ~2026-09-19** — slow-tx ≥ 5 s = 0/day. Day 1 = today, passes.
- [ ] **E. C6 docs** (CLAUDE.md admin dirs + Next 16 + `src/proxy.ts` + ADR 0062 pointer;
      `docs/ops/linear-sentry-observability.md`; audit §8 final) → Tier-2 gate → deliver.

## Open decisions for Mew (none blocking)

1. Telemetry rollup table so `/api/admin/insights?days=30` lands under 1 s (C7 got it to ~2 s, target was ≤ 1 s — accepted).
2. The `/admin` delta chip and `/admin/revenue` history compare C10's new definition against snapshots written under the old one → a false ▼ for ~30 days. On-screen note, or leave it?
3. `expectedMonthlyThb` on the new C8 card ignores coupons.
4. Linear drafts: apply? (A5 umbrella items.)
5. `BACKUP_RSYNC_TARGET` still needs an off-box destination — and see B3 above: C9's R2 path is
   equally unconfigured, so **right now nothing leaves the box**. The nightly snapshot sits on the
   same disk as `prisma/dev.db`, which is no protection against disk loss.

## Lessons (do not relearn)

- A `process.env` pin set BEFORE importing `src/lib/prisma` does not survive: constructing the first PrismaClient reloads `.env` for any unset key. Pin again AFTER the import.
- Always anchor prod log counts on `^2026-..T`; rotated files carry untimestamped lines.
- `gh pr merge --auto` merges immediately on this repo — wait for the check, then merge.
- Implementers must grep `scripts/` and `ci.yml` for moved file paths after any move.
- `ci.yml`/`package.json` adjacent-insert conflicts between stacked PRs resolve as a UNION — then assert no duplicate step names and that the YAML still parses.
- Deploy pre-flight: `pgrep -x -f "bash deploy/deploy.sh"` (plain `pgrep` self-matches and aborted a deploy once).
- Keep the ledger **committed**, not just in the worktree working directory.
