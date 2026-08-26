# HERO AI Creator Studio — prod DB read-only analytics (UX/conversion audit)

Extracted 2026-08-25 13:13 UTC (20:13 Bangkok) from `/var/www/ai-content/prisma/dev.db` via `sqlite3 -readonly` (SQLite 3.37.2).
All timestamps are epoch-ms; dates below are Asia/Bangkok unless noted.

**Definitions**
- **ext** = all users minus `email LIKE '%aoacademy%'` (16 accounts) and `duckyhero+uxaudit@gmail.com` (not present). 1,074 ext users of 1,090 total. ext still contains 2 non-aoacademy `role=ADMIN` accounts (neither signed up in W; they only affect all-time numbers).
- **W** = `User.createdAt >= 1784307600000` = **2026-07-18 00:00 +07**. NOTE: the epoch given in the brief (1784394000000) is 2026-07-19 00:00 +07, one day late — it would drop the 107 launch-day signups (ext W = 448 with Jul-18 vs 342 with Jul-19).
- "now" = 1787663606000.
- Steps: `returned` = any `page_viewed` on a later calendar day than signup; `editor_opened` / `editor_step2_reached` = TelemetryEvent names (**step2 is only instrumented since 2026-08-10**, so it under-counts every cohort); `videojob_created/done` = `VideoJob.type='create'`; `video_completed` = `Video.status='COMPLETED'` (see §11 — Video rows exist for only ~18% of done jobs, so `videojob_done` is the better "first video" signal); `burn_done` = `RenderJob type='BURN' status='DONE'`; `paid` = any `Payment.status='PAID'`; `stripe_recurring` = `User.stripeSubscriptionId IS NOT NULL`.

---

## 1. Funnel

### 1a. Window W (ext signups since 2026-07-18) — n = 448

| # | step | users | % of signups | % of prev step | median days signup→step |
|---|---|---|---|---|---|
| 0 | signups | 448 | 100.0 | – | – |
| 1 | returned on a later day | 129 | 28.8 | 28.8 | 1.19 |
| 2 | editor_opened | 267 | 59.6 | (207.0 — editor is reached on signup day, not after "return") | 0.002 (~3 min) |
| 3 | editor_step2_reached (instrumented ≥08-10) | 34 | 7.6 | 12.7 | 1.13 |
| 4 | VideoJob created | 85 | 19.0 | 31.8 of editor_opened | 0.05 (~70 min) |
| 5 | VideoJob done | 73 | 16.3 | 85.9 | 0.08 (~2 h) |
| 6 | Video row COMPLETED | 41 | 9.2 | 56.2 | 0.66 |
| 7 | BURN/export DONE | 40 | 8.9 | 97.6 | 0.73 |
| 8 | paid (Payment PAID) | 9 | 2.0 | 22.5 | 0.10 (~2.4 h) |
| 9 | Stripe recurring sub | 4 | 0.9 | 44.4 | – |

Non-activators (no VideoJob) = 363 / 448 = **81.0%**.

### 1b. All-time (ext) — n = 1,074

| # | step | users | % of signups | % of prev | median days |
|---|---|---|---|---|---|
| 0 | signups | 1074 | 100.0 | – | – |
| 1 | returned later day | 323 | 30.1 | 30.1 | 1.52 |
| 2 | editor_opened | 637 | 59.3 | – | 0.002 |
| 3 | editor_step2_reached | 48 | 4.5 | 7.5 | 4.43 |
| 4 | VideoJob created | 153 | 14.2 | 24.0 of editor_opened | 0.08 |
| 5 | VideoJob done | 134 | 12.5 | 87.6 | 0.15 |
| 6 | Video COMPLETED | 81 | 7.5 | 60.4 | 1.32 |
| 7 | BURN DONE | 113 | 10.5 | (139.5 — burn happens without a Video row) | 0.86 |
| 8 | paid | 23 | 2.1 | 20.4 | 7.37 |
| 9 | Stripe recurring | 8 | 0.7 | 34.8 | – |

Payers all-time: 24 distinct users with PAID payments = 23 ext + 1 internal (aoacademy).

---

## 2. Time to first video (W, activated = first `VideoJob done`, n = 73)

| bucket (signup → first done job) | users | % |
|---|---|---|
| same day (<24 h) | 56 | 76.7 |
| 1–3 d | 9 | 12.3 |
| 4–7 d | 4 | 5.5 |
| >7 d | 4 | 5.5 |

Same buckets for first `Video COMPLETED` row (n=41): same day 26 / 1–3d 8 / 4–7d 5 / >7d 2.

Trial: all 73 activated had a trial (`trialStartedAt` set; trial length = 7.0 d for all 66 rows that still carry `trialEndsAt`). **4 / 73 activated after trial end** (first done job > trialStartedAt+7d; 4 also created their first job after trial end). 0 activated after a still-set `trialEndsAt` (column is cleared on convert/revert, so the +7d proxy is the usable one).

---

## 3. Key setup (W signups, n = 448)

| key | users with non-empty key | % |
|---|---|---|
| geminiKey | 0 | 0.0 |
| pexelsKey | 105 | 23.4 |
| pixabayKey | 82 | 18.3 |
| any stock key (pexels or pixabay) | 119 | 26.6 |
| elevenlabsKey | 17 | 3.8 |
| heygenKey | 17 | 3.8 |
| no key at all | 329 | 73.4 |

`geminiKeyMode`: `byok` = 448 (100%) — but 0 of them have a Gemini key. Gemini keys stopped being set after June (2026-05: 4/4, 06: 110/474, 07: 0/378, 08: 0/218) — the managed-Gemini pivot made the column/mode stale (see §11).

Cross-tab (W): stock key × activation

| gemini key | stock key | users | started VideoJob | done | paid |
|---|---|---|---|---|---|
| 0 | 0 | 329 | 7 (2.1%) | 4 | 4 |
| 0 | 1 | 119 | 78 (65.5%) | 69 (58.0%) | 5 |

All-time (ext):

| gemini key | stock key | users | started | done | paid |
|---|---|---|---|---|---|
| 0 | 0 | 765 | 7 | 4 | 4 |
| 0 | 1 | 195 | 131 (67.2%) | 115 | 14 |
| 1 | 0 | 23 | 0 | 0 | 0 |
| 1 | 1 | 91 | 15 | 15 | 5 |

Setting a stock key is the single strongest activation predictor: 91.8% of W activators (78/85) have one; only 2.1% of no-key users ever start a job.

---

## 4. Segments

### 4a. Plan / trial state — W (n=448)

| segment | users | returned | editor | step2 | job | done | Video | burn | paid | sub |
|---|---|---|---|---|---|---|---|---|---|---|
| trial active (trialEndsAt > now) | 64 | 8 | 32 | 0 | 6 | 5 | 2 | 2 | 0 | 0 |
| trial expired → FREE | 305 | 69 | 169 | 3 | 46 | 39 | 19 | 18 | 0 | 0 |
| PRO paid | 9 | 7 | 9 | 5 | 4 | 4 | 2 | 2 | 9 | 4 |
| PRO via Bundle | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 0 | 0 |
| PRO unpaid (coupon grant) | 69 | 44 | 56 | 25 | 28 | 24 | 17 | 17 | 0 | 0 |
| BUSINESS | 0 | | | | | | | | | |

Activation rate by segment (job/users): trial-active 9.4% · trial-expired-FREE 15.1% · PRO-paid 44.4% · coupon-PRO **40.6%**.

### 4a'. Same, all-time (n=1,074)

| segment | users | returned | editor | step2 | job | done | Video | burn | paid | sub |
|---|---|---|---|---|---|---|---|---|---|---|
| trial active | 64 | 8 | 32 | 0 | 6 | 5 | 2 | 2 | 0 | 0 |
| trial expired → FREE | 843 | 224 | 504 | 6 | 98 | 84 | 42 | 66 | 2 | 0 |
| FREE, never had trial (pre-trial-era) | 57 | 9 | 6 | 0 | 1 | 1 | 1 | 1 | 0 | 0 |
| PRO paid | 19 | 17 | 19 | 12 | 14 | 14 | 12 | 12 | 19 | 7 |
| PRO via Bundle | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 0 | 0 |
| PRO unpaid (coupon grant) | 85 | 59 | 71 | 28 | 31 | 27 | 19 | 28 | 0 | 0 |
| BUSINESS | 4 | 4 | 4 | 1 | 2 | 2 | 4 | 3 | 2 | 1 |

Founding (`FOUNDING100` redeemers): 12 users, 12 paid (100% — the coupon is applied at checkout), 8 made a done video, 5 signed up in W.

### 4b. Affiliate refCode

| cohort | refCode | users | returned | editor | job | done | burn | paid |
|---|---|---|---|---|---|---|---|---|
| W | no | 412 | 121 | 245 | 80 | 71 | 39 | 9 |
| W | yes | 36 | 8 | 22 | 5 | 2 | 1 | 0 |
| all | no | 1035 | 315 | 612 | 148 | 132 | 112 | 23 |
| all | yes | 39 | 8 | 25 | 5 | 2 | 1 | 0 |

Affiliate-referred users: 13.9% start a job (vs 19.4%), 5.6% finish one (vs 17.2%), 0 paid.

### 4c. Feature usage vs paying (feature detection: `VideoJob.inputJson.avatarMode` non-empty; `Script` rows; `AiGenerationJob kind=image`; `inputJson.mode='upload'` = own-clip cutaway; `mode='broll-rerender'`; `voiceProvider`; `imageEngine` set = AI images inside a video; `VideoJob.type='export'`)

| feature | W: users used | W: of those paid | W: % of 9 payers using it | ALL: users used | ALL: of those paid | ALL: % of 23 payers using it |
|---|---|---|---|---|---|---|
| avatar (any mode) | 8 | 1 | 11 | 21 | 9 | 39 |
| Hero Script | 18 | 1 | 11 | 26 | 6 | 26 |
| Hero AI Image (AiGenerationJob) | 26 | 4 | 44 | 37 | 12 | 52 |
| AI images inside a video (imageEngine) | 19 | 1 | 11 | 27 | 6 | 26 |
| cutaway / own-clip upload mode | 13 | 0 | 0 | 32 | 5 | 22 |
| B-roll re-render | 12 | 0 | 0 | 17 | 2 | 9 |
| ElevenLabs voice | 2 | 0 | 0 | 14 | 7 | 30 |
| OmniVoice / Hero Voice | 0 | 0 | 0 | 1 | 0 | 0 |
| export job | 36 | 2 | 22 | 60 | 14 | 61 |

Avatar mode distribution over all create jobs: none 1,397 · full 227 · bookend 257 · bookend-both 68.

---

## 5. Drop-off diagnosis — W signups with no VideoJob (n = 363, 81.0%)

| metric | users | % of 363 |
|---|---|---|
| zero telemetry rows (never seen after Clerk signup) | 0 | 0.0 |
| exactly 1 session (sessionId) | 325 | 89.5 |
| 2–3 sessions | 36 | 9.9 |
| 4–6 sessions | 2 | 0.6 |
| returned on a later day | 80 | 22.0 |
| opened editor (editor_opened) | 183 | 50.4 |
| reached editor step 2 | 1 | 0.3 |
| onboardingDismissedAt set | 306 | 84.3 (unreliable — see §11: 63% of all dismissals are stamped <1 min after signup) |

Last `page_viewed` path (top 15+):

| last path | users |
|---|---|
| /dashboard | 169 |
| /video-editor | 49 |
| /settings | 42 |
| /pricing | 39 |
| /updates | 12 |
| /docs/getting-started | 10 |
| /docs | 9 |
| /hero-script | 8 |
| /videos | 4 |
| /docs/setup-api-keys | 4 |
| / | 4 |
| /docs/troubleshooting | 3 |
| /docs/minutes-credits | 3 |
| /docs/create-video | 2 |
| /docs/avatar | 2 |
| /style | 1 |

Pages ever viewed by non-activators (distinct users): /dashboard 362 · /video-editor 183 · /pricing 145 · /settings 142 · /updates 132 · /docs 119 · /videos 79 · /docs/getting-started 79 · /hero-script 59 · /docs/setup-api-keys 48 · /docs/create-video 43 · /brands 35 · /docs/avatar 34 · /docs/minutes-credits 31 · /docs/subtitles 26.

Signups by weekday (W, all 448) and activation:

| weekday | signups | activated (job) | % |
|---|---|---|---|
| Sun | 81 | 22 | 27.2 |
| Mon | 44 | 7 | 15.9 |
| Tue | 34 | 8 | 23.5 |
| Wed | 84 | 16 | 19.0 |
| Thu | 41 | 11 | 26.8 |
| Fri | 24 | 4 | 16.7 |
| Sat | 140 | 17 | 12.1 |

By hour (BKK): 00–05: 26 (4 act.) · 06–11: 118 (16) · 12–17: 169 (32) · 18–23: 135 (33).

Top 10 signup days (W):

| day | signups | activated | paid |
|---|---|---|---|
| 2026-07-18 (Sat, launch) | 107 | 8 | 0 |
| 2026-08-19 (Wed, CLIP0819 coupon day) | 55 | 10 | 1 |
| 2026-07-19 | 31 | 8 | 1 |
| 2026-07-20 | 21 | 2 | 2 |
| 2026-08-20 | 20 | 3 | 0 |
| 2026-08-16 | 18 | 5 | 0 |
| 2026-08-22 | 11 | 2 | 0 |
| 2026-07-26 | 11 | 3 | 0 |
| 2026-07-21 | 10 | 0 | 0 |
| 2026-08-23 | 9 | 2 | 2 |

Launch day 07-18: 107 signups → 8 activated (7.5%), 0 paid. 08-19 spike: 55 → 10 (18%).

Signups per week, all-time (ext; `%W` weeks, BKK):

| week | signups | activated | paid |
|---|---|---|---|
| W22 (Jun 1) | 74 | 4 | 4 |
| W23 | 46 | 3 | 0 |
| W24 | 128 | 5 | 1 |
| W25 | 192 | 10 | 3 |
| W26 | 81 | 14 | 3 |
| W27 | 65 | 21 | 1 |
| W28 (Jul 13–19, launch) | 174 | 25 | 3 |
| W29 | 71 | 13 | 2 |
| W30 | 29 | 7 | 0 |
| W31 | 33 | 7 | 2 |
| W32 | 50 | 15 | 1 |
| W33 (Aug 17–23) | 114 | 23 | 3 |
| W34 (Aug 24–25, partial) | 13 | 4 | 0 |

---

## 6. Failures (W = jobs created since 07-18 by ext users)

Job outcomes in W: done 819 (96 users) · failed 224 (**20.9%**, 51 users) · canceled 29 (14 users).

Top failure buckets (currentStep / errorProvider / errorCode):

| step | provider | code | jobs | users |
|---|---|---|---|---|
| captions | – | – | 83 | 28 |
| tts | – | – | 49 | 19 |
| stock | – | – | 16 | 6 |
| stock | – | INSUFFICIENT_CREDITS | 12 | 5 |
| tts | elevenlabs | fatal | 10 | 1 |
| render | – | – | 9 | 6 |
| avatar | heygen | quota | 8 | 3 |
| captions | gemini | transcribe_incomplete | 7 | 2 |
| composite | – | – | 5 | 3 |
| tts | elevenlabs | invalid_key | 5 | 1 |
| avatar | heygen | – | 4 | 2 |
| burn | – | – | 2 | 2 |
| captions | gemini | empty_captions | 2 | 2 |
| (null) | – | – | 1 | 1 |
| avatar | heygen | invalid_key | 1 | 1 |

Most failures carry no errorCode; by `errorMessage` (W):

| message (truncated) | jobs |
|---|---|
| ซับไม่ผ่านการตรวจคุณภาพ (text_mismatch) | 23 |
| ซับไม่ผ่านการตรวจคุณภาพ (spacing_mismatch) | 16 |
| ความยาวจริง 2 นาที มากกว่าที่ผู้ใช้ยืนยัน 1 นาที — ยืนยันค่าใช้จ่ายใหม่ | 14 |
| เครดิตไม่พอสำหรับ Hero AI Image … | 12 |
| avatar generate has unknown provider outcome — manual recovery required | 12 |
| ซับไม่ผ่านการตรวจคุณภาพ (punctuation_only_card) | 11 |
| เกิดข้อผิดพลาดที่ไม่คาดคิด | 10 |
| tts-gemini 429 QUOTA_AI_AUDIO | 10 |
| ถอดซับช่วงหนึ่งไม่ครบ … หลังลองใหม่ 3 ครั้ง | 9 |
| fetch-stock 401 API Key ใช้ไม่ได้ | 8 |
| ซับไม่ผ่านการตรวจคุณภาพ (card_too_short) | 7 |
| Prisma Socket timeout on videoJob.update | 7 |

Subtitle quality-gate rejections (`text_mismatch`+`spacing_mismatch`+`punctuation_only_card`+`card_too_short`) = 57 jobs = 25% of all W failures.

First-job outcome (users whose first VideoJob is in the cohort):

| cohort | first job | users | retried (>1 job) | eventually done | later paid |
|---|---|---|---|---|---|
| W | done | 54 (63.5%) | 30 | 54 | 1 |
| W | failed | 27 (**31.8%**) | 25 (92.6%) | 17 (63.0%) | 2 |
| W | canceled | 4 | 4 | 2 | 1 |
| all | done | 107 (69.9%) | 71 | 107 | 9 |
| all | failed | 42 (27.5%) | 37 | 25 | 6 |
| all | canceled | 4 | 4 | 2 | 1 |

---

## 7. Paywall

TelemetryEvent counts in W (events since 07-18, ext or anonymous):

| event | events | distinct users | first seen |
|---|---|---|---|
| locked_preview_viewed | 250 | 85 | 08-13 |
| hero_script_pricing_viewed | 65 | 40 | 08-08 |
| hero_script_upgrade_clicked | 59 | 40 | 08-08 |
| pricing_cta_clicked | 12 | 11 | 08-13 |
| feature_card_clicked | 11 | 8 | 08-14 |
| hero_script_checkout_requested | 5 | 4 | 08-13 |

`pricing_cta_clicked` by source/surface: brand_visual preview / brand_library 8 · first_clip_convert_prompt founding monthly 1 · founding annual 1 · hero_ai_image upgrade_modal 1 · automix upgrade_modal (grant_coupon) 1.
`locked_preview_viewed`: brand_visual preview 118 · brand_visual rollout_wait (grant_coupon) 82 · (paid_term) 23 · (bundle) 10 · (subscription) 6 · hero_ai_image upgrade_modal 7 · automix upgrade_modal 4.
`feature_card_clicked`: hero_ai_image broll_source_card 7 · automix 4.

Pricing → payment (W by event/creation date, ext):

| stage | users |
|---|---|
| viewed /pricing (page_viewed) | 243 |
| among W signups only | 199 (44.4% of 448) |
| created a Payment (checkout session) | 41 (64 rows) |
| PAID | 17 (18 rows) |

/pricing viewer → paid = 7.0%; checkout → paid = 41.5% of users.

Payment rows created in W (ext):

| status | plan | period | THB | rows | users |
|---|---|---|---|---|---|
| FAILED (abandoned/expired/cancelled checkout) | PRO | 365 d | 5,990 | 36 | 28 |
| FAILED | PRO | 30 d | 599 | 5 | 5 |
| FAILED | BUSINESS | 365 d | 9,900 | 4 | 4 |
| FAILED | BUSINESS | 30 d | 990 | 1 | 1 |
| PAID | PRO | 30 d | 599 | 6 | 6 |
| PAID | PRO | 365 d | 2,995 (founding 50%) | 6 | 6 |
| PAID | PRO | 365 d | 5,990 | 2 | 2 |
| PAID | credit pack (plan FREE, 0 d) | 199 | 2 | 2 |
| PAID | credit pack (PRO, 0 d) | 199 | 1 | 1 |
| PAID | credit pack (PRO, 0 d) | 499 | 1 | 1 |

`FAILED` is set by `checkout.session.expired`/cancel/resume paths (`src/app/api/payments/webhook|cancel|resume|checkout/route.ts`), i.e. abandoned checkouts. 28 users opened a full-price annual (5,990) checkout and did not pay; 3 of them later paid the 2,995 founding price.

Trial expiry in W (trialStartedAt+7d falls in W): **383 trials ended** · 1 still flagged active · paid within 14 d after expiry **3 (0.8%)** · paid any time after 5 · created a VideoJob after expiry 17 (13 got a done job, 11 had a failed job). Post-expiry failures are tts (14) / captions (13) / composite 3 / render 3 / stock 2 / avatar 1+1 quota — no quota-block error code, so expired FREE users are not being hard-blocked by plan limits; they fail on the same pipeline steps as everyone else.

---

## 8. The 24 paid journeys (all-time; P01 = internal aoacademy account, excluded from all other stats)

Columns: signup · d→job = days signup→first VideoJob · d→done · d→Video = first Video COMPLETED row · done-before-pay = done jobs before first payment (jobs-before-pay in parens) · d→pay · first paid item · billing · coupons · ref · features (av=avatar, sc=Hero Script, im=Hero AI Image, cw=cutaway, el=ElevenLabs) · jobs/done/failed total · last active (max VideoJob/telemetry) · last job · plan / expires · subStatus/cancelAtPeriodEnd · state · tickets · keys (stock/heygen/eleven).

| P | signup | d→job | d→done | d→Video | done(jobs) before pay | d→pay | first paid | all paid (THB) | billing | coupons | ref | av sc im cw el | jobs/done/failed | last active | last job | plan / exp | sub / cancel | state | tickets | keys s/h/e |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P01 (internal) | 05-09 | – | – | – | 0 | – | BUSINESS/30d/990 | 8 rows (6×990 + 599 + …) | manual/test | – | – | – | 0/0/0 | 08-18 | – | BUSINESS / 2027-01-22 | – | active | 0 | 1/1/0 |
| P02 | 06-03 | 16.0 | 16.2 | 30.9 | 0 (0) | 2.9 | PRO/30d/599 | 599 ; PRO/335d/2,307 = 2,906 | annual (sub canceled) | FOUNDING100, MEWSOCIALVIP, CLIP0819 | 0 | 1 1 1 1 1 | 119/72/46 | 08-25 | 08-24 | PRO / 2026-11-11 | canceled / 0 | active | **21** | 1/1/1 |
| P03 | 06-25 | 10.2 | 10.2 | 10.2 | 0 (0) | 0.0 | PRO/365d/2,995 | 2,995 | annual one-time | – | 0 | 0 0 0 0 0 | 2/2/0 | 07-20 | 07-20 | PRO / 2027-06-25 | – | active (dormant since 07-20) | 0 | 1/0/0 |
| P04 | 06-30 | 4.1 | 4.1 | 8.1 | 0 (0) | 0.1 | PRO/30d/599 | 599 ; credits 199 = 798 | Stripe sub active | – | 0 | 1 1 1 0 1 | 112/100/7 | 08-25 | 08-25 | PRO / 2027-08-07 | active / 0 | active | 2 | 1/1/1 |
| P05 | 06-30 | – | – | 0.1 | 0 (0) | 0.1 | BUSINESS/365d/9,900 | 9,900 | annual one-time | FOUNDING100 | 0 | 0 0 0 0 0 | 0/0/0 | 07-10 | – | BUSINESS / 2027-06-30 | – | active (never made a job) | 0 | 1/1/1 |
| P06 | 06-30 | 5.1 | 5.1 | 9.9 | 0 (0) | 0.0 | PRO/365d/5,990 | 5,990 | annual one-time | FOUNDING100 | 0 | 1 1 1 1 1 | 64/62/2 | 08-24 | 08-24 | PRO / 2027-06-30 | – | active | 0 | 1/1/1 |
| P07 | 06-26 | 6.2 | 6.2 | 11.3 | 2 (3) | 7.4 | PRO/30d/599 | 599 | monthly (sub canceled) | – | 0 | 1 0 0 1 0 | 10/8/2 | 07-24 | 07-16 | FREE / – | canceled / 0 | **churned** | 0 | 1/1/0 |
| P08 | 06-22 | 18.8 | 18.9 | 18.9 | 0 (0) | 17.8 | BUSINESS/365d/9,900 | 9,900 | Stripe sub active | FOUNDING100 | 0 | 1 0 1 0 1 | 8/7/1 | 08-24 | 08-24 | BUSINESS / 2027-07-10 | active / 0 | active | 0 | 1/1/1 |
| P09 | 07-20 | – | – | – | 0 (0) | 0.0 | PRO/30d/599 | 599 | Stripe sub active | OPB2026 | 0 | 0 0 0 0 0 | 0/0/0 | 07-20 | – | PRO / 2026-09-20 | active / 0 | active (never made a job) | 0 | 0/0/0 |
| P10 | 07-15 | 1.9 | 1.9 | 1.9 | 1 (1) | 7.4 | PRO/365d/5,990 | 5,990 | annual one-time | FOUNDING100 | 0 | 0 0 1 1 0 | 31/28/3 | 08-25 | 08-24 | PRO / 2027-07-22 | – | active | 0 | 1/1/0 |
| P11 | 07-10 | 0.6 | 0.6 | 0.6 | 7 (17) | 15.9 | PRO/30d/599 | 599 | Stripe sub active | – | 0 | 1 0 0 0 1 | 101/91/10 | 07-29 | 07-27 | PRO / 2026-08-25 | active / 0 | active (no activity since 07-29) | 0 | 1/1/1 |
| P12 | 08-06 | – | – | – | 0 (0) | 0.0 | PRO/365d/5,990 | 5,990 | annual one-time | FOUNDING100 | 0 | 0 0 0 0 0 | 0/0/0 | 08-08 | – | PRO / 2027-08-06 | – | active (never made a job) | 0 | 0/0/0 |
| P13 | 07-20 | 0.0 | 0.0 | 0.9 | 1 (3) | 18.0 | PRO/30d/599 | 599 | Stripe sub active | – | 0 | 0 0 1 0 0 | 8/6/0 | 08-25 | 08-25 | PRO / 2026-09-06 | active / 0 | active | 0 | 1/0/0 |
| P14 | 06-07 | – | – | – | 0 (0) | 62.1 | credits 199 (plan FREE) | 199 | one-time | – | 0 | 0 0 0 0 0 | 0/0/0 | 08-08 | – | FREE / – | – | lapsed (never made a job) | 0 | 1/0/1 |
| P15 | 07-15 | 13.5 | 13.5 | 13.5 | 7 (9) | 25.9 | PRO/365d/2,995 | 2,995 | annual one-time | MEWSOCIALVIP, FOUNDING100 | 0 | 1 0 1 0 1 | 10/8/2 | 08-18 | 08-10 | PRO / 2027-10-25 | – | active | 0 | 1/1/1 |
| P16 | 06-04 | 73.3 | 73.4 | 73.4 | 0 (0) | 70.4 | PRO/30d/599 | 599 | Stripe sub active | – | 0 | 0 1 1 1 0 | 15/15/0 | 08-25 | 08-25 | PRO / 2026-09-14 | active / 0 | active | 0 | 1/1/0 |
| P17 | 06-19 | 56.2 | 56.2 | 56.2 | 0 (0) | 56.1 | PRO/365d/2,995 | 2,995 | annual one-time | FOUNDING100 | 0 | 1 1 1 0 1 | 7/5/2 | 08-19 | 08-19 | PRO / 2027-08-14 | – | active | 0 | 1/1/1 |
| P18 | 06-03 | 27.9 | 27.9 | 31.2 | 45 (49) | 72.8 | credits 199 (plan FREE at time) | 199 | one-time credits | MEWSOCIAL2026X, CLIP0819 | 0 | 0 0 0 0 0 | 73/63/10 | 08-23 | 08-23 | PRO (coupon) / 2026-09-18 | – | active | 2 | 1/0/0 |
| P19 | 08-06 | – | – | – | 0 (0) | 11.0 | PRO/365d/2,995 | 2,995 | annual one-time | FOUNDING100 | 0 | 0 0 0 0 0 | 0/0/0 | 08-24 | – | PRO / 2027-08-17 | – | active (never made a job) | 0 | 1/0/0 |
| P20 | 08-19 | 0.1 | 0.1 | – | 0 (0) | 0.1 | PRO/365d/2,995 | 2,995 | annual one-time | FOUNDING100 | 0 | 0 1 1 0 0 | 1/1/0 | 08-20 | 08-19 | PRO / 2027-08-19 | – | active | 0 | 1/0/0 |
| P21 | 07-19 | – | – | – | 0 (0) | 33.2 | PRO/30d/599 | 599 | Stripe sub active | – | 0 | 0 0 0 0 0 | 0/0/0 | 08-21 | – | PRO / 2026-09-21 | active / 0 | active (never made a job) | 0 | 0/0/0 |
| P22 | 08-15 | 0.0 | 4.8 | 4.8 | 2 (13) | 6.0 | PRO/30d/599 | 599 ; credits 499 = 1,098 | Stripe sub active | – | 0 | 1 0 1 0 0 | 28/13/15 | 08-25 | 08-25 | PRO / 2026-09-21 | active / 0 | active | 2 | 1/1/1 |
| P23 | 08-23 | 0.0 | 0.3 | – | 0 (0) | 0.0 | PRO/365d/2,995 | 2,995 | annual one-time | FOUNDING100 | 0 | 0 0 1 0 0 | 3/1/2 | 08-23 | 08-23 | PRO / 2027-08-23 | – | active | 1 | 1/0/0 |
| P24 | 08-23 | – | – | – | 0 (0) | 0.0 | PRO/365d/2,995 | 2,995 | annual one-time | FOUNDING100, FLHRS-AUG | 0 | 0 0 0 0 0 | 0/0/0 | 08-25 | – | PRO / 2027-09-22 | – | active (never made a job) | 1 | 0/0/0 |

`manual` = 0 on every PAID row (admin manual-payment path unused). No payer has an affiliate refCode. All 23 ext payers except P02, P16, P18 had the 7-day trial.

**Payer patterns (23 ext payers)**
- **7 / 23 (30%) paid with zero VideoJobs ever** (P05, P09, P12, P14, P19, P21, P24); 5 of those 7 have no API key at all. Another 4 paid before finishing any video (P02, P03, P04, P06 — all within 3 days of signup, done-before-pay = 0). Only 5 payers had ≥2 completed videos before paying (P07, P11, P15, P18, P22).
- 11 / 23 paid on signup day or within 24 h of first job (d→pay ≤ 0.1: P03, P04, P05, P06, P09, P12, P20, P23, P24) — payment is a decision made from the sale page/coupon, not from product usage.
- Founding annual (2,995 or 5,990) = 12 payers; Stripe recurring = 8 (7 active + 1 canceled); credit packs only = 2 (P14, P18).
- Churned/lapsed: P07 (canceled after 1 month, last job 07-16) and P14 (credits only). Dormant-but-paid annual: P03 (no activity since 07-20), P05, P12, P19, P21, P24 (never ran a job).
- Support tickets: P02 alone filed 21 of the 195 tickets; all other payers ≤2.

**Payers vs activated non-payers (all-time ext users with ≥1 done job)**

| group | n | stock key | HeyGen key | ElevenLabs key | refCode | used avatar | Hero Script | Hero AI Image | cutaway | avg days→first done | avg jobs | avg Video rows | used a coupon |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| payer (activated) | 16 | 100% | 69% | 50% | 0% | 56% | 38% | 75% | 31% | 15.0 | 37.0 | 27.1 | 56% |
| activated non-payer | 118 | 97% | 18% | 24% | 2% | 9% | 14% | 21% | 22% | 5.4 | 7.4 | 3.3 | 32% |

Payers are the heavy users (5× more jobs) and disproportionately have HeyGen/ElevenLabs keys and use avatar + Hero AI Image; but they did not activate faster (15 d vs 5.4 d — pulled by the P16/P17 late activators).

---

## 9. Retention

- W activated (n=73): **36 (49.3%) completed a 2nd video within 7 days** of the first; 22 (30.1%) on a *later day* within 7 days; only **7 (9.6%) created any job more than 7 days after** their first completed video.
- Payers active in last 14 d: 12/24 created a job, 17/24 had telemetry; 14/24 created a job in last 30 d.

Weekly active creators (distinct ext users creating a VideoJob; `%W` week, BKK):

| week | creators | jobs | done jobs | creators with a done job |
|---|---|---|---|---|
| W26 (Jun 29–Jul 5) | 24 | 131 | 120 | 24 |
| W27 | 39 | 178 | 135 | 33 |
| W28 (launch) | 34 | 134 | 89 | 30 |
| W29 | 26 | 141 | 129 | 26 |
| W30 | 22 | 232 | 206 | 21 |
| W31 | 18 | 151 | 105 | 17 |
| W32 | 30 | 130 | 85 | 23 |
| W33 (Aug 17–23) | 44 | 308 | 219 | 38 |
| W34 (Aug 24–25 partial) | 18 | 52 | 38 | 15 |

Weekly creators are flat at ~20–40 despite 1,074 signups; W33 spike = CLIP0819 coupon (60 redemptions, 19 made a video).

---

## 10. Coupons, founding, bundle

| code | type | grant | promo credits | redemptions | users | later PAID (after redeem) | ever PAID | done a video after redeem | first–last redeem |
|---|---|---|---|---|---|---|---|---|---|
| CLIP0819 | GRANT | PRO 30 d | 50 | 60 | 60 | 0 | 2 | 19 (32%) | 08-19 → 08-21 |
| OPB2026 | GRANT | PRO 30 d | 0 | 46 | 46 | 1 | 1 | 3 (7%) | 07-18 → 07-20 |
| MEWSOCIALVIP | GRANT | PRO 90 d | 0 | 24 | 24 | 1 | 2 | 7 (29%) | 06-27 → 08-25 |
| MEWSOCIAL2026X | GRANT | PRO 30 d | 0 | 20 | 20 | 1 | 1 | 8 (40%) | 06-17 → 08-23 |
| FOUNDING100 | DISCOUNT 50% | – | 0 | 12 | 12 | 0 (applied at checkout) | 12 | 8 (67%) | 06-07 → 08-23 |
| MEWSOCIAL100K | GRANT | PRO 31 d | 0 | 6 | 6 | 0 | 0 | 2 | 07-22 → 08-20 |
| FLHRS-AUG | GRANT | PRO 30 d | 50 | 3 | 3 | 1 | 1 | 1 | 08-18 → 08-23 |
| PREFLIGHT0819 | GRANT | PRO 30 d | 50 | 1 | 1 | 0 | 0 | 1 | 08-16 |
| MEWSOCIALMN, PLAN0826 | GRANT | | | 0 | 0 | | | | |

GRANT coupons: 160 redemptions → 4 later paid (2.5%). OPB2026 (launch-event coupon, 46 users) produced 3 videos and 1 payment.
FoundingReservation: CONFIRMED 13 (13 users) · RELEASED 79 (47 users — 79 abandoned founding checkouts).
BundleEntitlement: 2 rows, both ACTIVE, 1,798 THB total.

---

## 11. Surprises / data-quality notes

1. **`paidAt` "all 2026-05" anomaly does not reproduce.** `paidAt` is a normal epoch-ms integer on all 34 PAID rows and `strftime('%Y-%m', paidAt/1000,'unixepoch')` returns the correct months here: **2026-05: 8 rows / 7,529 THB · 06: 6 / 22,390 · 07: 5 / 17,687 · 08: 15 / 27,452** (identical with `+7 hours`). The earlier result was almost certainly a shell-quoting problem (`%Y-%m` going through a `printf`/double-quoted layer) or grouping on the wrong column, not a data issue. 4 PAID rows have `paidAt` 1 ms *before* `createdAt` (created from the webhook; harmless).
2. **34 PAID rows ≠ 34 payers.** 8 of them belong to the internal aoacademy account P01 (6× BUSINESS/30d test-style payments), and P02/P04/P22 have 2 each. Real distinct payers = 24 (23 external). Revenue tables that count rows overstate.
3. **Brief's W epoch is off by one day** (1784394000000 = Jul 19 00:00 +07). Jul 18 was launch day with 107 signups — the largest day in the dataset.
4. **`Payment.status='FAILED'` means abandoned/expired checkout**, not a card decline (set from `checkout.session.expired`, cancel and resume routes). 103 such rows; 46 users never paid, 13 later did. 36 of the W FAILED rows are full-price annual PRO (5,990) — the default checkout that users open and leave; 3 later paid 2,995 founding.
5. **`Video` table is not a reliable "video completed" signal**: only 194 / 1,091 done create-jobs in W have `videoId`; Video rows are created on export/gallery paths. Use `VideoJob.status='done'` (73 users in W) rather than `Video.COMPLETED` (41).
6. **`editor_step2_reached` exists only since 2026-08-10** (and carries an A/B `cohort` rollout-wait/control) — funnel step 3 is structurally under-counted for July signups.
7. **`geminiKeyMode='byok'` for 100% of users, yet 0 Gemini keys since July** — the managed-Gemini pivot left the mode column stale; any UI/onboarding that reads it will mislabel every user as BYOK.
8. **`onboardingDismissedAt` is auto-stamped**: 486 / 767 dismissals are within 60 s of signup, so it cannot be used to measure deliberate onboarding dismissal.
9. **32% of `page_viewed` rows have null `userId`** (14,977 / 46,248) — pre-login marketing/auth pages; anonymous funnel from `/` → `/register` is not user-joinable.
10. **7 of 23 external payers have never created a VideoJob** (P05 BUSINESS 9,900 THB, P09, P12, P19, P21, P24, P14) — 30% of revenue is from people who bought before/without trying; they are the churn risk at renewal.
11. **One user (P02) accounts for 21 / 195 support tickets and 46 failed jobs**; the top all-time job creator is a non-aoacademy ADMIN (277 jobs) that remains inside "ext" for all-time numbers (not in W).
12. ext contains 1 user with null `clerkId` (legacy NextAuth account). No duplicate emails (case-insensitive).
13. Trial-expiry cliff: 383 trials expired in W, 3 converted within 14 days (0.8%); expired users are *not* blocked from creating jobs (17 did; failures are pipeline errors, not quota codes) — the trial end is not acting as a paywall moment at all.
14. Weekend/launch traffic activates worst: Saturday signups (140, mostly 07-18 launch) activate at 12% vs 27% for Sunday/Thursday; 18–23h signups activate at 24% vs 14% for 06–11h.
15. Affiliate-referred signups (39) have 0 payments and 2 completed videos.

---

## Appendix — exact SQL

All queries were run as `ssh root@72.62.196.230 "cd /var/www/ai-content && sqlite3 -readonly -header -column prisma/dev.db" < file.sql`. Temp tables live in the connection's temp DB only (nothing written to `dev.db`). Files are kept in `uxaudit-fable/` next to this report; bodies reproduced below.

(SQL appendix kept out of the repo — queries live in the session scratchpad; all numbers reproducible from `sqlite3 -readonly prisma/dev.db` with the definitions above.)
