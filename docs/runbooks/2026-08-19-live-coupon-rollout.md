# CLIP0819 production rollout runbook

วันที่จัดทำ: 16 สิงหาคม 2026
งาน: Live “โรงงานคลิป” วันพุธ 19 สิงหาคม 2026 เวลา 16:00 Asia/Bangkok

## Contract ที่ห้ามเปลี่ยนระหว่าง rollout

- `CLIP0819`: GRANT / PRO / 30 วัน / 500 สิทธิ์ / หมดอายุ `2026-08-21 23:59:59 Asia/Bangkok` (`2026-08-21T16:59:59Z`)
- คูปองเปิดแบบ `SAFE_APPEND` และให้ promo credits 50 หน่วย อายุ 30 วันเฉพาะบัญชีที่มีสิทธิ์เดิม
- FREE หรือ trial: เริ่ม PRO 30 วันทันที พร้อมรอบใหม่ 80 นาทีและ 50 monthly credits; ไม่บวก promo ซ้ำ
- Stripe ที่มี `stripeSubscriptionId`: ให้ promo credits 50 เท่านั้น ไม่แตะ plan, วันหมดอายุ, minute meter หรือ Stripe ไม่ว่าสถานะ subscription จะเป็นอะไร
- สิทธิ์แบบกำหนดเวลา (paid term, Bundle, Admin Grant, GRANT coupon): ต่อ PRO 30 วันหลังวันหมดอายุที่ไกลที่สุด ไม่ reset meter กลางรอบ และให้ promo credits 50 ทันที
- สิทธิ์ถาวร: คงสิทธิ์เดิมและให้ promo credits 50 เท่านั้น
- Brand Visual ยังเป็น upcoming feature: rollout 0/admin teaser และไม่รวมในสัญญาคูปอง
- ผู้ใช้หนึ่งบัญชีใช้คูปองเดิมได้ครั้งเดียว; การ redeem ที่ไม่เกิดประโยชน์หรือ rollback ต้องไม่กินสิทธิ์จาก 500

## สถานะก่อน deploy

- เก็บ `CLIP0819` ปิดไว้เสมอ จนกว่า migration, deploy และ private smoke จะผ่าน
- สคริปต์ config เป็น dry-run โดยค่าเริ่มต้น และจะไม่เปิดคูปองหากไม่มีทั้ง `--apply --enable` และ `LIVE0819_ENABLE=YES`
- ห้าม deploy หากมี RenderJob หรือ VideoJob ที่กำลัง `QUEUED`/`RUNNING`
- เป้าหมาย deploy: อังคาร 18 สิงหาคม ก่อน 12:00; ไม่มี planned deploy หลังจากนั้น และห้าม deploy ช่วงพุธ 19 สิงหาคม 15:00–18:00

## Pre-deploy gate

จาก branch ที่จะ merge:

```bash
npm ci
npm run verify:grant-coupon-redemption
npm run verify:grant-coupon-matrix
npm run verify:promotional-credits
npm run verify:coupon-pro-entitlements
npm run verify:paid-equivalent-entitlement
npm run verify:render-reservation-settlement
npm run verify:video-failure-credit-settlement
npm run build
git diff --check origin/main...HEAD
```

บน production ก่อน deploy:

```bash
cd /var/www/ai-content
sqlite3 prisma/dev.db "PRAGMA quick_check;"
sqlite3 prisma/dev.db "SELECT status, COUNT(*) FROM RenderJob WHERE status IN ('QUEUED','RUNNING') GROUP BY status;"
sqlite3 prisma/dev.db "SELECT status, COUNT(*) FROM VideoJob WHERE status IN ('queued','processing','waiting_provider') GROUP BY status;"
```

ผล queue ทั้งสองคำสั่งต้องว่าง และ `quick_check` ต้องได้ `ok`

## Backup และ restore rehearsal

สร้าง backup แบบ consistent ขณะ app ยังรันได้:

```bash
cd /var/www/ai-content
mkdir -p backups
sqlite3 prisma/dev.db ".backup 'backups/pre-live0819-20260818.db'"
sqlite3 backups/pre-live0819-20260818.db "PRAGMA quick_check;"
```

ซ้อม restore ไปไฟล์ทดสอบ ห้ามทับ production:

```bash
cd /var/www/ai-content
cp backups/pre-live0819-20260818.db /tmp/live0819-restore-rehearsal.db
sqlite3 /tmp/live0819-restore-rehearsal.db "PRAGMA foreign_key_check; PRAGMA quick_check;"
```

ต้องไม่มีผลจาก `foreign_key_check` และต้องได้ `ok` จาก `quick_check`

## Deploy โดยยังไม่เปิดคูปอง

1. Merge ตาม workflow ของ repo แล้ว deploy จาก `main` ด้วย `bash deploy/deploy.sh`
2. ตรวจ `/api/health`, PM2 logs และหน้า `/admin/coupons`
3. ตรวจ migration ว่ามี `Coupon.isActive`, `PromotionalCreditGrant`, `CouponAuditLog` และ funding snapshot fields
4. ตั้ง contract ของจริงแต่ยังปิด:

   ```bash
   cd /var/www/ai-content
   npm run ops:configure-live0819-coupon
   npm run ops:configure-live0819-coupon -- --apply
   ```

5. ตรวจจากหน้า admin ว่าแสดง `21 ส.ค. 2026 23:59:59` เวลาไทย, PRO 30 วัน, 500 สิทธิ์, promo 50/30 วัน และสถานะปิด

## Private smoke

สร้างคูปอง private คนละรหัสและ `maxUses=1` ผ่านหน้า admin โดยใช้ contract เดียวกับของจริง จากนั้นทดสอบอย่างน้อย:

1. FREE: ได้ PRO 30 วัน, 80 นาที, 50 monthly credits, ออก MCP PAT ได้
2. active trial: trial สิ้นสุดและเปลี่ยนเป็น PRO 30 วันทันที, meter 80/50 ใหม่
3. timed BUSINESS: BUSINESS และ meter เดิมไม่เปลี่ยน; มี scheduled PRO ต่อท้ายและ promo 50
4. Stripe BUSINESS ที่ `cancelAtPeriodEnd=true`: plan/expiry/minutes/Stripe ไม่เปลี่ยน; promo เพิ่ม 50 เท่านั้น
5. กรอกรหัสเดิมซ้ำ: ถูกปฏิเสธและ `usedCount` ไม่เพิ่ม
6. ทำ Hero AI Image หนึ่งงานและบังคับ failure หนึ่งงาน: ตัด 2 เครดิตตามวันหมดอายุที่ใกล้ที่สุดและคืนถังเดิมครบเมื่อ fail
7. ตรวจ report/CSV ที่ `/admin/coupons`: ref, signup, redemption, first clip และ paid membership ถูกต้อง; formula-like CSV cell ไม่ execute

ปิด private coupons หลัง smoke และเก็บ redemption/audit rows ไว้ ห้าม hard-delete

## เปิด CLIP0819

เมื่อ private smoke ผ่านและคิวว่าง:

```bash
cd /var/www/ai-content
LIVE0819_ENABLE=YES npm run ops:configure-live0819-coupon -- --apply --enable
```

ตรวจทันที:

```bash
sqlite3 prisma/dev.db "SELECT code,type,plan,durationDays,maxUses,usedCount,datetime(expiresAt/1000,'unixepoch'),isActive,stackingPolicy,promoCredits,promoCreditTtlDays FROM Coupon WHERE code='CLIP0819';"
```

เก็บ screenshot หน้า admin และทำ read-only preview ด้วยบัญชีทดสอบก่อนประกาศรหัส ห้ามใช้บัญชีทดสอบ redeem คูปองจริงหากต้องรักษา `usedCount=0`

## Monitoring ระหว่างไลฟ์

- ดู `usedCount`, redemption errors, database lock/timeout และ RenderJob/VideoJob queue ทุก 5–10 นาที
- ดู promo grant/ledger mismatch, negative balance และ refund failures
- รายงาน Studio แยก `live0819yt`, `live0819fb`, `live0819pre`, `live0819line`, `live0819code`; click count ดูที่ affiliate.heroaiengine.com
- ห้ามเปิด Brand Visual rollout เพียงเพื่อให้ตรงคำพูดในไลฟ์ ให้พูดว่าเป็น feature ที่กำลังจะ live เร็ว ๆ นี้

## Emergency stop และ rollback

กรณี redeem ผิด tier, reset สมาชิก Stripe, แจกซ้ำ, ledger ไม่ตรง หรือ error rate สูง:

1. กด Disable ที่ `/admin/coupons` ทันที หรือใช้ PATCH admin API; ห้ามลบคูปอง
2. ยืนยันว่า `isActive=false`; redemption ใหม่ต้องได้ `DISABLED`
3. หยุดประกาศรหัสและเก็บ user IDs/redemption IDs ที่ได้รับผลกระทบ
4. สิทธิ์ที่สำเร็จก่อนปิดยังคงอยู่ อย่าลบ redemption/promo grants โดยตรง
5. หากต้อง rollback code ให้ใช้ workflow deploy ปกติจาก commit ที่ยืนยันแล้ว และ restore DB เฉพาะ incident ที่ schema/data เสีย โดยหยุด app ก่อนและใช้ backup ที่ผ่าน restore rehearsal
6. หลัง incident ให้ reconcile `Coupon.usedCount` กับจำนวน `CouponRedemption` และตรวจ `CreditLedger`/`PromotionalCreditGrant` ก่อนแก้รายบัญชี

## หลังหมดเวลา

- หลัง `2026-08-21T16:59:59Z` redemption ที่เวลาเกินกว่านี้ต้องถูกปฏิเสธ; เวลาเท่ากับ boundary ยังยอมรับตาม contract
- ปิด `CLIP0819` ใน admin เพื่อให้สถานะชัด แม้ expiry จะป้องกันการใช้แล้ว
- export 4 กลุ่ม: สมัครแต่ไม่ redeem, redeemed, สร้างคลิป, paid membership
- สรุปยอดสำเร็จ/ล้มเหลว, cap, conversion และ support cases โดยไม่แก้หรือลบ audit evidence
