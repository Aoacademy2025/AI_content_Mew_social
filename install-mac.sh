#!/bin/bash
set -e

echo "============================================"
echo "  Mew Social - Mac Installer"
echo "============================================"
echo ""

APP_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── 1. Check Homebrew ──
echo "[1/5] ตรวจสอบ Homebrew..."
if ! command -v brew &>/dev/null; then
    echo "Homebrew ไม่พบ กำลังติดตั้ง..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
    echo "Homebrew พบแล้ว: $(brew --version | head -1)"
fi

# ── 2. Check Node.js ──
echo ""
echo "[2/5] ตรวจสอบ Node.js..."
if ! command -v node &>/dev/null; then
    echo "Node.js ไม่พบ กำลังติดตั้ง..."
    brew install node@20
    brew link node@20 --force
else
    echo "Node.js พบแล้ว: $(node --version)"
fi

# ── 3. Check Python ──
echo ""
echo "[3/5] ตรวจสอบ Python..."
if ! command -v python3 &>/dev/null; then
    echo "Python ไม่พบ กำลังติดตั้ง..."
    brew install python@3.10
else
    echo "Python พบแล้ว: $(python3 --version)"
fi

# ── 4. Check ffmpeg ──
echo ""
echo "[4/5] ตรวจสอบ ffmpeg..."
if ! command -v ffmpeg &>/dev/null; then
    echo "ffmpeg ไม่พบ กำลังติดตั้ง..."
    brew install ffmpeg
else
    echo "ffmpeg พบแล้ว"
fi

# ── 5. Install Node dependencies ──
echo ""
echo "[5/5] ติดตั้ง Node.js dependencies..."
cd "$APP_DIR"
npm install

# ── Install Whisper ──
echo ""
echo "ติดตั้ง Whisper (อาจใช้เวลา 5-10 นาที)..."
pip3 install openai-whisper 2>/dev/null || pip install openai-whisper
echo "Whisper ติดตั้งเสร็จ"

# ── Setup .env.local ──
echo ""
echo "============================================"
echo "  ตั้งค่า Environment"
echo "============================================"
if [ ! -f "$APP_DIR/.env.local" ]; then
    SECRET=$(openssl rand -hex 32)
    cat > "$APP_DIR/.env.local" << EOF
DATABASE_URL="file:./dev.db"
NEXTAUTH_SECRET="$SECRET"
NEXTAUTH_URL="http://localhost:3000"
WHISPER_MODEL=medium
EOF
    echo "ไฟล์ .env.local สร้างแล้ว"
else
    echo "ไฟล์ .env.local มีอยู่แล้ว"
fi

# ── Setup Database ──
echo ""
echo "กำลังสร้างฐานข้อมูล..."
npx prisma generate
npx prisma db push

# ── Build App ──
echo ""
echo "กำลัง build แอป (อาจใช้เวลา 3-5 นาที)..."
npm run build

# ── Create start script ──
cat > "$APP_DIR/start.sh" << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
open "http://localhost:3000" 2>/dev/null &
npm start
EOF
chmod +x "$APP_DIR/start.sh"

# ── Create app shortcut in Applications ──
cat > "/tmp/MewSocial.command" << EOF
#!/bin/bash
cd "$APP_DIR"
open "http://localhost:3000" &
sleep 2
npm start
EOF
chmod +x "/tmp/MewSocial.command"
cp "/tmp/MewSocial.command" ~/Desktop/"Mew Social.command"

echo ""
echo "============================================"
echo "  ติดตั้งเสร็จเรียบร้อย!"
echo "============================================"
echo ""
echo "กด double-click 'Mew Social.command' บน Desktop เพื่อเปิดแอป"
echo "หรือรัน: ./start.sh"
echo ""
echo "แอปจะเปิดที่: http://localhost:3000"
echo ""
