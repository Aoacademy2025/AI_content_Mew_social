# รีวิว "ตัวเลข" ทั้งระบบ HERO AI Creator Studio เทียบกับ North Star (trial → Stripe recurring)

> อ่านโค้ดอย่างเดียว (read-only) จาก root checkout `main` 2026-08-25. ทุกข้อมี `file:line`.
> North Star = trial→paid เป็น **Stripe recurring subscription** · Activation = **Burn/Export สำเร็จครั้งแรก**.
> สมมติ flag prod ตาม memory/CLAUDE.md: `MINUTE_QUOTA=1`, `CREDITS_LIVE=1` + `NEXT_PUBLIC_CREDITS_LIVE=1`, `MANAGED_GEMINI=1`, `EDITOR_V2=1`.

---

## 0. สรุป 10 ข้อที่สำคัญที่สุด (เรียงตาม impact ต่อ conversion)

| # | ประเด็น | หลักฐาน | ผล |
|---|---|---|---|
| 1 | **Dead end ตอนโควต้าหมดใน Editor v2 — จุดที่ลูกค้า "พร้อมจ่ายที่สุด" ไม่มีปุ่มจ่าย** | server ตอบ `{ error: { code: "quota_exceeded", userAction: "อัปเกรดแพ็กเกจที่หน้า Pricing…" } }` (`src/app/api/videos/render/route.ts:247-259`) แต่ client เทียบ `d?.error === "quota_exceeded"` เป็น string (`src/app/(dashboard)/video-editor/_v2/useV2Job.ts:486,576`) → ไม่ match; `message: d?.message ?? d?.error` ได้ object → `toast.error(object)` (`EditorV2Shell.tsx:200`) | `userAction`/`canBuyCredits` ไม่เคยถึงตา user ไม่มี UpgradeModal ไม่มีลิงก์ /pricing |
| 2 | **Default ทางจ่ายทุก surface = รายปี PromptPay "จ่ายครั้งเดียว" ≠ North Star (recurring)** | `/pricing` default `period="annual"`, `method="promptpay"` (`pricing-client.tsx:86-87`); landing default `yearly` (`pricing-toggle.tsx:25`) + billingNote "PromptPay จ่ายครั้งเดียว" (`pricing-display.ts:73`); trial-ended banner "อัปเกรดรายปีรับราคาพิเศษ" (`trial-banner.tsx:29`); Founding ลด 50% เฉพาะ annual (`pricing-display.ts:38-39`) | มีแค่ `FirstClipConvertPrompt` ที่ push รายเดือน recurring (`first-clip-convert-prompt.tsx:116-124`) — 2 กลยุทธ์ขัดกันเอง |
| 3 | **Trial user โดนอีเมล "ต่ออายุ" ตั้งแต่วันแรก** | cron `renewal-reminders` เลือก `plan != FREE && stripeSubscriptionId null && planExpiresAt ≤ +15d` (`route.ts:27-34`) — trial ตั้ง `planExpiresAt = trialEndsAt` (`trial.ts:50-54`) → เข้าเงื่อนไข; `REMIND_AT=[14,7,1]` → วันถัดจากสมัคร (daysLeft=7) และวันที่ 6 (daysLeft=1) ได้ notification "แพ็ก PRO หมดอายุในอีก 7 วัน / ต่ออายุก่อนหมด ล็อกราคาผู้ก่อตั้ง" (type `VIDEO_COMPLETED`!) + email `sendRenewalReminderEmail` (`route.ts:44-53`) | ข้อความผิดบริบท (ไม่ได้เคยจ่าย) และไม่ใช่ copy สำหรับ trial |
| 4 | **Trial user เห็น 4 สกุลเงินพร้อมกันก่อนทำคลิปแรก** | dashboard: chip `โควต้านาที 15/15` + `Hero credits 0` (`quota-status.tsx:107-139`, mount `dashboard/page.tsx:209`); ModelExplainer "คุณมี **80** นาที/เดือน" (hardcode `DashboardOnboarding.tsx:39` map plan→80 ไม่รู้ trial=15); Step2 "สิทธิ์ทดลองภาพ AI 8 ภาพ" (`Step2Elements.tsx:113`); "HeyGen คิดเงินตามวินาที" (`Step2Elements.tsx:758,838`); Receipt รวมสูงสุด 6 บรรทัด (`receipt.ts:147-236`) | trial ไม่ได้ credit grant (`credits.ts:709-714`) → "Hero credits **0**" โชว์ตลอด = ดูจน/พัง ตั้งแต่ยังไม่ได้ทำอะไร |
| 5 | **FREE clip cap ขัดกัน 3 แบบ และ cap 2 คลิปไม่ได้ enforce ภายใต้ MINUTE_QUOTA** | `FREE_LIMITS.clips=2` (`plan-limits.ts:2`) → landing/pricing FREE card "5 นาที + **สูงสุด 2 คลิป**/30 วัน" (`marketing-plan-facts.ts:64`) แต่ band ใน /pricing "5 นาที/เดือน · **~5 คลิป**" (`pricing-client.tsx:251`), docs "~5 คลิป" (`docs/_content/minutes-credits.tsx:21`), admin default "~5 คลิป" (`admin/page.tsx:434`); render route ใช้ `reserveClipUsage` เฉพาะ `!useMinuteQuota` (`render/route.ts:625`) | ตัวเลข "2 คลิป" บน sale page เป็น cap ที่ไม่มีจริง แต่ทำให้ FREE ดูขี้เหนียวกว่าความจริง |
| 6 | **Founding scarcity ซ่อนจากคนที่ควรเห็นที่สุด (trial)** | `DashboardFounderBanner` render เฉพาะ `plan === "FREE"` (`founder-banner.tsx:21,28`) — trial มี `plan=PRO` | trial 7 วันไม่เห็น "เหลือ N/100 ที่นั่ง" ในแอปเลย จนกว่าจะหมดอายุ |
| 7 | **Copy เสียสิทธิ์หลัง trial โกหกบางส่วน** | "ปิด Avatar / โคลนเสียง / **ตัดต่อในเว็บ**" (`pricing-client.tsx:251`) จาก `allowVideoEditor:false` (`plan-limits.ts:17`) แต่ Editor v2 เปิดให้ FREE ("แผน Free ยังสร้างวิดีโอจากสคริปต์…ได้" `Step1Script.tsx:320`); dashboard tile Videos "Pro only feature" สำหรับ non-paid (`dashboard/page.tsx:288-292`) | ข่มขู่ด้วยของที่ไม่ได้ปิดจริง → พอลองแล้วทำได้ = ไม่เชื่อ copy ที่เหลือ |
| 8 | **PRO ขาย "50 เครดิต/เดือน" ไม่เคยบอกลูกค้า** | `MONTHLY_GRANT.PRO=50` (`credits.ts:52-56`), admin coupon page รู้ ("PRO · 80 นาที / 50 monthly credits" `admin/coupons/page.tsx:177`) แต่ `pro_features` (`plan-config.ts:28-29`) และ UpgradeModal (`upgrade-modal.tsx:25-31`) ไม่มีเลย; ยิ่งกว่านั้น pricing footnote "เครดิตไม่ปลดล็อก Hero AI Image" (`pricing-client.tsx:537`) ขณะที่ PRO card บอก "ภาพ AI 2 เครดิต/ภาพ" (`marketing-plan-facts.ts:39`) | benefit ที่แพงที่สุดของ PRO หายจาก pitch + ข้อความเครดิตขัดกันเอง |
| 9 | **Telemetry ไม่มี event ของ funnel เงินเลย** | events ที่มี (grep `trackEvent("`): `pricing_cta_clicked`(3 surface), `locked_preview_viewed`, `feature_card_clicked`, `hero_script_checkout_requested` (เฉพาะ hero_script), `editor_opened/step2_reached/script_ready`, `page_viewed`. **ไม่มี** signup, trial_started/expired, paywall_shown, checkout_started/completed, first_export, key_saved/dismissed, quota_hit | `/admin/insights` จึงวัด trial→paid ไม่ได้ ทำได้แค่ stock count "Trial N / จ่ายจริง M" (`insights/route.ts:960-966`) |
| 10 | **Admin dashboard ไม่มี "อัตรา" ที่ North Star ต้องการแม้แต่ตัวเดียว** | overview 8 การ์ด (`admin/page.tsx:907-915`) = total users/contents/images/suspended; insights Activation ใช้ signups **ตลอดกาล** เป็นตัวหาร (`insights/route.ts:481-487`) → % ถูก history กดจม; MAPC เป็น retention ของคนจ่ายแล้ว ไม่ใช่ conversion (`subscription-north-star.server.ts:104-147`) | ไม่มี trial→paid by cohort, time-to-first-export, expiry outcome, paywall funnel |

---

## PART 1 — ตัวเลขฝั่งลูกค้า

### 1.1 ตารางแหล่งจริง (source of truth ที่ enforce)

| ตัวเลข | ค่า | ที่มา |
|---|---|---|
| Trial | 7 วัน (`TRIAL_DAYS_PUBLIC=7` `trial.ts:9`), 15 นาที (`TRIAL_MINUTES` `plan-limits.ts:21`; ใช้ `min(80,15)` ใน `usage-limits.ts:74-77`) | window นาที = 30 วัน (ไม่ใช่ 7) — copy "15 นาที ใน 7 วัน" ถูกในทางปฏิบัติเพราะ trial revert ก่อน |
| FREE | clips 2 / 120s / เก็บ 3 วัน / **5 นาที** / styles 2 / contents 5 / scripts 3 / ทุก allow=false | `plan-limits.ts:1-18` |
| PRO | clips 100 / 360s / 7 วัน / **80 นาที** / 50 credits/เดือน / brandProfiles 5 | `plan-limits.ts:23-39`, `credits.ts:54` |
| BUSINESS | clips 300 / 600s / 14 วัน / **150 นาที** / 150 credits | `plan-limits.ts:41-57`, `credits.ts:55` |
| ราคา | PRO 599 / BUSINESS 990 (SiteConfig override ได้) · annual = ×10 (`pricing-display.ts:37`) · Founding % จาก coupon | `plan-config.ts:24,31` |
| เครดิต | 1 เครดิต = ฿1 · overflow 2 เครดิต/นาที (`credit-costs.ts:15`) · Hero AI Image 2 เครดิต/ภาพ (`credit-costs.ts:41-42`) · pack 199/200, 499/540, 999/1150 | `pricing-client.tsx:24-28`, `credits-billing-section.tsx:17-55` (2 สำเนา sync มือ) |
| Starter AI Image | 8 ภาพ / 7 วัน | `starter-ai-image-allowance.ts:8-9` |

### 1.2 Surface-by-surface

| Surface | ตัวเลข/ป้ายที่โชว์ | โผล่เมื่อ | CTA → ปลายทาง | Telemetry | ข้อสังเกต (a/b/c/d) |
|---|---|---|---|---|---|
| **Landing `/`** (`src/app/page.tsx`) | hero chips "PRO ฟรี 7 วัน · 15 นาที / ไม่ใช้บัตร / AI หลักระบบดูแลให้" (:228); FAQ "7 วัน โควต้า 15 นาที" (:144-147); Founding bar "เหลือ N/100" + progress % (:166-181, :157); footer "PRO ฟรี 7 วัน" (:439) | public | ทุกปุ่ม → `/register` | ไม่มี (affiliate script เท่านั้น :453) | ✔ ชัด. แต่ FREE card ใน `PricingToggle` มี 5 ตัวเลข: "ทดลอง 7 วัน 15 นาที", "5 นาที + สูงสุด 2 คลิป/30 วัน", "ไม่เกิน 2 นาที · เก็บ 3 วัน" (`marketing-plan-facts.ts:67-74`) — คนยังไม่สมัครไม่ต้องรู้ cap FREE ขนาดนี้ |
| **PricingToggle (landing)** (`pricing-toggle.tsx`) | default **รายปี**; ราคา = เฉลี่ย/เดือน + "ชำระ ฿X/ปี" (`pricing-display.ts:66-75`) — ⚠️ ขัด CLAUDE.md "NO annual total" (sub บอกยอดปีเต็ม); badge "100 คนแรก" (:98); trust row "ทดลอง PRO ฟรี 7 วัน" (:121) | public | `/register` | ไม่มี | (b) landing โชว์ยอดปี แต่ in-app `/pricing` ซ่อน (`pricing-client.tsx:193`) — นโยบายไม่ตรงกัน |
| **Register/Login shell** (`auth-shell.tsx:108,162,171-172`) | "PRO ฟรี 7 วัน · ไม่ใช้บัตร" | signup | Clerk | ไม่มี `signup` event | ✔ |
| **TrialBanner** (`trial-banner.tsx`) | "ทดลอง PRO เหลืออีก N วัน · 15 นาที ใน 7 วัน" / หมดแล้ว: "อัปเกรดรายปีรับราคาพิเศษ" | ทุกหน้าใน dashboard ตลอด trial + หลังหมด | `/pricing` (ป้าย "อัปเกรดเลย"/"ดูแพ็กเกจ") | ไม่มี | (a) ไม่มี urgency ramp (วัน 7 = วัน 1); (b) push รายปี ≠ recurring; (d) ควรเปลี่ยนเป็น progress-to-first-clip ตอน 0 คลิป และ ramp ตอน ≤2 วัน |
| **Dashboard** (`dashboard/page.tsx`) | eyebrow "ทดลอง PRO" (:130); pill `7d remaining` (Eng/mono :187) เมื่อ `isPaid` — trial นับเป็น paid; QuotaStatus chip (:209); Styles tile `0/2` + % bar (:272-287); Videos tile "Pro only feature" (:288-292); limit warning "ใช้ Free plan ครบ limit" จาก styles/contents (:253-266); Upgrade card "Unlimited styles, content และ avatar videos" (:372) | ทุกครั้งที่เปิด | `/pricing` ×3 | ไม่มี | (a) Styles/Contents = ฟีเจอร์เก่า ไม่เกี่ยว activation; (c) "Pro only feature" บน Videos ผิด (FREE ทำได้); (b) "d remaining" ซ้ำกับ TrialBanner ต่างภาษา; (d) ไม่มี "ทำคลิปแรก" progress — `KeySetupChecklist` นับแค่ key `0/1` (`KeySetupChecklist.tsx:19-27`, managed → เหลือ stock key ตัวเดียว) |
| **ModelExplainerPanel** (`ModelExplainerPanel.tsx:32-47`) | "คุณมี **80 นาที/เดือน**" (trial) + "ใช้เกิน? ซื้อเครดิตเติมได้" | dashboard ทุกครั้ง (ไม่มี dismiss) | ไม่มี | ไม่มี | (b) trial จริง 15 นาที (hardcode map `DashboardOnboarding.tsx:38-40` ไม่รู้ trial) — ขัดกับ chip 15/15 ที่อยู่ถัดลงมา 2 บรรทัด; (a) ขาย "ซื้อเครดิต" ให้คนที่ยังไม่เคย render |
| **QuotaStatus chip/row** (`quota-status.tsx`) | `โควต้านาที R/L` + `Hero credits N` (PRO) / `เครดิตเติมนาที N` (FREE) (:103); row: + `รีเซ็ต dd/mm/พ.ศ.` + "อัปเกรด →" (:239-251) | dashboard, editor topbar ×2 (`EditorV2Shell.tsx:631,666`), settings billing (`settings/page.tsx:643`) | credits → `/settings#credits`; row → `/pricing` | ไม่มี | (a) trial = credits 0 ตลอด (`credits.ts:714` guard) → "Hero credits 0" คือคำเตือนปลอม; (b) สกุลเดียว 2 ชื่อตามแผน; low-quota แสดงเมื่อ `remaining ≤ 10` (:54) → trial 15 นาที **เป็น amber ตั้งแต่ใช้ไป 5 นาที** = เตือนตั้งแต่คลิปแรก |
| **Step1Script** (`Step1Script.tsx`) | "N คำ · M เซ็กเมนต์ · คลิปยาว ~x:xx นาที" (:194); upload mode lock "อัปโหลดคลิปส่วนตัวใช้ได้ใน Pro" (:318-332); duration violation msg "คลิปยาว X นาที เกินเพดานแผน … อัปเกรดเป็น …" (`plan-limits.ts:132-137`) | เมื่อพิมพ์/อัป | `/pricing` (ไม่มี `?source`) | `editor_script_ready` | ✔ contextual; (d) ไม่ track "locked_upload_viewed" |
| **Step2Elements** (`Step2Elements.tsx`) | "ฟรีล้วน · 0 เครดิต" (:64); "~N รูป × 2 = ~M เครดิต" (:109); "N ภาพจากสิทธิ์ทดลอง · เหลือ r/8" (:113); "HeyGen คิดเงินตามวินาที" (:758,838); caption "คลิปยาว ~x · ใช้ ~m จาก R นาทีที่เหลือ" (:969); banner First-Clip Path "สต็อกใช้ 0 เครดิต… หักส่วนเกิน 2 เครดิต/นาที" (:1121); UpgradeModal Hero AI Image (:1132-1160) | ทุกครั้ง | UpgradeModal → `/pricing?source=<feature>_preview` | `editor_step2_reached`, `locked_preview_viewed`, `feature_card_clicked`, `pricing_cta_clicked` ✔ | ดีที่สุดในระบบด้าน telemetry. (a) แต่ First-Clip banner ใส่ "หักส่วนเกิน 2 เครดิต/นาที" ให้คนที่มี 15 นาที + 0 เครดิต = ขู่ก่อนคลิปแรก |
| **RenderReceiptDialog** (`RenderReceiptDialog.tsx` + `receipt.ts`) | "นาทีที่จะใช้ (ประมาณ): X — รวมในแพ็กเกจ (เหลือ R จาก L)"; ภาพ AI …; overflow "ส่วนเกิน M นาทีจะหัก C Hero credits (2/นาที)"; "Hero credits ไม่พอ · ขาด D"; HeyGen line; disclaimer | ทุกครั้งที่กด Render (mandatory, `CREDITS_LIVE`) | ขาดเครดิต → `/pricing?from=editor` ป้าย "เติมเครดิต" หรือ "ดูแผนรายเดือน" (เฉพาะ starter eligible) (:242-253) | ไม่มี (ไม่มี receipt_shown/confirmed/cancelled) | (a) trial ที่คลิปยาวกว่าโควต้าเหลือ → "ไม่พอ" + ปุ่ม **"เติมเครดิต"** ทั้งที่การกระทำที่ถูกคือ subscribe (เครดิตสำหรับ FREE ไม่ปลดฟีเจอร์ ตาม `pricing-client.tsx:537`); (b) `/pricing?from=editor` ไม่ถูกอ่านที่ไหน (`pricing/page.tsx:13` รับแค่ `payment`,`source`) |
| **Quota hit (409)** | server: `quota_exceeded` + `userAction` + `canBuyCredits` (`render/route.ts:247-259`) | render | **ไม่มี** (ดูข้อ 1) | ไม่มี | (c) dead end อันดับ 1 |
| **FailedView** (`EditorV2Shell.tsx:946-999`, `failure-view.ts`) | insufficient-credits → "เติมเครดิต" → `/pricing?from=editor`; heygen-quota → "เติมเครดิต HeyGen"; provider-quota/key → กลับไปตั้งค่า | job fail | ↑ | ไม่มี | (c) ไม่มี kind สำหรับ plan-quota (ตกไป generic) |
| **FirstClipConvertPrompt** (`first-clip-convert-prompt.tsx`) | "คลิปแรกออกแล้ว — สมัครต่อเลย"; "สมัครรายเดือน ฿599/เดือน" (primary) / "ซื้อรายปี Founding ฿X" | หลัง `hero-first-clip-completed` (`useV2Job.ts:223`) + ทุก window focus; ทุก session (dismiss = sessionStorage :9,46) จนกว่าจะเป็น recurring payer (`first-clip-convert.ts:24-26`) | ตรงเข้า `/api/payments/checkout` (ไม่ผ่าน /pricing) ✔ | `pricing_cta_clicked{surface:first_clip_convert_prompt}` | **surface ที่ถูกต้องที่สุดใน North Star** แต่ (a) โผล่ซ้ำทุก session ให้คนจ่ายรายปี one-time/PromptPay ตลอดไป (ไม่ใช่ recurring) = รบกวนลูกค้าที่จ่ายแล้ว; (d) ไม่มี `shown`/`dismissed` → คำนวณ impression→click ไม่ได้; (b) ราคาไม่รวม coupon ที่ user เคย apply |
| **UpgradeModal default** (`upgrade-modal.tsx:25-31`) | "80 นาที/เดือน · ~80 คลิป", "Avatar, ElevenLabs TTS, Background Removal", "Music, Subtitle styles", "Video Editor ขั้นสูงครบฟีเจอร์" | feature gate ทั่วไป | `/pricing` | เฉพาะที่ผู้เรียกส่ง `onCtaClick` | (b) jargon/stale (ElevenLabs, Background Removal ไม่อยู่ใน pitch หลักแล้ว); "Video Editor ขั้นสูง" ทั้งที่ FREE ใช้ v2 ได้ |
| **/pricing band** (`pricing-client.tsx:226-285`) | trial: "เหลือ N วัน", "ใช้ไป u/15 นาทีเดือนนี้", bar %, "โควต้าทดลอง: 15 นาที ใน 7 วัน", "หลังหมดจะกลับเป็น Free — 5 นาที/เดือน · ~5 คลิป · เก็บ 3 วัน · ปิด Avatar/โคลนเสียง/ตัดต่อในเว็บ"; FREE: "อัปเกรด PRO ปลดล็อก 80 นาที/เดือน · ~80 คลิป · AI Avatar · เสียงโคลน · ซับไวรัล · ตัดต่อในเว็บ" | เข้า /pricing | การ์ด | `hero_script_pricing_viewed` เฉพาะ `?source=hero_script*` (:118-123) — source อื่น (`hero_ai_image_preview`, `automix_preview`, `from=editor`) **ไม่ถูก track** | (b) "~5 คลิป"/"~80 คลิป" vs การ์ดข้างล่าง "สูงสุด 2 คลิป"/"สูงสุด 100 คลิป" ในหน้าเดียวกัน; (a) ไม่มี usage ตอน trial ที่ยังไม่ render (0/15) = ว่างเปล่า |
| **/pricing cards** | ราคา/เดือน (annual = เฉลี่ย, ไม่โชว์ยอดปี), was-price, "🔥 Founding ลด 50% · จ่ายปีละครั้ง", badge "ทดลองอยู่ · N วัน"; FREE card "฿0 หลังทดลอง" + CTA "รวมอยู่ในแผนของคุณ" | | PRO/BUSINESS → checkout; ไม่มี `?source` ต่อไปยัง checkout | ไม่มี `checkout_started` (ยกเว้น hero_script :139-148) | (c) trial กด PRO → ok ✔ (comment :346-348); (d) ไม่มี social proof, ไม่มี "สิ่งที่คุณทำไปแล้วจะหาย" (คลิปที่เรนเดอร์ไว้หมดอายุ 3 วันหลัง revert) |
| **Credit packs (/pricing)** (`pricing-client.tsx:507-540`) | 199/200, 499/540 +8%, 999/1150 +15%; "1 เครดิต = ฿1 · 2 เครดิต = 1 นาทีส่วนเกิน"; "เครดิตไม่ปลดล็อก Hero AI Image, Avatar…" | CREDITS_LIVE | "ซื้อเครดิต →" → `/settings?tab=billing` (อีก 1 hop) | ไม่มี | (b) ขัดกับ PRO card "ภาพ AI 2 เครดิต/ภาพ" (เครดิตซื้อภาพได้ถ้า PRO); (a) แถวเครดิตอยู่ในหน้าที่ควร convert เป็น sub — ให้ทางเลือก "จ่าย 199 แทน 599" |
| **Settings › Billing** (`settings/page.tsx:111-147,643`, `credits-billing-section.tsx`) | QuotaStatus row; "FREE: 200 เครดิต ≈ 100 นาที… ลายน้ำ… ใช้เสียง Gemini พื้นฐาน…" (:160-165); balance 3 ช่อง (แถม/โปรโมชัน/ซื้อ); pack cards; ประวัติจ่าย "PRO Plan · 365 วัน ฿X" | tab billing | `/pricing` (การ์ดบน) / buy pack | ไม่มี | (b) "ลายน้ำ" — ไม่พบ enforce ที่อื่นใน copy (ตรวจเพิ่ม); (a) trial เห็น balance 0/0/0 |
| **Gallery** (`videos/page.tsx:289`) | "หมดอายุตามแพ็กเกจ Free 3 · Pro 7 · Business 14 วัน" | | ไม่มี CTA | | (d) จุดที่ควรบอก trial ว่า "คลิปนี้จะถูกลบใน 3 วันหลัง trial หมด — สมัครเพื่อเก็บ 7 วัน" |
| **Notifications/crons** | trial-expiry → `revertExpiredEntitlements` → "ทดลอง PRO หมดอายุแล้ว / กลับเป็น Free แล้ว (เหลือ 5 นาที/เดือน) อัปเกรด…" (`entitlements.ts:359-365`); renewal-reminders (ข้อ 3); day-21 "สิทธิ์แคมเปญครบ 21 วัน — สมัครรายเดือนต่อ" (`day21-convert-reminder.ts:2-4`, เฉพาะ paid-equivalent ไม่ใช่ trial) | | ไม่มี deep link ในตัว notification | ไม่มี | (d) **ไม่มี pre-expiry สำหรับ trial โดยตั้งใจ** (มีแต่ตัวผิดจาก renewal cron); ไม่มี "expired + คลิปจะหาย" email |
| **KeyOnboardingWizard/Checklist** (`KeyOnboardingWizard.tsx:85`, `KeySetupChecklist.tsx:27`) | "ตั้งแค่ 2 อย่าง" (managed → จริงๆ 1), "(0/1)" | tier1 ไม่ครบ | ไม่มี | **ไม่มี** (dismiss เรียก `/api/user/onboarding/dismiss` แต่ไม่ log event) | (d) ไม่รู้ key-setup drop-off จาก telemetry; insights ใช้ DB column แทน (`insights/route.ts:957-958`) — ใช้ได้ |

### 1.3 สารบัญข้อความ trial/cap ทั้งหมด + mismatch กับ `plan-limits.ts`

| ข้อความ | ไฟล์:บรรทัด | เทียบ source | สถานะ |
|---|---|---|---|
| "PRO ฟรี 7 วัน · 15 นาที" | `page.tsx:228`, `:146`, `:439`; `auth-shell.tsx:108,162,171`; `mobile-sticky-cta.tsx:42`; `pricing-toggle.tsx:121`; `pricing-client.tsx:482,502`; `trial-banner.tsx:26`; `pricing-client.tsx:247`; `marketing-plan-facts.ts:70`; `plan-config.ts:22` | 7 วัน / 15 นาที | ✔ ตรง (10+ จุด hardcode — ควรดึงจาก `TRIAL_DAYS_PUBLIC`/`TRIAL_MINUTES`; ตอนนี้มีเฉพาะ `marketing-plan-facts.ts` ที่ดึง) |
| "ช่วงทดลอง 7 วันสิ้นสุดแล้ว" (Hero AI Image) | `Step2Elements.tsx:1141` | ✔ | |
| "คุณมี 80 นาที/เดือน" (trial) | `DashboardOnboarding.tsx:39` → `ModelExplainerPanel.tsx:33` | ❌ trial = 15 | **mismatch** |
| FREE "5 นาที/เดือน · ~5 คลิป" | `pricing-client.tsx:251`; `docs/minutes-credits.tsx:21`; `admin/page.tsx:434`; `entitlements.ts:359` (ไม่มี ~5) | clips=2 | **ขัดกับ `clips:2`** (แต่ 2 ไม่ enforce ใต้ minute mode) |
| FREE "สูงสุด 2 คลิป/30 วัน" | `marketing-plan-facts.ts:64` (landing + /pricing card) | clips=2 | ตรง code แต่ **ไม่ตรงพฤติกรรมจริง** |
| PRO "~80 คลิป" | `upgrade-modal.tsx:27`; `pricing-client.tsx:269`; `docs:22` | clips=100 | ขัดกับ card "สูงสุด 100 คลิป" |
| BUSINESS "~150 คลิป" | `video-editor/page.tsx:1298` (v1); `docs:23`; `admin/page.tsx:438` | clips=300 | ขัดกับ card "สูงสุด 300 คลิป" (`plan-config.ts:36`) |
| "ปิด … ตัดต่อในเว็บ" หลัง trial | `pricing-client.tsx:251` | `allowVideoEditor:false` แต่ไม่ enforce ใน v2 | **โกหก** |
| "Pro only feature" (Videos tile) | `dashboard/page.tsx:291` | FREE render ได้ | **ผิด** |
| "ลายน้ำ" FREE | `credits-billing-section.tsx:162` | ไม่มี field ใน plan-limits | ยืนยันไม่ได้จาก plan-limits |
| "8 ภาพ" starter | `Step2Elements.tsx:1139`, `fetch-stock/route.ts:1720,2040`, `internal-ai-access.ts:201`, `video-hero-image.server.ts:219,333` | `STARTER_AI_IMAGE_ALLOWANCE_LIMIT=8` | ✔ แต่ hardcode 5 จุด |
| "เก็บวิดีโอ 3/7/14 วัน" | `videos/page.tsx:289`, `dashboard:371`, `plan-config.ts:22,29,36` | ✔ | |
| Business "Priority support" / "ภายใน 24 ชม." | `dashboard:371`, `video-editor/page.tsx:1298` | ไม่มี SLA ใน code | copy สัญญาที่ไม่มี backing |

### 1.4 คำตัดสิน (a)(b)(c)(d)

**(a) ช่วยตัดสินใจจ่าย หรือสร้างความกลัว/งง**
- Trial ใน 60 วินาทีแรกเห็น: `15/15 นาที`, `Hero credits 0`, "คุณมี 80 นาที", "สิทธิ์ภาพ 8", "2 เครดิต/นาที", "HeyGen ตามวินาที" → 6 ตัวเลข 4 หน่วย ก่อนคลิปแรก **ควรเหลือ 1 ตัวเลขเดียว: "เหลือ 15 นาทีลอง — พอทำ ~5 คลิป"** และซ่อนเครดิตทั้งหมดจนกว่า (i) เป็น PRO จ่ายแล้ว หรือ (ii) โควต้าเหลือ < ความยาวคลิปที่กำลังจะทำ
- Receipt สำหรับ trial ที่อยู่ในโควต้า: ดี (บอก "รวมในแพ็กเกจ") — แต่บรรทัด disclaimer + HeyGen ทำให้ 1 คลิกกลายเป็น 4-6 บรรทัดอ่าน; ควรพับเป็น "แสดงรายละเอียด"
- QuotaStatus low threshold `remaining ≤ 10` (`quota-status.tsx:54`) ผิดสเกลกับ trial 15 → amber ตั้งแต่ใช้ 5 นาที

**(b) ความไม่สอดคล้องข้าม surface** — ดู §1.3 + ข้อ 2/5/8 ในสรุป. เพิ่มเติม: landing โชว์ยอดจ่ายรายปีเต็ม (`pricing-display.ts:71-72`) แต่ /pricing ตั้งใจซ่อน (`pricing-client.tsx:193`) — นโยบายใน CLAUDE.md บอกซ่อนทั้งคู่

**(c) Dead ends**
1. Quota 409 ใน v2 → toast object (ข้อ 1)
2. Receipt "ไม่พอ" → "เติมเครดิต" สำหรับ trial/FREE ที่จริงต้องการ subscribe; `from=editor` ไม่มีใครอ่าน
3. Starter allowance exhausted → UpgradeModal ✔ แต่ `hideCta` เมื่อ `feature_off/suspended` (`Step2Elements.tsx:1150`) — ถูกต้อง
4. Dashboard Videos tile "Pro only" — gate ที่ไม่มีอยู่จริง (reverse dead end: ขู่แล้วไม่ต้องจ่าย)
5. Trial-ended notification ไม่มี link; TrialBanner หลังหมดพาไป /pricing ที่ default annual PromptPay
6. Credit pack "ซื้อเครดิต →" จาก /pricing วิ่งไป settings แล้วค่อยกดซื้อ (2 hop)

**(d) สิ่งที่ขาดเพื่อ conversion**
- Progress-to-first-export บน dashboard/trial banner: "ตั้ง key ✓ → เขียนสคริปต์ → Render → Export" (มี `firstClipPath` จาก `/api/user/me:113` แล้ว ใช้แค่ใน Step1/Step2)
- Urgency ramp: วัน ≤2 เปลี่ยนสี/ข้อความ + นับคลิปที่จะหมดอายุ (Video.expiresAt)
- Pre-expiry email/notification วัน 5 (แทน renewal cron ที่ยิงผิด) + post-expiry day+3 "คลิปถูกลบแล้ว"
- "What you keep with PRO" ตอน Export สำเร็จ (นอกจาก FirstClipConvertPrompt ครั้งเดียว): เก็บ 7 วัน, 80 นาที, 50 เครดิต, Hero AI Image
- Social proof ในแอป: Founding N/100 ที่ขายไปแล้ว (มี data), จำนวนคลิปที่ระบบทำวันนี้
- Annual toggle: ถ้า North Star = recurring → default **monthly card** ใน in-app `/pricing` และให้ annual เป็น "บัตร ต่ออัตโนมัติ" ก่อน PromptPay; Founding ควรมี variant monthly หรือย้ายไปเป็น 12-เดือน sub ไม่ใช่ one-time
- 50 เครดิต/เดือนของ PRO ต้องอยู่ใน pitch ทุกจุด (pricing card, UpgradeModal, FirstClipConvertPrompt)

---

## PART 2 — ตัวเลขฝั่ง Admin

### 2.1 รายการทุก metric/panel + คำตัดสิน

**`/admin` overview (`admin/page.tsx:907-915, 1021-1048`; API `admin/stats/route.ts`)**

| การ์ด | ที่มา | ตัดสิน | เหตุผล |
|---|---|---|---|
| ผู้ใช้งานทั้งหมด (+วันนี้) | `user.count` | KEEP (เป็น denominator) | |
| ผู้ใช้ Free / ถูกระงับ | `totalUsers-paidUsers`, suspended | REMOVE | `paidUsers` = plan∈PRO/BUSINESS รวม trial+comped (comment :41-43 ยอมรับเอง) → "Free" ผิด; suspended = ops |
| เนื้อหา / วิดีโอ / รูปภาพ ทั้งหมด | `content/video/generatedImage.count` | REMOVE | ตัวเลขสะสม legacy (Content/GeneratedImage = ฟีเจอร์เก่า) ไม่ actionable |
| สมัครวันนี้ / 7 วัน | | KEEP → แปลงเป็น cohort table | |
| จ่ายจริง (เงินสด) · Studio/Bundle · รอหมดรอบ | `revenue-cohorts.ts` | KEEP | honest ✔ |
| Trial (ทดลอง) | `trialActive` | KEEP แต่ต้องคู่กับ **trial→paid %** | stock count เดี่ยวๆ ไม่บอกอะไร |
| Comped | | DEMOTE | ต้นทุน ไม่ใช่ North Star |
| MRR (list-price) | | KEEP + ป้าย "list price ไม่ใช่ cash" (มีใน insights แล้ว :365-367 แต่ overview ไม่มี) | |
| หมายเหตุ "paidUsers ≈ จ่ายจริง+Trial+Comped (ที่เหลือรอ cron)" | :1044-1046 | REMOVE | ประโยคยอมรับว่าตัวเลขบนไม่ตรง — ลบ `paidUsers` ไปเลย |
| Billing tab: Stripe config / Plan Configuration / Cost Rates | | DEMOTE (settings ไม่ใช่ metric) | |
| Storage tab: renders เกิน 1/3/7 วัน | | DEMOTE → ops | |

**`/admin/insights` (`insights/page.tsx`; API `insights/route.ts`)**

| Panel | ตัวเลข | ตัดสิน | เหตุผล |
|---|---|---|---|
| **North Star · MAPC** (:282-330) | activeRecurringPayers, activeCreators, creatorRate%, monthly/annual, outcomes video/script/image, history snapshot | KEEP แต่ **เปลี่ยนชื่อ** — นี่คือ *paid retention/engagement* ไม่ใช่ trial→paid | นิยาม recurring ถูกต้อง (`subscription-north-star.server.ts:67-102`) ใช้ต่อได้เป็นตัวหารฝั่ง "หลังจ่าย" |
| **North Star · Activation** (:335-370) | signups(all-time, ตัด @aoacademy) → completedFirstVideo (%) ; window vs prev; tiles จ่ายจริง/Trial/แจกฟรี; MRR at risk | KEEP แต่แก้ 2 อย่าง: (1) denominator = signups **ใน cohort window** ไม่ใช่ all-time (`route.ts:481-487` `signups` = ทั้งหมด; `windowSignups` มีแต่ไม่ใช้ในสูตร %); (2) นิยาม Activation = Video COMPLETED ไม่ใช่ **Export/Burn** — ต้องนับ `RenderJob` export/burn (jobType export) หรือ `Video.videoUrl` หลัง burn | ตอนนี้ "ได้วิดีโอเสร็จ" = preview เสร็จ ไม่ใช่ export |
| **Activation funnel** (:374-410) | สมัคร → เข้าใช้งาน → กดเริ่ม → ได้วิดีโอ → ทำซ้ำ ≥2 + Gemini/Stock key coverage | KEEP + เพิ่มขั้น "Export สำเร็จ" และ "จ่าย (recurring)" ต่อท้าย | ขาด 2 ขั้นที่เป็น North Star จริง; key coverage ใช้ DB column ✔ (ไม่ต้องรอ telemetry) |
| Health Score / Video completed / Error telemetry / เปิด Editor tiles (:413-416) | สูตร `route.ts:695-709` | DEMOTE → tab "System" | ops ล้วน; Health Score เป็น composite ที่ไม่มีใครตัดสินใจจากมันได้ (เอกสาร `INSIGHTS_REDESIGN.md:16` เองก็บอกว่าเคยหลอก) |
| งานจริง (server) — failed by stage/kind | jobOutcomes | DEMOTE → System | แต่ **`quotaFailed`** (`route.ts:993`) คือ pricing signal → ดึงตัวเดียวนี้ขึ้นไป North Star ("คนชนเพดาน N คน/สัปดาห์") |
| งานสร้างวิดีโอ — หลุดตรงไหน (job funnel) | created→broll→config→render→done | DEMOTE | ops |
| AI Notes / recommendations | | REMOVE | generic text |
| ขั้นตอน pipeline p50/p95, Status stuck, Error telemetry list | | DEMOTE → System | |
| Render (RenderJob), Web Vitals, Playback, B-roll Resource (:573-606) | | DEMOTE → System (collapsed by default) | เอกสาร §5 เสนอไว้แล้ว |
| **CostMarginPanel** (`cost-margin-panel.tsx`; `admin/costs/route.ts`) | COGS, Gross margin %, AI cost %, กำไร run-rate, break-even, provider split, top-cost users, trend | DEMOTE → tab "Finance" | สำคัญแต่ไม่ใช่ North Star รายวัน; ควรเพิ่ม **COGS ต่อ trial** (ต้นทุนแจกฟรี 15 นาที + 8 ภาพ) เพื่อคำนวณ CAC-equivalent ต่อ conversion |
| brand-visual-funnel (`brand-visual-funnel.ts`) | control vs treatment first-render-24h, retention 7d, gate 100 users | KEEP เป็น experiment panel (ยังไม่ mount ใน insights page — ตรวจไม่พบการเรียก) | pattern นี้ (observed-window denominator) คือสิ่งที่ trial→paid ควรใช้ |

### 2.2 สิ่งที่ขาดเพื่อ "รัน" North Star

| Metric | นิยาม | ได้จาก DB วันนี้? | ต้องเพิ่ม |
|---|---|---|---|
| **Trial→Paid (recurring) by signup week** | trials started week W → มี `recurringBillingCohort()` ≠ null ภายใน 14/30 วัน | **ได้บางส่วน** จาก `User.trialStartedAt` + `Payment` + `stripeSubscriptionId/subStatus` — แต่ไม่รู้ "วันที่จ่ายครั้งแรก" ต่อ user โดยตรง (ใช้ `Payment.paidAt` min) | panel ใหม่ + snapshot รายวันแบบ `northStarDailySnapshot` |
| Trial expiry outcome | ต่อ trial ที่หมด: converted-before / converted-after(N วัน) / expired-silent / expired-after-first-export | ได้จาก `trialEndsAt`(ถูกล้างเป็น null ตอน revert `trial.ts:88`!) → **หายหลัง revert** ต้องใช้ `UsedTrialEmail`+`trialStartedAt` | เก็บ `trialEndedAt` แทนการล้าง หรือ event `trial_expired` |
| Time-to-first-export (p50/p90) และ export-within-trial % | `RenderJob` export/burn แรกของ user − `createdAt` | ได้ (RenderJob.jobType/parentJobId) | query |
| Key-setup drop (managed → stock key) | signups ที่ไม่มี pexels/pixabay ภายใน 24h | ได้ (`hasStockKey` มีแล้ว :958) แต่ไม่ cohort | เพิ่ม window |
| Paywall funnel: shown → click → checkout_started → paid | ต่อ surface (`first_clip_convert_prompt`, `upgrade_modal`, `receipt`, `trial_banner`, `pricing`) | **ไม่ได้** — มีแค่ `pricing_cta_clicked` (3 surface) ไม่มี shown/checkout/paid | events ด้านล่าง |
| Checkout started vs paid (abandon %) | Payment PENDING vs PAID ต่อวัน, ต่อ period/method | ได้จาก `Payment.status` (PENDING มีใน settings :185) | panel |
| Quota-hit → upgrade | users ชน 409 (`quotaFailed`) → จ่ายใน 7 วัน | ครึ่งเดียว | event `quota_hit` |
| Source/UTM | `?source=` มีแค่ hero_script (`pricing-client.tsx:118`); affiliate script ฝั่งนอก | **ไม่ได้** | เก็บ `acquisitionSource` ที่ signup (Clerk metadata/`User.source`) |
| Churn reasons | cancel ใน Stripe portal ไม่มี reason | ไม่ได้ | Stripe cancellation_details webhook → `Subscription.cancelReason` |
| Founding velocity | seats ขาย/วัน, % ที่เป็น trial-converted | ได้ (`CouponRedemption`) | panel เล็ก |

### 2.3 Minimal telemetry event list (ปิดช่องว่าง)

`TelemetryEvent` (schema :883-906) มี `name/category/source/step/status/value/properties` พอแล้ว — ไม่ต้องแก้ schema. ใช้ `category:"product"`, `source:"server"` สำหรับตัวที่ยิงจาก webhook/cron.

| Event | properties | ยิงที่ |
|---|---|---|
| `signup_completed` | `{ source, trialGranted:boolean, managed:boolean }` | `src/lib/clerk-auth.ts` lazy-create หลัง `grantTrial` (server) |
| `trial_started` | `{ trialDays:7, trialMinutes:15, trialEndsAt }` | `trial.ts:grantTrial` หลัง update สำเร็จ (server) |
| `trial_expired` | `{ hadFirstExport, exportsCount, minutesUsed, daysSinceLastActive }` | `entitlements.ts:syncUserEntitlement` ก่อน createNotification (:360) (server) |
| `onboarding_key_saved` / `onboarding_dismissed` | `{ keyId, tier, surface:"wizard"\|"settings" }` | `KeyOnboardingWizard.tsx:test/saveAll/skip`, `/api/user/onboarding/dismiss` |
| `first_clip_path_step` | `{ step:"script"\|"elements"\|"render"\|"export", firstClipPath:true }` | ต่อจาก `editor_script_ready`/`editor_step2_reached` ที่มีแล้ว + เพิ่มที่ `submitExport` |
| `export_completed` (**Activation**) | `{ jobId, durationSec, minutesCharged, creditsSpent, isFirst:boolean, daysSinceSignup, plan, onTrial }` | `useV2Job.ts:223` (client, ที่เดียวกับ `hero-first-clip-completed`) **และ** server ที่ RenderJob export → DONE (source of truth) |
| `quota_hit` | `{ kind:"minutes"\|"clips"\|"credits"\|"duration"\|"starter_images", remaining, needed, plan, onTrial, canBuyCredits }` | `render/route.ts:quotaExceededResponse`, `receipt` insufficient line, `plan-limits.audioDurationLimitViolation` caller |
| `paywall_shown` | `{ surface:"first_clip_convert"\|"upgrade_modal"\|"receipt_insufficient"\|"trial_banner"\|"locked_upload"\|"founder_banner", feature?, reason?, daysLeft?, plan, onTrial }` | mount ของแต่ละ component (มี `locked_preview_viewed` แล้วสำหรับ Step2 — รวมเป็นชื่อเดียว) |
| `paywall_dismissed` | `{ surface }` | ปุ่ม "ไว้ทีหลัง"/X |
| `pricing_viewed` | `{ source, from, plan, onTrial, daysLeft, defaultPeriod, defaultMethod }` | `pricing-client.tsx` useEffect (ตอนนี้มีแค่ hero_script :118-123) |
| `pricing_cta_clicked` (มีแล้ว) | เพิ่ม `{ plan, period, method, couponCode?, founding }` ให้ครบทุก surface | `handleUpgrade`, `handleFoundingAnnual`, FirstClipConvertPrompt (มี) |
| `checkout_started` | `{ plan, period, method, amountThb, coupon, surface, sessionId(stripe) }` | `/api/payments/checkout` + `/api/payments/founding-annual` + `/api/payments/credits` (server) |
| `checkout_completed` | `{ plan, period, method, amountThb, recurring:boolean, daysSinceSignup, daysSinceTrialStart, hadFirstExport, exportsBeforePay, surface(จาก session metadata) }` | Stripe webhook `checkout.session.completed`/`invoice.paid` (server) — ใส่ `surface` ลง Stripe session metadata ตอน start |
| `checkout_abandoned` | `{ plan, period, method }` | `/pricing?payment=cancelled` (:218) + Payment PENDING > 24h (cron) |
| `subscription_canceled` | `{ plan, period, reason(stripe cancellation_details), monthsPaid }` | webhook `customer.subscription.updated/deleted` |
| `credit_pack_purchased` | `{ pack, baht, plan, onTrial }` | webhook |

ด้วย 15 ตัวนี้ + `dedupeKey` (มีอยู่) คำนวณได้ครบ: trial→paid by cohort, paywall funnel per surface, time-to-first-export, expiry outcome, checkout abandon, quota→pay.

---

## ภาคผนวก: บั๊ก/ข้อควรแก้เชิงโค้ดที่พบระหว่างรีวิว (ไม่ใช่ UX แต่กระทบตัวเลข)

1. `useV2Job.ts:486,576` — เทียบ `d?.error === "quota_exceeded"` แต่ server ส่ง `error` เป็น object; ควรอ่าน `d?.error?.code` และ surface `userAction` + `canBuyCredits` เป็น UpgradeModal (`hideCta:false`, `pricingHref:/pricing?source=quota_hit`).
2. `renewal-reminders/route.ts:27-34` — เพิ่ม `trialEndsAt: null` (หรือ `trialStartedAt: null`) ใน where เพื่อกัน trial; เขียน trial-specific reminder แยก (วัน 5 + วัน 7).
3. `DashboardOnboarding.tsx:38-40` — ใช้ `minutesLimit` จาก `/api/user/me` (มี `minutesLimit` แล้ว :57-61) แทน map hardcode.
4. `quota-status.tsx:54` — threshold `remaining ≤ 10` ควรเป็นสัดส่วนของ `limit` เท่านั้น (หรือ `≤ 3` ตอน limit ≤ 20).
5. `pricing/page.tsx:13` — รับ `from` ด้วย และส่งเข้า `pricing_viewed`.
6. `first-clip-convert.ts:24-26` — เพิ่มเงื่อนไข "one-time/PromptPay annual ที่ยังไม่หมดอายุ → ไม่แสดง" (หรือแสดงแค่ครั้งเดียวต่อ 30 วัน ด้วย DB flag แทน sessionStorage).
7. `trial.ts:88` / `entitlements.ts` revert ล้าง `trialEndsAt=null` → เสียหลักฐานสำหรับ cohort; เก็บ `trialEndedAt`.
8. `pricing-display.ts:71-72` landing sub โชว์ยอดปีเต็ม — ขัด policy "NO annual total" ใน CLAUDE.md (in-app ซ่อนถูกแล้ว).
9. `plan-config.ts:22` free_features มี "15 นาทีช่วงทดลอง / 5 นาที/เดือน" hardcode ใน SiteConfig default — `supplementalPlanFeatures` strip ได้เฉพาะ pattern ที่ตรง (`marketing-plan-facts.ts:90-110`); ถ้าแอดมินแก้ข้อความจนหลุด pattern จะโชว์ซ้ำกับ `corePlanFacts`.
10. `credits-billing-section.tsx:161-162` "ลายน้ำ" — ไม่พบ enforcement ใน `plan-limits.ts`; ยืนยันก่อนใช้เป็น loss-aversion copy.
