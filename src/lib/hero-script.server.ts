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
// every query scoped to the owning user). Task 4 closes the loop with the
// money path: the rolling-window `scripts` plan cap (countScriptsInWindow /
// canCreateScript) and the 1-click handoff into the video editor
// (assembleScriptForHandoff + sendScriptToEditor).

import type { BrandProfile, Prisma, User } from "@prisma/client";
import { NextResponse } from "next/server";
import { limitsForPlan, PLAN_LABEL } from "@/lib/plan-limits";
import { geminiGenerateText } from "@/lib/gemini";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  HERO_SCRIPT_LOCKED_CODE,
  HERO_SCRIPT_LOCKED_MESSAGE,
} from "@/lib/hero-script-access";
import {
  resolveHeroScriptAccess,
  type HeroScriptAccessDecision,
  type HeroScriptCohort,
} from "@/lib/hero-script-rollout.server";
import { createEditorProject, sanitizeEditorProjectTitle } from "@/lib/editor-projects";
import { buildScriptHandoffDraft } from "@/lib/editor-default-draft";
import { getDefaultBrandPreference } from "@/lib/brand-assets.server";
import { visibleTtsProvider } from "@/lib/tts-providers";
import {
  applyBrandRevisionDefaultsToProjectDraft,
  BrandProfileLibraryError,
  resolveBrandProfileRevisionForNewProjectInTransaction,
} from "@/lib/brand-profile-library.server";
import { brandLookIdentityKey, VISUAL_FORMATS } from "@/lib/brand-visual-system";
import {
  openRouterGenerateText,
  isOpenRouterAuthError,
  isOpenRouterCreditError,
  OPENROUTER_CREDIT_MESSAGE,
  OPENROUTER_MODEL_FAST_DEFAULT,
  OPENROUTER_MODEL_PRO_DEFAULT,
  OPENROUTER_UNAVAILABLE_MESSAGE,
} from "@/lib/openrouter";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { reserveAiTextCall } from "@/lib/ai-text-limits";
import { checkAiInputCaps } from "@/lib/ai-input-caps";
import { tokenizeWords } from "@/lib/tts-timing";
import { isValidHookFormulaKey, isValidStoryStructureKey } from "@/lib/viral-frameworks";
import { TTS_WORDS_PER_SECOND } from "@/lib/prompts/content-generator";
import {
  buildBannedWordRetryNote,
  type BrandProfileForPrompt,
} from "@/lib/prompts/hero-script";

// ── Auth + internal-beta allowlist gate (shared by all 11 routes) ──────────
//
// Post-review amendment (2026-07-31): Hero Script is internal-beta only.
// Every route calls this instead of getCurrentUser() directly, so the 403
// FEATURE_LOCKED response is defined once, not copy-pasted 11 times.

export type HeroScriptAuthResult =
  | { ok: true; user: User; access: HeroScriptAccessDecision }
  | { ok: false; response: NextResponse };

export async function requireHeroScriptUser(): Promise<HeroScriptAuthResult> {
  const authUser = await getCurrentUser();
  if (!authUser) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const access = await resolveHeroScriptAccess(authUser);
  if (!access.canUse) {
    return {
      ok: false,
      response: NextResponse.json(
        { code: HERO_SCRIPT_LOCKED_CODE, error: HERO_SCRIPT_LOCKED_MESSAGE },
        { status: 403 }
      ),
    };
  }
  return { ok: true, user: authUser, access };
}

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

export type HeroScriptBrandProfileResolution =
  | {
      ok: true;
      profile: BrandProfileForPrompt;
      bannedWords: string[];
      ctaStyle: string;
    }
  | { ok: false; code: "NOT_FOUND" | "UNAVAILABLE"; message: string };

/** Resolve brand writing defaults for a NEW Hero Script operation.
 *
 * Legacy revision-0 rows keep their historical mutable behavior until the
 * creator explicitly imports them. Published Brand Library rows instead read
 * the immutable active Revision payload and pass the same plan-authoritative
 * freeze check used by Editor pinning. This prevents a mutable top-level row or
 * a downgraded overflow profile from changing new work. */
export async function resolveHeroScriptBrandProfile(
  userId: string,
  brandProfileId: string,
): Promise<HeroScriptBrandProfileResolution> {
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.brandProfile.findFirst({
        where: { id: brandProfileId, userId },
      });
      if (!row) {
        return { ok: false as const, code: "NOT_FOUND" as const, message: "ไม่พบโปรไฟล์แบรนด์" };
      }
      if (row.activeRevisionNumber <= 0) {
        if (row.frozenAt) {
          return {
            ok: false as const,
            code: "UNAVAILABLE" as const,
            message: "แบรนด์นี้อยู่ในโหมดอ่านอย่างเดียวตามแผนปัจจุบัน",
          };
        }
        const profile = toBrandProfileDTO(row);
        return {
          ok: true as const,
          profile,
          bannedWords: profile.bannedWords,
          ctaStyle: row.ctaStyle || "follow",
        };
      }

      const resolved = await resolveBrandProfileRevisionForNewProjectInTransaction(tx, {
        userId,
        profileId: row.id,
      });
      if (!resolved) {
        return { ok: false as const, code: "UNAVAILABLE" as const, message: "แบรนด์นี้ยังไม่พร้อมใช้งาน" };
      }
      const scriptDefaults = resolved.payload.script;
      const bannedWords = [...scriptDefaults.bannedWords];
      return {
        ok: true as const,
        profile: {
          niche: resolved.payload.niche,
          audience: resolved.payload.audience,
          tone: scriptDefaults.tone,
          bannedWords,
          analysisNotes: scriptDefaults.analysisNotes ?? null,
        },
        bannedWords,
        ctaStyle: scriptDefaults.ctaStyle || "follow",
      };
    });
  } catch (error) {
    if (error instanceof BrandProfileLibraryError) {
      return { ok: false, code: "UNAVAILABLE", message: error.message };
    }
    throw error;
  }
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
/** Amended 2026-07-31 (plan doc updated): the original default `gemini-2.5-pro`
 *  returns 404 "no longer available to new users" on the project's server key;
 *  `gemini-pro-latest` was verified working live. */
export const HERO_SCRIPT_MODEL_PRO_DEFAULT = "gemini-pro-latest";

/** Minimum thinking budget for the pro tier. Pro-tier Gemini models are
 *  thinking-only and reject a 0 budget outright (see GeminiTextOptions in
 *  src/lib/gemini.ts); 128 is the smallest accepted value, which keeps both
 *  latency and the thought-token share of maxOutputTokens small. Flash-tier
 *  calls keep thinking fully disabled (budget 0), unchanged. */
export const HERO_SCRIPT_PRO_THINKING_BUDGET = 128;

export type HeroScriptModelTier = "fast" | "pro";

// ── Provider switch (2026-07-31) ───────────────────────────────────────────
//
// Hero Script — and ONLY Hero Script — can run its LLM calls on OpenRouter
// (GPT-5.6 luna/terra) instead of Gemini. The other 11 Gemini call sites in the
// app are untouched by this switch. The code default is "gemini" so a missing
// or garbled env value can never take a working feature offline; the beta runs
// with HERO_SCRIPT_PROVIDER=openrouter in .env, and rollback is that one line
// (set it to `gemini`, restart) with no rebuild of logic.

export type HeroScriptProvider = "gemini" | "openrouter";

/** Fail-safe default: the provider Hero Script shipped on. */
export const HERO_SCRIPT_PROVIDER_DEFAULT: HeroScriptProvider = "gemini";

export interface HeroScriptProviderResolution {
  provider: HeroScriptProvider;
  /** Set only when the configured value was unusable (logged once by heroScriptProvider). */
  warning?: string;
}

/** Pure resolver for `HERO_SCRIPT_PROVIDER` — unset/blank → gemini, known value
 *  (case/whitespace-insensitive) → itself, anything else → gemini + a warning.
 *  Exported separately from heroScriptProvider() so the warning branch is
 *  testable without capturing console output. */
export function resolveHeroScriptProvider(raw: string | null | undefined): HeroScriptProviderResolution {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return { provider: HERO_SCRIPT_PROVIDER_DEFAULT };
  if (value === "gemini" || value === "openrouter") return { provider: value };
  return {
    provider: HERO_SCRIPT_PROVIDER_DEFAULT,
    warning: `HERO_SCRIPT_PROVIDER="${raw}" is not a known provider — falling back to "${HERO_SCRIPT_PROVIDER_DEFAULT}"`,
  };
}

/** Deduped so a misconfigured env warns once per value, not once per LLM call. */
let lastProviderWarning = "";

/** The active Hero Script LLM provider (reads the env on every call so a
 *  restart-free env change in dev takes effect immediately). */
export function heroScriptProvider(): HeroScriptProvider {
  const { provider, warning } = resolveHeroScriptProvider(process.env.HERO_SCRIPT_PROVIDER);
  if (warning && warning !== lastProviderWarning) {
    lastProviderWarning = warning;
    console.warn(`[hero-script] ${warning}`);
  }
  return provider;
}

/** Resolve the model id for a Hero Script tier, for the ACTIVE provider:
 *  gemini → `HERO_SCRIPT_MODEL_FAST` / `HERO_SCRIPT_MODEL_PRO`,
 *  openrouter → `HERO_SCRIPT_OR_MODEL_FAST` / `HERO_SCRIPT_OR_MODEL_PRO`,
 *  each falling back to that provider's default. The two env pairs are separate
 *  on purpose: a Gemini model id is meaningless to OpenRouter (and vice versa),
 *  so switching providers must never inherit the other one's override. */
export function heroScriptModel(
  tier: HeroScriptModelTier,
  provider: HeroScriptProvider = heroScriptProvider()
): string {
  if (provider === "openrouter") {
    const raw = tier === "pro" ? process.env.HERO_SCRIPT_OR_MODEL_PRO : process.env.HERO_SCRIPT_OR_MODEL_FAST;
    const fallback = tier === "pro" ? OPENROUTER_MODEL_PRO_DEFAULT : OPENROUTER_MODEL_FAST_DEFAULT;
    return raw?.trim() || fallback;
  }
  const raw = tier === "pro" ? process.env.HERO_SCRIPT_MODEL_PRO : process.env.HERO_SCRIPT_MODEL_FAST;
  const fallback = tier === "pro" ? HERO_SCRIPT_MODEL_PRO_DEFAULT : HERO_SCRIPT_MODEL_FAST_DEFAULT;
  return raw?.trim() || fallback;
}

/** The ONE seam where Hero Script's text generation meets a provider.
 *
 *  Every Hero Script LLM call site reaches the model through here (via
 *  generateValidatedJson), so the provider switch needs no per-route code.
 *
 *  `apiKey` is the caller's resolved GEMINI key — it is unused on the OpenRouter
 *  path, where the request runs on the server's OPENROUTER_API_KEY for every
 *  user (see resolveLlmTriad's metering note). Nothing here ever falls back to
 *  the other provider: a failure is reported as a failure (ADR 0004). */
export async function heroScriptGenerateText(params: {
  apiKey: string;
  prompt: string;
  maxOutputTokens: number;
  tier: HeroScriptModelTier;
}): Promise<string> {
  const { apiKey, prompt, maxOutputTokens, tier } = params;
  const provider = heroScriptProvider();
  const model = heroScriptModel(tier, provider);

  if (provider === "openrouter") {
    return openRouterGenerateText(prompt, { model, maxOutputTokens, temperature: 0 });
  }

  const thinkingBudget = tier === "pro" ? HERO_SCRIPT_PRO_THINKING_BUDGET : 0;
  return geminiGenerateText(apiKey, prompt, maxOutputTokens, 0, { model, thinkingBudget });
}

/** Text-LLM calls a PRO-tier route reserves per request (flash routes stay 1).
 *  See resolveLlmTriad's `opts.count` for the reasoning. */
export const PRO_TIER_TEXT_CALL_COST = 2;

// ── Model-unavailable (the 404 class) ──────────────────────────────────────
//
// The configured pro model can stop existing under us: Google retires ids and
// answers `404 NOT_FOUND — "models/<id> is not found for API version v1beta,
// or is not supported for generateContent"` / "…is no longer available…" (this
// is exactly why HERO_SCRIPT_MODEL_PRO_DEFAULT had to move off gemini-2.5-pro
// on 2026-07-31). getGeminiErrorInfo has no bucket for that, so it lands in
// `unknown` → ProviderError("fatal", status 404) and the route's generic catch
// reports "เกิดข้อผิดพลาดจากระบบ AI" — a message that tells nobody the model id
// is dead and invites the user to retry forever.
//
// There is deliberately NO fallback to the fast model: cross-tier fallback is
// forbidden (ADR 0004) — the pro tier is a product promise, and silently
// answering with flash would ship worse scripts under a better label. The
// honest move is a distinct 503 that tells the user to try again or ping the
// team, and puts the model id in the admin log where an operator can fix it.

export const MODEL_UNAVAILABLE_CODE = "MODEL_UNAVAILABLE";

export const MODEL_UNAVAILABLE_MESSAGE =
  "โมเดล AI สำหรับเขียนสคริปต์ไม่พร้อมใช้งานชั่วคราว โปรดลองใหม่อีกครั้งหรือแจ้งทีมงาน";

/** Is this the "the model id itself is gone/unusable" failure class?
 *
 *  Primary signal is the upstream 404 (ProviderError carries the upstream
 *  status; the message keeps the raw body as a fallback): generateContent's
 *  ONLY 404 is "this model id does not exist / is not usable with this method",
 *  and the callers of this predicate talk to nothing but Gemini. The message
 *  branch is the belt-and-braces path for when the status is lost — it demands
 *  both a mention of a model and an explicit gone/unsupported phrase, so
 *  quota / rate-limit / overloaded / key errors keep their own handling. */
export function isModelUnavailableError(error: unknown): boolean {
  if (!error) return false;
  const status = (error as { status?: unknown }).status;
  if (status === 404) return true;
  const raw = error instanceof Error ? error.message : String(error);
  const haystack = raw.toLowerCase();
  if (/"code"\s*:\s*404/.test(haystack)) return true;
  return (
    /model/.test(haystack) &&
    /not found|no longer available|not supported for generatecontent|is not supported/.test(haystack)
  );
}

/** Response code for "the PROVIDER's credit/allowance is spent" (OpenRouter
 *  402/429). Distinct from QUOTA_AI_TEXT (the user's own metered ceiling) —
 *  here the user did nothing wrong and has nothing to top up. */
export const PROVIDER_CREDIT_CODE = "PROVIDER_CREDIT";

/** Response code for "the provider is unusable for a reason only an operator
 *  can fix" (e.g. the server credential was rejected). Kept separate from
 *  PROVIDER_CREDIT so a log/HAR never mislabels a config problem as a bill. */
export const PROVIDER_UNAVAILABLE_CODE = "PROVIDER_UNAVAILABLE";

/** Turn an LLM failure that the user can neither fix nor usefully retry-loop on
 *  into the honest 503, or null when the caller should keep handling it.
 *
 *  Shared by all 6 Hero Script LLM routes so the copy + the operator log are
 *  defined once. Order matters: the provider-credit class is checked before the
 *  model-unavailable predicate, because a 429 body can mention a model name.
 *
 *  Never falls back to another model or provider (ADR 0004) — a pro-tier request
 *  answered by the fast model would be a worse script under a better label. */
export function heroScriptLlmErrorResponse(
  error: unknown,
  ctx: { route: string; tier: HeroScriptModelTier }
): NextResponse | null {
  const provider = heroScriptProvider();
  // Provider + model id ONLY in the log: a raw provider message can embed an
  // API key, and this path does not go through apiError's scrubber.
  const where = `${ctx.route}: provider=${provider} model=${heroScriptModel(ctx.tier, provider)}`;

  if (isOpenRouterCreditError(error)) {
    console.error(`[hero-script] provider credit/allowance exhausted (${where})`);
    return NextResponse.json({ code: PROVIDER_CREDIT_CODE, error: OPENROUTER_CREDIT_MESSAGE }, { status: 503 });
  }
  if (isOpenRouterAuthError(error)) {
    // Server-side credential problem — the user has no OpenRouter key of their
    // own, so they must never be told to "check your API key".
    console.error(`[hero-script] provider credential rejected/missing (${where})`);
    return NextResponse.json({ code: PROVIDER_UNAVAILABLE_CODE, error: OPENROUTER_UNAVAILABLE_MESSAGE }, { status: 503 });
  }
  if (isModelUnavailableError(error)) {
    console.error(`[hero-script] model unavailable (${where})`);
    return NextResponse.json(
      { code: MODEL_UNAVAILABLE_CODE, error: MODEL_UNAVAILABLE_MESSAGE },
      { status: 503 }
    );
  }
  return null;
}

/** Call the active LLM provider (heroScriptGenerateText) and validate its JSON
 *  response, retrying once on parse/validation failure (per the API contracts
 *  table: "1 retry on parse/validation failure, then 502"). Returns null when
 *  both attempts fail to validate — the caller is responsible for the 502
 *  `{ error: "AI ตอบผิดรูปแบบ ลองใหม่อีกครั้ง" }`.
 *
 *  `tier` picks the model (+ thinking config on Gemini): "fast" (default — the
 *  ideas/hooks/analyze routes) or "pro" (full-script generate + section
 *  regenerate). `apiKey` is the Gemini key; it is ignored under
 *  HERO_SCRIPT_PROVIDER=openrouter (server key). */
export async function generateValidatedJson<T>(params: {
  apiKey: string;
  prompt: string;
  maxOutputTokens?: number;
  tier?: HeroScriptModelTier;
  validate: (data: unknown) => T | null;
}): Promise<T | null> {
  const { apiKey, prompt, maxOutputTokens = 2048, tier = "fast", validate } = params;
  const attempts = 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const raw = await heroScriptGenerateText({ apiKey, prompt, maxOutputTokens, tier });
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
  | {
      ok: true;
      /** Gemini key — "" on the OpenRouter path (server key, resolved in the client). */
      apiKey: string;
      provider: HeroScriptProvider;
      /** null on the OpenRouter path: no Gemini key was resolved at all. */
      geminiMode: "managed" | "byok" | null;
    }
  | { ok: false; status: number; body: Record<string, unknown> };

/** Run the shared checkAiInputCaps → resolveGeminiKey → reserveAiTextCall
 *  preamble for `userId`. `inputCapsInput` is whatever the caller is about to
 *  send to the model (script text / scenes / words — see checkAiInputCaps). On
 *  success returns the resolved API key + provider + mode; on failure returns
 *  the exact { status, body } the route should respond with (byte-identical to
 *  what analyze/niche-ideas returned inline before this was extracted).
 *
 *  Under HERO_SCRIPT_PROVIDER=openrouter the resolveGeminiKey step is SKIPPED
 *  (no 409 KEY_REQUIRED — the server key serves everyone) and the call meter is
 *  enforced for every user, because the server is then the cost bearer.
 *
 *  `opts.count` is how many text-LLM calls to reserve (default 1 — every flash
 *  route). The PRO-tier routes pass 2: one request there can issue up to FOUR
 *  model round-trips (generateValidatedJson retries a bad parse once, and the
 *  banned-words guard can run the whole thing a second time), on a model that
 *  costs multiples of flash per token — while the ceiling in ai-text-limits.ts
 *  was calibrated against a 1-call flash route. Reserving 2 keeps a pro request
 *  from being the cheapest way to burn the managed key. */
export async function resolveLlmTriad(
  userId: string,
  inputCapsInput: LlmInputCapsInput,
  opts: { count?: number } = {}
): Promise<LlmTriadResult> {
  const inputCaps = checkAiInputCaps(inputCapsInput);
  if (!inputCaps.ok) return { ok: false, status: 400, body: { error: inputCaps.message } };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { geminiKey: true, plan: true },
  });
  if (!user) return { ok: false, status: 404, body: { error: "User not found" } };

  const provider = heroScriptProvider();

  let apiKey = "";
  let geminiMode: "managed" | "byok" | null = null;
  if (provider === "gemini") {
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
  }
  // provider === "openrouter": NO Gemini key is resolved and NO 409 KEY_REQUIRED
  // is possible — the call runs on the server's OPENROUTER_API_KEY, so a user
  // who never set up Gemini BYOK is served all the same.

  // H1: bound server-paid text-LLM call frequency. Under OpenRouter the SERVER
  // pays for every Hero Script call — including calls from users who are BYOK
  // for Gemini — so the meter is enforced for EVERYONE, not just managed-Gemini
  // users. Under Gemini the rule is unchanged (managed → enforce, BYOK → no-op,
  // byte-identical). `count` (2 for pro-tier routes) applies to both.
  const enforce = provider === "openrouter" ? true : geminiMode === "managed";
  const textReserve = await reserveAiTextCall(userId, { enforce, count: opts.count });
  if (!textReserve.allowed) {
    return { ok: false, status: 429, body: { code: "QUOTA_AI_TEXT", message: textReserve.message } };
  }

  return { ok: true, apiKey, provider, geminiMode };
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

/** The script as the EDITOR must receive it: assembleScript, then every
 *  blank/whitespace-only line removed (see normalizeLines).
 *
 *  assembleScript is deliberately literal, and the autosave PUT stores whatever
 *  the user typed — so a user who hits Enter twice in the เนื้อหา textarea has
 *  blank lines sitting in the row. The editor treats 1 line = 1 Segment, so this
 *  is the last chance to strip them before they become empty segments and pull
 *  subtitle timing out of sync. Normalizing the ASSEMBLED string (rather than
 *  each section) also collapses the join when a section is empty. */
export function assembleScriptForHandoff(script: ScriptSections): string {
  return normalizeLines(assembleScript(script));
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

/** Normalize a written block: CRLF → LF, trim each line, and drop EVERY
 *  blank/whitespace-only line — leading, trailing and internal.
 *
 *  Dropping internal blanks is the project invariant, not cosmetics: 1 บรรทัด =
 *  1 ประโยคที่พูดจริง, and the editor turns 1 line into 1 Segment (CONTEXT.md).
 *  A blank line is not a spoken sentence — it would become an empty segment and
 *  drag subtitle timing off — so no section (and therefore no assembleScript
 *  output) may contain one, whatever paragraphing the model felt like adding.
 *
 *  Exported because it guards TWO doors: the LLM validators below (model
 *  paragraphing) and assembleScriptForHandoff (blank lines the USER typed —
 *  PUT /api/scripts/[id] stores section text verbatim, by design). */
export function normalizeLines(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
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
  return (await resolveHeroScriptBrandProfile(userId, brandProfileId)).ok;
}

/** `client` defaults to the global prisma client; pass a transaction client to
 *  enlist the create in an outer interactive transaction (see
 *  createScriptWithinCap, where the cap count and the create must be one unit). */
export async function createScript(
  userId: string,
  input: ScriptCreateInput,
  client: Prisma.TransactionClient = prisma
) {
  return client.script.create({
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

// ══════════════════════════════════════════════════════════════════════════
// Task 4: the scripts plan cap + the 1-click handoff into the video editor
// ══════════════════════════════════════════════════════════════════════════

// ── Plan cap: scripts (FREE 3 / 30 days, PRO+BUSINESS unlimited) ───────────

/** The `scripts` cap is a ROLLING 30-day window (spec), not a calendar month —
 *  same shape as the clip cap (reserveClipUsage). */
export const SCRIPT_WINDOW_DAYS = 30;

const SCRIPT_WINDOW_MS = SCRIPT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// Full-generation product quota. Unlike the legacy Script-row count below,
// this ledger is charged before /generate calls the server-paid provider and
// survives deleting the resulting saved Script.
export const HERO_SCRIPT_FREE_GENERATIONS = 3;
export const HERO_SCRIPT_TRIAL_GENERATIONS = 10;
export const HERO_SCRIPT_RESERVATION_MINUTES = 10;

export function heroScriptGenerationLimit(cohort: HeroScriptCohort): number {
  if (cohort === "free") return HERO_SCRIPT_FREE_GENERATIONS;
  if (cohort === "trial") return HERO_SCRIPT_TRIAL_GENERATIONS;
  return Number.POSITIVE_INFINITY;
}

export type ScriptGenerationReservation =
  | { allowed: true; reservationId: string | null; used: number; limit: number }
  | { allowed: false; reservationId: null; used: number; limit: number; message: string };

/** Atomically reserve one full-script generation for finite FREE/TRIAL
 *  cohorts. Active reservations count until they expire, closing concurrent
 *  request races without permanently burning quota after a crashed request. */
export async function reserveScriptGeneration(
  userId: string,
  cohort: HeroScriptCohort,
  now: Date = new Date(),
): Promise<ScriptGenerationReservation> {
  const limit = heroScriptGenerationLimit(cohort);
  if (!Number.isFinite(limit)) {
    return { allowed: true, reservationId: null, used: 0, limit };
  }

  const bucket = cohort === "trial" ? "trial" : "free";
  const windowStart = new Date(now.getTime() - SCRIPT_WINDOW_MS);
  const expiresAt = new Date(now.getTime() + HERO_SCRIPT_RESERVATION_MINUTES * 60 * 1000);

  // Recycle only reservations that can no longer count. A fixed unique slot
  // per cohort makes admission safe across concurrent app processes: two
  // requests cannot both claim the same last slot.
  await prisma.scriptGenerationUsage.deleteMany({
    where: {
      userId,
      bucket,
      OR: [
        { status: "failed" },
        { status: "succeeded", createdAt: { lt: windowStart } },
        { status: "reserved", expiresAt: { lte: now } },
      ],
    },
  });

  for (let slot = 1; slot <= limit; slot++) {
    try {
      const row = await prisma.scriptGenerationUsage.create({
        data: { userId, bucket, slot, status: "reserved", expiresAt },
        select: { id: true },
      });
      const used = await prisma.scriptGenerationUsage.count({
        where: { userId, bucket },
      });
      return { allowed: true as const, reservationId: row.id, used, limit };
    } catch (error) {
      if ((error as { code?: string })?.code === "P2002") continue;
      throw error;
    }
  }

  const used = await prisma.scriptGenerationUsage.count({ where: { userId, bucket } });
  const message = cohort === "trial"
    ? `ช่วงทดลองใช้เขียนสคริปต์เต็มได้ ${limit} ครั้ง — อัปเกรดเพื่อเขียนไม่จำกัด`
    : `แผนฟรีเขียนได้ ${limit} สคริปต์/${SCRIPT_WINDOW_DAYS} วัน — อัปเกรดเพื่อเขียนไม่จำกัด`;
  return { allowed: false as const, reservationId: null, used, limit, message };
}

/** Settle a reservation exactly once. Failed generations do not consume the
 *  product quota; the separate AI-call meter still charges provider attempts. */
export async function settleScriptGeneration(
  userId: string,
  reservationId: string | null,
  succeeded: boolean,
  now: Date = new Date(),
): Promise<void> {
  if (!reservationId) return;
  if (!succeeded) {
    await prisma.scriptGenerationUsage.deleteMany({
      where: { id: reservationId, userId, status: "reserved" },
    });
    return;
  }
  await prisma.scriptGenerationUsage.updateMany({
    where: { id: reservationId, userId, status: "reserved" },
    data: { status: "succeeded", completedAt: now },
  });
}

/** How many Scripts `userId` created inside the rolling window (the number the
 *  cap is checked against). Own rows only. `client` takes a transaction client
 *  so the count can be serialized with the create it guards. */
export async function countScriptsInWindow(
  userId: string,
  now: Date = new Date(),
  client: Prisma.TransactionClient = prisma
): Promise<number> {
  return client.script.count({
    where: { userId, createdAt: { gte: new Date(now.getTime() - SCRIPT_WINDOW_MS) } },
  });
}

export interface ScriptCapCheck {
  allowed: boolean;
  cap: number;
  plan: string;
  /** Thai upsell message — only set when allowed === false. */
  message?: string;
}

/** scripts plan cap check for POST /api/scripts → 403 SCRIPT_LIMIT.
 *  `currentCount` comes from countScriptsInWindow. The message is the UI spec's
 *  copy; only FREE has a finite cap, so it names that plan directly (paid plans
 *  are Infinity and can never reach this branch). */
export function canCreateScript(plan: string, currentCount: number): ScriptCapCheck {
  const cap = limitsForPlan(plan).scripts;
  if (currentCount < cap) return { allowed: true, cap, plan };
  return {
    allowed: false,
    cap,
    plan,
    message: `แผนฟรีเขียนได้ ${cap} สคริปต์/${SCRIPT_WINDOW_DAYS} วัน — อัปเกรดเพื่อเขียนไม่จำกัด`,
  };
}

export type CreateScriptWithinCapResult =
  | { ok: true; script: Awaited<ReturnType<typeof createScript>> }
  | { ok: false; capCheck: ScriptCapCheck };

/** POST /api/scripts, cap included: count the window, decide, and create — all
 *  inside ONE interactive transaction.
 *
 *  Counting outside the transaction was a TOCTOU hole: two concurrent POSTs
 *  from a FREE user sitting at 2 scripts could both read 2, both pass the cap,
 *  and both insert. Prisma serializes interactive transactions on this
 *  project's SQLite connection, so the count and the insert it authorizes can no
 *  longer interleave. Nothing is written on the blocked path, so returning
 *  (rather than throwing) leaves nothing to roll back. */
export async function createScriptWithinCap(
  userId: string,
  plan: string,
  input: ScriptCreateInput
): Promise<CreateScriptWithinCapResult> {
  return prisma.$transaction(async (tx) => {
    const capCheck = canCreateScript(plan, await countScriptsInWindow(userId, new Date(), tx));
    if (!capCheck.allowed) return { ok: false as const, capCheck };
    return { ok: true as const, script: await createScript(userId, input, tx) };
  });
}

// ── send-to-editor ─────────────────────────────────────────────────────────

/** The UI spec's locked-CTA copy, reused verbatim as the 403 body so the API
 *  and the button say the same thing. */
export const EDITOR_LOCKED_MESSAGE = "อัปเกรดเป็น PRO เพื่อส่งเข้าตัดต่อ";

export type SendScriptToEditorResult =
  | {
      ok: true;
      projectId: string;
      brandProfileRevisionId: string | null;
      brandLookIdentityKey: string | null;
      visualFormatId: string | null;
    }
  | { ok: false; code: "NOT_FOUND"; message: string }
  | { ok: false; code: "EDITOR_LOCKED"; message: string }
  | { ok: false; code: "BRAND_PROFILE_UNAVAILABLE"; message: string }
  | { ok: false; code: "EMPTY_SCRIPT"; message: string };

/** POST /api/scripts/[id]/send-to-editor — hand a finished script to the video
 *  editor in one click.
 *
 *  1. the script must be the caller's own (IDOR guard — a foreign id is a plain
 *     NOT_FOUND, never a handoff),
 *  2. the plan must allow the editor at all (FREE → EDITOR_LOCKED upsell),
 *  3. the script text is assembled with blank lines stripped (1 line = 1
 *     Segment — see assembleScriptForHandoff),
 *  4. an EditorProject is created through the editor's own create path with the
 *     editor's own default draft (never a hand-rolled draftJson), seeded with
 *     the account's saved voice/avatar/logo defaults exactly like a project created
 *     inside the editor,
 *  5. the Script is marked "sent" and points at that project.
 *
 *  Re-sending an already-sent script is allowed: it creates a fresh project and
 *  re-points the row (the previous project may well have been deleted).
 *
 *  Steps 4+5 run in ONE interactive transaction: the Script write is the real
 *  existence check (the load in step 1 is only a fast path), so a script deleted
 *  from another tab mid-handoff rolls the EditorProject back instead of leaving
 *  an orphan behind a `{ok:true}` that never marked anything "sent". */
export async function sendScriptToEditor(
  userId: string,
  scriptId: string
): Promise<SendScriptToEditorResult> {
  const script = await getScript(userId, scriptId);
  if (!script) return { ok: false, code: "NOT_FOUND", message: "ไม่พบสคริปต์" };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      plan: true,
      ttsProvider: true,
      geminiVoiceName: true,
      elevenlabsVoiceId: true,
      heygenAvatarId: true,
    },
  });
  if (!user) return { ok: false, code: "NOT_FOUND", message: "ไม่พบผู้ใช้" };

  if (!limitsForPlan(user.plan).allowVideoEditor) {
    return { ok: false, code: "EDITOR_LOCKED", message: EDITOR_LOCKED_MESSAGE };
  }

  const text = assembleScriptForHandoff(script);
  if (!text) {
    return { ok: false, code: "EMPTY_SCRIPT", message: "สคริปต์ยังว่างอยู่ กรุณาเขียนเนื้อหาก่อนส่งไปตัดต่อ" };
  }

  const title = sanitizeEditorProjectTitle(script.topic);
  const brandDefault = await getDefaultBrandPreference(userId);
  const accountDraft = buildScriptHandoffDraft({
    script: text,
    projectTitle: title,
    accountDefaults: {
      // Mirrors the editor's loadAccountVideoDefaults() (/api/user/video-settings).
      voiceEngine: visibleTtsProvider(user.ttsProvider),
      geminiVoiceName: user.geminiVoiceName?.trim() || undefined,
      voiceId: user.elevenlabsVoiceId?.trim() ?? "",
      avatarId: user.heygenAvatarId?.trim() ?? "",
    },
    logoOverlay: brandDefault?.config,
  });

  // Sentinel: thrown to roll the whole handoff back, never surfaced to callers.
  const scriptGone = new Error("hero_script_send_target_missing");
  try {
    const handoff = await prisma.$transaction(async (tx) => {
      const revision = script.brandProfileId
        ? await resolveBrandProfileRevisionForNewProjectInTransaction(tx, {
            userId,
            profileId: script.brandProfileId,
          })
        : null;
      const draft = revision
        ? applyBrandRevisionDefaultsToProjectDraft({ draft: { ...accountDraft }, payload: revision.payload })
        : accountDraft;
      const project = await createEditorProject(userId, {
        title,
        draft,
        brandProfileRevisionId: revision?.revisionId,
      }, tx);
      // Ownership-scoped write — and the authoritative existence check: a
      // concurrent DELETE between the load above and here makes count 0, which
      // must undo the project rather than report a handoff that never happened.
      const marked = await tx.script.updateMany({
        where: { id: scriptId, userId, brandProfileId: script.brandProfileId },
        data: { status: "sent", editorProjectId: project.id },
      });
      if (marked.count === 0) throw scriptGone;
      const visual = revision?.payload.visual;
      const format = visual
        ? VISUAL_FORMATS.find((candidate) => candidate.id === visual.primaryVisualFormatId)
        : null;
      const language = visual?.languageMode === "defined"
        ? {
            palette: visual.palette,
            personality: visual.personality,
            peopleAndSetting: visual.peopleAndSetting,
            memorableCues: visual.memorableCues,
            visualNotes: visual.visualNotes,
          }
        : null;
      return {
        projectId: project.id,
        brandProfileRevisionId: revision?.revisionId ?? null,
        brandLookIdentityKey: visual && format
          ? brandLookIdentityKey({
              visualFormatId: visual.primaryVisualFormatId,
              recipeVersion: format.recipeVersion,
              treatment: visual.defaultTreatment,
              brandVisualLanguage: language,
            })
          : null,
        visualFormatId: visual?.primaryVisualFormatId ?? null,
      };
    });
    return { ok: true, ...handoff };
  } catch (error) {
    if (error === scriptGone) return { ok: false, code: "NOT_FOUND", message: "ไม่พบสคริปต์" };
    if (error instanceof BrandProfileLibraryError) {
      if (error.code === "NOT_FOUND") {
        return { ok: false, code: "NOT_FOUND", message: "ไม่พบแบรนด์ของสคริปต์นี้" };
      }
      if (error.code === "FROZEN" || error.code === "PREFERRED_REQUIRED" || error.code === "NO_REVISION") {
        return { ok: false, code: "BRAND_PROFILE_UNAVAILABLE", message: error.message };
      }
    }
    throw error;
  }
}
