#!/bin/bash
# ============================================================
# AI Content — Hostinger VPS Setup Script
# Ubuntu 22.04 LTS
# รัน: bash setup.sh
# ============================================================

set -e

APP_DIR="/var/www/ai-content"
APP_USER="www-data"
NODE_VERSION="20"

echo "=== [1/8] Update system ==="
apt-get update && apt-get upgrade -y

echo "=== [2/8] Install Node.js $NODE_VERSION ==="
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
apt-get install -y nodejs

echo "=== [3/8] Install PM2 ==="
npm install -g pm2

echo "=== [4/8] Install Nginx ==="
apt-get install -y nginx

echo "=== [5/8] Install Python + Whisper deps ==="
apt-get install -y python3 python3-pip ffmpeg
pip3 install openai-whisper

echo "=== [6/8] Install PostgreSQL ==="
apt-get install -y postgresql postgresql-contrib
systemctl start postgresql
systemctl enable postgresql

echo "=== [7/8] Create app directory ==="
mkdir -p $APP_DIR
mkdir -p $APP_DIR/public/renders
mkdir -p $APP_DIR/stocks
chown -R $USER:$USER $APP_DIR

echo "=== [8/8] Setup firewall ==="
ufw allow 22
ufw allow 80
ufw allow 443
ufw --force enable

echo ""
echo "✅ Setup เสร็จ — ทำขั้นตอนถัดไปใน deploy.sh"
