# HeyGen late-completion rollout

เอกสารนี้ใช้ deploy การแก้ปัญหา HeyGen สำเร็จช้ากว่า timeout เดิม 10 นาที โดยมีเงื่อนไขสำคัญว่า `VideoJob` และ `RenderJob` ต้องว่างพร้อมกันก่อนสลับ build production **ห้าม cancel งานของผู้ใช้เพื่อทำให้คิวว่าง**

ค่าคงที่ของ production:

```bash
APP_DIR=/var/www/ai-content
DB=/var/www/ai-content/prisma/dev.db
MARKER=/var/www/ai-content/.deploy-maintenance
```

## 1. ตรวจสถานะก่อน rollout

บันทึก SHA และสถานะ process ก่อนเปลี่ยนระบบ:

```bash
cd /var/www/ai-content
git rev-parse HEAD
pm2 status
sqlite3 prisma/dev.db <<'SQL'
SELECT 'VideoJob', status, COUNT(*)
FROM VideoJob
WHERE status IN ('queued', 'processing', 'waiting_provider')
GROUP BY status;
SELECT 'RenderJob', status, COUNT(*)
FROM RenderJob
WHERE status IN ('QUEUED', 'RUNNING')
GROUP BY status;
SQL
```

ถ้ามีผลลัพธ์แม้แต่หนึ่งแถว ให้รอจนงานจบเองแล้วเช็คใหม่ ห้ามแก้สถานะ, kill worker หรือ cancel งานเพื่อเร่ง deploy

## 2. เตรียม ingress barrier ครั้งแรก

ก่อน rollout ครั้งแรก production รุ่นเดิมยังไม่มี DB drain ให้ใช้ marker ของ Nginx เป็นตัวกันงานใหม่ก่อน ตรวจหาไฟล์ config จริงและสำรองก่อน:

```bash
nginx -T 2>&1 | less
install -d -m 0700 /etc/nginx/config-backups
cp /etc/nginx/sites-enabled/ACTIVE_CONFIG \
  /etc/nginx/config-backups/ACTIVE_CONFIG.before-heygen-rollout
```

ห้ามวางไฟล์ backup ไว้ใน `sites-enabled` เพราะ Nginx จะ include ไฟล์นั้นเป็น config อีกชุดและเกิด duplicate `listen`/`server`

ติดตั้ง static maintenance page จาก release นี้ไว้ **นอก working tree** ก่อนแก้ Nginx เพื่อให้ `git checkout/pull` ระหว่าง deploy ไม่กระทบหน้าที่กำลังเสิร์ฟ:

```bash
install -d -m 0755 /var/www/heroai-maintenance
install -m 0644 /var/www/ai-content/deploy/maintenance.html \
  /var/www/heroai-maintenance/maintenance.html
test -r /var/www/heroai-maintenance/maintenance.html
```

ใน HTTPS `server` block ของ config จริง เพิ่ม error document นี้หนึ่งครั้ง:

```nginx
error_page 503 /maintenance.html;

location = /maintenance.html {
    root /var/www/heroai-maintenance;
    internal;
    add_header Retry-After "120" always;
    add_header Cache-Control "no-store, no-cache, must-revalidate" always;
}
```

จากนั้นใส่ marker guard ไว้ด้านบนของ public `location /` ที่ proxy เข้า Next.js:

```nginx
location / {
    if (-f /var/www/ai-content/.deploy-maintenance) {
        return 503;
    }

    # proxy_pass และ proxy headers เดิมอยู่ต่อจากนี้
}
```

ถ้า config มี public static locations แยก เช่น `/_next/static/` หรือ `/renders/` ให้ใส่ guard เดียวกันใน location เหล่านั้นด้วย แต่ **ห้ามวาง guard ไว้ระดับ `server` และห้ามใส่ใน `location = /maintenance.html`** เพราะ internal redirect จะถูก guard ซ้ำและกลับไปเป็นหน้า 503 มาตรฐานของ Nginx

HTTP server block ใช้รูปแบบเดียวกัน: มี `error_page` + internal maintenance location และย้าย redirect เดิมเข้า `location /` หลัง marker guard

ตรวจ syntax/reload โดยยังไม่สร้าง marker:

```bash
nginx -t
systemctl reload nginx
```

อย่า copy `deploy/nginx.conf` ทับ config จริงทั้งไฟล์ เพราะชื่อโดเมนใน template อาจไม่ตรง production

## 3. ตรวจ deploy guards ก่อนเริ่ม

`deploy/deploy.sh` เป็นเจ้าของ guard ทั้งหมดแล้ว ห้ามสร้าง `.deploy-maintenance` หรือเปิด
DB drain ด้วยมือสำหรับ rollout ปกติ ให้ตรวจเพียงว่าไม่มี guard เก่าค้างจากเหตุการณ์ก่อนหน้า:

```bash
cd /var/www/ai-content
npm run ops:render-drain -- status
test ! -e .deploy-maintenance
```

ก่อน `npm ci` แตะ live `node_modules` script จะทำ **Mandatory render drain** โดยอัตโนมัติ:

1. ติดตั้ง cleanup trap แล้วเปิด DB drain เพื่อปฏิเสธ parent job ใหม่
2. ปล่อย child `RenderJob` ของ `VideoJob` ที่เริ่มก่อน drain ทำงานต่อ
3. รอทั้งสองคิวเป็นศูนย์แบบ fail-closed โดยไม่ cancel งาน
4. ติดตั้ง dependency, sync schema และ build โดยคง drain ไว้ตลอด
5. ตรวจคิวซ้ำ เปิด maintenance barrier, สลับ build และ restart ทุก worker
6. ปิด drain ก่อนเปิด ingress ใน cleanup เดียวกันทุก success/failure path

ค่าเริ่มต้นรอคิวได้สูงสุด 3,600 วินาที หากหมดเวลา script จะไม่แตะ dependency
หรือ live `.next`, ไม่ restart PM2 และเปิดรับงานกลับเอง หาก fail ที่การตรวจซ้ำก่อน swap
จะลบเฉพาะ staging และคง live `.next` ไว้

## 4. สำรองและตรวจฐานข้อมูล

ทำ backup แบบ consistent และต้องได้ `ok` จาก `PRAGMA quick_check`:

```bash
cd /var/www/ai-content
BACKUP="prisma/dev.db.before-heygen-$(date +%Y%m%d-%H%M%S)"
sqlite3 prisma/dev.db ".backup '$BACKUP'"
sqlite3 "$BACKUP" 'PRAGMA quick_check;'
```

หยุด rollout ถ้าผลไม่ใช่ `ok`

## 5. Deploy พร้อม mandatory fail-closed queue gate

ไม่ต้องส่ง flag เพิ่มและไม่มีเส้นทาง deploy ปกติที่ข้าม queue gate:

```bash
cd /var/www/ai-content
DEPLOY_BRANCH=main bash deploy/deploy.sh
```

script จะเปิด drain และรอคิวว่างก่อน `npm ci`, build ใน `.next-staging` โดยคง drain ไว้
แล้วตรวจคิวซ้ำก่อน atomic swap
หากคิวไม่ว่างตามเวลา หรืออ่าน DB ไม่ได้ จะลบเฉพาะ staging, ไม่แตะ live
`.next`/`.next.old` และไม่ restart PM2

## 6. ตรวจหลัง deploy

```bash
cd /var/www/ai-content
git rev-parse HEAD
sqlite3 prisma/dev.db "PRAGMA table_info('VideoJob');" | \
  grep -E 'providerCheckpointJson|providerNextPollAt'
pm2 status
npm run ops:check-render-queues
npm run ops:render-drain -- status
```

ต้องเห็น web `ai-content`, `mcp-video-worker`, `render-worker` online, สองคิวเป็นศูนย์,
drain เป็น `off`, ไม่มี `.deploy-maintenance` และ public health กลับมา 200 หาก deploy ล้มเหลว
cleanup trap ภายใน script ต้องคืนสถานะสอง guard นี้เอง ห้ามปลดด้วยมือก่อนอ่านสาเหตุจาก log

```bash
test ! -e .deploy-maintenance
curl --fail --silent --show-error https://YOUR_PRODUCTION_DOMAIN/api/health
```

## 7. สังเกต delayed job แรก

ไม่ต้องสร้างงาน HeyGen แบบเสียเงินเพื่อทดสอบ รอสังเกตงานจริงงานแรกที่ใช้เวลานาน ตรวจว่าลำดับใน log เป็น `processing -> waiting_provider -> processing -> done` และ provider video ID เดิมถูก poll ต่อ ไม่ได้ generate ซ้ำ:

```bash
pm2 logs mcp-video-worker --lines 500 --nostream | \
  grep -E 'waiting_provider|provider|resume|done'
sqlite3 prisma/dev.db <<'SQL'
SELECT id, status, providerNextPollAt, providerCheckpointJson
FROM VideoJob
WHERE providerCheckpointJson IS NOT NULL
ORDER BY updatedAt DESC
LIMIT 20;
SELECT json_extract(providerCheckpointJson, '$.intro.providerVideoId') AS provider_id,
       COUNT(*)
FROM VideoJob
WHERE providerCheckpointJson IS NOT NULL
GROUP BY provider_id
HAVING provider_id IS NOT NULL;
SQL
```

การ transition อาจเกิดเร็วเกินกว่าจะเห็นจาก snapshot DB จึงใช้ PM2 log ประกอบ ส่วน provider ID ต้องคงเดิมตลอด resume และไม่ควรมี generate call ซ้ำสำหรับ phase เดียวกัน

## 8. Legacy recovery: dry-run ก่อนเสมอ

คำสั่งปกติเป็น inspection/dry-run และไม่มี write:

```bash
cd /var/www/ai-content
JOB_ID='failed-video-job-id'
HEYGEN_VIDEO_ID='provider-video-id'
npm run ops:recover-heygen-timeout -- \
  --job-id "$JOB_ID" \
  --heygen-video-id "$HEYGEN_VIDEO_ID"
```

failed rows ของ account `sumawad` ที่มี successful retry ของ project/script เดียวกันต้องแสดง `superseded`; ถือว่าเป็นผลสำเร็จของ audit และ **ห้ามใช้ `--apply`** กับแถวเหล่านั้น

ใช้ `--apply` ได้เฉพาะ job ที่ dry-run รายงาน `recoverable` หรือ `pending`, ผ่าน ownership/media/payload/provider checks ครบ, ไม่มี successful retry และได้รับอนุมัติเป็นราย job:

```bash
npm run ops:recover-heygen-timeout -- --apply \
  --job-id "$JOB_ID" \
  --heygen-video-id "$HEYGEN_VIDEO_ID"
```

## 9. Rollback

ให้ marker และ DB drain คงเปิดอยู่ระหว่าง rollback และยืนยันสองคิวว่างก่อนทุกครั้ง ถ้า release ใหม่มีปัญหาแต่ schema additive ยังใช้กับ code เดิมได้:

```bash
cd /var/www/ai-content
pm2 stop ai-content mcp-video-worker render-worker
mv .next .next.failed-$(date +%Y%m%d-%H%M%S)
mv .next.old .next
pm2 start ecosystem.config.js
pm2 save
```

ตรวจ PM2 และ read-only health แล้วค่อยสั่ง `npm run ops:render-drain -- off`, ลบ marker และ reload Nginx ห้าม restore DB ทับ production โดยอัตโนมัติ; ใช้ backup เฉพาะเมื่อวิเคราะห์ data migration แล้วว่าจำเป็นจริง
