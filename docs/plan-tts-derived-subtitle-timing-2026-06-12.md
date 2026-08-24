# Plan: TTS-derived subtitle timing — จบปัญหาซับเพี้ยนถาวร · 2026-06-12

> **สำหรับ session ใหม่: อ่านไฟล์นี้ไฟล์เดียวพอ แล้วเริ่มที่ Phase/PR-A ได้เลย**
> เป้าหมาย: ทั้งสาย **Gemini AI Studio** (ไม่โคลนเสียง) และ **ElevenLabs** (โคลนเสียง)
> ต้องได้ซับตรงเสียง 100% ทุกความยาวคลิป — โดยเลิกให้ AI "ฟังเสียงแล้วเดาเวลา"

---

## 1. ทำไมต้องทำ (context 1 ย่อหน้า)

บัคซับเพี้ยนคลิปยาวไล่แก้มา 3 รอบ (PR #27-#34, ดู `docs/handoff-subtitle-chunking-2026-06-12.md`
+ memory `subtitle-long-clip-saga`): สาเหตุรากคือ timestamp จาก gemini-2.5-flash transcribe
**สุ่มทุกครั้งที่เรียก** — drift ไม่เป็นเชิงเส้น, ทิศทางสลับไปมา, words array บางทีหลอน/truncate
(108 คำ/105 การ์ด, เคยหลอนถึง 411s บนคลิป 285s) การ patch (#32-#34: sanitize → retry →
chunk 75s) ทำได้แค่ "ขังความเพี้ยนในกรอบ" ไม่มีวันเป๊ะ ทางออกถาวร: **เวลาเอามาจากขั้นสร้าง
TTS เลย** เพราะเสียงทุกไฟล์ใน flow หลักคือ TTS ที่เราสร้างเองจาก script

## 2. หลักการ + กฎเหล็ก

```
เดิม:  script → TTS → [flash ฟังเสียงเดาเวลา ← จุดสุ่มพัง] → ซับ
ใหม่:  script → [LLM ตัดการ์ด: text ล้วน] → TTS (เสียง + แผนที่เวลา ออกมาคู่กัน) → ซับทันที
```

- **กฎเหล็กข้อเดียว**: ข้อความที่ใช้สร้างซับ ต้องเป็น **สตริงเดียวกับที่ส่งเข้า TTS เป๊ะ ๆ**
  (บทเรียน VideoForge: เคย map ข้อความคนละเวอร์ชัน → "drifted heavily on transliterated content")
- LLM แตะได้เฉพาะ "การตัดข้อความเป็นการ์ด" — ห้ามยุ่งกับตัวเลขเวลาเด็ดขาด
- คลิปสั้น = 1 ท่อน ของ flow เดียวกัน → ไม่มีสอง mode ให้พังต่างกัน
- transcribe เดิม **ไม่ลบ** — เป็น fallback สำหรับเสียงที่ไม่ได้มาจาก TTS เรา
  (HeyGen avatar voice, ไฟล์อัปโหลด) ซึ่งมี chunk-75s + bidirectional retry (#34) คุมแล้ว

## 3. หลักฐานว่าแนวทางนี้ work (จากการ inspect VideoForge 06-12)

Repo: `https://github.com/mewic/VideoForge.git` (clone ไว้ที่ `/tmp/videoforge-inspect` —
ถ้าโดนลบ: `git clone --depth 1 https://github.com/mewic/VideoForge.git /tmp/videoforge-inspect`)

| สิ่งที่พบ | ตำแหน่ง | ความหมาย |
|---|---|---|
| ElevenLabs `/with-timestamps` + chunk ~1,500 chars + ffmpeg concat + **offset-merge alignment ด้วย ffprobe** | `main/pipeline/steps/02-tts.ts:147-326` | กลไกสาย ElevenLabs เขียนเสร็จแล้ว พิสูจน์แล้ว — **port ได้เกือบทั้งดุ้น** (ใช้ `language_code:'th'` + eleven_v3) |
| `context.alignment` ถูกสร้างแต่ **ไม่มีใครใช้ทั้ง repo** — ซับ/popup จริงใช้ Whisper/Gemini ฟังเสียง | grep `\.alignment` | ความเพี้ยนที่มิวจำได้จากยุค ElevenLabs **ไม่ใช่ความผิดของ alignment** (มันไม่เคยถูกใช้) แต่เป็น Whisper-ไทย + text mismatch |
| Google TTS ตัดท่อนทุก ~4,000 bytes (~30-60s ไทย) + concat ใช้งาน production จริงมานาน | `02-tts.ts:328-470` | **เสียง Gemini แบบต่อท่อนคุณภาพรับได้ — พิสูจน์เชิงประจักษ์แล้ว** แค่ไม่เคยจด offset (`alignment = null`) |
| helper `getMp3Duration` (ffprobe), `splitTextForChunkedTts` (ตัดที่จบประโยค) | `02-tts.ts:22-77` | ของพร้อมใช้ |

## 4. Design — สาย Gemini AI Studio (ทำก่อน เพราะเป็นเสียงหลักของลูกค้า)

ไฟล์หลักที่แก้: `src/app/api/videos/tts-gemini/route.ts` (ปัจจุบัน: call เดียวทั้ง script,
รับ `parts[0].inlineData` เป็น PCM s16le 24kHz mono แล้วเขียน WAV header เอง — บรรทัด 170-216)

### ขั้นตอน
1. **แบ่ง script ที่จบประโยค** เป็นท่อนละ ~15-30s ของการพูด (เริ่มที่ ~250-450 ตัวอักษรไทย/ท่อน
   — ทำเป็น const จูนได้) ใช้ pattern `splitTextForChunkedTts` ของ VideoForge
2. **TTS ทีละท่อน** (sequential + retry/backoff ตามโค้ดเดิม) → ได้ PCM buffer ต่อท่อน
3. **duration ต่อท่อน = `pcmBytes / (sampleRate × 2) × 1000` ms** — แม่นระดับ ms ไม่ต้อง ffprobe
   (parse `rate=` จาก mimeType ต่อท่อน, assert ว่าเท่ากันทุกท่อน)
4. **ต่อ PCM ด้วย `Buffer.concat`** → เขียน WAV header เดียว (โค้ด header เดิมใช้ได้เลย)
   → offset ท่อน i = ผลรวม duration ท่อน 0..i-1 — **เป๊ะ 100% โดยเลขคณิต**
5. **Guard ต่อท่อน (deterministic)**: chars-per-second ของท่อนต้องอยู่ใน ±40% ของ median
   ทุกท่อนในคลิป → ท่อนไหนหลุด (API คืนเสียงไม่ครบ/อ่านซ้ำ) retry เฉพาะท่อนนั้น (สูงสุด 3)
6. response เพิ่ม field (additive — client เก่าไม่พัง):
   ```ts
   {
     voiceUrl: string,
     audioDurationMs: number,
     timing: {
       provider: "gemini",
       segments: [{ text: string, startMs: number, durationMs: number }],
       chars: null,            // gemini ไม่มีระดับตัวอักษร
     }
   }
   ```

### เวลาภายในท่อน (สำหรับ words / การ์ดที่เล็กกว่าท่อน)
- เริ่มจาก **สัดส่วนตัวอักษรไทย** ภายในท่อน (โค้ดมี pattern อยู่แล้ว: `Intl.Segmenter("th")`
  + char-proportional ใน `transcribe/route.ts:1421-1462`)
- **ขัดเงาด้วย silencedetect** (Phase E): รัน ffmpeg silencedetect บนไฟล์รวม (โค้ดมีแล้วใน
  transcribe route: `detectSilences`) → ขอบการ์ด/ประโยคที่ interpolate ไว้ snap เข้า
  ช่วงเงียบจริงที่ใกล้สุดภายใน ±1.5s → ความคลาดภายในท่อนเหลือ ~±0.3-0.5s

## 5. Design — สาย ElevenLabs (โคลนเสียง)

ไฟล์หลักที่แก้: `src/app/api/videos/tts/route.ts` (ปัจจุบัน: POST ธรรมดา ได้ mp3)

1. เปลี่ยนเป็น `POST /v1/text-to-speech/{voiceId}/with-timestamps`
   (body เพิ่ม `language_code: "th"`; response = `{ audio_base64, alignment }`)
2. script ยาว: ตัดท่อน ~1,500 chars ที่จบประโยค → call ต่อท่อน → ffmpeg concat mp3
   → merge alignment โดย offset = ffprobe duration ของท่อนก่อนหน้า
   — **ลอกโครงจาก VideoForge `02-tts.ts:249-326` ได้ตรง ๆ** (รวมเหตุผลที่ใช้ ffprobe
   แทนตัวเลขท้าย alignment: "model occasionally clips trailing silence")
3. response:
   ```ts
   {
     voiceUrl, audioDurationMs,
     timing: {
       provider: "elevenlabs",
       segments: [...],        // ท่อน TTS (สำหรับ debug)
       chars: { characters: string[], startSec: number[], endSec: number[] }  // merged
     }
   }
   ```
   ความแม่น: ระดับตัวอักษร → โหมดแบ่ง 1 คำเป๊ะสนิท

## 6. ชั้นกลางร่วม: สร้าง captions + words จาก timing

ทำเป็น **lib pure function ใหม่ `src/lib/tts-timing.ts`** (test ได้ด้วย verify script):

```ts
buildWordsFromTiming(timing, fullText): { word, startMs, endMs }[]
//  - ตัดคำด้วย Intl.Segmenter("th") บน fullText (สตริงเดียวกับที่ส่ง TTS)
//  - EL: รวมเวลาจาก chars / Gemini: สัดส่วน char ภายใน segment

buildCaptionsFromCards(cards, timing, fullText): Caption[]
//  - cards = ผลตัดการ์ด (ช่วง char index บน fullText) → map เป็น startMs/endMs
//  - คืนรูปเดียวกับ data.captions ของ transcribe เดิม (text/startMs/endMs/tag)
```

### การตัดการ์ด (คงคุณภาพ viral style เดิม)
- **Phase แรก**: ตัดตามประโยค/บรรทัด (deterministic, ไม่มี LLM) — ใช้งานได้เลย
- **Phase ถัดไป**: route ใหม่ `/api/videos/split-script` — LLM (text-only, ไม่มี audio)
  ตัดการ์ดตามกฎเดิมใน transcribe prompt (กฎ 1-6: จุดหายใจ, 1 ซับ 1 ความคิด, ซับช็อก,
  ≤5s, hook/body/cta) แต่ **ตอบเป็นช่วงข้อความเท่านั้น ไม่มี timestamp ให้เดา**
  — แก้ Issue #2 ของมิว (การตัดคำ/split ไม่เนี้ยบ) ไปด้วยในตัว

## 7. Integration ฝั่ง editor (`src/app/(dashboard)/video-editor/page.tsx`)

- **กับดักที่ต้องระวัง (จาก PR-B)**: route ทำ `text.trim()` ก่อนส่ง TTS — fullText ที่ใช้กับ
  `buildWordsFromTiming`/`buildCaptionsFromCards` ฝั่ง editor ต้อง**ประกอบจาก
  `timing.segments.map(s => s.text).join("")`** เสมอ (ห้ามใช้ script state ตรง ๆ
  ไม่งั้น mismatch แล้วโดน `TtsTimingMismatchError` ตกไป fallback ฟรี ๆ)
- `runTts()` (~บรรทัด 1194): รับ `data.timing` → ถ้ามี:
  1. `buildCaptionsFromCards` + `buildWordsFromTiming` → `setCaptions`, `pipe.current.words`,
     `pipe.current.audioDurationMs` (ใช้ pipeline ปลายทางเดิมของ `runTranscribe` บรรทัด ~1446-1456)
  2. **ข้าม `runTranscribe()`** — mark step transcribe เป็น done "ซับจาก TTS ✓"
  3. ถ้า `timing` ไม่มี (เสียง avatar/อัปโหลด/route เก่า) → `runTranscribe()` ตามเดิม (fallback)
- `splitCaptionsByMode` ไม่ต้องแก้ — มันกิน `pipe.current.words` อยู่แล้ว
  (guard `boundWordsForSplit` ที่ใส่ใน #33 ก็ยังอยู่ เป็น defense ชั้นนอก)
- UI/ปุ่มทุกตัวเหมือนเดิม: ลากตำแหน่งซับ, แก้ข้อความ, แบ่ง N คำ realtime, BGM, avatar, Burn

## 8. แผน PR (เรียงลำดับ ทีละ PR เล็ก ๆ ตาม convention ทีม)

| PR | เนื้อหา | เทส |
|---|---|---|
| **A** | `src/lib/tts-timing.ts`: splitScriptForTts (ตัดประโยค), mergeSegmentTiming, buildWordsFromTiming, buildCaptionsFromCards, charsPerSecGuard | `scripts/verify-tts-timing.ts` (pure, เคสไทยจริง) |
| **B** | `tts-gemini/route.ts`: segmented generation + PCM concat + `timing` ใน response (additive) | verify + ยิงจริงบน dev ด้วย key ตัวเอง, เช็ค log per-segment |
| **C** | editor: ใช้ timing เมื่อมี + ข้าม transcribe + การ์ดแบบประโยค | เทสคลิปสั้น 1 นาที + ยาว 5-6 นาที บน prod |
| **D** | `tts/route.ts` (ElevenLabs): with-timestamps + merge (port VideoForge) | เหมือน C ด้วยเสียงโคลน |
| **E** | polish: LLM split-script route (การ์ด viral), silencedetect snap, อัปเดต STATUS.md/CLAUDE.md | เทสสไตล์ viral + แบ่ง 1 คำ |

แต่ละ PR: branch `mew/...` → PR เข้า main → verify scripts + tsc + build ผ่านก่อน merge
→ deploy (`bash deploy/deploy.sh` บน VPS, env ตาม CLAUDE.md) → เทสจริงก่อนเริ่ม PR ถัดไป

## 9. Checklist เทสรับงาน (ทำหลัง PR-C และ PR-D)

- [ ] คลิปสั้น (~1 นาที) Gemini: ซับตรงทั้งคลิป, ความยาว preview = ความยาวจริง
- [ ] คลิปยาว (5-6 นาที) Gemini: ซับตรง **ทุกช่วง** (ต้น/กลาง/ท้าย — จุดที่เคยพังคือ 2:20-2:30)
- [ ] กด "แบ่งซับ 1/3 คำ": preview เปลี่ยนสด, ไม่มีรูโหว่, ความยาวไม่เด้ง, คำสะกดตรง script
- [ ] กด "ประโยค" กลับ: คืนการ์ดต้นฉบับ
- [ ] ElevenLabs (โคลนเสียง) ซ้ำข้อ 1-4
- [ ] avatar bookend: ซับ offset ถูก / เสียง avatar (ไม่มี timing) ตกไป transcribe fallback ได้
- [ ] Burn & Download: ไฟล์สุดท้ายความยาวตรงเสียง ไม่มีหางเงียบ
- [ ] draft เก่า (มี captions แบบเดิม) เปิดได้ไม่พัง
- [ ] log ฝั่ง server: เห็น per-segment duration + guard/retry ของท่อนที่ผิดสัดส่วน

## 10. ความเสี่ยง / สิ่งที่ต้องวัดจริง

1. **Rate limit Gemini TTS preview (BYOK free tier)** — วัดใน PR-B: log latency/ท่อน;
   ตัวหมุนคือขนาดท่อน (ใหญ่ขึ้น = call น้อยลง = ความแม่นภายในท่อนลดนิดหน่อย)
   ถ้าชน 429 → ใช้ retry/backoff เดิมของ route + ขยายขนาดท่อน
   - **Adaptive chunk size (ตกลง 06-12)**: script สั้น (≤ ~2 นาทีพูด) ใช้ท่อนใหญ่ ~45-60s
     (~700-900 chars) เพื่อให้ผู้ใช้ free-tier key (ไม่ผูกบัตร) เจนคลิปสั้นได้เท่าเดิม;
     script ยาวใช้ท่อนมาตรฐาน 15-30s (กลุ่มนี้ต้องเปิด billing อยู่แล้ว — ~$0.03/นาทีเสียง)
     หมายเหตุ: ปี 2026 Google ไม่แปะตาราง limit สาธารณะแล้ว — ต้องวัดจริงใน PR-B
     (log 429 + ดู aistudio.google.com/rate-limit ของ key ทดสอบ) แล้วจดผลลง STATUS.md
   - **Fail-open ใน PR-B (ตกลง 06-12)**: ถ้า segmented generation ล้มเหลวหลัง retry
     → ถอยไปยิง single call แบบเดิมอัตโนมัติ + ไม่ส่ง `timing` → editor ตก transcribe
     fallback เอง = ผู้ใช้ไม่มีวัน "ใช้ไม่ได้" แค่ได้ซับแบบเดิมแทนซับเป๊ะ
   - **ข้อความ 429 บนคลิปยาว**: บอกตรง ๆ ว่า "คลิปยาวต้องเปิด billing ใน Google Cloud
     (~฿1/นาทีเสียง) หรือสลับ ElevenLabs" — ใช้โครง `getGeminiErrorInfo` เดิม
2. **รอยต่อเสียงระหว่างท่อน** — ความเสี่ยงต่ำ (VideoForge ทำแบบนี้ใน production มานาน)
   ลดเพิ่มได้ด้วยการตัดที่จบประโยคเสมอ
3. **Vertical ownership**: `tts/`, `tts-gemini/` อยู่ฝั่ง wao — **แจ้ง wao แล้ว 06-12 ✓**
   (เช็ค branch `dev_waow` แล้ว: ไม่แตะ tts routes เลย — ชนแค่ `video-editor/page.tsx`
   คนละโซนกับ runTts → **PR-C รอ dev_waow merge เข้า main ก่อน** ค่อยทำ)
4. ห้ามแตะของที่ใช้ร่วม (`prisma/schema.prisma`, `package.json`) — งานนี้ไม่จำเป็นต้องแตะ
   (หมายเหตุ: dev_waow ของ wao เพิ่ม `envatoKey` ใน schema — additive, ไม่ชนกับงานนี้)
5. **หน้าต่าง C→E (viral style)**: ระหว่าง PR-C ถึง PR-E การ์ดเป็นแบบตัดประโยค deterministic
   → ผู้ใช้สาย viral เห็นการ์ดจืดลงชั่วคราว — ทางเลือก: ขยับ split-script LLM มาชิด C
   หรือใน PR-C ให้เฉพาะโหมดประโยคใช้ timing ส่วนโหมด viral ยังตก transcribe เดิมจน E ลง
6. **Rollback**: ทั้งแผนไม่มี schema change / data migration → ทุก PR revert ได้สะอาด
   ด้วย `git revert` + redeploy; draft เก่า-ใหม่เก็บ captions รูปเดิม ข้อมูลลูกค้าไม่เสีย

## 11. สิ่งที่ "ห้ามพัง" (regression ที่เคยเจ็บมาแล้ว)

- `main` = production — ห้าม merge อะไรที่ build ไม่ผ่าน
- clip caps (`reserveClipUsage`) และ Gate 2 เพดาน 6 นาที (PRO) — flow ใหม่ต้องผ่าน gate เดิม
- transcribe fallback path (#32-#34) ต้องยังทำงาน: `src/lib/transcribe-timeline.ts` +
  verify scripts `verify-transcribe-*.ts` ต้องเขียวเสมอ
- editor mapper k (`captionEndMs/durationMs`, page.tsx ~201-210): flow ใหม่ทำให้ k=1 โดยนิยาม
  แต่โค้ด mapper ต้องคงไว้ (fallback path ยังพึ่งมัน)
