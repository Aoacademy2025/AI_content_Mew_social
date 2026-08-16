# Handoff — Subtitle drift on long clips (chunking fix) · 2026-06-12

## ⭐ อ่านตรงนี้ก่อน (TL;DR สำหรับพรุ่งนี้)

- บั๊ก "ซับเพี้ยน/ไม่ตรงเสียง บนคลิปยาว" หา root cause เจอ + แก้ด้วยการ **chunk เสียงยาว**
- **ล่าสุด PR #31 deploy แล้ว แต่ยังไม่ได้ validate** — พรุ่งนี้ต้องเทส
- prod ตอนนี้ = main = commit `6d34f4f`

### 👉 พรุ่งนี้ทำแค่นี้:
1. **Refresh** `/video-editor` 1 ครั้ง (deploy เปลี่ยน build)
2. Generate **คลิปยาว 5-6 นาที** (script เดิมที่เคยเพี้ยน)
3. ดูว่า **ซับตรงเสียงทั้งคลิป** (ไม่ใช่แค่ 2:30 แรก, ไม่มีต้นคลิปซ้ำช่วงหลัง)
4. บอก Claude ตอน transcribe เสร็จ → เขาจะ grep prod log พิสูจน์ว่า **chunk 2 = เนื้อหาช่วงหลังจริง** (ไม่ใช่ "แปดสิบเปอร์เซ็นต์..." ซ้ำ)

---

## บั๊กคืออะไร
คลิปยาว (>~4 นาที): ซับวิ่งเร็ว/ไม่ตรงเสียง + บางช่วงซับหาย. คลิปสั้น (1-3 นาที) ปกติดี. เป็นทั้ง ElevenLabs และ AI Studio (Gemini) TTS.

## Root cause (audit จาก prod log จริง)
**Gemini audio-transcribe หลุด timestamp-sync บน audio ยาว** → คืน duration ปลอมที่ยาวเกินจริง (+6% ถึง +23%) → ซับ drift + เกิด gap ซับหาย.
ตัดออกด้วยหลักฐานแล้วว่า **ไม่ใช่**: avatar bookend (ffmpeg ประกอบรักษา timeline), editor mapper (k≈1), deploy วันนี้ (diff caption-sync = ว่าง).
**ทางเลือกที่ตัดทิ้ง:** Whisper (มิวลองแล้ว แย่กว่า), gemini-2.5-pro (rate-limit free-tier โหด 5 RPM/50-100 RPD vs flash 10/500).
**→ Fix ที่เลือก: คง flash แต่ chunk เสียงยาว** (เลี้ยง flash ให้อยู่ในโซน sync)

## วิธี Fix (chunking)
คลิป >4 นาที → ตัดที่ silence (ffmpeg silencedetect) เป็นท่อน ~2.5 นาที (cap 3.5) → transcribe แต่ละท่อนบน flash → offset timestamp + merge. คลิป ≤4 นาที = single-call เดิม ไม่แตะ.

---

## Saga วันนี้ (PR เรียงตามลำดับ — ทั้งหมด deployed แล้ว)

| PR | ทำอะไร | ผล |
|----|--------|-----|
| **#24** | transcribe model: เลิก fallback gemini-1.5 (ตาย 404) → 2.5-pro/flash-lite | ✅ |
| **#26** | desync guard: overshoot >10% → error retryable (กันซับพังเงียบ) | ✅ |
| **#27** | **chunking หลัก** — แบ่ง audio ยาว transcribe ทีละท่อน merge | ✅ |
| **#29** | (เดาผิด) คิดว่า slice seek พัง → ย้าย `-ss`. ภายหลังพิสูจน์ slice ดีอยู่แล้ว | ✅ harmless |
| **#30** | ข้าม desync guard เมื่อ chunked (14% tail overshoot, clamp จัดการได้) | ✅ |
| **#31** | **ตัวล่าสุด/ตัวจริง** — ส่ง script เฉพาะส่วนตามสัดส่วนให้แต่ละ chunk | ✅ deploy แล้ว **รอ validate** |

### บั๊กที่ไล่เจอระหว่างทาง (chunk 2 เอาต้นคลิปมาซ้ำ)
- อาการ: 2:30 แรกตรง, หลังจากนั้นเอาซับต้นคลิปมาใช้
- **พิสูจน์บน ffmpeg ของ VPS จริง**: slice ที่ offset 150s = ครึ่งหลังถูกต้อง (tone -21.5dB) → **slice ไม่ใช่ปัญหา**
- ต้นเหตุจริง: ส่ง **full script** (ขึ้นต้น "80%...") เป็น reference ให้ทุก chunk → Gemini ยึดต้น script แล้วพ่นต้นคลิปซ้ำ
- **#31 แก้:** ส่ง script เฉพาะส่วนของแต่ละ chunk (สัดส่วนเวลา ±12% margin)

---

## ⚠️ ตัวชี้ขาดที่ต้องเห็นในผล #31 (พรุ่งนี้)
prod log ตอน transcribe คลิปยาว ต้องเห็น:
```
[transcribe] chunked XXXs audio into N chunks at silence
[transcribe] merged N chunks → ... captions
```
และ raw ของ **chunk 1 vs chunk 2 ต้องต่างกัน** (chunk 2 ≠ "แปดสิบเปอร์เซ็นต์..." ซ้ำ)

## Known follow-ups (ถ้า #31 ยังไม่เป๊ะ 100%)
1. **Tail overshoot ~14%** — clamp จัดการ แต่ ~30 วิสุดท้ายอาจเพี้ยนนิด → ทำ per-chunk rescale ได้
2. **UX**: transcribe error → spinner ค้าง re-run ไม่ได้ (ยังไม่แก้)
3. **Issue #2 ของมิว (polish):** การตัดคำ/เว้นวรรค/Split subtitle ยังไม่เนี้ยบ — งานแยก ยังไม่เริ่ม

## ถ้าจะถอย (revert chunking)
revert #27/#29/#30/#31 → กลับ single-call เดิม (2:30 แรกดี ท้าย drift). #24/#26 เก็บไว้ได้

---

## งานอื่นวันนี้ที่ขึ้น prod แล้ว (ไม่ใช่บั๊กซับ)
- **#18-#21** Phase 1 backend hardening (WAL, quota fail-fast, kapokja fix, pollJob, fetchWithBudget)
- **#22** editor playback perf (60fps ออกจาก React root) — รอ validate ความลื่น
- **#23** docs
- **#25→#28** duration pre-flight gate — **#28 ถอด Gate 1 ออก** (estimate over 6x → false-block คลิป >1 นาที). เหลือ Gate 2 (exact) enforce เพดาน 6 นาที (PRO)

prod == main == `6d34f4f`. ไม่มี PR open ค้าง (ทุกตัว merged).
