# A5 — สรุป error 14 วัน (2026-08-30 → 2026-09-12, เวลากรุงเทพฯ)

วัดแบบอ่านอย่างเดียว 2026-09-11 21:10 → 21:35 UTC (กรุงเทพฯ 2026-09-12 04:10 → 04:35), prod HEAD `84e4d8c2`
ไม่มีการเขียน/รีสตาร์ต/แก้ไฟล์บนเครื่อง production และไม่มีการ apply อะไรลง Linear เลย
แหล่งข้อมูล: Sentry `hero-studio-web` (อ่านผ่าน Chrome ที่ล็อกอินอยู่), PM2 logs, `SupportTicket`, `TelemetryEvent`

---

## 0. ช่วงเวลาที่วัดได้จริง (อ่านก่อนใช้ตัวเลข)

| แหล่ง | ครอบคลุมจริง | เหตุผล |
|---|---|---|
| `TelemetryEvent` (DB) | **14 วันเต็ม** 2026-08-30 → 2026-09-12 | ข้อมูลอยู่ใน DB ครบ |
| `SupportTicket` (DB) | **14 วันเต็ม** | เช่นกัน |
| Sentry | **14 วันเต็ม** (`statsPeriod=14d`) | retention ของ Sentry ครอบคลุม |
| PM2 logs | **2.40 วัน** (2026-09-09 18:31 → 2026-09-12 04:05 BKK) | PM2 เพิ่งเริ่มเขียน ISO timestamp เมื่อ 2026-09-09T11:31:07 UTC (A1 §Coverage caveat) ก่อนหน้านั้นแยกเป็นวันกรุงเทพฯ ไม่ได้ ไฟล์ log เก่าสุดบนเครื่องคือ 2026-09-07 |

**ตัวเลขจาก PM2 ทุกตัวในตารางนี้คือของ 2.40 วัน ไม่ได้คูณขยายเป็น 14 วัน** ช่องไหนที่มาจาก PM2 จะเขียนกำกับไว้

---

## 1. ตารางสรุป error 14 วัน

Error Source Class: `ours` (โค้ดเรา ไม่ว่ารันที่ไหน) · `customer-key` (คีย์/เครดิต BYOK ของลูกค้า) · `third-party-noise` (ส่วนขยายเบราว์เซอร์, in-app WebView, สคริปต์ที่ถูกฉีดเข้ามา) · `clerk-network` (เบราว์เซอร์ผู้เข้าชมต่อ CDN ของ Clerk ไม่ได้) · `unclassified`

| # | กลุ่ม error | แหล่ง | จำนวน 14 วัน | กระทบ (ผู้ใช้/ticket) | Error Source Class | แนะนำ | Linear ที่มี / ร่างใหม่ |
|---|---|---|---|---|---|---|---|
| 1 | **ติดคิวเขียน SQLite ตัวเดียว** — slow transaction ≥ 5 s, `Socket timeout`, `P1008`, `Transaction already closed` | PM2 | **ai-content** 217 slow-tx ≥ 5 s · **story-film-system-worker** 152 slow-tx ≥ 5 s + `lease failed` 102 (ทั้งสองชุดนี้คือ **2.40 วัน**) · marker: `Socket timeout` 73, `Transaction already closed` 101, `P1008` 23 (นับจากไฟล์ log ทั้งหมดที่มีบนเครื่อง คือตั้งแต่ 2026-09-07 ไม่ใช่ 14 วัน) | 54 จาก 219 (25 %) ของ slow-tx มี error ที่ผู้ใช้เห็นภายใน ±2 s · p50 hold 25.2 s, p90 30.2 s, max 46.3 s | `ours` | **แก้** | **HERO-10** → ร่าง `linear-drafts/HERO-10-reopen-comment.md` + `linear-drafts/perf-audit-umbrella.json` |
| 2 | **WebView/ส่วนขยายของเบราว์เซอร์ผู้เข้าชม** — `Error invoking postMessage: Java object is gone`, `Failed to connect to MetaMask`, `window.webkit.messageHandlers` | Sentry + telemetry | Sentry **183 จาก 226 events (81 %)** (7 groups) · `TelemetryEvent` **413 จาก 520 frontend_error (79 %)** | 0 บัญชีที่ล็อกอิน, 0 ticket · แต่ทำให้ตัวเลข error ฝั่ง `/admin/insights` ผิด | `third-party-noise` | **noise** (ต้องกรองฝั่ง telemetry) | ร่างใหม่ `linear-drafts/frontend-error-telemetry-noise.json` |
| 3 | **Hero AI Image RunPod `OUTPUT_INVALID`** | telemetry | `hero_ai_image_video_scene_error` 69 + `fetch_stock_server_error` 15 = **84** (7 วัน 09-05 → 09-11) | **20 บัญชี** · แนวโน้มขึ้น (09-05 = 1 → 09-09 = 23) | `ours` | **แก้** | ร่างใหม่ `linear-drafts/hero-ai-image-output-invalid.json` (ต่อจาก HERO-9 / HERO-12 ที่ Done แล้ว) |
| 4 | **brand visual preflight ถูกปฏิเสธ** — `schema_invalid` 27, `empty_provider_response` 13, ไม่ระบุ 1 | telemetry | **41** (+ `beat_count_mismatch` 6 ซึ่งเป็นของ HERO-26) · `pipeline_step_error` step `captions` 9 ครั้งที่ผู้ใช้เห็นข้อความ "ผลวิเคราะห์แนวภาพยังไม่สมบูรณ์" | **13 บัญชี** (captions 5 บัญชี) · 09-11 = 12 events (สูงสุดของช่วง) | `ours` | **แก้** | ร่างใหม่ `linear-drafts/brand-visual-preflight-invalid.json` · ส่วน `beat_count_mismatch` → **HERO-26** (Done, เฝ้าดู) |
| 5 | **401 บน endpoint ที่ poll อยู่เบื้องหลัง** (`auth_request_recovery`) | telemetry | **1,730 events** (`refreshing` 1,121 · `signed_out` 551 · `done` 495 · `refresh_failed` 56 · `retry_failed` 2) | 6–9 บัญชี/วัน · `/api/notifications` 981, `/api/editor-projects` 352, `/api/videos/usage` 338, `/api/credits/balance` 329 | `ours` | **แก้** | ร่างใหม่ `linear-drafts/auth-session-refresh-401-storm.json` |
| 6 | **เบราว์เซอร์ผู้เข้าชมต่อ CDN ของ Clerk ไม่ได้** — `failed_to_load_clerk_ui/js`, `ClerkJS: Network error` | Sentry + telemetry | Sentry **11** (5 groups) · telemetry **10** (`failed_to_load_clerk_ui` 9, `failed_to_load_clerk_js` 1) | 0 บัญชี · ไม่มี ticket | `clerk-network` | **เฝ้าดู** — **ห้ามใส่ `beforeSend`** ตามข้อบังคับของแผน | **HERO-19** (Done, เฝ้าดูถึง 09-18) |
| 7 | **MCP transport `Error: aborted`** (`POST /api/[transport]`) | Sentry + PM2 | Sentry **12 events** = PM2 **24 บรรทัด** `unhandledRejection: Error: aborted` (ตรงกันพอดี 2 บรรทัด/event) | 0 บัญชี · ล่าสุด 2026-09-11T21:03:39Z บน release `84e4d8c2` | `ours` | **เฝ้าดู** | ยังไม่มี issue — เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json`; เปิดใหม่ถ้าเกิน 5/วัน |
| 8 | **RSC stream ปิดก่อนเวลา** — `The destination stream closed early.` (`GET /ai-studio`) + `router state header ... could not be parsed` (`GET /(auth)/login`) | Sentry | 3 + 2 = **5** | 0 บัญชี | `ours` | **เฝ้าดู** | ยังไม่มี issue — เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json` |
| 9 | **stream controller ปิดแล้วยัง enqueue** (fatal, `GET /api/renders/*.mp4`) | Sentry | **2** (ล่าสุด 2026-09-08T03:43Z) | 0 บัญชี | `ours` | **เฝ้าดู** | **HERO-7** (Ready to Deploy) |
| 10 | **`play()` ถูก `pause()` ขัด** บน `/video-editor` | Sentry + telemetry | Sentry **3** · telemetry **13** · event สุดท้าย 2026-09-11T04:42Z **ก่อน** deploy ของ HERO-27 (09-11 19:08Z) · หลัง deploy = **0** | 1 session ต่อครั้ง | `ours` | **เฝ้าดู** (ตรงกับที่คาดหลัง fix) | **HERO-27** (Done, เฝ้าดูถึง 09-18) |
| 11 | **HeyGen avatar ผลลัพธ์ไม่ทราบสถานะ** — `avatar generate has unknown provider outcome` | telemetry | **2** (09-03, 09-09) | **2 บัญชี** · ticket `cmtvcdmm` (ปิดแล้ว, คืนเงินไม่ต้องเพราะเป็น label ค้าง) | `ours` | **เฝ้าดู** | **HERO-18** (Done, เฝ้าดูถึง 09-17) |
| 12 | **ชนเพดานแผน** — นาที AI-audio 15, ความยาวคลิปเกินแผน PRO 5 | telemetry | **20** | **4 บัญชี** | `ours` (กติกาธุรกิจ ไม่ใช่บั๊ก) | **เฝ้าดู** | **HERO-25** (Done) |
| 13 | **เครดิต/allowance หมด** — fetch-stock `402` 11, `insufficient_credits` 9, `ALLOWANCE_EXHAUSTED` 12, `ai_image_credit_reservation_rejected` 7 | telemetry | **39** | ~**9 บัญชี** (ทั้งหมด `fundingPolicy=conversion-trial`) | `ours` (กติกาธุรกิจ) | **เฝ้าดู** | เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json` |
| 14 | **คีย์ลูกค้าเต็มโควต้า** — ElevenLabs `401 quota_exceeded` | telemetry | **1** | **1 บัญชี** | `customer-key` | **เฝ้าดู** | เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json` |
| 15 | **b-roll coverage ไม่ครบ** — `broll_coverage_rejected` 3 + `render 422 broll_coverage_incomplete` 3 | telemetry | **6** | **3 บัญชี** | `ours` | **เฝ้าดู** | **HERO-12** (Done) |
| 16 | **`POST /api/videos` 500 ที่ข้อความไม่บอกสาเหตุ** + `render failed: Cannot find module .../@remotion/bun...` | telemetry | 9 + 1 = **10** (ทั้งหมด 2026-08-30) | **1 บัญชี** | `unclassified` (ข้อความ 500 ถูกกลบ จึงระบุสาเหตุจากข้อมูลที่มีไม่ได้) | **เฝ้าดู** | เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json` — ถ้ากลับมาซ้ำ ต้องเปิด issue เพราะ `Cannot find module` บน prod คือ defect จริง |
| 17 | **ไคลเอนต์ค้างเวอร์ชันเก่าหลัง deploy** — `ChunkLoadError` 6, `Server Action ... was not found on the server` 2 | telemetry | **8** (09-09 5, 09-10 2, 08-30/09-04 1) | 3 sessions | `ours` | **เฝ้าดู** | เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json` |
| 18 | **`Script error.` (cross-origin ทึบ)** | telemetry | **37** | — | `third-party-noise` | **noise** (ถูกกรองโดย `benignTelemetryReason` แล้ว) | `linear-drafts/frontend-error-telemetry-noise.json` (ครอบคลุมอยู่แล้ว ไม่ต้องเปิด issue แยก) |
| 19 | **เน็ตผู้ใช้หลุดกลาง fetch** — `TypeError: Load failed` / `Failed to fetch` | Sentry + telemetry | Sentry **4** · telemetry **6** | 1–2 บัญชี | `unclassified` (ไม่มี stack ฝั่งเรา แยก "เน็ตผู้ใช้" กับ "เราตอบช้า" ไม่ได้) | **เฝ้าดู** | เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json` |
| 20 | **`frontend_error` ที่ไม่มีข้อความเลย** (`message` ว่าง, `errorName=Error`) | telemetry | **14** | 9 sessions / 6 หน้า | `unclassified` | **เฝ้าดู** | เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json` — ควรเก็บ `source`/`stack` ให้ครบก่อนจึงจะจัดชั้นได้ |
| 21 | **error เฉพาะจุดบน `/video-editor`** — `NotFoundError` 6 (มี frame ของเราเอง), `SyntaxError` 4, `ReferenceError: Can't find variable: EmptyRanges` 5 (`EmptyRanges` ไม่มีอยู่ใน `src/` เลย) | telemetry | 6 + 4 = **10** (`ours`) · 5 (`third-party-noise`) | 2–3 บัญชี · แต่ละกลุ่มเกิดวันเดียว | `ours` (NotFoundError/SyntaxError) · `third-party-noise` (EmptyRanges) | **เฝ้าดู** | เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json` |
| 22 | **event ที่เราสร้างเองเพื่อทดสอบ / ไม่ใช่ error** — `HTTP/1.1 Overhead` (level `info`) 5, smoke test ที่ ignore ไว้ 3, `Sentry.captureException is not a function` จาก `eval` 1 | Sentry | **9** | 0 บัญชี | `ours` (เราเป็นคนยิงเอง) | **noise** | `linear-drafts/perf-audit-umbrella.json` (บันทึกไว้เฉย ๆ ไม่ควรเปิด issue แยก) |

**รวม**: Sentry 226 events / 23 groups (unresolved) + 3 groups ที่ ignore ไว้ · telemetry `frontend_error` 520 rows · telemetry `category='error'` ทั้งหมด 2,537 rows · PM2 (2.40 วัน) 369 slow-tx ≥ 5 s สองแอปรวมกัน · ticket 19 ใบ

---

## 2. Support ticket 14 วัน (id 8 ตัวแรกเท่านั้น)

19 ใบ ระหว่าง 2026-08-30 → 2026-09-11 (ไม่มีใบใหม่ใน 09-12 ถึงเวลาที่วัด)

| category | จำนวน | ที่ยังเปิด |
|---|---:|---:|
| `BUG_CONFIRMED` | 10 | 0 |
| (ยังไม่ได้จัดหมวด) | 6 | 1 |
| `USER_CONFUSION` | 1 | 0 |
| `NEED_MORE_INFO` | 1 | 1 |
| `FEATURE_REQUEST` | 1 | 0 |

| severity | status | จำนวน |
|---|---|---:|
| HIGH | CLOSED | 8 |
| (ว่าง) | CLOSED | 5 |
| LOW | CLOSED | 2 |
| MEDIUM | CLOSED | 2 |
| MEDIUM | OPEN | 1 |
| (ว่าง) | OPEN | 1 |

ต่อวัน (กรุงเทพฯ): 08-30 = 5 · 08-31 = 4 · 09-02 = 1 · 09-04 = 2 · 09-05 = 1 · 09-07 = 2 · 09-09 = 1 · 09-10 = 2 · 09-11 = 1

ใบที่ผูกกับ Linear แล้ว: `cmtqxfam` → HERO-9 · `cmtr1o4p` → HERO-8 · `cmtvut72` → HERO-20 (ทั้งสาม Done)
**ที่ยังเปิดอยู่ 2 ใบ**: `cmtgs2r2` (`NEED_MORE_INFO`/MEDIUM, 08-31) และ `cmtm2hvc` (ยังไม่จัดหมวด, 09-04) — ทั้งคู่ไม่มี Linear และไม่แมปกับกลุ่ม error ใดในตารางที่ 1 ได้จากข้อมูลที่อนุญาตให้อ่าน (ห้ามอ่านเนื้อความ)

บริบท job: 14 วันมี VideoJob 1,119 งาน — `done` 991, `failed` **95 (8.5 %)**, `canceled` 33 · วันที่แย่สุด 08-30 (26/124) และ 09-11 (18/133)

---

## 3. Cross-check: Sentry ต่ำกว่าความจริงตรงไหน (A1 PM2 census)

| ชั้น | Sentry เห็น | PM2 เห็น (2.40 วัน) | อธิบาย |
|---|---:|---:|---|
| ติดคิวเขียน SQLite | **0 events** | 369 slow-tx ≥ 5 s (2.40 วัน) + 197 บรรทัด `Socket timeout`/`P1008`/`Transaction already closed` (ไฟล์ตั้งแต่ 09-07) | Prisma error ถูก catch แล้วตอบเป็น HTTP error ไม่เคย throw ออกไปถึง handler ของ Sentry — **Sentry จึงมองไม่เห็นปัญหาใหญ่ที่สุดของระบบเลย** |
| `unhandledRejection: Error: aborted` | 12 events | 24 บรรทัด | ตรงกันพอดี (1 event = 2 บรรทัด: `⨯ unhandledRejection` + `[instrumentation] unhandledRejection`) |
| `uncaughtException` | 0 | 2 บรรทัด | นอกช่วง timestamp จึงระบุวันไม่ได้ |
| `[API Error] ... ERROR_SYSTEM (capacity)` | 0 | 26 × `GET /api/brand-library`, 8 × `user/me`, 6 × `POST /api/scripts/generate`, 6 × `GET /api/credits/balance` ฯลฯ | ปลายทางของแถวที่ 1 ที่ผู้ใช้เห็นจริง ไม่มีอันไหนขึ้น Sentry |

**สรุป**: Sentry ครอบคลุมเฉพาะ error ฝั่งเบราว์เซอร์และ exception ฝั่ง Node ที่หลุดขึ้นไปถึง top level เท่านั้น ห้ามใช้ event count ของ Sentry เป็นตัวชี้วัดสุขภาพระบบ — ต้องอ่านคู่กับ PM2 และ `TelemetryEvent` เสมอ

---

## 4. ตัวกรอง noise: Sentry ทำแล้ว แต่ `TelemetryEvent` ยังไม่ทำ

PR #463 (`5b861bf8`, merge 2026-09-09T14:29 +07 = 07:29 UTC) เริ่มทิ้ง third-party browser noise ก่อนส่งขึ้น Sentry

| | ก่อน 2026-09-09T07:45Z | หลัง 2026-09-09T07:45Z |
|---|---:|---:|
| Sentry — WebView bridge / MetaMask (event สุดท้าย 09-09T07:44Z) | มี | **0** |
| `TelemetryEvent` — WebView bridge | 331 | **62** |
| `TelemetryEvent` — MetaMask | 8 | **10** |
| `TelemetryEvent` — iOS bridge | 1 | **1** |
| `TelemetryEvent` — `frontend_error` ทั้งหมด | 418 | 102 |

หลังตัวกรองลง prod แล้ว **73 จาก 102 แถว (72 %)** ที่ `TelemetryEvent` ยังเขียนอยู่คือ noise ชุดเดียวกับที่ Sentry ทิ้งไปแล้ว
`src/components/telemetry/telemetry-provider.tsx` ไม่มีตัวกรองใด ๆ และ `benignTelemetryReason()` (`src/app/api/admin/insights/route.ts:288`) ไม่มีกฎสำหรับ WebView bridge หรือ extension frame → **413 จาก 520 แถว (79.4 %) ถูกนับเป็น error ของเราบน `/admin/insights`**

ย้ำข้อบังคับ: **ห้าม** ใส่ `failed_to_load_clerk_js` หรือ error ของ sign-in/sign-up ลง `beforeSend` ไม่ว่าในกรณีใด (แถวที่ 6)

---

## 5. HERO-10 — ทำไมจึงร่างให้เปิดใหม่

เกณฑ์ปิดเดิม: *contention signature ใน PM2 error log < 5 ครั้ง/วัน ติดกัน 7 วัน* — **ยังไม่ผ่าน ไม่ว่าจะนับแบบไหน**

| วัน (กรุงเทพฯ) | slow-tx (1 บรรทัด = 1 event) | ที่ ≥ 5 s | p50 | p90 | max | `Socket timeout` + `Tx closed` + `P1008` (บรรทัด) |
|---|---:|---:|---:|---:|---:|---:|
| 09-09 (ตั้งแต่ 18:31) | 42 | 42 | 29,497 ms | 39,215 ms | 45,572 ms | 26 |
| 09-10 | 99 | 98 | 20,241 ms | 30,147 ms | 46,302 ms | 18 |
| 09-11 | 72 | 71 | 27,035 ms | 30,137 ms | 45,284 ms | 9 |
| 09-12 (ถึง 03:47) | 4 | 4 | 20,701 ms | 30,062 ms | 30,089 ms | — |

รวม 2.40 วัน (n = 217): p50 **25,166 ms** · p90 **30,191 ms** · max **46,302 ms** · 150 จาก 219 (68.5 %) ตกอยู่ภายใน ±500 ms ของ timeout ที่ตั้งไว้

- เกณฑ์คือ < 5/วัน แต่วัดได้ **42 / 98 / 71** ต่อวัน (นับแบบ 1 บรรทัด = 1 event ไม่มีการพองจาก stack)
- แม้หารบรรทัด marker ด้วย 3 ตามที่ comment เดิมเตือนไว้ ก็ยังได้ ≈ 8.7 / 6.0 / 3.0 ต่อวัน → 2 ใน 3 วันยังไม่ผ่าน
- เกณฑ์ข้อสาม (telemetry ไม่โต) ก็ยังไม่ผ่าน: `TelemetryEvent` = 149.41 MB = **28.3 %** ของ DB, 305,452 แถว, **66 % เก่ากว่า 30 วัน**, ยังไม่มี retention job ใน `ecosystem.config.js`

ร่าง comment: `docs/plans/reports/linear-drafts/HERO-10-reopen-comment.md`

คำสั่งที่ **ตั้งใจจะรัน** (ยังไม่ได้รัน และห้ามรันจนกว่า Mew จะสั่ง):

```bash
cd /Users/mewsocialmacmini/projects/AI_content_Mew_social-perf-audit-reports
LINEAR_CLI=.agents/skills/hero-studio-ops/scripts/linear.mjs
node "$LINEAR_CLI" comment HERO-10 --file docs/plans/reports/linear-drafts/HERO-10-reopen-comment.md   # preview
node "$LINEAR_CLI" transition HERO-10 "Triage"                                                          # preview
# --apply เฉพาะเมื่อ Mew สั่งในข้อความนั้น ๆ
```

---

## 6. ร่าง Linear ทั้งหมด (ยังไม่ apply อะไรเลย)

| ไฟล์ | ชนิด | state / priority | labels | แถวที่อ้างถึง |
|---|---|---|---|---|
| `linear-drafts/HERO-10-reopen-comment.md` | comment + `transition HERO-10 "Triage"` | — | — | 1 |
| `linear-drafts/perf-audit-umbrella.json` | issue ใหม่ | Triage / P2 | Improvement · Area / Infra · Execution / Agent-ready · Risk / Production | 1, 7, 8, 13, 14, 16, 17, 19, 20, 21 |
| `linear-drafts/hero-ai-image-output-invalid.json` | issue ใหม่ | Triage / P2 | Bug · Area / B-roll · Execution / Agent-ready · Risk / Production | 3 |
| `linear-drafts/brand-visual-preflight-invalid.json` | issue ใหม่ | Triage / P3 | Bug · Area / Brand · Execution / Agent-ready · Risk / Production | 4 |
| `linear-drafts/auth-session-refresh-401-storm.json` | issue ใหม่ | Triage / P3 | Improvement · Area / Infra · Execution / Agent-ready · Risk / Production | 5 |
| `linear-drafts/frontend-error-telemetry-noise.json` | issue ใหม่ | Triage / P3 | Improvement · Area / Infra · Execution / Agent-ready · Risk / Production | 2, 18 |

คำสั่งที่ **ตั้งใจจะรัน** สำหรับ issue ใหม่ (ยังไม่ได้รัน):

```bash
for f in perf-audit-umbrella hero-ai-image-output-invalid brand-visual-preflight-invalid \
         auth-session-refresh-401-storm frontend-error-telemetry-noise; do
  node "$LINEAR_CLI" create --file "docs/plans/reports/linear-drafts/$f.json"   # preview
done
```

---

## Method note (English)

**Window.** Fourteen Bangkok days ending 2026-09-12. Every day bucket is `date(col/1000,'unixepoch','+7 hours')` in SQLite and the line's own ISO timestamp + 7 h for logs — never the log file's name. The server runs `Etc/UTC` and PM2 rotates at 00:00 UTC = 07:00 Bangkok, so every rotated file straddles two Bangkok days.

**Sentry.** Read through Mew's already-signed-in Chrome, in a tab created for this task and closed afterwards. The issue stream was read with `GET /api/0/organizations/mew-social-k0/issues/` (`query=is:unresolved environment:production`, `statsPeriod=14d`, `project=4512028555804672`, `sort=freq`, `limit=100`) and per-issue detail with `GET /api/0/organizations/mew-social-k0/issues/<id>/` for release attribution. Nothing was resolved, ignored, assigned or commented on. `is:resolved environment:production` returned **0** groups in the window; `is:ignored` returned 3, all of them deliberate HERO-5 / post-deploy smoke events from 2026-09-04, counted as noise in row 22. Group titles were sanitised in the browser before they left the page (URLs → `<URL>`, emails → `<EMAIL>`, session ids → `sess_…`, hex ids ≥ 16 chars → `<ID>`); no event body, no screenshot and no customer identity was copied anywhere. `userCount` is 0 on every group by design — the SDK disables user collection (`src/lib/sentry-config.ts`), so user impact in this report comes from `TelemetryEvent.userId` counts, never from Sentry.

**Classification.** `docs/ops/linear-sentry-observability.md` is the rule source. Remotion shutdown noise, third-party browser noise and Clerk `/touch` network noise are already dropped in `beforeSend`, so anything still visible in Sentry is a candidate — which is why row 2 is large only *before* PR #463 reached production on 2026-09-09 and is zero in Sentry after it. **Error Source Class** is scored on where the error is thrown, not on who should fix it: an extension error thrown in a visitor's browser is `third-party-noise` even though the fix (filtering it) is ours. `unclassified` is used only where the available evidence genuinely cannot separate two causes (rows 16, 19, 20) — it is not a synonym for "small".

**Production.** Read-only throughout: `sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro"`, `pm2 status`, and `grep`/`sed`/`awk`/`sort`/`uniq`/`wc`/`ls` over `/root/.pm2/logs`. No write, no `VACUUM`, no write `PRAGMA`, no `pm2 restart|stop|start`, no file edit, no `.env` value read, no copy of the database off the box. Support tickets were selected as `substr(id,1,8)` with no `message`, `adminReply`, `imageBase64`, `email` or `name` column ever in a projection. Telemetry free-text was reduced to counts, enumerated codes (`errorCode`, `reason`, `providerErrorCode`, `fundingPolicy`) or messages sanitised through the same URL/email/id pipeline and capped at 80–110 characters; `path` values carrying a job or project id were normalised to `/<id>` before being written down.

**Counting.** `[prisma-slow-tx]` emits exactly one line per event, so those are event counts. `Socket timeout` / `Transaction already closed` / `P1008` are **line** counts and a single Prisma failure prints the marker on 2–3 stack lines — both readings are given wherever the difference could change a decision (section 5). Sentry `count` is scoped to the requested `statsPeriod`, so the 14-day and 3-day figures are not the same number seen twice.

**Not measured, and why.** PM2 coverage is 2.40 days, not 14 (section 0) — the 14-day PM2 column that the brief's table implies does not exist and was not invented. The two still-open support tickets could not be mapped to an error class because reading ticket text is forbidden by the plan. Row 16's opaque `POST /api/videos` 500 cannot be attributed further because the route returns a generic Thai message and the underlying error is not recorded in telemetry.

---

## Commands run on production (A5)

ทุกคำสั่งรันผ่าน `ssh -o ConnectTimeout=20 -i ~/.ssh/hostinger_heroai_codex root@72.62.196.230 'bash -s' <<'EOF' … EOF` — ด้านล่างคือ body ของ remote script ตามจริง

**A5-1 — schema ของ `SupportTicket` และ `TelemetryEvent`**
```bash
date -u '+%Y-%m-%dT%H:%M:%SZ'; TZ=Asia/Bangkok date '+%Y-%m-%d %H:%M:%S %Z'
sqlite3 --version
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" ".schema SupportTicket"
echo '--- TelemetryEvent schema ---'
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" ".schema TelemetryEvent"
```

**A5-2 — ticket census + telemetry shape (คำสั่ง 1–7)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "SELECT substr(id,1,8) AS id8, COALESCE(category,'(null)') AS category, COALESCE(severity,'(null)') AS severity, status, date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, CASE WHEN linearIssueIdentifier IS NULL THEN '-' ELSE linearIssueIdentifier END AS linear FROM SupportTicket WHERE date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' ORDER BY createdAt;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(category,'(null)') AS category, COUNT(*) AS n, SUM(CASE WHEN status='OPEN' THEN 1 ELSE 0 END) AS open_n FROM SupportTicket WHERE date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(severity,'(null)') AS severity, status, COUNT(*) AS n FROM SupportTicket WHERE date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COUNT(*) AS n FROM SupportTicket WHERE date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY 1;"
sqlite3 -readonly "$DB" -header -column "SELECT je.key AS prop_key, COUNT(*) AS n FROM TelemetryEvent te, json_each(te.properties) je WHERE te.name='frontend_error' AND date(te.createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT COUNT(*) AS events, COUNT(DISTINCT userId) AS users, COUNT(DISTINCT sessionId) AS sessions, MIN(date(createdAt/1000,'unixepoch','+7 hours')) AS first_day, MAX(date(createdAt/1000,'unixepoch','+7 hours')) AS last_day FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30';"
sqlite3 -readonly "$DB" -header -column "SELECT name, category, source, COUNT(*) AS n FROM TelemetryEvent WHERE date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND (name LIKE '%error%' OR name LIKE '%fail%' OR category='error') GROUP BY 1,2,3 ORDER BY n DESC;"
```

**A5-3 — `frontend_error` grouping (คำสั่ง 8–11)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "SELECT json_extract(properties,'\$.errorName') AS errorName, json_extract(properties,'\$.signature') AS signature, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions, COUNT(DISTINCT userId) AS users, MIN(date(createdAt/1000,'unixepoch','+7 hours')) AS first_day, MAX(date(createdAt/1000,'unixepoch','+7 hours')) AS last_day FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2 ORDER BY n DESC LIMIT 60;"
sqlite3 -readonly -noheader -separator $'\t' "$DB" "SELECT COALESCE(json_extract(properties,'\$.message'),'(no message)') FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30';" \
 | sed -E 's#(https?://|blob:|data:|chrome-extension://|webkit-masked-url:|file://).*$# <URL>#g; s#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}#<EMAIL>#g; s#\b[0-9a-f]{8,}\b#<ID>#g; s#\bsess_[A-Za-z0-9_-]+#sess_…#g; s#\b[A-Za-z0-9_-]{20,}\b#<ID>#g; s#[0-9]+#N#g' \
 | cut -c1-80 | sort | uniq -c | sort -rn | head -40
sqlite3 -readonly "$DB" -header -column "SELECT date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY 1;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(path,'(null)') AS path, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC LIMIT 25;"
```

**A5-4 — third-party marker counts (คำสั่ง 12–17)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "SELECT
 SUM(CASE WHEN properties LIKE '%Java object is gone%' OR properties LIKE '%Java exception was raised%' THEN 1 ELSE 0 END) AS webview_java_bridge,
 SUM(CASE WHEN properties LIKE '%MetaMask%' THEN 1 ELSE 0 END) AS metamask,
 SUM(CASE WHEN properties LIKE '%chrome-extension://%' THEN 1 ELSE 0 END) AS chrome_ext_frame,
 SUM(CASE WHEN properties LIKE '%webkit-masked-url%' THEN 1 ELSE 0 END) AS webkit_masked,
 SUM(CASE WHEN properties LIKE '%window.webkit.messageHandlers%' THEN 1 ELSE 0 END) AS webkit_handlers,
 SUM(CASE WHEN properties LIKE '%Script error.%' THEN 1 ELSE 0 END) AS script_error_opaque,
 SUM(CASE WHEN properties LIKE '%Clerk%' THEN 1 ELSE 0 END) AS clerk_any,
 SUM(CASE WHEN properties LIKE '%Loading chunk%' OR properties LIKE '%ChunkLoadError%' THEN 1 ELSE 0 END) AS chunk_load,
 SUM(CASE WHEN properties LIKE '%play() request was interrupted%' THEN 1 ELSE 0 END) AS play_abort,
 SUM(CASE WHEN properties LIKE '%Server Action%' THEN 1 ELSE 0 END) AS server_action_missing,
 COUNT(*) AS total
 FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30';"
sqlite3 -readonly "$DB" -header -column "SELECT COUNT(*) AS no_own_frame FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND properties NOT LIKE '%/_next/%' AND properties NOT LIKE '%studio.heroaiengine.com%';"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.errorName'),'(null)') AS errorName, COUNT(*) AS n FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND COALESCE(json_extract(properties,'\$.message'),'')='' GROUP BY 1 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(path,'(null)') AS path, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND (properties LIKE '%Java object is gone%' OR properties LIKE '%Java exception was raised%') GROUP BY 1 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT name, COUNT(*) AS n, COUNT(DISTINCT userId) AS users, MIN(date(createdAt/1000,'unixepoch','+7 hours')) AS first_day, MAX(date(createdAt/1000,'unixepoch','+7 hours')) AS last_day FROM TelemetryEvent WHERE category='error' AND source='server' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='auth_request_recovery' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY 1;"
```

**A5-5 — property keys ของ event ฝั่ง server (คำสั่ง 18–20)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "SELECT je.key AS prop_key, COUNT(*) AS n FROM TelemetryEvent te, json_each(te.properties) je WHERE te.name='auth_request_recovery' AND date(te.createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(status,'(null)') AS status, COALESCE(step,'(null)') AS step, COALESCE(path,'(null)') AS path, COUNT(*) AS n FROM TelemetryEvent WHERE name='auth_request_recovery' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2,3 ORDER BY n DESC LIMIT 20;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(step,'(null)') AS step, COALESCE(status,'(null)') AS status, COUNT(*) AS n, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='pipeline_step_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT je.key AS prop_key, COUNT(*) AS n FROM TelemetryEvent te, json_each(te.properties) je WHERE te.name='pipeline_step_error' AND date(te.createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC;"
for N in hero_ai_image_video_scene_error fetch_stock_server_error brand_visual_preflight_invalid ai_image_credit_reservation_rejected; do
  echo "--- $N ---"
  sqlite3 -readonly "$DB" -header -column "SELECT je.key AS prop_key, COUNT(*) AS n FROM TelemetryEvent te, json_each(te.properties) je WHERE te.name='$N' AND date(te.createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC;"
done
```

**A5-6 — error code breakdown (คำสั่ง 21–27)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.initialStatus'),'-') AS initialStatus, COALESCE(json_extract(properties,'\$.retryStatus'),'-') AS retryStatus, COALESCE(status,'-') AS status, COUNT(*) AS n FROM TelemetryEvent WHERE name='auth_request_recovery' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2,3 ORDER BY n DESC LIMIT 25;"
sqlite3 -readonly "$DB" -noheader "SELECT COALESCE(path,'(null)') FROM TelemetryEvent WHERE name='auth_request_recovery' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30';" | sed -E 's#/(c[a-z0-9]{20,}|[0-9a-f-]{16,})#/<id>#g' | sort | uniq -c | sort -rn | head -20
sqlite3 -readonly "$DB" -noheader -separator '|' "SELECT COALESCE(step,'-'), COALESCE(json_extract(properties,'\$.message'),'(none)') FROM TelemetryEvent WHERE name='pipeline_step_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30';" | sed -E 's#(https?://)[^ ]*#<URL>#g; s#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+#<EMAIL>#g; s#\b(c[a-z0-9]{20,}|[0-9a-f]{16,})\b#<ID>#g' | cut -c1-100 | sort | uniq -c | sort -rn | head -30
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.errorCode'),'-') AS errorCode, COALESCE(json_extract(properties,'\$.aiProvider'),'-') AS provider, COALESCE(json_extract(properties,'\$.systemicProviderFailure'),'-') AS systemic, COUNT(*) AS n, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='hero_ai_image_video_scene_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2,3 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.providerErrorCode'),'-') AS providerErrorCode, COALESCE(json_extract(properties,'\$.errorProvider'),'-') AS errorProvider, COUNT(*) AS n, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='fetch_stock_server_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.reason'),'-') AS reason, COALESCE(json_extract(properties,'\$.sourceKind'),'-') AS sourceKind, COUNT(*) AS n, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='brand_visual_preflight_invalid' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.fundingPolicy'),'-') AS fundingPolicy, COALESCE(json_extract(properties,'\$.provider'),'-') AS provider, COALESCE(json_extract(properties,'\$.surface'),'-') AS surface, COUNT(*) AS n, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='ai_image_credit_reservation_rejected' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2,3 ORDER BY n DESC;"
```

**A5-7 — PM2 crash-class cross-check (คำสั่ง 28–31)**
```bash
cd /root/.pm2/logs
for m in 'uncaughtException' 'unhandledRejection' 'UnhandledPromiseRejection' 'FATAL' 'ECONNREFUSED' 'ETIMEDOUT' 'out of memory' 'JavaScript heap'; do
  n=$(grep -c "$m" ai-content-error*.log ai-content-out*.log 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
  echo "$m = $n"
done
wc -l ai-content-error*.log | tail -20
cat ai-content-error*.log 2>/dev/null | sed -E 's#^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z?:? ##' | sed -E 's#(https?://)[^ ]*#<URL>#g; s#\b(c[a-z0-9]{20,}|[0-9a-f]{16,})\b#<ID>#g; s#[0-9]+#N#g' | cut -c1-90 | sort | uniq -c | sort -rn | head -30
pm2 status
```

**A5-8 — `[API Error]` census + log coverage (คำสั่ง 32–35)**
```bash
cd /root/.pm2/logs
grep -h '\[API Error\]' ai-content-error*.log ai-content-out*.log 2>/dev/null | sed -E 's#^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+[+0-9:]*: ##' | sed -E 's#/(c[a-z0-9]{20,}|[0-9a-f-]{16,})#/<id>#g' | cut -c1-80 | sort | uniq -c | sort -rn | head -30
grep -hE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*\[API Error\]' ai-content-error*.log ai-content-out*.log 2>/dev/null | cut -c1-13 | sort | uniq -c | awk '{print $2, $1}' | head -60
ls -la ai-content-out*.log ai-content-error*.log
grep -hc 'ECONNRESET' ai-content-error*.log 2>/dev/null | awk '{s+=$1} END{print "ECONNRESET lines:", s+0}'
grep -h 'unhandledRejection' ai-content-error*.log ai-content-out*.log 2>/dev/null | cut -c1-100 | sort | uniq -c | sort -rn | head -10
```

**A5-9 — insights benign-filter replay + daily series (คำสั่ง 36–39)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "WITH fe AS (SELECT properties AS p FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30'),
 c AS (SELECT p,
  CASE WHEN p LIKE '%play() request was interrupted by a call to pause%' THEN 'benign: play/pause'
       WHEN p LIKE '%__SUPERSEDED__%' OR p LIKE '%superseded%' THEN 'benign: superseded'
       WHEN p LIKE '%AbortError%' OR p LIKE '%aborted%' OR p LIKE '%cancelled%' OR p LIKE '%canceled%' OR p LIKE '%Request closed%' OR p LIKE '%cancelSignal%' THEN 'benign: cancel'
       WHEN trim(COALESCE(json_extract(p,'\$.message'),'')) IN ('Script error.','Script error') THEN 'benign: opaque script error'
       ELSE 'counted as an error by insights' END AS verdict,
  CASE WHEN p LIKE '%Java object is gone%' OR p LIKE '%Java exception was raised%' THEN 'webview-bridge'
       WHEN p LIKE '%MetaMask%' THEN 'metamask-extension'
       WHEN p LIKE '%chrome-extension://%' THEN 'chrome-extension-frame'
       WHEN p LIKE '%window.webkit.messageHandlers%' THEN 'ios-webview-bridge'
       ELSE 'not-obviously-third-party' END AS third_party
  FROM fe)
 SELECT verdict, third_party, COUNT(*) AS n FROM c GROUP BY 1,2 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND (properties LIKE '%Java object is gone%' OR properties LIKE '%Java exception was raised%') GROUP BY 1 ORDER BY 1;"
sqlite3 -readonly "$DB" -noheader "SELECT COALESCE(json_extract(properties,'\$.errorName'),'?')||' :: '||COALESCE(json_extract(properties,'\$.message'),'(empty)')||' :: '||COALESCE(path,'-') FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND properties NOT LIKE '%Java object is gone%' AND properties NOT LIKE '%Java exception was raised%' AND properties NOT LIKE '%MetaMask%' AND properties NOT LIKE '%chrome-extension://%' AND properties NOT LIKE '%window.webkit.messageHandlers%';" | sed -E 's#(https?://|blob:|data:|file://)[^ "]*#<URL>#g; s#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}#<EMAIL>#g; s#\b(c[a-z0-9]{20,}|[0-9a-f]{12,})\b#<ID>#g' | cut -c1-110 | sort | uniq -c | sort -rn | head -40
sqlite3 -readonly "$DB" -header -column "SELECT category, COUNT(*) AS n FROM TelemetryEvent WHERE date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC;"
```

**A5-10 — Clerk / play-abort / our-code detail (คำสั่ง 40–44)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.errorName'),'-') AS errorName, CASE WHEN properties LIKE '%failed_to_load_clerk_ui%' THEN 'failed_to_load_clerk_ui' WHEN properties LIKE '%failed_to_load_clerk_js%' THEN 'failed_to_load_clerk_js' WHEN properties LIKE '%Clerk%' THEN 'other-clerk' ELSE '-' END AS clerk_code, date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND (properties LIKE '%Clerk%' OR properties LIKE '%clerk%') GROUP BY 1,2,3 ORDER BY bkk_day;"
sqlite3 -readonly "$DB" -header -column "SELECT strftime('%Y-%m-%dT%H',createdAt/1000,'unixepoch') AS utc_hour, date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND properties LIKE '%play() request was interrupted%' GROUP BY 1,2 ORDER BY 1;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.errorName'),'-') AS errorName, date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COALESCE(path,'-') AS path, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND COALESCE(json_extract(properties,'\$.errorName'),'') IN ('ChunkLoadError','NotFoundError','ReferenceError','SyntaxError','TypeError','UnrecognizedActionError') GROUP BY 1,2,3 ORDER BY errorName, bkk_day;"
sqlite3 -readonly "$DB" -header -column "SELECT date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COALESCE(path,'-') AS path, COALESCE(json_extract(properties,'\$.source'),'-') AS src_basename, COUNT(*) AS n FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND COALESCE(json_extract(properties,'\$.message'),'')='' GROUP BY 1,2,3 ORDER BY 1;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.errorName'),'-') AS errorName, CASE WHEN properties LIKE '%/_next/%' THEN 'own-origin-frame' WHEN properties LIKE '%webkit-masked-url%' OR properties LIKE '%chrome-extension%' THEN 'injected-frame' ELSE 'no-frame-info' END AS origin, COUNT(*) AS n FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND COALESCE(json_extract(properties,'\$.errorName'),'') IN ('ChunkLoadError','NotFoundError','ReferenceError','SyntaxError','TypeError','UnrecognizedActionError','AbortError') GROUP BY 1,2 ORDER BY 1;"
```

**A5-11 — pipeline error buckets + daily series + job census (คำสั่ง 45–48)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "SELECT step, CASE
  WHEN properties LIKE '%fetch-stock%503%' THEN 'fetchStock 503 (provider/system)'
  WHEN properties LIKE '%fetch-stock%402%' THEN 'fetchStock 402 (credits)'
  WHEN properties LIKE '%/api/videos%500%' THEN 'render POST /api/videos 500 (opaque)'
  WHEN properties LIKE '%broll_coverage_incomplete%' THEN 'render 422 broll_coverage_incomplete'
  WHEN properties LIKE '%Cannot find module%' THEN 'render Cannot find module'
  WHEN properties LIKE '%renderMedia() got cancelled%' THEN 'burnSubtitles renderMedia cancelled'
  WHEN properties LIKE '%เกินเพดานแผน%' THEN 'plan cap: clip length'
  WHEN properties LIKE '%ครบ%' OR properties LIKE '%QUOTA_AI_AUDIO%' THEN 'plan cap: AI-audio minutes'
  WHEN properties LIKE '%แนวภาพ%' THEN 'brand visual analysis incomplete'
  WHEN properties LIKE '%unknown provider outcome%' THEN 'avatar unknown provider outcome'
  WHEN properties LIKE '%ElevenLabs failed%' THEN 'customer key: ElevenLabs quota'
  ELSE 'other' END AS klass, COUNT(*) AS n, COUNT(DISTINCT userId) AS users, MIN(date(createdAt/1000,'unixepoch','+7 hours')) AS first_day, MAX(date(createdAt/1000,'unixepoch','+7 hours')) AS last_day
 FROM TelemetryEvent WHERE name='pipeline_step_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COUNT(*) AS n, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='hero_ai_image_video_scene_error' AND json_extract(properties,'\$.errorCode')='OUTPUT_INVALID' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY 1;"
sqlite3 -readonly "$DB" -header -column "SELECT date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COUNT(*) AS n, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='brand_visual_preflight_invalid' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY 1;"
sqlite3 -readonly "$DB" -header -column "SELECT status, COUNT(*) AS n FROM VideoJob WHERE date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC;"
```

**A5-12 — before/after ตัวกรอง Sentry (คำสั่ง 49–50, รันซ้ำเป็น 49b เพราะรอบแรกคำนวณ epoch ผิด)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "WITH k(cut) AS (SELECT strftime('%s','2026-09-09T07:45:00')*1000)
SELECT CASE WHEN createdAt >= (SELECT cut FROM k) THEN 'after 2026-09-09T07:45Z' ELSE 'before' END AS era,
 SUM(CASE WHEN properties LIKE '%Java object is gone%' OR properties LIKE '%Java exception was raised%' THEN 1 ELSE 0 END) AS webview,
 SUM(CASE WHEN properties LIKE '%MetaMask%' THEN 1 ELSE 0 END) AS metamask,
 SUM(CASE WHEN properties LIKE '%window.webkit.messageHandlers%' THEN 1 ELSE 0 END) AS ios_bridge,
 COUNT(*) AS all_frontend_error
 FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1;"
sqlite3 -readonly "$DB" "SELECT 'cutoff = '||datetime(strftime('%s','2026-09-09T07:45:00'),'unixepoch')||' UTC';"
sqlite3 -readonly "$DB" -header -column "SELECT date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed, COUNT(*) AS total FROM VideoJob WHERE date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY 1;"
```

### คำสั่ง read-only นอกเครื่อง production (เพื่อความครบถ้วนของ trail)

```bash
# Linear — อ่านอย่างเดียว ไม่มี create/comment/transition และไม่มี --apply
cd /Users/mewsocialmacmini/projects/AI_content_Mew_social-perf-audit-reports
cp ../AI_content_Mew_social/.env .env          # .env* อยู่ใน .gitignore อยู่แล้ว ไม่เคย print ค่า
node .agents/skills/hero-studio-ops/scripts/linear.mjs --help
node .agents/skills/hero-studio-ops/scripts/linear.mjs list --limit 100
node .agents/skills/hero-studio-ops/scripts/linear.mjs issue HERO-10

# git — อ่านอย่างเดียว ในโฟลเดอร์ baseline
git log --oneline --date=short --pretty='%h %ad %s' -20 -- src/lib/sentry-config.ts
git log --format='%h | %cI | %s' --since=2026-09-09T00:00:00Z --until=2026-09-09T23:59:59Z main

# Sentry — GET เท่านั้น ผ่าน Chrome ที่ล็อกอินอยู่ (แท็บที่สร้างเองและปิดแล้ว)
GET /api/0/organizations/mew-social-k0/issues/?query=is:unresolved environment:production&statsPeriod=14d&project=4512028555804672&limit=100&sort=freq
GET /api/0/organizations/mew-social-k0/issues/?query=is:resolved environment:production&statsPeriod=14d&project=4512028555804672&limit=100&sort=freq
GET /api/0/organizations/mew-social-k0/issues/?query=is:ignored environment:production&statsPeriod=14d&project=4512028555804672&limit=100&sort=freq
GET /api/0/organizations/mew-social-k0/issues/?query=environment:production&statsPeriod=14d|3d|24h&project=4512028555804672&limit=100&sort=freq
GET /api/0/organizations/mew-social-k0/issues/<issueId>/     # 10 กลุ่ม เพื่อดู firstRelease/lastRelease
```
