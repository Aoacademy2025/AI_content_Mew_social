// hero-script.server.ts — Hero Script service layer.
//
// Business logic for the "เขียนสคริปต์ AI" feature lives here (not in the
// route handlers) so routes stay thin and this file can be exercised directly
// by scripts/verify-hero-script.ts without going through HTTP/Clerk.
//
// Task 1 shipped the BrandProfile slice: bannedWords (de)serialization, the
// plan-cap check, the shared LLM-JSON-with-one-retry helper, and the response
// validators for the two Task-1 routes (analyze, niche-ideas). Task 2 adds:
// the shared LLM-triad route helper (resolveLlmTriad — extracted from the
// duplicated checkAiInputCaps/resolveGeminiKey/reserveAiTextCall block in
// analyze + niche-ideas), wordBudgetForDuration, getRecentScriptTopics (the
// IDEAS continuity query), and the ideas/hooks response validators. The
// remaining script-level helpers (assembleScript, containsBannedWord,
// countScriptsInWindow, canCreateScript, sendScriptToEditor) are added by
// later Hero Script tasks per the shared spec.

import type { BrandProfile } from "@prisma/client";
import { limitsForPlan, PLAN_LABEL } from "@/lib/plan-limits";
import { geminiGenerateText } from "@/lib/gemini";
import { prisma } from "@/lib/prisma";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { reserveAiTextCall } from "@/lib/ai-text-limits";
import { checkAiInputCaps } from "@/lib/ai-input-caps";
import { tokenizeWords } from "@/lib/tts-timing";
import { isValidHookFormulaKey } from "@/lib/viral-frameworks";
import { TTS_WORDS_PER_SECOND } from "@/lib/prompts/content-generator";

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

// ── Topic / duration validation (Task 2 — /api/scripts/hooks, /api/scripts/generate) ─

export const TOPIC_MAX_CHARS = 300;

export type TopicCheck = { ok: true; topic: string } | { ok: false; message: string };

/** Validate a user-typed (or idea-card-selected) `topic` input: required,
 *  ≤300 chars (trimmed) — same bound convention as validateNicheSeed. */
export function validateTopic(topic: unknown): TopicCheck {
  if (typeof topic !== "string" || !topic.trim()) {
    return { ok: false, message: "กรุณาระบุหัวข้อคลิป" };
  }
  const trimmed = topic.trim();
  if (trimmed.length > TOPIC_MAX_CHARS) {
    return { ok: false, message: `หัวข้อยาวเกินไป (สูงสุด ${TOPIC_MAX_CHARS} ตัวอักษร)` };
  }
  return { ok: true, topic: trimmed };
}

/** Valid Script durations per the schema comment (`durationSec Int // 30 | 60 | 90`). */
export const VALID_DURATION_SECS = [30, 60, 90] as const;

export function isValidDurationSec(durationSec: unknown): durationSec is 30 | 60 | 90 {
  return typeof durationSec === "number" && (VALID_DURATION_SECS as readonly number[]).includes(durationSec);
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

// ── Shared LLM-triad route helper (Task 2) ──────────────────────────────────
//
// Every Hero Script LLM route runs the same preamble before calling Gemini:
// checkAiInputCaps → look up the user → resolveGeminiKey (409 KEY_REQUIRED on
// failure) → reserveAiTextCall (429 QUOTA_AI_TEXT on failure). This was
// duplicated verbatim in analyze/route.ts and niche-ideas/route.ts; extracted
// here so routes stay a single `if (!triad.ok) return NextResponse.json(...)`
// line and new routes (ideas, hooks, …) can't drift from the pattern.

export type LlmInputCapsInput = Parameters<typeof checkAiInputCaps>[0];

export type LlmTriadResult =
  | { ok: true; apiKey: string; geminiMode: "managed" | "byok" }
  | { ok: false; status: number; body: Record<string, unknown> };

/** Run the shared checkAiInputCaps → resolveGeminiKey → reserveAiTextCall
 *  preamble for `userId`. `inputCapsInput` is whatever the caller is about to
 *  send to Gemini (script text / scenes / words — see checkAiInputCaps). On
 *  success returns the resolved API key + mode; on failure returns the exact
 *  { status, body } the route should respond with (byte-identical to what
 *  analyze/niche-ideas returned inline before this was extracted). */
export async function resolveLlmTriad(
  userId: string,
  inputCapsInput: LlmInputCapsInput
): Promise<LlmTriadResult> {
  const inputCaps = checkAiInputCaps(inputCapsInput);
  if (!inputCaps.ok) return { ok: false, status: 400, body: { error: inputCaps.message } };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { geminiKey: true, plan: true },
  });
  if (!user) return { ok: false, status: 404, body: { error: "User not found" } };

  let apiKey: string;
  let geminiMode: "managed" | "byok";
  try {
    const resolved = resolveGeminiKey(user);
    apiKey = resolved.key;
    geminiMode = resolved.mode;
  } catch (e) {
    if (e instanceof KeyRequiredError) {
      return { ok: false, status: 409, body: { code: "KEY_REQUIRED", action: "/settings?tab=api-keys" } };
    }
    throw e;
  }

  // H1: bound managed-key text-LLM call frequency (BYOK → no-op, byte-identical).
  const textReserve = await reserveAiTextCall(userId, { enforce: geminiMode === "managed" });
  if (!textReserve.allowed) {
    return { ok: false, status: 429, body: { code: "QUOTA_AI_TEXT", message: textReserve.message } };
  }

  return { ok: true, apiKey, geminiMode };
}

// ── Word budget (Task 2) ────────────────────────────────────────────────────

/** Target word count for a script of `durationSec` — durationSec × TTS pacing
 *  (reuses content-generator.ts's TTS_WORDS_PER_SECOND, the same ~4 words/sec
 *  figure its own videoPacing table is built on — do NOT invent a second
 *  pacing table here). The GENERATE prompt applies the spec's ±15% tolerance
 *  around this figure; this function returns the center value. */
export function wordBudgetForDuration(durationSec: number): number {
  return Math.round(durationSec * TTS_WORDS_PER_SECOND);
}

// ── Continuity query (Task 2 — IDEAS prompt's CONTINUITY_BLOCK) ────────────

/** Last `limit` Script topics of `brandProfileId` (owned by `userId`), newest
 *  first — fed into buildIdeasPrompt's `recentTopics` so the IDEAS prompt can
 *  enforce "no repeats + propose continuations/series". Returns [] when the
 *  profile has no saved scripts yet (buildIdeasPrompt then omits the
 *  continuity block entirely, per spec). */
export async function getRecentScriptTopics(
  userId: string,
  brandProfileId: string,
  limit = 20
): Promise<string[]> {
  const rows = await prisma.script.findMany({
    where: { userId, brandProfileId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { topic: true },
  });
  return rows.map((r) => r.topic);
}

// ── IDEAS response validator (Task 2) ───────────────────────────────────────

export interface ScriptIdea {
  topic: string;
  angle: string;
}

export interface IdeasResult {
  ideas: ScriptIdea[];
}

/** Validate the IDEAS route's `{ideas: [...] x 8}` JSON contract: exactly 8
 *  items, each with non-empty topic/angle strings. */
export function validateIdeasResponse(data: unknown): IdeasResult | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.ideas) || d.ideas.length !== 8) return null;

  const ideas: ScriptIdea[] = [];
  for (const raw of d.ideas) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    const topic = typeof item.topic === "string" ? item.topic.trim() : "";
    const angle = typeof item.angle === "string" ? item.angle.trim() : "";
    if (!topic || !angle) return null;
    ideas.push({ topic, angle });
  }
  return { ideas };
}

// ── HOOKS response validator (Task 2) ───────────────────────────────────────

export interface HookChoice {
  formula: string;
  text: string;
}

export interface HooksResult {
  hooks: HookChoice[];
}

/** Word count for a Thai/mixed hook line — reuses tts-timing.ts's
 *  Thai-aware tokenizer (Intl.Segmenter + loanword-boundary correction; falls
 *  back to whitespace splitting when Intl.Segmenter is unavailable) instead of
 *  a naive `.split(" ")`, since Thai text doesn't reliably space-delimit words. */
export function countWords(text: string): number {
  return tokenizeWords(text).length;
}

/** Validate the HOOKS route's `{hooks: [...] x 5}` JSON contract: exactly 5
 *  items, each a valid ∈ HOOK_FORMULAS key, all 5 formula keys DISTINCT, text
 *  non-empty and ≤ 20 คำ. */
export function validateHooksResponse(data: unknown): HooksResult | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.hooks) || d.hooks.length !== 5) return null;

  const hooks: HookChoice[] = [];
  const seenFormulas = new Set<string>();
  for (const raw of d.hooks) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    const formula = typeof item.formula === "string" ? item.formula.trim() : "";
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!formula || !text) return null;
    if (!isValidHookFormulaKey(formula)) return null;
    if (seenFormulas.has(formula)) return null; // must be 5 DISTINCT formula keys
    if (countWords(text) > 20) return null;
    seenFormulas.add(formula);
    hooks.push({ formula, text });
  }
  return { hooks };
}
