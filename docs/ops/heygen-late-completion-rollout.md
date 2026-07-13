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
cp /etc/nginx/sites-enabled/ACTIVE_CONFIG \
  /etc/nginx/sites-enabled/ACTIVE_CONFIG.before-heygen-rollout
```

เพิ่ม guard นี้ใน HTTPS `server` block ของ config ที่ใช้งานจริง (และ HTTP block ถ้ามี endpoint ที่ไม่ redirect):

```nginx
if (-f /var/www/ai-content/.deploy-maintenance) {
    return 503;
}
```

ตรวจ syntax/reload โดยยังไม่สร้าง marker:

```bash
nginx -t
systemctl reload nginx
```

อย่า copy `deploy/nginx.conf` ทับ config จริงทั้งไฟล์ เพราะชื่อโดเมนใน template อาจไม่ตรง production

## 3. ปิด ingress และรอคิวว่าง

สร้าง cleanup trap ใน shell เดียวกับที่ deploy เพื่อให้ทุก failure path เปิดระบบกลับและปิด DB drain:

```bash
cleanup_rollout() {
  rm -f /var/www/ai-content/.deploy-maintenance
  cd /var/www/ai-content
  npm run ops:render-drain -- off || true
  nginx -t && systemctl reload nginx
}
trap cleanup_rollout EXIT

touch /var/www/ai-content/.deploy-maintenance
```

เมื่อ trap ทำงานจะลบ `.deploy-maintenance` ก่อน แล้วสั่ง `npm run ops:render-drain -- off` เพื่อไม่ทิ้งระบบไว้ใน maintenance โดยไม่ตั้งใจ

marker กัน request ใหม่จากภายนอก แต่ worker ภายในที่เรียก `127.0.0.1:3000` ยังทำงานเดิมต่อได้ ให้รัน SQL ในข้อ 1 ซ้ำจนทั้งสอง query ไม่มีแถว **โดยไม่ cancel งาน** แล้วเช็คซ้ำอีกครั้งหลังเว้นระยะหนึ่งเพื่อปิด race

สำหรับ rollout หลังครั้งแรก เมื่อคิวเป็นศูนย์แล้วจึงเปิด DB drain และเช็คผ่าน command ของระบบ:

```bash
cd /var/www/ai-content
npm run ops:render-drain -- on
npm run ops:check-render-queues
```

ผลที่ยอมรับได้เท่านั้นคือ `videoJobs=0 renderJobs=0 empty=yes` ห้ามเปิด DB drain ขณะที่ยังมี `VideoJob` เพราะงานเดิมอาจต้อง enqueue `RenderJob` ภายในและจะถูกบล็อก

สำหรับ rollout ครั้งแรก ให้คง marker ไว้และใช้ direct SQL จนเป็นศูนย์ ถ้า checkout รุ่นเดิมยังไม่มีคำสั่ง `ops:render-drain`; deploy gate ด้านล่างจะเช็คซ้ำก่อนสลับ build

## 4. สำรองและตรวจฐานข้อมูล

ทำ backup แบบ consistent และต้องได้ `ok` จาก `PRAGMA quick_check`:

```bash
cd /var/www/ai-content
BACKUP="prisma/dev.db.before-heygen-$(date +%Y%m%d-%H%M%S)"
sqlite3 prisma/dev.db ".backup '$BACKUP'"
sqlite3 "$BACKUP" 'PRAGMA quick_check;'
```

หยุด rollout ถ้าผลไม่ใช่ `ok`

## 5. Deploy พร้อม fail-closed queue gate

marker ต้องยังอยู่และ direct SQL ต้องเป็นศูนย์ก่อนสั่ง:

```bash
cd /var/www/ai-content
REQUIRE_EMPTY_RENDER_QUEUES=1 DEPLOY_BRANCH=main bash deploy/deploy.sh
```

script จะ build ใน `.next-staging` แล้วรัน empty-queue checker ทันทีก่อน atomic swap หากคิวกลับมามีงานหรืออ่าน DB ไม่ได้ script จะลบเฉพาะ staging, ไม่แตะ live `.next`/`.next.old` และไม่ restart PM2

## 6. ตรวจหลัง deploy ก่อนเปิด ingress

```bash
cd /var/www/ai-content
git rev-parse HEAD
sqlite3 prisma/dev.db "PRAGMA table_info('VideoJob');" | \
  grep -E 'providerCheckpointJson|providerNextPollAt'
pm2 status
npm run ops:check-render-queues
npm run ops:render-drain -- status
```

ต้องเห็น web `ai-content`, `mcp-video-worker`, `render-worker` online, สองคิวเป็นศูนย์ และสองคอลัมน์ใหม่มีอยู่ จากนั้นทดสอบ health/status แบบ read-only ผ่าน localhost และ public endpoint ตาม config จริง

เมื่อทุกอย่างผ่าน ให้เปิดรับงานและยกเลิก trap:

```bash
npm run ops:render-drain -- off
rm -f /var/www/ai-content/.deploy-maintenance
nginx -t && systemctl reload nginx
trap - EXIT
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
