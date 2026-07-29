const { join } = require("node:path");
const dotenv = require("dotenv");

// PM2 evaluates this file in the deploy shell, which does not automatically load
// the application's .env. Load it before resolving process-backed secrets; otherwise
// --update-env can replace a valid saved secret with an empty fallback.
dotenv.config({ path: join(__dirname, ".env"), quiet: true });

// R2 credentials and rollout switches live in a separate root-only file so they
// do not need to be duplicated into the application's general .env. Keep the
// allowlist narrow: PM2 should expose only media-storage configuration to the
// web process, while the reconciliation timer continues to read the same file.
const r2MediaConfig = dotenv.config({
  path: join(__dirname, ".env.r2.production"),
  quiet: true,
}).parsed ?? {};
const r2MediaRuntimeEnv = Object.fromEntries([
  "R2_ACCOUNT_ID",
  "R2_BUCKET",
  "R2_ENDPOINT",
  "R2_READ_ACCESS_KEY_ID",
  "R2_READ_SECRET_ACCESS_KEY",
  "R2_WRITE_ACCESS_KEY_ID",
  "R2_WRITE_SECRET_ACCESS_KEY",
  "R2_MAX_ATTEMPTS",
  "R2_REQUEST_TIMEOUT_MS",
  "R2_MATERIALIZE_ROOT",
  "MEDIA_WRITE_MODE",
  "MEDIA_READ_MODE",
  "MEDIA_LOCAL_EVICTION",
  "MEDIA_R2_DELETE",
].flatMap((key) => typeof r2MediaConfig[key] === "string"
  ? [[key, r2MediaConfig[key]]]
  : []));

// Reviewed KVM8 runtime profile. Keep render-output settings in ONE object so web
// fallback rendering, --env production, and the durable render workers cannot drift.
// These are the effective production values verified on 2026-07-19; Batch A only
// makes them deterministic and does not tune speed or visual quality.
const renderRuntimeEnv = Object.freeze({
  RENDER_CONCURRENCY: "3",
  RENDER_LOW_RESOURCE: "0",
  RENDER_OFFTHREAD_CACHE_MB: "128",
  RENDER_JPEG_QUALITY: "90",
});

// Stock normalization runs in the ai-content fetch-stock route, not render-worker.
// Explicit defaults prevent a stale .env or caller shell from silently changing it.
const stockRuntimeEnv = Object.freeze({
  STOCK_NORMALIZE_CONCURRENCY: "1",
  STOCK_NORMALIZE_PRESET: "ultrafast",
});

module.exports = {
  apps: [
  {
      name: "ai-content",
      cwd: "/var/www/ai-content",
      script: "node_modules/.bin/next",
      args: "start",
      // Web heap. With RENDER_VIA_QUEUE=1 (below) render runs in the separate
      // render-worker app — NOT in this process — so ai-content no longer needs a
      // huge heap; 3GB is plenty for serving + light orchestration (observed ~0.5GB).
      // The worker carries the render heap (4GB). 3GB web + 4–5GB worker leaves
      // headroom under the 15GB box. ⚠️ If you ever set RENDER_VIA_QUEUE=0 (legacy),
      // RESTORE this to 12288 + max_memory_restart 13G — legacy renders in-process.
      // node_args alone doesn't reach the real node (the `next` wrapper spawns its
      // own node); NODE_OPTIONS in env is the reliable heap setter.
      node_args: "--max-old-space-size=3072",
      max_memory_restart: "4G",
      // Crash-loop guard (P1.6/STAB-LOW): if the process dies <20s after boot 10 times
      // in a row, PM2 stops retrying and leaves it `errored` — a DELIBERATE, detectable
      // stop (shows in `pm2 status` + the ops watchdog) rather than PM2's silent default
      // that quietly gives up after ~15 fast restarts. Prevents an invisible boot loop
      // (bad .env / missing .next / migration mismatch) from thrashing the box unnoticed.
      max_restarts: 10,
      min_uptime: "20s",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        NEXT_DISABLE_ESLINT: "1",
        // 3GB web heap — render runs in the render-worker (RENDER_VIA_QUEUE=1), not
        // here. Restore to 12288 if you ever revert to legacy in-process render.
        NODE_OPTIONS: "--max-old-space-size=3072",
        // Render tuning. Offthread cache lowered 512→128MB: a large per-job cache
        // inflates heap usage during long renders, which contributed to the OOM.
        ...renderRuntimeEnv,
        ...stockRuntimeEnv,
        ...r2MediaRuntimeEnv,
        // PR-7 durable render queue: "1" = the thin render route enqueues a
        // RenderJob (returns jobId) instead of rendering in-process; the
        // render-worker app below drains it. ENABLED + validated on prod 2026-06-19
        // (first live queue render OK; web stays ~0.5GB, isolated). ecosystem env
        // SHADOWS .env — apply changes by replacing the saved environment from the
        // checked-in file: `pm2 restart ecosystem.config.js --only ai-content --update-env`.
        // A name-only restart, or omitting --update-env on production PM2, keeps stale values.
        // To revert to legacy: set "0" AND restore the 12288 heap + 13G above.
        RENDER_VIA_QUEUE: "1",
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 3000,
        // Must repeat here — PM2 with `--env production` merges env_production
        // OVER env, so NODE_OPTIONS would be lost if only set in env.
        NODE_OPTIONS: "--max-old-space-size=3072",
        // Must repeat RENDER_VIA_QUEUE here too — env_production shadows env entirely,
        // so the flag would be lost if someone starts with `pm2 ... --env production`.
        // Keep in sync with the env block (see the RENDER_VIA_QUEUE notes above).
        RENDER_VIA_QUEUE: "1",
        ...renderRuntimeEnv,
        ...stockRuntimeEnv,
        ...r2MediaRuntimeEnv,
      },
    },
    {
      name: "db-backup",
      cwd: "/var/www/ai-content",
      script: "node_modules/.bin/tsx",
      args: "scripts/backup-db.ts",
      cron_restart: "0 2 * * *", // daily 2:00 AM — SQLite snapshot BEFORE the 3:00 cleanup (STAB-3)
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        // scripts/backup-db.ts reads these from the environment / prod .env (via dotenv):
        //   BACKUP_DIR            default /var/backups/heroai
        //   BACKUP_RETENTION_DAYS default 14
        //   BACKUP_RSYNC_TARGET   optional — set in .env to enable off-box copies
        //                         (unset = local snapshot only, logged, not an error)
      },
    },
    {
      name: "cleanup-videos",
      cwd: "/var/www/ai-content",
      script: "scripts/cleanup-videos.js",
      cron_restart: "0 3 * * *", // runs every day at 3:00 AM
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        CRON_SECRET: process.env.CRON_SECRET || "",
      },
    },
    {
      name: "media-cleanup",
      cwd: "/var/www/ai-content",
      script: "node_modules/.bin/tsx",
      args: "scripts/media-cleanup.ts --olderThanDays=3 --includeStocks",
      cron_restart: "30 3 * * *", // daily 3:30 AM — apply disabled until retention/reference-graph rollout is approved
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "mine-loanwords",
      cwd: "/var/www/ai-content",
      script: "node_modules/.bin/tsx",
      args: "scripts/cron-mine-loanwords.ts",
      cron_restart: "10 4 * * *", // daily 4:10 AM — mine new Thai loanwords ICU mis-splits from prod scripts
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "renewal-reminders",
      cwd: "/var/www/ai-content",
      script: "scripts/renewal-reminders.js",
      cron_restart: "0 9 * * *", // every day at 9:00 AM — remind PromptPay/one-time users before plan expiry
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        CRON_SECRET: process.env.CRON_SECRET || "",
      },
    },
    {
      name: "founding-sweep",
      cwd: "/var/www/ai-content",
      script: "scripts/founding-sweep.js",
      cron_restart: "*/15 * * * *", // every 15 min — release abandoned Founding-100 seats (webhook-miss backstop)
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        CRON_SECRET: process.env.CRON_SECRET || "",
      },
    },
    {
      name: "reconcile-processing",
      cwd: "/var/www/ai-content",
      script: "scripts/reconcile-processing.js",
      cron_restart: "*/15 * * * *", // every 15 min — complete stale PROCESSING videos that already have output files
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        CRON_SECRET: process.env.CRON_SECRET || "",
      },
    },
    {
      name: "trial-expiry",
      cwd: "/var/www/ai-content",
      script: "scripts/trial-expiry.js",
      cron_restart: "0 8 * * *", // daily 8:00 — revert expired free trials + upgrade prompt
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        CRON_SECRET: process.env.CRON_SECRET || "",
      },
    },
    {
      name: "disk-watch",
      cwd: "/var/www/ai-content",
      script: "scripts/disk-watch.js",
      cron_restart: "0 5 * * *", // daily 5:00 — after the 3:00/3:30 cleanups; sweep /tmp orphans + alert if disk over DISK_ALERT_THRESHOLD (default 80%)
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        CRON_SECRET: process.env.CRON_SECRET || "",
      },
    },
    {
      name: "mcp-video-worker",
      cwd: "/var/www/ai-content",
      script: "node_modules/.bin/tsx",
      args: "scripts/mcp-video-worker.ts",
      autorestart: true, // long-running worker (not a cron) — claims queued VideoJobs
      watch: false,
      env: {
        NODE_ENV: "production",
        MCP_INTERNAL_BASE_URL: process.env.MCP_INTERNAL_BASE_URL || "http://127.0.0.1:3000",
        MCP_SERVICE_SECRET: process.env.MCP_SERVICE_SECRET || "",
        // CAP-1 launch-capacity knob: how many videos this single worker orchestrates at
        // once (docs/audits/2026-07-07-system-optimization-audit.md). Set to 2 after the
        // KVM8 (8 vCPU/32GB) upgrade and validated by 7 days of live prod operation
        // (2026-07-09 -> 2026-07-16: 202 done jobs, queue-wait p95 4s, no instability).
        // Clamp 1..4 lives in the script (scripts/mcp-video-worker.ts), not here.
        // ecosystem env SHADOWS .env, and a plain `pm2 restart mcp-video-worker` keeps
        // the OLD env; to apply a change here, restart against the FILE:
        // `pm2 restart ecosystem.config.js --only mcp-video-worker --update-env`.
        // Rollback = set back to "1" and restart the same way. Single worker only (NOT
        // instances:2 — boot-recovery has no per-worker heartbeat guard; see the worker script).
        MCP_WORKER_CONCURRENCY: process.env.MCP_WORKER_CONCURRENCY || "2",
      },
    },
    {
      // PR-7 durable render queue: long-lived worker that drains RenderJob rows
      // (QUEUED→DONE/FAILED) via the shared runRender core. renderMedia runs IN this
      // process (its own headless Chromium), so it carries a worker heap separate from
      // the web app and tolerates a slow graceful drain on deploy (kill_timeout 30s,
      // matching the watchdog cancel + requeueForShutdown path in the script).
      name: "render-worker",
      cwd: "/var/www/ai-content",
      script: "node_modules/.bin/tsx",
      args: "scripts/render-worker.ts",
      // Rung 2 (docs/scale-upgrade-plan.md): 2 parallel render instances on the 8-vCPU box
      // so concurrent renders don't wait behind a single serial worker. Each instance polls
      // and claims RenderJob rows independently; SQLite atomic claims already prevent
      // double-claim. Bump toward 3 (and drop RENDER_CONCURRENCY→2) only if wait still grows.
      instances: 2,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      kill_timeout: 30000, // allow graceful drain (cancel render + requeue) before SIGKILL
      max_memory_restart: "5G", // worker heap; web heap shrinks once renders move off ai-content (PR-8)
      // Crash-loop guard (P1.6/STAB-LOW): same rationale as ai-content — a worker that
      // dies <20s after boot 10× in a row is left `errored` (deliberate, detectable) rather
      // than silently abandoned by PM2's default. A boot-crashing worker (bad DATABASE_URL /
      // missing tsx dep) stops thrashing and is visible to `pm2 status` + the watchdog.
      max_restarts: 10,
      min_uptime: "20s",
      env: {
        NODE_ENV: "production",
        // Worker heap for in-process renderMedia (long videos accumulate frame buffers).
        NODE_OPTIONS: "--max-old-space-size=4096",
        // The worker reads the queue directly — flag is informational here (it does not
        // gate the worker) but keeps the render path consistent across processes.
        RENDER_VIA_QUEUE: "1",
        // tsx (unlike Next) doesn't auto-load .env; dotenv/config in the script reads it,
        // but ecosystem env SHADOWS .env so pin the prod DB path here as a backstop.
        DATABASE_URL: process.env.DATABASE_URL || "file:/var/www/ai-content/prisma/dev.db",
        // Same authoritative profile used by the web fallback. 2 instances x 3 = 6
        // frame threads <= 8 cores on KVM8; Batch B owns any future tuning experiment.
        ...renderRuntimeEnv,
      },
    },
  ],
};
