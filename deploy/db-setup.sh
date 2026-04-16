#!/bin/bash
# ============================================================
# สร้าง PostgreSQL database สำหรับ production
# รัน: bash db-setup.sh
# ============================================================

DB_NAME="ai_content"
DB_USER="ai_content"
DB_PASS="$(openssl rand -base64 24)"  # generate random password

echo "=== สร้าง PostgreSQL user และ database ==="
sudo -u postgres psql <<EOF
CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';
CREATE DATABASE $DB_NAME OWNER $DB_USER;
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
EOF

echo ""
echo "✅ Database พร้อมแล้ว"
echo ""
echo "เพิ่มบรรทัดนี้ใน .env:"
echo "DATABASE_URL=\"postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME\""
