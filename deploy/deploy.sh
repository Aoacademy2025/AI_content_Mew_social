#!/bin/bash
# ============================================================
# AI Content — Deploy / Update Script
# รัน: bash deploy.sh
# ============================================================

set -e

APP_DIR="/var/www/ai-content"
REPO_URL="https://github.com/YOUR_USERNAME/YOUR_REPO.git"  # แก้ตรงนี้

echo "=== [1/6] Pull latest code ==="
if [ -d "$APP_DIR/.git" ]; then
  cd $APP_DIR && git pull
else
  git clone $REPO_URL $APP_DIR
  cd $APP_DIR
fi

echo "=== [2/6] Install dependencies ==="
cd $APP_DIR
npm install --production=false

echo "=== [3/6] Copy .env ==="
if [ ! -f "$APP_DIR/.env" ]; then
  cp $APP_DIR/deploy/.env.production $APP_DIR/.env
  echo "⚠️  กรอก .env ให้ครบก่อน build"
  exit 1
fi

echo "=== [4/6] Prisma migrate ==="
npx prisma migrate deploy
npx prisma generate

echo "=== [5/6] Build ==="
npm run build

echo "=== [6/6] Restart PM2 ==="
pm2 describe ai-content > /dev/null 2>&1 && pm2 restart ai-content || pm2 start npm --name "ai-content" -- start
pm2 save
pm2 startup

echo ""
echo "✅ Deploy เสร็จ — เว็บรันที่ port 3000"
