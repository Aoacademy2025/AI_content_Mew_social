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
npx prisma db push --skip-generate
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

echo "=== [6/6] Restart PM2 ==="
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  pm2 restart "$APP_NAME"
else
  pm2 start ecosystem.config.js --only "$APP_NAME"
fi

# The MCP async video worker runs the pipeline (orchestrator/pipeline-client) in
# a SEPARATE process. A deploy that ships new pipeline code to ai-content would
# otherwise leave the worker on stale code (version skew → silently-failing MCP
# jobs), so restart it in lockstep right after ai-content. --update-env picks up
# any ecosystem env changes; falls back to start if it isn't running yet.
WORKER_NAME="mcp-video-worker"
if pm2 describe "$WORKER_NAME" > /dev/null 2>&1; then
  pm2 restart "$WORKER_NAME" --update-env
else
  pm2 start ecosystem.config.js --only "$WORKER_NAME"
fi
pm2 save
pm2 startup

echo ""
echo "Deploy finished successfully."
