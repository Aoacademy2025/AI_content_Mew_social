# Hero Script public-launch runbook

วันที่จัดทำ: 7 สิงหาคม 2026
เป้าหมาย: เปิด Hero Script ให้สมาชิกแบบชำระเงิน 100% โดยไม่เปิด free/trial cohort ในรอบแรก และให้ผู้ใช้ทุกคนเห็นเมนู/Preview/คู่มือ

> คำว่า “พร้อมเปิด” ใน runbook นี้หมายถึง critical paths ที่กำหนดไว้ผ่านครบและไม่มี incident ระหว่าง cohort จริง ไม่ได้หมายความว่าซอฟต์แวร์จะพิสูจน์ได้ว่าไม่มี bug ทุกชนิด

## สิ่งที่ต้องผ่านก่อน deploy

- `npm run verify:hero-script-launch` ผ่านทั้งหมด
- `npx tsc --noEmit` และ `npm run build` ผ่าน
- ตรวจ diff ว่าไม่มี secret, production data หรือ rollout flag ที่เปิดโดยไม่ตั้งใจ
- ตรวจว่า webhook secret และ Stripe price IDs ของ production ถูกตั้งครบ โดยไม่พิมพ์ค่า secret ลง log
- ยืนยันว่า production queue ว่างตาม deploy runbook ปกติ

## Payment smoke test ที่ต้องทำก่อนเปิด cohort

ใช้ Stripe test mode บน environment ที่รับ webhook ได้จริง และบันทึก session ID ของแต่ละกรณี:

1. PRO รายเดือนด้วยบัตร: หน้า Settings ต้องขึ้น “กำลังยืนยัน” ก่อน และขึ้น “ชำระเงินสำเร็จ” หลัง Payment เป็น `PAID` เท่านั้น
2. BUSINESS รายปีด้วยบัตร: tier, วันหมดอายุ และ Hero Script access ต้องตรงกัน
3. PRO รายปีด้วย PromptPay: `checkout.session.completed` ที่ยังไม่ paid ต้องไม่เปิดสิทธิ์; เปิดเมื่อ `async_payment_succeeded` มาถึงเท่านั้น
4. ยกเลิก checkout: ต้องไม่เปิดสิทธิ์และไม่แสดงข้อความว่าตัดเงินสำเร็จ
5. replay webhook เดิมและส่ง completed/async success ซ้ำ: วันหมดอายุต้องไม่เพิ่มซ้ำ
6. session ของบัญชีอื่นและรายการซื้อเครดิต: confirmation endpoint ต้องไม่ยืนยันการอัปเกรดแผน
7. trial → paid: trial ต้องถูกล้าง และวันแรกของแพ็กเกจเริ่มจากเวลาชำระ
8. webhook ล่าช้าเกิน 15 วินาที: UI ต้องแสดงสถานะล่าช้า มีปุ่มตรวจซ้ำ และบอกให้ติดต่อ Support เมื่อเกิน 5 นาที
9. ส่วนลด 100%: session ที่ Stripe ยืนยัน `no_payment_required` และยอดรวม 0 ต้องเปิดสิทธิ์ได้ โดยไม่ค้าง PENDING
10. บัญชี PromptPay/one-time ที่ยังมีวันคงเหลือ: checkout แบบบัตรต้องถูกบล็อกอย่างสุภาพ ส่วนการต่อ PromptPay ต้องยังเพิ่มวันต่อจากวันหมดอายุเดิม

หลังทดสอบ ให้ตรวจข้อมูล 3 จุดตรงกัน: `User` entitlement, `Payment.status=PAID` พร้อม `periodDays>0`, และ `resolveHeroScriptAccess(...).cohort=paid`

## ลำดับเปิดใช้งาน

1. Deploy โค้ดโดยให้ rollout flags ปิดอยู่ก่อน
2. Smoke test ด้วย allowlist ของทีม
3. ตั้งค่า:

   ```text
   HERO_SCRIPT_PAID_ENABLED=1
   HERO_SCRIPT_PUBLIC_PREVIEW=1
   HERO_SCRIPT_TRIAL_PERCENT=0
   HERO_SCRIPT_FREE_PERCENT=0
   ```

4. ตรวจสมาชิกแบบชำระเงินจริงทั้ง 11 บัญชี: เข้า feature ได้; บัญชี free/trial เห็นเมนูและ Preview แต่เรียก API ไม่ได้
5. เฝ้าดูอย่างน้อย 5–7 วันก่อนถือว่า paid cohort พร้อม 100%
6. เมื่อ production live และ smoke ผ่านแล้วเท่านั้น จึงประกาศอัปเดต:

   ```bash
   cd /var/www/ai-content
   RUN=1 npx tsx scripts/publish-v1.5.0-hero-script.ts
   ```

   หากไม่ใส่ `RUN=1` สคริปต์จะเป็น dry-run แบบอ่านอย่างเดียว เมื่อ apply แล้วจะสร้าง pinned banner ที่แสดงข้ามหน้าหลักของระบบพร้อมลิงก์เข้า Hero Script

## เกณฑ์ Go / No-go สำหรับ paid 100%

Go เมื่อครบทุกข้อ:

- ไม่มี Sev-1/Sev-2 และไม่มี payment/access mismatch ที่ค้างเกิน 5 นาที
- checkout ที่ Stripe ยืนยัน paid แล้วเปิดสิทธิ์ครบ 100% ใน cohort ทดสอบ
- ไม่มีการเปิดสิทธิ์จาก PENDING, session คนอื่น หรือ credit-pack payment
- generate/save/reopen/edit/send-to-editor critical journey ผ่านทั้ง desktop และ mobile
- error rate ของ generate/regen อยู่ใน baseline ปกติ และไม่มี quota ถูกกินถาวรเมื่อ provider ล้มเหลว
- ประกาศ, in-page quick start และ `/docs/hero-script` แสดงผลและลิงก์ถูกต้อง

No-go ทันทีเมื่อมีการตัดเงินซ้ำ, paid แล้วสิทธิ์ไม่มา, สิทธิ์ข้ามบัญชี, ข้อมูลสคริปต์ข้ามบัญชี, หรือข้อมูลสูญหาย

## Monitoring และ Support

- ตรวจ Payment `PENDING` ที่เกิน 5 นาที, Stripe webhook failures และ notification errors
- แยก funnel `preview → upgrade → paid confirmation → first script → send to editor`
- Ticket เรื่อง payment ต้องขอเพียงอีเมลบัญชี, เวลาโดยประมาณ, tier และ session/ใบเสร็จถ้ามี ห้ามขอเลขบัตรหรือข้อมูลลับ
- ตอบผู้ใช้ว่า “กำลังตรวจสอบ” จนกว่าจะเห็น `PAID` และ entitlement จริง ห้ามยืนยันจากภาพหน้า success เพียงอย่างเดียว

## Rollback

หาก Hero Script มี incident แต่ระบบหลักยังปกติ ให้ปิดตามลำดับ:

```text
HERO_SCRIPT_TRIAL_PERCENT=0
HERO_SCRIPT_FREE_PERCENT=0
HERO_SCRIPT_PAID_ENABLED=0
HERO_SCRIPT_PUBLIC_PREVIEW=0
```

อย่าลบ Payment หรือ Script เพื่อ rollback. หาก incident เกี่ยวกับการชำระเงินจริง ให้หยุด checkout ตาม incident procedure และตรวจ Stripe กับฐานข้อมูลก่อนแก้สิทธิ์รายบัญชี

## Free/trial experiment

ยังไม่เปิดพร้อม paid launch. หลัง paid cohort ผ่าน 5–7 วัน ค่อยเริ่ม trial 10% แล้ว 25% และ free 5% แบบ deterministic cohort โดยดู conversion เป็น Subscription, generation success, support rate และต้นทุนต่อ subscriber ก่อนขยาย
