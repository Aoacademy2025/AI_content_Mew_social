# Design Spec — อัปคลิปตัวเอง + B-roll Cutaway อัตโนมัติ (Phase 1)

- **วันที่:** 2026-07-01
- **สถานะ:** Design approved (brainstorming) — รอ implementation plan
- **เจ้าของ:** Mew (pricing/UX) · เขียนโดย agent
- **Ticket ต้นทาง:** kapokja@gmail.com (PRO) + มีลูกค้าขอซ้ำหลายราย — use case = ครีเอเตอร์ affiliate/ปักตะกร้า อัดคลิปพูดเอง แล้วอยากได้ B-roll แทรกให้คลิปไม่น่าเบื่อ

---

## 1. Problem

ทุกวันนี้ direct-upload (อัปคลิปตัวเอง) ทำได้ 2 โหมด: **Green Screen** (ต้องถ่ายฉากเขียว → ตัดเขียววางบน b-roll) และ **เต็มจอ** (คลิปเต็มจอ + ซับ, ไม่มี b-roll). **ช่องว่าง:** คลิปพูดเองแบบ**ปกติ (ไม่ใช่ฉากเขียว)** เอา B-roll มาแทรกไม่ได้เลย ทั้งที่เป็นฟอร์แมตที่ครีเอเตอร์ affiliate ต้องการที่สุด (talking-head + B-roll cutaway แบบ Submagic/Opus)

โค้ดยืนยัน: composite route ทำได้แค่ overlay คลิปทับ b-roll (b-roll โผล่ผ่านรูที่ตัดเขียวเท่านั้น) — ไม่มี path cutaway/PiP สำหรับคลิปธรรมดา

## 2. Goal / Non-goals

**Goal (Phase 1):** ผู้ใช้อัป**คลิปแนวตั้งที่พูดเอง** → ระบบ **ใส่ซับไทย + แทรก B-roll แบบ Cutaway อัตโนมัติ (stock, ตรงกับสิ่งที่พูด)** → คลิป 9:16 · **กดปุ่มเดียว/อัตโนมัติ 100%**

**Non-goals (ยกไป Phase หลัง):**
- AI-gen B-roll (kie) ในโหมดนี้ — Phase 1 = **stock อย่างเดียว** (กันบิลเซอร์ไพรส์)
- อัปรูป/คลิป **สินค้า** ของ user มาแทรก (product media pipeline)
- Layout อื่น: PiP / split-screen (หน้าเราบน–B-roll ล่าง)
- คลิป**แนวนอน/จัตุรัส** (รับเฉพาะแนวตั้ง)
- ให้ผู้ใช้**คุม/แก้**ตำแหน่ง cutaway เอง (Phase 1 = auto ล้วน)
- ยก "อัปคลิปตัวเอง" ออกมาเป็นเมนูหลักแยกจากเซกชันพิธีกร (Phase 1 แค่ relabel)

## 3. UX / UI

### 3.1 Relabel เซกชันพิธีกร (ให้สื่อว่ามีทั้ง AI และคลิปเรา)

```
เดิม (งง)                          →   ใหม่ (สื่อ)
────────────────────────────────       ────────────────────────────────
AVATAR (HEYGEN)            [ON]        พิธีกรในคลิป (AI / คลิปฉัน)   [ON]
[ Generate ] [ Direct URL ]            [ Avatar AI ] [ อัปคลิปฉันเอง ]
[Green Screen] [วิดีโอเต็มจอ]           [ ฉากเขียว ] [ เต็มจอ ] [ เต็มจอ + B-roll ★ ]
```

- **หัวข้อเซกชัน:** `AVATAR (HEYGEN)` → **`พิธีกรในคลิป (AI / คลิปฉัน)`** (ถ้อยคำปรับได้ตอน implement)
- **แท็บ:** `Generate` → **`Avatar AI`** · `Direct URL` → **`อัปคลิปฉันเอง`**
- **ปุ่มฟอร์แมตที่ 3 (ใหม่):** **`เต็มจอ + B-roll`** — ต่อจาก `ฉากเขียว` / `เต็มจอ`
- ใต้ปุ่มใหม่มีคำโปรยสั้น: *"อัปคลิปพูดเอง → ระบบใส่ซับ + แทรก B-roll ให้อัตโนมัติ"*
- OFF = b-roll ล้วน ไม่มีคนพูด (เหมือนเดิม)

### 3.2 Flow ผู้ใช้ (โหมด "เต็มจอ + B-roll")

1. เปิด "พิธีกรในคลิป" → แท็บ "อัปคลิปฉันเอง" → ปุ่ม "เต็มจอ + B-roll"
2. อัปโหลดคลิป (แนวตั้ง) — **ไม่ต้องแปะ script ก็ได้** (ระบบถอดเสียงจากคลิปเอง); แปะได้เพื่อความแม่นของซับ/คีย์เวิร์ด
3. กด Render → ระบบทำเองหมด (transcribe → keyword → หา stock B-roll → เลือกช่วง cutaway → ประกอบ)
4. ได้ preview: คลิปเรา + B-roll แทรกเป็นช่วง + ซับ live overlay
5. Burn & Download = export ตัวจริง (ซับ burn) — เหมือน flow editor เดิม

### 3.3 Upload guard — เฉพาะแนวตั้ง

- ตอนอัป อ่าน dimension วิดีโอ (client-side); ถ้า **width ≥ height (แนวนอน/จัตุรัส) → ปฏิเสธ** พร้อมข้อความ *"รองรับเฉพาะคลิปแนวตั้ง 9:16"* + guard ซ้ำ server-side
- รับ portrait; ถ้าไม่ใช่ 9:16 เป๊ะ (เช่น 3:4) → **เติมขอบ (pad) ให้เป็น 9:16** ตอน render
- ผลพลอยได้: ตัด logic crop/fit คลิปแนวนอนทิ้งได้ → งานง่ายลง

## 4. System / Architecture

### 4.1 หลักการ: reuse ~90%, ของใหม่ 2 ชิ้น

**Reuse เดิมทั้งหมด** (direct-upload pipeline ที่มีอยู่):
- อัปโหลดคลิป → เป็น "เสียง"/base (ข้าม TTS)
- `transcribe` คลิป → captions + timing (เหมือน direct-upload วันนี้)
- `keyword` จาก transcript → `fetch-stock` (Pexels/Pixabay) → `buildBrollWindows` (หน้าต่าง 3–4 วิ ตรงเนื้อหา)
- render **b-roll base** เต็มความยาวคลิป (b-roll ตรงเนื้อหาทุก window อยู่แล้ว)
- ซับ live overlay + Burn — เหมือนเดิม
- **Metering** ผ่าน `render/route.ts` เดิม — ไม่แตะ

**ของใหม่ 2 ชิ้น:**
1. **`cutaway-plan` (pure function, ใหม่):** รับ b-roll windows → คืนว่า window ไหน "โชว์หน้าเรา" / window ไหน "โชว์ B-roll" (ดูข้อ 5). Pure + testable ด้วย `scripts/verify-cutaway-plan.ts`
2. **โหมด composite `"cutaway"` (ใหม่ ใน `api/heygen/composite/route.ts`):** ต่อยอดจาก `directComposite` เดิม

### 4.2 กุญแจสำคัญ — cutaway = "เต็มจอ" + time-gate (delta เล็กมาก)

โหมด `"เต็มจอ"` (`directComposite`) วันนี้ = overlay คลิปเรา**ทึบเต็มเฟรมทับ b-roll base** → b-roll ถูกบังหมด (`[bg][fg]overlay=0:0`, เสียง = คลิปเรา)

**Cutaway = อันเดิมเป๊ะ แต่ใส่ `enable` ให้ overlay คลิปเรา "ติดเฉพาะช่วงหน้าเรา":**
```
[bg][fg]overlay=0:0:enable='between(t,p0s,p0e)+between(t,p1s,p1e)+...'
                              └── ช่วง "หน้าเรา" จาก cutaway-plan ──┘
```
- ช่วง "หน้าเรา" → คลิปเราถูกวาดทับ → เห็นหน้าเรา
- ช่วง "B-roll" → คลิปเราไม่ถูกวาด → **b-roll base (ที่ตรงเนื้อหาอยู่แล้ว) โผล่เต็มจอ**
- **เสียง = คลิปเรา (base) ต่อเนื่องตลอด** ไม่ต้องแตะ audio เลย

→ ไม่ต้องตัด-ต่อ segment, ไม่ต้อง re-mux เสียง, reuse b-roll base render เต็มๆ

### 4.3 Data flow

```
คลิป(อัป) ─► transcribe ─► captions/timing ─► keyword ─► fetch-stock ─► buildBrollWindows
                                                                              │
                                              ┌───────────────────────────────┤
                                              ▼                               ▼
                                       render b-roll base            cutaway-plan(windows)
                                       (เต็มความยาว)                 → person[] / broll[] ranges
                                              │                               │
                                              └──────────► composite "cutaway" ◄┘
                                                 overlay คลิปเรา enable=person ranges
                                                              │
                                                        preview ─► Burn (ซับ) ─► 9:16
```

### 4.4 ทางเลือกที่พิจารณาแล้ว (ไม่เลือก)
- **ตัด-ต่อ segment (concat):** ตัดคลิปเราเป็นท่อน สลับ b-roll แล้ว concat + re-attach เสียง → เพี้ยน/ยุ่งกว่า, ต้อง re-encode. **ไม่เลือก** เพราะ 4.2 ทำงานน้อยกว่า + เสียงไม่ต้องแตะ

## 5. Auto-heuristic (`cutaway-plan`)

Default Phase 1 (เก็บเป็น knob ปรับได้):
- **window แรก (hook ~3–5 วิ) = หน้าเราเสมอ** (ให้คนจำหน้า/เกิด connection)
- หลังจากนั้น**สลับ**: ~40–50% ของ window เป็น B-roll
- แต่ละ B-roll ยาว 3–5 วิ (= 1 window) · **ห้าม B-roll ติดกันเกิน 2 window** (กันหน้าเราหายนาน)
- B-roll ของ window ไหน = ใช้ stock ที่ match keyword ของ window นั้น (มาจาก pipeline เดิม)
- Input: windows (start/end/keyword) · Output: `person: [{s,e}]`, `broll: [{s,e}]` (ครอบคลุมทั้งความยาว, ไม่ทับกัน)
- **Pure function** → `scripts/verify-cutaway-plan.ts` (invariants: ครอบคลุมเต็ม, ไม่ทับ, hook=person, ไม่มี broll-run > 2, สัดส่วนอยู่ในช่วง)

## 6. Metering / Billing

- **Reuse มิเตอร์นาทีเดิม 100%** — ฟีเจอร์วิ่งผ่าน `render/route.ts` ซึ่งคิด `reservedMinutes = minutesFromSeconds(videoDuration)` = `round(วินาที/60)` ขั้นต่ำ 1
- คลิป 2:00 → **2 นาที** · 2:30 → 3 (ปัดครึ่งขึ้น) · 1:29 → 1 · หักจากโควต้านาที/เดือน (PRO 80 / BIZ 150)
- นับ **ครั้งเดียว/คลิป** (ChargedClip กันคิดซ้ำตอน Burn)
- เพดานยาว/คลิปเดิม: FREE 2น. / PRO 6 / BIZ 10 → คลิป 2 นาทีผ่านทุกแผน
- transcribe/keyword = กินเพดาน AI ที่ซ่อน (`ai-spend-limits` / `ai-text-limits`) เหมือน direct-upload เดิม ไม่โผล่มิเตอร์นาที
- **Phase 1 stock-only → ไม่มีเครดิต AI บวก** = "จ่ายตามนาทีคลิป" ล้วน (mental model ชัด)
- Gate: **PRO / BUSINESS** (เหมือน direct-upload เดิม)

## 7. Edge cases / Fail-open

- **transcribe ล้ม** → ออกเป็นคลิปเต็มจอ + ซับจาก script ที่แปะ (ถ้ามี) / ไม่มี b-roll — ไม่พัง
- **fetch-stock ล้ม / ได้ b-roll น้อย** → window ที่ไม่มี b-roll = คงหน้าเราไว้ (fallback = เต็มจอช่วงนั้น)
- **คลิปสั้นมาก (< ~10 วิ / < 2 window)** → ข้าม cutaway, ออกเต็มจอ + ซับ
- **คลิปไม่ใช่แนวตั้ง** → ปฏิเสธตั้งแต่อัป
- ทุกชั้น fail-open → อย่างแย่สุดได้ "คลิปเต็มจอ + ซับ" (= โหมดเต็มจอเดิม) ไม่มีทางพังทั้งงาน

## 8. Testing

- `scripts/verify-cutaway-plan.ts` (tsx, throwaway) — invariants ของ heuristic (ข้อ 5)
- Build-verify (tsc/esbuild) สำหรับ UI + composite route
- Manual QA: อัปคลิปแนวตั้งจริง → เช็ก (a) b-roll โผล่เป็นช่วง (b) เสียงต่อเนื่อง (c) ซับตรงเสียง (d) window แรก=หน้าเรา (e) คลิปแนวนอนถูกปฏิเสธ (f) มิเตอร์นาทีหักตามความยาว

## 9. ไฟล์ที่แตะ (คร่าว)

- `src/app/(dashboard)/video-editor/_components/OrderPanel.tsx` — relabel หัวข้อ/แท็บ, ปุ่มโหมดที่ 3, upload guard แนวตั้ง
- `src/app/(dashboard)/video-editor/page.tsx` — เพิ่ม `directCompositeMode = "cutaway"`, ส่ง person-ranges ไป composite, ผูก cutaway-plan
- `src/app/api/heygen/composite/route.ts` — โหมด `"cutaway"` (directComposite + `enable=between(...)`)
- `src/lib/cutaway-plan.ts` — **ใหม่** (heuristic เลือก window)
- `scripts/verify-cutaway-plan.ts` — **ใหม่**
- Metering (`render/route.ts`), transcribe/keyword/fetch-stock, `buildBrollWindows` — **ไม่แตะ** (reuse)

## 10. Rollout

- หลังบ้าน + UI ปิดหลัง flag (เช่น `NEXT_PUBLIC_CLIP_CUTAWAY=1`) เปิดเมื่อ QA ผ่าน
- Phase 1 stock-only, PRO/BUSINESS
- Mew merge + deploy เอง (ตอนคิว render ว่าง)
