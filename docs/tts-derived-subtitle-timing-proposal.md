# Proposal: ย้าย subtitle timing ไปฝั่ง TTS (เลิกเดา timestamp จากการถอดเสียง) · 2026-06-12

> ร่างไว้คุยกับ wao — ยังไม่ลงมือ. Track A (retry สองทิศ + chunk 75s, PR #34) ซื้อเวลาให้แล้ว
> แต่ตราบใดที่ timing มาจาก Gemini ฟังเสียง มันจะ "สุ่ม" ทุกรอบ (หลักฐาน: saga 06-12, PR #32-#34)

## ปัญหาเชิงโครงสร้าง
ทุกคลิปในระบบคือเสียง TTS ที่**เราสร้างเองจาก script** — แต่เรากลับโยนเสียงนั้นให้
gemini-2.5-flash "ฟังแล้วเดาเวลา" ซึ่งพิสูจน์แล้วว่า:
- timestamp drift ไม่เป็นเชิงเส้นภายใน chunk, ทิศทาง/ขนาดสุ่มใหม่ทุก call
- words array บางครั้ง truncate/หลอน (108 คำ/105 ซับ, เหวี่ยง 154↔502)
- แก้ได้แค่ระดับ "พอใช้" ด้วย chunk เล็ก + retry + rescale (PR #27-#34)

## ทางแก้ถาวร: timing มาจากขั้น generate เสียงเลย
### ElevenLabs (ง่าย, API มีให้แล้ว)
- เปลี่ยน `POST /v1/text-to-speech/{voice}` → `/v1/text-to-speech/{voice}/with-timestamps`
- ได้ `alignment` ระดับตัวอักษร (char → start/end วินาที) พร้อมไฟล์เสียงในคำตอบเดียว
- สร้าง captions/words จาก alignment + script โดยตรง → ข้าม transcribe ทั้งขั้น
- แตะ: `src/app/api/videos/tts/route.ts` + จุดที่ editor เรียก transcribe (ส่ง captions มาแทน)

### Gemini TTS (ไม่มี timestamp API → ใช้ offset จากการต่อไฟล์)
- แบ่ง script เป็นท่อน (ประโยค/ย่อหน้า ~15-30s ต่อท่อน) → TTS ทีละท่อน (PCM 24kHz)
- ต่อ PCM ตรง ๆ (format เดียวกัน ไม่ต้อง re-encode) → **รู้ offset เริ่มของทุกท่อนแบบเป๊ะ 100%**
- ภายในท่อน: interpolate ตามสัดส่วนตัวอักษร (ท่อนสั้น 15-30s → คลาดเคลื่อนภายใน ≤ ~1s)
- ข้อแลก: หลาย call ต่อคลิป (RPM ของ TTS preview จำกัด — ต้อง batch ขนาดท่อนให้พอดี),
  prosody รอยต่อท่อนอาจสะดุดเล็กน้อย (ตัดที่จบประโยคช่วยได้)

### transcribe ยังต้องเก็บไว้สำหรับ
- เสียงที่ไม่ได้มาจาก TTS ของเรา (เช่น avatar/ไฟล์อัปโหลด) — เป็น fallback path เดิม

## ผลที่ได้
- ซับตรงเสียงแบบ deterministic ทุกคลิปทุกความยาว, ไม่มี retry/quota burn,
  ขั้น transcribe หายไปทั้งขั้นสำหรับ flow หลัก (เร็วขึ้น ~30-90s ต่อคลิป)
- ปิดทั้ง family ของบัค "ซับเพี้ยนคลิปยาว" ที่ไล่แก้กันมา 3 รอบ

## คำถามให้ wao
1. TTS routes อยู่ vertical ฝั่ง wao — ใครลงมือ/รีวิว?
2. Gemini TTS: ขนาดท่อนที่เหมาะกับ rate limit ของ key ลูกค้า (BYOK) คือเท่าไหร่?
3. editor flow: transcribe step จะถูก bypass ยังไงให้ draft/redo เดิมไม่พัง?
