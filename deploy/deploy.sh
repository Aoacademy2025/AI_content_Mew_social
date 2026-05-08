#!/usr/bin/env bash
# ============================================================
# AI Content - Deploy / Update Script
# Usage: bash deploy/deploy.sh
# ============================================================

set -euo pipefail

APP_DIR="/var/www/ai-content"
REPO_URL="https://github.com/Aoacademy2025/AI_content_Mew_social.git"
APP_NAME="ai-content"
DEFAULT_BRANCH="main"

# Build tuning
BUILD_HEAP_MB="${BUILD_HEAP_MB:-12288}"
export CI="1"
export BUILD_NO_LINT="1"
export NODE_OPTIONS="--max-old-space-size=${BUILD_HEAP_MB}"
export NEXT_DISABLE_ESLINT="1"

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

echo "=== [3/6] Copy .env ==="
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/deploy/.env.production" "$APP_DIR/.env"
fi
if [ ! -f "$APP_DIR/.env" ]; then
  echo "ERROR: missing .env file after setup"
  exit 1
fi

echo "=== [4/6] Prisma generate ==="
npx prisma generate

echo "=== [5/6] Clean and build ==="
rm -rf "$APP_DIR/.next"
npm run build

if [ ! -f "$APP_DIR/.next/BUILD_ID" ]; then
  echo "ERROR: build did not generate .next/BUILD_ID"
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
