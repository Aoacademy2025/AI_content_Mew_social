# Subtitle ↔ Voice Sync & Render Stability Audit — 2026-08-30

> Measured on production (`3c14d318`, VPS `srv1497873`) on 2026-08-30 19:30–23:30 ICT with read-only SQL over a DB copy,
> pm2 log pattern counts, and offline whisper (`large-v3-turbo`, Thai, word timestamps) over 56 real narration files.
> Companion plan: `docs/plans/2026-08-30-subtitle-shadow-mode-hotfix.md`. Decision record: ADR 0056.

## สรุปสำหรับมิว (Thai executive summary)

**คำถาม: หลังแก้มาทั้งอาทิตย์ ระบบดีขึ้นหรือแย่ลง? → แย่ลงชัดเจน ตั้งแต่ 08-28.**

| | create fail% | export fail% | Gemini ผ่าน | ผู้ใช้ที่เจอ fail |
|---|---|---|---|---|
| 08-20 → 08-27 (baseline 8 วัน) | 8–24% (เฉลี่ย ~17%) | 0–4% | ~80–90% | 3–7 จาก ~16 คน/วัน |
| 08-28 | **59%** | **56%** | 7/35 (20%) | 8 จาก 11 (73%) |
| 08-29 | 21% | **27%** | 26/35 | 7 จาก 14 |
| 08-30 (วันสอน class) | **31%** | 12.5% | 21/42 (50%) | 8 จาก 24 |

- สาเหตุ fail ใหม่ทั้งหมดเป็น **ด่านตรวจซับที่เพิ่มเข้ามา 08-27→08-30** (`unverified_alignment`, `text_mismatch` ตอน export,
  `legacy_caption_projection_failed`, `transcribe_incomplete`, "ไม่มี subtitle timing จาก TTS") + error generic
  "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง" 9 งานในวันเดียว + `Cannot find module @remotion/bundler` 2 งาน (deploy ดึง node_modules ระหว่าง render — #424 แก้แล้ว 19:12).
- **Remotion/ffmpeg เอง (RenderJob) แข็งแรง** ตลอดช่วง: fail 0–2 งาน/วัน. ปัญหาอยู่ชั้น "ก่อนเรนเดอร์" และ "ก่อนส่งออก".
- **ความเร็ว:** งานที่ผ่าน ไม่ช้าลง (median ~300 s เท่าเดิม) — แต่ step `captions` ที่ ASR+retry อยู่ **ไม่มี telemetry** (วัดไม่ได้),
  log วันนี้มี transcribe `attempt 2/3` 63 ครั้ง / `attempt 3/3` 16 ครั้ง, ยกเลิกเอง 10 งาน. ความช้าที่ผู้ใช้รู้สึกคือ **fail → ลองใหม่ → fail** ไม่ใช่เรนเดอร์ช้า.
- **ข้อร้องเรียน "ซับ Gemini ไม่ตรง" ของ sumawadee@aoacademy.co เป็นเรื่องจริง** (วัดจากไฟล์เสียงจริง 23 คลิป path เก่า):
  ส่วนใหญ่การ์ดคลาดแค่ ~0.1 s แต่ **9/23 คลิปมีการ์ด ≥7 ใบคลาด >0.5 s** และ **3 คลิปเพี้ยนหนัก (≥10 ใบคลาด >1 s, สูงสุด 4.2 s)**.
  รูปแบบ = ซับ*มาก่อน*เสียงสะสมภายในท่อนเมื่อ Gemini พูดช้ากว่าที่จำนวนตัวอักษรบอก (ลิสต์ตัวเลข, คำอังกฤษ, จังหวะหยุด) — เป็นข้อจำกัดเชิงโครงสร้างของ "นาฬิกาสัดส่วนตัวอักษร" ไม่ใช่บั๊กเฉพาะจุด.
- **ไม่ใช่เฉพาะบัญชีนี้** — คลิป path เก่าของผู้ใช้คนอื่น 8 คลิปให้ตัวเลขเดียวกัน (การ์ด >1 s ≈ 11–12 %, 1 ใน 4 คลิปพังหนัก). เป็นปัญหาทั้งระบบตั้งแต่ก่อน 08-27.
- **ASR forced alignment ของอาทิตย์นี้แม่นกว่าจริง** (21 คลิป/12 บัญชี): การ์ดที่ผิดชัดเจน (>1 s) ลดจาก ~11 % เหลือ **1.3 %** และไม่มีคลิปพังทั้งคลิปอีก (สูงสุด 1.5 s) —
  ที่ผิดคือ **การทำเป็นด่าน fail-closed + regen TTS + retry + ตรวจซ้ำตอน export + ไม่มีทางถอย** ซึ่งทำให้งานล้มครึ่งหนึ่ง.
- ทางออก (ตกลงแล้ว 08-30): **Shadow mode** — ด่านซับทุกตัวกลายเป็น "รายงาน"; ใช้ timing จาก forced alignment เมื่อสำเร็จภายในงบเวลา (เรียก 1 ครั้ง ไม่ retry ไม่ regen),
  ไม่สำเร็จถอยไปนาฬิกา TTS เดิม, export ไม่ตรวจซ้ำ; phase 2 เปลี่ยน*ต้นทางของเวลา*เป็น forced alignment แบบกำหนดผล (CTC ภาษาไทย บน CPU) — ดู `docs/research/2026-08-30-thai-forced-alignment-options.md`.

---

## 1. Scope & method

- Question 1 — did the 08-26→08-30 change set (47 merges, 206 files, +22,167 lines, no plan/ADR) improve or degrade production?
- Question 2 — are Gemini/Hero-voice subtitles actually out of sync, by how much, for whom, and why?
- Question 3 — where does wall-clock time go, and what blocks a render/export today?
- Method: (a) read-only SQL over a copy of `prisma/dev.db` (VideoJob, RenderJob, TelemetryEvent, SupportTicket; epoch-ms, ICT dates);
  (b) pm2 log pattern counts; (c) code map of every blocking gate at HEAD; (d) offline measurement: for each narration WAV,
  whisper word timestamps → char-level alignment with the stored caption text (Thai has no spaces) → per-card `start error =
  caption.startMs − ASR onset`. Whisper's own Thai word-timestamp jitter is ≈ ±0.2 s, so `|e| > 0.5 s` is treated as "visibly off"
  and `|e| > 1.0 s` as "clearly wrong".

## 2. Production numbers (VideoJob, ICT dates)

### 2.1 Per day
| day | total | done | failed | canceled | fail% | med done (s) | p90 (s) |
|---|---|---|---|---|---|---|---|
| 08-20 | 100 | 90 | 9 | 1 | 9.1 | 358 | 976 |
| 08-21 | 105 | 90 | 14 | 1 | 13.5 | 348 | 653 |
| 08-22 | 69 | 60 | 9 | 0 | 13.0 | 371 | 755 |
| 08-23 | 54 | 44 | 9 | 1 | 17.0 | 387 | 1007 |
| 08-24 | 88 | 73 | 6 | 9 | 7.6 | 330 | 866 |
| 08-25 | 78 | 71 | 4 | 3 | 5.3 | 280 | 448 |
| 08-26 | 35 | 30 | 5 | 0 | 14.3 | 315 | 680 |
| 08-27 | 77 | 68 | 8 | 1 | 10.5 | 259 | 487 |
| **08-28** | 59 | 24 | **34** | 1 | **58.6** | 150 | 363 |
| 08-29 | 82 | 58 | 18 | 6 | 23.7 | 333 | 580 |
| 08-30 | 114 | 78 | 26 | 10 | 25.0 | 301 | 720 |

### 2.2 By type — export was a zero-failure path until 08-28
| day | create fail% | export fail% |
|---|---|---|
| 08-20…08-27 | 12.1 / 21.2 / 19.6 / 24.3 / 12.8 / 8.5 / 22.7 / 16.0 | 3.8 / 0 / 0 / 0 / 0 / 0 / 0 / 0 |
| 08-28 | **59.2** (29/49) | **55.6** (5/9) |
| 08-29 | 20.9 | **27.3** (9/33) |
| 08-30 | 30.6 (22/72) | 12.5 (4/32) |

### 2.3 Failure reasons that did not exist before 08-28 (count 08-28→08-30)
| errorCode / message | n | introduced by |
|---|---|---|
| `unverified_alignment` (captions step) | 17 + 2 + 4 + 3 = 26 | #378 → b79df6c6 (`subtitle-quality.ts:1079`) |
| `ไม่มี subtitle timing จาก TTS` | 6 | b79df6c6 (`orchestrator.ts:2057`) |
| export `text_mismatch` ("ระบบหยุดก่อนส่งออก") | 7 | b79df6c6 export re-check (`orchestrator.ts:1342`) |
| export `unverified_alignment` | 4 | same |
| `legacy_caption_projection_failed` | 4 | b79df6c6 (`orchestrator.ts:1293`) |
| `transcribe_incomplete` (upload) | 4 | 5f558611 / 243d5165 (`transcribe/route.ts:1881`) |
| `word_timing_incomplete`, `transcribe_desynced`, `incomplete_alignment`, `overlapping_timing`, `invalid_timing`, `empty_captions` | 1–2 each | 5f558611 / b79df6c6 |
| bare `เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง` at step `render` | 9 (08-30, all one MCP user, 16:17–18:16) | **`POST /api/videos` threw `export_project_mismatch`** (27× in `ai-content-error.log`) — the strict Editor-export project check from #420/#422 (deployed 14:38/17:05) also rejected generic MCP create jobs whose RenderJob had already completed; fixed by #424 at 19:26 (0 render/save failures since). `api-error.ts:90` replaced the cause with the generic string, which is why the DB shows nothing useful |
| `Cannot find module '@remotion/bundler'` | 2 | deploy `npm ci` during a live render — fixed by #424 (drain before `npm ci`) |

Pre-existing reasons (plan-limit walls, HeyGen credit, content-preflight, quota) continue at their previous rate and are out of scope.

### 2.4 Gemini voice specifically (create jobs)
| day | Gemini jobs | done | failed |
|---|---|---|---|
| 08-20 | 42 | 34 | 7 |
| 08-25 | 21 | 19 | 1 |
| 08-27 | 24 | 16 | 7 |
| **08-28** | 35 | **7** | **27** |
| 08-29 | 35 | 26 | 8 |
| 08-30 | 42 | 21 | 18 |

### 2.5 RenderJob (Remotion/ffmpeg workers) — healthy throughout
RENDER: 0 failures/day except 08-30 (2: one bundler module missing during deploy, one cancel). BURN: 0–2/day (`renderMedia() got cancelled` = user cancel). Median RENDER 195–300 s, p90 ≤ 470 s, unchanged across the period. No RenderJob stuck at audit time; no VideoJob in flight >20 min at audit time (the 19:26 deploy restarted every worker).

### 2.6 Speed
TelemetryEvent `pipeline_step_done` medians, 08-20→26 vs 08-27→30: `tts` 58→49 s, `fetchStock` 42→38 s, `render` 245→216 s, `burnSubtitles` 235→198 s. **No `captions` row exists in either period** — `STEP_TELEMETRY_NAME` deliberately skips it (`orchestrator.ts:563`), so the ASR + alignment + retry time is invisible. pm2 `ai-content-error.log` (last 664 lines, all today): `attempt 2/3` ×63, `attempt 3/3` ×16, `ECONNRESET` ×5; `mcp-video-worker-error.log`: `text_mismatch` ×4, `regenerat` ×5 (Gemini TTS regenerated because of an alignment verdict — pure extra spend).

### 2.7 Support tickets
1–3 closed/day through the period; 08-30: 2 closed HIGH + **3 open**. The complaining account (BUSINESS, 92 jobs since 08-01) has **no ticket about subtitle sync** — the feedback came verbally in class; its tickets are about render errors, voice mismatch (07-27), avatar sizing (08-03) and a Gemini no-audio failure (08-19).

## 3. What changed, structurally

STATUS.md (06-12) locked the architecture: *subtitle time comes from the TTS step, exact by arithmetic, skip transcribe; every layer fail-open; never bring transcribe back as the primary path.* The 08-27 PR #378 ("block subtitle and presenter desync") inverted it:

| date | PR | effect |
|---|---|---|
| 08-27 | #378 | `tts_segment_timing` / `avatar_script_clock` → `unverified_alignment` = **fail-closed**; transcribe route gains 422s for incomplete word timing |
| 08-27 | #379 P0 | first false-positive wave: word-count ratio → timeline-coverage 0.85 |
| 08-28 | #386, #390 | fuzzy alignment (similarity ≥ 0.92), **every Gemini render now runs `/api/videos/transcribe` on its own TTS output** (3 models × 3 attempts, 600 s per call, sequential chunks >110 s), export re-runs the gate and re-aligns "legacy" previews |
| 08-28 | #394 | alignment verdict triggers **one Gemini TTS regeneration** + second ASR pass |
| 08-29 | #405, #406 | new gate `speech_coverage_incomplete` (no recovery path); "technical" alignment retry (2 attempts) |
| 08-30 | #417/#418, #421 | export blocked on punctuation edits → allowed; "unblock class renders": degrade to TTS clock only after the retry budget |

Net: Gemini captions travel `TTS clock → ASR → fuzzy char-DP → canonical rebuild → gate (13 codes) → maybe regen → maybe retry → maybe fallback`, with **no runtime switch** to disable any of it (no `process.env` in `subtitle-quality.ts`, `subtitle-speech-coverage.ts`, `transcribe-timeline.ts`, `caption-card-editing.ts`). Three different minimum-card constants (240 / 300 / 400 ms) and four "coverage" definitions coexist. `MAX_FUZZY_ALIGNMENT_CELLS = 12,000,000` compares Thai char-by-char, so a ~3,500-char script is reported as `text_mismatch` (a content failure) when it is really a size limit — and that verdict is what triggers the TTS regeneration.

## 4. How Gemini subtitle timing is actually produced (unchanged this week)

- Gemini returns **no timestamps**; the only measured quantity is each chunk's PCM duration (`tts-timing.ts:1065`). Chunk = 800 chars if the script ≤ 1,600 chars, else 350 (`tts-timing.ts:87-93`) → a typical 40–90 s clip is **one or two exact numbers**.
- Inside a chunk, card times are char-proportional (`segmentCharWeights`, `tts-timing.ts:307-323`; whitespace 0, every other char 1, +5 for an ellipsis run) then re-fitted by a silence-anchored DP (`fillSegmentSilenceAnchored`, `:392-542`, accepts only if deviation ≤ 35 % of speech; silencedetect −30 dB / ≥250 ms cannot see shorter pauses). Numbers and English loanwords are not compensated.
- Chunks are concatenated with no gap and offset by exact measured durations → **no cumulative drift across chunks**; the error is *within-chunk pace mismatch*.
- `preview.words` persisted in job output is interpolated, not measured (`buildWordsFromTiming`, `tts-timing.ts:661`), despite the "timing เป๊ะ" comment at `orchestrator.ts:2389`.

## 5. Measured subtitle accuracy (whisper word timestamps vs stored captions)

### 5.1 Complaining account — 23 clips on the old path (`tts_segment_timing`, 08-17 → 08-27) + 1 on the new path
| clip | n cards | text sim | median \|e\| | p90 \|e\| | max \|e\| | cards >0.5 s | cards >1.0 s | last-⅓ mean e |
|---|---|---|---|---|---|---|---|---|
| cmswrqnqa | 44 | 0.97 | 0.13 | 0.32 | 1.08 | 4 | 1 | +0.19 |
| cmswrrmi5 | 37 | 0.92 | 0.14 | 0.47 | 1.60 | 3 | 2 | +0.07 |
| cmswxtm2k | 25 | 0.97 | 0.10 | 0.34 | 1.44 | 1 | 1 | −0.14 |
| **cmswy537a** | 29 | 0.88 | **0.75** | **2.25** | **3.05** | **13** | **10** | **−1.91** |
| cmswypub6 | 31 | 0.93 | 0.11 | 0.38 | 1.03 | 3 | 1 | −0.08 |
| cmswz6jl4 | 31 | 0.94 | 0.12 | 0.37 | 0.90 | 3 | 0 | +0.10 |
| cmsx0suzc | 71 | 0.97 | 0.11 | 0.34 | 1.31 | 3 | 1 | +0.02 |
| cmsx3d4eq | 51 | 0.98 | 0.11 | 0.26 | 1.02 | 3 | 1 | +0.17 |
| cmsx4e588 | 66 | 0.94 | 0.09 | 0.31 | 1.07 | 4 | 1 | +0.08 |
| cmsx4fjm9 | 52 | 0.93 | 0.11 | 0.34 | 0.59 | 2 | 0 | +0.07 |
| cmt2glc5g | 44 | 0.93 | 0.15 | 0.77 | 1.71 | 7 | 4 | −0.21 |
| cmt2gre54 | 47 | 0.92 | 0.11 | 0.77 | 2.18 | 9 | 4 | −0.01 |
| cmt2qoekl | 19 | 0.93 | 0.22 | 2.49 | 2.92 | 7 | 5 | −1.27 |
| **cmt6r85xq** | 25 | 0.95 | **2.02** | **3.05** | **4.19** | **23** | **22** | **−2.39** |
| cmt6wk3ae | 24 | 0.91 | 0.29 | 0.68 | 2.42 | 5 | 2 | +0.16 |
| cmt6zl9cw | 33 | 0.98 | 0.13 | 0.75 | 1.55 | 7 | 2 | +0.09 |
| cmt72i0qy | 28 | 0.95 | 0.15 | 0.38 | 0.80 | 2 | 0 | +0.17 |
| cmt8whiz8 | 35 | 0.79 | 0.11 | 0.35 | 0.63 | 1 | 0 | +0.14 |
| **cmt8x51ay** | 32 | 0.97 | 0.22 | **1.84** | 2.32 | **13** | **11** | +0.08 |
| cmt9qpv7i | 26 | 0.96 | 0.11 | 0.57 | 1.37 | 4 | 2 | −0.14 |
| cmtbcjwlj | 26 | 0.94 | 0.27 | 1.82 | 2.14 | 11 | 9 | +0.08 |
| cmtboual3 | 39 | 0.98 | 0.32 | 1.54 | 2.03 | 12 | 8 | +0.03 |
| cmtboyfdc | 22 | 0.92 | 0.19 | 0.75 | 1.13 | 5 | 1 | −0.53 |
| cmtdx1bmj (**forced_alignment**, 08-29) | 18 | 0.99 | 0.20 | 0.36 | 0.62 | 2 | 0 | −0.31 |

Reading: the median card is fine (~0.1 s), but **every clip has at least one card ≥0.6 s off; 9/23 have ≥7 cards >0.5 s off; 3/23 are badly wrong for most of the clip**. The worst clip (`cmt6r85xq`, 523-char single chunk, a numbered "1… 2… 3… 4…" list with English terms) runs **~2 s early from card 4 to the end** — exactly the char-proportional failure mode in §4. Sign is mostly negative in the bad clips (captions ahead of speech).

### 5.2 Other accounts — new path (`forced_alignment`, 08-29→08-30), 21 clips / 12 accounts
| clip | n | sim | med \|e\| | p90 | max | >0.5 s | >1.0 s |
|---|---|---|---|---|---|---|---|
| cmteevysp | 52 | 0.94 | 0.11 | 0.34 | 0.50 | 0 | 0 |
| cmtefgobd | 52 | 0.95 | 0.13 | 0.48 | 0.84 | 6 | 0 |
| cmtegmvi0 | 52 | 0.97 | 0.16 | 0.50 | 1.26 | 6 | 1 |
| cmtehavtc | 46 | 0.93 | 0.23 | 0.60 | 0.86 | 9 | 0 |
| cmtei9w1a | 50 | 0.91 | 0.13 | 0.36 | 0.66 | 2 | 0 |
| cmtejqsed | 39 | 0.92 | 0.16 | 0.76 | 1.28 | 6 | 1 |
| cmtepkcnc | 23 | 0.94 | 0.12 | 0.40 | 0.60 | 2 | 0 |
| cmtf2xem8 | 34 | 0.93 | 0.18 | 0.36 | 0.53 | 1 | 0 |
| cmtf66xl5 | 34 | 0.93 | 0.22 | 0.44 | 1.43 | 4 | 2 |
| cmtf7pumw | 76 | 0.95 | 0.20 | 0.44 | 0.54 | 3 | 0 |
| cmtfacqj7 | 16 | 0.92 | 0.13 | 0.24 | 0.60 | 1 | 0 |
| cmtfbwylm | 34 | 0.92 | 0.29 | 0.52 | 1.50 | 6 | 2 |
| cmtfbzhly | 31 | 0.77 | 0.11 | 0.29 | 1.04 | 2 | 1 |
| cmtfcj0mj | 48 | 0.95 | 0.25 | 0.47 | 1.17 | 3 | 1 |
| cmtfe2bsj | 78 | 0.98 | 0.29 | 0.81 | 1.46 | 18 | 4 |
| cmtfgzgza | 38 | 0.93 | 0.14 | 0.38 | 0.94 | 3 | 0 |
| cmtfhbfr6 | 77 | 0.96 | 0.24 | 0.54 | 0.74 | 15 | 0 |
| cmtfhbh3w | 47 | 0.92 | 0.10 | 0.38 | 0.62 | 2 | 0 |
| cmtfknc7i | 65 | 0.90 | 0.17 | 0.48 | 0.58 | 5 | 0 |
| cmtfr71w0 | 72 | 0.92 | 0.25 | 0.57 | 0.85 | 13 | 0 |
| cmtftrp1y | 15 | 0.88 | 0.21 | 0.34 | 0.92 | 1 | 0 |

### 5.3 Other accounts — old path (`tts_segment_timing`, 08-22→08-26), 8 clips / 8 accounts
| clip | n | sim | med \|e\| | p90 | max | >0.5 s | >1.0 s |
|---|---|---|---|---|---|---|---|
| cmt6m1udo | 60 | 0.92 | 0.10 | 0.74 | 1.88 | 10 | 1 |
| cmt6s7vg9 | 4 | 0.95 | 0.34 | 0.35 | 0.40 | 0 | 0 |
| cmt7l80yo | 35 | 0.89 | 0.12 | 0.41 | 0.61 | 2 | 0 |
| cmt850qyp | 14 | 0.99 | 0.23 | 1.33 | 2.12 | 5 | 4 |
| **cmt88zvqs** | 95 | 0.90 | 0.24 | **1.61** | **3.31** | **31** | **20** |
| cmt8ikkyy | 54 | 0.97 | 0.11 | 0.38 | 2.28 | 4 | 2 |
| cmt9zsbu6 (4.6 min) | 135 | 0.86 | 0.12 | 0.93 | 2.94 | 20 | 10 |
| **cmta92m5g** | 21 | 0.56 | **2.00** | **3.70** | 3.75 | 8 | 7 |

### 5.4 Group comparison
| group | clips | cards | median \|e\| | p90 \|e\| | cards >0.5 s | **cards >1.0 s** | clips with ≥7 cards >0.5 s | clips with ≥10 cards >1 s | worst |
|---|---|---|---|---|---|---|---|---|---|
| complaining account, old path | 23 | 817 | 0.13 | 0.57 | 17.7 % | **10.8 %** | 9 | 3 | 4.19 s |
| other accounts, old path | 8 | 378 | 0.17 | 0.83 | 21.2 % | **11.6 %** | 4 | 2 | 3.75 s |
| other accounts, **new path** | 21 | 959 | 0.17 | 0.44 | 11.3 % | **1.3 %** | 4 | **0** | 1.50 s |

**Findings.** (1) The old path's inaccuracy is systemic, not one account: ≈ 1 card in 9 is >1 s off, and 1 clip in 4 is badly broken. (2) The forced-alignment path is materially better where it matters — "clearly wrong" cards fall from ~11 % to 1.3 % and no clip is broken end-to-end (worst 1.5 s vs 4.2 s). Its residual is a small early bias (signed median −0.1 to −0.2 s) and occasional 0.5–0.8 s cards in long clips. (3) So the week's ASR alignment is worth keeping **as a timing source** — what must go is everything around it: the fail-closed gate, TTS regeneration, retry loops, export re-checks, and the absence of a fallback.

## 6. Every gate that can block a render or export today (HEAD `3c14d318`)

**Before a job exists** (`api/videos/jobs/route.ts`): idempotency (204/165), in-flight cap 3 (`too_many_jobs`, 275/382/699), `stale_export_source` 409 (351, new 5e4d203f), first-clip script policy (499, 3ac10888), full-avatar >300 s (489, 733ebe7a), Render Receipt (517/526), voice plan preflight 403 (608-619, #355), missing/invalid keys (622-645, 893-903), HeyGen readiness (673), clip quota (683-694), Hero-image allowance (738-795), Content Preflight pin (820-855), **deploy drain 503 `render_maintenance`** (1005), funding (1011). Client-side: `handleRender` returns silently while `canRunProjectOperation()` is false (`EditorV2Shell.tsx:250`) — the "Render button does nothing" report.

**During a job** (`orchestrator.ts`): full-avatar estimate (694), duration/plan walls (1800-1834), `ไม่มี subtitle timing จาก TTS` (2057), **`subtitleQualityShouldFailJob` (2093)** with 13 failing codes of which only `spacing_mismatch` / `punctuation_only_card` / `card_too_short` are non-blocking, avatar-checkpoint re-validation (823), upload zero captions (1502) and upload QA (1521).

**At export**: source checks (1192-1202), `missing_legacy_replay_evidence` (1262), re-alignment failure (1281), `legacy_caption_projection_failed` (1293), `legacy_overlay_projection_failed` (1304), **export QA** (1342-1354); client preflight `blank_caption` / `spoken_content_changed` (`caption-card-editing.ts:32-58`).

**Transcribe route 422s** (`transcribe/route.ts` 1176-1307, 1789, 1866-1888): fine-recovery exhausted, recovery exhausted, chunk 3-attempt, single-call, `word_timing_incomplete`, `transcribe_desynced`, `transcribe_incomplete`.

## 7. Stuck-job and opacity findings (render lifecycle)

1. **No server-side watchdog for `VideoJob`.** A `processing` row with a dead worker stays `processing` until the next worker boot (`recoverProcessingJobsAfterWorkerRestart`); `reconcile-processing` only touches Gallery `Video` rows (`video-reconcile.ts:119`). `waiting_provider` with `providerNextPollAt = NULL` is unclaimable forever and blocks both the 3-job cap and the 3600 s deploy drain.
2. `pollRender` gives up at 60 min with `"render timed out"` while the RenderJob keeps running (orphan).
3. Client polling backs off to 30 s after 3 failures and never says "no progress for N minutes".
4. Errors: route failures reach the worker as the friendly string from `api-error.ts:90` (cause dropped); render-worker terminal errors are truncated to 1,000 chars in `RenderJob.error` with no telemetry.
5. Export 409 `stale_export_source` after an in-place B-roll re-render when the client still holds the previous preview (`editor-projects.ts:387`; 5e4d203f patched only the client half).
6. Render-worker bundle directories under `/tmp` are protected only per-process (`__activeRemotionBundleRefs`); `sweepDeadRenderJobs` runs only on the idle branch. Logged, not fixed in the hotfix.
7. RenderJob side is otherwise well guarded: stall 120 s, wall-clock 45 min, 10 s watchdog, requeue on SIGTERM, deploy drain before `npm ci` (#424).

## 8. Verdict

- **Stability:** worse since 08-28, entirely attributable to new fail-closed subtitle gates plus one deploy race (fixed). The renderer itself did not regress.
- **Sync:** the complaint is real, systemic and pre-dates this week; the old path's error is within-chunk pace mismatch (numbers, English, pauses), typically 1–3 s early in the affected stretch (≈11 % of cards >1 s off). The new forced-alignment path cuts that to 1.3 % (§5.4) — a real gain that was bought at a 3–5× failure rate and with no off switch. Keep the timing source, remove the gate.
- **Speed:** unchanged for jobs that complete; the user-visible slowness is failure-and-retry plus an unmeasured `captions` step. Fix = shadow mode + telemetry.

## 9. Do-not-repeat list
1. Never add a fail-closed subtitle gate on the TTS-voice path (ADR 0056). QA is a report.
2. Never let an alignment verdict trigger provider spend (TTS regeneration).
3. Any "verification" that adds wall-clock must run off the critical path and be measured (telemetry) before it can ever become a gate.
4. Thai text compare ≠ char-level Levenshtein with a cell cap; a size limit must not be reported as a content mismatch.
5. Hotfix series without a plan/ADR: 47 merges in 4 days produced the regression; the freeze stays until the shadow-mode PR is on prod.

## 10. Hotfix delivered — 2026-08-31 (branch `subtitle-render-stability-audit`, plan `docs/plans/2026-08-30-subtitle-shadow-mode-hotfix.md`)

### 10.1 What shipped (one commit per task + review-round commits, base `3c14d318`)

| Task | Commit(s) | Change |
|---|---|---|
| 1 QA `warning` status + blocking policy + `repairCaptionTiming` | `b072277f`, `bdbdf47b`, `995a70c0` | `validateSubtitleQuality` → `passed \| warning \| failed`; only `empty_script`/`empty_captions` fail; `repairCaptionTiming` (blank-drop, clamp, ≥240 ms, backward pass pulls a short tail inside the audio, never drops text); release audit: coverage/unverified → p1 |
| 2 Orchestrator ladder + export | `541829f8`, `623e87cc` | `alignNarrationOnce` (1 transcribe, `SUBTITLE_VERIFY_BUDGET_MS` read at call time, never throws) → `forced_alignment` else `tts_segment_timing` else `avatar_script_clock`; zero TTS regen; export never re-aligns, drops blank cards, strips empty popups; `subtitleEvidence.verification` persisted on every finishJob + avatar checkpoint (`avatar_script_clock` allow-listed in the checkpoint parser) |
| 3 Client export preflight | `c5ed9f0f` | text edits allowed; only `blank_caption` hint remains; `verify:caption-card-editing` in CI |
| 4 Transcribe partial coverage | `0aa2fb37`, `a82a3ee6` | 200 + `warnings[]` whenever ≥1 caption; single 422 = zero captions; pure `src/lib/transcribe-partial-coverage.ts` (route + fixtures share it); route warnings `transcribe_desynced`/`chunk_recovery_exhausted` fail the create-path alignment (TTS clock renders); editor avatar fallback parity |
| 5 Error specificity + `captions` telemetry | `397ef8ab`, `4842a331`, `a5ea0fe3` (final review fix wave — also typed evidence, refund-gate test, avatar-resume code) | `PipelineApiError` (code from envelope), `failJob({message, code})`, step-prefix form only for non-customer causes (content-based: Thai ∧ ¬diagnostic), `captions` in `STEP_TELEMETRY_NAME`; `detail` NOT on public envelopes (security review); `scrubSecrets` widened |
| 6 VideoJob watchdog | `4ea69e67`, `8a84ef20` | `sweepStalledVideoJobs` (45 min; composite/avatar/composite_queue 90 min > 65-min HTTP client), reuses `failJob` (refund + project transition), repairs NULL-poll waits only when a checkpoint exists; `claimNextRunnableJob` same predicate; worker sweep 60 s throttle; `verify:video-job-watchdog` in CI |
| 7 Export source + Render toast | `06a364b1` | any done `create` job of the same project created ≥ active job is a valid export source; disabled Render explains itself |

Deleted: `src/lib/mcp/subtitle-alignment-retry.ts`. New env knobs (safe defaults, ops-only): `SUBTITLE_VERIFY_BUDGET_MS=180000`, `VIDEO_JOB_STALE_MS=2700000`. No Prisma schema change.

### 10.2 Evidence (clean tree, 2026-08-31)
All green: `verify:subtitle-audio-sync` (incl. `verify:mcp-perfect`, `verify:provider-subtitle-alignment` cases A–M, `verify:export-gallery-metadata` 60/60, preview-mode 108/108, release-audit), `verify:transcribe-alignment` (89), `verify:video-job-watchdog` (52), `verify:render-queue`, `verify:editor-job-runtime`, `verify:caption-card-editing`, `verify:post-export-edit-state`, `verify:quota-error-shape`, `verify:customer-error-copy`, `verify:admin-error-notify`, `verify:avatar-caption-fallback`, `verify:subtitle-invariant`, `tsc --noEmit`, `npm run build` (231 routes). Harness replays of every 08-28→08-30 failure shape (`unverified_alignment`, `text_mismatch` on export, `legacy_caption_projection_failed`, `transcribe_incomplete`, missing TTS timing, `numeric_claim_mismatch`) complete instead of failing; call-log assertions: ≤1 `/api/videos/transcribe` per create job, 0 on export, exactly 1 `/api/videos/tts-gemini` per job.

Reviews: 7 task reviews (opus/sonnet), 6 fix rounds total, 1 security review (1 Medium found → fixed: `detail` removed from public error envelopes), 1 whole-branch review ("ready with fixes" → 1 fix wave). Findings fixed on the way that the plan did not foresee: `avatar_script_clock` rejected by the avatar checkpoint parser (avatar job would have failed *after* HeyGen spend); cascading tail overshoot in `repairCaptionTiming`; composite/avatar steps legitimately silent >45 min (watchdog per-step deadline); checkpoint-less `waiting_provider` replay = double provider spend; route 200-on-desync would have promoted a drifted ASR clock to `forced_alignment`.

### 10.3 Rulings made on Mew's behalf during execution (undo any you disagree with)
R1 parallel workers share the worktree with path-scoped commits · R2 schedule by shared files · R3 commit trailer = this session · R4 watchdog test uses inline temp-DB pattern · R5 Render-toast asserted via the source-text harness · R6 `SUBTITLE_VERIFY_BUDGET_MS` read at call time · R7 per-commit review packages · R9 watchdog passes `reservationRefundReason` · R10 tail card keeps 240 ms floor (then R14 backward pass) · R11 `audioDurationMs ≤ 0` ⇒ no clamp, documented · R12 release-audit `speech_coverage_incomplete` + 2nd `invalid_speech_coverage` → p1 · R15 composite-bound steps (`composite`, `composite_queue`, `avatar`) 90-min deadline · R16 NULL-poll claim/repair require a checkpoint · R17 shared `withVideoJobSqliteRetry` · R19 ElevenLabs without usable timing → `avatar_script_clock`, no transcribe · R20 `overlayRetimed` evidence · R21 strip empty popups on every export · R22/R23 evidence fixtures + export `verification: skipped` · R24 create-path empty-captions goes through the policy · R26 route warnings `transcribe_desynced`/`chunk_recovery_exhausted` fail alignment, `transcribe_incomplete` may proceed (an untranscribed tail can never end the track early — aligner fail-closed at 3 layers) · R27 editor avatar fallback on desync warning · R28 pure partial-coverage helpers · R30 `detail` off the public envelope + wider scrub · R31→R34 customer copy decided by content (Thai ∧ ¬diagnostic ∧ ≠ generic literal), not origin · R32 refund gate `includes` · R33 hardening (scrub header context, typed evidence) · R35 CLAUDE.md updated in docs commit.

### 10.4 Decisions reserved for Mew (defaults chosen; say no before merge)
1. Partial upload transcription now **settles** the managed AI-audio reservation (no refund) because captions were delivered.
2. Checkpoint-less `avatar` orphans are failed + refunded at **90 min** (was to be 45) — the 65-min HTTP timeout fails a live job first, so 90 only fires on a dead row.
3. First worker restart: `recoverProcessingJobsAfterWorkerRestart` handles historical `processing` rows; the sweep then repairs `waiting_provider` rows with NULL poll + checkpoint — count them on prod first (`SELECT COUNT(*) FROM VideoJob WHERE status='waiting_provider' AND providerNextPollAt IS NULL`).
4. Admin insights failure-mix will shift (codes now inside messages; `captions` step now reports errors) — re-baseline before quoting.

### 10.5 Deploy + measurement notes
`bash deploy/deploy.sh` (CI gate), then `pm2 restart mcp-video-worker --update-env` (new env knobs optional). 48 h acceptance via `/private/tmp/heroai-prod-measure.sh`: create fail ≤15 %, export fail ≤3 %, zero `unverified_alignment` / `legacy_caption_projection_failed` / `transcribe_incomplete` failures; treat `subtitle_alignment_empty_*` as the legitimate "nothing to show" refusal, not a regression; `captions` rows must appear in section E.

### 10.6 Follow-up tickets (not in this PR)
- Surface `uploadWarnings` / `routeWarnings` / `verification` in the Post phase; guard the legacy `/video-creator` `runTranscribe` on a `transcribe_desynced` 200 (twin of the editor fix).
- Test hardening: one real `POST /api/videos/transcribe` fixture with a stubbed Gemini client; source tripwire binding `COMPOSITE_BOUND_STEPS` to orchestrator `step("…")` literals; delete dead `scripts/verify-mcp-orchestrator.ts`; fix pre-broken runners `verify:editor-projects`, `verify-render-poll-timeout`.
- `failure-view.ts`: a `subtitle-empty` kind for `subtitle_alignment_empty_*`; rename `overlayRetimed` → `overlayConsistent`; `render_poll_unstable` code; drop duplicated `preview.words` from preview evidence (size).
- Phase 2 accuracy: deterministic Thai forced alignment as the timing *source* (`docs/research/2026-08-30-thai-forced-alignment-options.md`) — evaluated against the persisted `verification` evidence, never as a gate.
