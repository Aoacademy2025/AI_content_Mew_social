# STATUS — สถานะจริงของโปรเจกต์
> อัปเดต: 2026-06-04 · เอกสารนี้สะท้อน "งานจริง" (PRD.md = วิชันเดิม บางส่วนล้าสมัย) · ดู [CLAUDE.md](CLAUDE.md) ประกอบ

## ภาพรวม
**HERO AI** (studio.heroaiengine.com) — SaaS เปลี่ยนสคริปต์ 1 ชุด เป็นวิดีโอสั้นพร้อมโพสต์อัตโนมัติ (Faceless + AI Avatar + ซับไทย)

## 📊 การใช้งานจริง (ณ 2026-06-04)
- ผู้ใช้: **53** · วิดีโอที่สร้าง: **40** · payment: **13**
- แพ็ก: FREE 43 · PRO 11 · BUSINESS 2
- (ผู้ใช้ที่ใส่ API key เอง: Gemini 19 · HeyGen 8 · ElevenLabs 4 → ส่วนใหญ่ยังตั้ง key ไม่ครบ)

## ✅ มีแล้ว / ใช้งานอยู่
- Auth (Clerk) · 3 แพ็ก FREE/PRO/BUSINESS · Stripe checkout (one-time 30 วัน)
- **Video creator + video editor (timeline)** ด้วย Remotion
- ฟีเจอร์หลัก: AI Avatar (เต็ม/เปิด-ปิด/ไม่มี) · ซับไทยอัตโนมัติ (ยาว/keyword) · B-roll 3-5วิ · โคลนเสียง · เพลง · ตัดต่ออัตโนมัติ
- Coupon system · Admin · Notifications · Support tickets
- Deploy: Hostinger VPS + PM2 + Nginx · render ด้วย Remotion/ffmpeg บนเครื่อง

## 🔄 กำลังทำ (Mew — Payment vertical)
- **ระบบราคาใหม่ + subscription** (บัตร auto-renew + PromptPay จ่ายครั้งเดียว) + **ระบบเตือนต่ออายุ**
- **แคมเปญเปิดตัว** (claim page → Skool/allowlist → โค้ดเฉพาะตัว) + ส่วนลดตามกลุ่ม
- **CRO** หน้าขาย/หน้าราคาใหม่ (3-tier + toggle, ดีไซน์ตาม CI)
- **Onboarding ตั้ง API key** (เพราะ BYOK)
- *(รายละเอียดกลยุทธ์/ตัวเลข อยู่ใน internal spec — ไม่อยู่ใน repo)*

## ⚠️ Known issues (infra — ทีม render / wao1234)
- **Render ไม่มี global queue** → คนเรนเดอร์พร้อมกันเยอะ = OOM/crash (ปลอดภัย ~3-4 งานพร้อมกัน) → ต้องทำ **queue**
- **Clip cap PRO/BUSINESS ไม่ถูก enforce** (เฉพาะ FREE) → paid render ได้ไม่จำกัด → โหลดไม่มีเพดาน
- **VPS ตัวเดียว ไม่มี GPU** = คอขวด render ตอน scale (GPU ไม่ช่วย Remotion → ใช้ CPU/Lambda)
- **BYOK** = ผู้ใช้ต้องตั้ง key เอง → adoption friction → ต้องทำ onboarding ให้ดี

## 🗺️ Roadmap (ย่อ)
1. **Phase 1:** ราคา/subscription/PromptPay + หน้าราคาใหม่ + Quick Wins (CRO)
2. **Phase 2:** claim page + ส่วนลดกลุ่ม + trial + เตือนต่ออายุ
3. **Phase 3:** หน้า launch + เปิดแคมเปญ
4. **Infra (ทีม render):** render queue + enforce caps + แผน scale
