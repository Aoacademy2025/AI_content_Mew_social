// hero-script.ts — prompt builders for Hero Script (viral script writer).
//
// Task 1 ships only the ANALYZE and NICHE DRILL-DOWN builders (used by
// /api/brand-profiles/analyze and /api/brand-profiles/niche-ideas). The
// remaining builders (IDEAS/HOOKS/GENERATE/REGEN + the shared BRAND_BLOCK) are
// added by later Hero Script tasks per the shared spec — do not add stubs for
// them here so unused-export lint doesn't drift ahead of their real callers.
//
// Copy is verbatim from `.superpowers/sdd/2026-07-31-hero-script-v1/shared-spec.md`
// ("Prompt copy" section). The only non-verbatim addition is the literal
// insertion point for the caller-supplied sample text in buildAnalyzePrompt —
// the spec states the instruction copy but does not show a `{...}` marker for
// where the sample itself goes (unlike the other builders), so it is embedded
// between the instruction line and the JSON-contract line, delimited the same
// way the codebase's other analyze prompts (e.g. styles/analyze) embed samples.

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
