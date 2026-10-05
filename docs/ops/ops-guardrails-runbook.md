# Ops Guardrails Runbook (PR-4)

Prod box: Hostinger VPS — `ssh -i ~/.ssh/hostinger_heroai_codex root@72.62.196.230`
App dir: `/var/www/ai-content` · PM2 app: `ai-content`

> Policy: confirm with the team (Mew/wao) before SSHing into prod; run heavy
> steps off-peak. These steps are config-only and independent of any deploy.

## 1. HERO-10 PM2 log retention (14-day observation readiness)

Why: HERO-10's closure gate needs fourteen calendar days of timestamped
`[prisma-slow-tx]` lines. `log_date_format` is already set in
`ecosystem.config.js`; this is the separate, operator-applied PM2 retention
step. It is intentionally **not applied by this repository change**.

`pm2-logrotate` retains a count of rotated files, not an age. Production's
read-only September 20 check found `retain=5`, `max_size=50M`,
`compress=true`, daily `rotateInterval`, and `workerInterval=30`. Raising only
`retain` to 14 is the approved minimal change. It does **not** guarantee
fourteen wall-clock days when a file rotates more than once per day; the final
date-coverage check below is the authority. Missing history cannot be
recreated.

Run only in an authorized production maintenance window. First record the
current configuration for rollback:

```bash
pm2 conf pm2-logrotate
pm2 status
```

Apply only the approved retention change on the VPS:

```bash
pm2 set pm2-logrotate:retain 14
pm2 status
```

The installed production PM2 source was read-only verified on September 20:
`CLI.set` writes the namespaced value and calls `restart(app_name,
{ updateEnv: true })`; for this key, `app_name` is `pm2-logrotate`. Only the
logrotate module is therefore restarted, not application processes. Still,
compare `pm2 status` PIDs and restart counters before and after, and stop if
any application counter changes. The command remains an explicit operations
action rather than a deploy side effect.

Verify:

```bash
pm2 conf pm2-logrotate
```

Expected values: `max_size=50M`, `retain=14`, `compress=true`,
`rotateInterval=0 0 * * *`, and `workerInterval=30`. PM2's existing line
timestamps remain the source of Bangkok-day bucketing; rotated filenames must
not be used as day boundaries.

After fourteen elapsed days, check the **oldest timestamp only** in the retained
`ai-content` and `story-film-system-worker` error logs. It must be at or before
the requested fourteen-day observation start. If it is not, the seven-day
HERO-10 closure window is invalid; increase retention and start a fresh
observation window. Do not infer a holder from file adjacency.

Confirm storage and archive counts without printing application log content:

```bash
du -sh /root/.pm2/logs/
find /root/.pm2/logs -maxdepth 1 -type f \( -name 'ai-content-error*.log*' -o -name 'story-film-system-worker-error*.log*' \) -printf '%f\n' | sort
```

Rollback: `pm2 set pm2-logrotate:retain 5`. This does not restore archives
already pruned; do not apply the change until the retention capacity and disk
budget are accepted.

### Reading `[prisma-slow-tx]` provenance

The marker has this deliberately narrow shape:

```text
[prisma-slow-tx] #<sequence> elapsed <milliseconds>ms source=<static-location> kind=interactive queueMs=<milliseconds> ahead=<count> beforeCallbackMs=<milliseconds> callbackMs=<milliseconds> callbackEntered=<0|1>
[prisma-slow-tx] #<sequence> elapsed <milliseconds>ms source=<static-location> kind=batch queueMs=<milliseconds> ahead=<count>
```

`elapsed` is the total Prisma call time. `queueMs` is time spent waiting in
this process's own transaction line (HERO-70, `src/lib/prisma-transaction-queue.ts`)
and `ahead` is how many transactions were in front when it arrived (the holder
plus earlier waiters); both are 0 with `PRISMA_TX_SERIALIZE=0`. A large
`queueMs` means another transaction in the SAME process held the line; a large
`beforeCallbackMs` with a small `queueMs` means the wait was in the engine
(pool, `BEGIN IMMEDIATE`, busy wait — e.g. another process held the writer
lock). Before HERO-70 there was no line and `beforeCallbackMs` included
everything. For interactive transactions,
`beforeCallbackMs` is wall time from leaving the line until Prisma enters the
callback, while `callbackMs` is wall time executing that callback.
`callbackEntered=0` means Prisma returned or rejected before entry (including a
`queueMs` that reached `maxWait`, which rejects with P2028). Array
transactions have no callback boundary and remain total-only. Pre-callback
time can include connection scheduling or SQLite transaction acquisition, and
callback time can include database waits during callback queries; neither is a
write-lock hold duration. `source` identifies the invocation, not a proven lock
holder. Group source values during a slow window, compare them with
same-timestamp timeout failures, and treat a repeated source as an
investigation candidate only.

The logger keeps `src/...:line:column` or `scripts/...:line:column` when that source frame is
available. In a Next production bundle it reduces
`.next/server/app/.../route.js:line:column` to `app/.../route.js:line:column`; map that exact
generated location through the source map from the deployed Git revision. Unknown or chunk
frames stay `unknown` rather than logging an absolute path, function arguments,
SQL, model names, or row data. An `unknown` source means the release did not
provide a stable application frame and requires another discriminating probe;
it is not evidence against any route.

### In-process transaction line and pool cap (HERO-70)

Prisma's SQLite engine runs each statement on one of its worker threads (one
per CPU), and a statement waiting for the writer lock sleeps that thread. With
more waiting writers than threads, the transaction holding the lock cannot
COMMIT and everything stalls for a full `busy_timeout` (20 s steps, then
P1008/P2028). Two guards, each with its own rollback:

- `src/lib/prisma.ts` queues this process's transactions in one FIFO line
  (wait counts against `maxWait`). Off: `PRISMA_TX_SERIALIZE=0`.
- The pool is capped at the worker count: `connection_limit=<CPUs>` is appended
  to a `file:` `DATABASE_URL` unless one is already there. Restore Prisma's old
  default by putting `connection_limit=17` (2 × physical cores + 1 on the 8-vCPU prod host) in `DATABASE_URL` yourself.

Both are read once at process start, so restart the app after changing either
(and check the new value reached the process — see the PM2 env notes in
CLAUDE.md). Reproduction: `npm run verify:sqlite-tx-contention`.

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

Permanent purge is disabled pending shared writer exclusion across every process that can
create or update media references. A reference-graph scan alone cannot close the database
writer race, so the library and CLI reject purge requests before discovery or unlink.
Supplying extra or forged options does not enable the path.

Keep scheduled cleanup in dry-run and keep quarantined customer media recoverable through
restore. The first 14-day rollout cycle must accumulate and inspect quarantine state without
permanent deletion. Enabling purge later requires a separately reviewed coordinated writer
barrier used by the web process, workers, and maintenance operation; do not add a cron flag or
manual purge command until that shared exclusion mechanism exists and has race coverage.
