// hero-script.ts — prompt builders for Hero Script (viral script writer).
//
// Task 1 shipped the ANALYZE and NICHE DRILL-DOWN builders (used by
// /api/brand-profiles/analyze and /api/brand-profiles/niche-ideas). Task 2
// adds the shared BRAND_BLOCK builder plus the IDEAS and HOOKS builders (used
// by /api/scripts/ideas and /api/scripts/hooks). GENERATE/REGEN are added by
// later Hero Script tasks per the shared spec — do not add stubs for them
// here so unused-export lint doesn't drift ahead of their real callers.
//
// Copy is verbatim from `.superpowers/sdd/2026-07-31-hero-script-v1/shared-spec.md`
// ("Prompt copy" section). The only non-verbatim addition is the literal
// insertion point for the caller-supplied sample text in buildAnalyzePrompt —
// the spec states the instruction copy but does not show a `{...}` marker for
// where the sample itself goes (unlike the other builders), so it is embedded
// between the instruction line and the JSON-contract line, delimited the same
// way the codebase's other analyze prompts (e.g. styles/analyze) embed samples.

import { HOOK_FORMULAS, HOOK_COMMON_RULES } from "@/lib/viral-frameworks";

/**
 * ANALYZE (flash). `sample` is the already-truncated (≤4,000 chars) source
 * text — either pasted directly or fetched from a URL — same truncation
 * convention as `src/app/api/contents/generate/route.ts`.
 */
export function buildAnalyzePrompt(sample: string): string {
  return `วิเคราะห์ตัวอย่างคอนเทนต์นี้ แล้วสกัดโปรไฟล์แบรนด์

ตัวอย่างคอนเทนต์:
"""
${sample}
"""

ตอบเป็น JSON เท่านั้น: {"niche":"...","audience":"...","tone":"...","analysisNotes":"จุดเด่นสำนวน/เทคนิค hook/โครงที่ใช้ประจำ (3-5 bullet)"}`;
}

/**
 * NICHE DRILL-DOWN (flash). `seed` is a broad topic OR a previously-selected
 * niche (to drill down another level) — caller enforces the ≤300 char cap
 * (see `validateNicheSeed` in `src/lib/hero-script.server.ts`).
 */
export function buildNicheDrilldownPrompt(seed: string): string {
  return `คุณคือนักวางกลยุทธ์คอนเทนต์ที่เชี่ยวชาญการหา "นิชเจาะลึก" ให้ครีเอเตอร์ไทย
เรื่องที่ผู้ใช้สนใจ: ${seed}
เสนอนิชเจาะลึก 7 นิช ที่แคบกว่าเรื่องนี้อย่างน้อย 2 ระดับ — ห้ามเสนอหมวดหมู่ทั่วไป (เช่น "การออม" "การลงทุน")
ต้องเป็นมุมเฉพาะที่สร้าง identity ให้ช่องได้ เช่น "การเงินสาย dark เล่ากลโกงและคดีดัง", "ประวัติศาสตร์ทฤษฎีสมคบคิด"
แต่ละนิชต้องมี: ชื่อนิช, ช่องว่าง/ทำไมน่าสนใจตอนนี้, กลุ่มคนดูที่จะอิน, ตัวอย่างหัวข้อคลิป 2 อัน
ตอบเป็น JSON เท่านั้น: {"niches":[{"niche":"...","why":"...","audience":"...","sampleTopics":["...","..."]}]}`;
}

// ── Shared brand block (Task 2+) ────────────────────────────────────────────

/** Minimal profile shape the brand block needs — matches both a raw
 *  BrandProfile row and BrandProfileDTO (bannedWords already parsed). */
export interface BrandProfileForPrompt {
  niche: string;
  audience: string;
  tone: string;
  bannedWords: string[];
  analysisNotes?: string | null;
}

/**
 * Shared brand block, embedded in IDEAS/HOOKS/GENERATE/REGEN prompts. Returns
 * "" when no profile is selected (the caller's `{BRAND_BLOCK}` slot then
 * collapses to a blank line — matches "if a profile is provided" in the spec).
 */
export function buildBrandBlock(profile: BrandProfileForPrompt | null | undefined): string {
  if (!profile) return "";
  const bannedWords = profile.bannedWords.length > 0 ? profile.bannedWords.join(", ") : "ไม่มี";
  const analysisNotes = profile.analysisNotes?.trim() || "ไม่มี";
  return `ข้อมูลแบรนด์: นิช=${profile.niche} | กลุ่มเป้าหมาย=${profile.audience} | โทนเสียง=${profile.tone}
คำต้องห้าม (ห้ามปรากฏในผลลัพธ์เด็ดขาด): ${bannedWords}
โน้ตสไตล์การเขียนของแบรนด์นี้: ${analysisNotes}`;
}

// ── IDEAS (flash) ────────────────────────────────────────────────────────

/**
 * Continuity block — included only when the profile has saved scripts
 * (`recentTopics` non-empty). `recentTopics` = last 20 Script topics of the
 * selected BrandProfile, newest first (caller loads these, see
 * `getRecentScriptTopics` in src/lib/hero-script.server.ts).
 */
function buildContinuityBlock(recentTopics: string[]): string {
  if (recentTopics.length === 0) return "";
  return `หัวข้อที่ช่องนี้ทำไปแล้วล่าสุด: ${recentTopics.join(", ")}
กติกาความต่อเนื่อง: ห้ามเสนอหัวข้อซ้ำหรือใกล้เคียงกับที่ทำไปแล้ว
และอย่างน้อย 2 จาก 8 หัวข้อต้องเป็นการต่อยอดจากหัวข้อที่ทำไปแล้ว (ภาคต่อ, ซีรีส์, มุมใหม่ของเรื่องเดิม) — ระบุใน angle ว่าต่อยอดจากหัวข้อไหน`;
}

/**
 * IDEAS (flash). `profile` — the selected BrandProfile, or null/undefined
 * when the user picked "ไม่ใช้โปรไฟล์". `recentTopics` — last 20 Script topics
 * of that profile (createdAt desc); pass [] (or omit) when there is no history
 * yet or no profile is selected.
 */
export function buildIdeasPrompt(params: {
  profile?: BrandProfileForPrompt | null;
  recentTopics?: string[];
}): string {
  const brandBlock = buildBrandBlock(params.profile);
  const continuityBlock = buildContinuityBlock(params.recentTopics ?? []);
  return `คุณคือนักวางกลยุทธ์คอนเทนต์ไวรัลสำหรับครีเอเตอร์ไทย
${brandBlock}
${continuityBlock}
คิดหัวข้อคลิปสั้น 8 หัวข้อ ที่ทำให้กลุ่มเป้าหมายนี้ "หยุดนิ้ว"
กติกา: เจาะจง ไม่กว้าง, มี tension หรือประโยชน์ชัดเจน, ไม่เกิน 15 คำต่อหัวข้อ
ตอบเป็น JSON เท่านั้น: {"ideas":[{"topic":"...","angle":"ทำไมหัวข้อนี้น่าจะไวรัล (สั้น ๆ)"}]}`;
}

// ── HOOKS (flash) ────────────────────────────────────────────────────────

/** Renders the full HOOK_FORMULAS list (key + กติกา + ตัวอย่าง) + the shared
 *  HOOK_COMMON_RULES line, for embedding at the top of the HOOKS prompt. */
function renderHookFormulasBlock(): string {
  const lines = HOOK_FORMULAS.map(
    (f, i) => `${i + 1}. ${f.key} — ${f.name}: ${f.rule} — ตัวอย่าง: "${f.example}"`
  );
  return `${lines.join("\n")}\n${HOOK_COMMON_RULES}`;
}

/**
 * HOOKS (flash). `profile` — the selected BrandProfile, or null/undefined.
 */
export function buildHooksPrompt(params: {
  topic: string;
  durationSec: number;
  profile?: BrandProfileForPrompt | null;
}): string {
  const { topic, durationSec, profile } = params;
  const brandBlock = buildBrandBlock(profile);
  return `${renderHookFormulasBlock()}
หัวข้อคลิป: ${topic} (ความยาว ${durationSec} วินาที)
${brandBlock}
เลือกสูตร hook 5 สูตรที่เหมาะกับหัวข้อนี้ที่สุดจากรายการข้างบน แล้วเขียน hook สูตรละ 1 อัน
กติกา: ไม่เกิน 20 คำ, ภาษาพูด, ห้ามคำทักทาย, ตรงโทนเสียงแบรนด์
ตอบเป็น JSON เท่านั้น: {"hooks":[{"formula":"<key>","text":"..."}]}`;
}
