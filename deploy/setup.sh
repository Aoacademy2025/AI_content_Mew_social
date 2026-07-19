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

echo "=== [3b/8] Enable PM2 boot resurrection (systemd) ==="
# STAB-1: register the systemd unit that resurrects PM2 (and everything it manages —
# web, render/mcp workers, crons) on reboot. `pm2 startup` only PRINTS a
# `sudo env ... pm2 startup ...` command; that printed command is what actually
# installs+enables the unit, so capture and EXECUTE it (a bare `pm2 startup` in an
# unattended script is a no-op). Idempotent: re-running just rewrites the same unit.
STARTUP_CMD="$(pm2 startup systemd -u root --hp /root 2>/dev/null | grep -E '^sudo ' | tail -n1 || true)"
if [ -n "$STARTUP_CMD" ]; then
  echo "Registering PM2 systemd unit: $STARTUP_CMD"
  eval "$STARTUP_CMD"
else
  echo "pm2 startup printed no sudo command (already root/configured) — running directly"
  pm2 startup systemd -u root --hp /root || true
fi
# Persist the (currently empty) process list so the unit has a dump to resurrect from;
# deploy.sh runs `pm2 save` again after the apps are actually started.
pm2 save || true
# Verify the unit is enabled — fail LOUD here so provisioning surfaces a broken setup.
if systemctl is-enabled pm2-root >/dev/null 2>&1; then
  echo "OK: systemd unit 'pm2-root' is enabled — PM2 will resurrect on reboot."
else
  echo "WARNING: systemd unit 'pm2-root' is NOT enabled after setup — reboot will NOT restart PM2."
  echo "         Re-run this step or, as root: pm2 startup systemd -u root --hp /root && pm2 save"
fi

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
