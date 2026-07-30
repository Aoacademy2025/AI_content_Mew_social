// hero-script.server.ts — Hero Script service layer.
//
// Business logic for the "เขียนสคริปต์ AI" feature lives here (not in the
// route handlers) so routes stay thin and this file can be exercised directly
// by scripts/verify-hero-script.ts without going through HTTP/Clerk.
//
// Task 1 ships the BrandProfile slice: bannedWords (de)serialization, the
// plan-cap check, the shared LLM-JSON-with-one-retry helper, and the response
// validators for the two Task-1 routes (analyze, niche-ideas). Script-level
// helpers (assembleScript, containsBannedWord, wordBudgetForDuration,
// countScriptsInWindow, canCreateScript, sendScriptToEditor) are added by
// later Hero Script tasks per the shared spec.

import type { BrandProfile } from "@prisma/client";
import { limitsForPlan, PLAN_LABEL } from "@/lib/plan-limits";
import { geminiGenerateText } from "@/lib/gemini";

// ── bannedWords: stored as a JSON string array on BrandProfile ─────────────

/** Parse the stored `bannedWords` JSON string into a string array. Never throws
 *  — malformed/missing JSON safely yields []. */
export function parseBannedWords(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((w): w is string => typeof w === "string" && w.trim().length > 0);
  } catch {
    return [];
  }
}

/** Serialize a banned-words list back to the stored JSON string form. */
export function serializeBannedWords(words: readonly unknown[] | null | undefined): string {
  if (!words || !Array.isArray(words)) return "[]";
  return JSON.stringify(
    words.filter((w): w is string => typeof w === "string" && w.trim().length > 0)
  );
}

/** API-facing shape: bannedWords as a real array instead of a JSON string. */
export type BrandProfileDTO = Omit<BrandProfile, "bannedWords"> & { bannedWords: string[] };

/** Map a raw BrandProfile row to its API-facing DTO (bannedWords parsed). */
export function toBrandProfileDTO(row: BrandProfile): BrandProfileDTO {
  return { ...row, bannedWords: parseBannedWords(row.bannedWords) };
}

// ── Plan cap: brandProfiles (FREE 1 / PRO 5 / BUSINESS Infinity) ───────────

export interface BrandProfileCapCheck {
  allowed: boolean;
  cap: number;
  plan: string;
  /** Thai upsell message — only set when allowed === false. */
  message?: string;
}

/** brandProfiles plan cap check (Mew decision 2026-07-31: saved-niche count is
 *  a plan feature). Returns the Thai 403 upsell message from the API contracts
 *  table when the user is already at (or over) their cap. */
export function canCreateBrandProfile(plan: string, currentCount: number): BrandProfileCapCheck {
  const cap = limitsForPlan(plan).brandProfiles;
  if (currentCount < cap) return { allowed: true, cap, plan };
  const planLabel = PLAN_LABEL[plan] ?? plan;
  const capLabel = Number.isFinite(cap) ? String(cap) : "ไม่จำกัด";
  return {
    allowed: false,
    cap,
    plan,
    message: `แผน ${planLabel} เซฟนิชได้ ${capLabel} โปรไฟล์ — อัปเกรดเพื่อเพิ่มนิช`,
  };
}

// ── Niche drill-down seed validation (shared: analyze route doesn't use this) ─

export const NICHE_SEED_MAX_CHARS = 300;

export type NicheSeedCheck = { ok: true; seed: string } | { ok: false; message: string };

/** Validate the niche-ideas `seed` input: required, ≤300 chars (trimmed). */
export function validateNicheSeed(seed: unknown): NicheSeedCheck {
  if (typeof seed !== "string" || !seed.trim()) {
    return { ok: false, message: "กรุณาระบุเรื่องที่สนใจ" };
  }
  const trimmed = seed.trim();
  if (trimmed.length > NICHE_SEED_MAX_CHARS) {
    return { ok: false, message: `เรื่องที่สนใจยาวเกินไป (สูงสุด ${NICHE_SEED_MAX_CHARS} ตัวอักษร)` };
  }
  return { ok: true, seed: trimmed };
}

// ── LLM JSON-with-one-retry helper (shared by every Hero Script LLM route) ──

/** Strip ```json fences (matches the codebase's existing convention, e.g.
 *  contents/generate) then JSON.parse. Returns null (never throws) on
 *  malformed JSON so callers can retry/502 uniformly. */
export function parseJsonResponse(raw: string | null | undefined): unknown | null {
  if (!raw) return null;
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/** Call Gemini and validate its JSON response, retrying once on parse/validation
 *  failure (per the API contracts table: "1 retry on parse/validation failure,
 *  then 502"). Returns null when both attempts fail to validate — the caller
 *  is responsible for the 502 `{ error: "AI ตอบผิดรูปแบบ ลองใหม่อีกครั้ง" }`. */
export async function generateValidatedJson<T>(params: {
  apiKey: string;
  prompt: string;
  maxOutputTokens?: number;
  validate: (data: unknown) => T | null;
}): Promise<T | null> {
  const { apiKey, prompt, maxOutputTokens = 2048, validate } = params;
  const attempts = 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const raw = await geminiGenerateText(apiKey, prompt, maxOutputTokens);
    const parsed = parseJsonResponse(raw);
    if (parsed !== null) {
      const validated = validate(parsed);
      if (validated) return validated;
    }
  }
  return null;
}

// ── Response validators (pure — testable without any LLM/DB) ───────────────

export interface AnalyzeResult {
  niche: string;
  audience: string;
  tone: string;
  analysisNotes: string;
}

/** Validate the ANALYZE route's `{niche, audience, tone, analysisNotes}` JSON
 *  contract. All four fields must be non-empty strings. */
export function validateAnalyzeResponse(data: unknown): AnalyzeResult | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const niche = typeof d.niche === "string" ? d.niche.trim() : "";
  const audience = typeof d.audience === "string" ? d.audience.trim() : "";
  const tone = typeof d.tone === "string" ? d.tone.trim() : "";
  const analysisNotes = typeof d.analysisNotes === "string" ? d.analysisNotes.trim() : "";
  if (!niche || !audience || !tone || !analysisNotes) return null;
  return { niche, audience, tone, analysisNotes };
}

export interface NicheIdea {
  niche: string;
  why: string;
  audience: string;
  sampleTopics: [string, string];
}

export interface NicheIdeasResult {
  niches: NicheIdea[];
}

/** Validate the NICHE DRILL-DOWN route's `{niches: [...] x 7}` JSON contract:
 *  exactly 7 items, each with niche/why/audience non-empty strings and
 *  sampleTopics an array of exactly 2 non-empty strings. */
export function validateNicheIdeasResponse(data: unknown): NicheIdeasResult | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.niches) || d.niches.length !== 7) return null;

  const niches: NicheIdea[] = [];
  for (const raw of d.niches) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    const niche = typeof item.niche === "string" ? item.niche.trim() : "";
    const why = typeof item.why === "string" ? item.why.trim() : "";
    const audience = typeof item.audience === "string" ? item.audience.trim() : "";
    if (!niche || !why || !audience) return null;
    if (!Array.isArray(item.sampleTopics) || item.sampleTopics.length !== 2) return null;
    const topics = item.sampleTopics.map((t) => (typeof t === "string" ? t.trim() : ""));
    if (!topics[0] || !topics[1]) return null;
    niches.push({ niche, why, audience, sampleTopics: [topics[0], topics[1]] });
  }
  return { niches };
}
