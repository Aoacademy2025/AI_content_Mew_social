# STATUS — สถานะจริงของโปรเจกต์
> อัปเดต: 2026-06-07 · เอกสารนี้สะท้อน "งานจริง" (PRD.md = วิชันเดิม บางส่วนล้าสมัย) · ดู [CLAUDE.md](CLAUDE.md) + [docs/HANDOFF-2026-06-07.md](docs/HANDOFF-2026-06-07.md) ประกอบ

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

## 🔄 Payment vertical (Mew) — ทั้งหมด LIVE บน prod แล้ว (06-07)
- ✅ **Subscription LIVE (06-05)** — บัตร auto-renew + PromptPay one-time + billing portal + webhook lifecycle (config อยู่ใน DB `SiteConfig` ไม่ใช่ `.env`)
- 🟢 **Pricing redesign (LIVE 06-07, PR #10)** — หน้า `/pricing` ใหม่ (rich) + founding bar/ราคา founding บนการ์ดรายปี + coupon box
- 🟢 **Sale page (LIVE 06-07, PR #11)** — homepage `/` = evergreen sale page (ราคาสดจาก SiteConfig + founding bar read-only) · `src/components/marketing/pricing-toggle.tsx`
- 🟢 **Free trial (LIVE 06-07, PR #9)** — สมัครได้ PRO **7 วัน**อัตโนมัติ (ไม่ใช้บัตร, grant ตอน signup/lazy-create) → หมด revert FREE + prompt อัปเกรด (cron `trial-expiry` 8โมง) · 1 trial/คน · คอลัมน์ `User.trialStartedAt/trialEndsAt`
- 🔥 **Founding-100 — LAUNCHED LIVE (06-07)** — coupon `FOUNDING100` (DISCOUNT 50% / forever / maxUses 100) สร้างจริงบน Stripe+DB แล้ว · 100 คนแรกที่อัป annual ได้ 50% ตลอดชีพ · atomic seat counter (race-safe) · **founding bar โชว์ "เหลือ N/100" บนหน้าแรก (public)** · cron `founding-sweep` (ทุก 15น.) ปล่อยที่นั่งค้าง
  - ⚠️ founding bar บน `/pricing` โชว์เฉพาะคน**ล็อกอิน** (client-fetch `/api/founding/status` ที่ไม่ใช่ public route) · หน้าแรกโชว์ทุกคน (server-rendered)
- ⏸️ **Claim/allowlist page** — รอ center DB API เช็ค member (Mew กำลังทำ) → จะเรียก `grantTrial(id,30)` + ออกโค้ด
- ⏸️ **Onboarding ตั้ง API key (BYOK)** — wao1234 ทำระบบ api-key บน main
- ⏳ follow-ups: เทสจ่ายจริง+refund · OG image (`public/og.png`) ให้ sale page · ทำ `/api/founding/status` เป็น public ถ้าอยากให้ /pricing bar โชว์คน logged-out

## ⚙️ Cron (PM2 บน prod — รันอยู่, pm2 save แล้ว)
- `trial-expiry` (8โมง) · `founding-sweep` (ทุก 15น.) · `renewal-reminders` (9โมง — เตือน manual-renew 14/7/1 วันก่อนหมด) · `cleanup-videos` = ตั้งใจปิดไว้
- เปิด cron: `export CRON_SECRET="$(grep ^CRON_SECRET= .env | cut -d= -f2-)"` แล้ว `pm2 start ecosystem.config.js --only <X> --update-env && pm2 save`

## ⚠️ Known issues (infra — ทีม render / wao1234)
- **Render ไม่มี global queue** → คนเรนเดอร์พร้อมกันเยอะ = OOM/crash (ปลอดภัย ~3-4 งานพร้อมกัน) → ต้องทำ **queue**
- **Clip cap PRO/BUSINESS ไม่ถูก enforce** (เฉพาะ FREE) → paid render ได้ไม่จำกัด → โหลดไม่มีเพดาน
- **VPS ตัวเดียว ไม่มี GPU** = คอขวด render ตอน scale (GPU ไม่ช่วย Remotion → ใช้ CPU/Lambda)
- **BYOK** = ผู้ใช้ต้องตั้ง key เอง → adoption friction → ต้องทำ onboarding ให้ดี

## 🗺️ Roadmap (ย่อ)
1. **Phase 1:** ราคา/subscription/PromptPay + หน้าราคาใหม่ + Quick Wins (CRO) — ✅ เสร็จ
2. **Phase 2:** claim page + ส่วนลดกลุ่ม + trial + เตือนต่ออายุ — ✅ trial+เตือนต่ออายุเสร็จ · ⏸️ claim page รอ center DB API
3. **Phase 3:** หน้า launch + เปิดแคมเปญ founding — ✅ founding เปิด live แล้ว (06-07)
4. **Infra (ทีม render):** render queue + enforce caps + แผน scale
