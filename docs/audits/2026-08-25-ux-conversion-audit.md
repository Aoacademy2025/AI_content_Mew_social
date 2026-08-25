# UX / Conversion Audit — HERO AI Creator Studio

**วันที่:** 2026-08-25 · **ผู้ทำ:** Claude (Fable 5) ตามคำสั่ง Mew · **สถานะ:** DELIVERED — รอ Mew เคาะข้อเสนอกลุ่ม "ซ่อน/ตัด" ก่อนเปิด issue ชุดนั้น

> **North Star (ตกลงกันในเซสชัน):** trial → paid เป็น **Stripe recurring subscription** (รายเดือน/รายปี) · **Activation** = Burn/Export สำเร็จครั้งแรก · optimize เพื่อ "กลุ่มที่จ่ายอยู่แล้ว + คนที่เหมือนพวกเขา" ก่อน
> **Constraints ที่ล็อก:** ราคา tier, BYOK policy, managed exceptions (ADR 0002/0003/0008) — ไม่แตะ. "ลดฟีเจอร์" = ซ่อน/ย้าย Advanced/เปลี่ยน default ได้; "ตัดทิ้ง" เฉพาะที่ไม่มีคนจ่ายใช้ใน 30 วัน + มี maintenance cost ชัด

ภาคผนวก (รายละเอียดเต็ม): [A prod funnel data](./2026-08-25-ux-conversion-audit/A-prod-funnel-data.md) · [B ticket themes](./2026-08-25-ux-conversion-audit/B-ticket-themes.md) · [C numbers review (customer + admin)](./2026-08-25-ux-conversion-audit/C-numbers-review.md) · [D walkthrough friction log](./2026-08-25-ux-conversion-audit/D-walkthrough-friction-log.md) · [E mobile audit](./2026-08-25-ux-conversion-audit/E-mobile-audit.md)

---

## 0. Executive summary — 5 ตัวเลข 5 การกระทำ

**5 ตัวเลขที่ต้องจำ (ผู้ใช้ภายนอกที่สมัครตั้งแต่ launch 07-18 → 08-25, n = 448):**

| | ตัวเลข | ความหมาย |
|---|---|---|
| 1 | **81% สมัครแล้วไม่เคยเริ่มทำคลิป** (363/448) — 89.5% ของกลุ่มนี้มี session เดียว | ปัญหาไม่ใช่ traffic แต่คือ 60 วินาทีแรกหลัง login |
| 2 | **มี stock key → 65.5% เริ่มทำคลิป · ไม่มี key → 2.1%** | onboarding modal ขอ Pexels/Pixabay "จำเป็น" คือกำแพงจริง — ทั้งที่ **ระบบเรนเดอร์ได้โดยไม่มี key** (พิสูจน์ด้วย walkthrough วันนี้) |
| 3 | **trial หมดอายุ 383 คน → จ่ายภายใน 14 วัน 3 คน (0.8%)** | วันหมด trial ไม่ทำหน้าที่ paywall เลย (ไม่มี pre-expiry email, expired ยัง render ได้) |
| 4 | **30% ของคนจ่าย (7/23) ไม่เคยทำคลิปเลย · 11/23 จ่ายภายใน 24 ชม.** | การซื้อตอนนี้ขับด้วย sale page/community/Founding ไม่ใช่ product usage → คนกลุ่มนี้คือ churn risk ตอนต่ออายุ |
| 5 | **จ่ายแล้วทั้งหมด 24 คน / recurring active 8 คน / MRR-ish น้อยมาก** — และ **0 ticket บ่นว่า "แพง"** | objection ทั้งหมดคือ "งงสิทธิ์/กลัวเสียนาที/เรนเดอร์ไม่ผ่านไม่รู้ทำไม" ไม่ใช่ราคา |

**5 การกระทำที่ให้ผลมากสุด (เรียงตาม impact ÷ effort):**

1. **ทิ้ง key-gate ในวันแรก** — แทน onboarding modal ด้วย "สร้างคลิปแรกเลย (ไม่ต้องตั้งค่า)" และย้าย Pexels/Pixabay ไปเป็น *optional upgrade ของ B-roll* หลังคลิปแรก (§7.1 P0-1)
2. **แก้ dead-end ตอนโควต้าหมด** — `useV2Job.ts` เทียบ `d.error === "quota_exceeded"` ผิด type → user เห็น `[object Object]` แทนปุ่มอัปเกรด (§7.1 P0-2)
3. **ทำให้วันหมด trial เป็น moment** — pre-expiry email/notification วันที่ 5 + วันสุดท้าย, "คลิปของคุณจะถูกลบใน 3 วัน", และหยุด cron `renewal-reminders` ที่ส่ง "ต่ออายุ" ให้คน trial (§7.1 P0-3)
4. **ตัวเลขเดียวก่อนคลิปแรก** — ซ่อน credits / สิทธิ์ภาพ / "80 นาที" ทั้งหมดจนกว่าจะ export คลิปแรกหรือเป็น PRO จ่ายแล้ว; ตอนนี้ trial เห็น 6 ตัวเลข 4 หน่วยใน 60 วินาทีแรก (§7.2)
5. **ติด telemetry funnel เงิน 15 events** (signup, trial_expired, paywall_shown, checkout_started/completed, export_completed, quota_hit…) — ไม่ต้องแก้ schema — เพื่อให้ audit รอบหน้าวัดผลของ 1–4 ได้ (§8)

---

## 1. วิธีการ + ข้อจำกัดของข้อมูล

| แหล่ง | ทำอะไร |
|---|---|
| prod SQLite (read-only, `sqlite3 -readonly`) | funnel 10 ขั้น, segment (plan/feature/refCode), 24 paid journeys รายคน, failure, coupon, retention — ภาคผนวก A |
| `TelemetryEvent` (first-party, ~260k rows ตั้งแต่ 06-07) | page_viewed / editor_opened / paywall events ที่มี |
| `SupportTicket` 100 ใบใน window (17 คน) | จัด 13 ธีม UX — ภาคผนวก B |
| โค้ด (root checkout `main`) | review ทุกตัวเลขที่ลูกค้าเห็น + admin insights — ภาคผนวก C |
| walkthrough บน prod ด้วยบัญชี `duckyhero+uxaudit@gmail.com` (Mew สมัครให้) | landing → register → dashboard → editor → render → export → convert prompt → Stripe checkout (หยุดก่อนจ่าย) — ภาคผนวก D |

**Caveats ที่กระทบการตีความ**
- Window W = สมัคร ≥ 2026-07-18 00:00 BKK (รวม launch day 107 คน) ไม่รวม `@aoacademy` และบัญชี audit
- ไม่มี GA/PostHog/session recording; ไม่มี event signup / checkout / onboarding → ขั้นเหล่านั้น *อนุมาน* จาก DB
- `editor_step2_reached` เพิ่งมีตั้งแต่ 08-10 → ขั้นนี้ under-count; `onboardingDismissedAt` ถูก stamp อัตโนมัติตอน signup 63% → ใช้วัด dismiss ไม่ได้
- `Video` table มีแค่ ~18% ของ job ที่ done → ใช้ `VideoJob.status='done'` เป็น "ได้คลิป", `RenderJob type=BURN DONE` เป็น Activation
- `Payment.status='FAILED'` = checkout ที่ถูกทิ้ง/หมดอายุ ไม่ใช่บัตรถูกปฏิเสธ
- คนจ่ายทั้งหมด 24 (23 ภายนอก) → ฝั่ง paid เป็นการอ่านรายคน ไม่ใช่สถิติ
- Stripe MCP ต้องการ OAuth จาก Mew — ไม่ได้ใช้; ใช้ field ที่ sync ใน DB แทน (`subStatus`, `stripeSubscriptionId`, `Payment`)

---

## 2. Funnel — หลุดตรงไหน

### 2.1 Window W (n = 448)

| # | ขั้น | คน | % สมัคร | % ขั้นก่อน | median จากสมัคร |
|---|---|---|---|---|---|
| 0 | สมัคร | 448 | 100 | – | – |
| 1 | เปิด editor (วันเดียวกัน) | 267 | 59.6 | 59.6 | ~3 นาที |
| 2 | กลับมาอีกวัน | 129 | 28.8 | – | 1.2 วัน |
| 3 | สร้าง VideoJob | 85 | 19.0 | 31.8 ของ editor | ~70 นาที |
| 4 | VideoJob done (ได้คลิป preview) | 73 | 16.3 | 85.9 | ~2 ชม. |
| 5 | **Export/Burn สำเร็จ (Activation)** | 40 | **8.9** | 54.8 | 0.7 วัน |
| 6 | จ่ายเงิน (any) | 9 | 2.0 | 22.5 | 2.4 ชม. |
| 7 | **Stripe recurring** | 4 | **0.9** | 44.4 | – |

ทั้งประวัติ (n = 1,074): 14.2% เริ่ม · 10.5% export · 2.1% จ่าย · 0.7% recurring — สัดส่วนเดียวกัน ⇒ ปัญหาเป็นโครงสร้าง ไม่ใช่ช่วงเวลา

### 2.2 ขั้นที่หลุด + สาเหตุที่หลักฐานชี้

| ขั้นที่หลุด | ขนาด | หลักฐาน | สาเหตุที่น่าจะใช่ |
|---|---|---|---|
| **สมัคร → เริ่มทำคลิป** | 363 คน (81%) | 89.5% session เดียว · 50% เปิด editor แล้วออก · 44% ดู /pricing แล้วออก · last path = /dashboard 169, /video-editor 49, /settings 42 · **ไม่มี key 329 คน → เริ่ม 7 คน (2.1%)** | (1) modal ขอ API key เป็นสิ่งแรกที่เห็น → ออกไปสมัคร Pexels แล้วไม่กลับ (2) editor เปิดมาเป็นหน้าว่าง ไม่มี sample/AI เขียนให้ (3) dashboard ไม่มี "ขั้นถัดไปของคุณ" (มีแต่ checklist key) (4) 3 banner ซ้อน (trial + update + modal) |
| เริ่ม → ได้คลิป | 12 คน (14%) | fail rate 20.9% ของ jobs · **31.8% ของ job แรก fail** (27 คน; 25 ลองใหม่, 17 สำเร็จ) · top: subtitle quality-gate 57 jobs (25% ของ fail), TTS 429, stock 401 (key ผิด), HeyGen quota | error ไม่ actionable ("ซับไม่ผ่านการตรวจคุณภาพ", "เกิดข้อผิดพลาดที่ไม่คาดคิด") — ticket ธีม #1 ของคนจ่ายเงิน |
| ได้คลิป → Export | 33 คน (45%) | preview เสร็จแล้วแต่ไม่ burn | Post phase โหลด 8 การ์ดซับ + 3 แท็บ + timeline ทีเดียว; ไม่มี nudge "คลิปพร้อมแล้ว กดส่งออก"; ไม่รู้ว่า preview ≠ ไฟล์จริง |
| Export → จ่าย | 31 คน (78%) | FirstClipConvertPrompt ขึ้น 1 ครั้ง (ราคา ฿599 ขัดกับ ฿250 ที่จำจาก landing) · /pricing 243 คนดู → 41 เปิด checkout → 17 จ่าย · **36 checkout ที่ทิ้ง = PRO รายปีเต็มราคา ฿5,990** (default ของหน้า) | (1) ไม่มีเหตุผลต้องจ่ายวันนี้ (trial ยังเหลือ 6 วัน) (2) default checkout = รายปี PromptPay ฿5,990 → เปิดแล้วถอย (3) trial หมด → ไม่มีอะไรเกิดขึ้น (0.8% จ่ายหลังหมด) |
| จ่าย → recurring | 5/9 | 12/23 payer ทั้งหมด = Founding รายปี one-time; recurring แค่ 8 | ทุก surface ยกเว้น convert prompt push รายปี PromptPay "จ่ายครั้งเดียว ไม่ตัดอัตโนมัติ" — **ขัดกับ North Star recurring โดยตรง** |

---

## 3. Segments

**Plan/trial (W):** activation (สร้าง job/คน) — trial active 9.4% · trial-expired FREE 15.1% · **PRO coupon-grant 40.6%** · PRO paid 44.4%. คนที่ได้ PRO ฟรีจากคูปองใช้งานเท่าคนจ่าย แต่ 160 grant → จ่ายทีหลัง 4 (2.5%); CLIP0819 60 คน → 19 ทำคลิป → 0 จ่าย; OPB2026 (event launch) 46 คน → 3 คลิป → 1 จ่าย. **FOUNDING100 = 12/12 จ่าย** (discount coupon ใช้ที่ checkout)

**Feature × paying (ทั้งประวัติ, % ของ 23 payer ที่ใช้):** Hero AI Image 52% · avatar 39% · ElevenLabs 30% · Hero Script 26% · cutaway 22% · B-roll re-render 9% · Hero Voice 0%. Payer ที่ activate แล้ว vs non-payer ที่ activate: HeyGen key 69% vs 18% · avatar 56% vs 9% · Hero AI Image 75% vs 21% · jobs เฉลี่ย 37 vs 7.4 → **คนจ่าย = คนที่ใช้หนักและใช้ฟีเจอร์ "ไม่ต้องออกกล้อง" (avatar) + ภาพ AI** ไม่ใช่ feature ตัดต่อละเอียด

**ช่องทาง:** affiliate refCode 39 คน → 2 คลิป, 0 จ่าย. ไม่มี UTM/source อื่น → วัด organic/live/event แยกไม่ได้ (spike วันที่มี live/คูปอง: 07-18 107 คน activate 7.5%, 08-19 55 คน 18%) — วัน launch activation ต่ำสุด (คนมาดูเยอะ ตั้งใจน้อย)

**Weekday/hour:** เสาร์ 12% vs อาทิตย์/พฤหัส 27%; 18–23น. 24% vs เช้า 14% — คนที่สมัครตอนกลางคืนตั้งใจทำจริง

---

## 4. 24 paid journeys — คนจ่ายเดินทางมาอย่างไร

- **7/23 จ่ายโดยไม่เคยสร้าง job** (P05 BUSINESS ฿9,900, P09, P12, P19, P21, P24, P14) — 5 ใน 7 ไม่มี key ใดๆ → ซื้อเพราะ community/course/Founding; ยังไม่ activate = **churn risk ตอน renew อันดับ 1** (ต้อง onboarding ย้อนหลัง)
- อีก 4 (P02 P03 P04 P06) จ่ายภายใน 3 วันก่อนคลิปแรกเสร็จ; มีแค่ **5 คน (P07 P11 P15 P18 P22) ที่ทำ ≥2 คลิปก่อนจ่าย** — product-led conversion ที่ควรเป็น mainstream ตอนนี้เป็นส่วนน้อย
- 12 = Founding annual (one-time), 8 = Stripe recurring (7 active + 1 canceled), 2 = credit pack เท่านั้น
- Churned: P07 (รายเดือน ยกเลิกหลัง 1 เดือน, ticket 10 ใบใน window — คลิปยาว/avatar/ElevenLabs key fail ซ้ำ) — ต้องติดต่อเชิงรุก
- Dormant-but-paid annual: P03 P05 P12 P19 P21 P24 — 6 คน ไม่มี activity → ตอน renew ปีหน้าจะหาย 6/12 ของ Founding ถ้าไม่ทำอะไร
- Active หนักจริง: P02 P04 P06 P11 P22 — ทุกคนมี HeyGen+ElevenLabs key, ใช้ avatar+AI Image → **ICP = คนที่ทำคลิปประจำ ต้องการพิธีกร AI + ภาพ AI + เสียงโคลน**

---

## 5. เสียงลูกค้า (ticket 100 ใบ / 17 คน) — สรุปจากภาคผนวก B

| อันดับ impact ต่อ conversion | ธีม | # | ใครบ่น |
|---|---|---|---|
| 1 | เรนเดอร์/พากย์/ซับ "ไม่ผ่าน" ไม่บอกสาเหตุ | 16 | **คนจ่าย 11/16** — ธีมเดียวที่คนจ่ายเป็นเสียงหลัก |
| 2 | BYOK key ผิดประเภท / เครดิต provider หมด แล้วระบบไม่บอก (ElevenLabs Key-ID vs secret, restricted key, HeyGen หมด) | 4 (+ซ่อนใน #1) | คนจ่าย 3 |
| 3 | สิทธิ์/แผน/คูปอง/เครดิตสับสน ("คลังแสงได้ระดับไหน", "trial 7 วัน แต่ผมได้ 1 ปีไม่ใช่เหรอ") | 7+3 | คนจ่าย 4 |
| 4 | อัปเกรดรายเดือน→รายปีทำไม่ได้ (billing bug) | 1 HIGH | คนจ่าย — เงินหลุดมือ |
| 5 | แก้ B-roll รายช่วงแล้ว export ได้ไฟล์เก่า | 10 | คนจ่าย 2 |
| 6–11 | Hero AI Image bugs (16), editor polish (17), ซับ (11), Hero Voice (6), avatar (8), ค่าตั้งต้นไม่ persist (3) | | power users ที่ได้ PRO ฟรี |

**ไม่มี ticket ไหนบ่นราคา** — money-tickets ทั้ง 13 ใบคือ "ไม่รู้สถานะสิทธิ์ตัวเอง" และ "กลัวเสียนาที/เครดิตเปล่า"

---

## 6. Walkthrough บน prod (ภาคผนวก D) — จุดเสียดทานที่เห็นด้วยตา

| จุด | สิ่งที่เจอ | ระดับ |
|---|---|---|
| Landing | scroll เร็ว → ผืนว่างใหญ่ 1–2 วิ (reveal-on-scroll) · pricing default รายปี | ⚠️ |
| /register | Clerk form render ช้า ~4 วิ ครึ่งจอว่าง · ฟอร์มอังกฤษบนหน้าไทย · copy โปรโมท Avatar/อัปโหลดคลิป (ต้องมี key) ให้คนใหม่ | ⚠️ |
| /dashboard วันแรก | **modal ขอ Pexels/Pixabay "จำเป็น" เป็นสิ่งแรก** · 3 banner ซ้อน · "คุณมี 80 นาที/เดือน" vs "15/15" vs "15 นาที ใน 7 วัน" ในจอเดียว · sidebar CTA ม่วง = "Upgrade to Business" · "Hero credits 0" | 🔴 |
| Editor step 1 | หน้าว่าง 100% ไม่มี sample/"ให้ AI เขียน" (Hero Script อยู่คนละเมนู) · update banner ตามมา · ออกจาก editor ไม่ชัด | ⚠️ / 👍 auto-segment HOOK/CTA ดีมาก |
| Step 2 | 👍 default ครบ กด render ได้ทันที, receipt ชัด · ⚠️ "Hero AI Voice เร็วๆ นี้" แท็บแรกกดไม่ได้ · 3 ระบบหน่วย (นาที/เครดิต/สิทธิ์ภาพ) | |
| Render | **สำเร็จใน ~2.5 นาทีโดยไม่มี key เลย** (b-roll + AI image + ซับ + พาดหัว) → key-gate เป็นกำแพงปลอม | 🔴 finding |
| Post phase | 8 การ์ด + 3 แท็บ + timeline ทีเดียว · พาดหัว auto ตัดกลางประโยค · 👍 ปุ่ม "ส่งออกวิดีโอ" เด่น | ⚠️ |
| Export → convert prompt | ขึ้นก่อน user เห็นคลิปตัวเองเต็มๆ · ราคา ฿599 ≠ ฿250 ที่ landing · ไม่บอกว่า trial ยังเหลือ · **ขึ้นซ้ำทันทีที่เข้า /pricing** | ⚠️ |
| Stripe checkout | อังกฤษล้วน · รายเดือนมีแต่บัตร (ไม่มี PromptPay) · โลโก้เบลอ · ไม่มี trust copy | ⚠️ |
| /pricing in-app | PRO card 12 bullets (ไม่ lean) · "~5 คลิป" vs "2 คลิป" ในหน้าเดียว · "ปิด…ตัดต่อในเว็บ" หลัง trial = เท็จ (v2 เปิดให้ FREE) · credit packs ปนกับ plan · footnote เครดิตขัด PRO bullet | ⚠️ |

---

## 7. ข้อเสนอ — จัดลำดับตาม impact × effort

Impact = ผลต่อ trial→recurring; Effort S (<1 วัน) / M (1–3 วัน) / L (>3 วัน). ทุกข้อในหัวข้อ 7.1–7.3 เปิดเป็น GitHub issue ได้ทันที; 7.4 รอ Mew เคาะ

### 7.1 P0 — แก้ก่อน (bug/dead-end ที่ทำให้เงินหลุดมือ)

| # | ข้อเสนอ | หลักฐาน | Effort |
|---|---|---|---|
| P0-1 | **Zero-setup first clip:** ไม่เปิด KeyOnboardingWizard วันแรก; dashboard CTA เดียว "สร้างคลิปแรก (ไม่ต้องตั้งค่า)"; Pexels/Pixabay ย้ายเป็น optional "อัปเกรดคลัง B-roll" ที่ Step 2 / หลัง export; แก้ copy "จำเป็น" → "ไม่บังคับ" ทุกจุด (`KeyOnboardingWizard`, `KeySetupChecklist`, `ModelExplainerPanel`, docs/setup-api-keys) | key-gate: 2.1% vs 65.5%; render ได้โดยไม่มี key | M |
| P0-2 | **Quota dead-end:** `useV2Job.ts:486,576` อ่าน `d.error.code`; surface `userAction` + `canBuyCredits` เป็น UpgradeModal → `/pricing?source=quota_hit`; เพิ่ม FailedView kind `plan-quota` | ภาคผนวก C #1 | S |
| P0-3 | **Trial-expiry moment:** (a) หยุด `renewal-reminders` ยิงให้ trial (`where trialStartedAt: null`) (b) trial reminder แยก: วัน 5 "เหลือ 2 วัน + คลิป N ชิ้นจะถูกลบ 3 วันหลังหมด", วันหมด, วัน +3 (c) เก็บ `trialEndedAt` แทนล้าง `trialEndsAt` (cohort) | 383 หมด → 3 จ่าย; C #3, #7 | M |
| P0-4 | **Checkout default = recurring:** in-app `/pricing` default รายเดือน+บัตร (annual = "บัตร ต่ออัตโนมัติ" ก่อน PromptPay); trial-ended banner ไม่ push "รายปี"; PromptPay รายปีเก็บไว้เป็นทางเลือกลำดับ 2 | 36 abandoned = ฿5,990 default; North Star recurring | S |
| P0-5 | **Actionable render errors:** map error → {สาเหตุ, ใครแก้ (คุณ/เรา), ปุ่ม}: subtitle quality-gate → auto-retry/ผ่อน gate + ข้อความ "ระบบกำลังลองใหม่", stock 401 → "key Pexels ใช้ไม่ได้ → ตั้งค่า/ลบ key ใช้คลังระบบ", HeyGen quota → "เครดิต HeyGen ของคุณหมด", ElevenLabs invalid → "ใช้ Secret key ไม่ใช่ Key ID"; **validate key ตอนวาง** (preflight) ใน settings | fail 20.9%, first-job fail 31.8%; ticket T1/T12 | M |
| P0-6 | **Billing:** รายเดือน→รายปี upgrade path ใช้ได้จริง (Stripe portal/`subscription.update` proration) + follow-up ลูกค้าที่เคยติด | ticket T11 | S–M |
| P0-7 | **Convert prompt hygiene:** (a) ไม่ขึ้นซ้ำใน session/ผู้จ่าย one-time (ใช้ DB flag ไม่ใช่ sessionStorage; mount จุดเดียว) (b) โชว์หลัง user ดู/ดาวน์โหลดคลิป (delay หรือปุ่ม "ดูคลิป" ก่อน) (c) copy บอก "trial เหลือ N วัน · สมัครวันนี้ = เก็บคลิปนี้ 7 วัน + 80 นาที + 50 เครดิต" (d) ราคา = ราคาที่ landing แสดง (annual/เดือน) หรืออธิบาย ฿599 vs ฿250 | walkthrough; C table | S |

### 7.2 P1 — เพิ่ม/ปรับ (ทำให้คนใหม่ถึง aha เร็ว, ทำให้ตัวเลขน่าเชื่อถือ)

| # | ข้อเสนอ | Effort |
|---|---|---|
| P1-1 | **ตัวเลขเดียวก่อนคลิปแรก:** ก่อน export แรก โชว์แค่ "เหลือ 15 นาทีลอง ≈ 5 คลิป"; ซ่อน `Hero credits`, สิทธิ์ภาพ 8, overflow 2 เครดิต/นาที, HeyGen/วินาที, "80 นาที" (`ModelExplainerPanel` ใช้ `minutesLimit` จริง); `quota-status` amber threshold เป็นสัดส่วน (≤20%) ไม่ใช่ ≤10 นาที | S–M |
| P1-2 | **Dashboard = progress-to-first-export:** แทน STYLES/VIDEOS 0 + "Upgrade to Business" ด้วย stepper "เขียนสคริปต์ → เรนเดอร์ → ส่งออก → (แชร์)" (มี `firstClipPath` จาก `/api/user/me` แล้ว); sidebar CTA ตาม state (trial 0 คลิป = "สร้างคลิปแรก", trial มีคลิป = "สมัคร PRO", PRO = "Business") | M |
| P1-3 | **Editor step 1 ไม่ว่าง:** 3 sample script (สั้น/กลาง/ยาว) + ปุ่ม "ให้ AI เขียนจากหัวข้อ" ที่พาเข้า Hero Script แล้วส่งกลับ (handoff มีแล้ว); Hero Script ออกจาก allowlist สำหรับ trial อย่างน้อย 1 ครั้ง | M |
| P1-4 | **Banner hierarchy:** update banner ไม่โชว์ใน 7 วันแรก/ใน editor; trial banner ramp (วัน ≤2 เปลี่ยนสี+นับคลิปที่จะหาย); ไม่มี modal ทับวันแรก | S |
| P1-5 | **Copy truth sweep:** ลบ "~5 คลิป/~80 คลิป/~150 คลิป", "ปิด…ตัดต่อในเว็บ", "Pro only feature" บน Videos tile, "Priority support" ที่ไม่มี SLA; ดึง trial/limit ทุกจุดจาก `TRIAL_DAYS_PUBLIC`/`TRIAL_MINUTES`/`plan-limits` (10+ จุด hardcode) — รายการเต็มใน C §1.3 | S |
| P1-6 | **PRO pitch = สิ่งที่คนจ่ายใช้จริง:** การ์ด PRO ลดเหลือ 5 bullets: พิธีกร AI (avatar) · ภาพ AI + 50 เครดิต/เดือน (ยังไม่เคยบอกลูกค้า!) · เสียงโคลน · 80 นาที · เก็บ 7 วัน; ย้าย 7 bullets ที่เหลือเข้า "ดูทั้งหมด"; footnote เครดิตให้ตรงกัน | S |
| P1-7 | **Post-phase progressive:** คลิปแรก: โชว์ preview + ปุ่ม "ส่งออก" + "แก้ซับ (ไม่บังคับ)"; timeline/แท็บโลโก้พับไว้; พาดหัว auto ตัดที่จบ segment แรก | M |
| P1-8 | **Register/Checkout localization:** Clerk `localization: thTH` + skeleton ระหว่างโหลด; Stripe checkout `locale:'th'`, โลโก้ 512px, เพิ่ม PromptPay ให้รายเดือน (Stripe รองรับ PromptPay กับ subscription แบบ one-off first invoice — ตรวจก่อน) ; trust row "ยกเลิกได้ทุกเมื่อ · ใบเสร็จอัตโนมัติ" | S–M |
| P1-9 | **Re-onboard คนจ่ายที่ไม่เคยทำคลิป (7 คน) + dormant Founding (6 คน):** email/LINE ส่วนตัว "เรามีคลิปตัวอย่างจากสคริปต์ของคุณ" + concierge call; ทำก่อน renew ปีหน้า | S (ops) |
| P1-10 | **Coupon strategy:** GRANT coupon 160 → 4 จ่าย (2.5%) แต่ FOUNDING100 (discount) 12/12; เปลี่ยน event/live coupon จาก "PRO ฟรี 30 วัน" เป็น "ส่วนลด X% สำหรับสมัคร recurring ภายใน 72 ชม." + trial ปกติ | S (policy) |
| P1-11 | **Acquisition source:** เก็บ `User.acquisitionSource` จาก `?utm_*`/`?ref`/coupon ตอน signup (Clerk metadata) เพื่อแยก organic / live / event | S |

### 7.3 P2 — ระบบวัดผล (admin/insights)

| # | ข้อเสนอ | Effort |
|---|---|---|
| P2-1 | **Insights tab "Conversion" ใหม่ขึ้นบนสุด:** trial→recurring by signup week (14/30 วัน), trial-expiry outcome, time-to-first-export p50/p90, key-set drop, paywall funnel per surface (shown→click→checkout→paid), checkout abandon (PENDING/FAILED vs PAID), quota-hit→pay, founding velocity | M–L |
| P2-2 | **Activation panel แก้ 2 อย่าง:** denominator = signups ใน window (`windowSignups` มีแล้วแต่ไม่ใช้) · นิยาม = Export/Burn ไม่ใช่ Video COMPLETED | S |
| P2-3 | **Demote/Remove:** Health Score, pipeline p95, B-roll/playback/vitals, error list → tab "System" (collapsed); CostMargin → tab "Finance"; `/admin` overview ลบ "ผู้ใช้ Free/ถูกระงับ/เนื้อหา/รูปภาพ ทั้งหมด" + หมายเหตุ "paidUsers ≈ …"; ลบ AI recommendations text | S |
| P2-4 | **เปลี่ยนชื่อ MAPC → "Paid retention"** (มันวัดหลังจ่าย ไม่ใช่ conversion) และเพิ่ม COGS ต่อ trial ใน Finance | S |
| P2-5 | **Data hygiene:** `geminiKeyMode` stale ('byok' 100% แต่ไม่มี key) → ตั้ง managed ให้ถูก; `onboardingDismissedAt` อย่า auto-stamp; `Video` row ให้สร้างทุก done job หรือเลิกใช้ในสถิติ | S |

### 7.4 ซ่อน / ย้าย / ตัด — **รอ Mew เคาะ** (ยังไม่เปิด issue)

เกณฑ์: ซ่อน/ย้าย ได้ถ้าคนจ่ายไม่ได้ใช้เป็นหลัก; ตัด เฉพาะ 0 payer ใช้ใน 30 วัน + maintenance cost ชัด

| ฟีเจอร์/พื้นผิว | ข้อมูล | ข้อเสนอ |
|---|---|---|
| **KeyOnboardingWizard (modal วันแรก)** | key ไม่จำเป็นต่อการ render | **ซ่อนจาก first-run** → เหลือใน Settings + Step 2 contextual (P0-1) |
| **"Hero AI Voice — เร็วๆ นี้" แท็บ** | 0 payer ใช้ (1 user ทั้งประวัติ) | **ซ่อน** จนกว่าจะเปิด (แท็บกดไม่ได้ในตำแหน่งแรก = สับสน) |
| **Credit packs บน /pricing** | 2 payer ซื้อ pack อย่างเดียว (แทน sub); credits ไม่ปลดฟีเจอร์ | **ย้าย** ไป Settings › Billing เท่านั้น (ให้ /pricing ขายแค่ sub); เก็บ deep-link จาก receipt overflow |
| **STYLES / Contents / GeneratedImage (legacy dashboard tiles + limit warnings)** | เป็นฟีเจอร์เก่า ไม่อยู่ใน funnel; "ใช้ Free plan ครบ limit" มาจาก styles | **ซ่อนจาก dashboard**; พิจารณา **ตัด** โมดูล Content/Style เดิมถ้าไม่มี payer ใช้ 30 วัน (ต้อง query เพิ่ม: `Content`/`Style` rows ของ payer) |
| **Update banner (/updates) ใน editor และ 7 วันแรก** | 132 non-activator เคยเข้า /updates (แทนที่จะทำคลิป) | **ซ่อน** ใน editor + วันแรก; เหลือ badge ที่ sidebar |
| **B-roll re-render per-window** | 17 users, 2 payer; ticket 10 ใบ (bug "export ได้ไฟล์เก่า") | **เก็บแต่ย้ายเข้า Advanced** ของ Post phase จนแก้บั๊ก sync; ไม่ตัด (payer ใช้) |
| **Cutaway / upload-own-clip mode** | 32 users, 5 payer (22%) | เก็บ; แต่ **ไม่โปรโมทบน /register** (ตั้งความคาดหวังผิด) |
| **Founding banner สำหรับ trial** | ตอนนี้ render เฉพาะ plan=FREE → trial ไม่เห็น scarcity | **แสดง**ให้ trial ด้วย (กลับด้านคือ "เพิ่ม") |
| **Editor v1 (`?ui=v1`)** | escape hatch; ไม่มีข้อมูลการใช้ | ถ้า telemetry 30 วันไม่มี payer เปิด v1 → **ตัด** (ลด maintenance 2 editor) — ต้อง instrument ก่อน |
| **Affiliate program integration** | 39 คน → 0 จ่าย, 2 คลิป | ไม่ตัด แต่ **หยุดลงทุนเพิ่ม** จนกว่าจะมี partner ที่ส่งคนตั้งใจ; วัดด้วย acquisitionSource |

---

## 8. Telemetry ที่ต้องติด (ปิดช่องว่าง, ไม่แก้ schema)

`TelemetryEvent` มี `name/category/source/step/status/value/properties/dedupeKey` พอแล้ว. 15 events (รายละเอียด properties + จุดยิงใน C §2.3):

`signup_completed` · `trial_started` · `trial_expired` (server, ก่อน notification) · `onboarding_key_saved` / `onboarding_dismissed` · `first_clip_path_step` · **`export_completed`** (= Activation; client + server ที่ RenderJob BURN DONE) · `quota_hit` · `paywall_shown` / `paywall_dismissed` (รวม `locked_preview_viewed` เดิม) · `pricing_viewed` (ทุก source ไม่ใช่แค่ hero_script) · `pricing_cta_clicked` (เพิ่ม plan/period/method/coupon) · `checkout_started` (server ที่ `/api/payments/checkout|founding-annual|credits`, ใส่ `surface` ลง Stripe metadata) · `checkout_completed` (webhook) · `checkout_abandoned` · `subscription_canceled` (webhook + `cancellation_details`) · `credit_pack_purchased`

ด้วยชุดนี้ Insights คำนวณได้ครบ: trial→paid by cohort, paywall funnel per surface, time-to-first-export, expiry outcome, checkout abandon, quota→pay

---

## 9. Baseline เพื่อวัดผลรอบหน้า (เทียบ 06-18 → 08-25 → ครั้งถัดไป)

| metric | 06-18 (KEY_ONBOARDING_REDESIGN) | 08-25 (audit นี้, W) | เป้าหลัง P0/P1 (30 วัน) |
|---|---|---|---|
| สมัคร → เริ่มทำคลิป | – | 19.0% | ≥ 40% (คน key-less ต้องขึ้นจาก 2% → 30%+) |
| สมัคร → ได้คลิป | 9% (200 users) | 16.3% | ≥ 30% |
| สมัคร → Export (Activation) | – | 8.9% | ≥ 20% |
| first-job failure | – | 31.8% | ≤ 15% |
| trial expired → paid 14 วัน | – | 0.8% | ≥ 5% |
| /pricing → paid | – | 7.0% | ≥ 12% |
| checkout → paid | – | 41.5% | ≥ 60% (default recurring, ราคาไม่ shock) |
| paid ที่เป็น recurring | – | 8/24 (33%) | ≥ 60% ของ payer ใหม่ |
| payer ที่ไม่เคยทำคลิป | – | 30% | 0% (re-onboard) |

---

## 10. สิ่งที่ยังไม่ได้ทำ / ต้องการจาก Mew

1. **เคาะ §7.4** (ซ่อน/ย้าย/ตัด) → ผมเปิด issue ชุดที่ 2
2. **Stripe dashboard** (churn reason, abandoned session detail) — ต้องการ OAuth Stripe MCP หรือ export CSV
3. **ลบ/suspend บัญชี `duckyhero+uxaudit@gmail.com`** (มี 1 clip, 1 export; exclude จากสถิติแล้ว)
4. ฟีดแบ็กจาก LINE/Facebook ที่ไม่อยู่ใน ticket — ถ้ามี 3–5 ประเด็นเพิ่มให้ผม merge เข้า §5
5. ยืนยันสมมติฐาน "P07 churn เพราะ core-render bugs" ด้วยการติดต่อโดยตรง (ops)

---

## 11. GitHub issues ที่เปิดแล้ว (2026-08-25)

| Audit # | Issue | | Audit # | Issue |
|---|---|---|---|---|
| P0-1 | #297 | | P1-6 | #309 |
| P0-2 | #298 | | P1-7 | #310 |
| P0-3 | #299 | | P1-8 | #311 |
| P0-4 | #300 | | P1-9 (human) | #318 |
| P0-5 | #301 | | P1-10 (human) | #319 |
| P0-6 | #302 | | P1-11 | #312 |
| P0-7 | #303 | | P2-1 | #313 |
| P1-1 | #304 | | P2-2 | #314 |
| P1-2 | #305 | | P2-3 | #315 |
| P1-3 | #306 | | P2-4 telemetry | #316 |
| P1-4 | #307 | | P2-5 | #317 |
| P1-5 | #308 | | §7.4 hide/cut | รอ Mew |

---

## Erratum (2026-08-25, หลังส่งมอบ)

"เรนเดอร์ได้โดยไม่มี key" เป็นจริง **เฉพาะคลิปแรกของ trial**: `src/app/api/videos/jobs/route.ts:513-586` บังคับ `stockSource="kie-image"` (Hero AI Image, สิทธิ์ทดลอง 8 ภาพ) เมื่อ `firstClip.reason === "conversion_trial"`; คลิปที่ 2, ผู้ใช้คูปอง/จ่ายแล้ว และโหมดอัปโหลด ต้องมี Pexels/Pixabay key ไม่งั้น 400 `missing_key: broll`. คลิปทดสอบของ audit ใช้ภาพ AI 8/8 ทั้งที่ UI โชว์ AutoMix และ receipt บอก "เหลือ 7/8" → UI/receipt ไม่ตรง server. ผลต่อ P0-1 (#297): ต้องเลือก (a) managed stock key สำหรับ trial/FREE (rate-limit + fail-closed แบบ ADR 0003) / (b) ขยายสิทธิ์ AI / (c) ขอ key หลังคลิปแรกพร้อมเหตุผล — แนะนำ (a)+(c). ยังไม่มี Pexels key กลางบน prod; provider ไม่ใช้ key ที่มีอยู่ (Wikimedia/NASA/Met) เป็นภาพนิ่ง fallback เท่านั้น.

## 12. §7.4 decisions (Mew, 2026-08-25) + issue batch 2

| §7.4 item | decision | issue |
|---|---|---|
| 1 key modal day-one | approve → managed stock key (a)+(c) | #297 (spec in comments) |
| 2 Hero AI Voice "เร็วๆ นี้" tab | **keep** (signals upcoming feature) | — |
| 3 credit packs off /pricing | approve | #320 |
| 4 legacy Styles/Contents/Videos tiles | approve, remove | #321 |
| 5 update banner in editor / first 7 days | approve | #322 |
| 6 Founding banner for trial | approve | #323 |
| 7 per-window B-roll | **fix + verify, don't hide** | #324 |
| 8 /register copy | approve, reorder (zero-setup first, avatar as "ต่อยอดได้") | #325 |
| 9 Editor v1 | approve, instrument 30 days then cut | #326 |
| 10 cut Content/Style modules | approve (check payer usage first; no schema drops) | #327 |
| 11 affiliate | keep as is, no further investment | — |

## 13. Mobile (เพิ่ม 2026-08-25 ตามคำขอ Mew) — issue batch 3

มือถือ ≈ 13.5% ของการใช้งานหลัง login (nginx วันนี้); telemetry ไม่เก็บ device เลย. Landing/auth/editor v2/dashboard shell มี mobile pass จริง; จุดพังกระจุกที่ Gallery, Brands, modals ขายของ, Pricing toggles, และ `100vh`. รายละเอียด + หลักฐาน file:line ใน appendix E.

| # | ปัญหา | issue |
|---|---|---|
| M1 | Gallery ปุ่ม hover-only แตะไม่ได้บนมือถือ | #328 |
| M2 | Gallery preview modal กว้างเกินจอ, ปุ่มปิดหลุด, ไม่มี playsInline | #329 |
| M3 | Brand look preview grid-cols-3 ปุ่มทับกัน | #330 |
| M4 | UpgradeModal + ConvertPrompt ไม่มี scroll/ปุ่มปิด 16px | #331 |
| M5 | RenderReceiptDialog ปุ่มเรนเดอร์ตกใต้ toolbar | #332 |
| M6 | h-screen/100vh → dvh ทั้งระบบ | #333 |
| M7 | Pricing toggles เล็กเกินแตะ | #334 |
| M8 | Trial banner ล้น + tap targets เล็กใน onboarding/topbar | #335 |
| M9 | Download บน iOS: Content-Disposition, button-in-anchor | #336 |
| M10 | Mobile regression gate ใน CI + device telemetry | #337 |

ยังไม่ได้ยืนยันบนอุปกรณ์จริง (ดู appendix E §"ต้องยืนยันบนเครื่องจริง").
