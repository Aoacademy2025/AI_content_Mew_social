module.exports = {
  apps: [
  {
      name: "ai-content",
      cwd: "/var/www/ai-content",
      script: "node_modules/.bin/next",
      args: "start",
      // Raise the Node heap so renderMedia (which runs in this process) doesn't
      // hit the default ~4GB ceiling and OOM mid-render even though the VPS has
      // ~15GB RAM. Long videos accumulate frames/buffers past 4GB → fatal heap
      // limit. 12GB leaves headroom under the 15GB box + max_memory_restart 12G.
      // node_args alone doesn't reach the real node process: `script` points at
      // the `next` shell wrapper, which spawns its own node, so PM2's node_args
      // is dropped. NODE_OPTIONS in env propagates to every node in the chain
      // (including next-server) and is the reliable way to raise the heap.
      node_args: "--max-old-space-size=12288",
      max_memory_restart: "13G",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        NEXT_DISABLE_ESLINT: "1",
        // Raise heap to 12GB so renderMedia (runs in-process) doesn't OOM at the
        // default ~4GB ceiling on long videos. VPS has ~15GB RAM.
        NODE_OPTIONS: "--max-old-space-size=12288",
        // Render tuning. Offthread cache lowered 512→128MB: a large per-job cache
        // inflates heap usage during long renders, which contributed to the OOM.
        RENDER_CONCURRENCY: "4",
        RENDER_OFFTHREAD_CACHE_MB: "128",
        RENDER_JPEG_QUALITY: "70",
        // PR-7 durable render queue: the thin render route enqueues a RenderJob
        // (returns jobId) instead of rendering in-process; the render-worker app
        // below drains it. ecosystem env SHADOWS .env, so the flag MUST live here.
        RENDER_VIA_QUEUE: "1",
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 3000,
        // Must repeat here — PM2 with `--env production` merges env_production
        // OVER env, so NODE_OPTIONS would be lost if only set in env.
        NODE_OPTIONS: "--max-old-space-size=12288",
        // Must repeat RENDER_VIA_QUEUE here too — env_production shadows env entirely,
        // so the flag would be lost if someone starts with `pm2 ... --env production`.
        RENDER_VIA_QUEUE: "1",
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
      args: "scripts/media-cleanup.ts --olderThanDays=3 --includeStocks --apply",
      cron_restart: "30 3 * * *", // daily 3:30 AM — reference-aware orphan media cleanup
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
      autorestart: true,
      watch: false,
      kill_timeout: 30000, // allow graceful drain (cancel render + requeue) before SIGKILL
      max_memory_restart: "5G", // worker heap; web heap shrinks once renders move off ai-content (PR-8)
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
        // Render tuning for the worker process (smaller per-job cache / quality floor).
        RENDER_OFFTHREAD_CACHE_MB: "128",
        RENDER_JPEG_QUALITY: "60",
      },
    },
  ],
};
