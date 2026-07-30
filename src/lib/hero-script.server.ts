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
// IDEAS continuity query), and the ideas/hooks response validators. Task 3
// adds the full-script engine's service layer: model-tier resolution
// (heroScriptModel), assembleScript, the banned-words guard
// (containsBannedWord / generateWithBannedWordGuard), the GENERATE/REGEN
// response validators, and Script persistence (create/list/get/update/delete,
// every query scoped to the owning user). The plan-cap + send-to-editor
// helpers (countScriptsInWindow, canCreateScript, sendScriptToEditor) belong
// to Task 4 per the shared spec.

import type { BrandProfile } from "@prisma/client";
import { limitsForPlan, PLAN_LABEL } from "@/lib/plan-limits";
import { geminiGenerateText } from "@/lib/gemini";
import { prisma } from "@/lib/prisma";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { reserveAiTextCall } from "@/lib/ai-text-limits";
import { checkAiInputCaps } from "@/lib/ai-input-caps";
import { tokenizeWords } from "@/lib/tts-timing";
import { isValidHookFormulaKey, isValidStoryStructureKey } from "@/lib/viral-frameworks";
import { TTS_WORDS_PER_SECOND } from "@/lib/prompts/content-generator";
import { buildBannedWordRetryNote } from "@/lib/prompts/hero-script";

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

// ── Model tiers (spec Global Constraints) ──────────────────────────────────
//
// hooks/ideas/analyze run on the FAST model; full-script generate + section
// regenerate run on the PRO model. Both ids are env-overridable so prod can
// move to a newer model without a code change.

export const HERO_SCRIPT_MODEL_FAST_DEFAULT = "gemini-2.5-flash";
export const HERO_SCRIPT_MODEL_PRO_DEFAULT = "gemini-2.5-pro";

/** Minimum thinking budget for the pro tier. Pro-tier Gemini models are
 *  thinking-only and reject a 0 budget outright (see GeminiTextOptions in
 *  src/lib/gemini.ts); 128 is the smallest accepted value, which keeps both
 *  latency and the thought-token share of maxOutputTokens small. Flash-tier
 *  calls keep thinking fully disabled (budget 0), unchanged. */
export const HERO_SCRIPT_PRO_THINKING_BUDGET = 128;

export type HeroScriptModelTier = "fast" | "pro";

/** Resolve the Gemini model id for a Hero Script tier from the environment
 *  (`HERO_SCRIPT_MODEL_FAST` / `HERO_SCRIPT_MODEL_PRO`), falling back to the
 *  spec's defaults. */
export function heroScriptModel(tier: HeroScriptModelTier): string {
  const raw = tier === "pro" ? process.env.HERO_SCRIPT_MODEL_PRO : process.env.HERO_SCRIPT_MODEL_FAST;
  const fallback = tier === "pro" ? HERO_SCRIPT_MODEL_PRO_DEFAULT : HERO_SCRIPT_MODEL_FAST_DEFAULT;
  return raw?.trim() || fallback;
}

/** Call Gemini and validate its JSON response, retrying once on parse/validation
 *  failure (per the API contracts table: "1 retry on parse/validation failure,
 *  then 502"). Returns null when both attempts fail to validate — the caller
 *  is responsible for the 502 `{ error: "AI ตอบผิดรูปแบบ ลองใหม่อีกครั้ง" }`.
 *
 *  `tier` picks the model + thinking config: "fast" (default — the ideas/hooks/
 *  analyze routes) or "pro" (full-script generate + section regenerate). */
export async function generateValidatedJson<T>(params: {
  apiKey: string;
  prompt: string;
  maxOutputTokens?: number;
  tier?: HeroScriptModelTier;
  validate: (data: unknown) => T | null;
}): Promise<T | null> {
  const { apiKey, prompt, maxOutputTokens = 2048, tier = "fast", validate } = params;
  const model = heroScriptModel(tier);
  const thinkingBudget = tier === "pro" ? HERO_SCRIPT_PRO_THINKING_BUDGET : 0;
  const attempts = 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const raw = await geminiGenerateText(apiKey, prompt, maxOutputTokens, 0, { model, thinkingBudget });
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

/** Max words in a hook line — "ยาวไม่เกิน 20 คำ" (HOOK_COMMON_RULES). Enforced
 *  on both the HOOKS route and the hook target of regen-section. */
export const HOOK_MAX_WORDS = 20;

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
    if (countWords(text) > HOOK_MAX_WORDS) return null;
    seenFormulas.add(formula);
    hooks.push({ formula, text });
  }
  return { hooks };
}

// ══════════════════════════════════════════════════════════════════════════
// Task 3: full-script engine (generate / regen-section) + Script persistence
// ══════════════════════════════════════════════════════════════════════════

// ── assembleScript ─────────────────────────────────────────────────────────

/** Minimal Script shape the assembler/warning helpers need — a persisted
 *  Script row satisfies it, and so does an unsaved editor draft. */
export interface ScriptSections {
  hookText: string;
  bodyText: string;
  ctaText: string;
}

/** The full spoken script as ONE string: `hookText + "\n" + bodyText + "\n" +
 *  ctaText` (spec). Layout is literal — 1 line = 1 spoken sentence, which is
 *  what the editor turns into Segments — so nothing here trims or re-wraps. */
export function assembleScript(script: ScriptSections): string {
  return `${script.hookText}\n${script.bodyText}\n${script.ctaText}`;
}

/** Drop the first body line when the model echoed the user's hook into it.
 *  The server always reattaches the user's own hook (verbatim), so an echoed
 *  copy would show up twice in the assembled script. Comparison is
 *  whitespace-insensitive; anything else is left untouched. */
export function stripEchoedHook(bodyText: string, hookText: string): string {
  const hook = hookText.trim();
  if (!hook || !bodyText) return bodyText;
  const lines = bodyText.split("\n");
  if (lines[0].trim() !== hook) return bodyText;
  return lines.slice(1).join("\n").replace(/^\n+/, "");
}

// ── Banned-words guard (spec: retry once, then warn — never block) ─────────

/** Case-insensitive substring check of `text` against a profile's bannedWords.
 *  Case matters only for latin words (Thai is caseless), but the spec asks for
 *  case-insensitive matching, so both sides are lowercased. */
export function containsBannedWord(text: string, bannedWords: readonly string[]): boolean {
  return findBannedWord(text, bannedWords) !== null;
}

/** Like containsBannedWord, but returns the offending word (first match in
 *  `bannedWords` order) so the caller can name it in the Thai warning. */
export function findBannedWord(text: string, bannedWords: readonly string[]): string | null {
  if (!text || bannedWords.length === 0) return null;
  const haystack = text.toLowerCase();
  for (const word of bannedWords) {
    const needle = word.trim().toLowerCase();
    if (needle && haystack.includes(needle)) return word;
  }
  return null;
}

/** The spec's Thai warning copy for a banned word that survived the retry. */
export function bannedWordWarning(word: string): string {
  return `มีคำต้องห้ามหลุดมา: ${word}`;
}

export interface GuardedGeneration<T> {
  result: T;
  /** Set only when a banned word survived the retry (spec: warn, never block). */
  warning?: string;
}

/** Banned-words guard shared by /api/scripts/generate and /regen-section:
 *  generate → check → on a hit, ONE retry with the stern banned-words note
 *  appended to the prompt → if the word is still there, return the result
 *  anyway with the Thai `warning` (the user is never blocked).
 *
 *  `generate(sternNote)` is the caller's LLM round-trip: it appends `sternNote`
 *  (empty string on the first attempt) to its prompt and returns the validated
 *  payload, or null when the LLM output was unusable. `extractText` returns the
 *  part of the payload that must be screened. Returns null only when the FIRST
 *  attempt produced nothing usable — that's the caller's 502. */
export async function generateWithBannedWordGuard<T>(params: {
  bannedWords: readonly string[];
  extractText: (result: T) => string;
  generate: (sternNote: string) => Promise<T | null>;
}): Promise<GuardedGeneration<T> | null> {
  const { bannedWords, extractText, generate } = params;

  const first = await generate("");
  if (!first) return null;

  const firstHit = findBannedWord(extractText(first), bannedWords);
  if (!firstHit) return { result: first };

  const retried = await generate(buildBannedWordRetryNote(bannedWords));
  // Retry produced nothing usable → keep what we have, warn about it.
  if (!retried) return { result: first, warning: bannedWordWarning(firstHit) };

  const retryHit = findBannedWord(extractText(retried), bannedWords);
  if (!retryHit) return { result: retried };
  return { result: retried, warning: bannedWordWarning(retryHit) };
}

// ── GENERATE / REGEN response validators ───────────────────────────────────

export interface GenerateScriptResult {
  structure: string;
  bodyText: string;
  ctaText: string;
}

/** Normalize a model-written multi-line block: CRLF → LF, trim each line's
 *  trailing whitespace, drop leading/trailing blank lines. Internal blank
 *  lines are kept as-is (they're the model's own paragraphing). */
function normalizeLines(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/** Validate the GENERATE route's `{structure, bodyText, ctaText}` contract.
 *  `structure` must be one of the 5 STORY_STRUCTURES keys (the model picks it;
 *  we never take its word for the key being real). Note there is deliberately
 *  no hook field — the server reattaches the user's own hook verbatim. */
export function validateGenerateResponse(data: unknown): GenerateScriptResult | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const structure = typeof d.structure === "string" ? d.structure.trim() : "";
  const bodyText = typeof d.bodyText === "string" ? normalizeLines(d.bodyText) : "";
  const ctaText = typeof d.ctaText === "string" ? normalizeLines(d.ctaText) : "";
  if (!structure || !isValidStoryStructureKey(structure)) return null;
  if (!bodyText || !ctaText) return null;
  return { structure, bodyText, ctaText };
}

export const REGEN_TARGETS = ["hook", "body", "cta"] as const;
export type RegenTarget = (typeof REGEN_TARGETS)[number];

export function isValidRegenTarget(target: unknown): target is RegenTarget {
  return typeof target === "string" && (REGEN_TARGETS as readonly string[]).includes(target);
}

export interface RegenSectionResult {
  text: string;
  /** Only for target="hook" — the new (different) HOOK_FORMULAS key. */
  formula?: string;
}

/** Validate the REGEN route's `{text}` (+ `{formula}` for hook) contract.
 *  For target="hook" the formula must be a real HOOK_FORMULAS key AND differ
 *  from `currentFormula` (spec: "hook regen returns a new hook from a
 *  *different* formula"), and the hook must respect the ≤20 คำ rule. */
export function validateRegenResponse(
  data: unknown,
  opts: { target: RegenTarget; currentFormula?: string | null }
): RegenSectionResult | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const text = typeof d.text === "string" ? normalizeLines(d.text) : "";
  if (!text) return null;

  if (opts.target !== "hook") return { text };

  const formula = typeof d.formula === "string" ? d.formula.trim() : "";
  if (!formula || !isValidHookFormulaKey(formula)) return null;
  if (opts.currentFormula && formula === opts.currentFormula.trim()) return null;
  if (countWords(text) > HOOK_MAX_WORDS) return null;
  return { text, formula };
}

// ── Script persistence (all queries scoped to the owning user) ─────────────

/** GET /api/scripts: "list own (newest first, take 50)". */
export const SCRIPT_LIST_LIMIT = 50;

export interface ScriptCreateInput {
  topic: string;
  durationSec: number;
  hookFormula?: string | null;
  structure?: string | null;
  hookText: string;
  bodyText: string;
  ctaText: string;
  brandProfileId?: string | null;
}

/** Partial patch for PUT /api/scripts/[id]. Absent keys stay `undefined` so
 *  Prisma skips them (an omitted field must never reset a saved value — see
 *  the Task 2 ctaStyle regression). `status`/`editorProjectId` are deliberately
 *  NOT patchable here: only the send-to-editor path may mark a script "sent". */
export interface ScriptPatch {
  topic?: string;
  durationSec?: number;
  hookFormula?: string | null;
  structure?: string | null;
  hookText?: string;
  bodyText?: string;
  ctaText?: string;
  brandProfileId?: string | null;
}

/** Does `brandProfileId` belong to `userId`? Guards the POST/PUT script routes
 *  against attaching someone else's BrandProfile to your own Script (the FK
 *  alone only proves the row exists, not who owns it). */
export async function ownsBrandProfile(userId: string, brandProfileId: string): Promise<boolean> {
  const row = await prisma.brandProfile.findFirst({
    where: { id: brandProfileId, userId },
    select: { id: true },
  });
  return row !== null;
}

export async function createScript(userId: string, input: ScriptCreateInput) {
  return prisma.script.create({
    data: {
      userId,
      topic: input.topic,
      durationSec: input.durationSec,
      hookFormula: input.hookFormula ?? null,
      structure: input.structure ?? null,
      hookText: input.hookText,
      bodyText: input.bodyText,
      ctaText: input.ctaText,
      brandProfileId: input.brandProfileId ?? null,
    },
  });
}

export async function listScripts(userId: string, take = SCRIPT_LIST_LIMIT) {
  return prisma.script.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take,
  });
}

export async function getScript(userId: string, id: string) {
  return prisma.script.findFirst({ where: { id, userId } });
}

/** Partial update, scoped to the owner. Returns null when the script doesn't
 *  exist OR isn't the caller's (updateMany's where-clause is the IDOR guard —
 *  same shape as the brand-profiles routes). */
export async function updateScript(userId: string, id: string, patch: ScriptPatch) {
  // A patch with nothing in it is a no-op read (an empty `data` is not a valid
  // UPDATE) — still ownership-scoped, so a foreign id keeps returning null.
  if (Object.keys(patch).length === 0) return getScript(userId, id);
  const updated = await prisma.script.updateMany({ where: { id, userId }, data: patch });
  if (updated.count === 0) return null;
  return prisma.script.findUnique({ where: { id } });
}

/** Delete, scoped to the owner. Returns false when nothing was deleted. */
export async function deleteScript(userId: string, id: string): Promise<boolean> {
  const deleted = await prisma.script.deleteMany({ where: { id, userId } });
  return deleted.count > 0;
}
