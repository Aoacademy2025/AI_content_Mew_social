# Hero Voice — การทดลองปรับขั้นข้อความบน first version

วันที่ 2026-09-06 (อัปเดต 2026-09-07) · สถานะ: **แขน A รัน 4 รอบบน image เดิม · สูตรผ่านหูมิวแล้ว (golden 03C, 08D) · ขั้นถัดไป = port เข้าแอป (§11 รอมิว go)** · แขน B ยังติด workflow freeze

ต่อจาก `/tmp/hero-voice-fine-tune-handoff-2026-09-05.md` และ
`docs/plans/2026-09-05-hero-voice-first-sample.md`

## 1. เป้าหมาย

แก้สองอาการที่มิวฟังเจอใน first version โดย **ไม่แตะค่าที่ทำให้เสียงเหมือนและความเร็วโอเค**

| อาการ | เป้าหมายหลังทดลอง |
| --- | --- |
| ตัวเลขดิบไม่อ่านเป็นไทย | ตัวเลข วันที่ เวลา หน่วย ราคา รหัส อ่านเป็นคำไทยถูกความหมาย |
| คำอังกฤษแทรกไทยแล้วสำเนียงเปลี่ยนกะทันหัน | คำอังกฤษที่แทรกในประโยคไทยอ่านด้วยเสียง/สำเนียงเดียวกับส่วนไทย ไม่มีรอยต่อ |

ไม่อยู่ในขอบเขต: train weights ของโมเดล, parity กับเครื่องทีม, merge `dev_waow`,
เปลี่ยน routing production, รันคลิป 02/05/07 ซ้ำ, ต่อเข้า AI Studio

## 2. baseline ที่ตรึงไว้ (ห้ามเปลี่ยนในการทดลองนี้)

ทุกงานใช้ค่าชุดเดียวกับชุด `mew-voice-test-*` วันที่ 2026-09-05:

- reference เดิม (10.000 s, mono 24 kHz PCM16) และ `ref_text` เดิม
- profile `combined-quality-v1`: Demucs เปิด, peak 0.95, best-of-3,
  ranking = speaker cosine + 0.15 × pitch, watermark ปิด
- `speed` 1.0 (runtime คูณ 1.4 ก่อนเข้าโมเดล), `num_step` 32,
  guidance 2.0, class_temperature 0.8, `seed` 20260905
- `matched_settings_sha256` ต้องเท่าเดิมทุกงาน (พิสูจน์ว่า speed/steps ไม่ขยับ)

สิ่งเดียวที่เปลี่ยนคือ (ก) ข้อความที่ส่งเข้า worker และ (ข) นโยบายแบ่งช่วงภาษาใน worker
สำหรับงานที่ระบุเท่านั้น

## 3. สาเหตุที่ยืนยันจากโค้ด first version

อ่านจาก `services/omnivoice-clone-runpod/` ที่ HEAD `f5cbae76`:

1. worker ไม่แปลงข้อความเลย (`language.py` docstring "no text rewriting";
   stage `speech_text_attestation = application-speech-text/no-worker-rewrite-v1`)
   และ operator ของชุด 8 คลิปส่งข้อความดิบตรง ๆ ข้าม `prepareHeroVoiceSpeech`
   ของแอป → ตัวเลขดิบไปถึงโมเดลเป็นตัวเลข
2. `split_by_language` แยกทุกช่วงอักษรละตินออกจากไทย แล้ว `generate_candidates`
   สร้างแต่ละช่วงด้วย `language="English"` / `"Thai"` แยกกัน จากนั้น
   `np.concatenate` ต่อตรง ๆ → คลิป 03 = 19 ช่วง/candidate = 57 model calls
   ช่วงอังกฤษได้สำเนียงเจ้าของภาษาและมีรอยต่อทุกครั้งที่สลับ

ทั้งสองข้อเป็นขั้น **ก่อนเข้าโมเดล** จึงแก้ได้โดยไม่แตะ weights

## 4. การออกแบบ

### 4.1 ขั้นข้อความฝั่งแอป (ไม่แตะ worker)

ใช้ `src/lib/hero-voice-speech.ts` (`prepareHeroVoiceSpeech`, normalizer
`2026-07-24.1`) เป็นฐาน เพราะรันกับ 8 สคริปต์แล้วผ่านเกือบหมด
(หลักฐาน: `/tmp/hero-voice-parity-audit-2026-09-05/app-normalizer-results.json`)
เพิ่มกฎ 2 ข้อ แล้ว bump เป็น `2026-09-06.1`:

| กฎใหม่ | ตัวอย่าง | เหตุผล |
| --- | --- | --- |
| รหัสตัวอักษร+ตัวเลขติดกัน `^[A-Za-z]{1,4}\d{1,6}$` → สะกดตัวอักษรเป็นชื่อไทย + อ่านตัวเลข **ทีละหลัก** | `A07` → `เอ ศูนย์ เจ็ด`, `MP3` → `เอ็ม พี สาม` | ปัจจุบันได้ `Aเจ็ด` ศูนย์หาย ความหมายรหัสเพี้ยน |
| ขนาด `ตัวเลข x ตัวเลข` (`x`, `X`, `×`) → `คูณ` | `1920 x 1080` → `หนึ่งพันเก้าร้อยยี่สิบ คูณ หนึ่งพันแปดสิบ` | ปัจจุบัน `x` ค้างเป็นละติน และ `×` ถูกตีเป็น risk block |

กฎเดิมที่ **คงไว้โดยตั้งใจ** (เป็นการตัดสินใจเรื่องความหมาย ไม่ใช่ข้อบกพร่อง):

- เงินทศนิยม ≤ 2 หลัก → บาท/สตางค์ (`1,250.50 บาท` → `หนึ่งพันสองร้อยห้าสิบบาทห้าสิบสตางค์`)
- เงินทศนิยม > 2 หลัก → อ่าน `จุด` ทีละหลัก (`1,062.925 บาท` → `หนึ่งพันหกสิบสองจุดเก้าสองห้า บาท`)
  ไม่ใช้แบบทีมที่ตัดเหลือ `เก้าสิบสองสตางค์` เพราะเปลี่ยนค่าตัวเลข
- เบอร์โทร/OTP/PIN/รหัสผ่าน อ่านทีละหลัก (มี context rule อยู่แล้ว)
- ตัวย่อพิมพ์ใหญ่ 2–6 ตัว สะกดชื่ออักษร (`API` → `เอ พี ไอ`)
- วันที่ `วันที่ 5 กันยายน 2026` → `ห้า กันยายน สองพันยี่สิบหก`, เวลา `09:30 น.` → `เก้านาฬิกาสามสิบนาที`
- ข้อความแสดงผล (ซับ/สคริปต์ที่ผู้ใช้เห็น) **ไม่เปลี่ยน**; ข้อความอ่านเป็นคนละ field
  พร้อม `risks` เดิม

เทสต์: เพิ่ม fixture ใน `scripts/verify-omnivoice.ts` (รูปแบบเดิม
`prepareHeroVoiceSpeechText(display) === spoken` และ idempotent) สำหรับ
`A07`, `MP3`, `1920 x 1080`, `1920×1080`, และเคสที่ต้องไม่โดน: `GPT-5`, `1080p`
(digits นำหน้า อยู่นอกกฎ คงพฤติกรรมเดิม), `เบอร์โทร 081-234-5678`

### 4.2 dictionary คำอ่านไทยสำหรับคำอังกฤษ (ทาง A)

ใช้กลไก `data/hero-voice/thai-pronunciations.json` ที่มีอยู่ (longest-match,
case-insensitive, ต้องมี `reviewedBy`) แต่สำหรับการทดลองนี้เก็บเป็นไฟล์ส่วนตัว
ของ operator ก่อน ยังไม่ commit ลง data จนกว่ามิวยืนยันคำสะกด:

| คำ | คำอ่านเสนอ | ที่มา |
| --- | --- | --- |
| Hero AI Studio | ฮีโร่ เอไอ สตูดิโอ | ทีมใช้ `ฮีโร เอไอ สตูดิโอ` เสนอเติมไม้เอกให้ตรงเสียงจริง |
| short video | ชอร์ต วิดีโอ | dictionary ทีม |
| YouTube | ยูทูบ | dictionary ทีม |
| TikTok | ติ๊กต่อก | dictionary ทีม |
| content | คอนเทนต์ | dictionary ทีม |
| video | วิดีโอ | dictionary ทีม |
| voice cloning | วอยซ์ โคลนนิ่ง | ใหม่ |
| preview | พรีวิว | ใหม่ |
| export | เอ็กซ์พอร์ต | ใหม่ |
| RunPod | รันพ็อด | golden เดิมของ canary (`hero-voice-canary-objective-evidence.server.ts`) ไม่ใช่ รันพอด |
| Serverless | เซิร์ฟเวอร์เลส | ใหม่ |
| OmniVoice | ออมนิวอยซ์ | ใหม่ |
| Gemini | เจมิไน | golden เดิมของ canary |
| ElevenLabs | อีเลฟเวนแล็บส์ | ใหม่ |
| Remotion | รีโมชัน | ใหม่ |
| dashboard | แดชบอร์ด | ใหม่ |

`API`, `GPU`, `WAV`, `MP3` ไม่ต้องใส่ dictionary เพราะกฎตัวย่อ/รหัสจัดการแล้ว

ผลคือข้อความทาง A เป็นอักษรไทยล้วน → `split_by_language` ให้ช่วงเดียว
→ **ใช้ image เดิมได้ ไม่ต้องแก้ worker**

### 4.3 นโยบายแบ่งช่วงแบบไทยเป็นหลักใน worker (ทาง B)

เพิ่ม profile ใหม่ `combined-quality-thai-dominant-v1` = stages เดิมของ
`combined-quality-v1` ทุกอย่าง ต่างแค่ขั้นแบ่งช่วง:

1. รัน `split_by_language` เดิม (คงเทสต์ character-preservation)
2. ถ้าข้อความไม่มีอักษรไทยเลย → คงเดิม (English ล้วน)
3. ถ้ามีไทย → ช่วงอังกฤษที่ยาว **≤ 4 คำ** ถูกหลอมรวมกับช่วงไทยข้างเคียงและอ่านด้วย
   `language="Thai"`; ช่วงอังกฤษ ≥ 5 คำ ยังแยกและอ่านด้วย `language="English"`

ผลกับสคริปต์จริง: คลิป 03 ทุก run อังกฤษ ≤ 3 คำ → **1 ช่วง Thai** (จาก 19);
คลิป 02 run อังกฤษยาว → English + `ครับ` Thai เหมือน v13 (พฤติกรรมไม่เปลี่ยน);
คลิป 01/04/05/06/07 ไม่มีละติน → ไม่เปลี่ยน

stage identity ใหม่ `thai_dominant_segmentation =
"thai-english-v13/merge-english-runs-max4words-into-thai-v1"` เพื่อให้
result บอกได้ว่างานนี้ใช้นโยบายไหน; `CONTROL_PARITY` และ profile เดิมไม่แตะ

ความไม่แน่นอนหลักที่การทดลองนี้ตอบ: OmniVoice โหมด Thai อ่านอักษรละตินได้ดีแค่ไหน
(อ่านด้วยสำเนียงไทย / อ่านเป็นอังกฤษอยู่ดี / สะกดตัวอักษร / ข้าม) ไม่มีเอกสาร
ยืนยันจาก upstream จึงต้องฟังจริง

### 4.4 ทำไมต้องทดสอบทั้ง A และ B

| | A: แปลงเป็นอักษรไทย | B: คงละติน อ่านโหมดไทย |
| --- | --- | --- |
| แก้ worker | ไม่ | ใช่ (profile ใหม่ + image ใหม่) |
| ต้องมี dictionary | ใช่ ทุกคำใหม่ต้องเพิ่มเอง คำที่หลุดจะกลับไปสำเนียงอังกฤษ | ไม่ |
| ความเสี่ยงเสียง | คำอ่านสะกดผิดจะผิดถาวร | ไม่รู้ว่าโมเดลอ่านละตินโหมดไทยได้ |
| สเกลกับผู้ใช้จริง | ต้องดูแล dictionary ตลอด | ครอบคลุมคำที่ไม่เคยเห็น |

ถ้า B ฟังผ่าน จะเป็นทางหลักและใช้ dictionary เฉพาะคำที่โมเดลอ่านผิด
ถ้า B ไม่ผ่าน A คือทางเดียวที่เหลือและต้องลงทุน dictionary

## 5. งานที่จะรัน (7 งาน, งาน 08B เลือกได้)

| งาน | ข้อความส่งเข้า worker | profile | ตอบคำถามอะไร |
| --- | --- | --- | --- |
| 01-control | เหมือนเดิมทุกตัวอักษร | combined-quality-v1 | ยืนยันว่า image/worker ใหม่ให้เสียง **byte-identical** กับ `01-thai.wav` เดิม → ไม่มีอะไรนอกจากข้อความที่เปลี่ยน |
| 03A | ข้อความ dictionary ไทยล้วน (§4.2) | combined-quality-v1 | ทาง A |
| 03B | ข้อความเดิม | combined-quality-thai-dominant-v1 | ทาง B |
| 04 | ผ่าน normalizer `2026-09-06.1` | combined-quality-v1 | ตัวเลข ราคา ทศนิยม เปอร์เซ็นต์ เทียบคลิป 04 เดิมและคลิป 05 (คำอ่านที่มิวเขียนเอง) |
| 06 | ผ่าน normalizer `2026-09-06.1` | combined-quality-v1 | วันที่ เวลา หน่วย `คูณ` และรหัส `เอ ศูนย์ เจ็ด` |
| 08A | normalizer + dictionary | combined-quality-v1 | ชื่อผลิตภัณฑ์ ทาง A |
| 08B (เลือกได้) | normalizer อย่างเดียว คงชื่ออังกฤษ | combined-quality-thai-dominant-v1 | ชื่อผลิตภัณฑ์ ทาง B |

ข้อความที่จะส่งจริง (คำนวณล่วงหน้า ต้องตรงกับ output ของโค้ดตอน implement
ถ้าไม่ตรงถือว่าโค้ดผิดหรือ spec ผิด ต้องแก้ก่อนรัน):

- 03A: `วันนี้มิวใช้ ฮีโร่ เอไอ สตูดิโอ สร้าง ชอร์ต วิดีโอ สำหรับ ยูทูบ และ ติ๊กต่อก ครับ เริ่มจากเขียน คอนเทนต์ แล้วเลือก วอยซ์ โคลนนิ่ง ก่อนกด พรีวิว และ เอ็กซ์พอร์ต เป็นไฟล์ วิดีโอ ครับ`
- 04: `สินค้าราคา หนึ่งพันสองร้อยห้าสิบบาทห้าสิบสตางค์ ลด สิบห้าเปอร์เซ็นต์ เหลือ หนึ่งพันหกสิบสองจุดเก้าสองห้า บาทครับ มีสินค้า ยี่สิบเอ็ด ชิ้น ผู้ติดตาม หนึ่งหมื่นเอ็ด คน และยอดเข้าชม หนึ่งล้าน ครั้งครับ`
- 06: `นัดวันที่ ห้า กันยายน สองพันยี่สิบหก เวลา เก้านาฬิกาสามสิบนาที ครับ ระยะทาง สามจุดห้ากิโลเมตร อุณหภูมิ สามสิบเจ็ดจุดห้า องศาเซลเซียส ขนาด หนึ่งพันเก้าร้อยยี่สิบ คูณ หนึ่งพันแปดสิบ พิกเซล และรหัสทดสอบ เอ ศูนย์ เจ็ด ครับ`
- 08A: `ทดสอบคำว่า รันพ็อด เซิร์ฟเวอร์เลส, ออมนิวอยซ์, เจมิไน, อีเลฟเวนแล็บส์ และ รีโมชัน ครับ ระบบเชื่อมต่อผ่าน เอ พี ไอ ใช้ จี พี ยู ประมวลผล แล้วส่งไฟล์ ดับเบิลยู เอ วี และ เอ็ม พี สาม กลับมาที่ แดชบอร์ด ครับ`
- 08B: `ทดสอบคำว่า RunPod Serverless, OmniVoice, Gemini, ElevenLabs และ Remotion ครับ ระบบเชื่อมต่อผ่าน เอ พี ไอ ใช้ จี พี ยู ประมวลผล แล้วส่งไฟล์ ดับเบิลยู เอ วี และ เอ็ม พี สาม กลับมาที่ dashboard ครับ`

`normalizer_version` ในคำขอ: `app-2026-09-06.1` สำหรับงานที่ผ่าน normalizer,
`app-2026-09-06.1+dict-mew-2026-09-06` สำหรับ A, `language-suite-verbatim-v1`
สำหรับ 01-control และ 03B (ข้อความเดิมเป๊ะ)

image: build ใหม่จาก worktree หนึ่งครั้ง (มี profile B) ตรึง digest แล้วรันทุกงานบน
image เดียว endpoint เดียว worker 1 ตัว แบบเดียวกับ first sample
ถ้า build/verify_image ไม่ผ่านในเวลาที่ตกลง ให้ fallback: รัน 01-control, 03A, 04,
06, 08A บน digest เดิม `8afa2ae5…` (ต้องตรวจก่อนว่า image ยังอยู่ใน registry)
และเลื่อน 03B/08B

## 6. วิธีเทียบกับ WAV เดิม

ผล JSON ที่เก็บจากรอบก่อนไม่มี candidate metrics/hash (ตัดออกตามนโยบายไม่ emit
audio-linked hash) จึงเทียบจากไฟล์เสียงในเครื่องแทน ทั้งหมดทำ offline ไม่ส่งเสียงออก:

**อัตโนมัติ (script ส่วนตัวใน `/tmp`, output เป็นตัวเลขเท่านั้น):**

| ตรวจ | เกณฑ์ |
| --- | --- |
| 01-control vs `01-thai.wav` เดิม | byte-identical (ถ้าไม่ตรง หยุด รายงาน แล้วหาสาเหตุก่อนอ่านผลอื่น) |
| speaker cosine (resemblyzer CPU) ใหม่ vs reference, เทียบเดิม vs reference | ใหม่ต้องไม่ต่ำกว่าเดิมเกิน 0.02 ต่อคลิป (guard ความเหมือนเสียง) |
| ความยาวใหม่ / ความยาวเดิม | 04, 06, 08 ยาวขึ้นได้เพราะคำอ่านยาวกว่าตัวเลข; 03 ต้องอยู่ใน 0.7–1.3 |
| `matched_settings_sha256`, profile, stage identities ในทุก result | ตรงตาม §2 และ §5 |
| ระดับสัญญาณ/clipping | ตามเช็กเดิมใน `audio-checks.json` |

**ฟังโดยมิว (ตัดสินจริง):** ส่งไฟล์ลง root `AI_content_Mew_social` แบบเดิม
ตั้งชื่อชุด `mew-voice-tune-*`:

- `mew-voice-tune-ab-03.wav` … ต่อคลิปที่ทดสอบ: **เดิม → เงียบ 1 s → ใหม่** (03 มี A และ B)
- `mew-voice-tune-all.wav`, `mew-voice-tune.zip`, `mew-voice-tune-scripts.txt`
  (บอกว่าแต่ละคลิปส่งข้อความอะไรเข้าโมเดล และจุดที่ควรฟัง)

จุดฟังต่อคลิป:
- 03A/03B: คำอังกฤษยังเป็นเสียงมิวสำเนียงไทยไหม มีรอยต่อไหม เข้าใจคำไหม
- 04: เทียบกับคลิป 05 เดิม (คำอ่านที่มิวเขียน) ควรใกล้เคียง
- 06: `เก้านาฬิกาสามสิบนาที`, `คูณ`, `เอ ศูนย์ เจ็ด` ชัดและถูกไหม
- 08A/08B: ชื่อผลิตภัณฑ์เข้าใจไหม คำไหนสะกดคำอ่านผิดต้องแก้ dictionary

## 7. เกณฑ์ตัดสินและก้าวถัดไปตามผล

| ผล | ก้าวถัดไป |
| --- | --- |
| B ผ่านหู + cosine ไม่ตก | ทาง B เป็นหลัก; dictionary เฉพาะคำที่โมเดลอ่านผิด; ค่อยคุยต่อ AI Studio |
| B ไม่ผ่าน, A ผ่าน | ทาง A; ต้องวางกระบวนการ dictionary (ใครเพิ่ม/รีวิว) ก่อนใช้กับผู้ใช้จริง |
| ทั้งคู่ไม่ผ่านแต่ตัวเลขผ่าน | เก็บ normalizer; ปัญหาอังกฤษต้องไปทางอื่น (คุยใหม่ ไม่ต่อยอดในรอบนี้) |
| 01-control ไม่ identical | หยุดทั้งหมด หาสาเหตุ (GPU type, build, seed) ก่อนเชื่อผลใด ๆ |

## 8. งานก่อนรัน (ตามลำดับ) และไฟล์ที่จะแตะ

ทั้งหมดใน worktree `hero-voice-clone-prod-audit` branch `codex/hero-voice-clone-prod-audit`
ไม่แตะ root, ไม่ push, ไม่ merge, ไม่ deploy

1. **แอป**: `src/lib/hero-voice-speech.ts` (กฎรหัส + `คูณ`, bump version),
   `scripts/verify-omnivoice.ts` (fixtures §4.1) → รัน verify ผ่าน
2. **worker**: `language.py` (ฟังก์ชันหลอมช่วง ≤ 4 คำ), `runtime.py`
   (รับ policy จาก pipeline), `pipeline.py` (profile + stage identity ใหม่),
   `contract.py` (`EXPERIMENT_PROFILES`), `test_contract.py`
   (เทสต์ 4 เคส: คลิป 03 → 1 ช่วง, คลิป 02 → 2 ช่วง, English ล้วน, character preservation),
   `emit_cross_boundary_fixtures.py`/fixtures ถ้าอ้าง profile list,
   `SOURCE_MANIFEST.json`/`RUNTIME_MANIFEST.json` digest ใหม่ (ขั้นตอนใน README ของ worker)
   → `python3 -m unittest test_contract` ผ่าน
   **ไม่ bump `worker_version`** (คง `…-internal-eval-2`): profile เดิม 6 ตัวพฤติกรรมเท่าเดิมทุกไบต์
   ตัวตนของ build ใหม่ผูกกับ `source_manifest_sha256` + image digest อยู่แล้ว และ
   การ bump จะลามไปแก้ค่า pin ในแอป 6 ไฟล์โดยไม่เพิ่มความจริงอะไร
   ฝั่ง TS ต้องรู้จัก profile ใหม่เพราะ verifier ข้ามภาษาบังคับให้ชุด profile ตรงกัน:
   `hero-voice-canary-wire.ts`, `hero-voice-clone-runners.ts` (STAGES/identity/sets),
   `hero-voice-canary-manifest.ts`, `hero-voice-canary-ledger.server.ts`,
   `verify-hero-voice-clone-task2.ts`; แอป production ยัง pin `combined-quality-v1` เท่าเดิม
3. **operator ส่วนตัว** ใน `/tmp/hero-voice-text-stage-2026-09-06/`: สร้าง cases
   จาก §5 โดยเรียก normalizer ของแอปจริงผ่าน `tsx` (ไม่พิมพ์ข้อความมือ)
   + dictionary ส่วนตัว, ตรวจว่าตรงกับข้อความใน §5 ทุกตัวอักษร, script เทียบ §6
4. **build image** — เครื่อง Mac ไม่มี docker; image สร้างได้ทางเดียวคือ GitHub Actions
   `.github/workflows/hero-voice-clone-canary-image.yml` ซึ่งรันเมื่อ push ไป
   `mewic/hero-voice-clone-prod-audit` **แต่ถูก freeze ไว้ (`if: false`, commit `e2b4f6c4`
   "Task 6 rights are NO-GO")** การเปิดกลับเป็นการตัดสินใจของมิว ไม่ใช่ของ agent
   ทางเลือก: (ก) มิวเปิด workflow ชั่วคราว + push branch → ได้ image ที่มี profile B
   (ข) รันเฉพาะแขน A (01-control, 03A, 04, 06, 08A) บน digest เดิม `8afa2ae5…`
   ไม่ต้อง build ไม่ต้อง push; 03B/08B รอ
5. **reconcile งบ**: billing readback รอบก่อน (`billing-readback.json`,
   `previous-run-billing.json`) ยังคืน 0 record ทั้งสอง endpoint = provider lag
   ต้อง query ใหม่ก่อนรัน ถ้ายังไม่มีตัวเลข settle ให้แจ้งมิวว่าจะรันภายใต้เพดาน
   US$10 เดิมโดยไม่รู้ยอดที่ใช้ไป แล้วรอคำตอบ
   ประมาณการรอบนี้จากเวลาทำงานจริงรอบก่อน (คลิป 03: synthesis 47 s + ranking 11 s;
   คลิปอื่นสั้นกว่า): 7 งาน ≈ 5–7 นาที execution + cold start ไม่ใช่บิลจริง
6. **ขออนุมัติรัน GPU** แยกจาก spec นี้ พร้อม digest, รายการงาน, ยอดงบที่รู้

## 9. ความเสี่ยงและความไม่แน่นอนที่ตั้งชื่อไว้

- OmniVoice โหมด Thai กับอักษรละติน ไม่มีเอกสารยืนยัน (ทาง B อาจล้มทั้งทาง)
- byte-identical ของ 01-control ตั้งอยู่บนสมมติฐาน GPU type เดิม + `cudnn.deterministic`
  + lock เดิม ถ้าได้ GPU คนละรุ่นอาจไม่ identical โดยไม่ได้แปลว่าโค้ดผิด ต้องบันทึก GPU
  ที่ได้ในทุกงาน
- คำอ่านใน dictionary เป็นการเดาเสียงของผม ต้องให้มิวยืนยันสะกดก่อนรัน
  (คำผิดตอนนี้ = เสียงผิดในผลทดลอง)
- threshold 4 คำ เป็นค่าเริ่มต้นเชิงเหตุผล ไม่ได้มาจากข้อมูล ถ้า B ผ่านค่อยหาค่าที่เหมาะ
- normalizer ใส่ช่องว่างรอบตัวเลข (`มีสินค้า ยี่สิบเอ็ด ชิ้น`) ต่างจากคลิป 05 ที่มิวเขียนติดกัน
  อาจมีผลกับจังหวะ ถ้า 04 ฟังต่างจาก 05 ให้ดูข้อนี้ก่อน
- ผลรอบก่อนไม่มี cosine ต่อ candidate เก็บไว้ การเทียบ cosine ทำใหม่ทั้งสองฝั่งด้วย
  resemblyzer บน CPU จึงเป็นตัวเลขเชิงเทียบ ไม่ใช่ตัวเลขเดียวกับใน worker

## 10. สถานะหลัง implement (2026-09-06)

- แอป: กฎรหัส + คูณ, normalizer `2026-09-06.1`, fixtures 2 ชุดใน `thai-speech-cases.json`;
  script verify 3 ตัวที่เคย hardcode `2026-07-24.1` เปลี่ยนมาใช้ค่าคงที่ที่ export
- worker: `split_thai_dominant` + profile `combined-quality-thai-dominant-v1` + stage identity,
  เทสต์ใหม่ 5 ตัว, digest ทุกชั้นรีเฟรชแล้ว
- ผ่าน: `verify:omnivoice`, `verify:hero-voice-clone-task2`, `verify:hero-voice-clone`,
  `python3 -m unittest test_contract` (62), `tsc --noEmit`, eslint ไฟล์ที่แก้
- operator ส่วนตัว `/tmp/hero-voice-text-stage-2026-09-06/`: `dictionary.json`,
  `build-cases.ts` → `cases.json` (ข้อความตรง §5 ทุกตัวอักษร ยกเว้น รันพ็อด ตามข้างบน),
  `compare.py` (§6 อัตโนมัติ), `deliver.py` (ไฟล์ฟังลง root)
- ยังไม่ทำ: build image (ข้อ 4, ติด freeze), reconcile งบ, รัน GPU

## 10 (เดิม). สิ่งที่ต้องการจากมิวก่อน implement — ตอบแล้ว "approve" ทั้งสามข้อ

1. ยืนยัน/แก้คำอ่านใน dictionary §4.2 (โดยเฉพาะ ฮีโร่, เจมิไน, อีเลฟเวนแล็บส์, รีโมชัน)
2. รับหรือแก้กฎความหมาย §4.1 (เงินทศนิยม > 2 หลักอ่าน `จุด`, รหัสอ่านทีละหลัก)
3. จะรวม 08B ไหม (งานที่ 7)

หลังยืนยัน ผมทำข้อ 1–4 ของ §8 ได้เลยโดยไม่ต้องใช้ GPU และกลับมาขออนุมัติรันในข้อ 6

## 11. ผลการทดลอง 4 รอบ (2026-09-06) และแผน port เข้าแอป

### 11.1 สิ่งที่พิสูจน์แล้วด้วยหูมิว (+ ASR ยืนยัน)

| รอบ | เปลี่ยนอะไร | ผล |
| --- | --- | --- |
| 1 | normalizer + dictionary (ทาง A) | ตัวเลข/อังกฤษดีขึ้น 80–90 % ยังอ่านติด ๆ, `1,062.925` ผิด |
| 2 | **ตัดช่องว่าง** รอบตัวเลข/คำแปล ให้ติดกันเหมือนคลิป 05 ที่มิวเขียนเอง | ตัวเลขถูกหมด ธรรมชาติกว่า → ช่องว่างคือสาเหตุ; เหลือรีบ/ลิ้นพันช่วงท้าย |
| 3 | **ตัดประโยคที่ ครับ** สร้างแยกแล้วต่อ (หยุด 250 ms); สะกดตัวย่อทีละตัวเว้นวรรค | รีบช่วงท้ายหาย; แต่ตัวย่อสะกดทีละตัวฟังเป็นฝรั่ง/กระตุก (ปฏิเสธ); โมเดล**อ่านข้ามคำ**ต้นประโยค 2 (ranking เลือกด้วย speaker cosine ไม่เช็คเนื้อหา) |
| 4 | ตัวย่ออ่านแบบคนไทย ติดกัน (เวฟ, เอ็มพีสาม, เอพีไอ, จีพียู); **2 seed ต่อประโยค + หูจักรกลเลือกตัวที่อ่านครบ** | มิว: "perfect" → golden |

Golden set (ส่วนตัว `/tmp/hero-voice-text-stage-2026-09-06/golden/`): 03C, 08D
หูจักรกล: `gemini-3.8-flash` ถอดแบบดิบ (ห้ามให้สคริปต์ ไม่งั้นลอก) + `gemini-3.5-transcribe`
ทั้งคู่จับคำหาย/อ่านมั่วได้ จับสำเนียงละเอียดไม่ได้ · จุดบอด: หมื่นเอ็ด→10,000
ค่าใช้จ่ายจริง: 8 คลิป 2:11 = $0.03; ประมาณคลิป 10 นาที ≈ $0.2–0.3 (+retry ไม่เกิน $1)
แขน B (โหมดไทยอ่านละติน) **ไม่จำเป็นแล้ว** เพราะทาง A + dictionary ผ่าน; profile ใน worker คงไว้ ไม่ต้อง build

### 11.2 สูตรที่ล็อก (recipe v1)

1. `prepareHeroVoiceSpeech` → **glue**: ตัดช่องว่างทุกจุด ยกเว้นช่องว่างที่ต้นฉบับมีระหว่างคำไทยล้วนสองคำ หรือหลังเครื่องหมายวรรคตอน (normalize ทีละ segment ที่คั่นด้วยช่องว่างที่เก็บไว้ เพื่อให้กฎหลายคำอย่าง `1920 x 1080`, `วันที่ 5 กันยายน 2026`, `Hero AI Studio` ยังทำงาน)
2. dictionary: คำอ่านแบบคนไทยพูด ติดกัน ไม่สะกดทีละตัวสำหรับตัวย่อที่มีคำอ่านนิยม (เวฟ, เอ็มพีสาม, เอพีไอ, จีพียู); ตัวย่อที่ไม่มีใน dictionary ยังสะกดทีละตัวแต่**ติดกัน** (ซีอีโอ)
3. chunk ระดับ**ประโยค** (ตัดที่ ครับ/ค่ะ/คะ + เว้นวรรค, เพดาน ~150 ตัวอักษร) ไม่ใช่ 800 ตัวอักษรแบบปัจจุบัน; ต่อด้วยหยุด 250 ms
4. ต่อ chunk: สร้าง ≥2 seed → ASR drop gate (หาย ≥5 ตัวอักษร = ตก) → เลือกตัวที่ผ่าน; ไม่ผ่านทั้งหมด → seed ถัดไป (สูงสุด 3) → ยังตก = แจ้ง error ไม่ส่งเสียงที่ข้ามคำให้ผู้ใช้

### 11.3 แผน port (รอมิว go)

| ชิ้น | ไฟล์ | เทสต์ |
| --- | --- | --- |
| glue rule + version `2026-09-07.1` | `src/lib/hero-voice-speech.ts` | fixtures ใน `thai-speech-cases.json` จากข้อความ 04T/06T/03A3 ที่มิวอนุมัติ (ผลต้องตรงตัวอักษร) |
| dictionary 20 คำ (reviewedBy Mew 2026-09-06) | `data/hero-voice/thai-pronunciations.json` | fixture 03A3/08D |
| ตัดประโยค | `splitHeroVoiceScriptForTts` (`hero-voice-speech.ts`) + `maxChunkChars` ใน clone config | verify-omnivoice: สคริปต์ 03/08 → 2 chunks |
| ASR gate + retry seed | `hero-voice-generation.server.ts` (clone path) + `gemini.ts` helper; flag `HERO_VOICE_ASR_GATE` เริ่มปิด | verify script ด้วย fake ASR: ท่อนที่หายคำถูก regenerate ด้วย seed+1, ท่อนดีไม่ถูกแตะ |

ผลกระทบ: (1) Story Film production ใช้ normalizer เดียวกัน → glue rule มีผลกับเสียง OmniVoice ทุกงานทันทีที่ deploy (ดี แต่ต้อง QA คลิปจริง 1 คลิปก่อน) (2) chunk สั้นลง = จำนวน job ต่อคลิปเพิ่ม ~5 เท่า เวลารวมเพิ่มเล็กน้อย (ranking ต่อ job ~5 s) ค่าใช้จ่ายแทบเท่าเดิม (3) ASR gate เพิ่ม Gemini call ต่อ chunk (เศษสตางค์) และเวลา ~6 s ต่อ chunk
ไม่ทำในรอบนี้: แขน B, weights, ต่อ ElevenLabs migration UI

### 11.4 สถานะ port (2026-09-07 01:40)

| ชิ้น | สถานะ | commit |
| --- | --- | --- |
| glue rule + dictionary 20 คำ + normalizer `2026-09-07.1` | **เสร็จ** fixtures 4 ชุดจากคลิปที่อนุมัติ + fixtures เดิม 11 ชุด re-approve ระยะห่าง | `e7a1fea5` |
| ตัดประโยค (`splitHeroVoiceScriptForTts`) | **เสร็จ** ตัดที่ ครับ/ค่ะ/คะ/[.!?]/newline, tail <10 ตัวอักษรรวมกลับ | `e7a1fea5` |
| ASR gate ตัวประเมิน (`hero-voice-asr-gate.ts`) | **เสร็จ** LCS dropped-run ≥5 = ตก, normalize transcript ก่อนเทียบ, รับหลายหูเลือกดีสุด | (commit ถัดไป) |
| ASR gate **wiring** เข้า state machine | **เสร็จ** (2026-09-07) ดู 11.6 | (commit ถัดไป) |

ผ่าน: verify:omnivoice, verify:hero-voice-clone(-task2), verify:hero-voice-canary/ui/deletion, worker unittest, tsc, eslint

### 11.5 แผน wiring ASR gate (ชิ้นสุดท้าย ต้องออกแบบก่อนแตะ)

จุดต่อ: `advanceHeroVoiceGenerationUnlocked` ใน `hero-voice-generation.server.ts` หลังรับ part WAV ของ chunk
1. flag `HERO_VOICE_ASR_GATE=1` (ปิด = พฤติกรรมเดิม)
2. ถอดเสียง part ด้วย `gemini-3.5-transcribe` (audio-only, part `audioTranscription.text`) + `gemini-3.8-flash` prompt ดิบ ผ่าน `GEMINI_SERVER_KEY`; ส่งเฉพาะเสียงที่สร้าง ไม่ส่ง reference
3. `evaluateHeroVoiceTranscripts(chunk.speechText, [t35, tVerbatim])` ตก → สร้าง snapshot ใหม่ของ chunk เดิม (attemptId ใหม่, seed+1, sequence เดิม) แล้ว submit ใหม่ สูงสุด 2 ครั้ง; บันทึก `asrGate: {attempts, droppedRun}` ใน state (ต้องเพิ่ม optional key ใน `parseState`/`hasExactKeys` + fixtures ของ verify-hero-voice-clone-task2-runtime)
4. ตกครบ 3 ครั้ง → fail job รหัส `OMNIVOICE_CONTENT_DROPPED` + refund นาที (ผ่าน `failAndRefundVoiceJob`) ไม่ส่งเสียงที่ข้ามคำให้ผู้ใช้
5. ต้นทุน: Gemini ~เศษสตางค์/chunk, เวลา +6–10 s/chunk; retry = job OmniVoice เพิ่ม 1 ต่อครั้ง
6. เทสต์: fake ASR ใน verify script: chunk ที่หายคำถูก regenerate ด้วย seed+1 และ chunk ดีไม่ถูกแตะ; state roundtrip; refund เมื่อตกครบ
ความเสี่ยง: canary manifest/ledger ตรวจ seed ต่อ slot แบบตรึง (`snapshot.synthesis.seed !== slot.arm.seed`) → gate ต้อง**ปิด**ในเส้นทาง canary admission เสมอ

### 11.6 สถานะ wiring ASR gate (2026-09-07) — ทำตาม 11.5 พร้อมข้อตัดสินใจที่พบตอนแตะโค้ด

ไฟล์: `src/lib/hero-voice-asr-ears.server.ts` (หูสองข้าง), `src/lib/hero-voice-generation.server.ts`
(ต่อ gate ใน `advanceHeroVoiceGenerationUnlocked` หลังเขียน part WAV + `replaceRejectedCloneAttempt`),
`scripts/verify-hero-voice-asr-gate-runtime.ts` (fake RunPod + fake Gemini ที่ขอบ `fetch`, 7 กรณี)
รันใน `verify:hero-voice-clone-task2` และเพิ่ม `scripts/verify-hero-voice-durable.ts` (ครึ่ง Node ของ suite นั้น) เข้า CI (`ci.yml`) ซึ่งก่อนหน้านี้ไม่ได้รัน — ทั้ง suite ใส่ไม่ได้เพราะครึ่ง Python ต้องการ `pydub` บน runner

| ข้อใน 11.5 | ที่ทำจริง |
| --- | --- |
| flag | `HERO_VOICE_ASR_GATE=1` ปิด = พฤติกรรมเดิมไบต์ต่อไบต์ (ไม่มี key `asrGate` ใน state) |
| หู | `gemini-3.5-transcribe` (เสียงอย่างเดียว, อ่าน `audioTranscription.text`) + `gemini-3.8-flash` prompt บอด ขนานกัน, timeout ข้างละ 20 s, ใช้ `GEMINI_SERVER_KEY`; ส่งเฉพาะเสียงที่สร้าง — verify ยืนยันว่า body ไม่มี reference/refText และ prompt ไม่มีสคริปต์ |
| ตก → seed+1 | snapshot ใหม่ (attemptId ใหม่, seed+1, sequence เดิม, identity fields ตรึงจาก snapshot เดิม) — **แถว attempt ถูกลบแล้วสร้างใหม่** ใน transaction เดียวภายใต้ poll lease เพราะ `@@unique([jobId, sequence])` + `validateCloneDurableIdentity` ไม่อนุญาตให้มีสอง attempt ต่อ sequence; ประวัติ generation ที่ถูกปฏิเสธเก็บใน `state.asrGate.chunks[].rejected` (attemptId, providerJobId, seed, droppedRun) |
| ≤2 retry | ครั้งที่ 3 ตก → `failAndRefundVoiceJob(..., "OMNIVOICE_CONTENT_DROPPED", "failed_output")` ไม่มี part ใดหลงเหลือ |
| state key | `asrGate: {version:1, chunks:[{sequence, attempts, droppedRun, ears, rejected[]}]}` optional เฉพาะ clone mode, `parseState` ตรวจ exact keys; tts mode มี key นี้ = corrupt |
| canary | ข้าม gate เมื่อ `job.canaryRunId !== null` (manifest ตรึง seed ต่อ slot) และข้าม tts mode ทั้งหมด (stock ไม่มี seed ให้ขยับ) |
| lease | ก่อนฟังต่อ `pollLeaseExpiresAt` +45 s ด้วย CAS บน token; ต่อไม่ได้ = ทิ้ง part แล้วคืนงานตามเดิม |

**ข้อตัดสินใจเพิ่ม (ไม่อยู่ใน 11.5):** หูล่มทั้งสองข้าง (5xx/timeout/ไม่มี key) = ปัญหาโครงสร้าง ไม่ใช่เนื้อหา →
**fail-open**: เก็บ part ไว้, บันทึก `droppedRun: null, ears: 0` + telemetry `omnivoice_asr_gate_unavailable`,
ไม่เผา retry ไม่คืนเงิน. ถ้ามิวต้องการให้ล่ม = บล็อก ให้เปลี่ยนสาขา `heard.ears === 0` เป็นเส้นทางเดียวกับตก.
