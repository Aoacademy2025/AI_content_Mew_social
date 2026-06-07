# STATUS — สถานะจริงของโปรเจกต์
> อัปเดต: 2026-06-08 · prod app deploy ล่าสุดที่ Codex verify = `e69f589` · repo main มี commit ใหม่หลัง prod deploy (ดู handoff) · เอกสารนี้สะท้อน "งานจริง" (PRD.md = วิชันเดิม บางส่วนล้าสมัย) · ดู [CLAUDE.md](CLAUDE.md) + [docs/HANDOFF-2026-06-08.md](docs/HANDOFF-2026-06-08.md) ประกอบ

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
- **Video editor preview/export flow fixed (LIVE 06-08, `e69f589`)** — Render หยุดที่ editable preview ที่มี voice/avatar+BGM + live subtitle overlay; Burn Subtitles ใช้เป็น final export เท่านั้น; Mew test ผ่าน 2 clips แล้ว
- Coupon system · Admin · Notifications · Support tickets
- First-party telemetry + Admin Insights (`/admin/insights`) — เก็บ page view, frontend error, Web Vitals, render pipeline/performance event เพื่อใช้วิเคราะห์ drop-off/error/resource จริง
- Deploy: Hostinger VPS + PM2 + Nginx · render ด้วย Remotion/ffmpeg บนเครื่อง

## 🔄 Payment vertical (Mew) — ทั้งหมด LIVE บน prod แล้ว (06-07)
- ✅ **Subscription LIVE (06-05)** — บัตร auto-renew + PromptPay one-time + billing portal + webhook lifecycle (config อยู่ใน DB `SiteConfig` ไม่ใช่ `.env`)
- 🟢 **Pricing redesign (LIVE 06-07, PR #10)** — หน้า `/pricing` ใหม่ (rich) + founding bar/ราคา founding บนการ์ดรายปี + coupon box
- 🟢 **Sale page (LIVE 06-07, PR #11 + hotfix `a5f7077`)** — homepage `/` = evergreen sale page (ราคาสดจาก SiteConfig + founding bar read-only) · pricing card แสดง Founding annual price public แล้ว: PRO ฿2,995/ปี, BUSINESS ฿4,950/ปี · `src/components/marketing/pricing-toggle.tsx`
- 🟢 **Free trial (LIVE 06-07, PR #9)** — สมัครได้ PRO **7 วัน**อัตโนมัติ (ไม่ใช้บัตร, grant ตอน signup/lazy-create) → หมด revert FREE + prompt อัปเกรด (cron `trial-expiry` 8โมง) · 1 trial/คน · คอลัมน์ `User.trialStartedAt/trialEndsAt`
- 🔥 **Founding-100 — LAUNCHED LIVE (06-07)** — coupon `FOUNDING100` (DISCOUNT 50% / forever / maxUses 100) สร้างจริงบน Stripe+DB แล้ว · 100 คนแรกที่อัป annual ได้ 50% ตลอดชีพ · atomic seat counter (race-safe) · **founding bar/ราคา founding โชว์ public** ทั้งหน้าแรกและ `/pricing` ผ่าน `/api/founding/status`
  - prod smoke ล่าสุด: `/api/founding/status` = active, remaining **99/100**, percentOff 50
- ⏸️ **Claim/allowlist page** — รอ center DB API เช็ค member (Mew กำลังทำ) → จะเรียก `grantTrial(id,30)` + ออกโค้ด
- ⏸️ **Onboarding ตั้ง API key (BYOK)** — wao1234 ทำระบบ api-key บน main
- ⏳ follow-ups: เทสจ่ายจริง+refund · OG image (`public/og.png`) ให้ sale page

## ⚙️ Cron (PM2 บน prod — รันอยู่, pm2 save แล้ว)
- `trial-expiry` (8โมง) · `founding-sweep` (ทุก 15น.) · `renewal-reminders` (9โมง — เตือน manual-renew 14/7/1 วันก่อนหมด) · `cleanup-videos` (ตี 3 — ลบ expired videos + cancel stale PENDING payments)
- หมายเหตุ PM2: cron apps เป็น one-shot + `autorestart: false` จึงขึ้น `stopped` หลังรันจบ แต่ schedule ยังถูก save ใน PM2 แล้ว
- `cleanup-videos` เปิดกลับแล้วใน session นี้ และ hotfix path `/api/renders/...` → `public/renders/...` แล้ว; smoke ล่าสุดลบ expired videos ได้ 2 รายการ
- เปิด cron: `export CRON_SECRET="$(grep ^CRON_SECRET= .env | cut -d= -f2-)"` แล้ว `pm2 start ecosystem.config.js --only <X> --update-env && pm2 save`

## ⚠️ Known issues (infra — ทีม render / wao1234)
- **Render ไม่มี global queue** → คนเรนเดอร์พร้อมกันเยอะ = OOM/crash (ปลอดภัย ~3-4 งานพร้อมกัน) → ต้องทำ **queue**
- **Clip cap enforce แล้ว** ผ่าน `reserveClipUsage`: FREE 2, PRO 100, BUSINESS 300 ต่อ 30 วัน; ยังไม่มี global render queue
- **VPS ตัวเดียว ไม่มี GPU** = คอขวด render ตอน scale (GPU ไม่ช่วย Remotion → ใช้ CPU/Lambda)
- **BYOK** = ผู้ใช้ต้องตั้ง key เอง → adoption friction → ต้องทำ onboarding ให้ดี

## 🐞 Video editor bug status (06-08)
- ✅ **Mew BGM/subtitle preview bug closed** — deployed `b6bf434` → `5e78754` → `f720314` → `014c6e2` → `e69f589`; final UX: Render preview first, edit subtitles live, Burn & Download only at the end
- ⏳ **Customer backlog: `kapokja@gmail.com`** — paid annual PRO customer; not a payment issue. Tomorrow continue root fixes for avatar half-body, stale render jobs, and customer-specific recovery/backfill. Full audit notes in [docs/HANDOFF-2026-06-08.md](docs/HANDOFF-2026-06-08.md)

## 🗺️ Roadmap (ย่อ)
1. **Phase 1:** ราคา/subscription/PromptPay + หน้าราคาใหม่ + Quick Wins (CRO) — ✅ เสร็จ
2. **Phase 2:** claim page + ส่วนลดกลุ่ม + trial + เตือนต่ออายุ — ✅ trial+เตือนต่ออายุเสร็จ · ⏸️ claim page รอ center DB API
3. **Phase 3:** หน้า launch + เปิดแคมเปญ founding — ✅ founding เปิด live แล้ว (06-07)
4. **Infra (ทีม render):** render queue + แผน scale
