# Ops Guardrails Runbook (PR-4)

Prod box: Hostinger VPS — `ssh -i ~/.ssh/hostinger_heroai_codex root@72.62.196.230`
App dir: `/var/www/ai-content` · PM2 app: `ai-content`

> Policy: confirm with the team (Mew/wao) before SSHing into prod; run heavy
> steps off-peak. These steps are config-only and independent of any deploy.

## 1. pm2-logrotate (50MB × 5, compressed)

Why: the PM2 error log reached 414MB / 9.7M lines (2026-06-10 audit) —
unbounded logs eat the same disk renders need and make `pm2 logs` unusable.

Run on the VPS:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 5
pm2 set pm2-logrotate:compress true
pm2 save
```

`pm2 save` persists the module and its settings across reboots; installing the module briefly restarts only the logrotate worker — no impact on `ai-content`.

Verify:

```bash
pm2 conf pm2-logrotate
```

Expected: output like `$ pm2 set pm2-logrotate:max_size 50M`, `$ pm2 set pm2-logrotate:retain 5`, `$ pm2 set pm2-logrotate:compress true` (pm2 prints settings as `pm2 set` lines). If any of those three shows a different value, re-run the corresponding `pm2 set` command above.

The rotation worker checks sizes on each tick (default every 30s), so the existing oversized logs get rotated into compressed archives almost immediately. Confirm:

```bash
ls -lh /root/.pm2/logs/ | head -20
du -sh /root/.pm2/logs/
```

Expected: every live `*.log` is under 50M; `*.log.gz` archives appear
(at most 5 retained per log).

## 2. SQLite WAL (one-time per DB file)

Why: WAL lets readers and one writer coexist — required before the Phase 2
render worker shares `prisma/dev.db` with the web process (spec §5 PR-4,
§12). `journal_mode=WAL` is persistent (stored in the DB file); set it once
per DB file. `busy_timeout` is per-connection and is set in code
(`src/lib/prisma.ts`), not here.

Run on the VPS (`ssh -i ~/.ssh/hostinger_heroai_codex root@72.62.196.230`):

```bash
command -v sqlite3 >/dev/null || apt-get install -y sqlite3
sqlite3 /var/www/ai-content/prisma/dev.db "PRAGMA journal_mode=WAL;"
```

Expected output:

```
wal
```

If it prints `Error: database is locked`, a write was in flight — retry
off-peak (the switch needs a moment with no active write lock).

Verify it stuck and sidecar files exist:

```bash
sqlite3 /var/www/ai-content/prisma/dev.db "PRAGMA journal_mode;"
ls -lh /var/www/ai-content/prisma/ | grep dev.db
```

Expected: `wal`; `dev.db-wal` / `dev.db-shm` appear next to `dev.db` after the first write (SQLite creates them lazily and removes them when the last connection closes cleanly) (all
`prisma/*.db*` paths are gitignored, so `git pull` never touches them).

## 3. Permanent media quarantine purge

Permanent purge deliberately rebuilds the complete media reference graph immediately
before every file unlink. This closes the race where a live database reference is added
after the batch review or purge-intent write, at the cost of one complete reference scan
per purged file. Run purge only as an explicitly approved, off-peak maintenance command;
do not put it in the regular cleanup cron:

```bash
npx tsx scripts/media-cleanup.ts --purge-quarantine
```

Keep quarantine apply and the normal scheduled cleanup in dry-run until the rollout gates
are approved. One purge invocation processes the mature set it discovers sequentially; it
does not currently expose a record limit. Do not start a large backlog unless the maintenance
window can cover the full run, and do not interrupt it merely to bound runtime because a
crash-left operation lock requires validated manual recovery. Stage quarantine apply volume
ahead of time, then monitor the sanitized `scanned`, `purged`, `skipped`, and `errors` tallies
after each approved purge. Any incomplete graph, new live reference, original-path collision,
unsafe hierarchy, or fingerprint change fails closed and preserves the quarantined copy.
