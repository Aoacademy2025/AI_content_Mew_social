# STATUS — สถานะจริงของโปรเจกต์
> อัปเดต: 2026-06-09 · prod app deploy ล่าสุดที่ Codex verify = `4430835` · support tickets ล่าสุดปิดครบแล้ว · product update `v0.4.3` published · เอกสารนี้สะท้อน "งานจริง" (PRD.md = วิชันเดิม บางส่วนล้าสมัย) · ดู [CLAUDE.md](CLAUDE.md) + [docs/HANDOFF-2026-06-09.md](docs/HANDOFF-2026-06-09.md) ประกอบ

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
- **Support bugfix release (LIVE 06-09, `161e393` → `4430835`)** — แก้ Gemini/API key + keyword empty-state + transcribe/subtitle duration guard + timeline/playhead sync + zoom 100% + spacebar play/pause + notification click; support tickets ชุดนี้ปิดครบแล้ว
- Coupon system · Admin · Notifications · Support tickets
- First-party telemetry + Admin Insights (`/admin/insights`) — เก็บ page view, frontend error, Web Vitals, render pipeline/performance event เพื่อใช้วิเคราะห์ drop-off/error/resource จริง
- Deploy: Hostinger VPS + PM2 + Nginx · render ด้วย Remotion/ffmpeg บนเครื่อง
- **OmniVoice (canary proposed 07-20):** managed audio-only worker แยก KVM2; video ยัง render บน prod host เดิม. ค่าเริ่มต้นปิด, เปิดเฉพาะ account allowlist, จำกัดสคริปต์/คิว/AI-audio quota ตาม ADR 0003; Gemini/ElevenLabs เดิมไม่เปลี่ยน

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
- `trial-expiry` (8โมง) · `founding-sweep` (ทุก 15น.) · `reconcile-processing` (ทุก 15น. — complete วิดีโอ `PROCESSING` ค้างที่มี output แล้ว) · `renewal-reminders` (9โมง — เตือน manual-renew 14/7/1 วันก่อนหมด) · `cleanup-videos` (ตี 3 — ลบ expired videos + cancel stale PENDING payments)
- หมายเหตุ PM2: cron apps เป็น one-shot + `autorestart: false` จึงขึ้น `stopped` หลังรันจบ แต่ schedule ยังถูก save ใน PM2 แล้ว
- `cleanup-videos` เปิดกลับแล้วใน session นี้ และ hotfix path `/api/renders/...` → `public/renders/...` แล้ว; smoke ล่าสุดลบ expired videos ได้ 2 รายการ
- เปิด cron: `export CRON_SECRET="$(grep ^CRON_SECRET= .env | cut -d= -f2-)"` แล้ว `pm2 start ecosystem.config.js --only <X> --update-env && pm2 save`

## ⚠️ Known issues (infra — ทีม render / wao1234)
- **Render queue ยังเป็น in-memory guard** → กัน OOM/งานซ้ำได้ระดับหนึ่ง แต่ restart แล้ว queue ไม่ persist และยังไม่มี admin queue view → ต้องทำ persistent queue/worker ต่อ
- **Next production build ใช้ memory สูงมาก** → 06-09 build บน VPS เคยถูก OOM kill; เพิ่ม persistent swap `/swapfile-codex-build-extra` 24GB แล้ว + harden deploy script ให้ retry เมื่อ `.next/BUILD_ID` หาย; watch disk usage (หลังเพิ่ม swap เหลือประมาณ 41GB)
- **Clip cap enforce แล้ว** ผ่าน `reserveClipUsage`: FREE 2, PRO 100, BUSINESS 300 ต่อ 30 วัน; ยังไม่มี global render queue
- **VPS ตัวเดียว ไม่มี GPU** = คอขวด render ตอน scale (GPU ไม่ช่วย Remotion → ใช้ CPU/Lambda)
- **BYOK เป็นค่าเริ่มต้น** = ผู้ใช้ต้องตั้ง key เอง → adoption friction → ต้องทำ onboarding ให้ดี; OmniVoice เป็น managed exception เดียวและยังอยู่ canary

## 🎯 ซับเป๊ะจาก TTS timing — LIVE บน prod (06-12, PRs #35-#39)
- **สถาปัตยกรรมใหม่**: เวลาซับมาจากขั้นสร้าง TTS โดยตรง (ไม่ใช่ AI ฟังเสียงแล้วเดา — ต้นเหตุ saga ซับเพี้ยนคลิปยาว #27-#34) → ซับตรงเสียงเป๊ะระดับเลขคณิตทุกความยาวคลิป + pipeline เร็วขึ้น 1 step (ข้าม transcribe)
- ชิ้นส่วน: `src/lib/tts-timing.ts` (pure lib) · `tts-gemini` segmented PCM + `timing` + silencedetect · `tts` (ElevenLabs) `/with-timestamps` + char-level merge · editor ใช้ timing เมื่อมี (`_components/tts-timing-captions.ts`) · `/api/videos/split-script` ตัดการ์ด viral แบบ text-only (LLM เลือกจุดตัดได้ แต่แก้ข้อความไม่ได้แม้ตัวเดียว — server validate)
- **fail-open ทุกชั้น**: ท่อน TTS พัง→single call เดิม · timing เพี้ยน→transcribe เดิม · split-script พัง→การ์ดประโยค — ผู้ใช้ไม่มีทาง "ใช้ไม่ได้" จากฟีเจอร์นี้
- transcribe เดิม = fallback ถาวรสำหรับเสียง avatar/อัปโหลด (guards #32-#34 คงอยู่ครบ)
- เทส: `verify-tts-timing*.ts`, `verify-tts-gemini-segmented.ts`, `verify-split-snap.ts` + live QA 2 ชั้นทุก PR (บันทึกใน PR #36-#38 comments)
- จุดเฝ้าระวัง: free-tier Gemini key บนคลิปยาว (จำนวน TTS call เพิ่มตามท่อน — มี adaptive chunk size คุม) + งบเวลา segmented 240s บนคลิป 6 นาที → ถ้า log เจอ `fail-open` บ่อยให้ขยับ `CHUNK_CHARS_LONG_SCRIPT` 350→450

## 🐞 Video editor bug status (06-08)
- ✅ **Mew BGM/subtitle preview bug closed** — deployed `b6bf434` → `5e78754` → `f720314` → `014c6e2` → `e69f589`; final UX: Render preview first, edit subtitles live, Burn & Download only at the end
- ✅ **Customer support bug batch closed (06-09)** — deployed `161e393` + deploy hardening `6ba829a`/`4430835`; closed all 7 open tickets from bunchar/sumawadee; `/updates` has published `v0.4.3`
- ⏳ **Customer backlog: `kapokja@gmail.com`** — paid annual PRO customer; not a payment issue. Tomorrow continue root fixes for avatar half-body, stale render jobs, and customer-specific recovery/backfill. Full audit notes in [docs/HANDOFF-2026-06-08.md](docs/HANDOFF-2026-06-08.md)

## 🗺️ Roadmap (ย่อ)
1. **Phase 1:** ราคา/subscription/PromptPay + หน้าราคาใหม่ + Quick Wins (CRO) — ✅ เสร็จ
2. **Phase 2:** claim page + ส่วนลดกลุ่ม + trial + เตือนต่ออายุ — ✅ trial+เตือนต่ออายุเสร็จ · ⏸️ claim page รอ center DB API
3. **Phase 3:** หน้า launch + เปิดแคมเปญ founding — ✅ founding เปิด live แล้ว (06-07)
4. **Infra (ทีม render):** render queue + แผน scale
