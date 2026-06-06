# STATUS — สถานะจริงของโปรเจกต์
> อัปเดต: 2026-06-05 · เอกสารนี้สะท้อน "งานจริง" (PRD.md = วิชันเดิม บางส่วนล้าสมัย) · ดู [CLAUDE.md](CLAUDE.md) ประกอบ

## ภาพรวม
**HERO AI** (studio.heroaiengine.com) — SaaS เปลี่ยนสคริปต์ 1 ชุด เป็นวิดีโอสั้นพร้อมโพสต์อัตโนมัติ (Faceless + AI Avatar + ซับไทย)

## 📊 การใช้งานจริง (ณ 2026-06-04)
- ผู้ใช้: **53** · วิดีโอที่สร้าง: **40** · payment: **13**
- แพ็ก: FREE 43 · PRO 11 · BUSINESS 2
- (ผู้ใช้ที่ใส่ API key เอง: Gemini 19 · HeyGen 8 · ElevenLabs 4 → ส่วนใหญ่ยังตั้ง key ไม่ครบ)

## ✅ มีแล้ว / ใช้งานอยู่
- Auth (Clerk) · 3 แพ็ก FREE/PRO/BUSINESS · **Stripe subscription + one-time/PromptPay — LIVE (06-05)** (บัตร auto-renew · billing portal · webhook lifecycle)
- **Video creator + video editor (timeline)** ด้วย Remotion
- ฟีเจอร์หลัก: AI Avatar (เต็ม/เปิด-ปิด/ไม่มี) · ซับไทยอัตโนมัติ (ยาว/keyword) · B-roll 3-5วิ · โคลนเสียง · เพลง · ตัดต่ออัตโนมัติ
- Coupon system · Admin · Notifications · Support tickets
- Deploy: Hostinger VPS + PM2 + Nginx · render ด้วย Remotion/ffmpeg บนเครื่อง

## 🔄 Payment vertical (Mew)
- ✅ **subscription LIVE แล้ว (06-05)** — บัตร auto-renew + PromptPay one-time + billing portal + webhook lifecycle (config อยู่ใน DB `SiteConfig` ไม่ใช่ `.env`)
- 🧪 **Founding-100 (code-complete 06-06, branch `mew/founding-100`)** — 100 คนแรกที่อัปเกรดรายปีได้ราคา founding 50% ล็อกตลอดชีพ อัตโนมัติ · atomic seat counter (race-safe) ต่อยอด DISCOUNT coupon (`FOUNDING100`) · ผ่าน unit/concurrency proof (`scripts/verify-founding.ts`) + build · **รอ E2E (Stripe test mode) + deploy** (`npx prisma db push` model `FoundingReservation` บน VPS ก่อน) · spec/plan: `docs/superpowers/{specs,plans}/2026-06-06-founding-100*`
- 🔜 **หน้าขาย/หน้าราคา redesign** + ปุ่ม PromptPay ← งานหลักถัดไป
- 🔜 **แคมเปญเปิดตัว** (claim page → Skool/allowlist → โค้ดเฉพาะตัว) + ส่วนลดตามกลุ่ม
- 🔜 **Onboarding ตั้ง API key** (เพราะ BYOK)
- ⏳ follow-ups: renewal-reminders cron (รอ `CRON_SECRET`) · เทสจ่ายจริง+refund · cancel-at-period-end UI
- *(รายละเอียดกลยุทธ์/ตัวเลข/ขั้นตอน live อยู่ใน internal docs — ไม่อยู่ใน repo)*

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
