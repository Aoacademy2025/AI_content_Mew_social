# Editor v2 — Feedback Round 1 (2026-07-03) — Design

Mew ใช้งาน v2 จริงแล้วให้ฟีดแบค 6 ข้อ ดีไซน์นี้ผ่านการเลือกทางแยกกับ Mew ครบแล้ว (Q1=A, Q2=A, Q3=A, Q4=A)

**Scope:** เฉพาะ editor v2 (`src/app/(dashboard)/video-editor/_v2/`) + จุดต่อ API ที่จำเป็น — ไม่แตะพฤติกรรม v1

**แบ่งงาน 2 ก้อน:**
- **ก้อน 1 (quick wins):** ข้อ 2, 3, 4, 5, 6 — แก้ใน `_v2/` ล้วนๆ + ปรับ payload ตอน export
- **ก้อน 2:** ข้อ 1 (avatar position หลังเรนเดอร์) — ต่อท่อ re-composite backend เดิม ใหญ่กว่าเพื่อน

---

## 1. ปรับตำแหน่งอวตารหลังเรนเดอร์ (step 3 / PostPhase)

**ปัญหา:** v2 ไม่มี UI ปรับ/save ตำแหน่งอวตารเลย — server ใช้ preset ที่เคย save จาก v1 เท่านั้น (`app/api/videos/jobs/route.ts:107-108` → `getAvatarPreset` → fallback `DEFAULT_AVATAR_LAYOUT {scale:1, offsetX:0, offsetY:0}`) ทำให้ user ที่ใส่อวตารครั้งแรกได้ตำแหน่งเพี้ยนและไม่มีทางแก้

**ดีไซน์ (ทางเลือก A — ปรับหลังเรนเดอร์):**
- ปุ่ม "ปรับตำแหน่งอวตาร" ในแผงขวาของ PostPhase — โชว์เฉพาะงานที่ใช้อวตาร (`useAvatar` + `avatarId` มีค่า)
- กดแล้วเข้าโหมดปรับทับ preview video: ลากย้ายตำแหน่ง (pointer drag) + slider scale — พอร์ต logic จาก v1 `OrderPanel.tsx:150-159` (`updatePosFromPointer`) + sliders `OrderPanel.tsx:858-870`; ค่า = `{scale 0.1..2.5, offsetX/Y −200..200}`
- กด "ใช้ตำแหน่งนี้" ทำ 2 อย่าง:
  1. `PUT /api/avatar-presets/[avatarId]` บันทึก preset ต่อ user+avatar (endpoint เดิมของ v1) → การเรนเดอร์ครั้งถัดไปถูกตั้งแต่แรก
  2. สั่ง **re-composite ฟรี** บนงานเดิม (ท่อ re-composite ที่ shipped ไปกับ avatar framing WYSIWYG / composite all-modes — ไม่เรียก HeyGen ใหม่ ไม่คิดเงินเพิ่ม) → โชว์ progress → เสร็จแล้ว preview อัปเดตเป็นตำแหน่งใหม่
- ซับที่แก้ค้างไว้ใน PostPhase **ต้องไม่หาย** ระหว่าง re-composite (state `captions/overrides/cfg` อยู่ฝั่ง client อยู่แล้ว — แค่เปลี่ยน video src ใหม่)
- ยกเลิกกลางคันได้ (ปิดโหมดปรับ = ไม่เกิดอะไร)

**Error handling:** re-composite ล้มเหลว → toast แจ้ง + preview เดิมยังใช้ได้ + preset ที่ save ไปแล้วคงอยู่ (ครั้งหน้ายังได้ประโยชน์)

## 2. คลังเพลง BGM (step 2)

**ปัญหา:** `Step2Elements.tsx:264-270` hard-cap `systemTracks.slice(0,6)` — ไม่มีเพลง user ไม่มีอัปโหลด ทั้งที่ `GET /api/music` ส่งครบ

**ดีไซน์ (ทางเลือก A — chips + modal คลังเต็ม):**
- chips ~6 เพลงแรกคงเดิม (เลือกเร็ว) + ปุ่ม "คลังเพลงทั้งหมด (N)" — N = system + user tracks รวม
- ปุ่มเปิด modal/sheet:
  - ช่องค้นหา (filter ชื่อเพลง client-side)
  - แท็บ "เพลงระบบ / เพลงของฉัน"
  - แต่ละแถว: ชื่อเพลง + ปุ่มฟัง preview (`new Audio(/api/music/…)` แบบเดียวกับ chips เดิม — เล่นได้ทีละเพลง) + กดแถวเพื่อเลือก
  - แท็บ "เพลงของฉัน" มีปุ่มอัปโหลด — ใช้ endpoint upload เดิมของ v1 (ผ่าน `useBgm` / `/api/music` flow เดิม)
- เลือกแล้ว modal ปิด → เพลงที่เลือกแสดงเป็น chip ติดถูก (ถ้าเพลงที่เลือกไม่อยู่ใน 6 ตัวแรก ให้แสดง chip ของเพลงนั้นเพิ่ม/แทนตัวท้าย)
- state เดิม `musicTrack` ใช้ต่อได้ แต่ต้องรองรับ user track ด้วย (v1 ชี้ผ่าน `/api/music/[filename]` — ตรวจ path ให้ตรงตอน submit `bgmFile`)

## 3. Waveform เสียงพากย์ใน timeline (step 3)

**ปัญหา:** v1 มี `WaveformCanvas` + `useAudioPeaks` + snap ซับเข้าเสียง (`waveform-snap.ts`) แต่ `_v2/TimelinePanel.tsx` ไม่ได้ใช้เลย — snap แค่ขอบการ์ดเพื่อนบ้าน + วินาทีเต็ม

**ดีไซน์:**
- เพิ่มเลนคลื่นเสียงใน `TimelinePanel` (วางใต้/แทนที่ตำแหน่งเหมาะสมในชุด 4 เลนเดิม): `useAudioPeaks(audioUrl)` + `<WaveformCanvas peaks={…}/>` — ใช้ `audioUrl` ของงานที่มีอยู่แล้วใน output
- ต่อ snap ขอบการ์ดซับเข้ากับจุดจากเสียง: `snapPointsFromSilence/Peaks` + `snapToNearest` จาก `_components/waveform-snap.ts` รวมเข้ากับ `snapMs` เดิม (`TimelinePanel.tsx:87-99`) — ลำดับ: จุดเสียง > ขอบการ์ดเพื่อนบ้าน > วินาทีเต็ม
- ถ้า `audioUrl` ไม่มี/โหลด peaks ไม่ได้ → เลนไม่แสดง + snap ตกกลับพฤติกรรมเดิม (fail-open)

## 4. การ์ดซับวิ่งตาม preview (step 3)

**ปัญหา:** highlight การ์ดผูกกับ `selected` (คลิกเลือก) เท่านั้น — `timeMs` มีอยู่แล้ว (`PostPhase.tsx:56`, จาก `onTimeUpdate`) แต่ไม่ได้ใช้กับลิสต์การ์ด

**ดีไซน์ (ทางเลือก A — ตามอัตโนมัติ + หยุดเมื่อเลื่อนเอง + ปุ่มกลับ):**
- การ์ด active = การ์ดที่ `timeMs` อยู่ในช่วง (ใช้ `_lib/find-active-caption.ts` ที่มีอยู่) → ใส่สไตล์ highlight แยกจาก `selected` (เลือกเพื่อแก้ ≠ กำลังพูด)
- ขณะเล่น: ลิสต์ `scrollIntoView({block:"nearest"})` ตามการ์ด active
- user เลื่อนลิสต์เอง (wheel/touch/scrollbar — แยกจาก programmatic scroll ด้วย flag) → หยุด auto-follow + โผล่ chip ลอยท้ายลิสต์ "⤓ กลับไปซับที่กำลังเล่น"
- กด chip → เลื่อนกลับ + resume follow · คลิกการ์ดไหน → seek preview ไปการ์ดนั้น (พฤติกรรมเดิม) + resume follow
- focus อยู่ใน textarea แก้ซับ → ไม่ auto-scroll เด็ดขาด (กันเลื่อนหนีตอนพิมพ์)

## 5. หลังส่งออกวิดีโอ

**ปัญหา (2 ส่วน):**
- Gallery ขึ้น "Untitled": export ส่ง `POST /api/videos` ด้วย `script:null, contentId:null` (`PostPhase.tsx:193-204`) → `videos/page.tsx:309` หา headline/script ไม่เจอ
- งานค้างใน editor: export ไม่เคลียร์ localStorage `editor-v2-job` (`useV2Job.ts:13`) → กลับเข้ามา resume งานเดิมขึ้น PostPhase อีก

**ดีไซน์ (ทางเลือก A — จบแบบมีทางกลับ):**
- export ส่ง `script` (ข้อความสคริปต์ของงาน) ไปกับ `POST /api/videos` → Gallery ตั้งชื่อจากสคริปต์อัตโนมัติเหมือน v1 — ไม่เพิ่มช่องกรอกชื่อ
- export สำเร็จ → เคลียร์ `editor-v2-job` ทันที + แสดงหน้า/แผง success:
  - ดาวน์โหลดวิดีโอ
  - ดูใน Gallery (ลิงก์ `/videos`)
  - **แก้ซับต่อ & ส่งออกใหม่** — กลับเข้า PostPhase ด้วย state ที่ยังอยู่ในหน้า (in-memory ทำงานต่อได้จนกว่าจะออกจากหน้า) — export ซ้ำ = ได้วิดีโอใหม่ใน Gallery อีกชิ้น (ตั้งใจ)
  - สร้างคลิปใหม่ — reset ทั้งหมดกลับ step 1
- ออกจากหน้าแล้วกลับเข้า `/video-editor` ใหม่ → เริ่ม step 1 สดเสมอ (job ที่ export แล้วไม่ resume)
- งานที่**ยังไม่ได้ export** คงพฤติกรรมเดิม: resume ได้ (คอมเมนต์ `useV2Job.ts:42-44` "ออกจากหน้าแล้วกลับมา งานไม่หาย" ยังจริงสำหรับงานค้าง)

## 6. Timeline ลาก scrub ได้ (step 3)

**ปัญหา:** ruler ใน `TimelinePanel.tsx:176-188` มีอยู่แล้วแต่รับแค่ `onClick` — ลาก scrub ไม่ได้ (v1 มี pointer-down/move ที่ `page.tsx:4885-4917`)

**ดีไซน์:**
- เปลี่ยน ruler เป็น pointerdown + pointermove + pointer capture → ลากแล้ว playhead + preview `currentTime` วิ่งตามต่อเนื่อง (แบบ v1)
- ขยาย hit area ruler ให้สูงขึ้น (16px → ~24px) จับง่ายขึ้น
- playhead เดิม (`:247-250`) คงไว้ — ตามค่าเดียวกัน

---

## การทดสอบ

- แต่ละข้อ verify ผ่านการใช้งานจริงใน browser (local rig: Clerk dev keys, login mewtest/OTP 424242) — โฟกัส flow: เรนเดอร์งานมีอวตารครั้งแรก → ปรับตำแหน่ง → re-composite → export → เช็คชื่อใน Gallery → กลับเข้า editor ต้องเริ่มสด
- ก้อน 1 ไม่แตะ render backend; ก้อน 2 (re-composite) build-verify ก่อน merge ตามธรรมเนียม
- ฟีเจอร์ทั้งหมดอยู่หลัง flag `EDITOR_V2` เดิม — ไม่กระทบ v1
