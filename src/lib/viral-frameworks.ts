// viral-frameworks.ts — the Hero Script "Viral Framework Library" (product copy).
//
// Curated by session model; approved by Mew at plan approval
// (.superpowers/sdd/2026-07-31-hero-script-v1/shared-spec.md, "The Viral
// Framework Library" section). Every Thai string in this file is copied
// VERBATIM from that spec — do not paraphrase or "improve" the copy here;
// file an issue against the plan doc instead.
//
// Consumers: src/lib/prompts/hero-script.ts (HOOKS prompt embeds HOOK_FORMULAS
// + HOOK_COMMON_RULES; GENERATE/REGEN prompts — later tasks — embed
// STORY_STRUCTURES + RETENTION_RULES + CTA_STYLES), src/lib/hero-script.server.ts
// (hooks-response validator uses HOOK_FORMULA_KEYS), and the BrandProfile
// create/edit dialog (CTA style picker).

export interface HookFormula {
  key: string;
  /** ชื่อไทย */
  name: string;
  /** กติกา — the per-formula rule/description. */
  rule: string;
  /** ตัวอย่าง — one example hook line. */
  example: string;
}

export const HOOK_FORMULAS: HookFormula[] = [
  {
    key: "curiosity-gap",
    name: "เปิดช่องว่างความอยากรู้",
    rule: "บอกผลลัพธ์หรือปมที่น่าสนใจ แต่ยังไม่เฉลยวิธี/เหตุผล",
    example: "รู้ไหมทำไมร้านนี้ขายแพงกว่าคู่แข่ง 3 เท่า แต่คิวยาวกว่า",
  },
  {
    key: "contrarian",
    name: "ขัดความเชื่อ",
    rule: "ปฏิเสธสิ่งที่กลุ่มเป้าหมายเชื่อกันทั่วไปอย่างมั่นใจ",
    example: "เลิกตื่นตี 5 เถอะ ถ้าอยากงานเสร็จเยอะขึ้น",
  },
  {
    key: "shock-number",
    name: "ตัวเลขช็อค",
    rule: "นำด้วยตัวเลขที่เกินความคาดหมายและเจาะจง",
    example: "ผมเปลี่ยน 500 บาทเป็น 50,000 ใน 30 วัน ด้วยของที่ทุกบ้านมี",
  },
  {
    key: "direct-callout",
    name: "เรียกกลุ่มเป้าหมายตรง ๆ",
    rule: "ระบุตัวคนดูให้รู้ว่า \"คลิปนี้พูดกับฉัน\"",
    example: "ใครที่ลงคลิปทุกวันแต่ยอดวิวไม่ขยับ ฟังทางนี้",
  },
  {
    key: "mistake-warning",
    name: "เตือนความผิดพลาด",
    rule: "ชี้ว่าคนดูกำลังทำพลาดโดยไม่รู้ตัว",
    example: "3 อย่างที่คุณทำผิดทุกครั้งที่ตั้งชื่อคลิป",
  },
  {
    key: "pov-story",
    name: "เล่าเรื่องจากประสบการณ์",
    rule: "เปิดกลางเหตุการณ์ ไม่มีอารัมภบท",
    example: "วันที่ลูกค้ารายใหญ่ที่สุดเทผม คือวันที่ผมได้บทเรียนแพงที่สุดในชีวิต",
  },
  {
    key: "secret-reveal",
    name: "เปิดเผยความลับวงใน",
    rule: "สัญญาว่าจะบอกสิ่งที่คนในวงการไม่พูด",
    example: "สิ่งที่เอเจนซี่ไม่เคยบอกคุณ ตอนคิดค่ายิงแอด",
  },
  {
    key: "before-after",
    name: "ก่อน-หลัง",
    rule: "โชว์การเปลี่ยนแปลงสุดขั้วก่อนเล่าวิธี",
    example: "จากพูดหน้ากล้องไม่เป็น สู่ครีเอเตอร์แสนฟอลใน 6 เดือน",
  },
  {
    key: "challenge-timer",
    name: "ท้าพิสูจน์ในเวลาจำกัด",
    rule: "ผูกสัญญากับเวลาของคลิป",
    example: "ให้เวลาผม 60 วินาที จะทำให้คุณเลิกกลัวกล้องตลอดไป",
  },
  {
    key: "question-poll",
    name: "คำถามที่ทุกคนมีคำตอบในใจ",
    rule: "คำถามที่คนดูอยากตอบ/อยากรู้คำตอบของคนอื่น",
    example: "ถ้ามีเงินเก็บ 10,000 แรกในชีวิต คุณจะเอาไปทำอะไร",
  },
];

/** Set of valid HOOK_FORMULAS keys — O(1) membership check for the hooks-response validator. */
export const HOOK_FORMULA_KEYS: ReadonlySet<string> = new Set(HOOK_FORMULAS.map((f) => f.key));

export function isValidHookFormulaKey(key: string): boolean {
  return HOOK_FORMULA_KEYS.has(key);
}

export function getHookFormula(key: string): HookFormula | undefined {
  return HOOK_FORMULAS.find((f) => f.key === key);
}

/** กติการ่วมของทุก hook (applies on top of each formula's own rule). */
export const HOOK_COMMON_RULES =
  "กติการ่วมของทุก hook: ยาวไม่เกิน 20 คำ (พูดจบใน ~5 วินาที), ห้ามขึ้นต้นด้วยคำทักทาย, ภาษาพูด, เจาะจงไม่กว้าง";

export interface StoryStructure {
  key: string;
  /** ชื่อไทย */
  name: string;
  /** โครง — the beat-by-beat structure. */
  structure: string;
}

export const STORY_STRUCTURES: StoryStructure[] = [
  {
    key: "list",
    name: "ลิสต์",
    structure: "Hook → ข้อ 1..N (เก็บข้อเด็ดสุดไว้ท้าย พูดว่า \"ข้อสุดท้ายสำคัญสุด\") → CTA",
  },
  {
    key: "pas",
    name: "ปัญหา-ขยี้-ทางออก",
    structure: "ปัญหาที่คนดูเจอ → ขยี้ผลเสียให้เห็นภาพ → ทางออกทีละขั้น → CTA",
  },
  {
    key: "story-lesson",
    name: "เรื่องเล่า-บทเรียน",
    structure: "เหตุการณ์จริง (เปิดกลางเรื่อง) → จุดพลิก → บทเรียนที่ใช้ได้ทันที → CTA",
  },
  {
    key: "how-to",
    name: "สอนทำ",
    structure: "ผลลัพธ์ที่จะได้ → ขั้นตอน 1-2-3 → จุดที่คนมักพลาด → CTA",
  },
  {
    key: "myth-bust",
    name: "ล้างความเชื่อผิด",
    structure: "ความเชื่อที่คนส่วนใหญ่ยึด → ทำไมมันผิด (เหตุผล/หลักฐาน) → สิ่งที่ควรทำแทน → CTA",
  },
];

export const STORY_STRUCTURE_KEYS: ReadonlySet<string> = new Set(STORY_STRUCTURES.map((s) => s.key));

export function isValidStoryStructureKey(key: string): boolean {
  return STORY_STRUCTURE_KEYS.has(key);
}

export function getStoryStructure(key: string): StoryStructure | undefined {
  return STORY_STRUCTURES.find((s) => s.key === key);
}

/** RETENTION_RULES — injected into every generate prompt (GENERATE/REGEN). */
export const RETENTION_RULES: string[] = [
  "ประโยคสั้น ภาษาพูด ~4 คำ/วินาที; 1 บรรทัด = 1 ประโยคที่พูดจริง",
  "ทุก 3–5 วินาทีต้องมีเหตุผลให้ดูต่อ (open loop, คำถามค้าง, \"เดี๋ยวข้อต่อไปหนักกว่า\")",
  "ห้ามอารัมภบททุกชนิด (\"สวัสดีครับ วันนี้เราจะมาพูดถึง…\" = ห้าม) — ประโยคแรกคือ hook เสมอ",
  "ใช้คำที่กลุ่มเป้าหมาย (audience) ใช้จริง หลีกเลี่ยงภาษาทางการ/ภาษาเขียน",
  "CTA เดียว ชัดเจน ไม่เกิน 2 ประโยค ตามสไตล์ที่แบรนด์เลือก",
];

export interface CtaStyleDef {
  key: string;
  /** สั้น ๆ ก่อนเครื่องหมายจุดคู่ — used as the picker label. */
  label: string;
  /** ส่วนคำอธิบาย + ตัวอย่างที่ตามหลังเครื่องหมายจุดคู่. */
  description: string;
}

export const CTA_STYLES: CtaStyleDef[] = [
  {
    key: "follow",
    label: "ฝากติดตาม",
    description: "ผูกกับคุณค่าตอนต่อไป (\"ตามไว้ เดี๋ยวพาร์ทสองเจ็บกว่านี้\")",
  },
  {
    key: "comment",
    label: "ชวนคอมเมนต์",
    description: "ถามคำถามที่ตอบง่ายและอยากอวด (\"คุณทีมตื่นเช้าหรือทีมนอนดึก คอมเมนต์บอกหน่อย\")",
  },
  {
    key: "share",
    label: "ชวนแชร์/เซฟ",
    description: "ระบุคนที่ควรได้เห็น (\"เซฟไว้ก่อนหาย แล้วส่งให้เพื่อนที่กำลังท้อ\")",
  },
  {
    key: "sell",
    label: "ขายแบบเนียน",
    description: "สะพานจากเนื้อหาไปสินค้า/บริการ ไม่ hard sell (\"ถ้าอยากได้ตัวช่วย ผมทิ้งลิงก์ไว้ให้ใต้คลิป\")",
  },
];

export const CTA_STYLE_KEYS: ReadonlySet<string> = new Set(CTA_STYLES.map((c) => c.key));

export function isValidCtaStyleKey(key: string): boolean {
  return CTA_STYLE_KEYS.has(key);
}

export function getCtaStyle(key: string): CtaStyleDef | undefined {
  return CTA_STYLES.find((c) => c.key === key);
}
