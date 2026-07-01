# Design Spec — Redesign หน้า "วิธีใช้งาน" (docs)

- **Date:** 2026-07-01
- **Author:** Mew (+ Claude)
- **Branch/worktree:** `worktree-mew+docs-redesign` @ `.claude/worktrees/mew+docs-redesign` (fork จาก `d8a167b`)
- **Status:** Design approved — pending spec review → implementation plan

---

## 1. Problem / Goals

หน้า `/docs` ปัจจุบัน (`src/app/(dashboard)/docs/page.tsx`, ไฟล์เดียว ~853 บรรทัด) มีปัญหา:

1. **เนื้อหาล้าสมัย** — ยัง framing แบบ BYOK Gemini (ซ่อนด้วย flag `managed`) และ **ไม่มี**เรื่อง minutes/credits ซึ่งเป็นโมเดลใหม่ที่ live บน prod แล้ว
2. **ใช้งานยาก** — เป็น 3 แท็บ ธีม neon/sci-fi จัดเต็ม (ลูกแก้วเรืองแสง สแกนไลน์ อนิเมชันเยอะ) ไม่มี sidebar สารบัญ ไม่มีค้นหา ไม่มี deep-link ราย section
3. **แก้ยาก** — เนื้อหา hardcode ใน JSX ไฟล์เดียว ทำให้ไม่มีใครอยากอัปเดต → เป็นต้นเหตุที่มันล้าสมัย
4. **ปุ่ม "Docs" ไม่สื่อ** — เป็นภาษาอังกฤษ ป้ายไม่บอกว่าเป็นคู่มือ/วิธีใช้

**เป้าหมาย:** overhaul เต็ม — หน้าตาใหม่ที่อ่านง่าย + โครงสร้างสารบัญ+ค้นหา + เนื้อหาตรงกับผลิตภัณฑ์จริงปัจจุบัน + โครงเก็บเนื้อหาที่อัปเดตครั้งหน้าได้ง่าย + ป้ายปุ่มที่สื่อความ

**Non-goals:** ไม่ทำ i18n (ยังไม่มีระบบ, เนื้อหาเป็นไทยเป็นหลัก) · ไม่เปลี่ยน docs เป็น public/pre-login (คงล็อกอินถึงเข้าได้เหมือนเดิม) · ไม่ทำ admin-editable docs (DB) · ไม่แตะ pipeline/render/pricing logic — งานนี้เป็น presentation + copy ล้วน

---

## 2. Locked decisions

| หัวข้อ | สรุป |
|---|---|
| ขอบเขต | Overhaul เต็ม — redesign + เขียนเนื้อหาใหม่ทั้งหมด |
| โครงสร้าง | Sidebar สารบัญ + ช่องค้นหา (สไตล์ docs จริง) |
| เก็บเนื้อหา | แยกไฟล์ TSX ต่อหัวข้อ + registry |
| ป้ายปุ่ม | "วิธีใช้งาน" (top-nav + การ์ด dashboard + เพิ่มใน sidebar) |
| Layout | โซน docs เต็มจอแยกจากแอป (route group `(docs)` ของตัวเอง) — ไม่มีเมนูแอปมากวน |
| โทน | สะอาด อ่านง่าย · accent ม่วง `#8b5cf6` · Bai Jamjuree headings · อนิเมชันเบา |

---

## 3. Architecture — route + layout

### 3.1 Route group แยก
- สร้าง route group ใหม่ **`src/app/(docs)/`** พร้อม `layout.tsx` ของตัวเอง — **ไม่** ใช้ dashboard shell (ไม่มี sidebar/topnav ของแอป) → แก้ปัญหา "sidebar ซ้อนกัน 2 อัน"
- ย้ายหน้า docs ไปไว้ใต้ group นี้: `src/app/(docs)/docs/...` — **URL ยังเป็น `/docs` เหมือนเดิม** (route group ไม่มีผลกับ path)
- ลบไฟล์เดิม `src/app/(dashboard)/docs/page.tsx` (ย้ายเนื้อหาเข้า `_content/*`)
- **Auth:** URL ไม่เปลี่ยน → middleware ยังคุ้มครอง `/docs` เหมือนเดิม (ยังต้องล็อกอิน). ยืนยันใน `src/middleware.ts` ว่า `/docs` ยัง match protected และไม่โดน static-media redirect issue (docs เป็นเพจ ไม่ใช่ media)

### 3.2 Chrome ของโซน docs (`(docs)/layout.tsx`)
```
┌──────────────────────────────────────────────┐
│ [โลโก้→/dashboard]  [🔍 ค้นหา docs...]  [← กลับแอป] │  ← docs top bar
├───────────────┬──────────────────────────────┤
│ docs-sidebar  │  เนื้อหา (max-w ~72ch อ่านสบาย) │
│ (สารบัญ ราย    │                              │
│  หมวด/หัวข้อ)   │  [Section / Step / Tip ...]   │
└───────────────┴──────────────────────────────┘
```
- **Top bar:** โลโก้ (ลิงก์กลับ `/dashboard`) · ช่องค้นหา · ปุ่ม "← กลับแอป" (ไป `/dashboard`)
- **Left:** `docs-sidebar` — สารบัญจัดกลุ่มตามหมวด, highlight หัวข้อปัจจุบัน
- **Center:** เนื้อหา
- **Mobile:** sidebar ยุบเป็น drawer (ปุ่มแฮมเบอร์เกอร์บน top bar), เนื้อหาเต็มจอ, ค้นหาเข้าถึงได้
- Layout เป็น client component: fetch `managed`/plan **ครั้งเดียว** จาก `/api/user/api-keys/status` (+ `/api/user/me` สำหรับ minute/plan ถ้าจำเป็น) แล้วจ่ายผ่าน React context ให้เนื้อหาอ่าน (เหมือนหน้าปัจจุบันที่ fetch status อยู่แล้ว)

---

## 4. Content model — TSX modules + registry

### 4.1 โครงไฟล์
```
src/app/(docs)/
  layout.tsx                     # docs chrome (topbar + sidebar + context provider)
  docs/
    page.tsx                     # หน้าโฮม docs (hero + ค้นหา + การ์ดหมวด)
    [slug]/page.tsx              # เรนเดอร์หัวข้อตาม slug จาก registry
    _content/
      registry.ts                # รวมทุก entry → ordered, grouped by category
      getting-started.tsx
      setup-api-keys.tsx
      create-video.tsx
      subtitles.tsx
      avatar.tsx
      minutes-credits.tsx
      troubleshooting.tsx
    _components/
      docs-topbar.tsx
      docs-sidebar.tsx
      docs-search.tsx
      docs-context.tsx           # provider + useDocsContext() (managed, plan, minutes)
      ui.tsx                     # Section, Step, PipelineRow, ApiRow, Warn, Info, Tip, Code, Callout
```

### 4.2 DocMeta interface (ต่อไฟล์เนื้อหา)
```ts
export interface DocMeta {
  slug: string;            // e.g. "create-video"  → /docs/create-video
  title: string;           // "สร้างวิดีโอแรกของคุณ"
  category: string;        // "สร้างวิดีโอ" (จัดกลุ่มใน sidebar)
  order: number;           // ลำดับใน sidebar
  keywords: string[];      // สำหรับค้นหา
  summary: string;         // snippet ในผลค้นหา / หน้าโฮม
}
export const meta: DocMeta = { ... };
export default function Doc() { return (<>...</>); }
```

### 4.3 registry
- import ทุก entry, จัดเรียงตาม `category` แล้ว `order`, export:
  - `docsByCategory` → ขับ sidebar + การ์ดหน้าโฮม
  - `getDoc(slug)` → `[slug]/page.tsx` ใช้ lookup component + meta (unknown slug → `notFound()`)
  - `searchIndex` → array ของ `{ slug, title, category, summary, keywords }`
- เพิ่มหัวข้อใหม่ = สร้างไฟล์ 1 ไฟล์ + เพิ่ม import ใน registry (ไม่ต้องแก้ layout/sidebar)

---

## 5. Routing & search

- `/docs` → **หน้าโฮม**: hero สั้น + ช่องค้นหาเด่น + การ์ดหมวด ("เริ่มต้น", "สร้างวิดีโอ", ...) + ลิงก์ "เริ่มที่นี่"
- `/docs/[slug]` → หัวข้อเดี่ยว (deep-link ได้ เช่น ส่ง `studio.heroaiengine.com/docs/avatar` ให้ลูกค้าตอนซัพพอร์ต)
- **Search (MVP):** client-side filter บน `searchIndex` (title + keywords + summary) — เนื้อห​าไม่กี่หัวข้อ, ไม่ต้องมี index infra. พิมพ์ → โชว์รายการหัวข้อที่ match + หมวด → คลิกไปหน้านั้น. Empty state ชัดเจน
  - *Enhancement (ภายหลัง, ไม่ทำใน MVP):* index หัวข้อย่อย (H2) ในแต่ละ doc

---

## 6. Information Architecture (เนื้อหาใหม่ — อ้างอิงของจริงจากโค้ด)

> ตัวเลขด้านล่างดึงจากโค้ด (`src/lib/plan-limits.ts`, `src/lib/credits.ts`, `src/lib/key-tiers.ts`). **แนวทางกันข้อมูลล้าสมัย:** หัวข้อ "นาที & เครดิต" ควร `import` ค่าคงที่จริง (`MONTHLY_GRANT`, `minutesPerMonth`, `CREDIT_COST`) มาเรนเดอร์ตรงๆ เพื่อไม่ให้ตัวเลขใน docs drift จากระบบ

### 6.1 เริ่มต้น (getting-started)
- HERO ทำอะไรได้: สคริปต์ → วิดีโอสั้นอัตโนมัติ (เสียง + B-roll เปลี่ยนทุก 3–5 วิ + ซับไทยตรงเสียง + avatar ถ้าต้องการ)
- Flow หลัก: **Style → Content → Video**
- เริ่มยังไงใน 3 นาที (เช็คลิสต์สั้น: ใส่คีย์ B-roll → เขียนสคริปต์ → Render)

### 6.2 ตั้งค่าคีย์ API (setup-api-keys) — **เขียนใหม่**
- ⚠️ นำด้วย: **ระบบจัดการ Gemini ให้แล้ว** — ไม่ต้องใส่ Gemini key เอง (managed mode)
- คีย์ที่ผู้ใช้ต้องใส่เอง (BYOK) ที่ `/settings` แท็บ API Keys:
  - **จำเป็น:** Pexels **หรือ** Pixabay อย่างน้อย 1 ตัว (สำหรับ B-roll) — `isTier1Complete` ต้องมีอย่างน้อยหนึ่ง
  - **ตัวเลือก:** ElevenLabs (โคลนเสียง/เสียงพรีเมียม; ไม่ใส่ = ใช้เสียง Gemini) · HeyGen (avatar; ไม่ใส่ = เสียง+B-roll ปกติ)
- วิธี test คีย์ (ปุ่ม Test ที่ Settings) + วิธีเช็คว่าทำงาน
- ⚠️ ห้ามวาง key ในแชท — ให้ไปวางที่ Settings เสมอ
- *conditional:* ถ้า `managed` = false (flag ปิด) ให้โชว์ส่วน "ใส่ Gemini key เอง" — แต่ default (prod) = managed ON

### 6.3 สร้างวิดีโอ (create-video)
- Video Editor (เลย์เอาต์ 9:16 TikTok/Reels)
- ขั้นตอน: เขียนสคริปต์ → ตั้งค่า pipeline → เลือกสไตล์ซับ → Render (preview) → **Burn & Download** (export จริง)
- Pipeline: TTS Voice → Transcribe → Keywords → B-roll → Config → Render
- B-roll เปลี่ยนทุก 3–5 วิ (window-based, content-matched)
- เลือกเสียง: Gemini (default) หรือ ElevenLabs (ต้องมี voiceId)

### 6.4 ซับไทย (subtitles)
- 2 สไตล์: ยาว vs ไวรัล (viral-keyword)
- ซับตรงเสียง — timing มาจาก TTS (exact) ไม่ต้อง transcribe
- (บอกผู้ใช้ระดับ how-to พอ ไม่ลงรายละเอียดภายใน)

### 6.5 พิธีกร AI / Avatar (avatar)
- โหมด: `full` (ทั้งคลิป, แพง) · `bookend` (เปิด=หัว) · `bookend-both` (เปิด-ปิด=หัว+ท้าย)
- 2 วิธี: Generate ผ่าน HeyGen (ต้องมี HeyGen key + avatarId) vs Direct URL (green screen / full video)
- ⚠️ HeyGen คิดเงินตามวินาที — แนะนำ bookend ประหยัดกว่า full
- ตั้ง framing/ตำแหน่ง, timing (intro/tail secs), re-render โดยไม่เปลืองโควตา HeyGen

### 6.6 นาที & เครดิต (minutes-credits) — 🆕
- **แผน:** FREE / PRO / BUSINESS
- **โควตานาทีต่อ 30 วัน:** FREE **5** · PRO **80** · BUSINESS **150** (นับแบบปัดใกล้สุด ขั้นต่ำ 1 นาที/คลิป)
- **เครดิต (paid-only benefit):** 1 เครดิต = ฿1
  - grant รายเดือน (ใช้แล้วหมดไป ไม่ทบ): FREE **0** · PRO **50** · BUSINESS **150** · trial ไม่ได้รับ
  - ซื้อเพิ่มได้ (แพ็ก Stripe, permanent): ฿199→200, ฿499→540, ฿999→1150
  - **ใช้กับ:** นาที overflow เมื่อโควตานาทีหมด = **2 เครดิต/นาที** (อัตโนมัติ ไม่มี popup) · AI image/video gen (คิดต่อการกระทำ 3–25 เครดิต — ไม่ใช่อัตราตายตัว)
  - หัก granted ก่อน แล้วค่อย purchased
- คลิปย่อยต่อ 30 วัน (cap): FREE 2 · PRO 100 · BUSINESS 300
- *conditional/fail-open:* ถ้าโหลดสถานะ minutes/credits ไม่ได้ → แสดงเนื้อหาเป็นข้อมูลทั่วไป (default managed + credits live ตาม prod)

### 6.7 แก้ปัญหา / FAQ (troubleshooting)
- รวม error พบบ่อย + วิธีแก้: 503 high demand, B-roll หาคลิปไม่เจอ, avatar generate fail, key ไม่ถูกบันทึก, ฯลฯ (พอร์ตจากหน้าเดิม + อัปเดตให้ตรง managed/credits)

---

## 7. Entry points — ป้ายปุ่ม "วิธีใช้งาน"

| ไฟล์ | เดิม | ใหม่ |
|---|---|---|
| `src/components/layout/top-nav.tsx:20` | `{ title: "Docs", href: "/docs" }` | `{ title: "วิธีใช้งาน", href: "/docs" }` |
| `src/app/(dashboard)/dashboard/page.tsx:154` | label `"Docs"`, desc `"วิธีใช้งาน"` | label `"วิธีใช้งาน"`, desc เป็นคำอธิบายสั้น (เช่น "คู่มือ & สอนใช้ทีละขั้น") |
| `src/components/layout/sidebar.tsx` (~L43-51) | *(ไม่มีลิงก์ docs)* | **เพิ่ม** เมนู "วิธีใช้งาน" (ไอคอน `BookOpen`, href `/docs`) |

---

## 8. Visual design direction

- โทนสะอาด อ่านง่าย, dark theme สอดคล้องกับแอปแต่**สงบกว่า** (ลด orb/scanline/อนิเมชันหนัก)
- Accent เดียว: ม่วง `#8b5cf6` · headings Bai Jamjuree · line-length เหมาะอ่าน (~72ch)
- อนิเมชันเบา: fade-in ตอนเปลี่ยนหัวข้อ, hover states, respect `prefers-reduced-motion`
- ชุด UI ใช้ซ้ำใน `_components/ui.tsx`: Section, Step, PipelineRow, ApiRow, Warn/Info/Tip callouts, Code block — restyle จากของเดิมให้สะอาด
- ทำตาม `frontend-design` skill ตอน implement

---

## 9. Edge cases & error handling

- slug ไม่รู้จัก → `notFound()` (404 ในโซน docs) + ปุ่ม "กลับหน้า docs"
- โหลด `managed`/plan/credits พลาด → **fail-open**: แสดงเนื้อหา default (managed ON, credits live ตาม prod), ไม่ซ่อนอะไรจนผู้ใช้งง
- Search ไม่เจอ → empty state พร้อมลิงก์หน้าโฮม
- Auth: ยังล็อกอินถึงเข้าได้ (ยืนยัน middleware หลังย้าย route group — URL ไม่เปลี่ยน)
- Mobile: sidebar drawer, ค้นหาเข้าถึงได้, เนื้อหาเต็มจอ
- ลิงก์ภายในไป `/settings` ฯลฯ ต้องยังทำงานจากโซน docs

---

## 10. Verification plan

- `npm run build` ผ่าน (โปรเจกต์ verify ด้วย build + `verify-*.ts`, ไม่มี unit-test framework สำหรับเพจ)
- เทสมือ: เปิด `/docs` (โฮม) + ทุก `/docs/[slug]` + ค้นหา + ปุ่มกลับแอป + mobile drawer + ลิงก์ไป Settings
- เช็คเรนเดอร์ managed ON vs OFF (conditional ไม่พัง)
- เช็คปุ่ม "วิธีใช้งาน" ทั้ง 3 จุด (top-nav, dashboard card, sidebar) ลิงก์ถูก
- ยืนยันตัวเลขใน "นาที & เครดิต" ตรงกับค่าคงที่ในโค้ด

---

## 11. Files touched (สรุป)

**สร้างใหม่:**
- `src/app/(docs)/layout.tsx`
- `src/app/(docs)/docs/page.tsx`
- `src/app/(docs)/docs/[slug]/page.tsx`
- `src/app/(docs)/docs/_content/registry.ts` + `getting-started.tsx`, `setup-api-keys.tsx`, `create-video.tsx`, `subtitles.tsx`, `avatar.tsx`, `minutes-credits.tsx`, `troubleshooting.tsx`
- `src/app/(docs)/docs/_components/`: `docs-topbar.tsx`, `docs-sidebar.tsx`, `docs-search.tsx`, `docs-context.tsx`, `ui.tsx`

**แก้ไข:**
- `src/components/layout/top-nav.tsx` (ป้าย)
- `src/app/(dashboard)/dashboard/page.tsx` (ป้ายการ์ด)
- `src/components/layout/sidebar.tsx` (เพิ่มเมนู)

**ลบ:**
- `src/app/(dashboard)/docs/page.tsx` (เนื้อหาย้ายเข้า `_content/*`)

**ตรวจ (อาจไม่ต้องแก้):**
- `src/middleware.ts` (ยืนยัน `/docs` ยัง protected)

---

## 12. Open items

- ตัวเลขนาที/เครดิต: จะ hardcode ในเนื้อหา หรือ `import` ค่าคงที่จริงมาเรนเดอร์ (แนะนำ import เพื่อกัน drift) — ตัดสินตอน implement
- โฮม `/docs` จะเป็น landing การ์ดหมวด (ยืนยันแล้ว) — รายละเอียดหน้าตาไว้ทำตอน frontend-design
