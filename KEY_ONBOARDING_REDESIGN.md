# Key Onboarding + Settings API-Keys Redesign — Design Spec

> **Audience:** Mew (CEO) + dev
> **Status:** Approved design (2026-06-18) — พร้อมทำ implementation plan
> **Why:** จาก [[INSIGHTS_REDESIGN]] / insight audit — ผู้ใช้ 200 คน มีแค่ 18 (9%) ที่เคยได้วิดีโอ และ **81/112 ลูกค้าจ่ายเงิน (72%) ไม่เคยตั้ง Gemini key** = จ่ายแล้วใช้ไม่ได้ ทั้งที่ key คือ gate เบอร์ 1. นี่คือ action ที่ "แก้ usage/รายได้จริง" (ต่างจาก insight ที่แค่ทำให้ "เห็น")

---

## 1. ปัญหา (จากของจริง)
1. **ไม่มี onboarding บนเว็บเลย** — คนใหม่ (รวมคนเพิ่งจ่ายเงิน) land `/dashboard` แบบไม่มีไกด์ แล้วไปชนกำแพงตอนกดสร้างวิดีโอ (error 400 `{missingKey}`)
2. **หน้า Settings → API Keys กองคีย์ทั้ง 5 เรียงเท่ากัน** (Gemini, HeyGen, ElevenLabs, Pexels, Pixabay) ไม่มีลำดับ/คำอธิบาย/จำเป็น-ไม่จำเป็น ซ้ำร้ายเอาขั้นสูง (HeyGen/ElevenLabs) ไว้เหนือตัวจำเป็น (Pexels/Pixabay) → มือใหม่เห็นแล้วถอย
3. การแจ้ง key หาย เป็น **reactive** — เด้ง `ApiKeyModal` ตอนเจอ error เท่านั้น ไม่นำทางล่วงหน้า

## 2. เป้าหมาย / ไม่อยู่ในขอบเขต
**เป้าหมาย:** ลด time-to-first-key, ยก activation (9% → สูงขึ้น), ทำให้ภาษา/หน้าตาเรื่องคีย์ **สอดคล้องกันทั้งระบบ** (onboarding ↔ dashboard ↔ Settings)
**ไม่อยู่ในขอบเขต:** ไม่ทำ server-side AI keys (ยังเป็น BYOK), ไม่แตะ Stripe/plan gating, ไม่ auto-provision key ให้ลูกค้า

## 3. โมเดลกลาง: "3 ชั้น + คำอธิบาย" (ใช้ร่วมทุกหน้า)
นิยามที่เดียว (โมดูล `key-tiers`), render ได้ทั้ง wizard / checklist / Settings / modal:

| key | ชั้น | คำอธิบาย 1 บรรทัด (copy กลาง) | ฟรี? | getUrl | หมายเหตุ |
|---|---|---|---|---|---|
| **gemini** | จำเป็น | สมองของระบบ — เขียน/วิเคราะห์สคริปต์, เสียงพากย์ AI, หาคีย์เวิร์ด | ✓ | aistudio.google.com/apikey | ⚠ ต้องทำ 2 ขั้น: สร้าง key **+ เปิด Generative Language API** (กัน 403) |
| **pexels / pixabay** (≥1) | จำเป็น | คลังวิดีโอ B-roll ฟรี — ไม่มี = วิดีโอไม่มีภาพประกอบ | ✓ | pexels.com/api · pixabay.com/api/docs | นับเป็น "ครบ" เมื่อมี**อย่างน้อย 1** |
| **elevenlabs** | ขั้นสูง (ไม่บังคับ) | เสียงพากย์โคลน/พรีเมียม — *ไม่ใส่ก็ได้ ระบบใช้เสียง Gemini แทน* | – | elevenlabs.io | |
| **heygen** | ขั้นสูง (ไม่บังคับ) | พิธีกร AI (avatar) ในคลิป — *ไม่ใส่ก็ได้ คลิปเป็นเสียง+ภาพปกติ* | – | heygen.com | |

**Tier-1 complete** = มี `gemini` **และ** (`pexels` หรือ `pixabay`). ใช้เป็นเงื่อนไขเดียวทุกที่ (checklist หาย, wizard ไม่เด้ง, pre-check ผ่าน).

## 4. 4 surface ที่ทำงานร่วมกัน (non-forcing)

```
สมัคร/login ครั้งแรก ──► [A] Welcome Wizard เด้ง (ข้ามได้)
                              │ ข้าม / ยังไม่ครบ
                              ▼
        /dashboard ──► [B] Checklist card (หายเมื่อ Tier-1 ครบ)
                              │
   กด "สร้างวิดีโอ" โดยไม่มี Gemini ──► [C] Pre-check เด้ง Wizard (แทน error)

        Settings → API Keys ──► [D] หน้าจัดการคีย์ (จัดกลุ่ม 3 ชั้น)
```

### [A] Welcome Wizard
- **เมื่อไหร่:** หลัง login เมื่อ **Tier-1 ไม่ครบ** และ `user.onboardingDismissedAt == null`
- **เปิดด้วยประโยคลดความกลัว:** "ตั้งแค่ 2 อย่างก็เริ่มสร้างวิดีโอได้เลย"
- **ขั้น:** (1) Gemini → (2) B-roll (Pexels/Pixabay เลือก ≥1) → (3) ขั้นสูง **พับไว้** "ไม่บังคับ"
- ทุกช่อง: input + ปุ่ม **ทดสอบ** (เรียก `POST /api/user/test-key` ที่มีอยู่) → ✓ เขียว / error ไทยบอกชัด + ลิงก์ขอ key
- **"ข้ามก่อน" มีทุกขั้นเสมอ** (ไม่ trap คนยังไม่มีคีย์) → กดข้าม = set `onboardingDismissedAt = now` (ไม่เด้ง modal ซ้ำ; เหลือ checklist เตือนแทน)
- จบ → CTA "ลองสร้างวิดีโอแรก →" ไป `/video-editor`

### [B] Dashboard checklist card
- **เมื่อไหร่:** บน `/dashboard` ตราบใดที่ **Tier-1 ไม่ครบ** (ไม่ขึ้นกับ dismiss) — หายเองเมื่อครบ
- แสดง: สถานะ "ตั้งค่าจำเป็น 1/2", รายการ Gemini / B-roll พร้อม ✓ หรือปุ่ม "ตั้งค่า", บรรทัด "ขั้นสูง (ไม่บังคับ): ElevenLabs · HeyGen [ดู]"
- ปุ่ม "ตั้งค่า" → เปิด Wizard ที่ขั้นนั้น (หรือ Settings)
- pattern เดียวกับ `ProductUpdateBanner` ใน `DashboardLayout`

### [C] Create-video pre-check
- ใน `video-editor` / `video-creator`: **ก่อน**เรียก pipeline เช็ก **Tier-1 เต็ม (Gemini + B-roll ≥1)** → ถ้าขาด เปิด Wizard ที่ขั้นแรกที่ขาด (เด้งได้แม้เคย dismiss แล้ว เพราะเป็นจังหวะที่เกี่ยวข้อง). เหตุผล: ขาด stock = fetch-stock ล้ม → ไม่ได้วิดีโอ เหมือนกัน
- ของเดิม `ApiKeyModal` (reactive จาก `{missingKey}`) **คงไว้เป็น safety net**

### [D] Settings → API Keys (redesign)
จัดกลุ่มตาม 3 ชั้น + คำอธิบาย + สถานะ "ตั้งแล้ว/ยังไม่ตั้ง" (ไม่ใช่ ACTIVE เขียวหมด):
```
สถานะ:  ✓ พร้อมสร้างวิดีโอ   |  ตั้งค่าจำเป็น 1/2      ◄ แถบเดียวกับ dashboard
━━ จำเป็น ━━
🔑 Gemini   — <คำอธิบาย>   [••••] 👁🗑 [ทดสอบ]  [ตั้งแล้ว ✓]
   ⚠ ต้องทำ 2 ขั้น: Get key ↗ + Enable API ↗
🎬 B-roll (เลือก ≥1) — <คำอธิบาย>
   Pexels  [••••] [ทดสอบ] [ตั้งแล้ว ✓] · Pixabay [ยังไม่ตั้ง] [+เพิ่ม]
▸ ขั้นสูง (ไม่บังคับ) — ไม่ใส่ก็ใช้งานได้   [กางดู]   ◄ พับ default
     🎙️ ElevenLabs · 🧑‍💼 HeyGen
```
- เรียง จำเป็นขึ้นก่อน, ขั้นสูงพับ → default เห็น 2–3 คีย์ ไม่ใช่ 5
- คงคำเตือน Gemini 2 ขั้น (403) ไว้ติดกับคีย์ Gemini
- คง Save/Discard, eye/trash, test เดิม

## 5. สถาปัตยกรรมร่วม (ทำทีเดียว ใช้ 4 ที่)
| ของใช้ร่วม | รายละเอียด |
|---|---|
| `src/lib/key-tiers.ts` (ใหม่) | นิยาม tier + copy + getUrl + ลำดับ (ตาราง §3) — source of truth เดียว |
| `<ApiKeyField>` (ใหม่, refactor จาก `api-key-settings.tsx`) | ชื่อ + คำอธิบาย + input + ปุ่มทดสอบ + สถานะ — ใช้ทั้ง Wizard และ Settings |
| `<KeyOnboardingWizard>` (ใหม่) | modal stepper ประกอบจาก `<ApiKeyField>` |
| `<KeySetupChecklist>` (ใหม่) | การ์ด dashboard + แถบสถานะ Settings (variant เดียวกัน) |
| `GET /api/user/api-keys/status` (ใหม่ หรือ extend) | คืน boolean `{ gemini, pexels, pixabay, elevenlabs, heygen, tier1Complete }` — **ไม่คืนค่า key จริง** ใช้โดย dashboard/wizard/pre-check |
| reuse: `POST /api/user/test-key`, `PUT /api/user/api-keys`, `ApiKeyModal` | validate / save / reactive fallback (ไม่แก้สัญญา) |

**Schema:** เพิ่ม `User.onboardingDismissedAt DateTime?` (additive — `prisma db push` ปลอดภัยกับ prod ตาม deploy.sh)

## 6. ไฟล์ที่แตะ (ประเมิน)
- **ใหม่:** `src/lib/key-tiers.ts`, `src/components/onboarding/{KeyOnboardingWizard,KeySetupChecklist,ApiKeyField}.tsx`, `src/app/api/user/api-keys/status/route.ts`
- **แก้:** `prisma/schema.prisma` (+1 field), `src/components/settings/api-key-settings.tsx` (จัดกลุ่ม, ใช้ `<ApiKeyField>`), `src/app/(dashboard)/dashboard/page.tsx` (วาง checklist), `src/components/layout/dashboard-layout.tsx` หรือ dashboard page (mount wizard), `src/app/(dashboard)/video-editor/page.tsx` + `video-creator/page.tsx` (pre-check)

## 7. Error handling / edge cases
- ทดสอบคีย์ fail → แสดง error จาก `test-key` (ไทย, actionable) ไม่ block การ save (เผื่อ key ถูกแต่ test โดน rate limit)
- "ข้ามก่อน" ไม่ทำให้ Tier-1 ครบ → checklist ยังอยู่, pre-check ยังเด้ง
- คนตั้งคีย์ครบอยู่แล้ว (เช่น user ในภาพ) → ไม่เห็น wizard/checklist เลย, Settings แสดง "พร้อมสร้างวิดีโอ ✓"
- status endpoint ต้อง auth + คืนเฉพาะ boolean (กันรั่ว key)
- fail-open: ถ้า status endpoint ล่ม → ไม่บล็อกการใช้งาน (ถือว่าไม่ขึ้น checklist ดีกว่าค้าง)

## 8. การทดสอบ
- `scripts/verify-key-tiers.ts` (pattern เดียวกับทีม): tier1Complete logic (gemini+stock), copy ครบทุก key, status endpoint คืน boolean ไม่มีค่า key
- tsc + build-verify
- manual (QA rig / staging): คนไม่มีคีย์ → เห็น wizard → ทดสอบ Gemini ผ่าน → checklist หายเมื่อครบ → Settings จัดกลุ่มถูก; คนมีคีย์ครบ → ไม่เห็นอะไรเพิ่ม

## 9. คำถามที่ตกลงแล้ว
- ชั้น 2 (HeyGen/ElevenLabs) ใน onboarding/Settings = **แสดงแบบพับ "ขั้นสูง (ไม่บังคับ)"** (ไม่ซ่อนสนิท, ไม่บังคับ)
- โทน = **non-forcing**: wizard เด้งครั้งแรก (ข้ามได้) + checklist ค้าง + pre-check; ไม่ hard-gate
- Settings = ปรับทีเดียวให้ใช้โมเดล/คอมโพเนนต์เดียวกับ onboarding

## 10. Out of scope / ทำต่อทีหลัง
- A/B test wording, email reminder คนที่ข้าม, in-product video guide สำหรับการขอ Gemini key, วัดผล activation ลิฟต์ผ่านหน้า insights (มี North Star อยู่แล้ว — ใช้ดูผลได้)
