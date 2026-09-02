# Audit: `/brands` (Brand Library) และระบบสไตล์ — 2026-09-02

**ขอบเขต:** หน้า `/brands`, API `brand-library/*`, ระบบ Visual Format × Treatment, Content Preflight, เส้นทาง B-roll (stock / AI / AutoMix), และ Step 2 ของ editor ที่เกี่ยวกับสไตล์ — ตรวจจาก `origin/main` `6c7b95ea` (read-only), prod DB (SELECT อย่างเดียว อนุมัติโดยมิว), วิจัยเทรนด์จากแหล่งข้อมูลจริงผ่าน vidIQ (`docs/research/2026-09-02-faceless-short-video-style-trends.md`) และฟีดแบคทีมที่ทดสอบอยู่
**สถานะ:** ไม่มีการแก้โค้ดใน audit นี้ — ทุกข้อเสนอถูกแปลงเป็นแผน 3 wave (§9) และการตัดสินใจถูกบันทึกเป็น ADR 0057–0059 + `CONTEXT.md`
**ศัพท์:** ใช้ตาม `CONTEXT.md` (Brand Profile / Revision, Visual Format = แนวภาพ, Treatment Preset = แนวเล่าเรื่อง, ชุดสไตล์ = Style Pack, Stock Mood, Pacing)

---

## 1. สรุปผู้บริหาร

ระบบแบรนด์ที่มีอยู่ **ออกแบบมาดีในระดับโครงสร้าง** (revision แก้ไม่ได้, โปรเจกต์ pin revision, recipe มีเวอร์ชัน, มี benchmark ก่อนปล่อย, verify script 30+ ตัว) แต่ **ยังไม่ "ใช้งานได้จริง" ในสายตาผู้ใช้** ด้วยเหตุ 4 ชั้น:

1. **สไตล์ไปไม่ถึง stock B-roll เลย** — ระบบแนวภาพ/แนวเล่าเรื่องทั้งหมดส่งผลเฉพาะ Hero AI Image (ภาพ AI ที่คิดเครดิต) ส่วน stock (Pexels/Pixabay ที่ผู้ใช้ส่วนใหญ่ใช้ฟรี) มีเมนูสไตล์แยกอีกชุดใน Step 2 ที่ไม่คุยกับแบรนด์ และเมนูนั้น **ทำงานไม่ครบ** (§4) → แบรนด์ "หนังผีไทย" ได้ฟุตเทจสว่างธรรมดา นี่คือสาเหตุตรงของ "b-roll ไม่ล้อกัน"
2. **การเลือกสไตล์ยาก** — ผู้ใช้ต้องเข้าใจ 2 แกน (5 แนวภาพ × 8 แนวเล่าเรื่อง) + เมนู stock 8 ตัว; ผลคือบน prod ระบบ AI แนะนำ "ผู้เชี่ยวชาญอธิบายชัด" ให้ **79 % ของทุกคลิป** ไม่มีใครเคยล็อกแนวเล่าเรื่อง และ Brand Look Preview มีผู้ใช้จริงแค่ 2 คน
3. **ประตูปิดคนส่วนใหญ่** — หน้า `/brands` เปิดเฉพาะบัญชีจ่ายเงิน + ตาม % rollout, บัญชี trial สร้างแบรนด์ไม่ได้, คนที่ยังไม่เคยทำคลิปแรกถูก redirect ออก → ลูกค้า 1,144 คน สร้างแบรนด์แค่ 73 คน (6.4 %)
4. **บั๊กจริง 14 จุด** จากการอ่านโค้ด (§5) ที่หนักคือ ราคา Brand Look Preview บอกไม่ตรงกับที่หัก, ปุ่ม disable เงียบ ๆ, copy หลุดคำอังกฤษ, และ Content Preflight สำเร็จแค่ 63 %

**ทางออกที่เคาะแล้ว (Q1–Q8 กับมิว 2026-09-02):** ระบบสไตล์เดียวคุมทุกแหล่ง B-roll (ADR 0057) · เพิ่มชั้น **ชุดสไตล์** กดครั้งเดียว 12 ชุด บน 2 แกนเดิม (ADR 0058) · เปิด `/brands` ให้ทุกแผน gate เฉพาะภาพ AI (ADR 0059) · ชุดสไตล์คุม pacing ด้วย knob เดิม · ส่งมอบเป็น 3 wave: **wave 0 ซ่อมของเดิมให้ใช้ได้จริง → wave 1 ชุดสไตล์ 7 ชุด + stock mood + pacing → wave 2 แนวเล่าเรื่องใหม่ 5 แนว (การเมือง / dark story / ลึกลับ / ธรรมะ / โมทิเวชัน) หลังผ่าน benchmark**

---

## 2. วิธีตรวจ

| แหล่ง | ทำอะไร | ผลอยู่ที่ |
|---|---|---|
| โค้ด (read-only) | ไล่ flow `/brands` ทุก component/route, gate, downstream ทุกจุดที่ brand ถูกใช้, verify scripts, CI | §4–§6 |
| prod DB (SELECT only) | 10 กลุ่มคำถาม: ผู้ใช้/แบรนด์/treatment/preview/reroll/first-pass acceptance/stock-vs-AI/Step-2 prefs/telemetry/tickets | §3 (raw: scratchpad session, ตัวเลขสำคัญคัดมาไว้ที่นี่ครบ) |
| วิจัยเทรนด์ | 10 แนวเนื้อหา × ช่องจริง (vidIQ outliers/channel stats) → taxonomy 12 ลุค + อุปกรณ์สร้าง consistency | `docs/research/2026-09-02-faceless-short-video-style-trends.md` |
| ฟีดแบคทีม | 3 ข้อจากมิว: ใช้งานยาก / ภาพ-โทนมีไม่เยอะ / Step 2 advanced ใช้ไม่ได้จริง | §4 |

---

## 3. ตัวเลขจริงจาก prod (2026-09-02, ไม่รวมบัญชีทีม 17 บัญชี)

| ตัวชี้วัด | ค่า | ความหมาย |
|---|---|---|
| ลูกค้าทั้งหมด / จ่ายเงิน | 1,144 / 174 (PRO 170, BUSINESS 4) | ~15 % จ่าย |
| เคยสร้าง Brand Profile | **73 (6.4 %)** → publish จริง 48 | ฟีเจอร์เข้าถึงคนน้อยมาก |
| Brand Profile ทั้งหมด / revision เฉลี่ย | 126 / 1.26 ต่อโปรไฟล์ | สร้างครั้งเดียวแล้วไม่กลับมาแก้ |
| revision ที่มาจาก "บันทึกจากคลิป" (project-look) | **0 จาก 73** | เส้นทาง promote-from-clip ไม่เคยถูกใช้เลย |
| แนวเล่าเรื่องที่ถูก pin | expert-clarity **149/189 (79 %)**; horror 9, news 9, business 8, documentary 8, drama 4, product 2 | catalog มี 8 แต่ใช้จริงแทบแนวเดียว |
| AI แนะนำ (Content Preflight) | expert-clarity 230/311 (74 %); horror 47 | recommendation เอนไปทางเดียว |
| แนวภาพที่ AI แนะนำ | clear-infographic 298/410 (73 %) | ผลพวงเดียวกัน |
| pin source | adaptive 181 / creator 8 (96 % AI เลือก); **locked = 0 revision** | ไม่มีใครเจอ/ใช้ "ล็อกแนวเล่าเรื่อง" |
| Brand Look Preview | 29 batch / **2 ผู้ใช้** ตลอดกาล (ทั้งหมดใน 30 วัน) | แทบไม่มี reach |
| Scene Reroll | 31 ครั้ง / 5 ผู้ใช้; apply 65 % | ใช้ได้แต่ยังเล็ก |
| First-pass Visual Acceptance (expert-clarity) | export 12 vs reject 8 ≈ **60 %** | แนวอื่น ≤2 events ยังวัดไม่ได้ |
| Funnel 30 วัน | step2 952 → preflight สำเร็จ 604 (**63 %**), invalid 83 (9 %) | 1 ใน 3 ไม่ได้แผนภาพ |
| Step 2 advanced ถูกเปลี่ยนจาก auto | style ~7 %, region ~11 % (ส่วนใหญ่ "เน้นไทย") | สอดคล้อง "ไม่รู้ว่ามีผล" |
| โปรเจกต์ที่ผูกแบรนด์ export สำเร็จ | **87 %** (146/167) vs 61 % ไม่ผูก | สหสัมพันธ์ (คนตั้งใจ) แต่บอกว่าแบรนด์ = retention |
| Support ticket แตะคำ brand/B-roll | 31/214 (14.5 %, upper bound) | กระจายตัว มีกลุ่ม 4 ใบวันที่ 08-12 |
| Visual helper ("ขอคำแนะนำ") | 2 ครั้ง/30 วัน | ซ่อนอยู่ใน advanced ไม่มีใครเจอ |

**ช่องว่างข้อมูล:** ไม่มีคอลัมน์บันทึกว่าแต่ละฉากใช้ stock หรือ AI จริง (อยู่ใน JSON ฉาก) → wave 1 เพิ่ม telemetry ให้วัดได้

---

## 4. ฟีดแบคทีม + root cause "Step 2 advanced ใช้ไม่ได้จริง"

แผง advanced ใน Step 2 มี 2 ตัวเลือก: **คนและสถานที่** (`brollRegionPreference`: ตามเนื้อหา/เน้นไทย/เน้นเอเชีย/เน้นยุโรป/นานาชาติ/หลีกเลี่ยงคน) และ **สไตล์ฟุตเทจสต็อก** (`brollVisualStyle`: Auto/Doc/Cinematic/Business/Lifestyle/Tech/Minimal/Surreal) ค่าเดินทางถึง server ครบ (UI → draft → `/api/videos/jobs` → orchestrator → `extract-keywords` → `fetch-stock`) แต่ **ผลลัพธ์ไม่เปลี่ยน** เพราะ 5 สาเหตุซ้อนกัน:

| # | สาเหตุ | หลักฐาน | ผล |
|---|---|---|---|
| 1 | **สไตล์ไม่เคยแตะคำค้น** — `applyBrollPreferenceToSearchQuery` อ่านเฉพาะ region; style ไปแค่ใน prompt วิเคราะห์ (hint) และ relevance spec | `src/lib/broll-preferences.ts:303-325` | Pexels/Pixabay ได้คำค้นเดิมเป๊ะทุกสไตล์ → candidate pool เหมือนกัน |
| 2 | **cache 24 ชม. ของ managed stock key ด้วยคำค้นอย่างเดียว** | `src/lib/managed-stock.ts:356-364`, `fetch-stock/route.ts:1903-1912` | เปลี่ยนค่าแล้ว re-render ภายใน 24 ชม. ได้คลิปเดิมทุกไฟล์ |
| 3 | **หลัง render แรก path ไม่สนใจ preference** — re-render ใช้ `preview.config.bgVideos` เดิม; per-window search ค้นด้วย keyword ดิบ | `orchestrator.ts:1271-1289`, `api/videos/broll-window/search/route.ts:65-83` | loop จริงของผู้ใช้คือ "render → ไม่ชอบ → เปลี่ยนค่า → re-render" = no-op |
| 4 | region ใส่ prefix เฉพาะคำค้นที่มีคน/สถานที่ (ตั้งใจ กัน regression) | `broll-preferences.ts:318-324` | สคริปต์ที่คำค้นเป็นวัตถุ/นามธรรม → "เน้นไทย" ไม่เปลี่ยนอะไร และไม่มี telemetry บอก |
| 5 | คำ preference ถูก slice ทิ้งใน ranker prompt (`positive.slice(0,12)` หลังคำของโมเดล) + heuristic ranker ให้คะแนนเท่ากันทุก candidate | `fetch-stock/route.ts:938`, `:266`; `broll-preferences.ts:246-247` | ranker ก็ไม่ช่วย |

**ข้อสรุป:** ทีมพูดถูก — ฟีเจอร์นี้ "ทำงาน" ในเชิงส่งค่า แต่ไม่มีผลที่มองเห็น wave 0 ซ่อม 5 จุดนี้ให้ท่อใช้ได้จริง แล้ว wave 1 ใช้ท่อเดิมส่ง Stock Mood ของชุดสไตล์ (เมนูสไตล์ 8 ตัวถูกยุบ, "คนและสถานที่" คงไว้)

---

## 5. Findings จากโค้ด (บั๊ก / dead code / เอกสารไม่ตรง)

ระดับ: 🔴 กระทบเงินหรือบล็อกผู้ใช้ · 🟠 ผู้ใช้เห็นผิด/สับสน · 🟡 hygiene

| ID | ระดับ | เรื่อง | ที่ | กระทบใคร | Wave |
|---|---|---|---|---|---|
| F1 | 🔴 | **ราคา Brand Look Preview บอกผิด**: client ตั้ง `previewGenerationCount = 3` ตายตัวเมื่อไม่มี `?projectId` แต่ server อาจ reuse ภาพจาก revision ที่ promote จากคลิป (`sourcePreflightId`/`sourceVideoJobId`) แล้วเจนน้อยกว่า → บอก 6 เครดิตทั้งที่หักน้อยกว่า และอาจโดน `fundingInsufficient` บล็อกทั้งที่ไม่ต้องจ่าย | `BrandLibraryClient.tsx:126-130`; `brand-look-preview.server.ts:398-429` | ทุกคนที่มีแบรนด์บันทึกแล้ว | 0 |
| F2 | 🔴 | **quote กับ generate ใช้ input คนละชุด**: `preview-quote` รับ `{payload, projectId, preflightId}` ไม่มี `profileId/useDraft` ส่วน generate ยิง `[id]/preview` `{useDraft:true}` → ตัวเลขที่บอกกับที่หักได้ต่างกันโดยดีไซน์ | `BrandLibraryClient.tsx:120-124` vs `:607-608`; `preview-quote/route.ts` | เหมือน F1 | 0 |
| F3 | 🔴 | **trial สร้างแบรนด์ไม่ได้ + first-clip redirect**: `canCreate = !starterAllowance.eligible && …` และ layout redirect คนบน First-Clip Path ไป `/video-editor` → ปุ่ม "+ สร้างแบรนด์จากคลิปนี้" เด้งกลับ | `api/brand-library/route.ts:120-121`; `brands/layout.tsx:11` | trial/ผู้ใช้ใหม่ทุกคน | 0 (ADR 0059) |
| F4 | 🔴 | **หน้า `/brands` ปิดคน FREE + ตาม % rollout** ทั้งที่ plan-limits ให้ FREE 1 แบรนด์ | `brand-visual-rollout.server.ts:54-81`; `layout.tsx:12-16` | FREE 970 คน | 0 (ADR 0059) |
| F5 | 🟠 | **Content Preflight สำเร็จ 63 %, invalid 9 %** (§3) — ต้อง root-cause (schema retry หมด? โมเดล? สคริปต์ยาว?) เพราะ render ที่ต้องใช้ภาพ AI จะหยุดก่อนคิดเงินตาม ADR 0010 แต่ผู้ใช้เห็นเป็น "ยังไม่สมบูรณ์ ลองใหม่" | `content-preflight.server.ts:871-936`; telemetry `brand_visual_preflight_invalid` | ผู้ใช้ภาพ AI | 0 (diagnose) |
| F6 | 🟠 | **ปุ่ม "ทดลอง 3 ภาพ" disable เงียบ** เมื่อยังไม่ตั้งชื่อแบรนด์ (`!canPublish`) — อธิบายเฉพาะกรณีสิทธิ์ไม่พอ | `BrandLookPreviewPanel.tsx:70,82-89` | ผู้ใช้ใหม่ | 0 |
| F7 | 🟠 | **Step 2 advanced ไม่มีผลที่เห็น** (5 สาเหตุ §4) | ดู §4 | ทุกคนที่ใช้ stock | 0 |
| F8 | 🟠 | **AI แนะนำแนวเล่าเรื่องเอนไปทาง expert-clarity 74 %** และแนวภาพ clear-infographic 73 % — prompt ranking ไม่มี prior ต่อต้าน default และไม่มี fixture ตรวจ distribution | `content-preflight.server.ts:806-869` | ทุกคลิป AI | 1 |
| F9 | 🟠 | **Copy หลุดชื่อระบบภาษาอังกฤษ**: "Brand Visual กำลังทยอยเปิด…", "Brand Visual เป็นฟีเจอร์สำหรับสมาชิก PRO/BUSINESS", "Hero AI Image และ Video Editor", eyebrow "Brand Visual" | `BrandVisualLockedPreview.tsx:30-51`; `brand-visual-access.server.ts:18-29` | ทุกคนที่โดน gate | 0 |
| F10 | 🟠 | Copy "คลิปนี้ยังใช้**ก้างปลา**เล่าเรื่องรุ่นเดิม" — ชื่อ format ที่เลิกใช้แล้วโผล่ให้ลูกค้าเห็น | `BrandVisualSelector.tsx:527` | เจ้าของโปรเจกต์เก่า | 0 |
| F11 | 🟡 | Dead code: `canRestoreAll` server hardcode `false` → client branch ตายทั้งก้อน | `api/brand-library/route.ts:123`; `BrandLibraryClient.tsx:157-165` | — | 0 |
| F12 | 🟡 | Dead state `setSourceVisualContext` เขียน 6 ที่ ไม่เคยอ่าน | `BrandLibraryClient.tsx:109` | — | 0 |
| F13 | 🟡 | `suggest-visual` บังคับโมเดลตอบ `peopleAndSetting`/`memorableCues` ที่ถูกทิ้งตาม ADR 0006 → จ่าย token ฟรี | `suggest-visual/route.ts:16-17,53`; `BrandLibraryClient.tsx:434-446` | ต้นทุน Gemini | 0 |
| F14 | 🟡 | อีเมลเจ้าของ hardcode เป็น bypass ทุก gate (`PRODUCT_OWNER_EMAIL`) — ถอนไม่ได้โดยไม่ deploy | `brand-visual-rollout.server.ts:22,64` | security hygiene | 0 |
| F15 | 🟡 | เอกสาร ops อ้าง "บัญชีที่สร้างก่อน `BRAND_VISUAL_ROLLOUT_STARTED_AT` เป็น control" แต่โค้ดไม่เคยเทียบ `createdAt` | `docs/ops/brand-visual-system-rollout.md:58-59` vs `rollout.server.ts:54-81` | ทีม ops | 0 (แก้เอกสาร) |
| F16 | 🟡 | สอง write path ต่างขอบเขต caps บนคอลัมน์เดียวกันที่ถูกฉีดเข้า prompt Hero Script (`brand-profile-limits.ts` vs Zod ใน library) | `brand-profile-library.server.ts:100-105,890-904` | prompt cost | 0 |
| F17 | 🟡 | verify script 3 ตัวไม่ได้ต่อ npm/CI (`verify-brand-library-support-features`, `verify-brand-asset-api`, `verify-brand-assets`) และ ESLint ไม่ครอบไฟล์ brand เลย (audit 08-18) | `package.json`; audit 08-18 §toolchain | regression risk | 0 |
| F18 | 🟡 | `languageMode:"none"` ตั้งจาก UI ไม่ได้ (seed = defined, ทุก edit บังคับ defined) — field ตาย | `brand-profile-seed.ts:96`; `BrandLibraryClient.tsx:415-424` | — | 1 (ยุบเข้าชุดสไตล์) |
| F19 | 🟡 | product brief สถานะเก่า "implementation: not started" ทั้งที่ ship แล้ว | `docs/plans/2026-08-09-brand-visual-system-product-brief.md:194-196` | ผู้อ่านเอกสาร | 0 |
| F20 | 🟡 | ตาราง `Music` ไม่มี tag mood → ชุดสไตล์เลือกเพลงให้ไม่ได้ | `prisma/schema.prisma` Music | — | 1 |

---

## 6. ช่องโหว่โครงสร้าง (ทำไมแก้บั๊กอย่างเดียวไม่พอ)

1. **สองระบบสไตล์ที่ไม่คุยกัน** — Brand Visual (AI เท่านั้น) กับ `brollVisualStyle` + LLM `visualDirection` (stock เท่านั้น) → ผู้ใช้ตั้ง 2 ที่ ผลไม่ล้อกัน — แก้ด้วย ADR 0057
2. **หน่วยที่ผู้ใช้เลือกไม่ตรงกับหน่วยที่ผู้ใช้คิด** — คนคิดเป็น "ลุค" (หนังผี, คดีดัง, ประวัติศาสตร์) แต่ระบบให้เลือก medium × storytelling แยกกัน; วิจัยยืนยันว่าลุคจริงมี ~12 แบบและแนวเนื้อหาหยิบใช้ข้ามกัน — แก้ด้วย ADR 0058 (ชุดสไตล์ = ลุค)
3. **Adaptive default กลายเป็น monoculture** — ปล่อยให้ AI เลือกทุกคลิปแล้ว AI เลือกแนวกลาง ๆ 3 ใน 4 ครั้ง → ทุกช่องดูเหมือนกัน; ชุดสไตล์ที่ล็อกโดยผู้ใช้เอง (locked policy ที่มีอยู่แต่ไม่มีใครใช้) คือทางออก + rebalance recommendation (F8)
4. **Gate ออกแบบสำหรับฟีเจอร์คิดเงิน แต่ครอบทั้งหน้า** — เมื่อแบรนด์คุม stock ฟรีได้แล้ว ต้นทุนเป็นศูนย์ การปิด FREE/trial คือปิด retention hook — แก้ด้วย ADR 0059
5. **Consistency ที่แท้จริงไม่ได้อยู่ที่ภาพอย่างเดียว** — วิจัย: เสียงผู้เล่าคงที่ > สูตรชื่อคลิป/hook > เทมเพลตซับ > cadence > อุปกรณ์เล่าเรื่อง → Brand Profile มีเสียง+ซับ+โลโก้แล้ว; ชุดสไตล์เติม tone สคริปต์ + เพลง + pacing ให้ครบ

---

## 7. การตัดสินใจ (สัมภาษณ์ 2026-09-02)

| # | คำถาม | ตัดสินใจ | บันทึกที่ |
|---|---|---|---|
| Q1 | ขอบเขต consistency | **A** สไตล์เดียวคุม stock + AI + AutoMix | ADR 0057 |
| Q2 | โครงสร้างการเลือก | **B** ชั้นชุดสไตล์กดครั้งเดียว บน 2 แกนเดิม | ADR 0058 |
| Q3 | รายการชุดสไตล์ V1 | **12 ชุด 2 wave** (§8) | wave-1/2 plan |
| Q4 | ใครใช้ได้ | **A** ทุกแผน gate เฉพาะภาพ AI | ADR 0059 |
| Q5 | จังหวะ | **A** 3 ระดับผ่าน knob เดิม ไม่มีเอฟเฟกต์ใหม่ | CONTEXT (Pacing) |
| Q6 | ส่งมอบ | **A** แต่ execute ทุก wave ใน session ถัดไป | map |
| Q7 | ข้อมูล | ฟีดแบคทีม 3 ข้อ + prod read-only | §3–§4 |
| Q8 | เกณฑ์เสร็จ | ตามที่เสนอ | แผนแต่ละ wave |

---

## 8. Catalog ชุดสไตล์ V1 (12 ชุด)

โครง recipe ต่อชุด: แนวภาพ × แนวเล่าเรื่อง · Stock Mood (token ที่เติมในคำค้น / คำที่ต้องการ / คำที่เลี่ยง / ประโยคทิศทาง) · ซับ · เพลง · pacing · โทนสคริปต์ — ค่าเต็มแบบโค้ดอยู่ในแผน wave 1 Task 1

| # | ชุดสไตล์ | แนวภาพ × แนวเล่าเรื่อง | Stock Mood (token → ต้องการ / เลี่ยง) | ซับ | เพลง | Pacing | โทนสคริปต์ | Wave |
|---|---|---|---|---|---|---|---|---|
| 1 | **หนังผีไทย** | ภาพสมจริงแบบหนัง × หนังผีไทย | `night` → night, moonlight, abandoned house, candle, fog, old temple, forest at night / bright daylight, office, smiling, product | ตัวหนาขาว เน้นแดง เงาเข้ม ล่างกลาง | ominous | ปกติ | เล่าช้า กดดัน ไม่เฉลยเร็ว | 1 |
| 2 | **ประวัติศาสตร์ย้อนยุค** | เล่าเรื่องย้อนยุค × ประวัติศาสตร์และตำนานไทย | `vintage` → old temple, ruins, ancient, archive, monument, mural, palace / smartphone, neon, modern office | ตัวหนาครีม เน้นทอง | serious | ปกติ | เล่าเป็นลำดับเหตุการณ์ อ้างยุคสมัย | 1 |
| 3 | **ดราม่าชีวิตจริง** | ภาพสมจริงแบบหนัง × ดราม่าชีวิตไทย | `cinematic` → family, home, rain window, hands, hospital corridor, village, evening light / corporate, luxury, cartoon | ตัวหนาขาว เน้นเหลืองอ่อน | emotional | ปกติ | ใกล้ชิด ใช้รายละเอียดชีวิต | 1 |
| 4 | **ธุรกิจ-การเงินชัดเจน** | อินโฟกราฟิก × ผู้เชี่ยวชาญอธิบายชัด | `clean` → chart, coins, laptop, calculator, desk, city, documents / horror, dark, party | ตัวหนาขาว เน้นเหลือง | upbeat | เร็ว | ตรงประเด็น ตัวเลขนำ | 1 |
| 5 | **ข่าวสรุปเร็ว** | ภาพสมจริงแบบหนัง × ข่าวสืบสวนเข้มข้น | `news` → newsroom, city street, press, documents, courthouse, aerial city / cartoon, fantasy, product | ตัวหนาขาวบนแถบมืด เน้นแดง | tense | เร็ว | ประเด็นละประโยค ใครทำอะไรที่ไหน | 1 |
| 6 | **สุขภาพเข้าใจง่าย** | ภาพวาดเรียบง่าย × ผู้เชี่ยวชาญอธิบายชัด | `healthy` → fresh food, exercise, clinic, sleep, water, vegetables / horror, alcohol, graphic surgery | ตัวหนาขาว เน้นเขียวมิ้นต์ | calm | ปกติ | เป็นมิตร อธิบายเหตุ-ผล (ADR 0015) | 1 |
| 7 | **โฆษณาสินค้าพรีเมียม** | ภาพสมจริงแบบหนัง × โฆษณาสินค้าพรีเมียม | `luxury` → product close-up, studio light, marble, unboxing, minimal interior / crowd, messy, cartoon | ตัวบาง-กลางขาว เน้นทอง | lounge | ช้า | น้อยแต่คม ประโยชน์นำ | 1 |
| 8 | **คดีดัง / เรื่องเล่าดาร์ก** | ภาพสมจริงแบบหนัง × 🆕 dark story / true crime | `dark` → dim room, rain street, police tape, evidence, old photo, corridor, CCTV, silhouette / bright, smiling, product | ตัวหนาขาว เน้นแดง เงาแข็ง | ominous | ปกติ | เล่าตามลำดับเวลา สงบแต่หนัก (ADR 0016) | 2 |
| 9 | **เจาะประเด็นการเมือง** | ภาพสมจริงแบบหนัง × 🆕 political commentary | `editorial` → parliament, flag, podium, city hall, documents, newspaper, ballot, rally wide shot / cartoon, horror, celebrity faces | ตัวหนาขาว เน้นน้ำเงิน | serious | ปกติ | เป็นกลาง อ้างข้อเท็จจริง ไม่ใส่สีบุคคล (ADR 0016) | 2 |
| 10 | **ลึกลับ / ทฤษฎีสมคบคิด** | ภาพสมจริงแบบหนัง × 🆕 mystery / unexplained | `mysterious` → fog, night sky, old map, symbols, ruins, library, files, lantern / bright office, product, smiling | ตัวหนาขาว เน้นเขียวน้ำทะเล | eerie | ช้า | ตั้งคำถาม ค่อย ๆ เปิด ไม่ฟันธง | 2 |
| 11 | **นิทานธรรมะ** | ภาพวาดเรียบง่าย × 🆕 dharma storytelling | `temple` → temple, lotus, candle, golden light, Buddha statue, rice field, morning mist, offering / horror, nightlife, violence | ตัวใหญ่กลางจอ เน้นทอง | traditional | ช้า | เล่าเป็นนิทาน จบด้วยข้อคิด | 2 |
| 12 | **โมทิเวชันซีเนมาติก** | ภาพสมจริงแบบหนัง × 🆕 stoic / motivation | `cinematic` → sunrise mountain, ocean, lone silhouette, road, city dawn, storm clouds, stars / cartoon, product, office meeting | ตัวหนาขาวล้วน ไม่เน้นสี | epic | ช้า | ประโยคสั้น ทรงพลัง พูดกับ "คุณ" | 2 |

**กติกาที่ล็อก:** ชุด 8–12 อยู่ใน catalog ตั้งแต่ wave 1 ด้วยสถานะ `pending-benchmark` (ผู้ใช้ไม่เห็น) และเปิดเมื่อแนวเล่าเรื่องใหม่ผ่าน Treatment Qualification Benchmark (ADR 0010) เท่านั้น · ทุกชุดเป็น `locked` policy โดยดีไซน์; "ให้ AI เลือกตามเนื้อหา" และ "กำหนดเอง (แนวภาพ × แนวเล่าเรื่อง)" ยังอยู่ในขั้นสูง · ภาพตัวอย่างการ์ด 12 ใบ = generation ภายใน ต้องได้ go จากมิวก่อน (ADR 0017 กติกา paid execution)

---

## 9. แผนงาน

| Wave | แผน | เนื้อหา | เงื่อนไข |
|---|---|---|---|
| 0 | `docs/plans/2026-09-02-brands-wave0-make-it-work.md` | F1–F7, F9–F17, F19: quote ตรงจริง, เปิดทุกแผน, Step-2 ท่อใช้ได้จริง, copy, dead code, CI/lint, diagnose preflight | อนุมัติแล้ว — execute session หน้า |
| 1 | `docs/plans/2026-09-02-brands-wave1-style-packs.md` | catalog 12 ชุด (7 เปิด), ชุดสไตล์บน `/brands` + editor, Stock Mood ผ่านท่อ wave 0, pacing, music mood, rebalance recommendation (F8), telemetry | รออนุมัติ; ภาพการ์ดต้อง go |
| 2 | `docs/plans/2026-09-02-brands-wave2-new-treatments.md` | 5 Treatment Preset ใหม่ + compiler ทุก format + fixture + benchmark 75 ภาพ + review → เปิดชุด 8–12 | รออนุมัติ; benchmark คิดเงินต้อง go แยก |

ลำดับบังคับ: 0 → 1 → 2 (wave 1 ใช้ท่อ stock ที่ wave 0 ซ่อม; wave 2 ใช้ catalog ของ wave 1)

---

## 10. ไม่ทำ / ตัดออก

- ลุคที่ต้องใช้ AI video / 3D / motion graphics (วิจัย #2 #7 #9 #12) — pipeline ภาพนิ่งทำไม่ได้
- เปลี่ยนโมเดลภาพหรือเพิ่ม retry ซ่อน (ADR 0023 ยืน)
- แตะ subtitle timing (ADR 0056) — ชุดสไตล์เลือก *preset* ซับเท่านั้น
- เอฟเฟกต์ motion ใหม่ (zoom punch/ตัดกระชาก) — fast-follow หลังเห็น telemetry wave 1
- Character Identity Lock (ADR 0011 ยังเป็นอนาคต)

---

## F5 disposition — Content Preflight "สำเร็จ 63 % / invalid 9 %" (วินิจฉัย 2026-09-02, read-only prod)

**คำตัดสิน:** ตัวเลข 63 % **ไม่ใช่บั๊ก แต่เป็นตัวชี้วัดที่นับผิดฐาน** (ตัวตั้งกับตัวหารมาจากคนละกลุ่มผู้ใช้) · ส่วน invalid 9 % **ส่วนใหญ่ถูกแก้ไปแล้ว** (สาเหตุอันดับ 1 คือชื่อเฉพาะรั่ว ซึ่ง #353 + v13–v15 ปิดไปเมื่อ 08-26/08-28) · เหลือ **บั๊กจริง 1 ข้อ** คือ *ผู้ให้บริการตอบกลับมาว่างเปล่า แล้วโค้ดตีความเป็น "JSON พัง"* → แก้แล้วในงานนี้ (ดู "การแก้")

### F5.1 นับใหม่วันนี้ เทียบกับตัวเลขใน §3

| ตัวชี้วัด (30 วัน) | §3 (audit) | นับใหม่ 2026-09-02 | หมายเหตุ |
|---|---|---|---|
| step2 (`editor_step2_reached`) | 952 | **794** (= ทั้งหมดตลอดอายุฟีเจอร์) | นิยามเดิมนับไม่ซ้ำอีกไม่ได้; ทุก definition ที่ลองแล้วไม่ได้ 952 |
| preflight สำเร็จ (`brand_visual_preflight_resolved`) | 604 | **606** (analyzed 430 + cached 176) | ตรงกับ audit (โต 2 ระหว่างวัน) |
| invalid (`brand_visual_preflight_invalid`) | 83 | **83** | ตรงเป๊ะ |
| อัตราที่ audit สรุป | 63 % / 9 % | — | **ใช้ไม่ได้** ดู F5.2 |
| อัตราที่ถูกต้อง (สำเร็จ/ครั้งที่วิเคราะห์จริง) | — | **430/513 = 83.8 %** ตลอดอายุ · **106/108 = 98.1 %** ตั้งแต่ v15 (28 ส.ค.) | invalid ต่อความพยายามวิเคราะห์ |

### F5.2 ทำไม 63 % ถึงเป็นตัวเลขลวง — ตัวตั้งกับตัวหารเป็นคนละกลุ่ม

| event | cohort ที่ยิงจริง | จำนวน |
|---|---|---|
| `editor_step2_reached` | `rollout-wait` 725 + `control` 69 · **internal/treatment-\* = 0** | 794 |
| `brand_visual_preflight_resolved` | `internal` 395 · worker ไม่มี cohort (upload 123 + script 63) 186 · `rollout-wait` 25 | 606 |

`Step2Elements.tsx` ยิง `editor_step2_reached` เฉพาะ cohort ที่ "วัดผลได้" ซึ่งวันนี้คือ rollout-wait/control — กลุ่มที่ `decideBrandVisualAccess` คืน `canUse:false` จึง **ยิง preflight ไม่ได้อยู่แล้ว** (route ตอบ `brandVisualLockedResponse` เว้นแต่โปรเจกต์มี pin เดิม) ส่วน 94 % ของ resolved มาจาก cohort `internal` และจาก worker ที่ไม่ยิง step-2 เลย → **หารกันไม่ได้โดยนิยาม**

### F5.3 ช่องว่างเงียบ (952 vs 604+83) — แยกเป็น "ตามดีไซน์" กับ "บั๊ก"

นับที่ระดับโปรเจกต์: 400 โปรเจกต์ที่มี `editor_step2_reached`

| กลุ่ม | จำนวน | คำอธิบาย | ตัดสิน |
|---|---|---|---|
| มี VideoJob `stockSource ∈ (kie-image, auto-mix)` แต่ไม่มี ContentPreflight | **184** | เจ้าของอยู่นอก rollout → `ensureVideoJobContentPreflight` คืน `skipped: not-accepted` แล้วเรนเดอร์ด้วยเส้นทาง prompt เดิม | **ตามดีไซน์ของ rollout** (คือสิ่งที่ ADR 0059 / F4 เปิดให้ทุกแผน) |
| งาน stock อย่างเดียว ไม่มี preflight | 164 | trigger ฝั่ง editor (`shouldLoadBrandVisualContext`) และ orchestrator (`needsAiVisualPlan`) ไม่แตะ stock-only | **ตามดีไซน์** |
| ไม่เคยมี VideoJob เลย | 19 | เปิด Step 2 แล้วไม่เรนเดอร์ | **ตามดีไซน์** |
| มี ContentPreflight | 33 | 19 ต้องใช้ภาพ AI + 14 เปิดแผงขั้นสูง | — |

**ไม่พบ trigger ที่หายหรือ race:** งานที่ผู้ใช้อยู่ในเส้นทาง Brand Visual จริง (`projectVisualContextJson` ไม่ว่าง) และจบสถานะ `done` โดยไม่มี `contentPreflightId` = **0 งาน** → กติกาเงินของ ADR 0010 ("หยุดก่อนคิดเงินภาพ") ยังยืนอยู่ · งานที่ถูก preflight หยุดจริงตลอดอายุฟีเจอร์ = **14 งาน** (`CONTENT_PREFLIGHT_INVALID_ANALYSIS` 9 + `CONTENT_PREFLIGHT_NARRATIVE_MISMATCH` 5; ลูกค้า 9 / ทีม 5) และครั้งสุดท้ายของ INVALID_ANALYSIS คือ 08-27

### F5.4 จำแนก 83 invalid events (จาก `properties.diagnostic` + เวลา + cohort)

analyzer version: **v12 = 81 · v15 = 2** · cohort: **ทีม 78 / ลูกค้า 5** · ทุก event ใช้ครบ 3 attempts

| # | คลาสความล้มเหลว (จากไม้สุดท้ายที่ตัดสิน) | events | % | อ่านว่าอะไร |
|---|---|---|---|---|
| 1 | `beats[].subject:custom` — ชื่อเฉพาะรั่วเข้า field ที่ส่งให้ผู้ให้บริการ | **39** | 47 % | ปัญหา v12 ที่ #353 (08-26) + v13–v15 ปิดไปแล้ว: ก่อน 08-26 มี 44 event หลัง 08-26 เหลือ **2** |
| 2 | **`empty_provider_response`** — โมเดลตอบกลับมา **ว่างเปล่า (len=0) ครบทั้ง 3 ครั้ง** | **32** | 39 % | บั๊กจริง (F5.5) · 24 ครั้งเป็น burst วันเดียว 08-27, ยัง reproduce ได้ 09-01 |
| 3 | `storyEntities[].renderingDescription:custom` | 5 | 6 % | ตระกูลเดียวกับ #1 |
| 4 | `beats[].entityRefs[]:custom` (อ้าง entity ที่ไม่มี / real-person) | 3 | 4 % | 3 ใน 5 ของ event ฝั่งลูกค้าอยู่กลุ่มนี้ (08-26) |
| 5 | `hardSceneFacts.{actions,essentialObjects,count}:too_big` | 4 | 5 % | เพดานความยาว/จำนวน ยังชนบ้าง |
| — | `beat_count` ไม่ตรงจำนวนหน้าต่าง | ปนใน 3 event | — | ไม่เคยเป็นสาเหตุเดี่ยว |

ความถี่ path ระดับ attempt: `beats[].subject:custom` 232 · `renderingDescription:custom` 22 · `hardSceneFacts.actions[]:too_big` 17 · `entityRefs[]:custom` 11 · `entityTypes[]:too_big` 8 · อื่น ๆ ≤4

### F5.5 บั๊กที่พิสูจน์ได้ + การแก้

**หลักฐาน:** attempt ที่ถูกบันทึกว่า `json_parse` มี **96 ครั้ง และทั้ง 96 ครั้ง `len=0`** — ไม่เคยมีสักครั้งที่เป็น JSON เพี้ยนจริง ๆ · เมื่อได้ body ว่าง ครั้งถัดไปก็ว่างทุกครั้ง (**0 จาก 64**) · โค้ดกลับส่ง correction prompt ว่า *"Your previous JSON was rejected because it could not be parsed"* ซึ่งเป็นการบรรยายคำตอบที่โมเดลไม่เคยส่ง แล้วเผาอีก 2 calls ที่รู้ผลอยู่แล้ว · ซ้ำร้าย `diagnostic` ถูกตัดที่ 1,200 ตัวอักษรแบบรวม ทำให้ **attempt สุดท้ายหายไปใน 29 จาก 83 event** และ telemetry ไม่มี field ที่ระบุคลาสความล้มเหลว (ต้อง parse ข้อความเอง)

**แก้ (คงความหมาย ADR 0010 ทุกข้อ):** `src/lib/content-preflight.server.ts`

1. body ว่าง = คลาสของตัวเอง `empty_provider_response` → **หยุดทันที** (ไม่มีอะไรให้แก้) — *ลด* จำนวน call ไม่ใช่เพิ่ม, ไม่มี fallback, ไม่มีการคิดเงินภาพ, ผู้ใช้ยังได้ปุ่มลองใหม่ครั้งเดียวเหมือนเดิม
2. `brand_visual_preflight_invalid` เพิ่ม `reason` = `empty_provider_response | unparsable_json | beat_count_mismatch | schema_invalid` → query จำแนกได้ตรง ๆ
3. ตัด `diagnostic` **ต่อ attempt** (380 ตัวอักษร) แทนการตัดรวม → attempt สุดท้ายไม่หายอีก
4. ข้อความให้ผู้ใช้ของคลาสนี้แยกเป็น "ระบบวิเคราะห์แนวภาพไม่ได้รับผลลัพธ์กลับมา กรุณาลองใหม่อีกครั้ง" (ของเดิมพูดว่า "หลังลองแก้อัตโนมัติ" ซึ่งไม่จริงสำหรับคลาสนี้)

fixture: `scripts/verify-content-preflight.ts` — body ว่าง (`""` และช่องว่างล้วน) ต้องเรียกผู้ให้บริการ **1 ครั้ง**, ล้มแบบ fail-closed, และทิ้ง `"reason":"empty_provider_response"` ไว้ใน telemetry

### F5.6 งานต่อ (ticket ที่ควรเปิด)

| # | เรื่อง | ทำไม | Wave |
|---|---|---|---|
| T1 | เลิกใช้ "step2 → preflight" เป็น funnel · วัด **สำเร็จ/ความพยายามวิเคราะห์** และแยกตาม cohort ที่ใช้ได้จริง (`brand-visual-rollout-health.server.ts`) | ตัวเลข 63 % หลอกทั้ง audit นี้ | 0 (เอกสาร) / 1 (โค้ด) |
| T2 | ให้ `geminiGenerateText` ส่ง `finishReason` ออกมาเมื่อ body ว่าง เพื่อแยก safety-block กับ token-cap | ตอนนี้ระบุสาเหตุฝั่งผู้ให้บริการไม่ได้เลย; แตะ 14 call sites จึงเกินขอบเขต wave 0 | 1 |
| T3 | วัดซ้ำ 7 วันหลัง deploy ด้วย `json_extract(properties,'$.reason')` — คาด `empty_provider_response` เป็นคลาสนำ ส่วน `subject:custom` ควรใกล้ 0 | ยืนยันว่า v15 ปิดตระกูลชื่อเฉพาะได้จริง | 0 (ops) |
