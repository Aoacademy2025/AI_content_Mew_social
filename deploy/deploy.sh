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

echo "=== [4/6] Prisma generate ==="
if [ "$MIGRATE" != "1" ]; then
  npx prisma migrate deploy
fi
npx prisma generate

echo "=== [5/6] Build (heap: ${BUILD_HEAP_MB}MB, worker heap: ${BUILD_WORKER_HEAP_MB}MB) ==="
rm -rf "$APP_DIR/.next"
if ! npm run build; then
  echo "Build failed. Retrying with lower memory profile: main=${BUILD_HEAP_MB_LOW}MB worker=${BUILD_WORKER_HEAP_MB_LOW}MB"
  rm -rf "$APP_DIR/.next"
  export BUILD_HEAP_MB="$BUILD_HEAP_MB_LOW"
  export BUILD_WORKER_HEAP_MB="$BUILD_WORKER_HEAP_MB_LOW"
  export NODE_OPTIONS="--max-old-space-size=${BUILD_HEAP_MB} --max-semi-space-size=8"
  export NEXT_PRIVATE_WORKER_OPTIONS="--max-old-space-size=${BUILD_WORKER_HEAP_MB}"
  npm run build || exit 1
fi

if [ ! -f "$APP_DIR/.next/BUILD_ID" ]; then
  echo "ERROR: build did not generate .next/BUILD_ID (most likely killed by OOM)"
  exit 1
fi

echo "=== [6/6] Restart PM2 ==="
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  pm2 restart "$APP_NAME"
else
  pm2 start ecosystem.config.js --only "$APP_NAME"
fi
pm2 save
pm2 startup

echo ""
echo "Deploy finished successfully."
