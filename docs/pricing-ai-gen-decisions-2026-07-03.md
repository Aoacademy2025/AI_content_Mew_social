# AI Gen Business Model — Decisions (Grilling session 2026-07-03)

สรุปการตัดสินใจจากเซสชัน grill เรื่อง AI image gen / AI video gen / AutoMix / server / เป้า MRR
อ้างอิงฐานตัวเลขจาก `docs/pricing-business-model-2026-06-24.md` + โค้ด `src/lib/credits.ts`
(ระบบนาที+เครดิต LIVE บน prod แล้ว: `MINUTE_QUOTA=1 CREDITS_LIVE=1 MANAGED_GEMINI=1`)

## ภาษากลางที่เคลียร์กันแล้ว

- **80/150 = นาทีเรนเดอร์/เดือน** (PRO/BUSINESS) — ไม่ใช่เครดิต
- **เครดิต = สกุลเงินเติม, 1cr = ฿1** — PRO แถม 50cr/เดือน, BUSINESS 150cr/เดือน (หมดอายุรายเดือน);
  แพ็กซื้อเพิ่ม ฿199→200 / ฿499→540 / ฿999→1,150 (อยู่ได้ ~12 เดือน)

## Decisions

| # | เรื่อง | ตัดสินใจ |
|---|---|---|
| D1 | บทบาทของ AI gen | **ตัวดึง sub/retention ไม่ใช่เครื่องยนต์รายได้ที่สอง** — ตั้งราคาเพื่อ adoption, margin ×2-3 พอ, รายได้หลัก = subscription |
| D2 | Image gen go-live | **Managed** (server kie key = key ที่ admin ใช้อยู่, ย้ายเข้า env) + guardrail แบบ managed-Gemini (เพดาน spend ฝั่ง kie + rate-limit/user + เพดานรูป/job). BYOK เก็บเป็น escape hatch ทีหลัง |
| D3 | โมเดลภาพ + ราคา | 3 ระดับ user-facing: **ถูก 1cr** (โมเดล open-source class บน kie — [verify] เลือกตัวที่ COGS ≤฿0.35-0.5) · **gpt-image-2 3cr = DEFAULT** (มิว rank คุณภาพที่ 1 จากใช้จริง — ต้องสลับ default ในโค้ดจาก nano) · **nano-banana-pro 4cr** (ขั้นสูง). อีก 6 โมเดล = admin-only ต่อไป. **ไม่มีราคาเศษ 0.5cr** (ledger เป็นจำนวนเต็ม) |
| D4 | โมเดลวิดีโอ + ราคา | เปิดตัวด้วย **Seedance 1.5 pro ตัวเดียว, 5วิ เท่านั้น, 10cr/คลิป** (ตัด 10/15วิ — window 3-5วิ ไม่มีที่วาง). ตัวถูก (Wan/Seedance-lite class ~5cr) = ทดสอบใน benchmark ไว้รอเฟสถัดไป ถ้าคุณภาพผ่านตามิว |
| D5 | เห็นก่อนจ่าย | **Render Receipt บังคับทุกเรนเดอร์ step 2** ไม่ว่า b-roll แบบไหน: นาทีที่ใช้+คงเหลือ (แสดงเป็น "รวมในแพ็กเกจ" ไม่ใช่ "จ่าย") · เครดิต AI gen ที่จะหัก · เคสนาทีหมด→แจ้ง overflow 2cr/นาที ก่อนหัก (เลิกหักเงียบ) · อวตารระบุ "คิดผ่าน HeyGen ของคุณ" · ติดป้ายประมาณการ, ยอดจริงจากเสียง TTS จริง |
| D5.1 | AutoMix UX | **Mix preset 3 ปุ่ม** แทน slider: ฟรีล้วน (0cr) / ผสม AI แนะนำ (3:2:1, ~6-9cr/คลิป) / AI เต็มที่ (~25-40cr). **Default ของ PRO/BIZ = ผสม AI แนะนำ** (เครดิตแถมมีไว้ให้ลอง). เฟสถัดไป: **อัปเกรดรายช่อง**บน timeline (คลิกช่อง b-roll → เจนภาพ 3cr / วิดีโอ 10cr แทนช่องนั้น — re-render base ต้องไม่คิดนาทีซ้ำ ใช้แพทเทิร์น ChargedClip) |
| D6 | ลำดับปล่อยของ | **KVM8 (8c/32GB) → ขึ้น RENDER_CONCURRENCY + worker ขนาน → flip editor v2 + cutaway → เปิด managed image gen → benchmark วิดีโอ → เปิดวิดีโอ AI** — เจน AI ไม่กิน VPS (วิ่งบน kie); KVM8 มีไว้เพื่อ Remotion render ล้วน ๆ |
| D7 | Acquisition สู่ MRR | ช่องทาง: **คลาสสอน + community เป็นหัวหอก, ยิงแอด, เปิด Affiliate** — math: ฿500k ≈ 610-835 subs (เครดิต top-up ช่วยลด ~15%), ฿1M ≈ 1,200-1,700. ⚠️ แอดควรเปิดหลัง activation (ตอนนี้ 10%) ขึ้นเป็น ~25-30% ไม่งั้นเทเงินใส่ funnel รั่ว; Affiliate ต้องมี tracking (ยังไม่มีในระบบ = งาน build แยก) |

## เศรษฐศาสตร์ต่อคลิป (อ้างอิงตอนออกแบบ)

- คลิป 60วิ ≈ 15 b-roll windows → AI ล้วน = 45-60cr (เกือบหมด grant PRO ในคลิปเดียว — ห้ามเป็น default)
- preset "ผสม AI แนะนำ" (3:2:1) ≈ AI 2-3 รูป/คลิป = **6-9cr/คลิป** → PRO grant 50cr ≈ 6-8 คลิป/เดือนฟรี → heavy user เกิน grant = ยอดซื้อแพ็ก
- วิดีโอ AI = accent 1-2 ช่อง/คลิป (10-20cr) ไม่ใช่ปูทั้งคลิป (150cr/นาที — แพงเกิน)

## [verify] / งานที่ต้องทำต่อ (เรียงตาม D6)

1. ~~KVM8 upgrade~~ → ตาม runbook `/private/tmp/heroai-runbook-2026-06-28-deploy-imagegen-kvm8.md` + editor v2 launch runbook
2. **เช็คแคตตาล็อก kie**: โมเดลภาพถูกสุดที่คุณภาพรับได้ + COGS ≤฿0.5 → ผูก cost key `image-budget-1k = 1cr`
3. **สลับ default image model** nano-banana-pro → gpt-image-2 (โค้ด + admin UI)
4. **ย้าย kie key จาก BYOK admin → server env** + guardrails (spend cap ฝั่ง kie dashboard, rate-limit, cap รูป/job) + ปลด gate admin→paid
5. **Render Receipt** ใน editor v2 step 2 (นาที + เครดิต + overflow warning)
6. **Mix preset 3 ปุ่ม** + default "ผสม AI แนะนำ" สำหรับ paid
7. **Benchmark วิดีโอ**: Seedance 1.5 pro ~10 คลิป (เวลาเฉลี่ย/แย่สุด, fail rate, 9:16) + โมเดลถูก 1 ตัวเทียบ — เกิน ~3 นาที/คลิป = ต้องคิด UX ใหม่
8. **สร้าง video gen path** (net-new: kie video model + stitch เข้า window) + `video-seedance-5s = 10cr`
9. เฟสถัดไป: อัปเกรดรายช่องบน timeline + budget video tier (ถ้า benchmark ผ่าน) + Affiliate tracking
