// brand-profile-limits.ts — length caps for the user-editable BrandProfile fields.
//
// Why these exist: every stored BrandProfile field is rendered by
// buildBrandBlock (src/lib/prompts/hero-script.ts) into EVERY Hero Script LLM
// prompt (ideas / hooks / generate / regen), but a profile WRITE never passes
// through checkAiInputCaps — that guard bounds the per-request script/scenes
// payload, not the rows a prompt is later built from. Without a cap here, one
// save of a megabyte-long `tone` becomes a permanent per-call token-spend
// amplifier on the managed server key (and a cheap DoS: the rows are saved once
// and re-read on every call). These caps close that door at the write boundary.
//
// Framework-free and prisma-free on purpose: the two brand-profile routes, the
// client dialog (which truncates its analyze sample to the same bound) and
// scripts/verify-hero-script.ts all import this module directly.

export const BRAND_PROFILE_CAPS = {
  /** name / niche / tone — same 300-char bound as validateTopic / validateNicheSeed. */
  shortFieldChars: 300,
  /** audience — its own wider bound: audience descriptions run long, 500 was
   *  the /brands bound before wave 0, and a production check found 10 rows
   *  between 301 and 411 chars (Mew's decision, 2026-09-02). */
  audienceChars: 500,
  /** analysisNotes / sampleText — the analyze route's own 4,000-char truncation. */
  longFieldChars: 4000,
  /** sampleUrl — the practical URL length bound (IE/CDN de-facto limit). */
  urlChars: 2048,
  /** bannedWords list length … */
  bannedWords: 20,
  /** … and per-word length (they are joined into the brand block). */
  bannedWordChars: 50,
} as const;

export type BrandProfileFieldCheck = { ok: true } | { ok: false; message: string };

/** The exact values a route is about to PERSIST (already trimmed/normalized by
 *  the caller where it trims), so the check measures what actually gets stored.
 *  Anything absent — or not a string / not an array — is skipped here: presence
 *  and type are the routes' own required-field checks. */
export interface BrandProfileFieldInput {
  name?: unknown;
  niche?: unknown;
  audience?: unknown;
  tone?: unknown;
  analysisNotes?: unknown;
  sampleText?: unknown;
  sampleUrl?: unknown;
  bannedWords?: unknown;
}

/** Thai label + cap per field, in the order they are validated (so the message
 *  a user gets for a multi-field overflow is deterministic). */
const FIELD_RULES: readonly { key: keyof BrandProfileFieldInput; label: string; max: number }[] = [
  { key: "name", label: "ชื่อโปรไฟล์", max: BRAND_PROFILE_CAPS.shortFieldChars },
  { key: "niche", label: "นิช", max: BRAND_PROFILE_CAPS.shortFieldChars },
  { key: "audience", label: "กลุ่มเป้าหมาย", max: BRAND_PROFILE_CAPS.audienceChars },
  { key: "tone", label: "โทนเสียง", max: BRAND_PROFILE_CAPS.shortFieldChars },
  { key: "analysisNotes", label: "โน้ตสไตล์การเขียน", max: BRAND_PROFILE_CAPS.longFieldChars },
  { key: "sampleText", label: "ข้อความตัวอย่าง", max: BRAND_PROFILE_CAPS.longFieldChars },
  { key: "sampleUrl", label: "URL ตัวอย่าง", max: BRAND_PROFILE_CAPS.urlChars },
];

/** Enforce the caps above. Returns the Thai 400 message for the FIRST field
 *  that overflows (same "กรุณาระบุ…" register as the routes' other validation
 *  copy), or { ok: true } when everything is inside its bound. */
export function checkBrandProfileFieldLimits(input: BrandProfileFieldInput): BrandProfileFieldCheck {
  for (const rule of FIELD_RULES) {
    const value = input[rule.key];
    if (typeof value !== "string") continue;
    if (value.length > rule.max) {
      return { ok: false, message: `กรุณาระบุ${rule.label}ให้สั้นลง (สูงสุด ${rule.max.toLocaleString()} ตัวอักษร)` };
    }
  }

  if (Array.isArray(input.bannedWords)) {
    if (input.bannedWords.length > BRAND_PROFILE_CAPS.bannedWords) {
      return { ok: false, message: `กรุณาระบุคำต้องห้ามไม่เกิน ${BRAND_PROFILE_CAPS.bannedWords} คำ` };
    }
    for (const word of input.bannedWords) {
      if (typeof word === "string" && word.length > BRAND_PROFILE_CAPS.bannedWordChars) {
        return {
          ok: false,
          message: `กรุณาระบุคำต้องห้ามแต่ละคำไม่เกิน ${BRAND_PROFILE_CAPS.bannedWordChars} ตัวอักษร`,
        };
      }
    }
  }

  return { ok: true };
}
