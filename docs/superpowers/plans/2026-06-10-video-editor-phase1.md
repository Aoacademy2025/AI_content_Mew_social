# Video Editor Optimization — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the five Phase-1 quick-win PRs from the approved spec (`docs/superpowers/specs/2026-06-10-video-editor-optimization-design.md` §5): ops guardrails, quota fail-fast + kapokja fix, polling hardening, external-call armor, and the editor playback-lag fix — without changing any working user-visible behavior except strict improvements.

**Architecture:** Five independent PRs on separate branches off `main`, deployed one at a time in the order **PR-4 → PR-1 → PR-2 → PR-5 → PR-3**. Each PR is revertible on its own. New shared utilities (`poll-job.ts`, `fetch-budget.ts`, `provider-errors.ts`) are pure modules verified with the repo's `scripts/verify-*.ts` + `npx tsx` pattern (no test framework in this repo). Frontend changes keep all state shapes intact; the playback-perf PR moves 60fps updates out of React state into an external store + direct DOM writes.

**Tech Stack:** Next.js 15 (App Router) + React 19.2, TypeScript, Prisma 6 + SQLite, PM2/Nginx on a single Hostinger VPS, Remotion 4 + ffmpeg, `tsx` for verify scripts, `gh` CLI for PRs.

**Cross-PR dependencies & merge notes:**
- **PR-5 merges after PR-1** (it builds on PR-1's rewritten `poll-avatar` route).
- **PR-2 and PR-3 both touch `page.tsx`** in different regions; merge PR-2 first, then rebase PR-3 before merge.
- Every PR is reviewed by wao before merge; shared-file changes (`deploy/deploy.sh`, `next.config.ts` in PR-4) are explicitly flagged in the PR body.
- Production deploys: `bash deploy/deploy.sh` on the VPS, one PR per deploy, watch `pm2 logs ai-content` for 24h between deploys.

---

## PR-4: Ops guardrails

Machine-level guardrails deployed **before** all other Phase 1 PRs (spec §5 deploy order: PR-4 → PR-1 → PR-2 → PR-5 → PR-3): pm2 log rotation, removal of per-poll log flooding, SQLite WAL + busy_timeout (a Phase 2 prerequisite for the render worker), an atomic `.next` swap in `deploy/deploy.sh` (closes the 1,014-line ".next not found" crash-loop window), a hard 1.5GB ceiling on Remotion's offthread video cache, and stock-normalize hardening (300s timeout + drop broken clips instead of silently serving files that later crash Remotion with "Invalid data"). Risk is low — config/ops plus small, behavior-preserving code changes; no schema changes and no user-facing UI strings. Rollback: revert the PR (each change is independent); pm2-logrotate can be removed with `pm2 uninstall pm2-logrotate`; WAL can be reverted with `PRAGMA journal_mode=DELETE` but should be kept (Phase 2 depends on it).

**wao review points (shared files): `deploy/deploy.sh`, `next.config.ts` — tagged in the PR body (Task 4.7).**

---

### Task 4.1: Branch + pm2-logrotate on prod (runbook + ops)

**Files:**
- Create: `docs/ops/ops-guardrails-runbook.md`

- [ ] **Step 1: Create the feature branch**

```bash
cd /Users/mewsocialmacmini/projects/AI_content_Mew_social
git checkout main && git pull origin main
git checkout -b mew/ops-guardrails
```

Expected output ends with:
```
Switched to a new branch 'mew/ops-guardrails'
```

- [ ] **Step 2: Create `docs/ops/ops-guardrails-runbook.md`**

Create the file with exactly this content (the WAL section is appended later in Task 4.3):

````markdown
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
```

Verify:

```bash
pm2 conf pm2-logrotate
```

Expected: a key/value listing for module `pm2-logrotate` that includes
`max_size` = `50M`, `retain` = `5`, `compress` = `true` (other keys keep
their defaults, e.g. `workerInterval` 30, `rotateInterval` `0 0 * * *`).

The rotation worker ticks every 30s, so the existing oversized logs get
rotated into compressed archives within a minute. Confirm:

```bash
ls -lh /root/.pm2/logs/ | head
du -sh /root/.pm2/logs/
```

Expected: every live `*.log` is under 50M; `*.log.gz` archives appear
(at most 5 retained per log).
````

- [ ] **Step 3: Run the pm2-logrotate ops steps on prod**

Prod access (per project policy, confirm with the team before SSHing):

```bash
ssh -i ~/.ssh/hostinger_heroai_codex root@72.62.196.230
```

Then on the VPS run exactly the four `pm2 install`/`pm2 set` commands from the runbook above, followed by `pm2 conf pm2-logrotate`. Expected observations: `pm2 install pm2-logrotate` ends with the module `online` in the PM2 list; `pm2 conf pm2-logrotate` shows `max_size` `50M`, `retain` `5`, `compress` `true`. After ~1 minute, `ls -lh /root/.pm2/logs/ | head` shows the formerly-414MB `ai-content-error.log` rotated (live file < 50M, `.log.gz` archives present). Exit the SSH session.

- [ ] **Step 4: Commit the runbook**

```bash
cd /Users/mewsocialmacmini/projects/AI_content_Mew_social
git add docs/ops/ops-guardrails-runbook.md
git commit -m "$(cat <<'EOF'
docs(ops): add ops-guardrails runbook — pm2-logrotate 50M x 5 compressed

Documents the prod pm2-logrotate setup applied for PR-4 (spec §5 PR-4):
max_size 50M, retain 5, compress true. The 414MB/9.7M-line error log is
now rotated automatically.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

Expected: `1 file changed` with insertions only.

---

### Task 4.2: Gate per-poll verbose logging behind DEBUG_RENDER

**Files:**
- Modify: `src/app/api/videos/poll-avatar/route.ts`

- [ ] **Step 1: Confirm the current per-poll log sites**

```bash
cd /Users/mewsocialmacmini/projects/AI_content_Mew_social
grep -rn "console\.\(log\|info\)" src/app/api/videos/render-progress src/app/api/videos/render-status src/app/api/videos/poll-avatar
```

Expected output — exactly one match (verified at HEAD: `render-progress` and `render-status` routes contain no `console.log`/`console.info` at all; the only per-poll logger is `poll-avatar`, which dumps the full HeyGen JSON payload roughly every 3s per active avatar job):

```
src/app/api/videos/poll-avatar/route.ts:43:    console.log("[poll-avatar]", JSON.stringify(data));
```

- [ ] **Step 2: Gate the poll-avatar payload dump behind `DEBUG_RENDER`**

In `src/app/api/videos/poll-avatar/route.ts`, current code (lines 42–43):

```typescript
    const data = await res.json();
    console.log("[poll-avatar]", JSON.stringify(data));
```

Replace with:

```typescript
    const data = await res.json();
    if (process.env.DEBUG_RENDER === "1") {
      // Per-poll HeyGen payload dump (~1 line every 3s per active avatar job)
      // flooded the PM2 logs (414MB error log) — opt in with DEBUG_RENDER=1.
      console.log("[poll-avatar]", JSON.stringify(data));
    }
```

(`console.error("poll-avatar error:", error)` in the catch block at line 52 stays — errors are not per-poll noise.)

- [ ] **Step 3: Verify the gate**

```bash
grep -rn "console\.log" src/app/api/videos/poll-avatar/route.ts
grep -n "DEBUG_RENDER" src/app/api/videos/poll-avatar/route.ts
```

Expected: the first grep shows the `console.log` now on its own line inside the `if` block; the second shows exactly one match containing `process.env.DEBUG_RENDER === "1"`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/videos/poll-avatar/route.ts
git commit -m "$(cat <<'EOF'
fix(logs): gate per-poll HeyGen payload logging behind DEBUG_RENDER

poll-avatar logged the full HeyGen status JSON on every poll (~every 3s
per active avatar job), the main contributor to the 414MB PM2 error log.
render-progress / render-status have no per-poll logs (verified by grep).
Set DEBUG_RENDER=1 to re-enable when debugging avatar issues.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.3: SQLite WAL + busy_timeout (Phase 2 prerequisite)

**Files:**
- Create: `scripts/verify-sqlite-pragmas.ts`
- Modify: `src/lib/prisma.ts`, `docs/ops/ops-guardrails-runbook.md`
- Test: `scripts/verify-sqlite-pragmas.ts` (verify-* pattern, run with `npx tsx`)

> **Env note (verified on this machine):** this repo clone has NO local `.env`
> (only `deploy/.env.production` exists), and `tsx` does not auto-load `.env`
> anyway — so every `npx tsx scripts/verify-sqlite-pragmas.ts` invocation below
> passes `DATABASE_URL` explicitly, following the repo's existing verify-*
> convention (see the header of `scripts/verify-trial.ts`). The absolute path
> avoids Prisma's relative-`file:`-URL resolution ambiguity, and
> `?connection_limit=1` pins a single pooled connection so the init pragma and
> the verify reads can never land on different connections.

- [ ] **Step 1: Write the failing verify script FIRST**

Create `scripts/verify-sqlite-pragmas.ts` with exactly:

```typescript
// Verifies the SQLite settings PR-4 requires (spec §5 PR-4, §12 risk table):
//  - journal_mode=WAL  (persistent per DB file; set once via sqlite3 CLI —
//    see docs/ops/ops-guardrails-runbook.md §2)
//  - busy_timeout=5000 (per-connection; Prisma's SQLite connector already
//    defaults to 5000ms, and src/lib/prisma.ts now sets it explicitly on init
//    so the guarantee can't silently regress)
// tsx does NOT load .env — pass DATABASE_URL explicitly (repo verify-*
// convention, see scripts/verify-trial.ts). connection_limit=1 pins a single
// connection so the init pragma and the reads below share it. Run from root:
//   DATABASE_URL="file:$(pwd)/prisma/dev.db?connection_limit=1" npx tsx scripts/verify-sqlite-pragmas.ts
import { prisma } from "../src/lib/prisma";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}\n        got:  ${g}\n        want: ${w}`);
  }
}

async function main() {
  const journalRows = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>(
    "PRAGMA journal_mode"
  );
  check("journal_mode is wal", journalRows[0]?.journal_mode, "wal");

  const busyRows = await prisma.$queryRawUnsafe<{ timeout: number | bigint }[]>(
    "PRAGMA busy_timeout"
  );
  check("busy_timeout is 5000", Number(busyRows[0]?.timeout), 5000);

  await prisma.$disconnect();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll sqlite pragma checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run it — expect FAIL**

```bash
cd /Users/mewsocialmacmini/projects/AI_content_Mew_social
DATABASE_URL="file:$(pwd)/prisma/dev.db?connection_limit=1" npx tsx scripts/verify-sqlite-pragmas.ts
```

Expected: exit code 1 with exactly:

```
  FAIL  journal_mode is wal
        got:  "delete"
        want: "wal"
  PASS  busy_timeout is 5000

1 check(s) failed
```

(The local dev DB is in `delete` mode — re-confirmed 2026-06-10 via `sqlite3 prisma/dev.db "PRAGMA journal_mode;"`. The `busy_timeout` check PASSes even before any code change because Prisma 6.19.2's SQLite connector defaults every connection to busy_timeout=5000 — verified empirically on this repo. That default is undocumented, which is exactly why Step 4 makes it explicit. The journal_mode check is the genuinely failing one, so TDD's fail-first requirement holds.)

- [ ] **Step 3: One-time WAL switch on the dev DB**

```bash
cd /Users/mewsocialmacmini/projects/AI_content_Mew_social
sqlite3 prisma/dev.db "PRAGMA journal_mode=WAL;"
```

Expected output:

```
wal
```

(`journal_mode=WAL` is persistent — stored in the DB file header, survives restarts. `dev.db-wal`/`dev.db-shm` sidecar files will appear; both are already gitignored via `/prisma/*.db-wal` and `/prisma/*.db-shm`.)

- [ ] **Step 4: Set busy_timeout on Prisma client init**

`src/lib/prisma.ts` — current complete file:

```typescript
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

Replace the entire file with:

```typescript
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const isNewClient = !globalForPrisma.prisma;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient();

if (isNewClient) {
  // SQLite returns SQLITE_BUSY ("database is locked") when a write can't get
  // the lock within busy_timeout. With WAL enabled (one-time
  // `PRAGMA journal_mode=WAL` per DB file — docs/ops/ops-guardrails-runbook.md §2)
  // a 5s busy_timeout makes writers wait instead of erroring. This is the
  // prerequisite for the Phase 2 render worker, a second process sharing this
  // DB file (the worker sets it natively via better-sqlite3, which has NO
  // default). Prisma's own SQLite connector defaults busy_timeout to 5000ms
  // per connection (verified on Prisma 6.19.2), but that default is
  // undocumented — set it explicitly so it can never silently regress.
  // busy_timeout is per-connection and NOT persistent, so it is set at client
  // init and applies to the pooled connection that executes it.
  // NOTE: $queryRawUnsafe, NOT $executeRawUnsafe — SQLite PRAGMA assignment
  // returns a row, and Prisma's executeRaw rejects row-returning statements
  // ("Execute returned results, which is not allowed in SQLite.").
  // Fire-and-forget so module load can never throw.
  prisma
    .$queryRawUnsafe("PRAGMA busy_timeout = 5000")
    .catch((e) => console.warn("[prisma] could not set busy_timeout:", e));
}

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

- [ ] **Step 5: Re-run the verify script — expect PASS**

```bash
DATABASE_URL="file:$(pwd)/prisma/dev.db?connection_limit=1" npx tsx scripts/verify-sqlite-pragmas.ts
```

Expected output:

```
  PASS  journal_mode is wal
  PASS  busy_timeout is 5000

All sqlite pragma checks passed
```

(`?connection_limit=1` in the command makes this deterministic: the init pragma in `src/lib/prisma.ts` and the verify reads share the single pooled connection, so the busy_timeout check can never observe a different connection. Even without it the check would pass on Prisma 6.19.2 thanks to the connector's 5000ms default.)

- [ ] **Step 6: Append the prod WAL section to the runbook**

In `docs/ops/ops-guardrails-runbook.md`, append at the end of the file:

````markdown

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

Expected: `wal`, plus `dev.db-wal` / `dev.db-shm` next to `dev.db` (all
`prisma/*.db*` paths are gitignored, so `git pull` never touches them).
````

- [ ] **Step 7: Run the prod WAL one-time pragma**

SSH to prod (confirm with the team first, as in Task 4.1 Step 3) and run the two command blocks from runbook §2. Expected observations: `wal` printed twice (once on switch, once on verify) and the `-wal`/`-shm` files listed. Exit the SSH session.

- [ ] **Step 8: Commit**

```bash
git add scripts/verify-sqlite-pragmas.ts src/lib/prisma.ts docs/ops/ops-guardrails-runbook.md
git commit -m "$(cat <<'EOF'
feat(db): SQLite WAL + explicit 5s busy_timeout on Prisma init

- journal_mode=WAL applied one-time to dev + prod DB files (persistent;
  runbook §2 documents the prod commands)
- busy_timeout=5000 set on Prisma client init so concurrent writers wait
  instead of failing with SQLITE_BUSY — prerequisite for the Phase 2
  render worker sharing the DB file. Prisma's SQLite connector already
  defaults to 5000ms (undocumented); this makes it an explicit guarantee.
  Uses $queryRawUnsafe because SQLite PRAGMA assignment returns a row,
  which Prisma's executeRaw rejects.
- scripts/verify-sqlite-pragmas.ts asserts both (verify-* pattern)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.4: Atomic `.next` swap in deploy (wao review point)

**Files:**
- Modify: `next.config.ts` (**shared file — wao review point**), `deploy/deploy.sh` (**shared file — wao review point**), `.gitignore`

- [ ] **Step 1: Make `distDir` env-overridable in `next.config.ts`**

Current code (lines 13–16):

```typescript
const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
```

Replace with:

```typescript
const nextConfig: NextConfig = {
  // Build output dir. deploy/deploy.sh builds into .next-staging (via
  // NEXT_DIST_DIR) and atomically swaps it into .next only on success, so a
  // failed/OOM build can never delete the dist dir the running app serves
  // from (the old in-place flow caused a 1,014-line ".next not found" crash
  // loop). Runtime (pm2 `next start`) never sets NEXT_DIST_DIR, so it always
  // reads the default .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  typescript: {
    ignoreBuildErrors: true,
  },
```

- [ ] **Step 2: Verify config resolution both ways**

(Note the `m.default.default` accessor: `tsx -e` evaluates in a CommonJS context, so the ESM default export of `next.config.ts` is nested one level deeper than under plain ESM — `m.default.distDir` would print `undefined`. Verified empirically on this repo.)

```bash
cd /Users/mewsocialmacmini/projects/AI_content_Mew_social
npx tsx -e "process.env.NEXT_DIST_DIR='.next-staging'; import('./next.config.ts').then(m=>{const c=m.default.default ?? m.default; console.log('staging:', c.distDir)})"
npx tsx -e "delete process.env.NEXT_DIST_DIR; import('./next.config.ts').then(m=>{const c=m.default.default ?? m.default; console.log('default:', c.distDir)})"
```

Expected output:

```
staging: .next-staging
default: .next
```

- [ ] **Step 3: Rewrite the build+restart tail of `deploy/deploy.sh`**

Current code (lines 62–86) — quote exactly:

```bash
echo "=== [5/6] Build (heap: ${BUILD_HEAP_MB}MB, worker heap: ${BUILD_WORKER_HEAP_MB}MB) ==="
run_next_build() {
  rm -rf "$APP_DIR/.next"
  if ! npm run build; then
    return 1
  fi
  test -f "$APP_DIR/.next/BUILD_ID"
}

if ! run_next_build; then
  echo "Build failed or missing .next/BUILD_ID. Retrying with lower memory profile: main=${BUILD_HEAP_MB_LOW}MB worker=${BUILD_WORKER_HEAP_MB_LOW}MB"
  export BUILD_HEAP_MB="$BUILD_HEAP_MB_LOW"
  export BUILD_WORKER_HEAP_MB="$BUILD_WORKER_HEAP_MB_LOW"
  export NODE_OPTIONS="--max-old-space-size=${BUILD_HEAP_MB} --max-semi-space-size=8"
  export NEXT_PRIVATE_WORKER_OPTIONS="--max-old-space-size=${BUILD_WORKER_HEAP_MB}"
  if ! run_next_build; then
    echo "ERROR: build did not generate .next/BUILD_ID (most likely killed by OOM)"
    exit 1
  fi
fi

if [ ! -f "$APP_DIR/.next/BUILD_ID" ]; then
  echo "ERROR: build did not generate .next/BUILD_ID (most likely killed by OOM)"
  exit 1
fi
```

Replace with (OOM-retry env logic is byte-identical — only the target dir and the swap are new; `scripts/build.js` spreads `process.env` into the `next build` child, so the exported `NEXT_DIST_DIR` reaches `next.config.ts`):

```bash
echo "=== [5/6] Build (heap: ${BUILD_HEAP_MB}MB, worker heap: ${BUILD_WORKER_HEAP_MB}MB) ==="
# Build into a staging dir and swap it into .next only after BUILD_ID exists.
# The old in-place flow (rm -rf .next before building) left the running app
# with NO dist dir for the whole multi-minute build; a failed/OOM build caused
# a ".next not found" crash loop. Runtime (pm2 `next start`) never sets
# NEXT_DIST_DIR, so it keeps serving the existing .next until the swap.
STAGING_DIR="$APP_DIR/.next-staging"
export NEXT_DIST_DIR=".next-staging"
run_next_build() {
  rm -rf "$STAGING_DIR"
  if ! npm run build; then
    return 1
  fi
  test -f "$STAGING_DIR/BUILD_ID"
}

if ! run_next_build; then
  echo "Build failed or missing BUILD_ID. Retrying with lower memory profile: main=${BUILD_HEAP_MB_LOW}MB worker=${BUILD_WORKER_HEAP_MB_LOW}MB"
  export BUILD_HEAP_MB="$BUILD_HEAP_MB_LOW"
  export BUILD_WORKER_HEAP_MB="$BUILD_WORKER_HEAP_MB_LOW"
  export NODE_OPTIONS="--max-old-space-size=${BUILD_HEAP_MB} --max-semi-space-size=8"
  export NEXT_PRIVATE_WORKER_OPTIONS="--max-old-space-size=${BUILD_WORKER_HEAP_MB}"
  if ! run_next_build; then
    echo "ERROR: build did not generate ${STAGING_DIR}/BUILD_ID (most likely killed by OOM). Old .next untouched — app keeps running."
    exit 1
  fi
fi

if [ ! -f "$STAGING_DIR/BUILD_ID" ]; then
  echo "ERROR: build did not generate ${STAGING_DIR}/BUILD_ID (most likely killed by OOM). Old .next untouched — app keeps running."
  exit 1
fi

echo "=== [5b/6] Atomic swap .next-staging -> .next ==="
# .next.old is kept until the next deploy as a manual rollback
# (mv .next.old .next && pm2 restart ai-content); costs a few hundred MB.
rm -rf "$APP_DIR/.next.old"
if [ -d "$APP_DIR/.next" ]; then
  mv "$APP_DIR/.next" "$APP_DIR/.next.old"
fi
mv "$STAGING_DIR" "$APP_DIR/.next"
unset NEXT_DIST_DIR
```

(Everything after — `=== [6/6] Restart PM2 ===` onwards — is unchanged. Failure behavior preserved: any build failure exits before the swap, so the old `.next` keeps serving.)

- [ ] **Step 4: Ignore the staging/backup dirs**

`.gitignore` — current code (lines 19–21):

```
# next.js
/.next/
/out/
```

Replace with:

```
# next.js
/.next/
/.next-staging/
/.next.old/
/out/
```

- [ ] **Step 5: Syntax-check the script and prove env propagation with a real local build**

```bash
bash -n deploy/deploy.sh
NEXT_DIST_DIR=.next-staging npm run build
ls .next-staging/BUILD_ID
rm -rf .next-staging
```

Expected: `bash -n` prints nothing (exit 0); the build ends with the Next.js route table (a plain `npm run build` was verified to pass on this machine with no local `.env`, so no extra env vars are needed); `ls` prints `.next-staging/BUILD_ID` (proving `scripts/build.js` propagates `NEXT_DIST_DIR` to `next build`); the default `.next` dir is left untouched.

- [ ] **Step 6: Commit**

```bash
git add next.config.ts deploy/deploy.sh .gitignore
git commit -m "$(cat <<'EOF'
feat(deploy): build into .next-staging and atomically swap on success

The old flow rm -rf'd .next before the multi-minute build, so a failed or
OOM-killed build left the app in a ".next not found" crash loop (1,014
lines of it in prod logs). Now: next.config.ts honors NEXT_DIST_DIR,
deploy.sh builds into .next-staging, and only after BUILD_ID exists does
it swap .next -> .next.old -> new .next, then restart PM2. Build heap
caps and the OOM-retry profile are unchanged. On any build failure the
old .next is untouched and the app keeps running.

wao review point: shared files deploy/deploy.sh + next.config.ts.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.5: Hard-cap Remotion `offthreadVideoCacheSizeInBytes` at 1.5GB

Note for the implementer: at HEAD the render route **already** sets `offthreadVideoCacheSizeInBytes` explicitly (32–128MB per-job defaults, `RENDER_OFFTHREAD_CACHE_MB` env override) — the gap is that the env override has **no upper clamp** (`RENDER_OFFTHREAD_CACHE_MB=99999` would allocate ~97GB). This task extracts the logic into a pure lib (so the verify-* pattern applies), preserves the existing defaults bit-for-bit, and adds the spec's hard ceiling of 1.5GB = `1_610_612_736` bytes.

**Files:**
- Create: `src/lib/offthread-cache.ts`, `scripts/verify-offthread-cache.ts`
- Modify: `src/app/api/videos/render/route.ts`
- Test: `scripts/verify-offthread-cache.ts` (run with `npx tsx`)

- [ ] **Step 1: Write the failing verify script FIRST**

Create `scripts/verify-offthread-cache.ts` with exactly:

```typescript
// Verifies resolveOffthreadCacheBytes: Remotion's offthread video frame cache
// (default: HALF OF FREE SYSTEM RAM) must always be explicit and hard-capped
// at 1.5GB on the shared 4 vCPU / 15.6GB VPS (spec §1 root cause 6, §5 PR-4).
// Run: npx tsx scripts/verify-offthread-cache.ts
import {
  OFFTHREAD_CACHE_MAX_BYTES,
  resolveOffthreadCacheBytes,
} from "../src/lib/offthread-cache";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}\n        got:  ${g}\n        want: ${w}`);
  }
}

// 1) ceiling constant is exactly 1.5GB
check("max is 1.5GB", OFFTHREAD_CACHE_MAX_BYTES, 1_610_612_736);

// 2) env unset (NaN) -> per-job default (same math as the old inline code)
check("default 128MB base, 1 slot",
  resolveOffthreadCacheBytes({ requestedMb: NaN, baseCacheMb: 128, activeRenderSlots: 1 }),
  128 * 1024 * 1024);
check("128MB base / 3 slots -> 42MB",
  resolveOffthreadCacheBytes({ requestedMb: NaN, baseCacheMb: 128, activeRenderSlots: 3 }),
  42 * 1024 * 1024);
check("32MB base / 4 slots -> floor clamps to 32MB",
  resolveOffthreadCacheBytes({ requestedMb: NaN, baseCacheMb: 32, activeRenderSlots: 4 }),
  32 * 1024 * 1024);

// 3) env override respected below the ceiling
check("env 512MB respected",
  resolveOffthreadCacheBytes({ requestedMb: 512, baseCacheMb: 128, activeRenderSlots: 1 }),
  512 * 1024 * 1024);

// 4) the NEW guardrail: env above the ceiling is clamped to 1.5GB
//    (previously RENDER_OFFTHREAD_CACHE_MB=99999 would allocate ~97GB)
check("env 99999MB clamped to 1.5GB",
  resolveOffthreadCacheBytes({ requestedMb: 99999, baseCacheMb: 128, activeRenderSlots: 1 }),
  1_610_612_736);

// 5) env below the 32MB floor is ignored -> fall back to per-job default
check("env 8MB ignored (below floor)",
  resolveOffthreadCacheBytes({ requestedMb: 8, baseCacheMb: 64, activeRenderSlots: 1 }),
  64 * 1024 * 1024);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll offthread-cache checks passed");
```

- [ ] **Step 2: Run it — expect failure (module does not exist yet)**

```bash
cd /Users/mewsocialmacmini/projects/AI_content_Mew_social
npx tsx scripts/verify-offthread-cache.ts
```

Expected: non-zero exit with `Cannot find module '../src/lib/offthread-cache'` (or equivalent ERR_MODULE_NOT_FOUND).

- [ ] **Step 3: Create `src/lib/offthread-cache.ts`**

```typescript
// Resolves Remotion renderMedia's offthreadVideoCacheSizeInBytes.
//
// Remotion's own default is HALF OF FREE SYSTEM RAM — on the shared 15.6GB
// VPS (web + render + ffmpeg in one Node process) that is a direct OOM
// vector, so the value must always be explicit AND hard-capped. This mirrors
// the previous inline logic in src/app/api/videos/render/route.ts (32–128MB
// per-job defaults scaled down by concurrent render slots, with a
// RENDER_OFFTHREAD_CACHE_MB env override) and adds a 1.5GB ceiling so a
// misconfigured env var can never exhaust the box.

export const OFFTHREAD_CACHE_MAX_BYTES = 1_610_612_736; // 1.5 GB
export const OFFTHREAD_CACHE_MIN_MB = 32;

export function resolveOffthreadCacheBytes(opts: {
  /** Number(process.env.RENDER_OFFTHREAD_CACHE_MB) — NaN when unset */
  requestedMb: number;
  /** Host-profile default in MB (32 critical-low-mem / 64 low-resource / 128 normal) */
  baseCacheMb: number;
  /** Concurrent renderMedia slots sharing RAM right now (>= 1) */
  activeRenderSlots: number;
}): number {
  const { requestedMb, baseCacheMb, activeRenderSlots } = opts;
  const slots = Math.max(1, activeRenderSlots);
  const perJobCacheMb = Math.max(OFFTHREAD_CACHE_MIN_MB, Math.floor(baseCacheMb / slots));
  const bytes =
    Number.isFinite(requestedMb) && requestedMb >= OFFTHREAD_CACHE_MIN_MB
      ? Math.round(requestedMb * 1024 * 1024)
      : perJobCacheMb * 1024 * 1024;
  return Math.min(bytes, OFFTHREAD_CACHE_MAX_BYTES);
}
```

- [ ] **Step 4: Re-run the verify script — expect PASS**

```bash
npx tsx scripts/verify-offthread-cache.ts
```

Expected output: 7 `PASS` lines and `All offthread-cache checks passed`, exit 0.

- [ ] **Step 5: Wire it into the render route**

In `src/app/api/videos/render/route.ts`, add the import. Current code (lines 11–12):

```typescript
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { recordTelemetryEvent } from "@/lib/telemetry";
```

Replace with:

```typescript
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { resolveOffthreadCacheBytes } from "@/lib/offthread-cache";
import { recordTelemetryEvent } from "@/lib/telemetry";
```

Then replace the inline computation. Current code (lines 732–738, inside the `withRenderSlot` callback that starts at line 712, 10-space indentation):

```typescript
          const requestedOffthreadCacheMb = Number(process.env.RENDER_OFFTHREAD_CACHE_MB);
          // Scale down cache per job when running many renderMedia slots in parallel
          const baseCacheMb = isCriticalLowMem ? 32 : isLowResourceHost ? 64 : 128;
          const perJobCacheMb = Math.max(32, Math.floor(baseCacheMb / activeRenderSlots));
          const offthreadVideoCacheSizeInBytes = Number.isFinite(requestedOffthreadCacheMb) && requestedOffthreadCacheMb >= 32
            ? Math.round(requestedOffthreadCacheMb * 1024 * 1024)
            : perJobCacheMb * 1024 * 1024;
```

Replace with:

```typescript
          const requestedOffthreadCacheMb = Number(process.env.RENDER_OFFTHREAD_CACHE_MB);
          // Scale down cache per job when running many renderMedia slots in
          // parallel; hard-capped at 1.5GB inside the resolver (PR-4 guardrail).
          const baseCacheMb = isCriticalLowMem ? 32 : isLowResourceHost ? 64 : 128;
          const offthreadVideoCacheSizeInBytes = resolveOffthreadCacheBytes({
            requestedMb: requestedOffthreadCacheMb,
            baseCacheMb,
            activeRenderSlots,
          });
```

For context (unchanged — the value is already passed into the `renderMedia` options object at line 794 and logged at line 754):

```typescript
          await renderMedia({
            composition,
            serveUrl: bundleLocation,
            codec: "h264",
            outputLocation,
            inputProps,
            timeoutInMilliseconds: 7200000,
            concurrency: renderConcurrency,
            cancelSignal,
            x264Preset: isLowResourceHost ? "faster" : "medium",
            jpegQuality,
            offthreadVideoCacheSizeInBytes,
```

- [ ] **Step 6: Verify no dangling references**

```bash
grep -n "perJobCacheMb" src/app/api/videos/render/route.ts
grep -n "resolveOffthreadCacheBytes\|offthread-cache" src/app/api/videos/render/route.ts
```

Expected: first grep prints nothing (the only two former uses, old lines 735/738, are gone); second prints the import line and the call site.

- [ ] **Step 7: Commit**

```bash
git add src/lib/offthread-cache.ts scripts/verify-offthread-cache.ts src/app/api/videos/render/route.ts
git commit -m "$(cat <<'EOF'
feat(render): hard-cap Remotion offthread video cache at 1.5GB

Remotion's default offthreadVideoCacheSizeInBytes is half of free system
RAM — an OOM vector on the shared 15.6GB box. The route already set
explicit 32-128MB per-job defaults with a RENDER_OFFTHREAD_CACHE_MB
override, but the override had no upper clamp. Extract the logic into
src/lib/offthread-cache.ts (defaults preserved bit-for-bit, ceiling
1_610_612_736 bytes) with scripts/verify-offthread-cache.ts coverage.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.6: Stock normalize hardening — 300s timeout + drop broken clips

Note for the implementer: the `STOCK_NORMALIZE_TIMEOUT_MS` env hook **already exists** in the route (default 120s, clamped 30s–600s); this task raises the default to 300s and changes the failure policy. Today a SIGKILL at the timeout leaves the un-normalized download in place and **still serves it** (`results.push` runs regardless of normalize status), which later crashes Remotion with "Invalid data". New policy: on normalize failure, delete the broken file and skip the clip — the render's existing gap-fill (`[render] gap … extending next segment back` in `render/route.ts`) substitutes neighboring clips, and the next fetch re-downloads fresh.

**Files:**
- Modify: `src/app/api/videos/fetch-stock/route.ts`, `scripts/normalize-stock-cache.mjs`
- Test: manual broken-clip test via `scripts/normalize-stock-cache.mjs` + grep checks

- [ ] **Step 1: Raise the default normalize timeout to 300s**

In `src/app/api/videos/fetch-stock/route.ts`, current code (line 29):

```typescript
const NORMALIZE_TIMEOUT_MS = readIntEnv("STOCK_NORMALIZE_TIMEOUT_MS", 120_000, 30_000, 600_000);
```

Replace with:

```typescript
// 300s default: long 4K source clips legitimately take minutes to re-encode;
// a SIGKILL'd encode must not be the common case (override via env, max 600s).
const NORMALIZE_TIMEOUT_MS = readIntEnv("STOCK_NORMALIZE_TIMEOUT_MS", 300_000, 30_000, 600_000);
```

- [ ] **Step 2: Update the stale "keep original" comment in `normalizeForRemotion`'s catch**

Current code (lines 102–107 of the same file):

```typescript
  } catch (e) {
    // If normalization fails, keep the original download rather than losing the clip
    console.warn(`[fetch-stock] normalize failed for ${path.basename(filePath)}, keeping original:`, e);
    safeUnlink(tmp);
    return { status: "failed", durationMs: Date.now() - startedAt };
  }
```

Replace with:

```typescript
  } catch (e) {
    // Normalization failed (timeout/SIGKILL or bad input). Callers DROP the
    // clip — an un-normalized file crashes Remotion later ("Invalid data").
    console.warn(`[fetch-stock] normalize failed for ${path.basename(filePath)}:`, e);
    safeUnlink(tmp);
    return { status: "failed", durationMs: Date.now() - startedAt };
  }
```

- [ ] **Step 3: Drop broken clips on the cache-hit path**

Current code (lines 846–854, inside the download-phase `withConcurrency` callback):

```typescript
      if (isValidMp4Path(outPath)) {
        console.log(`[fetch-stock] cache hit: ${outFile}`);
        stockTelemetry.cacheHitCount++;
        // Older cached clips may predate normalization (or were left B-frame'd) —
        // normalizeForRemotion no-ops if already clean, re-encodes otherwise.
        applyNormalizeTelemetry(await normalizeForRemotion(outPath));
        results.push({ keyword, pexelsId: id, duration, videoUrl: link, localPath: outPath, localUrl: `/api/stocks/${outFile}` });
        return;
      }
```

Replace with:

```typescript
      if (isValidMp4Path(outPath)) {
        console.log(`[fetch-stock] cache hit: ${outFile}`);
        stockTelemetry.cacheHitCount++;
        // Older cached clips may predate normalization (or were left B-frame'd) —
        // normalizeForRemotion no-ops if already clean, re-encodes otherwise.
        const cachedNormalize = await normalizeForRemotion(outPath);
        applyNormalizeTelemetry(cachedNormalize);
        if (cachedNormalize.status === "failed") {
          // Un-normalized clips crash Remotion later ("Invalid data"). Drop the
          // broken file and skip this clip — the render timeline gap-fills with
          // neighboring clips, and the next fetch re-downloads it fresh.
          safeUnlink(outPath);
          safeUnlink(normalizedMarkerPath(outPath));
          console.warn(`[fetch-stock] dropped broken cached clip after normalize failure: ${outFile}`);
          return;
        }
        results.push({ keyword, pexelsId: id, duration, videoUrl: link, localPath: outPath, localUrl: `/api/stocks/${outFile}` });
        return;
      }
```

- [ ] **Step 4: Drop broken clips on the fresh-download path**

Current code (lines 862–870 of the same callback):

```typescript
        stockTelemetry.downloadedCount++;
        // Re-encode to Remotion-safe CFR/no-B-frame so the compositor can seek
        // every frame (fixes "No frame found at position X" render crashes).
        applyNormalizeTelemetry(await normalizeForRemotion(outPath));
        if (!isValidMp4Path(outPath)) {
          stockTelemetry.downloadFailCount++;
          return;
        }
        results.push({ keyword, pexelsId: id, duration, videoUrl: link, localPath: outPath, localUrl: `/api/stocks/${outFile}` });
```

Replace with:

```typescript
        stockTelemetry.downloadedCount++;
        // Re-encode to Remotion-safe CFR/no-B-frame so the compositor can seek
        // every frame (fixes "No frame found at position X" render crashes).
        const freshNormalize = await normalizeForRemotion(outPath);
        applyNormalizeTelemetry(freshNormalize);
        if (freshNormalize.status === "failed") {
          // Un-normalized clips crash Remotion later ("Invalid data"). Drop the
          // broken file and skip this clip — the render timeline gap-fills with
          // neighboring clips instead of rendering a corrupt one.
          safeUnlink(outPath);
          safeUnlink(normalizedMarkerPath(outPath));
          stockTelemetry.downloadFailCount++;
          console.warn(`[fetch-stock] dropped ${outFile} after normalize failure`);
          return;
        }
        if (!isValidMp4Path(outPath)) {
          stockTelemetry.downloadFailCount++;
          return;
        }
        results.push({ keyword, pexelsId: id, duration, videoUrl: link, localPath: outPath, localUrl: `/api/stocks/${outFile}` });
```

(`safeUnlink` and `normalizedMarkerPath` are existing module-level helpers in this file at lines 177 and 62 — no new imports needed. Telemetry: `normalizeFailedCount` is already incremented by `applyNormalizeTelemetry` (line 509).)

- [ ] **Step 5: Mirror the policy in the backfill script**

`scripts/normalize-stock-cache.mjs` declares itself a mirror of the route's logic. Current code (lines 19–20):

```javascript
const TARGET_FPS = 30;
const CONCURRENCY = 3; // keep CPU usable; encodes are heavy
```

Replace with:

```javascript
const TARGET_FPS = 30;
const CONCURRENCY = 3; // keep CPU usable; encodes are heavy
// Match the route's default (STOCK_NORMALIZE_TIMEOUT_MS, 300s). Without a
// timeout one pathological clip hangs the whole backfill forever.
const TIMEOUT_MS = Number(process.env.STOCK_NORMALIZE_TIMEOUT_MS) || 300_000;
```

Current code (lines 34–52, inside `normalize`):

```javascript
  try {
    await execFileAsync(ffmpeg, [
      "-y", "-i", filePath, "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-r", String(TARGET_FPS), "-g", String(TARGET_FPS), "-keyint_min", String(TARGET_FPS),
      "-bf", "0", "-vsync", "cfr", "-movflags", "+faststart", tmp,
    ], { maxBuffer: 64 * 1024 * 1024 });
    if (fs.existsSync(tmp) && fs.statSync(tmp).size > 1_500) {
      fs.renameSync(tmp, filePath);
      try { fs.writeFileSync(marker, ""); } catch {}
      return "ok";
    }
    safeUnlink(tmp);
    return "fail";
  } catch (e) {
    safeUnlink(tmp);
    console.warn(`  ! ${path.basename(filePath)}: ${e.message?.slice(0, 120)}`);
    return "fail";
  }
```

Replace with:

```javascript
  try {
    await execFileAsync(ffmpeg, [
      "-y", "-i", filePath, "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-r", String(TARGET_FPS), "-g", String(TARGET_FPS), "-keyint_min", String(TARGET_FPS),
      "-bf", "0", "-vsync", "cfr", "-movflags", "+faststart", tmp,
    ], { maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT_MS, killSignal: "SIGKILL" });
    if (fs.existsSync(tmp) && fs.statSync(tmp).size > 1_500) {
      fs.renameSync(tmp, filePath);
      try { fs.writeFileSync(marker, ""); } catch {}
      return "ok";
    }
    safeUnlink(tmp);
    safeUnlink(filePath); // un-normalizable clip would crash Remotion — drop it
    return "fail";
  } catch (e) {
    safeUnlink(tmp);
    // Un-normalizable clips crash Remotion later ("Invalid data") — drop them.
    safeUnlink(filePath);
    console.warn(`  ! ${path.basename(filePath)}: dropped (${e.message?.slice(0, 120)})`);
    return "fail";
  }
```

- [ ] **Step 6: Manual verification — a broken clip is dropped, not kept**

```bash
cd /Users/mewsocialmacmini/projects/AI_content_Mew_social
mkdir -p stocks
head -c 100000 /dev/urandom > stocks/zz-broken-test.mp4
node scripts/normalize-stock-cache.mjs
ls stocks/zz-broken-test.mp4
```

Expected (on this machine `stocks/` does not exist yet, so the garbage file is the only clip and the counts are deterministic; `node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg` is present):

```
Normalizing 1 stock clips (concurrency=3)...
  ! zz-broken-test.mp4: dropped (Command failed: /Users/.../node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg -y -i ...)
  1/1 — ok:0 skip:0 fail:1

Done. ok:0 skip:0 fail:1
```

(execFile failures surface as `Command failed: …` — the message is truncated to 120 chars by the script.) The final `ls` fails with `No such file or directory` — the broken file was deleted; previously it would have been silently kept. Note: if you run this on a machine whose `stocks/` cache already holds clips, un-markered clips will be re-encoded (heavy) — the `.normalized` marker files skip already-done ones. Then confirm the timeout defaults landed in both places:

```bash
grep -n "STOCK_NORMALIZE_TIMEOUT_MS" src/app/api/videos/fetch-stock/route.ts scripts/normalize-stock-cache.mjs
```

Expected: two matches, both containing `300_000`.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/videos/fetch-stock/route.ts scripts/normalize-stock-cache.mjs
git commit -m "$(cat <<'EOF'
fix(stock): 300s normalize timeout; drop broken clips instead of serving them

Previously a SIGKILL at the 120s normalize timeout left the un-normalized
download in place and still served it, which later crashed Remotion with
"Invalid data". Now: default timeout 120s -> 300s (STOCK_NORMALIZE_TIMEOUT_MS
override unchanged, max 600s), and on normalize failure the broken file +
marker are deleted and the clip is skipped — the render timeline gap-fills
with neighboring clips and the next fetch re-downloads fresh. The backfill
script (normalize-stock-cache.mjs) mirrors the same timeout + drop policy.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.7: Final build check, push, and open the PR

**Files:** none (verification + PR only)

- [ ] **Step 1: Full local build gate (catches type/import mistakes across all tasks)**

```bash
cd /Users/mewsocialmacmini/projects/AI_content_Mew_social
npm run build
ls .next/BUILD_ID
```

Expected: build completes with the Next.js route table and `.next/BUILD_ID` exists (a plain `npm run build` was verified to pass on this machine even without a local `.env`). Also re-run both verify scripts one last time:

```bash
DATABASE_URL="file:$(pwd)/prisma/dev.db?connection_limit=1" npx tsx scripts/verify-sqlite-pragmas.ts
npx tsx scripts/verify-offthread-cache.ts
```

Expected: both end with their "All … checks passed" line, exit 0.

- [ ] **Step 2: Manual flow smoke test (dev)**

Precondition: this requires a configured local dev environment (`.env` with Clerk keys + a user with BYOK keys). This repo clone currently has NO `.env` — run this step in the dev setup you normally use for flow testing; if none exists, do this smoke test on prod after deploy, off-peak.

Run `npm run dev`, then in the browser: create a video in `/video-creator` (any style, B-roll on) and confirm (a) the render completes and B-roll plays, (b) the terminal does NOT show `[poll-avatar] {...}` payload dumps during an avatar poll (unless you set `DEBUG_RENDER=1`), and (c) `[fetch-stock]` logs show clips being served or `dropped … after normalize failure` — never a served clip after a normalize failure. Stop the dev server.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin mew/ops-guardrails
gh pr create --title "PR-4: ops guardrails — logrotate, SQLite WAL, atomic .next swap, render cache cap, stock normalize hardening" --body "$(cat <<'EOF'
## Summary

Phase 1 PR-4 from the approved design (docs/superpowers/specs/2026-06-10-video-editor-optimization-design.md §5). Deploys FIRST in the Phase 1 sequence (PR-4 → PR-1 → PR-2 → PR-5 → PR-3). Each change is independent and low risk:

- **pm2-logrotate** on prod (50MB × 5, compressed) — documented in `docs/ops/ops-guardrails-runbook.md`; the 414MB error log is now rotated.
- **Per-poll log flood removed**: poll-avatar's full HeyGen JSON dump (every ~3s per active job) is now gated behind `DEBUG_RENDER=1`. render-progress/render-status had no per-poll logs (grep-verified).
- **SQLite WAL + busy_timeout=5000** (`src/lib/prisma.ts` + one-time PRAGMA on dev/prod DB files, runbook §2) — Phase 2 render-worker prerequisite; writers now wait 5s instead of failing SQLITE_BUSY. (Set via `$queryRawUnsafe` — PRAGMA assignment returns a row, which Prisma's executeRaw rejects on SQLite.)
- **Atomic `.next` swap in deploy**: build into `.next-staging` (`NEXT_DIST_DIR`), swap to `.next` only after BUILD_ID exists. A failed/OOM build can no longer cause the ".next not found" crash loop; old `.next` keeps serving. Build heap caps + OOM-retry profile unchanged; `.next.old` kept as manual rollback.
- **Remotion offthread cache hard-capped at 1.5GB** (`src/lib/offthread-cache.ts`): existing 32–128MB per-job defaults preserved bit-for-bit; the previously unclamped `RENDER_OFFTHREAD_CACHE_MB` override can no longer exhaust RAM.
- **Stock normalize hardening**: default timeout 120s → 300s (`STOCK_NORMALIZE_TIMEOUT_MS`), and clips that fail normalization are deleted + skipped (render gap-fill substitutes neighbors) instead of being silently served and crashing Remotion with "Invalid data" later. Backfill script mirrors the policy.

## wao review points (shared files)

- `deploy/deploy.sh` — build-into-staging + atomic swap (sections [5/6]/[5b/6] only; heap/OOM-retry env logic untouched)
- `next.config.ts` — new `distDir: process.env.NEXT_DIST_DIR || ".next"` (runtime never sets the env, so prod `next start` still reads `.next`)

## Testing

- `scripts/verify-sqlite-pragmas.ts` + `scripts/verify-offthread-cache.ts` (npx tsx) — all pass
- `NEXT_DIST_DIR=.next-staging npm run build` produced `.next-staging/BUILD_ID` locally; default build unaffected
- Broken-clip test: garbage mp4 in `stocks/` is dropped (file deleted) by the normalize policy
- Dev flow: render with B-roll completes; no per-poll log spam without `DEBUG_RENDER=1`

## Deploy notes

After merge, deploy normally (`bash deploy/deploy.sh`). Prod ops already applied per runbook: pm2-logrotate config + one-time `PRAGMA journal_mode=WAL` on `/var/www/ai-content/prisma/dev.db`. Rollback: revert this PR; `pm2 uninstall pm2-logrotate` if needed; keep WAL (Phase 2 prerequisite).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh pr create` prints the new PR URL (e.g. `https://github.com/Aoacademy2025/AI_content_Mew_social/pull/<n>` — verified: `gh` is authenticated and `origin` points at that repo). Do NOT merge — wao reviews first (shared-file review points above), and PR-4 must be deployed before PR-1/2/3/5.

---

## PR-1: Fail-fast quota + close the kapokja hole

This PR makes `/api/videos/render` reject quota-exhausted requests **before any heavy work** (today the user can burn 20 minutes of CPU and only then get a plan-limit error — 25 failures/day in prod), and fixes `/api/videos/poll-avatar`, which currently masks HeyGen 401/404/402 as a 200 `{status:"unknown"}` so the editor spins for 30 minutes (the "kapokja" bug). Risk: **low** — no schema changes, no shared-file changes (`prisma/schema.prisma`, `package.json`, `next.config.ts` untouched), no behavior change for users within quota. Rollback: revert the merge commit and redeploy — there is nothing else to undo. Per the design doc (`docs/superpowers/specs/2026-06-10-video-editor-optimization-design.md` §5), deploy this **after PR-4**.

Note for the implementing engineer: `src/app/api/videos/render/route.ts` and `src/app/api/videos/poll-avatar/route.ts` are in wao's vertical (video/AI render backend) — the PR body must explicitly request his review (final task does this). Never commit to `main`.

### Task 1.1: Create the feature branch

**Files:** none

- [ ] **Step 1: Branch off up-to-date main**

  ```bash
  cd /Users/mewsocialmacmini/projects/AI_content_Mew_social
  git checkout main && git pull origin main
  git checkout -b mew/quota-precheck-avatar-errors
  ```

  Expected output ends with: `Switched to a new branch 'mew/quota-precheck-avatar-errors'`

### Task 1.2: Read-only quota check helper (`checkClipQuota`) — TDD

The render route needs a quota check that does **not** reserve (the existing `reserveClipUsage` increments `usageCount`; calling it twice would double-charge). We add a read-only peek next to it and prove both with a verify script, following the repo's `scripts/verify-*.ts` pattern (see `scripts/verify-trial.ts` for the style being copied).

**Files:**
- Create: `scripts/verify-clip-quota.ts`
- Modify: `src/lib/usage-limits.ts`

- [ ] **Step 1: Write the verify script FIRST (it must fail)**

  Create `scripts/verify-clip-quota.ts` with exactly:

  ```ts
  // Proof of the clip-quota fail-fast contract (PR-1). Run against a throwaway SQLite DB
  // with an ABSOLUTE path (Prisma CLI resolves relative file: paths vs the schema dir;
  // runtime vs cwd — they must agree):
  //   ROOT="$(pwd)"
  //   DATABASE_URL="file:$ROOT/prisma/test-quota.db" npx prisma db push --skip-generate --accept-data-loss
  //   DATABASE_URL="file:$ROOT/prisma/test-quota.db?connection_limit=1" npx tsx scripts/verify-clip-quota.ts
  import { prisma } from "../src/lib/prisma";
  import { checkClipQuota, refundClipUsage, reserveClipUsage } from "../src/lib/usage-limits";

  let passed = 0;
  function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

  async function main() {
    await prisma.user.deleteMany();
    const u = await prisma.user.create({ data: { name: "quota-user", email: "quota@t.test", plan: "FREE" } });

    // Fresh FREE user: peek allows and does NOT consume
    let peek = await checkClipQuota(u.id);
    assert(peek !== null && peek.allowed === true, "checkClipQuota allows a fresh FREE user");
    let row = await prisma.user.findUnique({ where: { id: u.id } });
    assert(row!.usageCount === 0, "checkClipQuota did NOT increment usageCount (read-only)");

    // Reserve up to the FREE limit (2 clips / 30 days)
    const r1 = await reserveClipUsage(u.id);
    assert(r1 !== null && r1.allowed === true && r1.usageCount === 1, "reserve #1 allowed (1/2)");
    const r2 = await reserveClipUsage(u.id);
    assert(r2 !== null && r2.allowed === true && r2.usageCount === 2, "reserve #2 allowed (2/2)");

    // Exhausted: peek refuses with the Thai quota message and still does not mutate
    peek = await checkClipQuota(u.id);
    assert(peek !== null && peek.allowed === false, "checkClipQuota refuses when quota exhausted");
    assert(peek !== null && peek.allowed === false && peek.message.includes("จำกัด"), "refusal carries the Thai quota message");
    row = await prisma.user.findUnique({ where: { id: u.id } });
    assert(row!.usageCount === 2, "exhausted peek did not change usageCount");

    // Reserve also refuses (atomic guard) and does not over-increment
    const r3 = await reserveClipUsage(u.id);
    assert(r3 !== null && r3.allowed === false, "reserve refuses when quota exhausted");
    row = await prisma.user.findUnique({ where: { id: u.id } });
    assert(row!.usageCount === 2, "refused reserve did not over-increment");

    // Refund frees a slot; peek allows again
    await refundClipUsage(u.id);
    peek = await checkClipQuota(u.id);
    assert(peek !== null && peek.allowed === true, "after refund, checkClipQuota allows again");

    await prisma.user.deleteMany();
    await prisma.$disconnect();
    console.log(`\n✅ ALL ${passed} CLIP-QUOTA CHECKS PASSED`);
  }
  main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
  ```

- [ ] **Step 2: Run it — expect FAILURE (helper does not exist yet)**

  ```bash
  cd /Users/mewsocialmacmini/projects/AI_content_Mew_social
  ROOT="$(pwd)"
  DATABASE_URL="file:$ROOT/prisma/test-quota.db" npx prisma db push --skip-generate --accept-data-loss
  DATABASE_URL="file:$ROOT/prisma/test-quota.db?connection_limit=1" npx tsx scripts/verify-clip-quota.ts
  ```

  Expected: a runtime error referencing `checkClipQuota` (e.g. `SyntaxError: The requested module '../src/lib/usage-limits' does not provide an export named 'checkClipQuota'` or `TypeError: checkClipQuota is not a function`). If it PASSES at this point, stop — something is wrong.

- [ ] **Step 3: Add `checkClipQuota` to `src/lib/usage-limits.ts`**

  Current code (end of `src/lib/usage-limits.ts`, after `reserveClipUsage`):

  ```ts
  export async function refundClipUsage(userId: string): Promise<void> {
    await prisma.user.updateMany({
      where: { id: userId, usageCount: { gt: 0 } },
      data: { usageCount: { decrement: 1 } },
    });
  }
  ```

  Replace with:

  ```ts
  /** Read-only quota peek — does NOT reserve. Use for fail-fast prechecks before heavy
   *  work; reserveClipUsage above remains the single atomic source of truth. */
  export async function checkClipQuota(userId: string): Promise<UsageReservation | null> {
    const usage = await syncUsageWindow(userId);
    if (!usage) return null;

    if (usage.usageCount >= usage.usageLimit) {
      return { ...usage, allowed: false, message: quotaMessage(usage.plan, usage.usageLimit, usage.resetAt) };
    }

    return { ...usage, allowed: true };
  }

  export async function refundClipUsage(userId: string): Promise<void> {
    await prisma.user.updateMany({
      where: { id: userId, usageCount: { gt: 0 } },
      data: { usageCount: { decrement: 1 } },
    });
  }
  ```

- [ ] **Step 4: Run the verify script again — expect PASS**

  ```bash
  DATABASE_URL="file:$ROOT/prisma/test-quota.db?connection_limit=1" npx tsx scripts/verify-clip-quota.ts
  ```

  Expected final line: `✅ ALL 10 CLIP-QUOTA CHECKS PASSED`

  Then clean up the throwaway DB: `rm -f prisma/test-quota.db` (`prisma/*.db` is gitignored, but keep the tree clean).

- [ ] **Step 5: Commit**

  ```bash
  git add src/lib/usage-limits.ts scripts/verify-clip-quota.ts
  git commit -m "$(cat <<'EOF'
  feat(quota): add read-only checkClipQuota helper (verified)

  Read-only peek next to reserveClipUsage so routes can fail fast on
  exhausted quota without double-reserving. Proven by
  scripts/verify-clip-quota.ts (10 checks).

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 1.3: Fail-fast 403 `quota_exceeded` in the render route

Today `reserveClipUsage` is called at `src/app/api/videos/render/route.ts:271` — but only AFTER the route has parsed the body, **cancelled the user's previous in-flight job, and `await`-ed that render to finish** (lines 248–269; this can take minutes and destroys their preview even when the new request is doomed to 403). Both the editor's Render step AND the Burn step POST to this same route, so prod's 25/day "plan limit at the final burn step" failures all come through here. We add a read-only precheck immediately after auth, returning the spec §8 error shape, and convert the existing (kept, still atomic) reservation's 403 to the same shape.

**Files:**
- Modify: `src/app/api/videos/render/route.ts`

- [ ] **Step 1: Import the helper**

  Current code (line 6):

  ```ts
  import { refundClipUsage, reserveClipUsage } from "@/lib/usage-limits";
  ```

  Replace with:

  ```ts
  import { checkClipQuota, refundClipUsage, reserveClipUsage } from "@/lib/usage-limits";
  ```

- [ ] **Step 2: Add the shared 403 response builder**

  Current code (module level, just before the POST handler):

  ```ts
  function saveBundleCache() {
    const tmpDir = getRenderTmpDir();
    const cacheFile = path.join(tmpDir, "remotion-bundle-cache.json");
    try {
      fs.writeFileSync(
        cacheFile,
        JSON.stringify({ bundleLocation: cachedBundleLocation, entryMtime: cachedBundleMtime })
      );
    } catch {}
  }

  export async function POST(req: Request) {
  ```

  Replace with:

  ```ts
  function saveBundleCache() {
    const tmpDir = getRenderTmpDir();
    const cacheFile = path.join(tmpDir, "remotion-bundle-cache.json");
    try {
      fs.writeFileSync(
        cacheFile,
        JSON.stringify({ bundleLocation: cachedBundleLocation, entryMtime: cachedBundleMtime })
      );
    } catch {}
  }

  // Design-doc §8 error contract: { code, provider, message, userAction, retryable }.
  // `detail` duplicates the Thai message as a plain string for legacy clients that
  // render data.error / data.detail directly (e.g. video-creator's ApiCallError message).
  function quotaExceededResponse(message: string) {
    return NextResponse.json(
      {
        error: {
          code: "quota_exceeded",
          provider: "heroai",
          message,
          userAction: "อัปเกรดแพ็กเกจที่หน้า Pricing เพื่อสร้างคลิปต่อ",
          retryable: false,
        },
        detail: message,
      },
      { status: 403 }
    );
  }

  export async function POST(req: Request) {
  ```

- [ ] **Step 3: Insert the precheck before ALL heavy work**

  Current code (inside `POST`, lines 207–213):

  ```ts
      const userId = authUser.id;

      const dbUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { plan: true },
      });
      if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });
  ```

  Replace with:

  ```ts
      const userId = authUser.id;

      // PR-1 fail-fast: เช็คโควต้าก่อนทำงานหนักทุกอย่าง — ก่อน parse body, ก่อนยกเลิก job เดิม
      // ของ user (ซึ่งต้อง await render เก่าจบ อาจกินเวลาหลายนาทีและทำลาย preview เดิม)
      // และก่อน bundle/render ใดๆ. อ่านอย่างเดียว ไม่กินโควต้า — reserveClipUsage ด้านล่าง
      // ยังเป็นตัวจองจริง (atomic) ตัวเดียวเหมือนเดิม จึงไม่มีการจองซ้ำ
      const quotaCheck = await checkClipQuota(userId);
      if (!quotaCheck) return NextResponse.json({ error: "User not found" }, { status: 404 });
      if (!quotaCheck.allowed) return quotaExceededResponse(quotaCheck.message);

      const dbUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { plan: true },
      });
      if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });
  ```

- [ ] **Step 4: Convert the existing reservation 403 to the same shape**

  Current code (lines 271–275):

  ```ts
      const quota = await reserveClipUsage(userId);
      if (!quota) return NextResponse.json({ error: "User not found" }, { status: 404 });
      if (!quota.allowed) return NextResponse.json({ error: quota.message }, { status: 403 });
      quotaReserved = true;
      reservedUserId = userId;
  ```

  Replace with:

  ```ts
      const quota = await reserveClipUsage(userId);
      if (!quota) return NextResponse.json({ error: "User not found" }, { status: 404 });
      // Race guard: คำขออื่นของ user เดียวกันอาจกินโควต้าคลิปสุดท้ายไประหว่าง precheck → reserve
      if (!quota.allowed) return quotaExceededResponse(quota.message);
      quotaReserved = true;
      reservedUserId = userId;
  ```

- [ ] **Step 5: Manual verification (dev)**

  Start dev (`npm run dev`), log in at http://localhost:3000, then exhaust your own quota (substitute your login email; run from the repo root — the explicit absolute `DATABASE_URL` pins the same `prisma/dev.db` the dev server uses, regardless of how `.env` spells its relative path):

  ```bash
  DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx -e "import { prisma } from './src/lib/prisma'; (async () => { await prisma.user.updateMany({ where: { email: 'YOUR_LOGIN_EMAIL' }, data: { usageCount: 9999, usagePeriodStartedAt: new Date() } }); console.log('quota exhausted'); await prisma.\$disconnect(); })();"
  ```

  In the browser DevTools console (any logged-in page):

  ```js
  const r = await fetch("/api/videos/render", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  console.log(r.status, await r.json());
  ```

  Expected — response arrives in **well under 1 second** (the precheck runs before body validation and before the cancel-previous wait):

  ```
  403 { error: { code: "quota_exceeded", provider: "heroai", message: "แพ็กเกจ ... จำกัด ... คลิปต่อ 30 วัน รอบนี้ใช้ครบแล้ว (รีเซ็ต ...)", userAction: "อัปเกรดแพ็กเกจที่หน้า Pricing เพื่อสร้างคลิปต่อ", retryable: false }, detail: "แพ็กเกจ ..." }
  ```

  Restore your quota afterwards (same one-liner with `usageCount: 0`). Also confirm a normal render still works after restoring (run any short script through `/video-editor` RUN — render completes).

- [ ] **Step 6: Commit**

  ```bash
  git add src/app/api/videos/render/route.ts
  git commit -m "$(cat <<'EOF'
  feat(render): fail-fast 403 quota_exceeded before any render work

  Quota is now prechecked (read-only) immediately after auth — before body
  parse, before cancelling the user's in-flight job, before bundling. The
  atomic reserveClipUsage stays where it was (no double reservation); both
  403s now return the structured {code, provider, message, userAction,
  retryable} error shape from the design doc.

  Fixes the prod pattern of 25/day burn failures hitting the plan limit
  only after the full render had already burned CPU.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 1.4: Pure HeyGen poll-status mapper — TDD

`poll-avatar` currently does `data.data?.status ?? "unknown"` with no `res.ok` check, so HeyGen 401/404/402 come back as 200 `"unknown"` and the client polls a dead video for 30 minutes. The status mapping is pure logic, so we extract it into `src/lib/heygen-poll.ts` and prove it with a verify script (no DB needed) before wiring the route.

**Files:**
- Create: `src/lib/heygen-poll.ts`, `scripts/verify-heygen-poll-map.ts`

- [ ] **Step 1: Write the verify script FIRST (it must fail)**

  Create `scripts/verify-heygen-poll-map.ts` with exactly:

  ```ts
  // Proof of the HeyGen poll mapping contract (PR-1, the "kapokja hole").
  // Pure logic — no DB. Run: npx tsx scripts/verify-heygen-poll-map.ts
  import { mapHeygenPollResponse } from "../src/lib/heygen-poll";

  let passed = 0;
  function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

  // 401 → terminal invalid_key (old route returned 200 'unknown' and the client spun 30 min)
  const k = mapHeygenPollResponse({ httpStatus: 401, body: { code: 400112, message: "Unauthorized" } });
  assert(k.status === "failed" && k.error?.code === "invalid_key", "401 → failed/invalid_key");
  assert(k.error!.userAction === "แก้ HeyGen API key ใน Settings", "invalid_key carries the Settings userAction");

  // HeyGen application code 400112 even with HTTP 200 → invalid_key
  const k2 = mapHeygenPollResponse({ httpStatus: 200, body: { code: 400112, message: "Unauthorized" } });
  assert(k2.status === "failed" && k2.error?.code === "invalid_key", "200 + body code 400112 → failed/invalid_key");

  // 404 → terminal not_found
  const nf = mapHeygenPollResponse({ httpStatus: 404, body: null });
  assert(nf.status === "failed" && nf.error?.code === "not_found", "404 → failed/not_found");

  // 402 → terminal insufficient_credit
  const credit = mapHeygenPollResponse({ httpStatus: 402, body: null });
  assert(credit.status === "failed" && credit.error?.code === "insufficient_credit", "402 → failed/insufficient_credit");

  // 429 → keep polling, honor Retry-After
  const rl = mapHeygenPollResponse({ httpStatus: 429, body: null, retryAfterHeader: "12" });
  assert(rl.status === "pending" && rl.retryAfterSec === 12, "429 → pending with Retry-After honored");
  const rl2 = mapHeygenPollResponse({ httpStatus: 429, body: null, retryAfterHeader: null });
  assert(rl2.status === "pending" && rl2.retryAfterSec === 30, "429 without header → pending, default 30s");

  // 5xx and network timeout → pending (polling continues)
  assert(mapHeygenPollResponse({ httpStatus: 503, body: null }).status === "pending", "503 → pending");
  assert(mapHeygenPollResponse({ httpStatus: 0, body: null }).status === "pending", "network timeout (httpStatus 0) → pending");

  // any other 4xx → terminal provider_failed (must NOT spin forever)
  const bad = mapHeygenPollResponse({ httpStatus: 400, body: { code: 40001, message: "Bad request" } });
  assert(bad.status === "failed" && bad.error?.code === "provider_failed", "unknown 4xx → failed/provider_failed");

  // healthy passthrough
  const ok = mapHeygenPollResponse({ httpStatus: 200, body: { code: 100, data: { status: "processing" } } });
  assert(ok.status === "processing" && !ok.error, "200 processing → passthrough, no error");
  const done = mapHeygenPollResponse({ httpStatus: 200, body: { code: 100, data: { status: "completed", video_url: "https://x/y.mp4" } } });
  assert(done.status === "completed" && done.videoUrl === "https://x/y.mp4", "200 completed → videoUrl passthrough");

  // HeyGen-reported failure with a structured error object in data.error
  const hf = mapHeygenPollResponse({ httpStatus: 200, body: { code: 100, data: { status: "failed", error: { code: 40119, message: "Avatar not allowed" } } } });
  assert(hf.status === "failed" && hf.error?.code === "provider_failed" && (hf.errorMsg ?? "").includes("Avatar not allowed"), "200 status=failed → failed with HeyGen detail");

  // 200 with unparseable body (e.g. nginx HTML page) → pending, NOT failed
  assert(mapHeygenPollResponse({ httpStatus: 200, body: null }).status === "pending", "200 + non-JSON body → pending");

  console.log(`\n✅ ALL ${passed} HEYGEN POLL MAP CHECKS PASSED`);
  ```

  Run it — expect FAILURE:

  ```bash
  npx tsx scripts/verify-heygen-poll-map.ts
  ```

  Expected: `Error: Cannot find module '../src/lib/heygen-poll'` (or equivalent resolve error).

- [ ] **Step 2: Create `src/lib/heygen-poll.ts`**

  Full file content:

  ```ts
  // Pure mapper: HeyGen v1 video_status.get HTTP response → /api/videos/poll-avatar payload.
  // No I/O here so scripts/verify-heygen-poll-map.ts can prove the contract:
  //   - invalid key (HTTP 401 หรือ HeyGen code 400112), 404, 402, 4xx อื่นๆ → terminal "failed"
  //   - 429 → "pending" + retryAfterSec (client หน่วงตาม Retry-After)
  //   - network timeout (httpStatus 0) / 5xx / 200 ที่ parse ไม่ได้ → "pending" (poll ต่อ)
  // This closes the "kapokja hole": the old route returned 200 {status:"unknown"} for
  // HeyGen 401/404 and the client kept polling a dead video for 30 minutes.

  export type AvatarPollError = {
    code: "invalid_key" | "not_found" | "insufficient_credit" | "provider_failed";
    provider: "heygen";
    message: string;
    userAction: string;
    retryable: false;
  };

  export type AvatarPollPayload = {
    status: string; // "completed" | "processing" | "pending" | "waiting" | "failed" | ...
    videoUrl: string | null;
    thumbnailUrl: string | null;
    errorMsg: string | null;
    error?: AvatarPollError;
    retryAfterSec?: number;
  };

  function asRecord(v: unknown): Record<string, unknown> | null {
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  }

  function heygenErrorText(err: unknown): string | null {
    if (err == null) return null;
    if (typeof err === "string") return err;
    const rec = asRecord(err);
    if (rec) {
      const parts = [rec.code, rec.message, rec.detail].filter((p) => p != null).map(String);
      if (parts.length > 0) return parts.join(": ");
      try { return JSON.stringify(err); } catch { return String(err); }
    }
    return String(err);
  }

  function pendingPayload(retryAfterSec?: number): AvatarPollPayload {
    return { status: "pending", videoUrl: null, thumbnailUrl: null, errorMsg: null, ...(retryAfterSec ? { retryAfterSec } : {}) };
  }

  function terminalPayload(error: AvatarPollError): AvatarPollPayload {
    return {
      status: "failed",
      videoUrl: null,
      thumbnailUrl: null,
      errorMsg: `${error.message} — ${error.userAction}`,
      error,
    };
  }

  export function mapHeygenPollResponse(input: {
    /** HTTP status of the HeyGen response; 0 = fetch threw (network error / timeout) */
    httpStatus: number;
    /** Parsed JSON body, or null when the body was not JSON */
    body: unknown;
    retryAfterHeader?: string | null;
  }): AvatarPollPayload {
    const { httpStatus, body, retryAfterHeader } = input;
    const rec = asRecord(body);
    const bodyCode = typeof rec?.code === "number" ? rec.code : null;
    const data = asRecord(rec?.data);

    // Invalid API key — HTTP 401 หรือ HeyGen application code 400112 (มาได้แม้ HTTP 200)
    if (httpStatus === 401 || bodyCode === 400112) {
      return terminalPayload({
        code: "invalid_key",
        provider: "heygen",
        message: "HeyGen API key ไม่ถูกต้องหรือหมดอายุ",
        userAction: "แก้ HeyGen API key ใน Settings",
        retryable: false,
      });
    }

    if (httpStatus === 404) {
      return terminalPayload({
        code: "not_found",
        provider: "heygen",
        message: "ไม่พบวิดีโอนี้ใน HeyGen (อาจถูกลบ หรือสร้างไม่สำเร็จ)",
        userAction: "กดสร้าง Avatar ใหม่อีกครั้ง",
        retryable: false,
      });
    }

    if (httpStatus === 402) {
      return terminalPayload({
        code: "insufficient_credit",
        provider: "heygen",
        message: "เครดิต HeyGen ไม่เพียงพอ",
        userAction: "เติมเครดิตในบัญชี HeyGen แล้วลองใหม่",
        retryable: false,
      });
    }

    // Rate limited — poll ต่อได้ แต่ให้ client หน่วงตาม Retry-After
    if (httpStatus === 429) {
      const parsed = Number(retryAfterHeader);
      const retryAfterSec = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 120) : 30;
      return pendingPayload(retryAfterSec);
    }

    // 4xx อื่นๆ = client error ถาวร — poll ต่อก็ไม่มีวันหาย ต้อง fail ทันที
    if (httpStatus >= 400 && httpStatus < 500) {
      const detail = (typeof rec?.message === "string" && rec.message) || heygenErrorText(data?.error) || `HTTP ${httpStatus}`;
      return terminalPayload({
        code: "provider_failed",
        provider: "heygen",
        message: `HeyGen ปฏิเสธคำขอ (${detail})`,
        userAction: "ตรวจสอบ HeyGen API key/เครดิต แล้วลองสร้างใหม่",
        retryable: false,
      });
    }

    // Network error/timeout (0) หรือ HeyGen 5xx — ชั่วคราว poll ต่อ
    if (httpStatus === 0 || httpStatus >= 500) return pendingPayload();

    // 2xx — อ่าน envelope ของ HeyGen { code, data: { status, video_url, thumbnail_url, error } }
    const status = typeof data?.status === "string" ? data.status : null;
    if (!status) return pendingPayload(); // 200 แต่ body ไม่ใช่รูปแบบที่รู้จัก (เช่น proxy คั่น) — ชั่วคราว

    if (status === "failed") {
      const detail = heygenErrorText(data?.error);
      return {
        status: "failed",
        videoUrl: null,
        thumbnailUrl: typeof data?.thumbnail_url === "string" ? data.thumbnail_url : null,
        errorMsg: detail ?? "HeyGen แจ้งว่าสร้างวิดีโอไม่สำเร็จ",
        error: {
          code: "provider_failed",
          provider: "heygen",
          message: detail ? `HeyGen สร้างวิดีโอไม่สำเร็จ: ${detail}` : "HeyGen สร้างวิดีโอไม่สำเร็จ",
          userAction: "ตรวจสอบ Avatar ID และเครดิตใน HeyGen แล้วลองใหม่",
          retryable: false,
        },
      };
    }

    return {
      status,
      videoUrl: typeof data?.video_url === "string" ? data.video_url : null,
      thumbnailUrl: typeof data?.thumbnail_url === "string" ? data.thumbnail_url : null,
      errorMsg: null,
    };
  }
  ```

- [ ] **Step 3: Run the verify script again — expect PASS**

  ```bash
  npx tsx scripts/verify-heygen-poll-map.ts
  ```

  Expected final line: `✅ ALL 14 HEYGEN POLL MAP CHECKS PASSED`

- [ ] **Step 4: Commit**

  ```bash
  git add src/lib/heygen-poll.ts scripts/verify-heygen-poll-map.ts
  git commit -m "$(cat <<'EOF'
  feat(heygen): add pure HeyGen poll-status mapper (verified)

  Maps video_status.get responses to terminal vs transient statuses:
  401/400112 -> invalid_key, 404 -> not_found, 402 -> insufficient_credit,
  other 4xx -> provider_failed (all terminal); 429 -> pending+retryAfterSec;
  5xx/timeout/non-JSON -> pending. 14-check verify script included.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 1.5: Rewrite `/api/videos/poll-avatar` on top of the mapper

Callers of this route (verified): the video-editor loops updated in Task 1.6, AND `src/app/(dashboard)/video-creator/page.tsx`, which polls it in two loops (fetches at ~line 1326 and ~1384). Both video-creator loops already `throw` on `pollData.status === "failed"` with `errorMsg` (lines ~1343–1345 and ~1391), so they pick up this fix with **no code changes** — terminal errors that used to come back as `"unknown"` (infinite spin) now stop their loops immediately with the Thai `errorMsg`. (`src/app/api/heygen/test-avatar/route.ts:77` mentions this route only in a comment.)

**Files:**
- Modify: `src/app/api/videos/poll-avatar/route.ts`

- [ ] **Step 1: Replace the entire file**

  The current file (59 lines) fetches HeyGen with no timeout, never checks `res.ok`, logs the full body every poll, and returns `data.data?.status ?? "unknown"`. Replace `src/app/api/videos/poll-avatar/route.ts` with exactly:

  ```ts
  import { NextResponse } from "next/server";
  import { getCurrentUser } from "@/lib/clerk-auth";
  import { prisma } from "@/lib/prisma";
  import { mapHeygenPollResponse } from "@/lib/heygen-poll";

  export const maxDuration = 30;
  export const runtime = "nodejs";

  function decrypt(encrypted: string): string {
    return Buffer.from(encrypted, "base64").toString("utf-8");
  }

  // POST /api/videos/poll-avatar
  // Body: { videoId: string }
  // Returns AvatarPollPayload (src/lib/heygen-poll.ts):
  //   { status, videoUrl, thumbnailUrl, errorMsg, error?, retryAfterSec? }
  // Contract: terminal HeyGen errors (key ผิด / ไม่พบวิดีโอ / เครดิตหมด / 4xx อื่นๆ) กลับมาเป็น
  // status "failed" พร้อม `error` แบบมีโครงสร้าง — client ต้องหยุด poll ทันที
  // เฉพาะ rate limit (429), HeyGen 5xx และ network timeout เท่านั้นที่ได้ "pending" (poll ต่อ)
  export async function POST(req: Request) {
    try {
      const authUser = await getCurrentUser();
      if (!authUser) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const body = await req.json().catch(() => null);
      const videoId: string = body?.videoId ?? "";
      if (!videoId) return NextResponse.json({ error: "videoId required" }, { status: 400 });

      const user = await prisma.user.findUnique({
        where: { id: authUser.id },
        select: { heygenKey: true },
      });

      if (!user?.heygenKey) {
        return NextResponse.json({ error: "HeyGen API key not set", missingKey: "heygen" }, { status: 400 });
      }

      const heygenKey = decrypt(user.heygenKey);

      let httpStatus = 0;
      let heygenBody: unknown = null;
      let retryAfterHeader: string | null = null;
      try {
        const res = await fetch(
          `https://api.heygen.com/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`,
          { headers: { "X-Api-Key": heygenKey }, signal: AbortSignal.timeout(20000) }
        );
        httpStatus = res.status;
        retryAfterHeader = res.headers.get("retry-after");
        heygenBody = await res.json().catch(() => null);
      } catch {
        // network error / timeout — httpStatus คงเป็น 0 → mapper คืน "pending" ให้ poll ต่อ
      }

      const payload = mapHeygenPollResponse({ httpStatus, body: heygenBody, retryAfterHeader });
      if (payload.status === "failed") {
        console.warn(`[poll-avatar] terminal http=${httpStatus} code=${payload.error?.code ?? "provider"} video=${videoId}`);
      }
      return NextResponse.json(payload);
    } catch (error) {
      console.error("poll-avatar error:", error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Poll failed" },
        { status: 500 }
      );
    }
  }
  ```

- [ ] **Step 2: Manual verification (dev)**

  With dev running and a **valid** HeyGen key set in Settings, run in the browser console:

  ```js
  const r = await fetch("/api/videos/poll-avatar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoId: "nonexistent-id-123" }) });
  console.log(r.status, await r.json());
  ```

  Expected: `200` with `status: "failed"` and `error.code` of `"not_found"` **or** `"provider_failed"` (HeyGen returns 404 or a 4xx envelope for unknown ids — both are terminal). The old behavior was `status: "unknown"` — if you see `"unknown"`, the fix is not in effect.

  Now corrupt your key in the DB (the stored key is base64-encoded; the absolute `DATABASE_URL` pins the dev server's `prisma/dev.db`):

  ```bash
  DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx -e "import { prisma } from './src/lib/prisma'; (async () => { const bad = Buffer.from('invalid-key-test').toString('base64'); await prisma.user.updateMany({ where: { email: 'YOUR_LOGIN_EMAIL' }, data: { heygenKey: bad } }); console.log('heygen key corrupted'); await prisma.\$disconnect(); })();"
  ```

  Re-run the console fetch. Expected:

  ```
  200 { status: "failed", videoUrl: null, thumbnailUrl: null, errorMsg: "HeyGen API key ไม่ถูกต้องหรือหมดอายุ — แก้ HeyGen API key ใน Settings", error: { code: "invalid_key", provider: "heygen", message: "HeyGen API key ไม่ถูกต้องหรือหมดอายุ", userAction: "แก้ HeyGen API key ใน Settings", retryable: false } }
  ```

  Restore your real HeyGen key via Settings → API keys before continuing.

- [ ] **Step 3: Commit**

  ```bash
  git add src/app/api/videos/poll-avatar/route.ts
  git commit -m "$(cat <<'EOF'
  fix(avatar): poll-avatar fails fast on HeyGen 401/404/402 (kapokja hole)

  The route now checks the HTTP status and HeyGen error codes via the
  verified mapper instead of returning 200 {status:"unknown"} for every
  non-success — which made the editor poll a dead video for 30 minutes.
  Adds a 20s fetch timeout (timeout -> "pending", polling continues) and
  drops the per-poll full-body console.log.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 1.6: Editor avatar loops — honor terminal statuses, survive network blips

The main loop in `runAvatar` already throws on `status === "failed"`, but builds the message from `errorMsg` only; `runAvatarTail`'s loop has **no try/catch around its fetch** — one network blip throws out of a pipeline that may have been running 30 minutes. Both loops now share a typed payload + Thai failure-message builder and honor `retryAfterSec`.

**Files:**
- Modify: `src/app/(dashboard)/video-editor/page.tsx`

- [ ] **Step 1: Add the shared poll-payload type + failure-message helper**

  Current code (the `HEYGEN_FRAMING` block, ~line 1684):

  ```ts
    // HeyGen เจนด้วยเฟรมมาตรฐานที่พิสูจน์แล้ว "เสมอ" — ตำแหน่ง/ขนาดของผู้ใช้ทำที่ composite (เลเยอร์ ffmpeg)
    // ทำให้ preview ตรงกับผลจริง 100% และเปลี่ยนตำแหน่งได้โดยไม่ต้องเจน HeyGen ใหม่ (ไม่เปลือง credit)
    const HEYGEN_FRAMING = { scale: 2.02, offsetX: 0, offsetY: 0.13 } as const;
  ```

  Replace with:

  ```ts
    // HeyGen เจนด้วยเฟรมมาตรฐานที่พิสูจน์แล้ว "เสมอ" — ตำแหน่ง/ขนาดของผู้ใช้ทำที่ composite (เลเยอร์ ffmpeg)
    // ทำให้ preview ตรงกับผลจริง 100% และเปลี่ยนตำแหน่งได้โดยไม่ต้องเจน HeyGen ใหม่ (ไม่เปลือง credit)
    const HEYGEN_FRAMING = { scale: 2.02, offsetX: 0, offsetY: 0.13 } as const;

    // Payload จาก /api/videos/poll-avatar (ดู src/lib/heygen-poll.ts) — `error` คือ terminal error แบบมีโครงสร้าง
    type AvatarPollData = {
      status?: string;
      videoUrl?: string | null;
      errorMsg?: string | null;
      error?: { code?: string; message?: string; userAction?: string } | null;
      retryAfterSec?: number;
    };

    function avatarFailureMessage(pollData: AvatarPollData, fallbackPrefix: string): string {
      if (pollData.error?.message) {
        return pollData.error.userAction
          ? `${pollData.error.message} — ${pollData.error.userAction}`
          : pollData.error.message;
      }
      return `${fallbackPrefix}: ${pollData.errorMsg ?? "unknown"}`;
    }
  ```

- [ ] **Step 2: Update the main `runAvatar` poll loop**

  Current code (inside the `for (let i = 0; i < 360; i++)` loop of `runAvatar`, ~lines 1737–1753):

  ```ts
        // try ครอบเฉพาะ fetch/parse (ข้าม tick เมื่อ network พลาดชั่วคราว) — แต่สถานะ "failed" จาก HeyGen
        // ต้อง throw ออกไปถึง catch ของ pipeline ไม่งั้นจะ poll วิดีโอที่ตายแล้วต่ออีก 30 นาที (อาการ "ค้าง")
        let pollData: { status?: string; videoUrl?: string | null; errorMsg?: string | null } = {};
        try {
          const pollRes = await fetch("/api/videos/poll-avatar", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoId: heygenVideoId }),
            signal: abortControllerRef.current?.signal,
          });
          pollData = await pollRes.json();
        } catch (e) {
          if (e instanceof Error && (e.name === "AbortError" || e.message === "__SUPERSEDED__")) throw e;
          continue;
        }
        if (pollData.status === "completed" && pollData.videoUrl) { avatarVideoUrl = pollData.videoUrl; break; }
        if (pollData.status === "failed") throw new Error(`Avatar failed: ${pollData.errorMsg ?? "unknown"}`);
        setStep("avatar", "running", `HeyGen: ${pollData.status} (${i + 1}) ~${Math.round((i + 1) * 5 / 60)}min`);
  ```

  Replace with:

  ```ts
        // try ครอบเฉพาะ fetch/parse (ข้าม tick เมื่อ network พลาดชั่วคราว) — แต่สถานะ "failed" จาก HeyGen
        // ต้อง throw ออกไปถึง catch ของ pipeline ไม่งั้นจะ poll วิดีโอที่ตายแล้วต่ออีก 30 นาที (อาการ "ค้าง")
        let pollData: AvatarPollData = {};
        try {
          const pollRes = await fetch("/api/videos/poll-avatar", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoId: heygenVideoId }),
            signal: abortControllerRef.current?.signal,
          });
          pollData = await pollRes.json();
        } catch (e) {
          if (e instanceof Error && (e.name === "AbortError" || e.message === "__SUPERSEDED__")) throw e;
          continue;
        }
        if (pollData.status === "completed" && pollData.videoUrl) { avatarVideoUrl = pollData.videoUrl; break; }
        // Terminal จาก server (key ผิด / ไม่พบวิดีโอ / เครดิตหมด / HeyGen fail) → ล้มทันที ไม่วนต่อ 30 นาที
        if (pollData.status === "failed") throw new Error(avatarFailureMessage(pollData, "Avatar failed"));
        // HeyGen ขอให้รอ (429) — เคารพ Retry-After ก่อน poll รอบถัดไป (ลูปนี้หน่วงเองอยู่แล้ว 5s)
        const retrySec = pollData.retryAfterSec;
        if (retrySec && retrySec > 5) await new Promise(r => setTimeout(r, (retrySec - 5) * 1000));
        setStep("avatar", "running", `HeyGen: ${pollData.status} (${i + 1}) ~${Math.round((i + 1) * 5 / 60)}min`);
  ```

- [ ] **Step 3: Update the `runAvatarTail` poll loop (currently one network blip kills the pipeline)**

  Current code (inside `runAvatarTail`, ~lines 1831–1844):

  ```ts
      let tailUrl = "";
      for (let i = 0; i < 360; i++) {
        await new Promise(r => setTimeout(r, 5000));
        if (abortRef.current) throw new Error("__SUPERSEDED__");
        const pollRes = await fetch("/api/videos/poll-avatar", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId: genData.videoId }),
          signal: abortControllerRef.current?.signal,
        });
        const pollData = await pollRes.json();
        if (pollData.status === "completed" && pollData.videoUrl) { tailUrl = pollData.videoUrl; break; }
        if (pollData.status === "failed") throw new Error(`Tail avatar failed: ${pollData.errorMsg}`);
      }
      if (!tailUrl) throw new Error("Tail avatar: timeout");
  ```

  Replace with:

  ```ts
      let tailUrl = "";
      for (let i = 0; i < 360; i++) {
        await new Promise(r => setTimeout(r, 5000));
        if (abortRef.current) throw new Error("__SUPERSEDED__");
        // เหมือน loop หลักของ runAvatar: network พลาดชั่วคราว = ข้าม tick — ห้ามฆ่า pipeline ทั้งเส้น
        let pollData: AvatarPollData = {};
        try {
          const pollRes = await fetch("/api/videos/poll-avatar", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoId: genData.videoId }),
            signal: abortControllerRef.current?.signal,
          });
          pollData = await pollRes.json();
        } catch (e) {
          if (e instanceof Error && (e.name === "AbortError" || e.message === "__SUPERSEDED__")) throw e;
          continue;
        }
        if (pollData.status === "completed" && pollData.videoUrl) { tailUrl = pollData.videoUrl; break; }
        if (pollData.status === "failed") throw new Error(avatarFailureMessage(pollData, "Tail avatar failed"));
        const retrySec = pollData.retryAfterSec;
        if (retrySec && retrySec > 5) await new Promise(r => setTimeout(r, (retrySec - 5) * 1000));
        setStep("avatarTail", "running", `HeyGen tail: ${pollData.status ?? "pending"} (${i + 1})`);
      }
      if (!tailUrl) throw new Error("Tail avatar: timeout");
  ```

- [ ] **Step 4: Quick compile sanity check**

  With `npm run dev` running, load `/video-editor` in the browser. Expected: page renders with no red overlay / no TypeScript compile error in the dev terminal. (Full behavior is exercised in Task 1.8.)

- [ ] **Step 5: Commit**

  ```bash
  git add "src/app/(dashboard)/video-editor/page.tsx"
  git commit -m "$(cat <<'EOF'
  fix(avatar): editor loops honor terminal poll statuses; tail loop survives network blips

  Both poll loops now show the structured Thai error (message + userAction)
  the moment poll-avatar reports a terminal status, honor 429 retryAfterSec,
  and runAvatarTail gets the same transient-fetch tolerance as the main
  loop (previously one blip killed a 30-min pipeline).

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 1.7: Frontend `quota_exceeded` → Upgrade modal with pricing link

The render route's 403 body changed from `{ error: string }` to `{ error: { code, message, userAction, ... } }`. The editor's `handlePlanError`/`friendlyError` would render `[object Object]`; video-creator (the other caller of this route) has its own `friendlyError` with the same problem. Fix all three display paths and route the burn path's 403 into the existing `UpgradeModal` (which already has the "ดูแผนราคา — อัปเกรดเลย" button navigating to `/pricing` — see `src/components/ui/upgrade-modal.tsx:63`).

**Files:**
- Modify: `src/app/(dashboard)/video-editor/page.tsx`, `src/app/(dashboard)/video-creator/page.tsx`

- [ ] **Step 1: Editor — make `handlePlanError` understand the structured shape**

  Current code (`video-editor/page.tsx` ~lines 865–879):

  ```ts
    function handlePlanError(err: unknown): boolean {
      if (err instanceof ApiCallError && (err.data as any)._status === 403) {
        setUpgradeModal({ open: true, message: String(err.data.error ?? "") });
        return true;
      }
      // check via message contains "403"
      if (err instanceof ApiCallError) {
        const status = (err.data as any)._status;
        if (status === 403) {
          setUpgradeModal({ open: true, message: String(err.data.error ?? "") });
          return true;
        }
      }
      return false;
    }
  ```

  Replace with:

  ```ts
    function handlePlanError(err: unknown): boolean {
      if (!(err instanceof ApiCallError)) return false;
      if ((err.data as any)._status !== 403) return false;
      // PR-1 structured shape: { error: { code: "quota_exceeded", message, userAction } }
      const rawErr = err.data.error;
      const structured = typeof rawErr === "object" && rawErr !== null
        ? (rawErr as { code?: string; message?: string; userAction?: string })
        : null;
      const message = structured
        ? [structured.message, structured.userAction].filter(Boolean).join(" — ")
        : String(rawErr ?? "");
      setUpgradeModal({ open: true, message });
      return true;
    }
  ```

- [ ] **Step 2: Editor — make `friendlyError` understand the structured shape**

  Current code (`video-editor/page.tsx` ~lines 886–890):

  ```ts
      if (err instanceof ApiCallError) {
        const status = (err.data as any)._status as number | undefined;
        const errMsg = String(err.data.error ?? "");
        if (status === 429 && errMsg) return errMsg;
        // Key ตั้งไว้แล้วแต่ invalid — บอกรายละเอียดแทนการให้ใส่ซ้ำ
  ```

  Replace with:

  ```ts
      if (err instanceof ApiCallError) {
        const status = (err.data as any)._status as number | undefined;
        // PR-1 structured errors: { error: { code, message, userAction } } — เช่น quota_exceeded
        const structuredErr = typeof err.data.error === "object" && err.data.error !== null
          ? (err.data.error as { code?: string; message?: string; userAction?: string })
          : null;
        const errMsg = structuredErr
          ? [structuredErr.message, structuredErr.userAction].filter(Boolean).join(" — ")
          : String(err.data.error ?? "");
        if (status === 429 && errMsg) return errMsg;
        // Key ตั้งไว้แล้วแต่ invalid — บอกรายละเอียดแทนการให้ใส่ซ้ำ
  ```

  Note: `runAll` (catch at ~line 2052) and `runFrom`/`runRenderOnly` already call `handlePlanError(err)` first — with Steps 1–2 they now show the Thai quota message in the Upgrade modal with the `/pricing` button. No change needed inside `runAll` itself.

- [ ] **Step 3: Editor — burn path: throw `ApiCallError` instead of a plain string error**

  Current code (`burnSubtitlesCore`, ~lines 2279–2285):

  ```ts
        const res = await fetch("/api/videos/render", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subtitleOverlayConfig }),
          signal: abortControllerRef.current?.signal,
        });
        const data = await res.json() as { jobId?: string; videoUrl?: string; error?: string };
        if (!res.ok) throw new Error(data.error ?? "Burn subtitles failed");
  ```

  Replace with:

  ```ts
        const res = await fetch("/api/videos/render", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subtitleOverlayConfig }),
          signal: abortControllerRef.current?.signal,
        });
        const data = await res.json() as { jobId?: string; videoUrl?: string; error?: unknown };
        // โยน ApiCallError เพื่อให้ catch ด้านล่างส่ง 403 quota_exceeded ไปเปิด Upgrade modal
        // (มีปุ่มไปหน้า /pricing) แทน toast ข้อความ error ทั่วไป
        assertOk("Burn", res, data as Record<string, unknown>);
  ```

- [ ] **Step 4: Editor — burn path catch: route quota errors to the Upgrade modal**

  Current code (`burnSubtitlesCore` catch, ~lines 2361–2368):

  ```ts
      } catch (err) {
        if (err instanceof Error && (err.name === "AbortError" || err.message === "__SUPERSEDED__")) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        setStep("burnSubtitles", "error", msg);
        setRenderActivity({ phase: "idle", label: "", queuePosition: null, startedAt: null });
        if (toastOnError) toast.error(msg);
        throw err;
      } finally {
  ```

  Replace with:

  ```ts
      } catch (err) {
        if (err instanceof Error && (err.name === "AbortError" || err.message === "__SUPERSEDED__")) throw err;
        const msg = friendlyError(err);
        setStep("burnSubtitles", "error", msg);
        setRenderActivity({ phase: "idle", label: "", queuePosition: null, startedAt: null });
        // โควต้าคลิปหมด (403 quota_exceeded) → เปิด Upgrade modal พร้อมลิงก์หน้า Pricing แทน toast
        if (handlePlanError(err)) throw err;
        if (toastOnError) toast.error(msg);
        throw err;
      } finally {
  ```

- [ ] **Step 5: video-creator — structured-error guard in its `friendlyError`**

  Current code (`src/app/(dashboard)/video-creator/page.tsx` ~lines 632–637):

  ```ts
      if (err instanceof ApiCallError) {
        const status = (err.data as any)._status as number | undefined;
        const errMsg = String(err.data.error ?? "");
        if (status === 429 && errMsg) return errMsg;
        if (err.data.provider === "gemini" && errMsg) return errMsg;
      }
  ```

  Replace with:

  ```ts
      if (err instanceof ApiCallError) {
        const status = (err.data as any)._status as number | undefined;
        // PR-1 structured errors จาก /api/videos/render: { error: { code, message, userAction } }
        const structuredErr = typeof err.data.error === "object" && err.data.error !== null
          ? (err.data.error as { code?: string; message?: string; userAction?: string })
          : null;
        if (structuredErr?.message) {
          return [structuredErr.message, structuredErr.userAction].filter(Boolean).join(" — ");
        }
        const errMsg = String(err.data.error ?? "");
        if (status === 429 && errMsg) return errMsg;
        if (err.data.provider === "gemini" && errMsg) return errMsg;
      }
  ```

- [ ] **Step 6: Manual verification (dev)**

  Exhaust quota again (one-liner from Task 1.3 Step 5 with `usageCount: 9999`). Then in `/video-editor` with an existing rendered preview (or run one before exhausting):
  - Click **Burn & Download** → expect the Upgrade modal: title "ฟีเจอร์นี้ใช้ได้เฉพาะแผน Pro", body "แพ็กเกจ ... จำกัด ... คลิปต่อ 30 วัน รอบนี้ใช้ครบแล้ว (รีเซ็ต ...) — อัปเกรดแพ็กเกจที่หน้า Pricing เพื่อสร้างคลิปต่อ", button "ดูแผนราคา — อัปเกรดเลย" navigates to `/pricing`. NO generic "[object Object]" anywhere, NO long render attempt before the modal.
  - Click **RUN** (full pipeline) → the pipeline stops at the Render step with the same modal.
  - Restore quota (`usageCount: 0`), confirm render + burn complete normally.

- [ ] **Step 7: Commit**

  ```bash
  git add "src/app/(dashboard)/video-editor/page.tsx" "src/app/(dashboard)/video-creator/page.tsx"
  git commit -m "$(cat <<'EOF'
  feat(editor): quota_exceeded shows upgrade modal with pricing link

  handlePlanError/friendlyError (editor) and friendlyError (creator) now
  read the structured { error: { code, message, userAction } } 403 body;
  the burn path throws ApiCallError and routes quota errors to the
  existing UpgradeModal (-> /pricing) instead of a generic toast.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 1.8: Full verification + open the PR

**Files:** none

- [ ] **Step 1: Re-run both verify scripts (regression gate)**

  ```bash
  cd /Users/mewsocialmacmini/projects/AI_content_Mew_social
  npx tsx scripts/verify-heygen-poll-map.ts
  ROOT="$(pwd)"
  DATABASE_URL="file:$ROOT/prisma/test-quota.db" npx prisma db push --skip-generate --accept-data-loss
  DATABASE_URL="file:$ROOT/prisma/test-quota.db?connection_limit=1" npx tsx scripts/verify-clip-quota.ts
  rm -f prisma/test-quota.db
  ```

  Expected: `✅ ALL 14 HEYGEN POLL MAP CHECKS PASSED` and `✅ ALL 10 CLIP-QUOTA CHECKS PASSED`.

- [ ] **Step 2: Production build check**

  ```bash
  npm run build
  ```

  Expected: build completes with `✓ Compiled successfully` and no type errors. (Do NOT skip — `main` deploys straight to prod. Note: `tsconfig.json` excludes `scripts/` from the build typecheck, so the two verify scripts are covered by Step 1's tsx runs, not by this build.)

- [ ] **Step 3: Full manual flow check (dev, per design doc §9)**

  1. **Normal flow:** `/video-editor` → paste a short Thai script → RUN → preview renders → edit a subtitle → Burn & Download → burned file downloads. Expected: identical to before this PR.
  2. **Kapokja simulation (key dies mid-poll):** with a valid HeyGen key, start the avatar pipeline; while the step shows `HeyGen: processing...`, corrupt the key (one-liner from Task 1.5 Step 2). Expected: within ~5 s the avatar step flips to error with "HeyGen API key ไม่ถูกต้องหรือหมดอายุ — แก้ HeyGen API key ใน Settings", a toast appears with the "ไปที่ Settings" action, the spinner stops, and the Network tab shows NO further `poll-avatar` requests. Restore the real key afterwards.
  3. **Quota flow:** already verified in Task 1.7 Step 6 — re-confirm RUN and Burn both show the Upgrade modal instantly when exhausted, then restore `usageCount: 0`.

- [ ] **Step 4: Push and open the PR**

  ```bash
  git push -u origin mew/quota-precheck-avatar-errors
  gh pr create --title "PR-1: fail-fast quota + close the kapokja hole" --body "$(cat <<'EOF'
  Part 1 of the video-editor optimization plan (docs/superpowers/specs/2026-06-10-video-editor-optimization-design.md, Phase 1 PR-1). Deploy AFTER PR-4 per the design's deploy order.

  ## What
  - **Fail-fast quota:** `/api/videos/render` now does a read-only quota precheck immediately after auth — before body parse, before cancelling/awaiting the user's previous render, before any bundle/render work. Exhausted quota returns a structured 403 `{ error: { code: "quota_exceeded", provider, message, userAction, retryable } }` (+ `detail` string for legacy clients). The atomic `reserveClipUsage` stays as the single reservation point — no double-charge. Targets the 25/day prod burn failures that hit the plan limit only after the render burned CPU.
  - **Kapokja hole:** `/api/videos/poll-avatar` no longer returns 200 `status:"unknown"` for HeyGen errors. New pure mapper (`src/lib/heygen-poll.ts`): 401/code-400112 → `invalid_key`, 404 → `not_found`, 402 → `insufficient_credit`, other 4xx → `provider_failed` (all terminal); 429 → pending + `retryAfterSec`; 5xx/timeout/non-JSON → pending. 20 s fetch timeout added.
  - **Editor:** both avatar poll loops fail immediately on terminal statuses with the Thai message (+ "ไปที่ Settings" toast action); `runAvatarTail` now tolerates transient network errors like the main loop (one blip no longer kills a 30-min pipeline). 403 `quota_exceeded` from RUN or Burn opens the existing UpgradeModal with the /pricing button. (video-creator's two avatar poll loops already throw on `status:"failed"` — verified, they pick up the poll-avatar fix with no changes.)

  ## Tests
  - `scripts/verify-clip-quota.ts` — 10 checks (throwaway SQLite): peek is read-only, reserve/refund/exhaustion, Thai message.
  - `scripts/verify-heygen-poll-map.ts` — 14 checks: every terminal/transient mapping incl. Retry-After and non-JSON bodies.
  - Manual: normal render→edit→burn unchanged; key-corrupted-mid-poll fails in ~5 s with Settings action; exhausted quota shows Upgrade modal instantly on both RUN and Burn.

  ## Review points for wao
  - `src/app/api/videos/render/route.ts` and `src/app/api/videos/poll-avatar/route.ts` are in your vertical — please review the precheck placement (before the cancel-previous `await prevDone` wait) and the HeyGen status mapping.
  - 403 error shape from the render route changed from `{error: string}` to the structured object; both callers (video-editor, video-creator) were updated, and `detail` keeps a plain string for anything else.
  - poll-avatar no longer emits `status:"unknown"` and no longer logs the full HeyGen body every poll.

  No schema / package.json / next.config.ts changes. Rollback = revert the merge commit.

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```

  Expected output: a GitHub PR URL like `https://github.com/<org>/<repo>/pull/<n>`.

---

# (section) PR-2

## PR-2: Polling can never hang forever

This PR replaces the video editor's three overlapping client poll loops (render: 600ms progress + 3s status; burn: 600ms progress + 2s `checkOnce` doing 2 GETs) with one shared, hardened `pollJob` helper: single in-flight request, exponential backoff on transient errors, tolerance for non-JSON 502/504 bodies (today a Nginx 502 HTML page makes `res.json()` throw and rejects the whole burn while the server keeps burning), a 10-minute no-progress-change stale timeout, and AbortSignal support — plus an unmount cleanup so loops stop leaking across SPA navigation. **Risk: medium — this touches the editor's main render/burn flow; run the full manual matrix in Task 2.5 before merging.** Rollback: revert the single PR (no schema, no API route, no shared-file changes). Deliberately OUT of scope: (1) the mount-time URL-jobId auto-cancel and the `beforeunload` sendBeacon cancel keep their exact current semantics — changing those (refresh-resume) is Phase 2 PR-9; (2) the HeyGen avatar 5s `for`-loops (`runAvatar` / `runAvatarTail`) are NOT converted to `pollJob` — they are already sequential single-in-flight loops with a hard 360-tick (30-min) cap, PR-1 (which lands first) edits those same lines for terminal-status handling, and Task 2.4 below stops them on unmount; that covers the spec's no-hang + no-leak obligations for avatar without colliding with PR-1.

Branch: `mew/polling-hardening`. Deploy order per spec section 5: after PR-4 and PR-1.

---

### Task 2.1: `pollJob` helper (TDD: verify script first)

**Files:**
- Create: `src/app/(dashboard)/video-editor/_lib/poll-job.ts`
- Test: `scripts/verify-poll-job.ts` (Create)

- [ ] **Step 1: Create the branch**

```bash
cd /Users/mewsocialmacmini/projects/AI_content_Mew_social
git checkout main && git pull origin main
git checkout -b mew/polling-hardening
git status --porcelain
```

Expected output: branch switches to `mew/polling-hardening`; `git status --porcelain` shows only untracked `?? docs/...` entries (pre-existing, leave them alone) — nothing staged, nothing modified.

- [ ] **Step 2: Write the FAILING verify script**

Create `scripts/verify-poll-job.ts` with exactly this content (matches the repo's `verify-*.ts` pattern — plain assertions, `npx tsx`, exit 1 on failure):

```ts
// Verify pollJob — the shared hardened poll loop for render/burn.
// Run: npx tsx scripts/verify-poll-job.ts
import {
  pollJob, nextBackoffDelay,
  PollStaleError, PollAbortError, PollFailedError, PollTransientLimitError,
} from "../src/app/(dashboard)/video-editor/_lib/poll-job";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}

async function main() {
  // (a) 502 HTML body → res.json() throws SyntaxError → transient, retried, NOT fatal
  {
    let calls = 0;
    const result = await pollJob<string>({
      intervalMs: 5,
      staleTimeoutMs: 60_000,
      backoffCapMs: 10,
      fetchOnce: async () => {
        calls++;
        if (calls <= 2) {
          // exactly what r.json() does when Nginx serves a 502 HTML error page
          JSON.parse("<html><body>502 Bad Gateway</body></html>");
        }
        return { status: "done", value: "https://example.com/out.mp4" };
      },
    });
    check("(a) 502-HTML is retried, not fatal",
      result === "https://example.com/out.mp4" && calls === 3,
      `calls=${calls} result=${result}`);
  }

  // (b) frozen progress → rejects with PollStaleError, code "stale"
  {
    let err: unknown = null;
    try {
      await pollJob<string>({
        intervalMs: 5,
        staleTimeoutMs: 40,
        fetchOnce: async () => ({ status: "pending", progress: 42 }),
      });
    } catch (e) { err = e; }
    check("(b) stale timeout fires when progress frozen",
      err instanceof PollStaleError && err.code === "stale", String(err));
  }

  // (b2) changing progress keeps resetting the stale clock — never goes stale
  {
    let p = 0; let err: unknown = null; let result = "";
    const seen: number[] = [];
    try {
      result = await pollJob<string>({
        intervalMs: 5,
        staleTimeoutMs: 40,
        onProgress: v => seen.push(v),
        fetchOnce: async () => {
          p++;
          if (p >= 20) return { status: "done", value: "ok" }; // ~100ms total > 40ms stale window
          return { status: "pending", progress: p };
        },
      });
    } catch (e) { err = e; }
    check("(b2) changing progress never goes stale + onProgress fires",
      err === null && result === "ok" && seen.length === 19 && seen[0] === 1,
      `err=${String(err)} seen=${seen.length}`);
  }

  // (c) backoff: 1.5x growth, hard cap
  {
    check("(c1) backoff grows 1.5x", nextBackoffDelay(2000, 15_000) === 3000,
      `got ${nextBackoffDelay(2000, 15_000)}`);
    let d = 2000;
    for (let i = 0; i < 20; i++) d = nextBackoffDelay(d, 15_000);
    check("(c2) backoff caps at 15s", d === 15_000, `d=${d}`);
    let err: unknown = null; let calls = 0;
    try {
      await pollJob<string>({
        intervalMs: 1, backoffCapMs: 2, staleTimeoutMs: 60_000, maxTransientErrors: 5,
        fetchOnce: async () => { calls++; throw new Error("boom"); },
      });
    } catch (e) { err = e; }
    check("(c3) gives up after maxTransientErrors consecutive errors",
      err instanceof PollTransientLimitError && calls === 5, `calls=${calls} err=${String(err)}`);
  }

  // (d) abort stops cleanly with name === "AbortError" (existing catch blocks rely on it)
  {
    const ac = new AbortController();
    let calls = 0;
    const pending = pollJob<string>({
      intervalMs: 5, staleTimeoutMs: 60_000, signal: ac.signal,
      fetchOnce: async () => { calls++; return { status: "pending", progress: 1 }; },
    });
    setTimeout(() => ac.abort(), 25);
    let err: unknown = null;
    try { await pending; } catch (e) { err = e; }
    const callsAtAbort = calls;
    await new Promise(r => setTimeout(r, 30));
    check("(d) abort rejects with AbortError and polling stops",
      err instanceof PollAbortError && (err as Error).name === "AbortError" && calls === callsAtAbort,
      `err=${String(err)} calls=${calls} callsAtAbort=${callsAtAbort}`);
  }

  // (e) a "failed" tick is terminal and carries the job's error message
  {
    let err: unknown = null;
    try {
      await pollJob<string>({
        intervalMs: 5,
        fetchOnce: async () => ({ status: "failed", error: "Render failed: out of memory" }),
      });
    } catch (e) { err = e; }
    check("(e) job failure is terminal with original message",
      err instanceof PollFailedError && (err as Error).message === "Render failed: out of memory",
      String(err));
  }

  if (failures > 0) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nALL PASS");
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run it — expect FAILURE (module does not exist yet)**

```bash
npx tsx scripts/verify-poll-job.ts
```

Expected output (verified): non-zero exit with

```
Error: Cannot find module '../src/app/(dashboard)/video-editor/_lib/poll-job'
Require stack:
- .../scripts/verify-poll-job.ts
```

If it says ALL PASS, something is wrong — stop and investigate.

- [ ] **Step 4: Implement the helper**

Create the directory and file `src/app/(dashboard)/video-editor/_lib/poll-job.ts` with exactly this content:

```ts
/**
 * pollJob — single hardened polling loop for long-running server jobs
 * (render / burn). Replaces the old setInterval pairs in video-editor/page.tsx.
 *
 * Guarantees:
 * - Single in-flight request: the loop is strictly sequential
 *   (await fetchOnce → await sleep), so a slow response can never stack a
 *   second request — unlike setInterval.
 * - Transient errors NEVER fail the job: network down, Nginx 502/504 HTML
 *   bodies that make res.json() throw SyntaxError, non-OK statuses — any
 *   throw from fetchOnce (except abort) is retried with exponential backoff
 *   (×1.5, capped) until maxTransientErrors CONSECUTIVE failures.
 * - Stale timeout: if reported progress does not CHANGE for staleTimeoutMs
 *   (default 10 min — long enough to survive the 2–5 min post-deploy
 *   Remotion bundle stall), rejects with PollStaleError (code "stale").
 * - AbortSignal: aborting rejects promptly with PollAbortError, whose
 *   name === "AbortError" so existing catch blocks recognize it.
 */

export type PollTick<T> =
  /** Job still running. `progress` feeds stale detection: any CHANGE resets
   *  the stale clock. `resetStale: true` resets it unconditionally (used
   *  while queued — queue waits are legitimate and bounded elsewhere). */
  | { status: "pending"; progress?: number | null; resetStale?: boolean }
  | { status: "done"; value: T }
  | { status: "failed"; error: string };

export class PollAbortError extends Error {
  readonly code = "aborted";
  constructor() { super("Aborted"); this.name = "AbortError"; }
}

export class PollStaleError extends Error {
  readonly code = "stale";
  constructor(staleTimeoutMs: number) {
    super(`No progress change for ${Math.round(staleTimeoutMs / 60000)} min`);
    this.name = "PollStaleError";
  }
}

export class PollFailedError extends Error {
  readonly code = "job_failed";
  constructor(message: string) { super(message); this.name = "PollFailedError"; }
}

export class PollTransientLimitError extends Error {
  readonly code = "transient_limit";
  constructor(count: number) {
    super(`Polling gave up after ${count} consecutive transient errors`);
    this.name = "PollTransientLimitError";
  }
}

export const BACKOFF_FACTOR = 1.5;
export const BACKOFF_CAP_MS = 15_000;

/** Pure backoff step: next delay after a transient error. Exported for tests. */
export function nextBackoffDelay(currentMs: number, capMs: number = BACKOFF_CAP_MS): number {
  return Math.min(Math.round(currentMs * BACKOFF_FACTOR), capMs);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new PollAbortError()); return; }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => { clearTimeout(timer); reject(new PollAbortError()); };
    timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface PollJobOptions<T> {
  /** One poll attempt. Return a PollTick; ANY throw (except abort) is treated
   *  as a transient error and retried with backoff. ctx.tick starts at 0 and
   *  the first call happens immediately (no initial delay). */
  fetchOnce: (ctx: { tick: number }) => Promise<PollTick<T>>;
  intervalMs: number;
  /** Reject with PollStaleError when progress hasn't changed this long.
   *  Default 10 min — survives the 2–5 min post-deploy bundle stall. */
  staleTimeoutMs?: number;
  /** Consecutive transient errors before giving up. Default 40 — at the 15s
   *  backoff cap that is roughly the same wall-clock budget as staleTimeoutMs. */
  maxTransientErrors?: number;
  /** Backoff cap; exposed so the verify script can use short values. */
  backoffCapMs?: number;
  /** Called with each finite progress value from a pending tick. */
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

export async function pollJob<T>(opts: PollJobOptions<T>): Promise<T> {
  const {
    fetchOnce, intervalMs, signal, onProgress,
    staleTimeoutMs = 600_000,
    maxTransientErrors = 40,
    backoffCapMs = BACKOFF_CAP_MS,
  } = opts;

  let delayMs = intervalMs;
  let consecutiveErrors = 0;
  let lastProgress: number | null = null;
  let lastChangeAt = Date.now();
  let tick = 0;

  for (;;) {
    if (signal?.aborted) throw new PollAbortError();

    try {
      const t = await fetchOnce({ tick });
      consecutiveErrors = 0;
      delayMs = intervalMs;
      if (t.status === "done") return t.value;
      if (t.status === "failed") throw new PollFailedError(t.error);
      if (t.resetStale) {
        lastChangeAt = Date.now();
      } else if (typeof t.progress === "number" && t.progress !== lastProgress) {
        lastProgress = t.progress;
        lastChangeAt = Date.now();
      }
      if (typeof t.progress === "number" && onProgress) onProgress(t.progress);
    } catch (err) {
      // Terminal outcomes pass through; everything else is transient.
      if (err instanceof PollFailedError) throw err;
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw new PollAbortError();
      }
      consecutiveErrors++;
      if (consecutiveErrors >= maxTransientErrors) {
        throw new PollTransientLimitError(consecutiveErrors);
      }
      delayMs = nextBackoffDelay(delayMs, backoffCapMs);
    }

    if (Date.now() - lastChangeAt > staleTimeoutMs) throw new PollStaleError(staleTimeoutMs);

    tick++;
    await sleep(delayMs, signal);
  }
}
```

- [ ] **Step 5: Run the verify script — expect ALL PASS**

```bash
npx tsx scripts/verify-poll-job.ts
```

Expected output (exit 0 — verified by running this exact script against this exact implementation):

```
  PASS  (a) 502-HTML is retried, not fatal
  PASS  (b) stale timeout fires when progress frozen
  PASS  (b2) changing progress never goes stale + onProgress fires
  PASS  (c1) backoff grows 1.5x
  PASS  (c2) backoff caps at 15s
  PASS  (c3) gives up after maxTransientErrors consecutive errors
  PASS  (d) abort rejects with AbortError and polling stops
  PASS  (e) job failure is terminal with original message

ALL PASS
```

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/video-editor/_lib/poll-job.ts" scripts/verify-poll-job.ts
git commit -m "$(cat <<'EOF'
feat(video-editor): add pollJob hardened polling helper

Single sequential poll loop with: single in-flight guard, 1.5x backoff
(cap 15s) on transient errors, 502/504-HTML tolerance (never job
failure), 10-min no-progress-change stale timeout, AbortSignal support.
TDD'd via scripts/verify-poll-job.ts (spec PR-2).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

Expected: 2 files changed, commit created on `mew/polling-hardening`.

---

### Task 2.2: Replace the render polling pair with one `pollJob` call

**Files:**
- Modify: `src/app/(dashboard)/video-editor/page.tsx` (function `runRender`, currently lines ~1473–1680)
- Test: manual (dev-server smoke check, Step 7) — pure-logic guarantees already covered by `scripts/verify-poll-job.ts`

- [ ] **Step 1: Add the import**

In `src/app/(dashboard)/video-editor/page.tsx`, current code (line 35):

```ts
import { trackEvent } from "@/lib/client-telemetry";
```

Replace with:

```ts
import { trackEvent } from "@/lib/client-telemetry";
import { pollJob, PollStaleError, PollTransientLimitError } from "./_lib/poll-job";
```

- [ ] **Step 2: Delete the 600ms progress interval, add the abort plumbing**

In `runRender`, current code (lines 1485–1547 — quote is exact, delete ALL of it):

```ts
    let renderPollTimer: ReturnType<typeof setInterval> | null = null;
    let pollStopped = false;
    let renderFailedMessage: string | null = null;
    let resolveRenderUrl: ((url: string) => void) | null = null;
    let currentJobId: string | null = null;
    let renderIsQueued = false;

    const stopPoll = () => {
      pollStopped = true;
      if (renderPollTimer) { clearInterval(renderPollTimer); renderPollTimer = null; }
    };
    stopRenderPollRef.current = stopPoll;

    renderPollTimer = setInterval(async () => {
      if (pollStopped || !currentJobId) return;
      try {
        const r = await fetch(`/api/videos/render-progress?jobId=${encodeURIComponent(currentJobId)}`, { cache: "no-store", signal: abortControllerRef.current?.signal });
        if (!r.ok) return;
        const d = await r.json() as RenderProgressPayload;
        if (d.videoUrl) {
          // progress file บอก done → resolve ทันที แล้วหยุด poll ทั้งคู่
          if (resolveRenderUrl) { resolveRenderUrl(d.videoUrl); resolveRenderUrl = null; }
          stopPoll();
          return;
        }
        if (d.error) { renderFailedMessage = d.error; setRenderProgressError(d.error); setStep("render", "error", d.error); stopPoll(); return; }
        const p = Number(d.progress);
        renderIsQueued = Boolean(d.queued || d.stage === "queued");
        if (renderIsQueued) {
          const queueText = d.queuePosition ? `รอคิวเรนเดอร์ #${d.queuePosition}` : "รอคิวเรนเดอร์";
          setRenderProgress(0);
          setRenderActivity({
            phase: "queued",
            label: queueText,
            queuePosition: d.queuePosition ?? null,
            startedAt: renderActivityStartedAt,
          });
          setStep("render", "running", queueText);
          return;
        }
        if (d.stage === "preparing") {
          setRenderActivity({
            phase: "preparing",
            label: "เตรียมไฟล์สำหรับเรนเดอร์",
            queuePosition: null,
            startedAt: renderActivityStartedAt,
          });
          setStep("render", "running", "Preparing render...");
          return;
        }
        if (Number.isFinite(p)) {
          const safeProgress = Math.min(100, Math.max(0, Math.round(p)));
          setRenderProgress(safeProgress);
          setRenderActivity({
            phase: "rendering",
            label: "กำลังเรนเดอร์",
            queuePosition: null,
            startedAt: renderActivityStartedAt,
          });
          setStep("render", "running", `Rendering... ${safeProgress}%`);
        }
      } catch {}
    }, 600);
```

Replace with:

```ts
    // One sequential pollJob loop replaces the old 600ms progress interval +
    // 3s status interval. pollAbort stops it: chained to the shared
    // AbortController (stopAll / beforeunload) and exposed via stopRenderPollRef.
    const pollAbort = new AbortController();
    const sharedSignal = abortControllerRef.current?.signal;
    const onSharedAbort = () => pollAbort.abort();
    if (sharedSignal?.aborted) pollAbort.abort();
    else sharedSignal?.addEventListener("abort", onSharedAbort);
    stopRenderPollRef.current = () => pollAbort.abort();
```

- [ ] **Step 3: Remove the dead `renderFailedMessage` check after the POST**

Current code (lines 1585–1592):

```ts
      const res = await fetch("/api/videos/render", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortVideoConfig: patchedConfig, fps: renderFps, jpegQuality: renderQualityToJpeg[renderQuality] }),
        signal: abortControllerRef.current?.signal,
      });
      if (renderFailedMessage) throw new Error(renderFailedMessage);
      const data = await res.json();
      assertOk("Render", res, data);
```

Replace with:

```ts
      const res = await fetch("/api/videos/render", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortVideoConfig: patchedConfig, fps: renderFps, jpegQuality: renderQualityToJpeg[renderQuality] }),
        signal: abortControllerRef.current?.signal,
      });
      const data = await res.json();
      assertOk("Render", res, data);
```

- [ ] **Step 4: Replace the 3s render-status Promise loop with one `pollJob` call**

Current code (lines 1604–1647 — the whole block from `currentJobId = jobId;` through the closing of the `new Promise`):

```ts
      currentJobId = jobId; activeJobIdRef.current = jobId;
      // บันทึก jobId ลงใน URL เพื่อให้ resume ได้หลัง refresh
      try { const u = new URL(window.location.href); u.searchParams.set("jobId", jobId); window.history.replaceState({}, "", u.toString()); } catch {}

      // Stale detection: ถ้า progress ไม่เปลี่ยนนาน 60 นาที → ถือว่า hang → error
      const STALE_TIMEOUT_MS = 60 * 60 * 1000;
      let lastProgressValue = -1;
      let lastProgressChangedAt = Date.now();

      let statusNotFoundCount = 0;
      const url = await new Promise<string>((resolve, reject) => {
        resolveRenderUrl = resolve;
        const si = setInterval(async () => {
          if (activeJobIdRef.current !== jobId) { clearInterval(si); resolveRenderUrl = null; reject(new Error("__SUPERSEDED__")); return; }
          if (renderFailedMessage) { clearInterval(si); reject(new Error(renderFailedMessage)); return; }
          if (!resolveRenderUrl) { clearInterval(si); return; }

          // Stale check: progress ไม่เปลี่ยนนานเกิน 5 นาที → hang
          const curProgress = renderProgressRef.current;
          if (renderIsQueued) {
            lastProgressChangedAt = Date.now();
          } else if (curProgress !== lastProgressValue) { lastProgressValue = curProgress; lastProgressChangedAt = Date.now(); }
          else if (Date.now() - lastProgressChangedAt > STALE_TIMEOUT_MS) {
            clearInterval(si); resolveRenderUrl = null;
            reject(new Error("Render หยุดค้างนานเกิน 60 นาที — กรุณาลองใหม่"));
            return;
          }

          try {
            const sr = await fetch(`/api/videos/render-status?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store", signal: abortControllerRef.current?.signal });
            const sd = await sr.json();
            if (activeJobIdRef.current !== jobId) { clearInterval(si); resolveRenderUrl = null; reject(new Error("__SUPERSEDED__")); return; }
            if (sd.status === "done" && sd.videoUrl) { clearInterval(si); resolveRenderUrl = null; resolve(sd.videoUrl as string); }
            else if (sd.status === "error") { clearInterval(si); resolveRenderUrl = null; reject(new Error(sd.error ?? "Render failed")); }
            else if (sd.status === "not_found" || sr.status === 404) {
              statusNotFoundCount++;
              if (statusNotFoundCount >= 3) {
                clearInterval(si);
                console.warn(`[render] render-status not_found ×${statusNotFoundCount} — falling back to progress-file polling`);
              }
            }
          } catch (e) { if (e instanceof Error && e.name === "AbortError") { clearInterval(si); resolveRenderUrl = null; reject(e); } }
        }, 3000);
      });
```

Replace with:

```ts
      activeJobIdRef.current = jobId;
      // บันทึก jobId ลงใน URL เพื่อให้ resume ได้หลัง refresh
      try { const u = new URL(window.location.href); u.searchParams.set("jobId", jobId); window.history.replaceState({}, "", u.toString()); } catch {}

      let statusNotFoundCount = 0;
      const url = await pollJob<string>({
        intervalMs: 2000,
        staleTimeoutMs: 600_000, // 10 นาที — ทนช่วง bundle stall 2–5 นาทีหลัง deploy ได้
        signal: pollAbort.signal,
        fetchOnce: async ({ tick }) => {
          if (activeJobIdRef.current !== jobId) return { status: "failed", error: "__SUPERSEDED__" };

          // render-status fallback ทุก tick ที่ 5 (~10 วินาที) — จับเคสที่ progress file หาย
          if (tick > 0 && tick % 5 === 0) {
            const sr = await fetch(`/api/videos/render-status?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store", signal: pollAbort.signal });
            if (sr.ok) {
              const sd = await sr.json() as { status?: string; videoUrl?: string; error?: string };
              if (sd.status === "done" && sd.videoUrl) return { status: "done", value: sd.videoUrl };
              if (sd.status === "error") return { status: "failed", error: sd.error ?? "Render failed" };
              if (sd.status === "not_found") {
                statusNotFoundCount++;
                if (statusNotFoundCount === 3) console.warn("[render] render-status not_found ×3 — relying on progress-file polling");
              }
            } else if (sr.status === 404) {
              statusNotFoundCount++;
              if (statusNotFoundCount === 3) console.warn("[render] render-status not_found ×3 — relying on progress-file polling");
            }
          }

          // 502/504 HTML หรือ network ล่ม → throw → pollJob ถือเป็น transient + backoff (ห้าม fail งาน)
          const r = await fetch(`/api/videos/render-progress?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store", signal: pollAbort.signal });
          if (!r.ok) throw new Error(`render-progress HTTP ${r.status}`);
          const d = await r.json() as RenderProgressPayload;
          if (d.videoUrl) return { status: "done", value: d.videoUrl };
          if (d.error) return { status: "failed", error: d.error };
          const p = Number(d.progress);
          if (d.queued || d.stage === "queued") {
            const queueText = d.queuePosition ? `รอคิวเรนเดอร์ #${d.queuePosition}` : "รอคิวเรนเดอร์";
            setRenderProgress(0);
            setRenderActivity({
              phase: "queued",
              label: queueText,
              queuePosition: d.queuePosition ?? null,
              startedAt: renderActivityStartedAt,
            });
            setStep("render", "running", queueText);
            return { status: "pending", resetStale: true }; // รอคิว = งานยังไม่เริ่ม ไม่นับ stale
          }
          if (d.stage === "preparing") {
            setRenderActivity({
              phase: "preparing",
              label: "เตรียมไฟล์สำหรับเรนเดอร์",
              queuePosition: null,
              startedAt: renderActivityStartedAt,
            });
            setStep("render", "running", "Preparing render...");
            return { status: "pending", progress: null }; // preparing ค้างเกิน 10 นาที = stale (ตั้งใจ)
          }
          if (Number.isFinite(p)) {
            const safeProgress = Math.min(100, Math.max(0, Math.round(p)));
            setRenderProgress(safeProgress);
            setRenderActivity({
              phase: "rendering",
              label: "กำลังเรนเดอร์",
              queuePosition: null,
              startedAt: renderActivityStartedAt,
            });
            setStep("render", "running", `Rendering... ${safeProgress}%`);
            return { status: "pending", progress: safeProgress };
          }
          return { status: "pending", progress: null };
        },
      });
```

Note the deliberate behavior changes: stale timeout drops 60 min → 10 min (spec), the queued state still resets the stale clock (same as before), and `preparing` no longer resets it (a job stuck in preparing > 10 min is exactly the hang class we want to catch).

- [ ] **Step 5: Replace `runRender`'s catch/finally**

Current code (lines 1668–1679):

```ts
    } catch (err) {
      if (err instanceof Error && err.message === "__SUPERSEDED__") throw err;
      try { const u = new URL(window.location.href); u.searchParams.delete("jobId"); window.history.replaceState({}, "", u.toString()); } catch {}
      if (!renderFailedMessage && !(err instanceof Error && err.name === "AbortError")) {
        const msg = friendlyError(err);
        setRenderProgressError(msg); setStep("render", "error", msg);
      }
      setRenderActivity({ phase: "idle", label: "", queuePosition: null, startedAt: null });
      throw err;
    } finally {
      stopPoll(); stopRenderPollRef.current = null;
    }
```

Replace with:

```ts
    } catch (err) {
      if (err instanceof Error && err.message === "__SUPERSEDED__") throw err;
      try { const u = new URL(window.location.href); u.searchParams.delete("jobId"); window.history.replaceState({}, "", u.toString()); } catch {}
      // stale/transient-limit: งานฝั่ง server อาจยังทำงานอยู่ — แนะนำให้เช็ค Gallery แล้วค่อยลองใหม่
      const finalErr = err instanceof PollStaleError || err instanceof PollTransientLimitError
        ? new Error("Render ไม่คืบหน้า/เซิร์ฟเวอร์ไม่ตอบสนองนานเกิน 10 นาที — วิดีโออาจยังเรนเดอร์อยู่ ลองเช็คผลใน Gallery แล้วค่อยกด Render ใหม่อีกครั้ง")
        : err;
      if (!(finalErr instanceof Error && finalErr.name === "AbortError")) {
        const msg = friendlyError(finalErr);
        setRenderProgressError(msg); setStep("render", "error", msg);
      }
      setRenderActivity({ phase: "idle", label: "", queuePosition: null, startedAt: null });
      throw finalErr;
    } finally {
      pollAbort.abort();
      sharedSignal?.removeEventListener("abort", onSharedAbort);
      stopRenderPollRef.current = null;
    }
```

(`__SUPERSEDED__` now arrives as a `PollFailedError` whose `.message` is `"__SUPERSEDED__"` — the existing message-based checks in `runRenderOnly`/`runAll` keep working unchanged. `d.error` job failures arrive the same way and get the same `friendlyError` treatment as before; the old in-loop `setStep("render","error",...)` duplicate is gone.)

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit
```

Expected: exit 0 with no output (the repo type-checks clean at HEAD — verified 2026-06-10, and the full set of PR-2 edits has been pre-validated to also type-check clean). Any error that appears is from this change — fix it before proceeding. Note: `tsconfig.json` excludes `scripts/`, so the verify script is intentionally not part of this check.

- [ ] **Step 7: Dev smoke check (render only)**

```bash
npm run dev
```

In the browser: `http://localhost:3000/video-editor` → run the pipeline with a short 2–3 line Thai script (avatar: ไม่ใช้) → press Render. In DevTools Network (filter `render-`): expect `render-progress` requests every ~2s (NOT every 600ms), one `render-status` every ~10s, progress % climbing, and "Render preview พร้อมแล้ว" toast at the end. Leave the dev server running for the next task.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(dashboard)/video-editor/page.tsx"
git commit -m "$(cat <<'EOF'
refactor(video-editor): render polling via single pollJob loop

Collapses the 600ms render-progress interval + 3s render-status
interval into one sequential 2s pollJob loop with a render-status
check every 5th tick. Stale timeout 60min -> 10min; 502/504 and
non-JSON responses are now transient (retried with backoff), never
job failures. Refresh/cancel semantics unchanged (PR-9 scope).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.3: Replace `burnSubtitlesCore`'s two loops with one `pollJob` call

**Files:**
- Modify: `src/app/(dashboard)/video-editor/page.tsx` (function `burnSubtitlesCore`, currently lines ~2161–2371)
- Test: manual (dev-server smoke check, Step 5)

The success path stays IDENTICAL: `finalizeBurn(url)` (which does the gallery PATCH via `saveToGallery({..., status: "COMPLETED"})`) is untouched, and the Burn & Download button's `a.click()` download flow at page.tsx ~2754–2786 is untouched.

- [ ] **Step 1: Delete the 600ms burn-progress interval, add abort plumbing**

Current code (lines 2179–2233 — delete ALL of it):

```ts
    let burnPollTimer: ReturnType<typeof setInterval> | null = null;
    let pollStopped = false;
    let burnFailedMessage: string | null = null;
    let resolveBurnUrl: ((url: string) => void) | null = null;
    let currentJobId: string | null = null;

    const stopPoll = () => {
      pollStopped = true;
      if (burnPollTimer) { clearInterval(burnPollTimer); burnPollTimer = null; }
    };

    burnPollTimer = setInterval(async () => {
      if (pollStopped || !currentJobId) return;
      try {
        const r = await fetch(`/api/videos/render-progress?jobId=${encodeURIComponent(currentJobId)}`, { cache: "no-store", signal: abortControllerRef.current?.signal });
        if (!r.ok) return;
        const d = await r.json() as RenderProgressPayload;
        if (d.videoUrl) {
          if (resolveBurnUrl) { resolveBurnUrl(d.videoUrl); resolveBurnUrl = null; }
          stopPoll();
          return;
        }
        if (d.error) {
          burnFailedMessage = d.error;
          setRenderProgressError(d.error);
          setStep("burnSubtitles", "error", d.error);
          stopPoll();
          return;
        }
        const p = Number(d.progress);
        if (d.queued || d.stage === "queued") {
          const queueText = d.queuePosition ? `รอคิว Burn #${d.queuePosition}` : "รอคิว Burn";
          setRenderProgress(0);
          setRenderActivity({
            phase: "queued",
            label: queueText,
            queuePosition: d.queuePosition ?? null,
            startedAt: burnActivityStartedAt,
          });
          setStep("burnSubtitles", "running", queueText);
          return;
        }
        if (Number.isFinite(p)) {
          const safeProgress = Math.min(100, Math.max(0, Math.round(p)));
          setRenderProgress(safeProgress);
          setRenderActivity({
            phase: "burning",
            label: "กำลังฝังซับ",
            queuePosition: null,
            startedAt: burnActivityStartedAt,
          });
          setStep("burnSubtitles", "running", `Burning... ${safeProgress}%`);
        }
      } catch {}
    }, 600);
```

Replace with:

```ts
    // One sequential pollJob loop replaces the old 600ms progress interval +
    // 2s checkOnce loop (2 GETs/tick). pollAbort stops it: chained to the
    // shared AbortController (stopAll / beforeunload) and exposed via
    // stopRenderPollRef — เดิม burn ไม่เคยลงทะเบียน stop hook เลย ทำให้กด Stop
    // แล้ว loop ยังวิ่งต่อ; ตอนนี้หยุดได้จริง
    const pollAbort = new AbortController();
    const sharedSignal = abortControllerRef.current?.signal;
    const onSharedAbort = () => pollAbort.abort();
    if (sharedSignal?.aborted) pollAbort.abort();
    else sharedSignal?.addEventListener("abort", onSharedAbort);
    stopRenderPollRef.current = () => pollAbort.abort();
```

- [ ] **Step 2: Replace `checkOnce` + the 2s Promise loop with `pollJob`**

This deletes the exact bug named in the spec: `checkOnce` rethrows any error whose message isn't `'Failed to fetch'`, so a 502 HTML body makes `sr.json()` throw `SyntaxError: Unexpected token '<'` which rejects the whole burn while the server keeps burning — users retry and stack duplicate burns.

Current code (lines 2316–2360):

```ts
      const jobId = data.jobId;
      if (!jobId) throw new Error("Burn subtitles: no jobId returned");
      currentJobId = jobId;
      activeJobIdRef.current = jobId;

      // Check immediately in case server already finished (fast burn or bundle was cached)
      const checkOnce = async (): Promise<string | null> => {
        try {
          // Try progress file first (more reliable, written before in-memory job map)
          const pr = await fetch(`/api/videos/render-progress?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" });
          if (pr.ok) {
            const pd = await pr.json() as { progress?: number; videoUrl?: string | null; error?: string | null };
            if (pd.videoUrl) return pd.videoUrl;
            if (pd.error) throw new Error(pd.error);
          }
          const sr = await fetch(`/api/videos/render-status?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" });
          const sd = await sr.json() as { status?: string; videoUrl?: string; error?: string };
          if (sd.status === "done" && sd.videoUrl) return sd.videoUrl;
          if (sd.status === "error") throw new Error(sd.error ?? "Burn subtitles failed");
        } catch (e) {
          if (e instanceof Error && e.message && e.message !== "Failed to fetch") throw e;
        }
        return null;
      };

      const immediate = await checkOnce();
      if (immediate) { finalizeBurn(immediate); return; }

      const url = await new Promise<string>((resolve, reject) => {
        resolveBurnUrl = resolve;
        const si = setInterval(async () => {
          if (activeJobIdRef.current !== jobId) { clearInterval(si); resolveBurnUrl = null; reject(new Error("__SUPERSEDED__")); return; }
          if (burnFailedMessage) { clearInterval(si); reject(new Error(burnFailedMessage)); return; }
          try {
            const found = await checkOnce();
            if (activeJobIdRef.current !== jobId) { clearInterval(si); resolveBurnUrl = null; reject(new Error("__SUPERSEDED__")); return; }
            if (found) { clearInterval(si); resolveBurnUrl = null; resolve(found); }
          } catch (e) {
            if (e instanceof Error && e.name === "AbortError") { clearInterval(si); resolveBurnUrl = null; reject(e); return; }
            clearInterval(si); resolveBurnUrl = null; reject(e instanceof Error ? e : new Error(String(e)));
          }
        }, 2000);
      });

      finalizeBurn(url);
```

Replace with:

```ts
      const jobId = data.jobId;
      if (!jobId) throw new Error("Burn subtitles: no jobId returned");
      activeJobIdRef.current = jobId;

      // pollJob ยิง fetchOnce ครั้งแรกทันที (tick 0) — ครอบเคส burn เสร็จเร็ว/bundle cache แล้ว
      const url = await pollJob<string>({
        intervalMs: 2000,
        staleTimeoutMs: 600_000, // 10 นาที — ทนช่วง bundle stall 2–5 นาทีหลัง deploy ได้
        signal: pollAbort.signal,
        fetchOnce: async ({ tick }) => {
          if (activeJobIdRef.current !== jobId) return { status: "failed", error: "__SUPERSEDED__" };

          // render-status fallback ทุก tick ที่ 5 (~10 วินาที) — เดิม checkOnce ยิง 2 GET ทุก 2 วิ
          if (tick > 0 && tick % 5 === 0) {
            const sr = await fetch(`/api/videos/render-status?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store", signal: pollAbort.signal });
            if (sr.ok) {
              const sd = await sr.json() as { status?: string; videoUrl?: string; error?: string };
              if (sd.status === "done" && sd.videoUrl) return { status: "done", value: sd.videoUrl };
              if (sd.status === "error") return { status: "failed", error: sd.error ?? "Burn subtitles failed" };
            }
          }

          // 502/504 HTML หรือ network ล่ม → throw → transient + backoff
          // (ห้าม fail งาน burn — เซิร์ฟเวอร์ยัง burn อยู่ ไม่งั้นผู้ใช้กดซ้ำจน burn ซ้อน)
          const r = await fetch(`/api/videos/render-progress?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store", signal: pollAbort.signal });
          if (!r.ok) throw new Error(`render-progress HTTP ${r.status}`);
          const d = await r.json() as RenderProgressPayload;
          if (d.videoUrl) return { status: "done", value: d.videoUrl };
          if (d.error) return { status: "failed", error: d.error };
          const p = Number(d.progress);
          if (d.queued || d.stage === "queued") {
            const queueText = d.queuePosition ? `รอคิว Burn #${d.queuePosition}` : "รอคิว Burn";
            setRenderProgress(0);
            setRenderActivity({
              phase: "queued",
              label: queueText,
              queuePosition: d.queuePosition ?? null,
              startedAt: burnActivityStartedAt,
            });
            setStep("burnSubtitles", "running", queueText);
            return { status: "pending", resetStale: true };
          }
          if (Number.isFinite(p)) {
            const safeProgress = Math.min(100, Math.max(0, Math.round(p)));
            setRenderProgress(safeProgress);
            setRenderActivity({
              phase: "burning",
              label: "กำลังฝังซับ",
              queuePosition: null,
              startedAt: burnActivityStartedAt,
            });
            setStep("burnSubtitles", "running", `Burning... ${safeProgress}%`);
            return { status: "pending", progress: safeProgress };
          }
          return { status: "pending", progress: null };
        },
      });

      finalizeBurn(url);
```

- [ ] **Step 3: Replace `burnSubtitlesCore`'s catch/finally with stale-aware Thai messaging**

Current code (lines 2361–2371):

```ts
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.message === "__SUPERSEDED__")) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      setStep("burnSubtitles", "error", msg);
      setRenderActivity({ phase: "idle", label: "", queuePosition: null, startedAt: null });
      if (toastOnError) toast.error(msg);
      throw err;
    } finally {
      stopPoll();
    }
  }
```

Replace with:

```ts
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.message === "__SUPERSEDED__")) throw err;
      // stale/transient-limit: เซิร์ฟเวอร์อาจ burn เสร็จแล้วแต่เราเช็คไม่ได้ — ให้เช็ค Gallery ก่อน
      // retry = กดปุ่ม Burn & Download เดิมอีกครั้งได้เลย (ปุ่มยังอยู่เมื่อ step เป็น error)
      const msg = err instanceof PollStaleError || err instanceof PollTransientLimitError
        ? "Burn ไม่คืบหน้า/เซิร์ฟเวอร์ไม่ตอบสนองนานเกิน 10 นาที — วิดีโออาจเสร็จแล้ว ลองเช็คใน Gallery ก่อน แล้วค่อยกด Burn & Download อีกครั้ง"
        : err instanceof Error ? err.message : String(err);
      setStep("burnSubtitles", "error", msg);
      setRenderActivity({ phase: "idle", label: "", queuePosition: null, startedAt: null });
      if (toastOnError) toast.error(msg);
      throw err;
    } finally {
      pollAbort.abort();
      sharedSignal?.removeEventListener("abort", onSharedAbort);
      stopRenderPollRef.current = null;
    }
  }
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: exit 0; no errors. (This also confirms `burnFailedMessage`/`resolveBurnUrl`/`currentJobId`/`stopPoll` were fully removed — leftovers would be unused-variable/undefined-name errors. Pre-validated: the complete PR-2 edit set type-checks clean.)

- [ ] **Step 5: Dev smoke check (burn)**

With the dev server still running: on the rendered video from Task 2.2 Step 7, press **Burn & Download**. Expect: "กำลังฝังซับ x%" progress, Network shows `render-progress` every ~2s + `render-status` every ~10s, then toast "Burn Subtitles เสร็จแล้ว! วิดีโอมีซับพร้อม Download", the MP4 downloads, and the Gallery row flips to COMPLETED (check `/dashboard` gallery or the `PATCH /api/videos/<id>` request in Network).

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/video-editor/page.tsx"
git commit -m "$(cat <<'EOF'
fix(video-editor): burn polling via pollJob; 502 no longer fails burns

Replaces burnSubtitlesCore's 600ms interval + 2s checkOnce (which
rethrew the SyntaxError from a Nginx 502 HTML body, failing the burn
while the server kept burning -> users stacked duplicate burns) with
one 2s pollJob loop. Adds a 10-min stale timeout with a Thai
check-the-gallery message; Stop/unload can now actually halt burn
polling. finalizeBurn success path (gallery PATCH + download) is
unchanged.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.4: Unmount cleanup — stop every loop on SPA navigation

**Files:**
- Modify: `src/app/(dashboard)/video-editor/page.tsx` (after the Init effect, currently ending at line ~462)
- Test: manual (Step 3)

Inventory of every timer/loop/controller in `page.tsx` (verified against the file at HEAD):

| What | Where | Cleanup |
|---|---|---|
| Shared `AbortController` (`abortControllerRef`) — all pipeline fetches + (after Tasks 2.2/2.3) chained `pollJob` loops | created per run (~lines 1862, 1996, 2068, 2145, 2377) | **NEW effect below**: `.abort()` |
| Active `pollJob` loop (render or burn) | `stopRenderPollRef` | **NEW effect below**: call + null |
| HeyGen 5s `for`-loops (`runAvatar` ~1727, `runAvatarTail` ~1832; up to 360 ticks = 30 min) | break when `abortRef.current === true` at next tick; their fetches carry the shared signal | **NEW effect below**: `abortRef.current = true` |
| `runningRef` running-flag | guards re-entry | **NEW effect below**: reset to false |
| 1s render-elapsed interval | lines 291–295 | already self-cleans in its own `useEffect` return — no change |
| 600ms avatar-info debounce `setTimeout` | lines 509–513 | already self-cleans (`return () => clearTimeout(t)`) — no change |
| rAF video-sync loop + media listeners | lines 516–565 | already self-cleans (`cancelAnimationFrame` + `removeEventListener`) — no change |
| 50ms focus `setTimeout` | line ~3132 | one-shot UI focus, harmless — no change |

- [ ] **Step 1: Add the unmount-cleanup effect**

Current code (end of the Init effect, lines 460–462):

```ts
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
```

Replace with:

```ts
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Unmount cleanup ───────────────────────────────────────────────────
  // SPA navigation away from /video-editor must stop every client-side loop —
  // เดิม loop พวกนี้รั่วข้ามหน้า (poll ต่อแม้ออกจากหน้าไปแล้ว):
  // - abortRef = true       → HeyGen 5s for-loops (runAvatar / runAvatarTail) หยุดที่ tick ถัดไป
  // - abortControllerRef    → ยกเลิก fetch ที่ค้าง + pollJob loops (render/burn) ผ่าน abort chaining
  // - stopRenderPollRef     → หยุด pollJob loop ที่ active โดยตรง (กันเหนียว)
  // จงใจไม่ cancel งานฝั่ง server ที่นี่ — การเปลี่ยน semantics ของ
  // mount-time auto-cancel / beforeunload sendBeacon เป็นงาน Phase 2 PR-9.
  // (StrictMode dev double-mount ปลอดภัย: ทุก run ตั้ง abortRef = false ใหม่
  // และ abortControllerRef ถูกสร้างใหม่ต่อ run)
  useEffect(() => {
    return () => {
      abortRef.current = true;
      abortControllerRef.current?.abort();
      stopRenderPollRef.current?.();
      stopRenderPollRef.current = null;
      runningRef.current = false;
    };
  }, []);
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: exit 0, no errors mentioning our files.

- [ ] **Step 3: Manual check — navigation stops polling**

With `npm run dev` running: start a Render on `/video-editor`; while "กำลังเรนเดอร์ x%" is showing, open DevTools Network with **Preserve log** ON, then click a sidebar link to `/dashboard` (SPA navigation, NOT a full reload). Expected: `render-progress` requests stop within one interval (≤ 15s — usually immediately, the in-flight one may show `(canceled)`); no new `render-status` or `poll-avatar` requests appear afterwards; console shows no repeating errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/video-editor/page.tsx"
git commit -m "$(cat <<'EOF'
fix(video-editor): stop all polling loops on unmount

Adds an unmount cleanup effect: abortRef stops the 5s HeyGen loops,
the shared AbortController abort stops in-flight fetches and the
chained render/burn pollJob loops, stopRenderPollRef is invoked and
cleared. Previously these leaked across SPA navigation. Mount-time
auto-cancel and beforeunload semantics intentionally unchanged (PR-9).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.5: Full manual verification matrix + open the PR

**Files:**
- Test: manual only (no file changes; one temporary local edit that MUST be reverted)

- [ ] **Step 1: Re-run the logic verification**

```bash
npx tsx scripts/verify-poll-job.ts
```

Expected: `ALL PASS`, exit 0.

- [ ] **Step 2: Matrix 1 — render + burn happy path**

`npm run dev` → `/video-editor` → full pipeline (short Thai script, avatar ไม่ใช้) → Render → Burn & Download. Expected: progress climbs smoothly; Network shows the new cadence (2s progress / ~10s status, no 600ms storm); burned MP4 downloads; toast "Burn + Download + บันทึกลง Gallery แล้ว" (button path) or "Burn Subtitles เสร็จแล้ว!..."; gallery row COMPLETED.

- [ ] **Step 3: Matrix 2 — kill the server mid-burn (transient tolerance, then stale)**

1. Start a burn. While "กำลังฝังซับ x%": press Ctrl+C on the dev server.
2. Expected immediately: UI **stays** in the burning state (no instant failure — the old code could fail or hang here); Network shows failed `render-progress` requests with growing gaps 2s → 3s → 4.5s → 6.8s → 10.1s → 15s → 15s (backoff cap).
3. To see the stale rejection without waiting 10 minutes: temporarily change **both** occurrences of `staleTimeoutMs: 600_000,` in `src/app/(dashboard)/video-editor/page.tsx` to `staleTimeoutMs: 45_000,`, repeat step 1–2 and keep the server down. Expected within ~45–60s: red toast "Burn ไม่คืบหน้า/เซิร์ฟเวอร์ไม่ตอบสนองนานเกิน 10 นาที — วิดีโออาจเสร็จแล้ว ลองเช็คใน Gallery ก่อน แล้วค่อยกด Burn & Download อีกครั้ง", step turns error, and the Burn & Download button is pressable again (the retry affordance).
4. **Revert the temporary edit** and verify: `git diff --stat` → expected output: empty (working tree clean).

Note: the exact prod 502-HTML-body case (HTTP 200/502 + `<html>` body → `r.json()` SyntaxError → transient) is deterministically covered by `verify-poll-job.ts` test (a); the kill-server test exercises the same retry path via connection-refused.

- [ ] **Step 4: Matrix 3 — restart the server mid-render-poll**

Start a Render; mid-progress Ctrl+C the dev server, wait ~20s, then `npm run dev` again. Expected: during downtime the UI stays in "กำลังเรนเดอร์" with backed-off retries and NO error toast; once the server is back, `render-progress` requests succeed again (HTTP 200). Polling survives the outage — i.e., it resumes through the 502-equivalent window. (In dev the restart also kills the in-memory render job itself; the loop will then either pick up a server-reported error/`not_found` or hit the 10-min stale message — both are correct terminal outcomes, NOT a hang. On prod behind Nginx+PM2 the same window returns real 502 HTML, which test (a) of the verify script proves is tolerated.)

- [ ] **Step 5: Matrix 4 — navigate away mid-render**

Repeat Task 2.4 Step 3 (Preserve log; SPA-navigate to `/dashboard` mid-render). Expected: polling requests stop within one interval; nothing keeps polling in the background.

- [ ] **Step 6: Matrix 5 — Stop button mid-burn**

Start a burn, press the Stop (หยุด) control. Expected: toast "หยุดแล้ว", polling requests stop immediately (pollAbort chained to `stopAll()`'s abort), steps reset to idle. This previously left the burn `checkOnce` loop running forever — confirm it no longer does.

- [ ] **Step 7: Push and open the PR**

```bash
git push -u origin mew/polling-hardening
gh pr create --title "fix(video-editor): polling can never hang forever (spec PR-2)" --body "$(cat <<'EOF'
## What

Implements PR-2 of docs/superpowers/specs/2026-06-10-video-editor-optimization-design.md:

- New `src/app/(dashboard)/video-editor/_lib/poll-job.ts` — one shared hardened poll loop: single in-flight request, exponential backoff (1.5x, cap 15s) on transient errors, **502/504 HTML bodies are transient, never job failures**, 10-min no-progress-change stale timeout (survives the 2–5 min post-deploy bundle stall), AbortSignal support. TDD'd via `scripts/verify-poll-job.ts` (run: `npx tsx scripts/verify-poll-job.ts` → ALL PASS).
- `runRender`: 600ms progress interval + 3s status interval → one 2s pollJob loop (status check every 5th tick). Stale 60min → 10min.
- `burnSubtitlesCore`: 600ms interval + 2s checkOnce (2 GETs) → one 2s pollJob loop. Fixes the prod bug where a Nginx 502 HTML body rejected the burn (SyntaxError from res.json()) while the server kept burning, so users retried and stacked duplicate burns. Stale → Thai "เช็คใน Gallery แล้วค่อยกด Burn อีกครั้ง" message; finalizeBurn success path (gallery PATCH + download) unchanged.
- Unmount cleanup effect: aborts the shared AbortController, stops the active pollJob loop, breaks the 5s HeyGen loops — these previously leaked across SPA navigation. Stop (หยุด) now actually halts burn polling.

**NOT in this PR (deliberate):** mount-time URL-jobId auto-cancel and beforeunload sendBeacon-cancel keep today's semantics — refresh-resume is Phase 2 PR-9. The HeyGen avatar 5s loops are not converted to pollJob (already sequential with a 360-tick cap; PR-1 owns their terminal-status handling) — they are stopped on unmount here.

## Testing

- `npx tsx scripts/verify-poll-job.ts` → ALL PASS (502-HTML transient, stale fires, backoff caps, abort clean, terminal failure).
- `npx tsc --noEmit` clean.
- Full manual matrix on dev: render+burn happy path; kill server mid-burn → backoff then stale message (no hang, no false failure); restart server mid-render-poll → polling survives the outage; SPA-navigate away mid-render → network polling stops; Stop button mid-burn → halts immediately.

## Review notes for wao

- No shared files touched (no prisma/schema.prisma, package.json, next.config.ts, no API routes) — changes are confined to the video-editor page + a new _lib helper + a verify script.
- This changes the editor's main render/burn polling path, so please sanity-check a render+burn on your side before merge; client request rate drops from ~4.3 req/s to ~0.6 req/s per active user.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected output: a PR URL like `https://github.com/<org>/<repo>/pull/<n>`. Do NOT merge until wao has reviewed and the full matrix above has been run on the final commit.

---

## PR-5: External-call armor

Every HeyGen/ElevenLabs/Gemini/Pexels/Pixabay call gets a per-attempt timeout, bounded retries (network errors, 429 honoring `Retry-After`, 5xx only), and a wall-clock cap via a new `fetchWithBudget` helper; failures are classified into the shared §8 taxonomy (`invalid_key | quota | rate_limit | transient | fatal`) and returned by routes as a consistent JSON shape with the correct HTTP status. This also removes the process-wide undici dispatcher override in `tts-gemini` that today lets EVERY fetch in the process hang up to 10 minutes per phase. Risk: low-medium — pure code, no schema/config/shared-file changes; rollback = revert the PR (no migration, no env change). **Dependency: merge AFTER PR-1** (Task 5.4 builds on the poll-avatar rewrite); only the highest-leverage call sites are converted here — the rest are listed as follow-ups in the PR body (Task 5.8).

Branch: `mew/external-call-armor`.

---

### Task 5.1: Provider error taxonomy (`src/lib/provider-errors.ts`)

**Files:**
- Create: `src/lib/provider-errors.ts`
- Test: `scripts/verify-provider-errors.ts`

- [ ] **Step 1: Confirm PR-1 is merged, then create the feature branch**

Run:

```bash
cd /Users/mewsocialmacmini/projects/AI_content_Mew_social
git checkout main && git pull origin main
grep -n "res.ok\|invalid_key" src/app/api/videos/poll-avatar/route.ts
```

Expected: at least one matching line (PR-1 added `res.ok` checking / terminal-status mapping to poll-avatar). **If grep prints nothing, STOP — PR-1 is not merged yet; this PR must wait.** (Verified 2026-06-10: `main` today has NO `res.ok` handling in poll-avatar — this guard WILL fire until PR-1 lands.)

Then:

```bash
git checkout -b mew/external-call-armor
```

Expected output: `Switched to a new branch 'mew/external-call-armor'`

- [ ] **Step 2: Write the failing verify script FIRST**

Create `scripts/verify-provider-errors.ts` with exactly:

```ts
/**
 * TDD verify for src/lib/provider-errors.ts (design doc §8 taxonomy).
 * Run: npx tsx scripts/verify-provider-errors.ts
 * Must FAIL before src/lib/provider-errors.ts exists, PASS after.
 */
import assert from "node:assert/strict";
import {
  providerError,
  isProviderError,
  isRetryable,
  toUserMessage,
  classifyHttpStatus,
  httpStatusForCode,
  toErrorResponse,
  type ProviderErrorCode,
} from "../src/lib/provider-errors";

// ── classification of upstream HTTP statuses ──
assert.equal(classifyHttpStatus(401), "invalid_key");
assert.equal(classifyHttpStatus(402), "quota");
assert.equal(classifyHttpStatus(403), "quota");
assert.equal(classifyHttpStatus(429), "rate_limit");
assert.equal(classifyHttpStatus(500), "transient");
assert.equal(classifyHttpStatus(502), "transient");
assert.equal(classifyHttpStatus(503), "transient");
assert.equal(classifyHttpStatus(400), "fatal");
assert.equal(classifyHttpStatus(404), "fatal");

// ── HTTP statuses OUR routes return per code (§8: 401/402/429/503/500) ──
assert.equal(httpStatusForCode("invalid_key"), 401);
assert.equal(httpStatusForCode("quota"), 402);
assert.equal(httpStatusForCode("rate_limit"), 429);
assert.equal(httpStatusForCode("transient"), 503);
assert.equal(httpStatusForCode("fatal"), 500);

// ── retryable flags follow the taxonomy ──
const flags: Record<ProviderErrorCode, boolean> = {
  invalid_key: false,
  quota: false,
  rate_limit: true,
  transient: true,
  fatal: false,
};
for (const [code, expected] of Object.entries(flags) as [ProviderErrorCode, boolean][]) {
  const e = providerError(code, "test", "boom");
  assert.equal(e.retryable, expected, `${code}.retryable === ${expected}`);
  assert.equal(isRetryable(e), expected, `isRetryable(${code}) === ${expected}`);
}

// ── providerError builds a real Error carrying every field ──
const err = providerError("invalid_key", "heygen", "HeyGen returned 401", { status: 401 });
assert.ok(err instanceof Error);
assert.equal(err.name, "ProviderError");
assert.equal(err.code, "invalid_key");
assert.equal(err.provider, "heygen");
assert.equal(err.message, "HeyGen returned 401");
assert.equal(err.status, 401);
assert.ok(err.userAction && err.userAction.includes("Settings"), "invalid_key userAction points to Settings");

// ── guards ──
assert.equal(isProviderError(err), true);
assert.equal(isProviderError(new Error("x")), false);
assert.equal(isProviderError(null), false);
assert.equal(isRetryable(new Error("x")), false);

// ── Thai user messages exist for every code ──
for (const code of ["invalid_key", "quota", "rate_limit", "transient", "fatal"] as const) {
  assert.ok(toUserMessage(code).length > 10, `toUserMessage(${code}) non-trivial`);
}

// ── route response shape ──
const { body, status } = toErrorResponse(err);
assert.equal(status, 401);
assert.equal(body.code, "invalid_key");
assert.equal(body.provider, "heygen");
assert.equal(body.missingKey, "heygen"); // opens the existing fix-your-key modal
// Legacy client gate: handleMissingKey() in video-creator/video-editor SKIPS the
// key modal whenever `retryable === false` (checked BEFORE missingKey) —
// invalid_key must therefore OMIT the legacy field, not set it to false.
assert.equal(body.retryable, undefined);
assert.equal(body.error, body.userAction); // legacy `error` key kept for current clients
const t = toErrorResponse(providerError("transient", "pexels", "503 from pexels", { status: 503 }));
assert.equal(t.status, 503);
assert.equal(t.body.missingKey, undefined);
assert.equal(t.body.retryable, true); // non-invalid_key codes DO carry the flag

console.log("verify-provider-errors: ALL PASS");
```

- [ ] **Step 3: Run the verify script — expect FAILURE**

```bash
npx tsx scripts/verify-provider-errors.ts
```

Expected: an error like `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/lib/provider-errors'` and non-zero exit. This is the failing TDD run — do not skip it.

- [ ] **Step 4: Create `src/lib/provider-errors.ts`**

Create the file with exactly:

```ts
/**
 * Shared provider-error taxonomy — design doc §8 (2026-06-10).
 *
 * Every external-provider failure (HeyGen / ElevenLabs / Gemini / Pexels /
 * Pixabay / stock CDNs) is normalized into one of five codes so API routes
 * return a consistent JSON shape and the UI can map each code to the right
 * action (fix key / show plan-limit / wait / silent retry / generic error).
 *
 * Framework-free on purpose: scripts/verify-*.ts run this directly via
 * `npx tsx` (the repo's test pattern).
 */

export type ProviderErrorCode = "invalid_key" | "quota" | "rate_limit" | "transient" | "fatal";

export interface ProviderError extends Error {
  /** Taxonomy bucket (design doc §8). */
  code: ProviderErrorCode;
  /** Which provider failed: "heygen" | "elevenlabs" | "gemini" | "pexels" | "pixabay" | "stock-cdn" | … */
  provider: string;
  /** Technical message for logs/admin notifications (NOT for end users). */
  message: string;
  /** Thai, user-facing — what the user should do. */
  userAction?: string;
  /** Whether an automatic retry can plausibly succeed. */
  retryable: boolean;
  /** Upstream HTTP status, when there was one. */
  status?: number;
}

class ProviderErrorImpl extends Error implements ProviderError {
  code: ProviderErrorCode;
  provider: string;
  userAction?: string;
  retryable: boolean;
  status?: number;

  constructor(
    code: ProviderErrorCode,
    provider: string,
    message: string,
    opts?: { status?: number; userAction?: string },
  ) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.provider = provider;
    this.retryable = code === "rate_limit" || code === "transient";
    this.userAction = opts?.userAction ?? toUserMessage(code);
    this.status = opts?.status;
  }
}

export function providerError(
  code: ProviderErrorCode,
  provider: string,
  message: string,
  opts?: { status?: number; userAction?: string },
): ProviderError {
  return new ProviderErrorImpl(code, provider, message, opts);
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof Error && e.name === "ProviderError" && "code" in e && "provider" in e && "retryable" in e;
}

export function isRetryable(e: unknown): boolean {
  return isProviderError(e) && e.retryable;
}

export function toUserMessage(code: ProviderErrorCode): string {
  switch (code) {
    case "invalid_key":
      return "API Key ใช้ไม่ได้ — กรุณาตรวจสอบ key ใน Settings";
    case "quota":
      return "เครดิต/โควต้าของผู้ให้บริการหมด — กรุณาตรวจสอบแพ็กเกจของบัญชีที่ใช้ key";
    case "rate_limit":
      return "ผู้ให้บริการขอให้รอสักครู่ (rate limit) — กรุณาลองใหม่ในอีก 1-2 นาที";
    case "transient":
      return "ระบบปลายทางขัดข้องชั่วคราว — กรุณาลองใหม่อีกครั้ง";
    case "fatal":
      return "เกิดข้อผิดพลาดที่ไม่คาดคิด — กรุณาลองใหม่ หรือติดต่อทีมงาน";
  }
}

/** Map an UPSTREAM provider HTTP status to a taxonomy code. */
export function classifyHttpStatus(status: number): ProviderErrorCode {
  if (status === 401) return "invalid_key";
  if (status === 402 || status === 403) return "quota";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "transient";
  return "fatal";
}

/** HTTP status OUR routes return for each code (§8): 401 / 402 / 429 / 503 / 500. */
export function httpStatusForCode(code: ProviderErrorCode): number {
  switch (code) {
    case "invalid_key":
      return 401;
    case "quota":
      return 402;
    case "rate_limit":
      return 429;
    case "transient":
      return 503;
    case "fatal":
      return 500;
  }
}

export interface ProviderErrorBody {
  /** Legacy field every existing client toast reads — Thai user message. */
  error: string;
  code: ProviderErrorCode;
  provider: string;
  message: string;
  userAction: string;
  /**
   * Taxonomy retryable flag — OMITTED on invalid_key. The existing clients'
   * handleMissingKey (video-creator/page.tsx, video-editor/page.tsx) treats
   * `retryable === false` as "not a key problem" and returns BEFORE checking
   * missingKey, which would permanently suppress the fix-your-key modal.
   */
  retryable?: boolean;
  /** Set on invalid_key so the existing fix-your-key modal opens (same field routes already use). */
  missingKey?: string;
}

/** Build the JSON body + HTTP status for an API route response. */
export function toErrorResponse(err: ProviderError): { body: ProviderErrorBody; status: number } {
  const userAction = err.userAction ?? toUserMessage(err.code);
  return {
    body: {
      error: userAction,
      code: err.code,
      provider: err.provider,
      message: err.message,
      userAction,
      // invalid_key: missingKey opens the key modal; legacy `retryable` is
      // omitted because retryable===false would suppress that modal (see above).
      ...(err.code === "invalid_key" ? { missingKey: err.provider } : { retryable: err.retryable }),
    },
    status: httpStatusForCode(err.code),
  };
}
```

- [ ] **Step 5: Run the verify script — expect PASS**

```bash
npx tsx scripts/verify-provider-errors.ts
```

Expected output (exactly): `verify-provider-errors: ALL PASS`

- [ ] **Step 6: Commit**

```bash
git add src/lib/provider-errors.ts scripts/verify-provider-errors.ts
git commit -m "$(cat <<'EOF'
feat(errors): add shared provider-error taxonomy (PR-5)

invalid_key | quota | rate_limit | transient | fatal with Thai user
messages, upstream-status classification, route HTTP-status mapping
(401/402/429/503/500), and a JSON response builder that keeps the
legacy `error` + `missingKey` fields existing clients read. invalid_key
omits the legacy `retryable` field: the clients' handleMissingKey treats
retryable===false as "not a key problem" and would never open the modal.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

Expected: 1 commit created, 2 files changed.

---

### Task 5.2: `fetchWithBudget` (`src/lib/fetch-budget.ts`)

**Files:**
- Create: `src/lib/fetch-budget.ts`
- Test: `scripts/verify-fetch-budget.ts`

- [ ] **Step 1: Write the failing verify script FIRST (scripted node:http failure sequences)**

Create `scripts/verify-fetch-budget.ts` with exactly:

```ts
/**
 * TDD verify for src/lib/fetch-budget.ts.
 * Run: npx tsx scripts/verify-fetch-budget.ts
 * Must FAIL before src/lib/fetch-budget.ts exists, PASS after (~8s runtime).
 *
 * Local node:http server scripts the failure sequences:
 *   1. hang (per-attempt timeout) → 200      ⇒ retry succeeds
 *   2. 429 + Retry-After: 1 → 200            ⇒ waits ≥ ~1s, succeeds
 *   3. 502 × 3                               ⇒ throws ProviderError 'transient'
 *   4. 401                                   ⇒ immediate 'invalid_key' (heygen), exactly 1 request
 *   5. 401 + returnHttpErrors                ⇒ Response returned, body still readable
 */
import http from "node:http";
import assert from "node:assert/strict";
import { fetchWithBudget, parseRetryAfterMs, backoffDelayMs } from "../src/lib/fetch-budget";
import { isProviderError } from "../src/lib/provider-errors";

const hits: Record<string, number> = {};

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  hits[url] = (hits[url] ?? 0) + 1;
  const n = hits[url];

  if (url === "/timeout-then-ok") {
    if (n === 1) return; // hang forever — client per-attempt timeout must fire
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url === "/429-then-ok") {
    if (n === 1) {
      res.writeHead(429, { "Retry-After": "1" });
      res.end("rate limited");
      return;
    }
    res.writeHead(200);
    res.end("ok");
    return;
  }
  if (url === "/502-always") {
    res.writeHead(502);
    res.end("bad gateway");
    return;
  }
  if (url === "/401" || url === "/401-return") {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  res.writeHead(404);
  res.end();
});

async function main() {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  const base = `http://127.0.0.1:${addr.port}`;

  // 0. helpers
  assert.equal(parseRetryAfterMs("2"), 2000);
  const httpDateMs = parseRetryAfterMs(new Date(Date.now() + 5000).toUTCString());
  assert.ok(httpDateMs !== null && httpDateMs > 3000 && httpDateMs <= 5500, `http-date Retry-After parsed: ${httpDateMs}`);
  assert.equal(parseRetryAfterMs("garbage"), null);
  assert.equal(parseRetryAfterMs(null), null);
  const d = backoffDelayMs(2);
  assert.ok(d >= 2000 && d < 2500, `backoff(2) in [2000,2500): ${d}`);

  // 1. per-attempt timeout, then success
  const res1 = await fetchWithBudget(`${base}/timeout-then-ok`, {}, {
    provider: "test", timeoutMs: 500, retries: 2, wallClockMs: 30_000,
  });
  assert.equal(res1.status, 200);
  assert.equal(hits["/timeout-then-ok"], 2, "timeout case: exactly 2 attempts");

  // 2. 429 honors Retry-After: 1
  const t0 = Date.now();
  const res2 = await fetchWithBudget(`${base}/429-then-ok`, {}, {
    provider: "test", timeoutMs: 5_000, retries: 2, wallClockMs: 30_000,
  });
  const elapsed = Date.now() - t0;
  assert.equal(res2.status, 200);
  assert.equal(hits["/429-then-ok"], 2, "429 case: exactly 2 attempts");
  assert.ok(elapsed >= 950, `waited Retry-After (~1s), got ${elapsed}ms`);

  // 3. 502 × 3 → ProviderError 'transient'
  let err3: unknown;
  try {
    await fetchWithBudget(`${base}/502-always`, {}, {
      provider: "test", timeoutMs: 5_000, retries: 2, wallClockMs: 30_000,
    });
  } catch (e) {
    err3 = e;
  }
  if (!isProviderError(err3)) throw new Error("502 case did not throw ProviderError");
  assert.equal(err3.code, "transient");
  assert.equal(err3.status, 502);
  assert.equal(err3.retryable, true);
  assert.equal(hits["/502-always"], 3, "502 case: exactly 3 attempts (1 + 2 retries)");

  // 4. 401 → immediate invalid_key for provider 'heygen' (no retry)
  let err4: unknown;
  try {
    await fetchWithBudget(`${base}/401`, {}, {
      provider: "heygen", timeoutMs: 5_000, retries: 2, wallClockMs: 30_000,
    });
  } catch (e) {
    err4 = e;
  }
  if (!isProviderError(err4)) throw new Error("401 case did not throw ProviderError");
  assert.equal(err4.code, "invalid_key");
  assert.equal(err4.provider, "heygen");
  assert.equal(err4.retryable, false);
  assert.equal(err4.status, 401);
  assert.equal(hits["/401"], 1, "401 case: exactly 1 request (no retry)");

  // 5. returnHttpErrors: caller keeps its own res.status mapping; body stays readable
  const res5 = await fetchWithBudget(`${base}/401-return`, {}, {
    provider: "heygen", timeoutMs: 5_000, retries: 1, wallClockMs: 30_000, returnHttpErrors: true,
  });
  assert.equal(res5.status, 401);
  const body5 = await res5.json();
  assert.equal(body5.error, "unauthorized");
  assert.equal(hits["/401-return"], 1);

  console.log("verify-fetch-budget: ALL PASS");
}

main()
  .then(() => {
    server.closeAllConnections?.();
    server.close();
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    server.closeAllConnections?.();
    server.close();
    process.exit(1);
  });
```

- [ ] **Step 2: Run it — expect FAILURE**

```bash
npx tsx scripts/verify-fetch-budget.ts
```

Expected: `ERR_MODULE_NOT_FOUND ... Cannot find module '.../src/lib/fetch-budget'`, non-zero exit.

- [ ] **Step 3: Create `src/lib/fetch-budget.ts`**

Create the file with exactly:

```ts
/**
 * fetchWithBudget — fetch with a per-attempt timeout, bounded retries, and a
 * wall-clock cap. Final failures are thrown as ProviderError (§8 taxonomy).
 *
 * Retry policy (EXPLICIT — do not widen it):
 * - Retries ONLY on (a) network errors / per-attempt timeouts (the request may
 *   never have reached the server) and (b) HTTP statuses in `retryOn`
 *   (default 429, 500, 502, 503, 504 — i.e. the server SAID it failed).
 * - 429 honors the Retry-After header (delta-seconds or HTTP-date), capped by
 *   the remaining wall clock.
 * - Any other status (400/401/402/403/404 …) is NEVER retried.
 * - Non-idempotent POSTs that must not double-submit (e.g. HeyGen generate,
 *   which spends user credits) should pass `retries: 0`.
 *
 * Contract: resolves ONLY with an `ok` Response. Non-ok final outcomes throw
 * ProviderError — unless `returnHttpErrors: true`, in which case the final
 * non-ok Response is returned (body untouched) so existing `res.status`
 * mapping at the call site keeps working; network/timeout failures still throw.
 */
import { providerError, classifyHttpStatus, type ProviderError } from "./provider-errors";

export interface FetchBudgetOptions {
  /** Per-attempt timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Extra attempts after the first. Default 2. */
  retries?: number;
  /** HTTP statuses worth retrying. Default [429, 500, 502, 503, 504]. */
  retryOn?: number[];
  /** Total budget across attempts + backoff, in ms. Default 120s. */
  wallClockMs?: number;
  /** Provider tag for error classification, e.g. "heygen". */
  provider: string;
  /** Return the final non-ok HTTP Response instead of throwing. Default false. */
  returnHttpErrors?: boolean;
}

const DEFAULT_RETRY_ON = [429, 500, 502, 503, 504];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parse Retry-After: delta-seconds ("2") or HTTP-date. null if absent/garbage. */
export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/** Jittered exponential backoff: 1s, 2s, 4s … + 0-500ms jitter. */
export function backoffDelayMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
}

/** Compose the caller's signal with a per-attempt timeout (AbortSignal.any when available). */
function composeSignal(callerSignal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) return timeoutSignal;
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn([callerSignal, timeoutSignal]);
  return timeoutSignal; // Node < 20.3 fallback — timeout still applies
}

function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

export async function fetchWithBudget(
  url: string,
  init: RequestInit = {},
  options: FetchBudgetOptions,
): Promise<Response> {
  const {
    timeoutMs = 30_000,
    retries = 2,
    retryOn = DEFAULT_RETRY_ON,
    wallClockMs = 120_000,
    provider,
    returnHttpErrors = false,
  } = options;

  const startedAt = Date.now();
  const maxAttempts = retries + 1;
  let lastFailure: ProviderError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: composeSignal(init.signal, timeoutMs) });
    } catch (e) {
      // Network error or per-attempt timeout — the request may never have
      // arrived, so a retry is safe and the failure is transient.
      const reason = isTimeoutError(e)
        ? `timeout after ${timeoutMs}ms`
        : e instanceof Error ? e.message : String(e);
      lastFailure = providerError(
        "transient",
        provider,
        `${provider} fetch failed (attempt ${attempt}/${maxAttempts}): ${reason}`,
      );
      if (attempt < maxAttempts) {
        const delay = backoffDelayMs(attempt);
        if (Date.now() - startedAt + delay < wallClockMs) {
          await sleep(delay);
          continue;
        }
      }
      throw lastFailure;
    }

    if (res.ok) return res;

    // clone() so a returned Response (returnHttpErrors) keeps a readable body
    const excerpt = await res.clone().text().then((t) => t.slice(0, 300)).catch(() => "");
    lastFailure = providerError(
      classifyHttpStatus(res.status),
      provider,
      `${provider} returned HTTP ${res.status}: ${excerpt}`,
      { status: res.status },
    );

    if (retryOn.includes(res.status) && attempt < maxAttempts) {
      const retryAfterMs = res.status === 429 ? parseRetryAfterMs(res.headers.get("retry-after")) : null;
      const delay = retryAfterMs ?? backoffDelayMs(attempt);
      if (Date.now() - startedAt + delay < wallClockMs) {
        await sleep(delay);
        continue;
      }
      // wall clock exhausted — fall through to final handling
    }

    if (returnHttpErrors) return res;
    throw lastFailure;
  }

  // Unreachable: every loop path returns, continues, or throws.
  throw lastFailure ?? providerError("fatal", provider, `${provider}: attempts exhausted`);
}
```

- [ ] **Step 4: Run the verify script — expect PASS**

```bash
npx tsx scripts/verify-fetch-budget.ts
```

Expected output (after ~8s — the backoff sleeps are real): `verify-fetch-budget: ALL PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fetch-budget.ts scripts/verify-fetch-budget.ts
git commit -m "$(cat <<'EOF'
feat(net): add fetchWithBudget — timeout/retry/wall-clock armor (PR-5)

Per-attempt AbortSignal.timeout (composed with caller signal), jittered
exponential backoff, Retry-After support on 429, retries only on
network errors/429/5xx, final failures classified as ProviderError.
Verified by scripts/verify-fetch-budget.ts against a scripted local
http server (timeout→ok, 429→ok, 502×3, 401-immediate).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5.3: Remove the process-wide undici override in tts-gemini

**Files:**
- Modify: `src/app/api/videos/tts-gemini/route.ts`

> Note: `undici` is NOT a direct dependency in `package.json` — it resolves transitively (node_modules has undici 6.x) and this file already imports it on `main` today, so the import keeps working. Do NOT add it to `package.json` (shared file — wao coordination required).

- [ ] **Step 1: Replace the global dispatcher with a module-scoped per-request Agent**

In `src/app/api/videos/tts-gemini/route.ts`, current code (lines 9–12):

```ts
import { setGlobalDispatcher, Agent } from "undici";

// Long scripts (5-6 min) produce large base64 audio responses — extend timeouts
setGlobalDispatcher(new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }));
```

Replace with:

```ts
import { Agent } from "undici";

// Long scripts (5-6 min) produce large base64 audio responses — extend timeouts
// for the Gemini TTS call ONLY, via a per-request dispatcher. (Previously this
// was setGlobalDispatcher, which silently let EVERY fetch in the whole Node
// process hang up to 10 minutes per phase — design doc §1 root cause 5.)
const geminiTtsDispatcher = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });
```

- [ ] **Step 2: Pass the dispatcher only to the long Gemini TTS fetch**

Same file, current code (lines 72–79, inside the retry loop):

```ts
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: requestBody,
        });
```

Replace with:

```ts
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: requestBody,
          // undici-specific fetch option — not part of the standard RequestInit type
          dispatcher: geminiTtsDispatcher,
        } as RequestInit & { dispatcher: Agent });
```

- [ ] **Step 3: Verify the override is gone and types are clean**

```bash
grep -rn "setGlobalDispatcher" src/
npx tsc --noEmit 2>&1 | grep "tts-gemini"
```

Expected: BOTH commands print nothing (grep exits 1 — that is the pass condition). The route keeps its existing model-chain/backoff logic untouched. (Verified: `setGlobalDispatcher` appears exactly once in `src/` today — in this file — so the first grep going silent proves the removal is complete.)

- [ ] **Step 4: Commit**

```bash
git add src/app/api/videos/tts-gemini/route.ts
git commit -m "$(cat <<'EOF'
fix(tts-gemini): scope 600s undici timeouts to the TTS call only (PR-5)

setGlobalDispatcher extended headers/body timeouts to 10 min for every
fetch in the process; replace with a module-scoped Agent passed via the
per-request `dispatcher` option on the one long Gemini TTS call.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5.4: HeyGen armor — poll-avatar + generate-with-bg

**Files:**
- Modify: `src/app/api/videos/poll-avatar/route.ts`
- Modify: `src/app/api/heygen/generate-with-bg/route.ts`

> **PR-1 dependency note:** PR-1 rewrote poll-avatar's handling of the HeyGen response (`res.ok` + terminal-status mapping for 401/400112/404/402), but it did NOT change the fetch call itself. The "current code" quotes below are from `main` pre-PR-1; after pulling main with PR-1 merged, locate the single `video_status.get` fetch and apply exactly the substitution shown — keep PR-1's status-mapping code that follows it untouched. `returnHttpErrors: true` is used deliberately so PR-1's mapping still receives the non-ok Response.

- [ ] **Step 1: Re-confirm PR-1's mapping exists**

```bash
grep -n "video_status.get" src/app/api/videos/poll-avatar/route.ts
grep -cn "res.ok\|invalid_key" src/app/api/videos/poll-avatar/route.ts
```

Expected: first grep shows exactly one fetch URL line; second prints a count ≥ 1. If the second prints `0`, STOP — PR-1 missing.

- [ ] **Step 2: poll-avatar — add the import**

In `src/app/api/videos/poll-avatar/route.ts`, current code (lines 1–3):

```ts
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
```

Replace with:

```ts
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { fetchWithBudget } from "@/lib/fetch-budget";
```

- [ ] **Step 3: poll-avatar — budget the HeyGen status call (15s, 1 retry)**

Same file, current code (as on `main` pre-PR-1; the fetch expression is identical post-PR-1):

```ts
    const res = await fetch(
      `https://api.heygen.com/v1/video_status.get?video_id=${videoId}`,
      { headers: { "X-Api-Key": heygenKey } }
    );
```

Replace with:

```ts
    // HeyGen status budget: 15s/attempt, 1 retry (network/429/5xx only).
    // returnHttpErrors keeps PR-1's res.status → terminal-state mapping working
    // unchanged on 401/402/404 responses.
    let res: Response;
    try {
      res = await fetchWithBudget(
        `https://api.heygen.com/v1/video_status.get?video_id=${videoId}`,
        { headers: { "X-Api-Key": heygenKey } },
        { provider: "heygen", timeoutMs: 15_000, retries: 1, wallClockMs: 25_000, returnHttpErrors: true },
      );
    } catch (e) {
      // Network error / timeout — genuinely transient: report a NON-terminal
      // status so the client keeps polling (PR-2's stale timeout bounds it).
      console.warn("[poll-avatar] transient HeyGen failure:", e instanceof Error ? e.message : e);
      return NextResponse.json({ status: "unknown", videoUrl: null, thumbnailUrl: null, errorMsg: null, transient: true });
    }
```

Keep everything after this point (PR-1's `res.ok`/status mapping and the route's outer catch) exactly as merged.

- [ ] **Step 4: generate-with-bg — add imports**

In `src/app/api/heygen/generate-with-bg/route.ts`, current code (lines 1–6):

```ts
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
```

Replace with:

```ts
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { fetchWithBudget } from "@/lib/fetch-budget";
import { isProviderError, providerError, classifyHttpStatus, toErrorResponse } from "@/lib/provider-errors";
```

- [ ] **Step 5: generate-with-bg — budget the background-asset upload (120s, 1 retry, throws taxonomy)**

Same file, current code (inside `uploadAsset`, lines 56–64):

```ts
  const res = await fetch("https://upload.heygen.com/v1/asset", {
    method: "POST",
    headers: { "X-API-KEY": heygenKey, "Content-Type": ct, Accept: "application/json" },
    body: buffer as unknown as BodyInit,
  });
  const data = await res.json();
  console.log("[generate-with-bg] upload result:", res.status, JSON.stringify(data));
  if (!res.ok || !data.data?.id) throw new Error(`Upload failed: ${data.message ?? res.status}`);
  return { id: data.data.id as string, url: (data.data.url as string) ?? null };
```

Replace with:

```ts
  // HeyGen asset-upload budget: 120s/attempt, 1 retry (network/429/5xx only —
  // a duplicated upload only creates an unused asset, no user-visible harm).
  // Non-ok statuses throw ProviderError → surfaced by the route-level catch.
  const res = await fetchWithBudget("https://upload.heygen.com/v1/asset", {
    method: "POST",
    headers: { "X-API-KEY": heygenKey, "Content-Type": ct, Accept: "application/json" },
    body: buffer as unknown as BodyInit,
  }, { provider: "heygen", timeoutMs: 120_000, retries: 1, wallClockMs: 300_000 });
  const data = await res.json();
  console.log("[generate-with-bg] upload result:", res.status, JSON.stringify(data));
  if (!data.data?.id) throw new Error(`Upload failed: ${data.message ?? res.status}`);
  return { id: data.data.id as string, url: (data.data.url as string) ?? null };
```

- [ ] **Step 6: generate-with-bg — budget the audio upload (keep its crafted Thai error handling)**

Same file, current code (lines 158–163):

```ts
    const uploadRes = await fetch("https://upload.heygen.com/v1/asset", {
      method: "POST",
      headers: { "X-API-KEY": heygenKey, "Content-Type": "audio/mpeg", Accept: "application/json" },
      body: buffer as unknown as BodyInit,
    });
    const uploadData = await uploadRes.json();
```

Replace with:

```ts
    // Audio upload budget: 120s/attempt, 1 retry. returnHttpErrors keeps the
    // carefully-worded Thai 401-vs-other handling below working unchanged.
    const uploadRes = await fetchWithBudget("https://upload.heygen.com/v1/asset", {
      method: "POST",
      headers: { "X-API-KEY": heygenKey, "Content-Type": "audio/mpeg", Accept: "application/json" },
      body: buffer as unknown as BodyInit,
    }, { provider: "heygen", timeoutMs: 120_000, retries: 1, wallClockMs: 300_000, returnHttpErrors: true });
    const uploadData = await uploadRes.json();
```

Then, a few lines below, current code (line 175):

```ts
      return NextResponse.json({ error: msg, retryable: false }, { status: keyRejected ? 401 : 500 });
```

Replace with:

```ts
      return NextResponse.json(
        { error: msg, retryable: false, code: keyRejected ? "invalid_key" : "fatal", provider: "heygen" },
        { status: keyRejected ? 401 : 500 }
      );
```

(This branch deliberately keeps `retryable: false` and NO `missingKey` — the existing code chose toast-only here, no key modal; preserve that UX.)

- [ ] **Step 7: generate-with-bg — budget the generate call (60s, NO retries) and map its errors to the taxonomy**

Same file, current code (lines 202–218):

```ts
  console.log("[generate-with-bg] generate payload:", JSON.stringify(payload));
  const genRes = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: { "X-Api-Key": heygenKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const genData = await genRes.json();
  console.log("[generate-with-bg] generate response:", genRes.status, JSON.stringify(genData));

  if (!genRes.ok || !genData.data?.video_id) {
    // retryable:false — generate ล้มเหลว (เช่น credit หมด, พารามิเตอร์ไม่ผ่าน) ไม่ใช่ key หาย
    // ไม่งั้น client เปิด modal ใส่ key ซ้ำ ทำให้ผู้ใช้เข้าใจผิดว่า key มีปัญหา
    return NextResponse.json(
      { error: `HeyGen generate failed: ${JSON.stringify(genData.error ?? genData)}`, retryable: false },
      { status: 500 }
    );
  }
```

Replace with:

```ts
  console.log("[generate-with-bg] generate payload:", JSON.stringify(payload));
  // HeyGen generate budget: 60s, NO retries — a duplicated generate would
  // spend the user's HeyGen credits twice. returnHttpErrors → map status below.
  const genRes = await fetchWithBudget("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: { "X-Api-Key": heygenKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, { provider: "heygen", timeoutMs: 60_000, retries: 0, wallClockMs: 65_000, returnHttpErrors: true });
  const genData = await genRes.json();
  console.log("[generate-with-bg] generate response:", genRes.status, JSON.stringify(genData));

  if (!genRes.ok || !genData.data?.video_id) {
    if (!genRes.ok) {
      // §8 mapping: 401→invalid_key(401)+missingKey (key modal ถูกต้องเมื่อ key
      // ถูกปฏิเสธจริง), 402/403→quota(402) เช่น credit หมด — ไม่เปิด modal ใส่ key,
      // 429→rate_limit(429), 5xx→transient(503)
      const pErr = providerError(
        classifyHttpStatus(genRes.status),
        "heygen",
        `HeyGen generate failed (${genRes.status}): ${JSON.stringify(genData.error ?? genData).slice(0, 300)}`,
        { status: genRes.status },
      );
      const { body: errBody, status } = toErrorResponse(pErr);
      return NextResponse.json(errBody, { status });
    }
    // 200 แต่ไม่มี video_id — response ผิดรูป ไม่ใช่ปัญหา key (อย่าเปิด modal ใส่ key ซ้ำ)
    return NextResponse.json(
      { error: `HeyGen generate failed: ${JSON.stringify(genData.error ?? genData)}`, retryable: false },
      { status: 500 }
    );
  }
```

- [ ] **Step 8: generate-with-bg — route-level catch returning the ProviderError shape**

Same file, current code (lines 67–71):

```ts
// POST /api/heygen/generate-with-bg
// Mode A (video bg): { text|audioUrl, avatarId, bgVideoUrl, scale?, offsetX?, offsetY? }
// Mode B (green screen): { text|audioUrl, avatarId, greenScreen: true, scale?, offsetX?, offsetY? }
// Returns: { videoId }
export async function POST(req: Request) {
```

Replace with:

```ts
// POST /api/heygen/generate-with-bg
// Mode A (video bg): { text|audioUrl, avatarId, bgVideoUrl, scale?, offsetX?, offsetY? }
// Mode B (green screen): { text|audioUrl, avatarId, greenScreen: true, scale?, offsetX?, offsetY? }
// Returns: { videoId }
export async function POST(req: Request) {
  try {
    return await handleGenerateWithBg(req);
  } catch (error) {
    if (isProviderError(error)) {
      console.error(`[generate-with-bg] ${error.provider}/${error.code}:`, error.message);
      const { body: errBody, status } = toErrorResponse(error);
      return NextResponse.json(errBody, { status });
    }
    console.error("[generate-with-bg] unexpected error:", error);
    return NextResponse.json(
      { error: "ระบบ Avatar ทำงานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", retryable: false },
      { status: 500 }
    );
  }
}

async function handleGenerateWithBg(req: Request) {
```

(The existing function body — starting with `const authUser = await getCurrentUser();` — is now the body of `handleGenerateWithBg`; no other lines change. Note: the catch messages deliberately avoid the words "Unauthorized"/"401", which video-creator maps to "Session หมดอายุ".)

- [ ] **Step 9: Type-check + manual verification**

```bash
npx tsc --noEmit 2>&1 | grep -E "poll-avatar|generate-with-bg"
```

Expected: no output. Then manual check (dev): run `npm run dev`, log in, set a deliberately broken HeyGen key in Settings (e.g. append "x"), start an avatar generation in `/video-creator` → the request to `/api/heygen/generate-with-bg` fails fast (within seconds — HeyGen rejects a bad key immediately; the point is no multi-minute hang). Which JSON you see depends on which HeyGen call fails first:
- **bg-video upload or generate path** (Mode A, or text voice): status `401` with `"code":"invalid_key"`, `"provider":"heygen"`, `"missingKey":"heygen"`, a Thai `error` message, and NO `retryable` field — the fix-your-key modal opens.
- **audio-upload path** (avatar with a generated voice file): status `401` with the existing crafted Thai message + `"retryable":false` + `"code":"invalid_key"` — toast only, no modal (deliberately preserved behavior from line 175's branch).

Restore your real key afterwards.

- [ ] **Step 10: Commit**

```bash
git add src/app/api/videos/poll-avatar/route.ts src/app/api/heygen/generate-with-bg/route.ts
git commit -m "$(cat <<'EOF'
feat(heygen): budget avatar calls + taxonomy error responses (PR-5)

- poll-avatar: 15s/attempt + 1 retry on the status call; network/timeout
  failures return a non-terminal status so polling continues (bounded by
  PR-2's stale timeout); PR-1's terminal-status mapping untouched.
- generate-with-bg: 120s budgets on both asset uploads (1 retry), 60s
  NO-retry budget on generate (avoid double credit spend), upstream
  statuses mapped to invalid_key/quota/rate_limit/transient with correct
  HTTP statuses, route-level catch returns the ProviderError shape.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5.5: Stock search/download armor (`fetch-stock`)

**Files:**
- Modify: `src/app/api/videos/fetch-stock/route.ts`

- [ ] **Step 1: Add imports**

In `src/app/api/videos/fetch-stock/route.ts`, current code (lines 1–6):

```ts
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { geminiGenerateText } from "@/lib/gemini";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { recordTelemetryEvent } from "@/lib/telemetry";
```

Replace with:

```ts
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { geminiGenerateText } from "@/lib/gemini";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { fetchWithBudget } from "@/lib/fetch-budget";
import { isProviderError, toErrorResponse, type ProviderError } from "@/lib/provider-errors";
```

- [ ] **Step 2: Budget the Pexels search (20s, 2 retries)**

Same file, current code (lines 153–157, inside `searchPexels`):

```ts
  const res = await fetch(`https://api.pexels.com/videos/search?${params}`, {
    headers: { Authorization: apiKey },
  });

  if (!res.ok) throw new Error(`Pexels search failed: ${res.status}`);
```

Replace with:

```ts
  // Stock-search budget: 20s/attempt, 2 retries (429 honors Retry-After).
  // Final non-ok throws ProviderError — existing callers already treat a
  // throw as "no candidates for this keyword".
  const res = await fetchWithBudget(`https://api.pexels.com/videos/search?${params}`, {
    headers: { Authorization: apiKey },
  }, { provider: "pexels", timeoutMs: 20_000, retries: 2, wallClockMs: 60_000 });
```

- [ ] **Step 3: Budget the Pixabay search (20s, 2 retries)**

Same file, current code (lines 263–264, inside `searchPixabay`):

```ts
  const res = await fetch(`https://pixabay.com/api/videos/?${params}`);
  if (!res.ok) throw new Error(`Pixabay search failed: ${res.status}`);
```

Replace with:

```ts
  const res = await fetchWithBudget(`https://pixabay.com/api/videos/?${params}`, {},
    { provider: "pixabay", timeoutMs: 20_000, retries: 2, wallClockMs: 60_000 });
```

- [ ] **Step 4: Budget the CDN download (120s; retries stay in the existing outer loop)**

Same file, current code (line 213, inside `downloadAndCrop`):

```ts
  const TIMEOUT_MS = 90_000; // 90s — Pixabay CDN บางไฟล์ใหญ่ช้ามาก
```

Replace with:

```ts
  const TIMEOUT_MS = 120_000; // 120s — Pixabay CDN บางไฟล์ใหญ่ช้ามาก (PR-5 stock-download budget)
```

Then current code (lines 218–225):

```ts
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          // บาง CDN บล็อก bot — ใส่ User-Agent เหมือน browser
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        },
      });
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
```

Replace with:

```ts
      // retries: 0 — downloadAndCrop's own MAX_ATTEMPTS loop already retries
      // (it also re-validates the file on disk, which fetchWithBudget can't).
      const res = await fetchWithBudget(url, {
        headers: {
          // บาง CDN บล็อก bot — ใส่ User-Agent เหมือน browser
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        },
      }, { provider: "stock-cdn", timeoutMs: TIMEOUT_MS, retries: 0, wallClockMs: TIMEOUT_MS + 5_000 });
```

- [ ] **Step 5: Capture invalid_key during search instead of silently swallowing it**

Same file, current code (line 571):

```ts
  const usedIds = new Set<number>();
```

Replace with:

```ts
  const usedIds = new Set<number>();
  let stockProviderError: ProviderError | null = null; // จับ invalid_key ไว้รายงานตอนท้าย — เดิมถูกกลืนเงียบ
```

Then current code (lines 622–632, inside the search `mapWithConcurrency` callback):

```ts
          const [pexelsRaw, pixabayRaw] = await Promise.allSettled([
            canUsePexels
              ? searchPexels(query, pexelsKey!, 3, basePerPage)
              : Promise.resolve([] as PexelsVideo[]),
            canUsePixabay
              ? searchPixabay(query, pixabayKey).catch(() => [] as { id: number; duration: number; videoUrl: string }[])
              : Promise.resolve([] as { id: number; duration: number; videoUrl: string }[]),
          ]);

          const pexelsVideos = pexelsRaw.status === "fulfilled" ? pexelsRaw.value : [];
          const pixabayVideos = pixabayRaw.status === "fulfilled" ? pixabayRaw.value : [];
```

Replace with:

```ts
          const [pexelsRaw, pixabayRaw] = await Promise.allSettled([
            canUsePexels
              ? searchPexels(query, pexelsKey!, 3, basePerPage)
              : Promise.resolve([] as PexelsVideo[]),
            canUsePixabay
              ? searchPixabay(query, pixabayKey!)
              : Promise.resolve([] as { id: number; duration: number; videoUrl: string }[]),
          ]);

          for (const settled of [pexelsRaw, pixabayRaw]) {
            if (settled.status === "rejected" && isProviderError(settled.reason) && !stockProviderError) {
              stockProviderError = settled.reason;
            }
          }
          const pexelsVideos = pexelsRaw.status === "fulfilled" ? pexelsRaw.value : [];
          const pixabayVideos = pixabayRaw.status === "fulfilled" ? pixabayRaw.value : [];
```

- [ ] **Step 6: Surface invalid_key when zero clips were found**

Same file, current code (lines 836–839):

```ts
  if (!clipsToDownload.length) {
    await recordFetchStockTelemetry("done", { emptyResult: true });
    return NextResponse.json({ results: [] });
  }
```

Replace with:

```ts
  if (!clipsToDownload.length) {
    // หาคลิปไม่ได้เลยและสาเหตุคือ key ใช้ไม่ได้ — บอกผู้ใช้ตรง ๆ แทน results ว่าง
    if (stockProviderError && stockProviderError.code === "invalid_key") {
      await recordFetchStockTelemetry("error", {
        providerErrorCode: stockProviderError.code,
        errorProvider: stockProviderError.provider,
      });
      const { body: errBody, status } = toErrorResponse(stockProviderError);
      return NextResponse.json(errBody, { status });
    }
    await recordFetchStockTelemetry("done", { emptyResult: true });
    return NextResponse.json({ results: [] });
  }
```

- [ ] **Step 7: Type-check + manual verification**

```bash
npx tsc --noEmit 2>&1 | grep "fetch-stock"
```

Expected: no output. Manual (dev server running): a normal B-roll fetch in the video-creator flow still returns clips. Then set an INVALID Pexels key and REMOVE/empty the Pixabay key in Settings, retry → expect HTTP `401` with `"code":"invalid_key"` and `"missingKey":"pexels"` instead of a silent empty result, and the fix-your-key modal opens. (Note: Pixabay reports bad keys as HTTP 400 → classified `fatal`, so the invalid_key surfacing is Pexels-specific; a bad Pixabay key still just yields the empty-result path.) Restore keys.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/videos/fetch-stock/route.ts
git commit -m "$(cat <<'EOF'
feat(stock): budget Pexels/Pixabay calls and surface invalid_key (PR-5)

Search: 20s/attempt + 2 retries per provider. Download: 120s budget,
outer attempt loop unchanged. invalid_key rejections are no longer
swallowed — when zero clips are found because the key is bad, the
route returns 401 + missingKey so the fix-your-key modal opens.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5.6: ElevenLabs TTS armor (`videos/tts`)

**Files:**
- Modify: `src/app/api/videos/tts/route.ts`

- [ ] **Step 1: Add imports and raise maxDuration to match the 300s budget**

In `src/app/api/videos/tts/route.ts`, current code (lines 1–8):

```ts
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";

export const maxDuration = 120;
export const runtime = "nodejs";
```

Replace with:

```ts
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { fetchWithBudget } from "@/lib/fetch-budget";
import { classifyHttpStatus, isProviderError, providerError, toErrorResponse } from "@/lib/provider-errors";

export const maxDuration = 300; // TTS budget is 300s/attempt (long scripts)
export const runtime = "nodejs";
```

- [ ] **Step 2: Wrap the handler so thrown ProviderErrors become taxonomy responses**

Same file, current code (lines 10–13):

```ts
// POST /api/videos/tts
// Body: { text, voiceId? }
// Returns: { voiceUrl, filename }
export async function POST(req: Request) {
```

Replace with:

```ts
// POST /api/videos/tts
// Body: { text, voiceId? }
// Returns: { voiceUrl, filename }
export async function POST(req: Request) {
  try {
    return await handleTts(req);
  } catch (error) {
    if (isProviderError(error)) {
      console.error(`[tts] ${error.provider}/${error.code}:`, error.message);
      const { body: errBody, status } = toErrorResponse(error);
      return NextResponse.json(errBody, { status });
    }
    console.error("[tts] unexpected error:", error);
    return NextResponse.json({ error: "ระบบเสียงทำงานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" }, { status: 500 });
  }
}

async function handleTts(req: Request) {
```

(The existing body starting `const authUser = await getCurrentUser();` becomes `handleTts`'s body unchanged.)

- [ ] **Step 3: Budget the main ElevenLabs call (300s, 1 retry)**

Same file, current code (lines 29–38):

```ts
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: text.trim(),
      model_id: "eleven_v3",
      language_code: languageCode,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true },
    }),
  });
```

Replace with:

```ts
  // ElevenLabs TTS budget: 300s/attempt (long scripts), 1 retry on network/429/5xx.
  // returnHttpErrors keeps the language_code-fallback logic below working.
  const res = await fetchWithBudget(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: text.trim(),
      model_id: "eleven_v3",
      language_code: languageCode,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true },
    }),
  }, { provider: "elevenlabs", timeoutMs: 300_000, retries: 1, wallClockMs: 660_000, returnHttpErrors: true });
```

- [ ] **Step 4: Budget the language_code-fallback call (300s, no extra retry)**

Same file, current code (lines 46–54):

```ts
      const retry = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text.trim(),
          model_id: "eleven_v3",
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true },
        }),
      });
```

Replace with:

```ts
      const retry = await fetchWithBudget(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text.trim(),
          model_id: "eleven_v3",
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true },
        }),
      }, { provider: "elevenlabs", timeoutMs: 300_000, retries: 0, wallClockMs: 320_000, returnHttpErrors: true });
```

- [ ] **Step 5: Return the taxonomy shape on final ElevenLabs failure**

Same file, current code (line 66):

```ts
    return NextResponse.json({ error: `ElevenLabs failed (${res.status}): ${err.slice(0, 200)}` }, { status: 500 });
```

Replace with:

```ts
    // ElevenLabs ส่ง quota หมดเป็น 401 + "quota_exceeded" — แยกจาก key ผิด
    const code = err.includes("quota_exceeded") ? ("quota" as const) : classifyHttpStatus(res.status);
    const pErr = providerError(code, "elevenlabs", `ElevenLabs failed (${res.status}): ${err.slice(0, 200)}`, { status: res.status });
    const { body: errBody, status } = toErrorResponse(pErr);
    return NextResponse.json(errBody, { status });
```

- [ ] **Step 6: Type-check + manual verification**

```bash
npx tsc --noEmit 2>&1 | grep "tts/route"
```

Expected: no output. Manual (dev, requires a PRO account with an ElevenLabs key): generate a voice in video-creator with ElevenLabs selected → mp3 returned as before. With an invalid key → HTTP `401`, body has `"code":"invalid_key"`, `"missingKey":"elevenlabs"`, no `retryable` field — the fix-your-key modal opens.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/videos/tts/route.ts
git commit -m "$(cat <<'EOF'
feat(tts): budget ElevenLabs call + taxonomy error responses (PR-5)

300s/attempt budget with 1 retry on network/429/5xx; final failures
return invalid_key(401)/quota(402, quota_exceeded detect)/
rate_limit(429)/transient(503) instead of a blanket 500.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5.7: Gemini text budget (`src/lib/gemini.ts`)

**Files:**
- Modify: `src/lib/gemini.ts`

- [ ] **Step 1: Rewrite `geminiGenerateText` with a 120s budget, transient retry, and ProviderError classification**

Current complete content of `src/lib/gemini.ts`:

```ts
import { GoogleGenAI } from "@google/genai";

const GEMINI_MODEL = "gemini-2.5-flash";

export async function geminiGenerateText(
  apiKey: string,
  prompt: string,
  maxOutputTokens = 4096,
  temperature = 0,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      maxOutputTokens,
      temperature,
      thinkingConfig: { thinkingBudget: 0 },  // disable thinking — JSON output must not be prefixed with thought text
    },
  });
  return response.text ?? "";
}
```

Replace the WHOLE file with:

```ts
import { GoogleGenAI } from "@google/genai";
import { getGeminiErrorInfo, type GeminiErrorKind } from "./gemini-errors";
import { providerError, type ProviderErrorCode } from "./provider-errors";

const GEMINI_MODEL = "gemini-2.5-flash";
// PR-5 budget: text generation must never hang a route for minutes.
const GEMINI_TEXT_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3; // 1 call + 2 retries on retryable failures

function codeFromGeminiInfo(kind: GeminiErrorKind, status: number, retryable: boolean): ProviderErrorCode {
  if (kind === "invalid_key") return "invalid_key";
  // Account problems (non-retryable) BEFORE the 429 check: gemini-errors
  // reports kind "billing" with status 429 when the upstream status was 429,
  // and that must stay `quota` (retryable:false), not become `rate_limit`.
  if (kind === "billing" || kind === "permission" || kind === "api_disabled") return "quota";
  if (kind === "quota" || status === 429) return "rate_limit";
  if (status === 402 || status === 403) return "quota";
  if (retryable || status >= 500 || kind === "timeout" || kind === "high_demand") return "transient";
  return "fatal";
}

export async function geminiGenerateText(
  apiKey: string,
  prompt: string,
  maxOutputTokens = 4096,
  temperature = 0,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: GEMINI_TEXT_TIMEOUT_MS } });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          maxOutputTokens,
          temperature,
          thinkingConfig: { thinkingBudget: 0 },  // disable thinking — JSON output must not be prefixed with thought text
          abortSignal: AbortSignal.timeout(GEMINI_TEXT_TIMEOUT_MS),
        },
      });
      return response.text ?? "";
    } catch (e) {
      const info = getGeminiErrorInfo(e);
      if (info.retryable && attempt < MAX_ATTEMPTS) {
        const delayMs = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
        console.warn(`[gemini] ${info.kind} (attempt ${attempt}/${MAX_ATTEMPTS}) — retry in ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw providerError(
        codeFromGeminiInfo(info.kind, info.status, info.retryable),
        "gemini",
        info.technicalMessage || (e instanceof Error ? e.message : String(e)),
        { status: info.status, userAction: info.userMessage },
      );
    }
  }
  // Unreachable — the loop always returns or throws — TS needs a tail.
  throw providerError("transient", "gemini", "gemini retries exhausted");
}
```

(`ProviderError` extends `Error`, so existing callers — `fetch-stock` LLM ranking fallback, `analyze-script`, `extract-keywords`, etc. — keep working; the `userAction` carries `gemini-errors.ts`'s specific Thai message. `@google/genai@^1.50.1` supports both `GoogleGenAIOptions.httpOptions.timeout` and `GenerateContentConfig.abortSignal` — verified against `node_modules/@google/genai/dist/genai.d.ts`.)

- [ ] **Step 2: Type-check + manual smoke**

```bash
npx tsc --noEmit 2>&1 | grep -E "src/lib/gemini.ts"
```

Expected: no output. Manual (dev): run any Gemini-backed step (e.g. keyword extraction in video-creator) with a valid key → works as before; with an invalid Gemini key → the route's existing error handling shows the fix-your-key message instead of hanging.

- [ ] **Step 3: Commit**

```bash
git add src/lib/gemini.ts
git commit -m "$(cat <<'EOF'
feat(gemini): 120s budget + transient retry in geminiGenerateText (PR-5)

httpOptions.timeout + per-request AbortSignal.timeout (120s), up to 2
backoff retries on retryable failures (per gemini-errors classification),
final failures thrown as ProviderError with the existing Thai userAction.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5.8: Build, full-flow check, open the PR

**Files:** none (verification + PR only)

- [ ] **Step 1: Re-run both verify scripts and the production build**

```bash
npx tsx scripts/verify-provider-errors.ts && npx tsx scripts/verify-fetch-budget.ts
npm run build
```

Expected: `verify-provider-errors: ALL PASS`, `verify-fetch-budget: ALL PASS`, and the build finishes with `✓ Compiled successfully` (build may take several minutes locally).

- [ ] **Step 2: Manual full-flow check (spec §9)**

With `npm run dev`: (1) create a video with avatar = none → render → edit subtitles → burn — completes; (2) B-roll fetch returns clips; (3) TTS (Gemini voice) returns audio; (4) avatar flow with a valid HeyGen key reaches "processing" and poll responses appear every few seconds in the Network tab (no request pending longer than ~30s); (5) start a render and cancel mid-flight, then refresh the page → no stuck state and the flow can be resumed (spec §9). Any regression here blocks the PR.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin mew/external-call-armor
gh pr create --title "feat: external-call armor — fetchWithBudget + provider error taxonomy (PR-5)" --body "$(cat <<'EOF'
## What

Phase-1 PR-5 of the video-editor optimization design (docs/superpowers/specs/2026-06-10-video-editor-optimization-design.md §5/§8):

- **src/lib/provider-errors.ts** — shared error taxonomy `invalid_key | quota | rate_limit | transient | fatal` with Thai user messages, HTTP-status mapping (401/402/429/503/500), and a route response builder that keeps the legacy `error` + `missingKey` fields the UI already reads. NOTE: `invalid_key` responses deliberately OMIT the legacy `retryable` field — the existing `handleMissingKey` in video-creator/video-editor treats `retryable===false` as "not a key problem" and would suppress the fix-your-key modal.
- **src/lib/fetch-budget.ts** — `fetchWithBudget`: per-attempt `AbortSignal.timeout`, jittered exponential backoff, `Retry-After` support on 429, wall-clock cap; retries ONLY on network errors/429/5xx. TDD'd via `scripts/verify-fetch-budget.ts` (scripted local http server) + `scripts/verify-provider-errors.ts`.
- **tts-gemini**: removed the process-wide `setGlobalDispatcher` (it let EVERY fetch in the process hang 10 min/phase) → per-request undici Agent on the one long TTS call.
- Adopted budgets at the highest-leverage call sites: HeyGen status poll 15s / generate 60s (no retry — credits) / uploads 120s; Pexels+Pixabay search 20s / CDN download 120s; ElevenLabs TTS 300s; `geminiGenerateText` 120s. These routes now return the taxonomy JSON shape with correct HTTP statuses; fetch-stock surfaces `invalid_key` instead of a silent empty result.

## Dependency

Built on top of **PR-1** (poll-avatar terminal-status mapping) — merge after PR-1. poll-avatar keeps PR-1's mapping via `returnHttpErrors`; only network/timeout failures return a non-terminal "keep polling" status (bounded by PR-2's stale timeout).

## Review points for wao

- No shared files touched (`prisma/schema.prisma`, `package.json`, `next.config.ts` unchanged). `undici` stays a transitive dependency.
- `tts-gemini`: please confirm nothing else relied on the old process-wide 600s undici timeouts — they are now scoped to the Gemini TTS call only.
- `poll-avatar` / `generate-with-bg` are in your avatar vertical — semantics: generate has retries:0 to never double-spend HeyGen credits; 401s now return `missingKey:"heygen"` (opens the key modal); the audio-upload 401 keeps its existing toast-only behavior.

## Follow-ups (NOT in this PR — convert opportunistically)

heygen/avatars (axios, already 10s timeout), heygen/avatar-info, heygen/composite, heygen/preview-bg, heygen/preview-frame, heygen/test-avatar, heygen/upload-asset, videos/create-avatar, videos/heygen-direct, videos/tts-gemini main fetch chain (kept its bespoke model-chain retry), videos/transcribe, elevenlabs/voices.

## Test plan

- `npx tsx scripts/verify-provider-errors.ts` / `npx tsx scripts/verify-fetch-budget.ts` — ALL PASS
- `npm run build` clean; manual full flow (render → subtitles → burn, B-roll, TTS, avatar poll, cancel mid-flight → refresh/resume) on dev
- Invalid-key drills: HeyGen/Pexels/ElevenLabs bad keys → fast 401 + `missingKey` + key modal opens, no hangs

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints the new PR URL. Do NOT merge until wao reviews (and PR-1 is on main).

---

## PR-3: Editor lag fix (`mew/editor-playback-perf`)

**NO behavior changes intended — pure performance.** Today a rAF loop calls `setCurrentMs` ~60×/sec at the root of the 4,115-line `/video-editor` page (plus a duplicate inline `onTimeUpdate`), re-rendering the entire tree every frame — the direct cause of "laggy editor" (design spec §1 root cause 4, §5 PR-3). This PR moves the 60fps position into a tiny external store; only leaf components subscribe, the page root re-renders only on play/pause/seek/end/caption-change. Risk is medium — not because the change is clever, but because it touches the playback path everywhere, so it carries the heaviest manual test matrix and **deploys LAST** in the Phase-1 order (PR-4 → PR-1 → PR-2 → PR-5 → **PR-3**, spec §5). Rollback = a single `git revert` of the merge commit (no schema, no config, no API changes).

Pre-flight notes for the implementing engineer:
- `main` is production. Never commit to it. All work happens on `mew/editor-playback-perf`.
- `next.config.ts` sets `typescript.ignoreBuildErrors: true` and `eslint.ignoreDuringBuilds: true` — the build will NOT catch your type errors. Run the scoped `tsc` checks in the steps below; do not skip them.
- `src/remotion/renderSubtitle.tsx` is shared with the Remotion burn pipeline (wao's vertical). Task 3.4 is a pure refactor of it — flag in the PR body.

---

### Task 3.1: Playback-time store + binary-search caption lookup (verify-first)

**Files:**
- Create: `src/app/(dashboard)/video-editor/_lib/playback-time.ts`
- Create: `src/app/(dashboard)/video-editor/_lib/find-active-caption.ts`
- Test: `scripts/verify-editor-playback.ts`

- [ ] **Step 1: Create the feature branch**

```bash
cd /Users/mewsocialmacmini/projects/AI_content_Mew_social
git checkout main && git pull && git checkout -b mew/editor-playback-perf
```
Expected output ends with: `Switched to a new branch 'mew/editor-playback-perf'`

- [ ] **Step 2: Write the verify script FIRST (it must fail — modules don't exist yet)**

Create `scripts/verify-editor-playback.ts` with exactly:

```ts
// Proof of the editor playbackTime store + binary-search caption lookup.
// Pure logic — no DB, no React rendering. Run:
//   npx tsx scripts/verify-editor-playback.ts
import { playbackTime } from "../src/app/(dashboard)/video-editor/_lib/playback-time";
import { findActiveCaptionIdx } from "../src/app/(dashboard)/video-editor/_lib/find-active-caption";
import type { Caption } from "../src/app/(dashboard)/video-editor/_components/types";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

// ── playbackTime store ──────────────────────────────────────────────────────
assert(playbackTime.getMs() === 0, "store starts at 0");
playbackTime.setMs(1234.5);
assert(playbackTime.getMs() === 1234.5, "setMs/getMs round-trip");

let calls = 0;
const unsub = playbackTime.subscribe(() => { calls++; });
playbackTime.setMs(2000);
assert(calls === 1, "subscriber notified on change");
playbackTime.setMs(2000);
assert(calls === 1, "NO notification when value unchanged");
let calls2 = 0;
const unsub2 = playbackTime.subscribe(() => { calls2++; });
playbackTime.setMs(3000);
assert(calls === 2 && calls2 === 1, "multiple subscribers each notified once");
unsub();
playbackTime.setMs(4000);
assert(calls === 2 && calls2 === 2, "unsubscribed listener no longer notified");
unsub2();
playbackTime.setMs(0); // reset for repeat runs

// ── findActiveCaptionIdx — must be EXACTLY equivalent to the old per-frame
//    captions.findIndex(c => ms >= c.startMs && ms < c.endMs) on the sorted,
//    non-overlapping captions normalizeCaptionsForTimeline produces ──────────
const caps: Caption[] = [
  { text: "a", startMs: 0,    endMs: 1000 },
  { text: "b", startMs: 1000, endMs: 2500 },
  // gap 2500–3000
  { text: "c", startMs: 3000, endMs: 4000 },
];
assert(findActiveCaptionIdx([], 500) === -1, "empty captions → -1");
assert(findActiveCaptionIdx(caps, -10) === -1, "before first start → -1");
assert(findActiveCaptionIdx(caps, 0) === 0, "exact startMs is inclusive");
assert(findActiveCaptionIdx(caps, 999.9) === 0, "just before endMs → same caption");
assert(findActiveCaptionIdx(caps, 1000) === 1, "endMs exclusive / next startMs inclusive");
assert(findActiveCaptionIdx(caps, 2700) === -1, "gap between captions → -1");
assert(findActiveCaptionIdx(caps, 3500) === 2, "inside last caption");
assert(findActiveCaptionIdx(caps, 4000) === -1, "exact last endMs → -1 (exclusive)");
assert(findActiveCaptionIdx(caps, 99999) === -1, "after last caption → -1");

// Randomized equivalence vs the old findIndex
for (let trial = 0; trial < 50; trial++) {
  const n = 1 + Math.floor(Math.random() * 40);
  const fixture: Caption[] = [];
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const gap = Math.random() < 0.3 ? Math.floor(Math.random() * 500) : 0;
    const start = cursor + gap;
    const end = start + 100 + Math.floor(Math.random() * 3000);
    fixture.push({ text: `c${i}`, startMs: start, endMs: end });
    cursor = end;
  }
  const totalEnd = fixture[fixture.length - 1].endMs;
  for (let probe = 0; probe < 20; probe++) {
    const t = Math.random() * (totalEnd + 1000) - 200;
    const expected = fixture.findIndex(c => t >= c.startMs && t < c.endMs);
    const actual = findActiveCaptionIdx(fixture, t);
    if (actual !== expected) {
      console.error(`❌ mismatch at t=${t}: expected ${expected}, got ${actual}`, JSON.stringify(fixture));
      process.exit(1);
    }
  }
}
console.log("✓ binary search ≡ findIndex on 50 random non-overlapping fixtures × 20 probes");
passed++;

console.log(`\nAll ${passed} checks passed ✅`);
```

- [ ] **Step 3: Run it — expect FAILURE (module not found)**

```bash
npx tsx scripts/verify-editor-playback.ts
```
Expected: non-zero exit with an error like `Cannot find module '.../video-editor/_lib/playback-time'`. If it passes here, something is wrong — stop.

- [ ] **Step 4: Create `src/app/(dashboard)/video-editor/_lib/playback-time.ts`** (new directory `_lib/`) with exactly:

```ts
"use client";

import { useSyncExternalStore } from "react";

/**
 * External playback-time store — the ONLY thing that changes 60×/sec during
 * video playback. Plain emitter, no dependencies, module-level singleton
 * (one editor instance per page).
 *
 * Why: currentMs used to be React state at the root of the 4,000-line
 * /video-editor page; the rAF loop calling setCurrentMs every frame
 * re-rendered the entire tree (design spec 2026-06-10 §5 PR-3). Now the rAF
 * loop writes here, and only the few leaf components that truly need 60fps
 * subscribe (TimeLabel, PlayheadIndicator, ActiveCaptionOverlay, ScrubberBar).
 *
 * Unit: VIDEO milliseconds (video.currentTime * 1000) — same unit the old
 * currentMs state used. Caption-time mapping happens at the consumer, exactly
 * like the old videoMsToCaptionMs(currentMs).
 */
type Listener = () => void;

let currentMs = 0;
const listeners = new Set<Listener>();

export const playbackTime = {
  getMs(): number {
    return currentMs;
  },
  setMs(ms: number): void {
    if (ms === currentMs) return;
    currentMs = ms;
    for (const l of listeners) l();
  },
  subscribe(cb: Listener): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
};

/**
 * 60fps playback position as a React value. ONLY use this in small leaf
 * components — every subscriber re-renders every frame during playback.
 * For one-shot reads in event handlers use playbackTime.getMs() instead.
 */
export function usePlaybackMsDisplay(): number {
  return useSyncExternalStore(playbackTime.subscribe, playbackTime.getMs, () => 0);
}
```

- [ ] **Step 5: Create `src/app/(dashboard)/video-editor/_lib/find-active-caption.ts`** with exactly:

```ts
import type { Caption } from "../_components/types";

/**
 * Binary search for the caption active at `captionMs` (caption-time ms).
 *
 * Replaces the old per-frame O(n) scan in the rAF loop:
 *   captions.findIndex(c => captionMs >= c.startMs && captionMs < c.endMs)
 * which ran 60×/sec × N captions during playback.
 *
 * Requires captions sorted by startMs and non-overlapping — guaranteed by
 * normalizeCaptionsForTimeline (sorts + clamps each end to the next start)
 * and by the timeline drag handlers (clamp between neighbours).
 * Returns the index with startMs <= captionMs < endMs, or -1 (gaps, before
 * first, after last) — identical results to the old findIndex.
 */
export function findActiveCaptionIdx(captions: readonly Caption[], captionMs: number): number {
  let lo = 0;
  let hi = captions.length - 1;
  let best = -1; // last caption whose startMs <= captionMs
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (captions[mid].startMs <= captionMs) { best = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  if (best === -1) return -1;
  return captionMs < captions[best].endMs ? best : -1;
}
```

- [ ] **Step 6: Run the verify script again — expect PASS**

```bash
npx tsx scripts/verify-editor-playback.ts
```
Expected: lines of `✓ ...` and final line `All 16 checks passed ✅`, exit code 0. (15 asserts + the randomized-equivalence check = 16.)

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/video-editor/_lib/playback-time.ts" "src/app/(dashboard)/video-editor/_lib/find-active-caption.ts" scripts/verify-editor-playback.ts
git commit -m "$(cat <<'EOF'
perf(editor): add playbackTime store + binary-search caption lookup

External 60fps time store (plain emitter + useSyncExternalStore hook) and an
O(log n) active-caption lookup, verified by scripts/verify-editor-playback.ts.
No callers yet — wired up in the next commits.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.2: 60fps leaf components (TimeLabel, PlayheadIndicator, ActiveCaptionOverlay)

These three files are created now but not used until Task 3.3, so this commit is inert and safe. PlayheadIndicator and TimeLabel subscribe to the store and write DOM directly via refs (zero React re-renders per frame); ActiveCaptionOverlay must re-render React content (frame-driven subtitle effects), so it uses `usePlaybackMsDisplay` — it is the one small subtree that commits per frame.

**Files:**
- Create: `src/app/(dashboard)/video-editor/_components/TimeLabel.tsx`
- Create: `src/app/(dashboard)/video-editor/_components/PlayheadIndicator.tsx`
- Create: `src/app/(dashboard)/video-editor/_components/ActiveCaptionOverlay.tsx`

- [ ] **Step 1: Create `src/app/(dashboard)/video-editor/_components/TimeLabel.tsx`** with exactly:

```tsx
"use client";

import { memo, useEffect, useRef } from "react";
import { playbackTime } from "../_lib/playback-time";

interface TimeLabelProps {
  className: string;
  // When BOTH are > 0, display caption-time (videoMs × captionEndMs/durationMs)
  // — same formula as page.tsx videoMsToCaptionMs. Omit both for raw video-time.
  durationMs?: number;
  captionEndMs?: number;
}

// Same formatter as page.tsx fmtMs (duplicated here because page.tsx declares
// it inside the component body and still uses it for static labels).
function fmtMs(ms: number) {
  const s = Math.floor(ms / 1000); const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Playback time label. Subscribes to the playbackTime store and writes
 * textContent directly via a ref — ZERO React re-renders during playback.
 */
export const TimeLabel = memo(function TimeLabel({ className, durationMs = 0, captionEndMs = 0 }: TimeLabelProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let lastText = "";
    const apply = () => {
      const el = ref.current;
      if (!el) return;
      const videoMs = playbackTime.getMs();
      const displayMs = durationMs > 0 && captionEndMs > 0 ? videoMs * (captionEndMs / durationMs) : videoMs;
      const text = fmtMs(displayMs);
      if (text !== lastText) { lastText = text; el.textContent = text; }
    };
    apply();
    return playbackTime.subscribe(apply);
  }, [durationMs, captionEndMs]);

  return <span ref={ref} className={className}>0:00</span>;
});
```

- [ ] **Step 2: Create `src/app/(dashboard)/video-editor/_components/PlayheadIndicator.tsx`** with exactly:

```tsx
"use client";

import { memo, useEffect, useRef } from "react";
import { playbackTime } from "../_lib/playback-time";

// Video-time → caption-time mapping — same formula as page.tsx
// videoMsToCaptionMs. The timeline runs in caption-time; the <video> element
// (burned output, avatar bookends) can be slightly longer.
function toCaptionMs(videoMs: number, durationMs: number, captionEndMs: number): number {
  return durationMs > 0 && captionEndMs > 0 ? videoMs * (captionEndMs / durationMs) : videoMs;
}

interface PlayheadProps {
  totalMs: number;
  durationMs: number;
  captionEndMs: number;
}

/**
 * Timeline playhead. Subscribes to the playbackTime store and writes
 * style.left directly via a ref — ZERO React re-renders during playback.
 */
export const PlayheadIndicator = memo(function PlayheadIndicator({ totalMs, durationMs, captionEndMs }: PlayheadProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const apply = () => {
      const el = ref.current;
      if (!el) return;
      const playheadMs = toCaptionMs(playbackTime.getMs(), durationMs, captionEndMs);
      el.style.left = totalMs > 0 ? `${(playheadMs / totalMs) * 100}%` : "0%";
    };
    apply();
    return playbackTime.subscribe(apply);
  }, [totalMs, durationMs, captionEndMs]);

  return (
    <div ref={ref} className="absolute top-0 bottom-0 w-[1.5px] bg-violet-500 pointer-events-none z-10"
      style={{ left: "0%" }}>
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-violet-500 shadow-[0_0_6px_rgba(124,58,237,0.8)]" />
    </div>
  );
});

/**
 * Thin progress strip under the phone-frame video. Same store + ref pattern,
 * but writes style.width. (Fourth 60fps visual found in the audit — without
 * this it would freeze between coarse state updates.)
 */
export const PlaybackProgressStrip = memo(function PlaybackProgressStrip({ totalMs, durationMs, captionEndMs }: PlayheadProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const apply = () => {
      const el = ref.current;
      if (!el) return;
      const playheadMs = toCaptionMs(playbackTime.getMs(), durationMs, captionEndMs);
      el.style.width = totalMs > 0 ? `${(playheadMs / totalMs) * 100}%` : "0%";
    };
    apply();
    return playbackTime.subscribe(apply);
  }, [totalMs, durationMs, captionEndMs]);

  return <div ref={ref} className="h-full bg-violet-500 transition-none" style={{ width: "0%" }} />;
});
```

- [ ] **Step 3: Create `src/app/(dashboard)/video-editor/_components/ActiveCaptionOverlay.tsx`** with exactly (markup and animation math copied 1:1 from page.tsx lines 3357–3433 — preview must keep matching the burned MP4):

```tsx
"use client";

import React, { memo } from "react";
import { renderSubEl } from "./subtitle-renderer";
import type { Caption, SubPreset, SubTextEffect } from "./types";
import { usePlaybackMsDisplay } from "../_lib/playback-time";

export interface ActiveCaptionOverlayProps {
  cap: Caption | null;
  playing: boolean;
  subPosition: number;
  subDragRef: React.RefObject<{ startY: number; startPos: number } | null>;
  onSubPointerDown: (e: React.PointerEvent) => void;
  onSubPointerMove: (e: React.PointerEvent) => void;
  onSubPointerUp: () => void;
  onOpenStyleTab: () => void;
  onOpenFontTab: () => void;
  onResetPosition: () => void;
  // video-time → caption-time mapping (same formula as page.tsx videoMsToCaptionMs)
  durationMs: number;
  captionEndMs: number;
  subColor: string;
  subAccentColor: string;
  subPreset: SubPreset;
  subEffect: SubTextEffect;
  subFontFamily: string;
  subFontSize: number;
  subFontWeight: number;
  previewScale: number;
}

/**
 * Live subtitle overlay on the phone frame — the ONLY component that
 * re-renders 60×/sec during playback (usePlaybackMsDisplay). It is a leaf:
 * each commit is just this small subtree, not the 4,000-line page.
 *
 * Markup + animation math copied 1:1 from page.tsx. The entrance approximation
 * must keep MATCHING AnimatedSubtitle (ShortVideoComposition) so preview ===
 * burned MP4 — do not "improve" the easing here.
 */
export const ActiveCaptionOverlay = memo(function ActiveCaptionOverlay({
  cap, playing, subPosition, subDragRef,
  onSubPointerDown, onSubPointerMove, onSubPointerUp,
  onOpenStyleTab, onOpenFontTab, onResetPosition,
  durationMs, captionEndMs,
  subColor, subAccentColor, subPreset, subEffect,
  subFontFamily, subFontSize, subFontWeight, previewScale,
}: ActiveCaptionOverlayProps) {
  const videoMs = usePlaybackMsDisplay();

  if (!cap) return null;
  const isDragging = !!subDragRef.current;

  const playheadMs = durationMs > 0 && captionEndMs > 0 ? videoMs * (captionEndMs / durationMs) : videoMs;

  const PREVIEW_FPS = 30;
  const capDurMs = Math.max(1, cap.endMs - cap.startMs);
  const capDurFrames = Math.max(1, Math.round((capDurMs / 1000) * PREVIEW_FPS));
  const elapsedMs = Math.max(0, Math.min(capDurMs, playheadMs - cap.startMs));
  // frame for the INNER text effects (glow-pulse/highlight/karaoke/
  // typewriter). -1 when paused = resting/fully-visible.
  const frame = playing ? Math.round((elapsedMs / 1000) * PREVIEW_FPS) : -1;

  // Container ENTRANCE animation — must MATCH AnimatedSubtitle
  // (ShortVideoComposition) so preview === burned MP4. We can't
  // call Remotion spring() here, so approximate it: same start/end
  // values and similar durations, with an ease that mimics the
  // spring's settle. Only animates while playing; when paused we
  // show the resting state (transform none, opacity 1).
  const f = playing ? Math.max(0, Math.round((elapsedMs / 1000) * PREVIEW_FPS)) : 9999;
  const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
  const easeBack = (t: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  const prog = (dur: number) => Math.min(1, f / dur);
  const fadeIn = Math.min(1, f / 5);
  let tf = "", op = 1;
  if (subEffect === "pop")        { const t = easeOut(prog(12)); tf = `translateY(${6*(1-t)}px) scale(${0.76+0.24*t})`; }
  else if (subEffect === "bounce"){ const t = easeBack(prog(18)); tf = `translateY(${14*(1-Math.min(1,t))}px) scale(${0.5+0.5*t})`; }
  else if (subEffect === "quick") { const t = easeOut(prog(6));  tf = `translateY(${8*(1-t)}px) scale(${0.6+0.4*t})`; }
  else if (subEffect === "fade")  { op = Math.min(1, f/8); }
  else if (subEffect === "slide") { const t = easeOut(prog(16)); tf = `translateY(${40*(1-t)}px)`; op = fadeIn; }
  else if (subEffect === "flip")  { const t = easeOut(prog(14)); tf = `perspective(600px) rotateX(${90*(1-t)}deg)`; op = Math.min(1, f/6); }

  return (
    <div
      className="absolute z-20 group"
      style={{
        top: `${subPosition}%`,
        left: "4%",
        right: "4%",
        transform: "translateY(-50%)",
        cursor: isDragging ? "grabbing" : "grab",
      }}
      onPointerDown={onSubPointerDown}
      onPointerMove={onSubPointerMove}
      onPointerUp={onSubPointerUp}
      onPointerCancel={onSubPointerUp}
    >
      {/* Hover border */}
      <div className="absolute -inset-x-2 -inset-y-1 rounded pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ border: "1px dashed rgba(124,58,237,0.55)" }} />

      {/* Quick actions — float ABOVE the subtitle text */}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 pointer-events-auto whitespace-nowrap">
        <span className="text-[9px] text-violet-400 bg-black/70 rounded px-1.5 py-0.5">↕{subPosition}%</span>
        <button onClick={e => { e.stopPropagation(); onOpenStyleTab(); }}
          className="px-1.5 py-0.5 bg-violet-600 rounded text-[9px] text-white font-bold hover:bg-violet-500">Style</button>
        <button onClick={e => { e.stopPropagation(); onOpenFontTab(); }}
          className="px-1.5 py-0.5 bg-[#1e1e28] border border-[#3a3a4a] rounded text-[9px] text-slate-300 hover:bg-[#2a2a36]">Font</button>
        <button onClick={e => { e.stopPropagation(); onResetPosition(); }}
          className="px-1.5 py-0.5 bg-[#1e1e28] border border-[#3a3a4a] rounded text-[9px] text-slate-400 hover:bg-[#2a2a36]">↺</button>
      </div>

      {/* Subtitle text — matches Remotion render exactly.
          data-subtitle-text lets the :fullscreen CSS upscale the font
          when the phone-frame is fullscreened, so the subtitle stays
          legible at viewport-width sizes. */}
      <div data-subtitle-text style={{ width: "100%", textAlign: "center" }} onClick={e => { e.stopPropagation(); onOpenFontTab(); }}>
        <div style={{ transform: tf || undefined, opacity: op, transformOrigin: subEffect === "flip" ? "center top" : "center" }}>
          {renderSubEl(cap.text, subColor, subAccentColor, cap.tag === "hook", subPreset, subFontFamily, subFontSize, subFontWeight, previewScale, subEffect, frame, capDurFrames)}
        </div>
      </div>
    </div>
  );
});
```

- [ ] **Step 4: Scoped type check**

```bash
npx tsc --noEmit 2>&1 | grep -E "(video-editor|renderSubtitle)" || echo "OK: no type errors in touched files"
```
Expected output: `OK: no type errors in touched files` (verified: this command prints exactly that on the current tree, so any output line = an error you introduced).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/video-editor/_components/TimeLabel.tsx" "src/app/(dashboard)/video-editor/_components/PlayheadIndicator.tsx" "src/app/(dashboard)/video-editor/_components/ActiveCaptionOverlay.tsx"
git commit -m "$(cat <<'EOF'
perf(editor): add 60fps leaf components for playhead, time labels, subtitle overlay

TimeLabel + PlayheadIndicator/PlaybackProgressStrip write DOM via refs (zero
re-renders); ActiveCaptionOverlay re-renders per frame but is a tiny leaf.
Markup/animation math copied 1:1 from page.tsx. Not wired up yet.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.3: Rewire page.tsx + ScrubberBar — kill the 60fps setState and the duplicate `onTimeUpdate`

This is the core change. Intermediate steps leave the working tree transiently inconsistent — that is fine; only the final commit must be coherent. Apply the steps in order.

**Files:**
- Modify: `src/app/(dashboard)/video-editor/page.tsx`
- Modify: `src/app/(dashboard)/video-editor/_components/ScrubberBar.tsx`
- Test: scoped tsc (step 13) + manual smoke test (step 14)

- [ ] **Step 1: Add imports to page.tsx.** Current code (lines 33–35):

```tsx
import { RightSettingsPanel } from "./_components/RightSettingsPanel";
import { ScrubberBar } from "./_components/ScrubberBar";
import { trackEvent } from "@/lib/client-telemetry";
```

Replace with:

```tsx
import { RightSettingsPanel } from "./_components/RightSettingsPanel";
import { ScrubberBar } from "./_components/ScrubberBar";
import { TimeLabel } from "./_components/TimeLabel";
import { PlayheadIndicator, PlaybackProgressStrip } from "./_components/PlayheadIndicator";
import { ActiveCaptionOverlay } from "./_components/ActiveCaptionOverlay";
import { playbackTime } from "./_lib/playback-time";
import { findActiveCaptionIdx } from "./_lib/find-active-caption";
import { trackEvent } from "@/lib/client-telemetry";
```

- [ ] **Step 2: Rewrite the rAF effect.** Current code (page.tsx lines 515–565):

```tsx
  // ── Video sync — rAF loop for smooth subtitle tracking ────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let rafId = 0;
    let lastIdx = -1;

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const ms = v.currentTime * 1000;
      const captionMs = videoMsToCaptionMs(ms);
      setCurrentMs(ms);
      const idx = captionsRef.current.findIndex(c => captionMs >= c.startMs && captionMs < c.endMs);
      if (idx !== lastIdx) {
        lastIdx = idx;
        setActiveCaptionIdx(idx);
        if (idx >= 0) setActiveSegIdx(idx);
      }
    };

    const onPlay    = () => { setPlaying(true);  rafId = requestAnimationFrame(tick); };
    const onPause   = () => { setPlaying(false); cancelAnimationFrame(rafId); };
    const onEnded   = () => { setPlaying(false); cancelAnimationFrame(rafId); };
    const onMeta    = () => setDurationMs(v.duration * 1000);
    // single timeupdate for when video is paused/seeking
    const onTime    = () => {
      const ms = v.currentTime * 1000;
      const captionMs = videoMsToCaptionMs(ms);
      setCurrentMs(ms);
      const idx = captionsRef.current.findIndex(c => captionMs >= c.startMs && captionMs < c.endMs);
      setActiveCaptionIdx(idx);
      if (idx >= 0) setActiveSegIdx(idx);
    };

    v.addEventListener("play",        onPlay);
    v.addEventListener("pause",       onPause);
    v.addEventListener("ended",       onEnded);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("seeked",      onTime);

    if (!v.paused) { rafId = requestAnimationFrame(tick); }

    return () => {
      cancelAnimationFrame(rafId);
      v.removeEventListener("play",        onPlay);
      v.removeEventListener("pause",       onPause);
      v.removeEventListener("ended",       onEnded);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("seeked",      onTime);
    };
  }, [captions, videoUrl, preRenderUrl, videoMsToCaptionMs]);  // re-run when video src changes so listeners attach to new element
```

Replace with:

```tsx
  // ── Video sync — rAF loop drives the external playbackTime store ──────
  // Per frame: ONLY playbackTime.setMs() (leaf components subscribe to it)
  // and a binary-search caption lookup. setCurrentMs (React state at the page
  // root — re-renders the whole 4,000-line tree) now fires only on
  // play/pause/seek/end; setActiveCaptionIdx only when the caption changes.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let rafId = 0;
    let lastIdx = -1;

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const ms = v.currentTime * 1000;
      const captionMs = videoMsToCaptionMs(ms);
      playbackTime.setMs(ms);
      const idx = findActiveCaptionIdx(captionsRef.current, captionMs);
      if (idx !== lastIdx) {
        lastIdx = idx;
        setActiveCaptionIdx(idx);
        if (idx >= 0) setActiveSegIdx(idx);
      }
    };

    // Coarse sync into React state — play/pause/seek/end only. Keeps existing
    // non-60fps logic working unchanged.
    const syncCoarse = () => {
      const ms = v.currentTime * 1000;
      const captionMs = videoMsToCaptionMs(ms);
      playbackTime.setMs(ms);
      setCurrentMs(ms);
      const idx = findActiveCaptionIdx(captionsRef.current, captionMs);
      lastIdx = idx;
      setActiveCaptionIdx(idx);
      if (idx >= 0) setActiveSegIdx(idx);
    };

    const onPlay    = () => { setPlaying(true);  syncCoarse(); rafId = requestAnimationFrame(tick); };
    const onPause   = () => { setPlaying(false); cancelAnimationFrame(rafId); syncCoarse(); };
    const onEnded   = () => { setPlaying(false); cancelAnimationFrame(rafId); syncCoarse(); };
    const onMeta    = () => setDurationMs(v.duration * 1000);

    v.addEventListener("play",        onPlay);
    v.addEventListener("pause",       onPause);
    v.addEventListener("ended",       onEnded);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("seeked",      syncCoarse);

    if (!v.paused) { rafId = requestAnimationFrame(tick); }

    return () => {
      cancelAnimationFrame(rafId);
      v.removeEventListener("play",        onPlay);
      v.removeEventListener("pause",       onPause);
      v.removeEventListener("ended",       onEnded);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("seeked",      syncCoarse);
    };
  }, [captions, videoUrl, preRenderUrl, videoMsToCaptionMs]);  // re-run when video src changes so listeners attach to new element
```

- [ ] **Step 3: Annotate the coarse state + reset the store in resetEditorState.** Current code (page.tsx line 178):

```tsx
  const [currentMs, setCurrentMs] = useState(0);
```

Replace with:

```tsx
  // Coarse playback position — updated on play/pause/seek/end ONLY (design
  // spec §5 PR-3). The 60fps position lives in the playbackTime store
  // (_lib/playback-time.ts); leaf components subscribe there. Event handlers
  // that need the live position read playbackTime.getMs().
  const [currentMs, setCurrentMs] = useState(0);
  void currentMs; // write-mostly by design — kept so coarse logic can use state later
```

Then, current code (page.tsx lines 602–605, inside `resetEditorState`):

```tsx
    // Playback
    setPlaying(false);
    setCurrentMs(0);
    setDurationMs(0);
```

Replace with:

```tsx
    // Playback
    setPlaying(false);
    setCurrentMs(0);
    playbackTime.setMs(0);
    setDurationMs(0);
```

- [ ] **Step 4: Delete ONLY the duplicate inline `onTimeUpdate` handler** — it is the second per-playback `setCurrentMs` source. **Keep `onLoadedMetadata`/`onPlay`/`onPause`/`onEnded`**: they fire on discrete events (zero per-frame cost) and are idempotent duplicates of the effect's listeners — exactly the status quo. `onLoadedMetadata` is load-bearing: when the `<video>` first mounts because a `pipe.current.*` URL changed (a ref — NOT in the rAF effect's deps `[captions, videoUrl, preRenderUrl, videoMsToCaptionMs]`), the effect has not yet attached to the new element; the inline `onLoadedMetadata` → `setDurationMs` → new `videoMsToCaptionMs` identity → effect re-runs and attaches its listeners + rAF. Removing it would leave `durationMs` at 0 and the rAF loop dead on that path. Current code (page.tsx lines 3326–3343):

```tsx
                {previewVideoUrl ? (
                  <video
                    ref={videoRef}
                    src={previewVideoUrl}
                    className="w-full h-full object-cover"
                    loop playsInline
                    onClick={playToggle}
                    style={{ cursor: "pointer" }}
                    onLoadedMetadata={e => setDurationMs((e.target as HTMLVideoElement).duration * 1000)}
                    onTimeUpdate={e => {
                      const ms = (e.target as HTMLVideoElement).currentTime * 1000;
                      setCurrentMs(ms);
                    }}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => setPlaying(false)}
                  />
                ) : (
```

Replace with (only `onTimeUpdate` removed; `onLoadedMetadata` keeps the effect's re-attach bootstrap alive — see above):

```tsx
                {previewVideoUrl ? (
                  <video
                    ref={videoRef}
                    src={previewVideoUrl}
                    className="w-full h-full object-cover"
                    loop playsInline
                    onClick={playToggle}
                    style={{ cursor: "pointer" }}
                    onLoadedMetadata={e => setDurationMs((e.target as HTMLVideoElement).duration * 1000)}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => setPlaying(false)}
                  />
                ) : (
```

- [ ] **Step 5: Swap the under-video progress strip to the leaf.** Current code (page.tsx lines 3351–3353):

```tsx
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-black/40">
                  <div className="h-full bg-violet-500 transition-none" style={{ width: totalMs > 0 ? `${(playheadMs / totalMs) * 100}%` : "0%" }} />
                </div>
```

Replace with:

```tsx
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-black/40">
                  <PlaybackProgressStrip totalMs={totalMs} durationMs={durationMs} captionEndMs={captionEndMs} />
                </div>
```

- [ ] **Step 6: Swap the live subtitle overlay to the leaf.** Current code (page.tsx lines 3356–3433 — the entire IIFE block):

```tsx
              {/* Subtitle overlay — draggable, clickable */}
              {!previewUsesBurnedOutput && (() => {
                // Show active caption when playing, or first caption when paused/before play
                const cap = activeSub ?? (!playing && displayCaptions.length > 0 ? displayCaptions[0] : null);
                if (!cap) return null;
                const isDragging = !!subDragRef.current;
                return (
                  <div
                    className="absolute z-20 group"
                    style={{
                      top: `${subPosition}%`,
                      left: "4%",
                      right: "4%",
                      transform: "translateY(-50%)",
                      cursor: isDragging ? "grabbing" : "grab",
                    }}
                    onPointerDown={onSubPointerDown}
                    onPointerMove={onSubPointerMove}
                    onPointerUp={onSubPointerUp}
                    onPointerCancel={onSubPointerUp}
                  >
                    {/* Hover border */}
                    <div className="absolute -inset-x-2 -inset-y-1 rounded pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
                      style={{ border: "1px dashed rgba(124,58,237,0.55)" }} />

                    {/* Quick actions — float ABOVE the subtitle text */}
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 pointer-events-auto whitespace-nowrap">
                      <span className="text-[9px] text-violet-400 bg-black/70 rounded px-1.5 py-0.5">↕{subPosition}%</span>
                      <button onClick={e => { e.stopPropagation(); setActiveRightTab("style"); }}
                        className="px-1.5 py-0.5 bg-violet-600 rounded text-[9px] text-white font-bold hover:bg-violet-500">Style</button>
                      <button onClick={e => { e.stopPropagation(); setActiveRightTab("font"); }}
                        className="px-1.5 py-0.5 bg-[#1e1e28] border border-[#3a3a4a] rounded text-[9px] text-slate-300 hover:bg-[#2a2a36]">Font</button>
                      <button onClick={e => { e.stopPropagation(); setSubPosition(82); }}
                        className="px-1.5 py-0.5 bg-[#1e1e28] border border-[#3a3a4a] rounded text-[9px] text-slate-400 hover:bg-[#2a2a36]">↺</button>
                    </div>

                    {/* Subtitle text — matches Remotion render exactly.
                        data-subtitle-text lets the :fullscreen CSS upscale the font
                        when the phone-frame is fullscreened, so the subtitle stays
                        legible at viewport-width sizes. */}
                    <div data-subtitle-text style={{ width: "100%", textAlign: "center" }} onClick={e => { e.stopPropagation(); setActiveRightTab("font"); }}>
                      {(() => {
                        const PREVIEW_FPS = 30;
                        const capDurMs = Math.max(1, cap.endMs - cap.startMs);
                        const capDurFrames = Math.max(1, Math.round((capDurMs / 1000) * PREVIEW_FPS));
                        const elapsedMs = Math.max(0, Math.min(capDurMs, playheadMs - cap.startMs));
                        // frame for the INNER text effects (glow-pulse/highlight/karaoke/
                        // typewriter). -1 when paused = resting/fully-visible.
                        const frame = playing ? Math.round((elapsedMs / 1000) * PREVIEW_FPS) : -1;

                        // Container ENTRANCE animation — must MATCH AnimatedSubtitle
                        // (ShortVideoComposition) so preview === burned MP4. We can't
                        // call Remotion spring() here, so approximate it: same start/end
                        // values and similar durations, with an ease that mimics the
                        // spring's settle. Only animates while playing; when paused we
                        // show the resting state (transform none, opacity 1).
                        const f = playing ? Math.max(0, Math.round((elapsedMs / 1000) * PREVIEW_FPS)) : 9999;
                        const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
                        const easeBack = (t: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
                        const prog = (dur: number) => Math.min(1, f / dur);
                        const fadeIn = Math.min(1, f / 5);
                        let tf = "", op = 1;
                        if (subEffect === "pop")        { const t = easeOut(prog(12)); tf = `translateY(${6*(1-t)}px) scale(${0.76+0.24*t})`; }
                        else if (subEffect === "bounce"){ const t = easeBack(prog(18)); tf = `translateY(${14*(1-Math.min(1,t))}px) scale(${0.5+0.5*t})`; }
                        else if (subEffect === "quick") { const t = easeOut(prog(6));  tf = `translateY(${8*(1-t)}px) scale(${0.6+0.4*t})`; }
                        else if (subEffect === "fade")  { op = Math.min(1, f/8); }
                        else if (subEffect === "slide") { const t = easeOut(prog(16)); tf = `translateY(${40*(1-t)}px)`; op = fadeIn; }
                        else if (subEffect === "flip")  { const t = easeOut(prog(14)); tf = `perspective(600px) rotateX(${90*(1-t)}deg)`; op = Math.min(1, f/6); }
                        return (
                          <div style={{ transform: tf || undefined, opacity: op, transformOrigin: subEffect === "flip" ? "center top" : "center" }}>
                            {renderSubEl(cap.text, subColor, subAccentColor, cap.tag === "hook", subPreset, subFontFamily, subFontSize, subFontWeight, previewScale, subEffect, frame, capDurFrames)}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              })()}
```

Replace with:

```tsx
              {/* Subtitle overlay — draggable, clickable. Leaf component: the only
                  60fps React subtree (subscribes to playbackTime internally). */}
              {!previewUsesBurnedOutput && (
                <ActiveCaptionOverlay
                  cap={activeSub ?? (!playing && displayCaptions.length > 0 ? displayCaptions[0] : null)}
                  playing={playing}
                  subPosition={subPosition}
                  subDragRef={subDragRef}
                  onSubPointerDown={onSubPointerDown}
                  onSubPointerMove={onSubPointerMove}
                  onSubPointerUp={onSubPointerUp}
                  onOpenStyleTab={() => setActiveRightTab("style")}
                  onOpenFontTab={() => setActiveRightTab("font")}
                  onResetPosition={() => setSubPosition(82)}
                  durationMs={durationMs}
                  captionEndMs={captionEndMs}
                  subColor={subColor}
                  subAccentColor={subAccentColor}
                  subPreset={subPreset}
                  subEffect={subEffect}
                  subFontFamily={subFontFamily}
                  subFontSize={subFontSize}
                  subFontWeight={subFontWeight}
                  previewScale={previewScale}
                />
              )}
```

- [ ] **Step 7: Swap the playback-bar time label and drop ScrubberBar's `currentMs` prop.** Current code (page.tsx lines 3469–3482):

```tsx
            {/* Time */}
            <span className="text-[11px] text-slate-500 tabular-nums flex-shrink-0">{fmtMs(currentMs)}</span>

            {/* Scrubber — hover shows time preview, drag to seek */}
            <ScrubberBar
              currentMs={currentMs}
              totalMs={totalMs}
              durationMs={durationMs}
              isScrubbing={isScrubbing}
              setIsScrubbing={setIsScrubbing}
              videoRef={videoRef}
              setCurrentMs={setCurrentMs}
              fmtMs={fmtMs}
            />
```

Replace with:

```tsx
            {/* Time — leaf, ticks at 60fps from the playbackTime store */}
            <TimeLabel className="text-[11px] text-slate-500 tabular-nums flex-shrink-0" />

            {/* Scrubber — hover shows time preview, drag to seek */}
            <ScrubberBar
              totalMs={totalMs}
              durationMs={durationMs}
              isScrubbing={isScrubbing}
              setIsScrubbing={setIsScrubbing}
              videoRef={videoRef}
              setCurrentMs={setCurrentMs}
              fmtMs={fmtMs}
            />
```

- [ ] **Step 8: Swap the timeline-toolbar time label** (this one displays caption-time, like the old `fmtMs(playheadMs)`). Current code (page.tsx line 3744):

```tsx
          <span className="text-violet-400 font-bold tabular-nums text-[12px]">{fmtMs(playheadMs)}</span>
```

Replace with:

```tsx
          <TimeLabel className="text-violet-400 font-bold tabular-nums text-[12px]" durationMs={durationMs} captionEndMs={captionEndMs} />
```

- [ ] **Step 9: Split button reads the LIVE position from the store** (the coarse `currentMs` state would be stale while playing — this preserves today's "split exactly at the moving playhead" behavior). Current code (page.tsx lines 3766–3769):

```tsx
            <button
              onClick={() => {
                const splitMs = playheadMs;
                if (splitMs <= 0 || activeSegIdx < 0 || activeSegIdx >= displayCaptions.length) return;
```

Replace with:

```tsx
            <button
              onClick={() => {
                // Live position from the store (currentMs state is coarse now),
                // mapped video-time → caption-time exactly like old playheadMs.
                const splitMs = videoMsToCaptionMs(playbackTime.getMs());
                if (splitMs <= 0 || activeSegIdx < 0 || activeSegIdx >= displayCaptions.length) return;
```

- [ ] **Step 10: Ruler seek handlers also feed the store** (instant playhead/label feedback mid-drag, before the async `seeked` event lands). Current code (page.tsx lines 3877–3887, the `onPointerDown` block of the ruler):

```tsx
                onPointerDown={e => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  if (!videoRef.current || !totalMs) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                  // Timeline is in caption-space; convert to video-space before seeking.
                  const captionMs = pct * totalMs;
                  const videoMs = captionMsToVideoMs(captionMs);
                  videoRef.current.currentTime = videoMs / 1000;
                  setCurrentMs(videoMs);
                }}
```

Replace with:

```tsx
                onPointerDown={e => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  if (!videoRef.current || !totalMs) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                  // Timeline is in caption-space; convert to video-space before seeking.
                  const captionMs = pct * totalMs;
                  const videoMs = captionMsToVideoMs(captionMs);
                  videoRef.current.currentTime = videoMs / 1000;
                  playbackTime.setMs(videoMs); // instant visual feedback while dragging
                  setCurrentMs(videoMs);
                }}
```

Then current code (page.tsx lines 3888–3897, the ruler `onPointerMove` block):

```tsx
                onPointerMove={e => {
                  if (e.buttons !== 1 || !videoRef.current || !totalMs) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                  // Timeline is in caption-space; convert to video-space before seeking.
                  const captionMs = pct * totalMs;
                  const videoMs = captionMsToVideoMs(captionMs);
                  videoRef.current.currentTime = videoMs / 1000;
                  setCurrentMs(videoMs);
                }}
```

Replace with:

```tsx
                onPointerMove={e => {
                  if (e.buttons !== 1 || !videoRef.current || !totalMs) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                  // Timeline is in caption-space; convert to video-space before seeking.
                  const captionMs = pct * totalMs;
                  const videoMs = captionMsToVideoMs(captionMs);
                  videoRef.current.currentTime = videoMs / 1000;
                  playbackTime.setMs(videoMs); // instant visual feedback while dragging
                  setCurrentMs(videoMs);
                }}
```

- [ ] **Step 11: Swap the timeline playhead to the leaf and delete the now-unused `playheadMs`.** Current code (page.tsx lines 3998–4003):

```tsx
              {/* Playhead — uses playheadMs (video-time mapped into caption-time) so it
                  tracks the caption clips exactly, even when the video is longer. */}
              <div className="absolute top-0 bottom-0 w-[1.5px] bg-violet-500 pointer-events-none z-10"
                style={{ left: totalMs > 0 ? `${(playheadMs / totalMs) * 100}%` : "0%" }}>
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-violet-500 shadow-[0_0_6px_rgba(124,58,237,0.8)]" />
              </div>
```

Replace with:

```tsx
              {/* Playhead — leaf, writes style.left via ref from the playbackTime
                  store (video-time mapped into caption-time, as before). */}
              <PlayheadIndicator totalMs={totalMs} durationMs={durationMs} captionEndMs={captionEndMs} />
```

Then delete the dead derivation (all five consumers — strip 3352, overlay 3401, toolbar label 3744, split 3768, playhead 4001 — were replaced in steps 5–9 and above). Current code (page.tsx lines 196–199):

```tsx
  const captionMsToVideoMs = useCallback((captionMs: number) => (
    durationMs > 0 && captionEndMs > 0 ? captionMs * (durationMs / captionEndMs) : captionMs
  ), [durationMs, captionEndMs]);
  const playheadMs = videoMsToCaptionMs(currentMs);
```

Replace with:

```tsx
  const captionMsToVideoMs = useCallback((captionMs: number) => (
    durationMs > 0 && captionEndMs > 0 ? captionMs * (durationMs / captionEndMs) : captionMs
  ), [durationMs, captionEndMs]);
```

- [ ] **Step 12: Rewrite `_components/ScrubberBar.tsx`** — it becomes a self-subscribing leaf (its `currentMs` prop forced the parent to track it). Replace the ENTIRE file content with:

```tsx
"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { playbackTime, usePlaybackMsDisplay } from "../_lib/playback-time";

interface ScrubberBarProps {
  totalMs: number;
  durationMs: number;
  isScrubbing: boolean;
  setIsScrubbing: (v: boolean) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  setCurrentMs: (v: number) => void;
  fmtMs: (ms: number) => string;
}

export function ScrubberBar({
  totalMs, durationMs, isScrubbing,
  setIsScrubbing, videoRef, setCurrentMs, fmtMs,
}: ScrubberBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  // 60fps position from the playbackTime store. This component is a small
  // leaf, so re-rendering it per frame is cheap (it used to receive currentMs
  // as a prop, which forced the whole page to re-render to move this bar).
  const currentMs = usePlaybackMsDisplay();

  const seekToClientX = (clientX: number) => {
    const track = trackRef.current;
    if (!track || !videoRef.current) return;
    const r = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const dur = videoRef.current.duration || (durationMs / 1000);
    videoRef.current.currentTime = pct * dur;
    playbackTime.setMs(pct * dur * 1000); // instant visual feedback while dragging
    setCurrentMs(pct * dur * 1000);
  };

  const updateHover = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const r = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    setHoverPct(pct);
  };

  const hoverMs = hoverPct !== null ? hoverPct * totalMs : 0;

  return (
    <div
      ref={trackRef}
      className="flex-1 relative py-3 cursor-pointer group"
      onPointerDown={e => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setIsScrubbing(true);
        seekToClientX(e.clientX);
      }}
      onPointerMove={e => {
        updateHover(e.clientX);
        if (e.buttons === 1) seekToClientX(e.clientX);
      }}
      onPointerEnter={e => updateHover(e.clientX)}
      onPointerLeave={() => setHoverPct(null)}
      onPointerUp={() => setIsScrubbing(false)}
      onPointerCancel={() => setIsScrubbing(false)}
    >
      <div
        className={cn(
          "absolute top-1/2 left-0 right-0 -translate-y-1/2 rounded overflow-hidden transition-all",
          isScrubbing ? "h-2" : "h-1 group-hover:h-1.5",
        )}
        style={{ background: "#2a2a36" }}
      >
        {/* Hover ghost — shows where you'd seek to */}
        {hoverPct !== null && !isScrubbing && (
          <div
            className="absolute top-0 left-0 h-full bg-violet-500/30 rounded pointer-events-none"
            style={{ width: `${hoverPct * 100}%` }}
          />
        )}
        {/* Played progress */}
        <div
          className="h-full bg-violet-500 rounded relative z-10"
          style={{ width: totalMs > 0 ? `${(currentMs / totalMs) * 100}%` : "0%" }}
        />
      </div>

      {/* Thumb on current position */}
      <div
        className={cn(
          "absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full bg-white border-2 border-violet-500 shadow-[0_0_6px_rgba(124,58,237,0.6)] transition-all pointer-events-none",
          isScrubbing ? "w-4 h-4 opacity-100" : "w-3 h-3 opacity-0 group-hover:opacity-100",
        )}
        style={{ left: totalMs > 0 ? `${(currentMs / totalMs) * 100}%` : "0%" }}
      />

      {/* Hover time tooltip */}
      {hoverPct !== null && totalMs > 0 && (
        <div
          className="absolute -top-1 -translate-y-full -translate-x-1/2 bg-[#0e0e13] border border-[#2a2a36] rounded px-1.5 py-0.5 text-[10px] font-mono text-slate-300 tabular-nums pointer-events-none whitespace-nowrap shadow-lg z-20"
          style={{ left: `${hoverPct * 100}%` }}
        >
          {fmtMs(hoverMs)}
        </div>
      )}
    </div>
  );
}
```

(Only three things changed vs. the old file: `currentMs` prop removed from the interface/destructure, the `usePlaybackMsDisplay()` line added, and `playbackTime.setMs(...)` added in `seekToClientX`. Everything else is byte-identical.)

- [ ] **Step 13: Scoped type check**

```bash
npx tsc --noEmit 2>&1 | grep -E "(video-editor|renderSubtitle)" || echo "OK: no type errors in touched files"
```
Expected output: `OK: no type errors in touched files`. Fix any reported error in the touched files before continuing (do NOT rely on the build — `next.config.ts` ignores type errors).

- [ ] **Step 14: Manual smoke test (dev)**

```bash
npm run dev
```
Open `http://localhost:3000/video-editor`, load a draft that has a rendered video + captions (header draft list; if none exists, paste a 3-line Thai script and click Render, wait for the editable preview). Verify:
1. Press Play (preview click, playback-bar button, timeline button, AND spacebar): video plays, subtitle overlay changes captions on time, both time labels tick, scrubber progress + thumb move, timeline playhead and the thin strip under the video move smoothly.
2. Pause: everything freezes at the right position; overlay shows resting (no entrance animation).
3. Seek via skip-back / +5s buttons, scrubber click, scrubber drag, ruler click, ruler drag: playhead/labels/overlay jump instantly and consistently, while playing and while paused.
4. Click a caption clip and a transcript row: video seeks to its start, row highlights.
5. No console errors.

- [ ] **Step 15: Commit**

```bash
git add "src/app/(dashboard)/video-editor/page.tsx" "src/app/(dashboard)/video-editor/_components/ScrubberBar.tsx"
git commit -m "$(cat <<'EOF'
perf(editor): stop 60fps setState at page root; drive playback visuals from store

rAF loop now writes playbackTime.setMs() + binary-search caption lookup per
frame; setCurrentMs fires only on play/pause/seek/end. Playhead, time labels,
progress strip, subtitle overlay and scrubber are leaves subscribed to the
store. Removes the duplicate inline <video> onTimeUpdate (old
page.tsx:3335-3338); the other inline handlers stay (discrete events;
onLoadedMetadata bootstraps the effect's re-attach on pipe-ref-driven mounts).
No behavior changes intended.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.4: Module-level `Intl.Segmenter` singleton in renderSubtitle.tsx

`segmentWords` currently constructs a new `Intl.Segmenter` (ICU word-break data load) on EVERY call — and it is called per subtitle render, which after Task 3.3 is still 60×/sec inside ActiveCaptionOverlay during karaoke/highlight playback, and per word-card in the settings panel. **Note for wao:** this file is shared with the Remotion burn pipeline — pure refactor, identical output.

**Files:**
- Modify: `src/remotion/renderSubtitle.tsx`
- Test: manual (step 2) + burn parity in Task 3.6 matrix

- [ ] **Step 1: Hoist segmentWords + cache the Segmenter.** Current code (renderSubtitle.tsx lines 35–55, inside `renderSubtitle`):

```tsx
  // Tokenize for per-word effects (highlight / karaoke).
  // Thai is written WITHOUT spaces between words, so a naive `split(/\s+/)`
  // returns the whole line as one token → the entire caption highlights at once
  // (illegible yellow-on-yellow block). Use Intl.Segmenter to split Thai into
  // real words; it also handles spaced scripts (English) correctly. Falls back
  // to whitespace splitting where Segmenter is unavailable.
  const segmentWords = (s: string): string[] => {
    const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
    if (Seg) {
      try {
        const seg = new Seg("th", { granularity: "word" });
        const out: string[] = [];
        for (const { segment, isWordLike } of seg.segment(s)) {
          // Keep word-like tokens; skip pure whitespace/punctuation separators
          if (isWordLike && segment.trim().length > 0) out.push(segment);
        }
        if (out.length > 0) return out;
      } catch { /* fall through */ }
    }
    return s.split(/\s+/).filter(w => w.length > 0);
  };
```

Delete that block from inside the function, and insert the following at module level, directly ABOVE the `export function renderSubtitle(` line (after the file's imports/doc comment):

```tsx
// ── Intl.Segmenter singleton ────────────────────────────────────────────────
// Constructing a Segmenter loads ICU word-break data and is expensive.
// segmentWords runs on EVERY subtitle render — in the editor preview that is
// 60×/sec during karaoke/highlight playback — so cache one instance per
// locale+granularity at module level instead of constructing per call.
const segmenterCache = new Map<string, Intl.Segmenter>();

function getSegmenter(locale: string, granularity: "word" | "grapheme" | "sentence"): Intl.Segmenter | null {
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (!Seg) return null;
  const key = `${locale}|${granularity}`;
  const cached = segmenterCache.get(key);
  if (cached) return cached;
  try {
    const seg = new Seg(locale, { granularity });
    segmenterCache.set(key, seg);
    return seg;
  } catch {
    return null;
  }
}

// Tokenize for per-word effects (highlight / karaoke).
// Thai is written WITHOUT spaces between words, so a naive `split(/\s+/)`
// returns the whole line as one token → the entire caption highlights at once
// (illegible yellow-on-yellow block). Use Intl.Segmenter to split Thai into
// real words; it also handles spaced scripts (English) correctly. Falls back
// to whitespace splitting where Segmenter is unavailable.
function segmentWords(s: string): string[] {
  const seg = getSegmenter("th", "word");
  if (seg) {
    const out: string[] = [];
    for (const { segment, isWordLike } of seg.segment(s)) {
      // Keep word-like tokens; skip pure whitespace/punctuation separators
      if (isWordLike && segment.trim().length > 0) out.push(segment);
    }
    if (out.length > 0) return out;
  }
  return s.split(/\s+/).filter(w => w.length > 0);
}
```

The two existing callers (`textEffect === "highlight"` at line 100 and `textEffect === "karaoke"` at line 140) keep calling `segmentWords(text)` unchanged.

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit 2>&1 | grep -E "(video-editor|renderSubtitle)" || echo "OK: no type errors in touched files"
```
Expected: `OK: no type errors in touched files`. Then in the dev editor set Text Animation = `ไฮไลท์` and play: Thai words highlight one-by-one exactly as before (NOT the whole line as one yellow block — that would mean tokenization broke). Repeat with `คาราโอเกะ`.

- [ ] **Step 3: Commit**

```bash
git add src/remotion/renderSubtitle.tsx
git commit -m "$(cat <<'EOF'
perf(subtitles): cache Intl.Segmenter at module level in renderSubtitle

Was constructed per call (per subtitle render — 60x/sec in the editor preview
during karaoke/highlight). Pure refactor, identical tokenization output.
Shared with the Remotion burn pipeline — flagged for wao review.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.5: `content-visibility` on transcript rows + preset cards, `useDeferredValue` for card styles

**Files:**
- Modify: `src/app/(dashboard)/video-editor/_components/RightSettingsPanel.tsx`
- Modify: `src/app/(dashboard)/video-editor/page.tsx`
- Test: manual (step 4)

- [ ] **Step 1: Defer the style values the 17 preset cards consume.** Current code (RightSettingsPanel.tsx line 3):

```tsx
import { useEffect, useRef } from "react";
```

Replace with:

```tsx
import { useDeferredValue, useEffect, useRef } from "react";
```

Then, current code (RightSettingsPanel.tsx lines 80–81):

```tsx
export function RightSettingsPanel(p: RightPanelProps) {
  const cols4 = p.detached || (p.panelWidth !== undefined ? p.panelWidth >= 420 : p.wide);
```

Replace with:

```tsx
export function RightSettingsPanel(p: RightPanelProps) {
  const cols4 = p.detached || (p.panelWidth !== undefined ? p.panelWidth >= 420 : p.wide);
  // Deferred copies of the style values rendered inside the 17 preset cards.
  // While dragging the color picker / switching fonts, the urgent render
  // updates the live preview strip first; the card grid catches up at
  // deferred priority instead of janking the input.
  const dSubColor = useDeferredValue(p.subColor);
  const dSubAccentColor = useDeferredValue(p.subAccentColor);
  const dSubFontFamily = useDeferredValue(p.subFontFamily);
  const dSubFontWeight = useDeferredValue(p.subFontWeight);
```

- [ ] **Step 2: content-visibility on the preset cards + use the deferred values.** Current code (RightSettingsPanel.tsx lines 144–161):

```tsx
                {PRESETS_DATA.map(pr => {
                  const isSelected = p.subPreset === pr.value;
                  return (
                    <button key={pr.value} onClick={() => p.setSubPreset(pr.value)}
                      className="flex flex-col items-center gap-1 rounded-xl py-2 px-1 transition-all"
                      style={isSelected
                        ? { background: "hsl(190 100% 50% / 0.12)", border: "1px solid hsl(190 100% 50% / 0.5)" }
                        : { background: "#1a1a22", border: "1px solid #2a2a36" }}>
                      <div className="w-full h-10 flex items-center justify-center rounded-lg overflow-hidden px-0.5 [&_span]:whitespace-nowrap! [&_span]:break-normal! [&_div]:px-2!" style={{ background: "rgba(0,0,0,0.45)" }}>
                        {/* Static preset preview — STYLE only (no motion). The
                            arbitrary selectors force every inner span to one line and
                            shrink the box-preset paddings, because renderSubtitle sets
                            whiteSpace:normal + break-all (correct for real subtitles)
                            which would otherwise wrap "ตัวอย่าง" inside the small card. */}
                        <div style={{ lineHeight: 1, transform: "scale(0.82)" }}>
                          {renderSubEl("ตัวอย่าง", p.subColor, p.subAccentColor, false, pr.value, p.subFontFamily, 15, p.subFontWeight, 1)}
                        </div>
                      </div>
```

Replace with:

```tsx
                {PRESETS_DATA.map(pr => {
                  const isSelected = p.subPreset === pr.value;
                  return (
                    <button key={pr.value} onClick={() => p.setSubPreset(pr.value)}
                      className="flex flex-col items-center gap-1 rounded-xl py-2 px-1 transition-all"
                      style={{
                        // Offscreen cards skip layout/paint entirely; the size hint
                        // keeps the scrollbar stable (≈ card height).
                        contentVisibility: "auto",
                        containIntrinsicSize: "auto 72px",
                        ...(isSelected
                          ? { background: "hsl(190 100% 50% / 0.12)", border: "1px solid hsl(190 100% 50% / 0.5)" }
                          : { background: "#1a1a22", border: "1px solid #2a2a36" }),
                      }}>
                      <div className="w-full h-10 flex items-center justify-center rounded-lg overflow-hidden px-0.5 [&_span]:whitespace-nowrap! [&_span]:break-normal! [&_div]:px-2!" style={{ background: "rgba(0,0,0,0.45)" }}>
                        {/* Static preset preview — STYLE only (no motion). The
                            arbitrary selectors force every inner span to one line and
                            shrink the box-preset paddings, because renderSubtitle sets
                            whiteSpace:normal + break-all (correct for real subtitles)
                            which would otherwise wrap "ตัวอย่าง" inside the small card. */}
                        <div style={{ lineHeight: 1, transform: "scale(0.82)" }}>
                          {renderSubEl("ตัวอย่าง", dSubColor, dSubAccentColor, false, pr.value, dSubFontFamily, 15, dSubFontWeight, 1)}
                        </div>
                      </div>
```

- [ ] **Step 3: content-visibility on the transcript caption rows.** Current code (page.tsx lines 3041–3045):

```tsx
              return (
                <div key={i}
                  ref={isActive ? activeSegCardRef : null}
                  className={cn("rounded-xl border transition-all group",
                    isActive ? "bg-violet-500/10 border-violet-500/40" : "bg-transparent border-transparent hover:bg-[#1a1a22] hover:border-[#2a2a36]")}>
```

Replace with:

```tsx
              return (
                <div key={i}
                  ref={isActive ? activeSegCardRef : null}
                  // Offscreen rows skip layout/paint; size hint ≈ row height so the
                  // panel scrollbar stays stable. scrollIntoView still works.
                  style={{ contentVisibility: "auto", containIntrinsicSize: "auto 90px" }}
                  className={cn("rounded-xl border transition-all group",
                    isActive ? "bg-violet-500/10 border-violet-500/40" : "bg-transparent border-transparent hover:bg-[#1a1a22] hover:border-[#2a2a36]")}>
```

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit 2>&1 | grep -E "(video-editor|renderSubtitle)" || echo "OK: no type errors in touched files"
```
Expected: `OK: no type errors in touched files`. Then in the dev editor:
1. Font tab → click the `+` custom-color swatch and DRAG inside the OS color picker continuously: the live preview strip at the top of the panel follows instantly; switch to the Style tab — the 17 cards show the final color (they may lag a frame or two behind while dragging — that is the deferral working). Dragging must feel smooth, no input jank.
2. Style tab: all 17 cards render correctly while scrolling the panel up/down (no blank cards stuck unrendered, no scrollbar jumping).
3. Load a draft with many captions (30+; use the split tool to multiply if needed) and scroll the transcript list — smooth, rows appear as they enter the viewport; click Play — the active row still auto-scrolls into view.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/video-editor/_components/RightSettingsPanel.tsx" "src/app/(dashboard)/video-editor/page.tsx"
git commit -m "$(cat <<'EOF'
perf(editor): content-visibility on caption rows/preset cards + deferred card styles

Offscreen transcript rows and preset cards skip layout/paint
(content-visibility:auto + contain-intrinsic-size); the 17 preset cards read
color/font values through useDeferredValue so color-picker drags stay smooth.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.6: Full verification (profiler before/after, manual matrix, low-end Android) + PR

**Files:**
- Test: manual only — no code changes in this task

- [ ] **Step 1: Record the "BEFORE" profile on main.** Install the React Developer Tools browser extension if not present. Then:

```bash
git checkout main && npm run dev
```
1. Open `http://localhost:3000/video-editor`, load a draft with a rendered video + captions.
2. DevTools → **Profiler** tab → gear icon → enable **"Record why each component rendered while profiling"**.
3. Click record ⏺, press Play in the editor, let it play **30 seconds**, stop recording.
4. Expected BEFORE observation: a near-continuous stream of commits (~60/sec, the commit bar chart is solid); selecting any commit shows the flamegraph rooted at `VideoEditorPage` re-rendering (reason: "Hook 'useState' changed" — the `setCurrentMs` per frame), with commit durations in the multiple-millisecond range. Screenshot it for the PR.

- [ ] **Step 2: Record the "AFTER" profile on the branch.**

```bash
git checkout mew/editor-playback-perf && npm run dev
```
Repeat the same 30-second recording on the same draft. Expected AFTER observation: during steady playback the commits contain ONLY `ActiveCaptionOverlay` (and `ScrubberBar`) with sub-millisecond durations; `VideoEditorPage` itself appears only at caption boundaries (`activeCaptionIdx` change, every ~1–3s) and on play/pause/seek; `PlayheadIndicator` and `TimeLabel` never commit at all (they write DOM via refs). **No whole-tree commits during playback = acceptance criterion met** (spec §5 PR-3). Screenshot it for the PR.

- [ ] **Step 3: Manual behavior matrix — every row must behave IDENTICALLY to main, just smoother.** Run on the dev server, draft with avatar-less render first, then once with an avatar-bookend render (video longer than captions — exercises the videoMs↔captionMs mapping in every leaf):

| # | Action | Expected (identical to main) |
|---|---|---|
| 1 | Play/pause ×4 entry points (video click, playback bar, timeline bar, spacebar) | toggles correctly, icons swap, overlay rests on pause |
| 2 | Seek: skip-back, +5s, scrubber click, ruler click, transcript row click, timeline clip click | all visuals jump together: both time labels, scrubber, strip, playhead, overlay |
| 3 | Scrub-DRAG on scrubber and on ruler (slow + fast) | playhead/labels/overlay follow the pointer smoothly, while playing and paused |
| 4 | Edit caption text while PLAYING (double-click row, type, Enter) | playback never stutters/stops; new text appears when that caption is active |
| 5 | Karaoke (`คาราโอเกะ`), highlight (`ไฮไลท์`), typewriter (`พิมพ์ดีด`) animations while playing | per-word/char progression sweeps smoothly across each caption |
| 6 | Switch through several of the 17 presets while playing | overlay restyles instantly, playback uninterrupted |
| 7 | Drag the subtitle overlay vertically (paused AND playing) | `↕%` badge updates, position sticks, Style/Font/↺ quick actions work |
| 8 | **Split at playhead WHILE PLAYING** (regression risk: store-read change in Task 3.3 step 9) | clip splits at the exact moving playhead position |
| 9 | Delete segment, drag clip edges/move clip on timeline while playing | identical to main; undo history (Ctrl+Z if wired) intact |
| 10 | Volume slider, mute, fullscreen, expand editor | unaffected |
| 11 | Reset/new project | playhead, labels, strip and scrubber all show 0:00 / 0% (store reset) |
| 12 | **Burn & Download once** (renderSubtitle.tsx was touched) | burned MP4 subtitles look identical to the live preview (karaoke/highlight word splits included) |

- [ ] **Step 4: Low-end Android test over the local network.**

```bash
npm run dev -- -H 0.0.0.0
ipconfig getifaddr en0   # → e.g. 192.168.1.42
```
On the low-end Android phone (same Wi-Fi): open `http://<that-ip>:3000/video-editor`, sign in, load the same draft, and run matrix rows 1, 3, 5, 7. (Clerk dev instances generally accept LAN origins; if sign-in fails, add `http://<that-ip>:3000` under Clerk Dashboard → your dev instance → Domains, then retry.) Expected: playback and scrubbing are visibly smooth (this device is where main's 60fps whole-tree render was unusable); touch-drag of the subtitle overlay and scrubber works.

- [ ] **Step 5: Final check + push**

```bash
npx tsx scripts/verify-editor-playback.ts   # All 16 checks passed ✅
npm run build                               # completes without error
git push -u origin mew/editor-playback-perf
```

- [ ] **Step 6: Open the PR**

```bash
gh pr create --title "perf(editor): fix playback lag — 60fps updates move out of React root (Phase-1 PR-3)" --body "$(cat <<'EOF'
## What
Phase-1 **PR-3** of the video-editor optimization design (docs/superpowers/specs/2026-06-10-video-editor-optimization-design.md §5). **No behavior changes intended — pure performance.**

- New external `playbackTime` store (`_lib/playback-time.ts`); the rAF loop writes it per frame instead of calling `setCurrentMs` at the root of the 4,115-line page. `currentMs` state now updates only on play/pause/seek/end.
- Active-caption lookup: per-frame `findIndex` → binary search (`_lib/find-active-caption.ts`, verified by `scripts/verify-editor-playback.ts`).
- New leaf components: `TimeLabel`, `PlayheadIndicator`/`PlaybackProgressStrip` (ref + direct DOM writes, zero re-renders), `ActiveCaptionOverlay` + `ScrubberBar` (subscribe via `useSyncExternalStore` — the only per-frame React commits, both tiny).
- Removed the duplicate inline `<video>` `onTimeUpdate` handler (old page.tsx:3335-3338) — the second per-playback `setCurrentMs` source. The inline metadata/play/pause/ended handlers stay: discrete events, and `onLoadedMetadata` bootstraps the rAF effect's re-attach when the video mounts from a pipeline-ref change.
- `Intl.Segmenter` cached at module level in `src/remotion/renderSubtitle.tsx` (was constructed per subtitle render).
- `content-visibility: auto` on transcript rows + the 17 preset cards; card styles read through `useDeferredValue`.

## Evidence
- Profiler BEFORE: whole tree (`VideoEditorPage`) committed ~60×/sec during playback. AFTER: only `ActiveCaptionOverlay`/`ScrubberBar` commit per frame (<1ms); page root commits only on play/pause/seek/caption change. Screenshots attached.
- Full manual matrix passed (play/pause/seek/scrub-drag/edit-while-playing/karaoke/preset-switch/split-while-playing/burn parity), including avatar-bookend draft (video longer than captions) and a low-end Android over LAN.
- `npx tsx scripts/verify-editor-playback.ts` → All 16 checks passed.

## Notes for wao
- Touches `src/remotion/renderSubtitle.tsx` (shared with the burn pipeline): pure refactor — Segmenter instance cached, tokenization output identical; one Burn & Download parity check done.
- No shared config files touched (no schema / package.json / next.config.ts changes).
- Per the design spec deploy order, this PR deploys **LAST** of Phase 1 (after PR-4 → PR-1 → PR-2 → PR-5).

## Rollback
Single `git revert` of the merge commit — no schema, no env, no API changes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: a PR URL printed. Do not merge until wao reviews (working convention) and the Phase-1 PRs ahead of it in the deploy order have shipped.
