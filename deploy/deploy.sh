#!/usr/bin/env bash
# ============================================================
# AI Content - Deploy / Update Script
# Usage: bash deploy/deploy.sh
# ============================================================

set -euo pipefail

APP_DIR="/var/www/ai-content"
REPO_URL="https://github.com/Aoacademy2025/AI_content_Mew_social.git"
APP_NAME="ai-content"
DEFAULT_BRANCH="${DEPLOY_BRANCH:-main}"
MIGRATE="${SKIP_DB_MIGRATE:-0}"

# Build tuning for low-memory VPS
BUILD_HEAP_MB="${BUILD_HEAP_MB:-12000}"
BUILD_WORKER_HEAP_MB="${BUILD_WORKER_HEAP_MB:-2048}"
BUILD_HEAP_MB_LOW="${BUILD_HEAP_MB_LOW:-8192}"
BUILD_WORKER_HEAP_MB_LOW="${BUILD_WORKER_HEAP_MB_LOW:-1024}"
BUILD_NO_LINT="${BUILD_NO_LINT:-1}"
export BUILD_HEAP_MB BUILD_WORKER_HEAP_MB BUILD_NO_LINT
export CI="1"
export NODE_OPTIONS="--max-old-space-size=${BUILD_HEAP_MB} --max-semi-space-size=16"
export NEXT_PRIVATE_WORKER_OPTIONS="--max-old-space-size=${BUILD_WORKER_HEAP_MB}"
if [ "$BUILD_NO_LINT" = "1" ]; then
  export NEXT_DISABLE_ESLINT="1"
fi

echo "=== [1/6] Pull latest code ==="
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR"
  git fetch --all --prune
  git checkout "$DEFAULT_BRANCH"
  git pull origin "$DEFAULT_BRANCH"
else
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
  git checkout "$DEFAULT_BRANCH"
fi

# Keep the maintenance document outside the working tree that this deploy
# updates. Nginx can continue serving it while git and .next are changing.
MAINTENANCE_PAGE_DIR="/var/www/heroai-maintenance"
install -d -m 0755 "$MAINTENANCE_PAGE_DIR"
install -m 0644 "$APP_DIR/deploy/maintenance.html" "$MAINTENANCE_PAGE_DIR/maintenance.html.next"
mv "$MAINTENANCE_PAGE_DIR/maintenance.html.next" "$MAINTENANCE_PAGE_DIR/maintenance.html"

echo "=== [2/6] Install dependencies ==="
cd "$APP_DIR"
npm install --no-audit --no-fund

echo "=== [3/6] Prepare .env ==="
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/deploy/.env.production" "$APP_DIR/.env"
fi
if [ ! -f "$APP_DIR/.env" ]; then
  echo "ERROR: missing .env file"
  exit 1
fi

echo "=== [4/6] Prisma sync schema + generate ==="
# SQLite project uses db push (no migrations dir). Sync new columns into the
# live DB so queries referencing new fields (e.g. cancelAtPeriodEnd) don't 500.
# No --accept-data-loss: additive changes (new nullable/defaulted columns) apply
# safely; a destructive change will fail loudly instead of dropping data.
# P3.3: db push runs FIRST (before build/restart). If it fails, abort with a LOUD
# banner — set -e would exit anyway, but silently; this makes it unmissable in the log
# and guarantees we never build+restart onto code that expects columns the DB lacks.
if ! npx prisma db push --skip-generate; then
  echo ""
  echo "########################################################################"
  echo "## DEPLOY ABORTED — DB SCHEMA NOT APPLIED"
  echo "## 'prisma db push' failed. Build and PM2 restart were NOT run, so the"
  echo "## app keeps serving on the OLD schema + OLD code (no partial deploy)."
  echo "## Likely cause: a destructive/ambiguous schema change needing review, or"
  echo "## the DB is locked. Resolve the drift, then re-run: bash deploy/deploy.sh"
  echo "########################################################################"
  exit 1
fi
npx prisma generate

echo "=== [5/6] Build (heap: ${BUILD_HEAP_MB}MB, worker heap: ${BUILD_WORKER_HEAP_MB}MB) ==="
# Build into a staging dir and swap it into .next only after BUILD_ID exists.
# The old in-place flow (rm -rf .next before building) left the running app
# with NO dist dir for the whole multi-minute build; a failed/OOM build caused
# a ".next not found" crash loop. Runtime (pm2 `next start`) never sets
# NEXT_DIST_DIR, so it keeps serving the existing .next until the swap.
STAGING_DIR="$APP_DIR/.next-staging"
export NEXT_DIST_DIR=".next-staging"
run_next_build() {
  local media_root
  local media_shadow
  rm -rf "$STAGING_DIR"
  mkdir -p "$STAGING_DIR"
  # Preserve the webpack/SWC build cache from the LIVE .next so the compile is
  # INCREMENTAL, not from-scratch every deploy. The staging-dir flow otherwise
  # starts each build with an empty cache (log: "No build cache found") → the
  # full ~40min compile every time. Reusing the prior cache cuts unchanged-code
  # deploys from ~40min to a few minutes. Safe: Next re-validates the cache and
  # rebuilds anything stale; a bad cache only costs a slower build, never wrong output.
  if [ -d "$APP_DIR/.next/cache" ]; then
    cp -a "$APP_DIR/.next/cache" "$STAGING_DIR/cache" 2>/dev/null || true
  fi

  # Next traces dynamic filesystem reads before applying NFT exclusions. On a
  # live media host that made the build enumerate thousands of runtime renders
  # and stocks, consuming almost all RAM even though none belongs in the bundle.
  # A private mount namespace gives only the build empty views of those roots;
  # the running web/workers continue to see the real files on the host.
  for media_root in "$APP_DIR/public/renders" "$APP_DIR/stocks"; do
    if [ ! -d "$media_root" ] || [ -L "$media_root" ]; then
      echo "ERROR: unsafe runtime media root for isolated build: $media_root"
      return 1
    fi
  done
  mkdir -p "$APP_DIR/.tmp"
  media_shadow="$(mktemp -d "$APP_DIR/.tmp/next-build-media.XXXXXX")"
  if ! unshare --mount --propagation private sh -c '
    set -eu
    media_shadow="$1"
    app_dir="$2"
    mount --bind "$media_shadow" "$app_dir/public/renders"
    mount --bind "$media_shadow" "$app_dir/stocks"
    cd "$app_dir"
    npm run build
  ' sh "$media_shadow" "$APP_DIR"; then
    rmdir "$media_shadow"
    return 1
  fi
  rmdir "$media_shadow"
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

echo "=== [5a/6] Normalize staged build permissions ==="
# Build output inherits the caller's umask. Nginx runs as a different user and
# must be able to traverse directories and read static assets before the swap.
chmod -R a+rX "$STAGING_DIR"

echo "=== [5b/6] Empty render queue gate ==="
# Production rollouts set REQUIRE_EMPTY_RENDER_QUEUES=1 after external ingress is
# blocked. The checker is fail-closed: active queues exit 2 and DB/unknown errors exit
# nonzero. Abort before touching live .next or restarting any PM2 process.
if [ "${REQUIRE_EMPTY_RENDER_QUEUES:-0}" = "1" ]; then
  if ! npx tsx scripts/check-empty-render-queues.ts; then
    rm -rf "$STAGING_DIR"
    echo "ERROR: render queues are active or unreadable. Old .next untouched; PM2 was not restarted."
    exit 1
  fi
fi

echo "=== [5c/6] Atomic swap .next-staging -> .next ==="
# .next.old is kept until the next deploy as a manual rollback
# (mv .next.old .next && pm2 restart ai-content); costs a few hundred MB.
rm -rf "$APP_DIR/.next.old"
if [ -d "$APP_DIR/.next" ]; then
  mv "$APP_DIR/.next" "$APP_DIR/.next.old"
fi
mv "$STAGING_DIR" "$APP_DIR/.next"
unset NEXT_DIST_DIR

echo "=== [6/6] Restart PM2 ==="
restart_from_ecosystem() {
  local process_name="$1"
  if pm2 describe "$process_name" > /dev/null 2>&1; then
    # Both pieces are load-bearing on the production PM2 version: the ecosystem
    # file supplies the reviewed values and --update-env replaces the saved env.
    # Without the flag PM2 warns and keeps stale values even though the file is passed.
    pm2 restart ecosystem.config.js --only "$process_name" --update-env
  else
    pm2 start ecosystem.config.js --only "$process_name" --update-env
  fi
}

restart_from_ecosystem "$APP_NAME"

# The MCP async video worker runs the pipeline (orchestrator/pipeline-client) in
# a SEPARATE process. A deploy that ships new pipeline code to ai-content would
# otherwise leave the worker on stale code (version skew → silently-failing MCP
# jobs), so reload it from the checked-in ecosystem config in lockstep with ai-content.
WORKER_NAME="mcp-video-worker"
restart_from_ecosystem "$WORKER_NAME"

# PR-7 durable render queue: the render-worker runs the render core (runRender) in
# its OWN process, so a deploy must restart it in lockstep with ai-content (else it
# stays on stale render code → version skew). Reloading the ecosystem file applies the
# reviewed render profile; kill_timeout (30s) still lets an in-flight render drain
# gracefully (cancel + requeue with no attempt consumed).
RENDER_WORKER_NAME="render-worker"
restart_from_ecosystem "$RENDER_WORKER_NAME"

pm2 save
pm2 startup

# STAB-1 self-check: verify PM2 reboot-resurrection is actually armed. `pm2 save` above
# only persists the process list; the systemd UNIT that replays it on boot is registered
# by deploy/setup.sh (`pm2 startup systemd`). If that unit is missing, a VPS reboot brings
# back NOTHING (web, workers, crons). Warn LOUD — non-fatal (the deploy itself succeeded),
# guarded so `is-enabled` returning non-zero can't trip `set -e`.
echo "=== [self-check] PM2 reboot resurrection (systemd unit) ==="
if systemctl is-enabled pm2-root >/dev/null 2>&1; then
  echo "OK: systemd unit 'pm2-root' is enabled — PM2 will resurrect on reboot."
else
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "!! WARNING: systemd unit 'pm2-root' is NOT enabled."
  echo "!! A reboot will NOT restart PM2 — web, workers, and crons stay DOWN."
  echo "!! Fix once, as root:  pm2 startup systemd -u root --hp /root && pm2 save"
  echo "!! (or re-run deploy/setup.sh — it registers the unit idempotently)."
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
fi

echo ""
echo "Deploy finished successfully."
