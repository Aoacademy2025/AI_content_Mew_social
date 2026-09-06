// hero-script.ts — prompt builders for Hero Script (viral script writer).
//
// Task 1 shipped the ANALYZE and NICHE DRILL-DOWN builders (used by
// /api/brand-profiles/analyze and /api/brand-profiles/niche-ideas). Task 2
// adds the shared BRAND_BLOCK builder plus the IDEAS and HOOKS builders (used
// by /api/scripts/ideas and /api/scripts/hooks). Task 3 adds the GENERATE and
// REGEN builders (used by /api/scripts/generate and /api/scripts/regen-section)
// plus the banned-words retry note.
//
// Original copy comes from the Hero Script v1 shared spec. The duration target
// and bounded correction were revised after measured narration exceeded the
// selected length; see docs/audits/2026-09-06-hero-script-duration.md.

import {
  HOOK_FORMULAS,
  HOOK_COMMON_RULES,
  STORY_STRUCTURES,
  RETENTION_RULES,
  getCtaStyle,
} from "@/lib/viral-frameworks";
import { scriptWordRange } from "@/lib/hero-script-duration";

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

// ── GENERATE / REGEN (pro) ────────────────────────────────────────────────
//
// Both prompts open with the same three context blocks the spec calls for
// ("include STORY_STRUCTURES + RETENTION_RULES + CTA style ที่เลือก"), then the
// per-prompt instructions. The framework blocks
// are rendered from src/lib/viral-frameworks.ts so the product copy has exactly
// one home.

/** โครงเรื่อง list (key + ชื่อไทย + โครง) for the model to choose from. */
function renderStoryStructuresBlock(): string {
  const lines = STORY_STRUCTURES.map(
    (s, i) => `${i + 1}. ${s.key} — ${s.name}: ${s.structure}`
  );
  return `โครงเรื่องที่เลือกได้:\n${lines.join("\n")}`;
}

/** RETENTION_RULES — labelled so the instruction copy ("ทำตาม RETENTION_RULES
 *  ทุกข้อ") refers to something the model can actually see. */
function renderRetentionRulesBlock(): string {
  return `RETENTION_RULES (ทำตามทุกข้อ):\n${RETENTION_RULES.map((r) => `- ${r}`).join("\n")}`;
}

/** The selected CTA style, rendered key + ชื่อไทย + คำอธิบาย/ตัวอย่าง. Unknown
 *  keys fall back to the stored key itself (a profile row could hold anything). */
function renderCtaStyleBlock(ctaStyle: string): string {
  const style = getCtaStyle(ctaStyle);
  if (!style) return `สไตล์ CTA ที่เลือก: ${ctaStyle}`;
  return `สไตล์ CTA ที่เลือก: ${style.key} — ${style.label}: ${style.description}`;
}

/** ชื่อไทย of a CTA style — what gets interpolated into the spec's
 *  "{ctaStyle}" slots, so the model reads product copy instead of a machine
 *  key (the key itself is right above it in the CTA style block). */
function ctaStyleLabel(ctaStyle: string): string {
  return getCtaStyle(ctaStyle)?.label ?? ctaStyle;
}

/** Shared opening context for GENERATE/REGEN. */
function buildScriptContext(params: {
  topic: string;
  durationSec: number;
  wordBudget: number;
  ctaStyle: string;
  profile?: BrandProfileForPrompt | null;
}): string {
  const { topic, durationSec, wordBudget, ctaStyle, profile } = params;
  const range = scriptWordRange(wordBudget);
  return `${renderStoryStructuresBlock()}
${renderRetentionRulesBlock()}
${renderCtaStyleBlock(ctaStyle)}
หัวข้อคลิป: ${topic} | เป้าหมายความยาว ${durationSec} วินาที (±10%) | งบคำทั้งคลิป ~${wordBudget} คำ รวม hook+body+cta (${range.min}–${range.max} คำ)
เผื่อเวลาพูดและหยุดหายใจด้วย ใช้ประโยคสมบูรณ์ กระชับ ไม่แยกทุกวลีสั้นเป็นคนละบรรทัด
${buildBrandBlock(profile)}`;
}

/**
 * GENERATE (pro). `hookText` is the hook the user picked in step 3 — it is
 * embedded verbatim and the model is told never to touch it; the server
 * reattaches the user's own copy afterwards regardless of what comes back
 * (the response contract has no hook field at all).
 */
export function buildGeneratePrompt(params: {
  topic: string;
  durationSec: number;
  wordBudget: number;
  hookText: string;
  ctaStyle: string;
  profile?: BrandProfileForPrompt | null;
}): string {
  const { hookText, ctaStyle } = params;
  return `${buildScriptContext(params)}
Hook ที่ผู้ใช้เลือก (ห้ามแก้แม้แต่คำเดียว จะถูกใช้เป็นบรรทัดแรกเสมอ): "${hookText}"
เลือกโครงเรื่องที่เหมาะที่สุด 1 โครงจากรายการข้างบน แล้วเขียนเนื้อหา (body) ต่อจาก hook และปิดด้วย CTA สไตล์ ${ctaStyleLabel(ctaStyle)}
กติกา body: 1 บรรทัด = 1 ประโยคที่พูดจริง, ทำตาม RETENTION_RULES ทุกข้อ, งบคำรวม (hook+body+cta) อยู่ในกรอบ
นับ Hook ที่เลือกไว้ในงบก่อน แล้วใช้คำที่เหลือสำหรับ body และ CTA อย่าเติมรายละเอียดหรือ open loop จนเกินเวลา
ตอบเป็น JSON เท่านั้น: {"structure":"<key>","bodyText":"บรรทัดละประโยค\\nคั่นด้วย \\\\n","ctaText":"..."}`;
}

/** The current script, so a regenerate knows what it must differ from. */
function renderCurrentScriptBlock(current: { hookText: string; bodyText: string; ctaText: string }): string {
  return `สคริปต์ปัจจุบัน:
Hook: ${current.hookText}
เนื้อหา:
${current.bodyText}
CTA: ${current.ctaText}`;
}

/**
 * REGEN (pro) — same context as GENERATE plus the current script, then the
 * spec's per-target instruction. For target="hook" the full HOOK_FORMULAS list
 * is included so the model can pick a *different* valid formula key (the
 * server re-validates that it really is different — see validateRegenResponse).
 */
export function buildRegenPrompt(params: {
  target: "hook" | "body" | "cta";
  topic: string;
  durationSec: number;
  wordBudget: number;
  current: { hookText: string; bodyText: string; ctaText: string };
  ctaStyle: string;
  currentFormula?: string | null;
  profile?: BrandProfileForPrompt | null;
}): string {
  const { target, current, ctaStyle, currentFormula } = params;
  const context = buildScriptContext(params);

  if (target === "hook") {
    return `${context}
${renderHookFormulasBlock()}
${renderCurrentScriptBlock(current)}
เขียน hook ใหม่ 1 อันจากสูตรอื่นที่ไม่ใช่ ${currentFormula ?? "สูตรเดิม"}
ตอบเป็น JSON เท่านั้น: {"text":"...","formula":"<key>"}`;
  }

  const instruction =
    target === "body"
      ? "เขียน body ใหม่ให้ต่างจากเดิมชัดเจน โดยคง hook และ CTA เดิม"
      : `เขียน CTA ใหม่สไตล์ ${ctaStyleLabel(ctaStyle)} ให้ต่างจากเดิม`;

  return `${context}
${renderCurrentScriptBlock(current)}
${instruction}
ตอบเป็น JSON เท่านั้น: {"text":"..."}`;
}

// ── Banned-words retry note ───────────────────────────────────────────────

/**
 * Stern addition appended to the prompt for the ONE retry the banned-words
 * guard is allowed (shared spec: "on hit → 1 retry with a stern addition to
 * the prompt"). The spec states the rule and the user-facing warning copy but
 * not this prompt-internal wording, so it is written here in the same register
 * as the rest of the prompt copy. Returns "" when there is nothing to warn
 * about, so callers can append it unconditionally.
 */
export function buildBannedWordRetryNote(bannedWords: readonly string[]): string {
  const words = bannedWords.map((w) => w.trim()).filter(Boolean);
  if (words.length === 0) return "";
  return `\nคำเตือนสำคัญ: ผลลัพธ์ครั้งก่อนมีคำต้องห้ามหลุดมา ห้ามใช้คำเหล่านี้หรือรูปแปรของมันเด็ดขาดแม้แต่คำเดียว: ${words.join(", ")}
เขียนใหม่เฉพาะส่วนที่ขอโดยเลี่ยงคำเหล่านี้ และตรวจซ้ำก่อนตอบ`;
}

export function buildScriptLengthRetryNote(params: {
  words: number;
  wordBudget: number;
  durationSec: number;
  editableText: string;
  editableWords: number;
}): string {
  const range = scriptWordRange(params.wordBudget);
  const fixedWords = Math.max(0, params.words - params.editableWords);
  const editableBudget = Math.max(0, params.wordBudget - fixedWords);
  const change = editableBudget < params.editableWords ? "ลด" : "เพิ่ม";
  const percent = Math.round(Math.abs(editableBudget - params.editableWords) / Math.max(1, params.editableWords) * 100);
  return `\nผลก่อนหน้ารวมทุกส่วนได้ ${params.words} คำ จากตัวนับคำภาษาไทยของระบบ สำหรับเป้าหมาย ${params.durationSec} วินาที
ส่วนที่คงเดิมใช้ ${fixedWords} คำ จึงเหลืองบส่วนที่แก้ได้ประมาณ ${editableBudget} คำ จากเดิม ${params.editableWords} คำ: ${change}เนื้อหาส่วนนี้ประมาณ ${percent}%
ถ้าต้องลด ให้ตัดรายละเอียดรองและรวมประโยค ไม่ใช่แค่เปลี่ยนคำพ้องความหมาย
ปรับเฉพาะส่วนที่คำขอให้เขียนใหม่ ให้ทั้งสคริปต์ใกล้ ${params.wordBudget} คำ (${range.min}–${range.max} คำ) รวมส่วนเดิมที่ห้ามแก้แล้ว
รักษาใจความและข้อเท็จจริง ใช้ประโยคพูดที่สมบูรณ์ ไม่ตัดกลางคำหรือเติมคำซ้ำเพื่อให้ครบงบ คงส่วนที่ไม่ได้ขอแก้ตามเดิม
ข้อความจากผลก่อนหน้าที่แก้ได้:
${params.editableText}
ตอบด้วย JSON รูปแบบเดิมเท่านั้น`;
}

/** Several complete lengths in one correction call let the server use its
 * real Thai tokenizer to select an answer, rather than trusting model counts. */
export function buildScriptCorrectionOptionsNote(wordBudget: number): string {
  const budgets = [0.7, 0.85, 1].map((scale) => Math.round(wordBudget * scale));
  return `\nสำหรับการแก้รอบนี้ ให้ส่ง 3 ฉบับที่เล่าใจความครบ แต่ต่างกันด้านปริมาณรายละเอียดอย่างชัดเจน
จำนวนคำรวมทั้งคลิปของแต่ละฉบับ: ${budgets.join(" / ")} คำ รวมส่วนเดิมที่ห้ามแก้แล้ว
ใช้เป้าของแต่ละฉบับนี้ในการแก้รอบนี้ ระบบจะนับคำจริงและเลือกฉบับที่ใกล้เป้าหมายเวลาที่สุด
ทุกฉบับต้องรักษาส่วนที่ห้ามแก้ ข้อเท็จจริง และบทสรุป ไม่ตัดกลางประโยคหรือเติมคำซ้ำ
อย่าใส่ชื่อฉบับ ตัวเลขงบ หรือข้อมูลการนับคำในข้อความพูด
แทนที่รูปแบบ JSON ก่อนหน้า ให้ตอบอ็อบเจ็กต์ที่มีคีย์ candidates เป็นอาร์เรย์ 3 รายการ แต่ละรายการใช้รูปแบบผลลัพธ์ JSON เดิมทุกฟิลด์`;
}
