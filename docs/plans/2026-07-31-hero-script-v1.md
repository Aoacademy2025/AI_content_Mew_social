# Hero Script v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship "Hero Script" — a viral short-form script writer (Thai-first, hook-first flow, framework engine + structured BrandProfile) with 1-click handoff into the video editor.

**Architecture:** New dashboard page `/hero-script` backed by two new Prisma models (`BrandProfile`, `Script`) and a set of `/api/brand-profiles/*` + `/api/scripts/*` routes. All LLM routes follow the existing text-gen triad (`resolveGeminiKey` → `reserveAiTextCall` → `checkAiInputCaps`); hooks/ideas use `gemini-2.5-flash`, full-script/regenerate use `gemini-2.5-pro`. Handoff creates an `EditorProject` server-side (via `src/lib/editor-projects.ts`) with the script prefilled in `draftJson`, then redirects to `/video-editor?projectId=`.

**Tech Stack:** Next.js 15 App Router, Prisma 6/SQLite, Clerk auth, Gemini via `src/lib/gemini.ts`, Tailwind v4 + shadcn/ui (violet house system).

## Global Constraints

- Branch: `mew/hero-script-v1` off `main`, in a **fresh worktree** (current checkout `mew/hero-voice-emotion-rig` is dirty — do not build on it). Fresh worktree needs `.env` + `npx prisma generate` (see memory: overnight-audit 2026-07-02).
- `main` = production. Never push to main; PR only.
- Feature name: **Hero Script**; UI menu label: **เขียนสคริปต์ AI**. All user-facing copy in Thai.
- Script text convention: **1 line = 1 spoken sentence** (the editor treats 1 line = 1 Segment — see CONTEXT.md "Segment").
- Billing: **no credits.** Managed-mode LLM calls are metered per-call by `reserveAiTextCall` (existing). New plan caps in `plan-limits.ts`: `scripts` FREE 3 / 30 days, PRO+BUSINESS Infinity; `brandProfiles` FREE 1 / PRO 5 / BUSINESS Infinity (saved-niche count is a plan feature — Mew decision 2026-07-31).
- **Continuity rule:** idea generation must know the profile's history — last 20 saved Script topics under the selected BrandProfile are injected into the IDEAS prompt with "no repeats + propose continuations/series" rules. This is the core moat vs raw chatbots.
- Models: hooks/ideas/analyze = `gemini-2.5-flash`; full script + section regenerate = pro tier. Model ids read from env with defaults: `HERO_SCRIPT_MODEL_FAST` (default `gemini-2.5-flash`), `HERO_SCRIPT_MODEL_PRO` (default `gemini-pro-latest` — amended 2026-07-31: `gemini-2.5-pro` returns 404 "no longer available to new users" on the project server key; `gemini-pro-latest` verified working live). Pro-tier models reject `thinkingBudget: 0`, hence the per-call thinking-budget param in `gemini.ts`.
- Word budget: `durationSec × 4 คำ/วินาที ±15%` — reuse the pacing constants in `src/lib/prompts/content-generator.ts:33-49`; do not invent a second pacing table.
- Every new API route: Clerk-authenticated (follow existing `/api/videos/*` route auth pattern), Thai error messages, JSON responses. URL fetching only through the existing SSRF-guarded helper used by `src/app/api/contents/generate/route.ts` (`safeAxiosGet`).
- Do not modify `Style`, `Content`, or any `/content` `/style` legacy pages. Do not touch the editor's own files except the read path already consuming `draftJson`.
- Verify pattern: `scripts/verify-hero-script.ts` run with `tsx` against a **throwaway SQLite** (copy the pattern from an existing `scripts/verify-*.ts`; never point at dev.db).

---

## The Viral Framework Library (product copy — implement verbatim in Task 2)

Curated by session model; approved by Mew at plan approval. Stored as data in `src/lib/viral-frameworks.ts`.

### Hook formulas (`HOOK_FORMULAS`) — key, ชื่อไทย, กติกา, ตัวอย่าง

1. `curiosity-gap` — **เปิดช่องว่างความอยากรู้**: บอกผลลัพธ์หรือปมที่น่าสนใจ แต่ยังไม่เฉลยวิธี/เหตุผล — "รู้ไหมทำไมร้านนี้ขายแพงกว่าคู่แข่ง 3 เท่า แต่คิวยาวกว่า"
2. `contrarian` — **ขัดความเชื่อ**: ปฏิเสธสิ่งที่กลุ่มเป้าหมายเชื่อกันทั่วไปอย่างมั่นใจ — "เลิกตื่นตี 5 เถอะ ถ้าอยากงานเสร็จเยอะขึ้น"
3. `shock-number` — **ตัวเลขช็อค**: นำด้วยตัวเลขที่เกินความคาดหมายและเจาะจง — "ผมเปลี่ยน 500 บาทเป็น 50,000 ใน 30 วัน ด้วยของที่ทุกบ้านมี"
4. `direct-callout` — **เรียกกลุ่มเป้าหมายตรง ๆ**: ระบุตัวคนดูให้รู้ว่า "คลิปนี้พูดกับฉัน" — "ใครที่ลงคลิปทุกวันแต่ยอดวิวไม่ขยับ ฟังทางนี้"
5. `mistake-warning` — **เตือนความผิดพลาด**: ชี้ว่าคนดูกำลังทำพลาดโดยไม่รู้ตัว — "3 อย่างที่คุณทำผิดทุกครั้งที่ตั้งชื่อคลิป"
6. `pov-story` — **เล่าเรื่องจากประสบการณ์**: เปิดกลางเหตุการณ์ ไม่มีอารัมภบท — "วันที่ลูกค้ารายใหญ่ที่สุดเทผม คือวันที่ผมได้บทเรียนแพงที่สุดในชีวิต"
7. `secret-reveal` — **เปิดเผยความลับวงใน**: สัญญาว่าจะบอกสิ่งที่คนในวงการไม่พูด — "สิ่งที่เอเจนซี่ไม่เคยบอกคุณ ตอนคิดค่ายิงแอด"
8. `before-after` — **ก่อน-หลัง**: โชว์การเปลี่ยนแปลงสุดขั้วก่อนเล่าวิธี — "จากพูดหน้ากล้องไม่เป็น สู่ครีเอเตอร์แสนฟอลใน 6 เดือน"
9. `challenge-timer` — **ท้าพิสูจน์ในเวลาจำกัด**: ผูกสัญญากับเวลาของคลิป — "ให้เวลาผม 60 วินาที จะทำให้คุณเลิกกลัวกล้องตลอดไป"
10. `question-poll` — **คำถามที่ทุกคนมีคำตอบในใจ**: คำถามที่คนดูอยากตอบ/อยากรู้คำตอบของคนอื่น — "ถ้ามีเงินเก็บ 10,000 แรกในชีวิต คุณจะเอาไปทำอะไร"

กติการ่วมของทุก hook: ยาวไม่เกิน 20 คำ (พูดจบใน ~5 วินาที), ห้ามขึ้นต้นด้วยคำทักทาย, ภาษาพูด, เจาะจงไม่กว้าง

### Story structures (`STORY_STRUCTURES`) — key, ชื่อไทย, โครง

1. `list` — **ลิสต์**: Hook → ข้อ 1..N (เก็บข้อเด็ดสุดไว้ท้าย พูดว่า "ข้อสุดท้ายสำคัญสุด") → CTA
2. `pas` — **ปัญหา-ขยี้-ทางออก**: ปัญหาที่คนดูเจอ → ขยี้ผลเสียให้เห็นภาพ → ทางออกทีละขั้น → CTA
3. `story-lesson` — **เรื่องเล่า-บทเรียน**: เหตุการณ์จริง (เปิดกลางเรื่อง) → จุดพลิก → บทเรียนที่ใช้ได้ทันที → CTA
4. `how-to` — **สอนทำ**: ผลลัพธ์ที่จะได้ → ขั้นตอน 1-2-3 → จุดที่คนมักพลาด → CTA
5. `myth-bust` — **ล้างความเชื่อผิด**: ความเชื่อที่คนส่วนใหญ่ยึด → ทำไมมันผิด (เหตุผล/หลักฐาน) → สิ่งที่ควรทำแทน → CTA

### Retention rules (`RETENTION_RULES` — injected into every generate prompt)

- ประโยคสั้น ภาษาพูด ~4 คำ/วินาที; 1 บรรทัด = 1 ประโยคที่พูดจริง
- ทุก 3–5 วินาทีต้องมีเหตุผลให้ดูต่อ (open loop, คำถามค้าง, "เดี๋ยวข้อต่อไปหนักกว่า")
- ห้ามอารัมภบททุกชนิด ("สวัสดีครับ วันนี้เราจะมาพูดถึง…" = ห้าม) — ประโยคแรกคือ hook เสมอ
- ใช้คำที่กลุ่มเป้าหมาย (audience) ใช้จริง หลีกเลี่ยงภาษาทางการ/ภาษาเขียน
- CTA เดียว ชัดเจน ไม่เกิน 2 ประโยค ตามสไตล์ที่แบรนด์เลือก

### CTA styles (`CTA_STYLES`)

- `follow` — ฝากติดตาม: ผูกกับคุณค่าตอนต่อไป ("ตามไว้ เดี๋ยวพาร์ทสองเจ็บกว่านี้")
- `comment` — ชวนคอมเมนต์: ถามคำถามที่ตอบง่ายและอยากอวด ("คุณทีมตื่นเช้าหรือทีมนอนดึก คอมเมนต์บอกหน่อย")
- `share` — ชวนแชร์/เซฟ: ระบุคนที่ควรได้เห็น ("เซฟไว้ก่อนหาย แล้วส่งให้เพื่อนที่กำลังท้อ")
- `sell` — ขายแบบเนียน: สะพานจากเนื้อหาไปสินค้า/บริการ ไม่ hard sell ("ถ้าอยากได้ตัวช่วย ผมทิ้งลิงก์ไว้ให้ใต้คลิป")

---

## Data model (Task 1 — exact schema)

```prisma
model BrandProfile {
  id            String   @id @default(cuid())
  userId        String
  name          String                    // ชื่อแบรนด์/โปรไฟล์
  niche         String                    // นิช เช่น "การเงินส่วนบุคคล"
  audience      String                    // กลุ่มเป้าหมาย เช่น "มนุษย์เงินเดือน 25-35"
  tone          String                    // โทนเสียง เช่น "เป็นกันเอง ขี้เล่น มีสาระ"
  bannedWords   String   @default("[]")   // JSON string array
  ctaStyle      String   @default("follow") // follow | comment | share | sell
  language      String   @default("th")
  sampleText    String?                   // แหล่งที่ใช้ตอน analyze (ถ้ามี)
  sampleUrl     String?
  analysisNotes String?                   // โน้ตสไตล์การเขียนที่ LLM สกัดได้
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  scripts       Script[]

  @@index([userId])
}

model Script {
  id              String   @id @default(cuid())
  userId          String
  brandProfileId  String?
  topic           String
  durationSec     Int      @default(60)   // 30 | 60 | 90
  hookFormula     String?                 // key จาก HOOK_FORMULAS
  structure       String?                 // key จาก STORY_STRUCTURES
  hookText        String
  bodyText        String                  // หลายบรรทัด: 1 บรรทัด = 1 ประโยค
  ctaText         String
  status          String   @default("draft") // draft | sent
  editorProjectId String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  user            User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  brandProfile    BrandProfile? @relation(fields: [brandProfileId], references: [id], onDelete: SetNull)

  @@index([userId, createdAt])
}
```

Also add back-relations `brandProfiles BrandProfile[]` / `scripts Script[]` on `User`. Deploy path is `prisma db push` (additive — safe per deploy.sh).

## API contracts (implemented across Tasks 1–4)

All routes: Clerk auth; on missing key → 409 `KEY_REQUIRED`; over text quota → 429 `QUOTA_AI_TEXT` (both already produced by the triad — surface their Thai messages). LLM JSON responses validated; 1 retry on parse/validation failure, then 502 `{ error: "AI ตอบผิดรูปแบบ ลองใหม่อีกครั้ง" }`.

| Route | Method | Request → Response |
|---|---|---|
| `/api/brand-profiles` | GET / POST | list own · create `{name, niche, audience, tone, bannedWords?, ctaStyle?}` → profile. POST enforces `brandProfiles` plan cap → 403 `PROFILE_LIMIT` `{ error: "แผน {plan} เซฟนิชได้ {cap} โปรไฟล์ — อัปเกรดเพื่อเพิ่มนิช" }` |
| `/api/brand-profiles/[id]` | PUT / DELETE | update fields · delete |
| `/api/brand-profiles/analyze` | POST | `{sampleText?} \| {sampleUrl?}` → `{niche, audience, tone, analysisNotes}` (suggestion only, **not** auto-saved; flash) |
| `/api/brand-profiles/niche-ideas` | POST | `{seed}` (เรื่องกว้าง **หรือ** นิชที่เลือกไว้แล้ว เพื่อขุดลึกลงอีกชั้น) → `{niches: [{niche, why, audience, sampleTopics: [2]}] × 7}` (flash; seed ≤ 300 chars) |
| `/api/scripts/ideas` | POST | `{brandProfileId}` → `{ideas: [{topic, angle}] × 8}` (flash). Server loads last 20 Script topics of that profile and injects them per the IDEAS prompt continuity block |
| `/api/scripts/hooks` | POST | `{topic, brandProfileId?, durationSec}` → `{hooks: [{formula, text}] × 5}` (flash; 5 different formula keys, each valid ∈ HOOK_FORMULAS, ≤ 20 คำ) |
| `/api/scripts/generate` | POST | `{topic, hookText, hookFormula, brandProfileId?, durationSec}` → `{structure, bodyText, ctaText}` (pro; hookText is preserved verbatim — model writes body+cta around it and picks structure, labeling the key) |
| `/api/scripts/regen-section` | POST | `{target: "hook"\|"body"\|"cta", topic, durationSec, brandProfileId?, current: {hookText, bodyText, ctaText}}` → `{text}` for that section, others unchanged (pro; hook regen returns a new hook from a *different* formula). Request additionally accepts optional `hookFormula` (current formula) so the server can validate the regenerated formula differs — addendum 2026-07-31. |
| `/api/scripts` | GET / POST | list own (newest first, take 50) · save `{topic, durationSec, hookFormula, structure, hookText, bodyText, ctaText, brandProfileId?}` → Script (enforces FREE cap → 403 `SCRIPT_LIMIT` with Thai upsell message) |
| `/api/scripts/[id]` | GET / PUT / DELETE | load (restore into UI) · update sections · delete |
| `/api/scripts/[id]/send-to-editor` | POST | paid: create EditorProject via `src/lib/editor-projects.ts` create path with `draftJson` containing `mode: "script"` + assembled script (hook\n…body…\ncta), set `Script.status="sent"`, `editorProjectId` → `{projectId}`. FREE (`allowVideoEditor: false` in `plan-limits.ts`): 403 `EDITOR_LOCKED` + upsell message |

**Service layer:** business logic lives in `src/lib/hero-script.server.ts` (pure/service functions: `assembleScript`, `containsBannedWord`, `wordBudgetForDuration`, `countScriptsInWindow`, `canCreateScript`, `sendScriptToEditor`, prompt builders) so routes stay thin and the verify script can test logic without HTTP.

**Banned-words guard:** after every generate/regen, case-insensitive substring check against the profile's `bannedWords`; on hit → 1 retry with a stern addition to the prompt; if still present → return result with `warning: "มีคำต้องห้ามหลุดมา: <คำ>"` (never block the user).

## Prompt copy (implement verbatim as builders in `src/lib/prompts/hero-script.ts`)

`{...}` = interpolation. Brand block (shared): if a profile is provided —
```
ข้อมูลแบรนด์: นิช={niche} | กลุ่มเป้าหมาย={audience} | โทนเสียง={tone}
คำต้องห้าม (ห้ามปรากฏในผลลัพธ์เด็ดขาด): {bannedWords}
โน้ตสไตล์การเขียนของแบรนด์นี้: {analysisNotes}
```

**IDEAS (flash):**
```
คุณคือนักวางกลยุทธ์คอนเทนต์ไวรัลสำหรับครีเอเตอร์ไทย
{BRAND_BLOCK}
{CONTINUITY_BLOCK}
คิดหัวข้อคลิปสั้น 8 หัวข้อ ที่ทำให้กลุ่มเป้าหมายนี้ "หยุดนิ้ว"
กติกา: เจาะจง ไม่กว้าง, มี tension หรือประโยชน์ชัดเจน, ไม่เกิน 15 คำต่อหัวข้อ
ตอบเป็น JSON เท่านั้น: {"ideas":[{"topic":"...","angle":"ทำไมหัวข้อนี้น่าจะไวรัล (สั้น ๆ)"}]}
```
`{CONTINUITY_BLOCK}` — included only when the profile has saved scripts:
```
หัวข้อที่ช่องนี้ทำไปแล้วล่าสุด: {recentTopics}
กติกาความต่อเนื่อง: ห้ามเสนอหัวข้อซ้ำหรือใกล้เคียงกับที่ทำไปแล้ว
และอย่างน้อย 2 จาก 8 หัวข้อต้องเป็นการต่อยอดจากหัวข้อที่ทำไปแล้ว (ภาคต่อ, ซีรีส์, มุมใหม่ของเรื่องเดิม) — ระบุใน angle ว่าต่อยอดจากหัวข้อไหน
```

**HOOKS (flash):** include the full HOOK_FORMULAS list (key + กติกา + ตัวอย่าง) in the prompt, then:
```
หัวข้อคลิป: {topic} (ความยาว {durationSec} วินาที)
{BRAND_BLOCK}
เลือกสูตร hook 5 สูตรที่เหมาะกับหัวข้อนี้ที่สุดจากรายการข้างบน แล้วเขียน hook สูตรละ 1 อัน
กติกา: ไม่เกิน 20 คำ, ภาษาพูด, ห้ามคำทักทาย, ตรงโทนเสียงแบรนด์
ตอบเป็น JSON เท่านั้น: {"hooks":[{"formula":"<key>","text":"..."}]}
```

**GENERATE (pro):** include STORY_STRUCTURES + RETENTION_RULES + CTA style ที่เลือก, then:
```
หัวข้อคลิป: {topic} | ความยาว {durationSec} วินาที | งบคำทั้งคลิป ~{wordBudget} คำ (±15%)
{BRAND_BLOCK}
Hook ที่ผู้ใช้เลือก (ห้ามแก้แม้แต่คำเดียว จะถูกใช้เป็นบรรทัดแรกเสมอ): "{hookText}"
เลือกโครงเรื่องที่เหมาะที่สุด 1 โครงจากรายการข้างบน แล้วเขียนเนื้อหา (body) ต่อจาก hook และปิดด้วย CTA สไตล์ {ctaStyle}
กติกา body: 1 บรรทัด = 1 ประโยคที่พูดจริง, ทำตาม RETENTION_RULES ทุกข้อ, งบคำรวม (hook+body+cta) อยู่ในกรอบ
ตอบเป็น JSON เท่านั้น: {"structure":"<key>","bodyText":"บรรทัดละประโยค\nคั่นด้วย \\n","ctaText":"..."}
```

**REGEN (pro):** same context; instruction per target — body: "เขียน body ใหม่ให้ต่างจากเดิมชัดเจน โดยคง hook และ CTA เดิม"; cta: "เขียน CTA ใหม่สไตล์ {ctaStyle} ให้ต่างจากเดิม"; hook: "เขียน hook ใหม่ 1 อันจากสูตรอื่นที่ไม่ใช่ {currentFormula}". Output `{"text":"..."}` (+`"formula"` when target=hook).

**NICHE DRILL-DOWN (flash):**
```
คุณคือนักวางกลยุทธ์คอนเทนต์ที่เชี่ยวชาญการหา "นิชเจาะลึก" ให้ครีเอเตอร์ไทย
เรื่องที่ผู้ใช้สนใจ: {seed}
เสนอนิชเจาะลึก 7 นิช ที่แคบกว่าเรื่องนี้อย่างน้อย 2 ระดับ — ห้ามเสนอหมวดหมู่ทั่วไป (เช่น "การออม" "การลงทุน")
ต้องเป็นมุมเฉพาะที่สร้าง identity ให้ช่องได้ เช่น "การเงินสาย dark เล่ากลโกงและคดีดัง", "ประวัติศาสตร์ทฤษฎีสมคบคิด"
แต่ละนิชต้องมี: ชื่อนิช, ช่องว่าง/ทำไมน่าสนใจตอนนี้, กลุ่มคนดูที่จะอิน, ตัวอย่างหัวข้อคลิป 2 อัน
ตอบเป็น JSON เท่านั้น: {"niches":[{"niche":"...","why":"...","audience":"...","sampleTopics":["...","..."]}]}
```
(ใช้ endpoint เดียวกันขุดซ้ำได้: ส่งนิชที่เพิ่งเลือกกลับมาเป็น `seed` เพื่อลงลึกอีกชั้น)

**ANALYZE (flash):** input = sampleText (≤ 4,000 chars, same truncation as contents/generate) or fetched URL text:
```
วิเคราะห์ตัวอย่างคอนเทนต์นี้ แล้วสกัดโปรไฟล์แบรนด์
ตอบเป็น JSON เท่านั้น: {"niche":"...","audience":"...","tone":"...","analysisNotes":"จุดเด่นสำนวน/เทคนิค hook/โครงที่ใช้ประจำ (3-5 bullet)"}
```

## UI (single page `/hero-script`, violet house system, mobile-responsive)

Stepper flow (state machine in one client component tree under `src/app/(dashboard)/hero-script/_components/`):

1. **Setup rail** — BrandProfile picker (dropdown + "สร้างโปรไฟล์แบรนด์" dialog: manual form + tab "วิเคราะห์จากตัวอย่าง" paste text/URL → suggestion fills the form for user confirmation) + duration select (30/60/90 วิ). Profile optional — "ไม่ใช้โปรไฟล์" allowed. **Niche Drill-down:** ข้างช่อง niche มีปุ่ม "ขุดนิชให้ลึกกว่านี้" → ส่งค่าที่พิมพ์เป็น `seed` → แสดง 7 การ์ดนิชเจาะลึก (ชื่อ + ทำไมน่าสนใจ + คนดู + ตัวอย่างหัวข้อ) → เลือกแล้วเติม `niche`+`audience` ให้อัตโนมัติ (แก้ต่อได้) และกดขุดซ้ำจากนิชที่เลือกเพื่อลงลึกอีกชั้นได้; ช่อง niche ใช้ label "นิชเจาะลึก" + placeholder ตัวอย่างแบบลึก ("เช่น การเงินสาย dark เล่ากลโกงและคดีดัง")
2. **หัวข้อ** — topic input + ปุ่ม "คิดไอเดียให้หน่อย" → 8 idea cards (topic + angle); clicking one fills the topic.
3. **เลือก Hook** — 5 hook cards, each labeled with ชื่อสูตรไทย; inline-editable after pick; ปุ่ม "ขออีกชุด" regenerates 5 more.
4. **สคริปต์เต็ม** — three editable sections (Hook / เนื้อหา / CTA) each with a regenerate button; word-count vs budget indicator; autosaves as a `Script` row (debounced PUT).
5. **ส่งไปตัดต่อ** — primary CTA → POST send-to-editor → `router.push("/video-editor?projectId=…")`. FREE sees the button in locked state with upsell copy "อัปเกรดเป็น PRO เพื่อส่งเข้าตัดต่อ".

**History**: "สคริปต์ของฉัน" list (topic, วันที่, status chip ร่าง/ส่งแล้ว) → click restores into step 4. Delete with confirm.

**Quota/error states (Thai):** 429 → "ใช้โควตา AI ครบรอบนี้แล้ว รอรีเซ็ตหรืออัปเกรดแผน"; FREE script cap → "แผนฟรีเขียนได้ 3 สคริปต์/30 วัน — อัปเกรดเพื่อเขียนไม่จำกัด" + link `/pricing`.

**Nav:** add "เขียนสคริปต์ AI" to `src/components/layout/sidebar.tsx` main section (above วิดีโอของฉัน), badge "ใหม่".

---

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Schema + BrandProfile slice (models, CRUD+analyze API, page shell + nav + profile UI) | mew-worker | subagent | — | build+verify, mew-reviewer, /security-review (new user-input routes + URL fetch) |
| 2 | Framework library + ideas + hooks (lib data, 2 LLM routes, step 2-3 UI) | mew-worker | subagent | 1 | build+verify, mew-reviewer |
| 3 | Full-script engine (generate/regen routes, section editor UI, scripts CRUD + history) | mew-worker-heavy | subagent | 2 | build+verify, mew-reviewer |
| 4 | Handoff + gating (send-to-editor, FREE caps + paywall states, quota error surfaces) | mew-worker-heavy | subagent | 3 | build+verify, mew-reviewer, /security-review (plan gating + project creation) |
| 5 | Integration verify (full verify script pass, `npm run build`, smoke checklist) | mew-worker | subagent | 4 | session final gate |

Session model: authors this plan's copy (done — framework library + prompts above), reviews Tier-1 summaries, holds the final gate. Workers never invent copy — every Thai string they need is in this file.

### Task 1: Schema + BrandProfile vertical slice

**Files:**
- Modify: `prisma/schema.prisma` (add 2 models + User back-relations), `src/components/layout/sidebar.tsx` (nav item), `src/lib/plan-limits.ts` (`brandProfiles: 1` FREE / `5` PRO / `Infinity` BUSINESS)
- Create: `src/app/api/brand-profiles/route.ts`, `src/app/api/brand-profiles/[id]/route.ts`, `src/app/api/brand-profiles/analyze/route.ts`, `src/app/api/brand-profiles/niche-ideas/route.ts`, `src/app/(dashboard)/hero-script/page.tsx`, `src/app/(dashboard)/hero-script/_components/BrandProfilePanel.tsx`, `src/lib/hero-script.server.ts` (start: types + profile helpers), `src/lib/prompts/hero-script.ts` (start: ANALYZE + NICHE DRILL-DOWN builders), `scripts/verify-hero-script.ts` (start)

**Interfaces produced:** `BrandProfile`/`Script` Prisma models; `heroScriptPage` shell that later tasks mount steps into; `buildAnalyzePrompt(sample: string): string`.

- [ ] Add Prisma models exactly as specced → `npx prisma generate` + local `prisma db push` on a scratch DB
- [ ] Write verify cases (BrandProfile CRUD roundtrip incl. bannedWords JSON parse; NICHE prompt builder contains seed + JSON contract; FREE 2nd profile → `PROFILE_LIMIT`, PRO 5 OK + 6th → `PROFILE_LIMIT`) → run red
- [ ] Implement routes (auth pattern + flash triad on analyze/niche-ideas; sampleUrl via `safeAxiosGet`; 4,000-char truncation; niche-ideas validates 7 items each with niche/why/audience/sampleTopics[2], 1 retry; POST cap check via `canCreateBrandProfile(plan, count)` in `hero-script.server.ts`) → verify green
- [ ] Page shell + nav item + BrandProfilePanel (list/create/edit dialog + analyze tab + Niche Drill-down button/cards per UI spec; "สร้างโปรไฟล์" locked at cap with upsell + `/pricing` link)
- [ ] `npm run build` passes → commit

### Task 2: Framework library + ideas + hooks

**Files:**
- Create: `src/lib/viral-frameworks.ts` (HOOK_FORMULAS, STORY_STRUCTURES, RETENTION_RULES, CTA_STYLES — verbatim from this plan), `src/app/api/scripts/ideas/route.ts`, `src/app/api/scripts/hooks/route.ts`, `_components/TopicStep.tsx`, `_components/HookStep.tsx`
- Modify: `src/lib/prompts/hero-script.ts` (IDEAS + HOOKS builders), `src/lib/hero-script.server.ts` (`wordBudgetForDuration` reusing content-generator pacing constants), page wiring

**Interfaces:** consumes Task 1 profile types; produces `HookChoice = {formula: string, text: string}` used by Task 3.

- [ ] Verify cases: prompt builders contain formula keys + brand block + banned words; `wordBudgetForDuration(60) ≈ 240`; IDEAS builder with recentTopics includes continuity block (topics list + no-repeat + ต่อยอด rules) and omits it when history is empty → red
- [ ] Implement library + builders → green
- [ ] Routes (flash, triad, JSON validation: exactly 5 hooks, distinct valid formula keys, ≤ 20 คำ; 1 retry; ideas route queries last 20 Script topics by brandProfileId ordered by createdAt desc)
- [ ] UI steps 2–3 per spec (idea cards, hook cards with ชื่อสูตร, editable pick, "ขออีกชุด")
- [ ] Build passes → commit

### Task 3: Full-script engine + history

**Files:**
- Create: `src/app/api/scripts/route.ts`, `src/app/api/scripts/[id]/route.ts`, `src/app/api/scripts/generate/route.ts`, `src/app/api/scripts/regen-section/route.ts`, `_components/ScriptEditorStep.tsx`, `_components/ScriptHistory.tsx`
- Modify: `src/lib/prompts/hero-script.ts` (GENERATE + REGEN builders), `src/lib/hero-script.server.ts` (`assembleScript` = hook + "\n" + bodyText + "\n" + ctaText; `containsBannedWord`; save/list/update service fns), page wiring

**Interfaces:** consumes `HookChoice`; produces saved `Script` rows + `assembleScript(script): string` used by Task 4.

- [ ] Verify cases: `assembleScript` newline layout; `containsBannedWord("อย่าลืมกดไลก์", ["กดไลก์"]) === true`; GENERATE prompt contains hook verbatim + word budget; Script CRUD roundtrip → red
- [ ] Implement service fns + builders → green
- [ ] Routes (pro model; hookText verbatim-preserved — server reattaches it, never trusts the model to echo it; banned-word retry-then-warn per spec)
- [ ] UI step 4 (three sections, per-section regenerate, budget indicator, debounced autosave) + history list/restore/delete
- [ ] Build passes → commit

### Task 4: Handoff + gating

**Files:**
- Create: `src/app/api/scripts/[id]/send-to-editor/route.ts`
- Modify: `src/lib/plan-limits.ts` (`scripts: 3` in FREE_LIMITS; `scripts: Infinity` in PRO/BUSINESS), `src/lib/hero-script.server.ts` (`countScriptsInWindow` = Script count where `createdAt >= now-30d`; `canCreateScript(plan, count)`; `sendScriptToEditor` using the create path in `src/lib/editor-projects.ts` — reuse its default-draft builder, set `mode: "script"` + script text, **never hand-roll draftJson**; read `useV2Project.ts:1090` hydration to confirm field names), scripts POST route (enforce cap → 403 `SCRIPT_LIMIT`), `ScriptEditorStep.tsx` (CTA states: paid → redirect; FREE → locked + upsell), error surfaces per UI spec

**Interfaces:** consumes `assembleScript`; produces `{projectId}` consumed by `/video-editor?projectId=`.

- [ ] Verify cases: FREE 4th script in window → `SCRIPT_LIMIT`; PRO 5 scripts OK; `sendScriptToEditor` (paid) creates EditorProject whose draftJson script === assembled text + Script.status="sent" + editorProjectId set; FREE → `EDITOR_LOCKED` → red
- [ ] Implement → green
- [ ] Wire UI states (locked CTA, quota toasts, /pricing links)
- [ ] Build passes → commit

### Task 5: Integration verify

- [ ] Full `scripts/verify-hero-script.ts` run green on throwaway DB (all tasks' cases)
- [ ] `npm run build` green
- [ ] Write smoke checklist result into PR description: create profile (manual + analyze), idea→hook→script→edit→regen each section, save/restore from history, send-to-editor lands in editor with script prefilled, FREE cap + locked CTA behave
- [ ] Open PR `mew/hero-script-v1` → `main` (no merge — Mew merges/deploys)

## Acceptance Criteria

- [ ] PRO user completes the full loop: BrandProfile → idea → 5 hooks (distinct formulas, Thai, ≤20 คำ) → full script within word budget ±15% (1 line = 1 sentence) → per-section regenerate without losing other sections → ส่งไปตัดต่อ → editor opens with the exact assembled script, ready to render
- [ ] Niche Drill-down: typing a broad seed ("การเงิน") returns 7 เจาะลึก sub-niches (specific angles, not generic categories), picking one fills niche+audience, and re-drilling from a picked niche goes one level deeper
- [ ] Saved niches are plan-gated: FREE 1 / PRO 5 / BUSINESS unlimited BrandProfiles, with Thai upsell at the cap
- [ ] Continuity: with ≥1 saved script under a profile, idea generation never repeats a past topic and proposes ≥2 continuation/series ideas referencing past topics
- [ ] FREE user: writes up to 3 scripts/30d then hits `SCRIPT_LIMIT` upsell; ส่งไปตัดต่อ always locked with upgrade CTA
- [ ] BYOK (non-managed) users work via their own Gemini key; managed users are metered by `reserveAiTextCall`; no credit is ever charged
- [ ] Banned words never silently pass: retry then explicit warning
- [ ] History restores a script exactly; deleting never touches EditorProjects
- [ ] All new routes reject unauthenticated requests; analyze URL fetch goes only through `safeAxiosGet`; inputs capped (4,000-char samples, topic ≤ 300 chars)
- [ ] `npm run build` + full verify script green; zero changes to legacy `/content` `/style` behavior and to editor v1/v2 render paths

## Out of scope

- Trend-based idea research, reference-clip analysis, premium-model upsell, image-gen personalization — all mapped in `docs/plans/2026-07-31-script-first-funnel-map.md`
- English-first UX (structure supports `language` field; UI copy Thai-only v1)
- Chat-refine interface (deliberate Q6 decision)
- Editor-side changes beyond consuming a prefilled draft

## Status

interviewed 2026-07-31 | approved: 2026-07-31 | executed: 2026-07-31 (5 tasks + final hardening wave, all reviews clean) | delivered: 2026-07-31 PR to main
