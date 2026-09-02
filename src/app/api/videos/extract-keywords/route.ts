import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { geminiGenerateText } from "@/lib/gemini";
import { getGeminiErrorInfo } from "@/lib/gemini-errors";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { checkAiInputCaps } from "@/lib/ai-input-caps";
import { reserveAiTextCall } from "@/lib/ai-text-limits";
import { walletFundingForCurrentRequest } from "@/lib/mcp/video-job-funding";
import {
  contentProfilePromptBlock,
  detectContentProfile,
  fallbackQueriesForProfile,
  type ContentProfile,
} from "@/lib/broll-profile";
import { parseRelevanceSpec, type RelevanceSpec } from "@/lib/relevance-spec";
import {
  applyBrollPreferenceToSearchQuery,
  applyBrollPreferenceToSearchQueries,
  appendBrollPreferenceToDirection,
  augmentRelevanceSpecWithBrollPreference,
  brollPreferencePromptBlock,
  normalizeBrollRegionPreference,
  normalizeBrollVisualStyle,
  type ApplyQueryOptions,
  type BrollPreferenceInput,
} from "@/lib/broll-preferences";
import { parseStockMoodRequest } from "@/lib/style-pack-snapshot";

export const maxDuration = 300;
export const runtime = "nodejs";

function preprocessScript(raw: string): string {
  return raw
    .replace(/\r?\n/g, " ")
    .replace(/\([A-Za-z][^)]{0,80}\)/g, "")
    .replace(/\.{3,}/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitizeSubtitleForKeyword(raw: string): string {
  return raw
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^a-zA-Z0-9฀-๿]+|[^a-zA-Z0-9฀-๿\s.,!?()"']+$/g, "")
    .trim();
}

// Word-overlap similarity: returns ratio of shared significant words
function keywordSimilarity(a: string, b: string): number {
  const sig = (s: string) => new Set(s.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wa = sig(a), wb = sig(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size);
}

function isTooSimilar(candidate: string, usedSet: Set<string>, threshold = 0.6): boolean {
  for (const used of usedSet) {
    if (keywordSimilarity(candidate, used) >= threshold) return true;
  }
  return false;
}

// เลือก keyword ไม่ซ้ำให้ครบ `limit` ตัว — กันซ้ำทั้งแบบเป๊ะและคล้ายกัน (similarity)
// ดึงจาก alternatives มาเติมก่อน ถ้ายังไม่ครบค่อยยอมรับตัวที่คล้าย (ดีกว่าได้ไม่ครบ)
function pickDistinctKeywords(
  keywords: string[],
  alternatives: string[][],
  limit: number,
): { keywords: string[]; alternatives: string[][] } {
  const used = new Set<string>();
  const outKw: string[] = [];
  const outAlts: string[][] = [];

  const tryAdd = (kw: string, alts: string[]): boolean => {
    if (!kw || used.has(kw) || isTooSimilar(kw, used, 0.6)) return false;
    used.add(kw);
    outKw.push(kw);
    outAlts.push(alts.length ? alts : [kw]);
    return true;
  };

  // รอบ 1: ลอง primary keyword ของแต่ละ slot
  for (let i = 0; i < keywords.length && outKw.length < limit; i++) {
    if (tryAdd(keywords[i], alternatives[i] ?? [])) continue;
    // primary ซ้ำ → ลอง alternative ตัวอื่นใน slot เดียวกัน
    for (const alt of alternatives[i] ?? []) {
      if (tryAdd(alt, alternatives[i] ?? [])) break;
    }
  }

  // รอบ 2 (เผื่อไม่ครบ): ยอมรับ exact-unique แม้จะคล้ายของเดิม
  if (outKw.length < limit) {
    for (let i = 0; i < keywords.length && outKw.length < limit; i++) {
      const kw = keywords[i];
      if (kw && !used.has(kw)) {
        used.add(kw);
        outKw.push(kw);
        outAlts.push((alternatives[i] ?? []).length ? alternatives[i] : [kw]);
      }
    }
  }

  return { keywords: outKw, alternatives: outAlts };
}

// Minimal validation: must be English, 2-8 words, not noise
const NOISE_RE = /^(scene|scenes|keywords?|clip|clips?|shot|shots|video|videos)\s*[:\-]?\s*\d*$/i;

const GENERIC_FALLBACK_QUERIES = [
  "hands using smartphone",
  "person reading document",
  "people walking city",
  "office desk close up",
  "person thinking window",
  "team meeting room",
  "hands typing keyboard",
  "notebook pen close up",
];

const TEXT_HINT_FALLBACKS: Array<{ pattern: RegExp; queries: string[] }> = [
  { pattern: /ข่าว|ดราม่า|คดี|อาชญากรรม|ตำรวจ|ศาล|จับ|สารภาพ|หลักฐาน|ผู้ต้องหา|เหยื่อ|โกง|ขโมย|ปล้น|ลอตเตอรี่|หวย|รางวัล|โรงพัก|crime|police|court|evidence|scam|theft|lottery|arrest/i, queries: ["police station exterior", "official document close up", "hands counting cash"] },
  { pattern: /ai|เอไอ|ปัญญาประดิษฐ์|เทคโนโลยี|ระบบ|ข้อมูล|ดิจิทัล|software|technology/i, queries: ["artificial intelligence", "data center servers", "software developer"] },
  { pattern: /เงิน|รายได้|ธุรกิจ|ขาย|ลูกค้า|ลงทุน|ตลาด|กำไร|business|money|sales|market/i, queries: ["business meeting", "hands counting money", "office presentation"] },
  { pattern: /สุขภาพ|หมอ|โรงพยาบาล|ยา|ออกกำลัง|health|doctor|medical|fitness/i, queries: ["doctor consultation", "healthy lifestyle", "fitness training"] },
  { pattern: /เรียน|ศึกษา|โรงเรียน|มหาวิทยาลัย|ครู|นักเรียน|education|student|learn/i, queries: ["student studying", "classroom learning", "online education"] },
  { pattern: /อาหาร|กิน|ร้าน|ครัว|กาแฟ|food|restaurant|coffee|kitchen/i, queries: ["restaurant kitchen", "coffee shop", "food preparation"] },
  { pattern: /บ้าน|ครอบครัว|เด็ก|พ่อแม่|family|home|child/i, queries: ["family at home", "children playing", "cozy living room"] },
  { pattern: /เดินทาง|เที่ยว|รถ|ถนน|เมือง|travel|car|road|city/i, queries: ["city street", "travel suitcase", "car driving road"] },
  { pattern: /กลัว|เครียด|กังวล|ปัญหา|เสี่ยง|stress|fear|problem|risk/i, queries: ["stressed person", "worried office worker", "dark city street"] },
  { pattern: /สำเร็จ|เติบโต|เป้าหมาย|แรงบันดาลใจ|success|growth|goal|motivation/i, queries: ["team celebration", "person sunrise", "business growth chart"] },
];

function sanitizeKeyword(raw: string): string {
  const k = raw
    .replace(/[^a-zA-Z0-9\s\-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!k) return "";
  if (NOISE_RE.test(k)) return "";
  if (!/[a-z]/.test(k)) return "";
  const words = k.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 8) return "";
  return k;
}

function visualDirectionCandidates(visualDirection: string): string[] {
  const words = visualDirection
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !NOISE_RE.test(w));
  const candidates: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    candidates.push(`${words[i]} ${words[i + 1]}`);
  }
  return candidates;
}

function englishTextCandidates(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !NOISE_RE.test(w));
  const candidates: string[] = [];
  for (let i = 0; i < Math.min(words.length - 1, 4); i++) {
    candidates.push(`${words[i]} ${words[i + 1]}`);
  }
  if (words.length >= 3) candidates.push(words.slice(0, 3).join(" "));
  return candidates;
}

function fallbackQueriesForText(
  text: string,
  index: number,
  count: number,
  visualDirection = "",
  contentProfile: ContentProfile = "general",
): string[] {
  const candidates: string[] = [];
  for (const hint of TEXT_HINT_FALLBACKS) {
    if (hint.pattern.test(text)) candidates.push(...hint.queries);
  }
  candidates.push(...visualDirectionCandidates(visualDirection));
  candidates.push(...englishTextCandidates(text));
  candidates.push(...fallbackQueriesForProfile(contentProfile));

  for (let i = 0; i < GENERIC_FALLBACK_QUERIES.length; i++) {
    candidates.push(GENERIC_FALLBACK_QUERIES[(index + i) % GENERIC_FALLBACK_QUERIES.length]);
  }

  const deduped: string[] = [];
  for (const candidate of candidates) {
    const clean = sanitizeKeyword(candidate);
    if (clean && !deduped.includes(clean)) deduped.push(clean);
    if (deduped.length >= count) break;
  }

  return deduped.length > 0 ? deduped : [fallbackQueriesForProfile(contentProfile)[0] ?? "hands using smartphone"];
}

function parseKeywordAlternatives(raw: string): string[][] {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Try JSON object with keywords array
  const objMatch = stripped.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      const arr: unknown[] = Array.isArray(parsed?.keywords) ? parsed.keywords
        : Array.isArray(parsed?.queries) ? parsed.queries
        : Array.isArray(parsed) ? parsed : [];

      if (arr.length > 0) {
        if (Array.isArray(arr[0])) {
          // [[q1,q2,q3], [q1,q2,q3], ...]
          return arr.map(group =>
            (Array.isArray(group) ? group : [group])
              .filter((k): k is string => typeof k === "string")
              .map(k => sanitizeKeyword(k))
              .filter(Boolean)
          ).filter(g => g.length > 0);
        }
        // flat array ["q1", "q2", ...]
        return arr
          .filter((k): k is string => typeof k === "string")
          .map(k => sanitizeKeyword(k))
          .filter(Boolean)
          .map(k => [k]);
      }
    } catch { /* fall through */ }
  }

  // Fallback: quoted strings
  const quoted = stripped.match(/"([^"]{3,150})"/g);
  if (quoted?.length) {
    return quoted
      .map(s => sanitizeKeyword(s.slice(1, -1)))
      .filter(Boolean)
      .map(k => [k]);
  }

  return [];
}

export async function POST(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = authUser.id;

  const body = await req.json().catch(() => null);
  const {
    script,
    scenes,
    perSubtitle = false,
    audioDurationSec = 0,
    targetClipCount = 0,
    brollRegionPreference,
    brollVisualStyle,
    stockMood: stockMoodRaw,
  } = body ?? {};
  // The Stock Mood is resolved SERVER-side by the worker from the pinned Style
  // Pack snapshot, but it still arrives over HTTP — validate it here so an
  // oversized mood can never reach a provider query or an LLM prompt.
  const stockMoodResult = parseStockMoodRequest(stockMoodRaw);
  if (!stockMoodResult.ok) {
    return NextResponse.json({ error: "invalid_stock_mood" }, { status: 400 });
  }
  const brollPreference: BrollPreferenceInput = {
    brollRegionPreference,
    // One style system (ADR 0057): the pack retires the legacy style outright.
    brollVisualStyle: stockMoodResult.stockMood ? undefined : brollVisualStyle,
    stockMood: stockMoodResult.stockMood,
  };
  const preferenceBlock = brollPreferencePromptBlock(brollPreference);
  const preferenceRegion = normalizeBrollRegionPreference(brollRegionPreference);
  // A pinned Stock Mood replaces the legacy style outright, so the no-op log
  // must not keep naming a style that had no effect on a single query.
  const preferenceStyle = stockMoodResult.stockMood ? undefined : normalizeBrollVisualStyle(brollVisualStyle);
  const preferencePackId = stockMoodResult.stockMood?.packId ?? null;
  // The region qualifier only fires on people/place queries by design, so a
  // script whose queries are all objects or abstractions gets "เน้นไทย" with
  // nothing visibly changing (F7 cause #4). Count what the region actually
  // touched so that no-op is measurable instead of invisible.
  let primaryQueryCount = 0;
  let regionChangedAPrimaryQuery = false;
  /** role "primary" = a query the creator should see their style in; role
   *  "fallback" = a heuristic/safe list that only runs when the primaries gave
   *  nothing, so the style token must not narrow it again. */
  const withBrollPreference = (queries: string[], options: ApplyQueryOptions = { role: "primary" }) => {
    const applied = applyBrollPreferenceToSearchQueries(queries, brollPreference, options);
    if (options.role === "primary" && preferenceRegion) {
      primaryQueryCount += applied.length;
      // Region-only comparison: style always rewrites a primary query, so
      // comparing the full preference would hide a region that did nothing.
      if (!regionChangedAPrimaryQuery) {
        regionChangedAPrimaryQuery = queries.some(
          (query) =>
            applyBrollPreferenceToSearchQuery(query, { brollRegionPreference })
            !== applyBrollPreferenceToSearchQuery(query, {}),
        );
      }
    }
    return applied;
  };
  let preferenceNoopReported = false;
  /** Fires at most once per request, and ONLY when a region preference was set
   *  and changed nothing in the final primary query list. */
  function reportBrollPreferenceNoop() {
    if (preferenceNoopReported || !preferenceRegion || regionChangedAPrimaryQuery) return;
    preferenceNoopReported = true;
    console.log(
      `[extract-keywords] preference-noop region=${preferenceRegion} style=${preferenceStyle ?? "auto"} pack=${preferencePackId ?? "none"} queries=${primaryQueryCount}`,
    );
    // `userId` is authUser.id captured above — a hoisted function declaration
    // cannot see the null-narrowing of `authUser` from the guard at the top.
    recordTelemetryEvent(userId, {
      name: "broll_preference_noop",
      category: "quality",
      source: "server",
      status: preferenceRegion,
      properties: { style: preferenceStyle ?? null, packId: preferencePackId, queryCount: primaryQueryCount },
    }).catch(() => {});
  }

  // Cap input size server-side to bound LLM cost. scenes[] is the worst amplifier:
  // extract-keywords re-embeds the full script in every 15-item batch (L4 cost guard).
  const inputCaps = checkAiInputCaps({ script, scenes });
  if (!inputCaps.ok) return NextResponse.json({ error: inputCaps.message }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { id: authUser.id },
    select: { geminiKey: true, plan: true },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  let apiKey: string;
  let geminiMode: "managed" | "byok";
  try {
    const resolved = resolveGeminiKey(user);
    apiKey = resolved.key;
    geminiMode = resolved.mode;
  } catch (e) {
    if (e instanceof KeyRequiredError) {
      return NextResponse.json({ code: "KEY_REQUIRED", action: "/settings?tab=api-keys" }, { status: 409 });
    }
    throw e;
  }

  // H1: bound managed-key text-LLM call frequency (BYOK → no-op, byte-identical).
  // One reserve per request — this route fans out to N batched Gemini calls, but
  // that per-request fan-out is the separate L4 blast-radius guard (ai-input-caps).
  const walletFunding = await walletFundingForCurrentRequest(userId);
  const textReserve = await reserveAiTextCall(userId, {
    enforce: geminiMode === "managed",
    allowOverCeiling: walletFunding.allowed,
  });
  if (!textReserve.allowed) {
    return NextResponse.json({ code: "QUOTA_AI_TEXT", message: textReserve.message }, { status: 429 });
  }

  async function callLLM(prompt: string, maxTokens: number, jsonMode = true): Promise<string> {
    return await geminiGenerateText(apiKey, prompt, maxTokens);
  }

  function geminiErrorResponse(error: unknown) {
    const info = getGeminiErrorInfo(error);
    console.error("[extract-keywords] Gemini failed:", {
      kind: info.kind,
      status: info.status,
      retryable: info.retryable,
      detail: info.technicalMessage.slice(0, 500),
    });
    return NextResponse.json({
      error: info.userMessage,
      retryable: info.retryable,
      provider: "gemini",
      reason: info.kind,
    }, { status: info.status });
  }

  let keywordFallbackRecorded = false;
  function useHeuristicKeywordFallback(error: unknown, mode: "normal" | "perSubtitle", itemCount: number): string | null {
    const info = getGeminiErrorInfo(error);
    if (!info.retryable) return null;

    console.log(`[extract-keywords] Gemini ${info.kind}; using heuristic keyword fallback (mode=${mode}, items=${itemCount})`);
    if (!keywordFallbackRecorded) {
      keywordFallbackRecorded = true;
      recordTelemetryEvent(userId, {
        name: "keyword_fallback_used",
        category: "pipeline",
        source: "server",
        step: "keywords",
        status: "fallback",
        properties: {
          mode,
          reason: info.kind,
          providerStatus: info.status,
          itemCount,
        },
      }).catch(() => {});
    }
    return info.kind;
  }

  // ── perSubtitle mode ──────────────────────────────────────────────────────────
  if (perSubtitle) {
    const subtitleList: string[] = Array.isArray(scenes) && scenes.length > 0
      ? scenes.map((s: string) => sanitizeSubtitleForKeyword(s)).filter(Boolean)
      : (script ?? "").split(/\n+/).map((s: string) => sanitizeSubtitleForKeyword(s)).filter(Boolean);

    if (!subtitleList.length) return NextResponse.json({ error: "script or scenes required" }, { status: 400 });

    const fullScript = preprocessScript(
      typeof script === "string" && script.trim() ? script : subtitleList.join(" ")
    );
    const contentProfile = detectContentProfile(fullScript);
    console.log(`[extract-keywords] contentProfile: ${contentProfile}`);

    let useHeuristicFallback = false;
    let heuristicFallbackReason: string | null = null;

    // Step 0: Analyze script once → visual direction (tone) + per-script relevance spec
    let visualDirection = "";
    let relevanceSpec: RelevanceSpec | null = null;
    try {
      const analysisPrompt = `Analyze this video script. Return ONLY a JSON object (no prose, no markdown fences):
{
  "visualDirection": "<one concise English sentence, max 20 words: mood/tone, setting, color, energy>",
  "visualDomain": "<2-6 word English label of the literal subject, e.g. 'consumer drones and RC aircraft', 'home cooking', 'crypto trading'>",
  "positiveConcepts": ["<8-15 lowercase English nouns a camera can film that SHOULD appear for this exact topic>"],
  "avoidConcepts": ["<3-8 lowercase English nouns that are OFF-topic for THIS script and should be down-ranked>"],
  "safeFallbackQueries": ["<6-10 English Pexels search phrases, 2-5 words each, on-topic, filmable, no names/brands>"]
}
Ground the topic literally (a script about drones → drone/quadcopter/aerial, NOT generic tech). avoidConcepts come from THIS script's topic, not a fixed category.
${preferenceBlock ? `\n${preferenceBlock}` : ""}

Script: ${fullScript.slice(0, 1500)}`;
      const raw = (await callLLM(analysisPrompt, 400, false)).trim();
      relevanceSpec = parseRelevanceSpec(raw);
      visualDirection = relevanceSpec?.visualDomain
        ? raw.match(/"visualDirection"\s*:\s*"([^"]{1,200})"/)?.[1]?.trim() ?? relevanceSpec.visualDomain
        : raw.replace(/^["']|["']$/g, "").slice(0, 200);
      console.log(`[extract-keywords] visualDirection: ${visualDirection} | spec: ${relevanceSpec ? relevanceSpec.visualDomain : "none"}`);
    } catch (e) {
      heuristicFallbackReason = useHeuristicKeywordFallback(e, "perSubtitle", subtitleList.length);
      useHeuristicFallback = Boolean(heuristicFallbackReason);
      if (!useHeuristicFallback) {
        console.warn("[extract-keywords] visualDirection analysis failed, continuing without it:", e);
      }
    }
    visualDirection = appendBrollPreferenceToDirection(visualDirection, brollPreference);
    relevanceSpec = augmentRelevanceSpecWithBrollPreference(relevanceSpec, brollPreference);

    const BATCH_SIZE = 15;
    const batches: string[][] = [];
    for (let i = 0; i < subtitleList.length; i += BATCH_SIZE) {
      batches.push(subtitleList.slice(i, i + BATCH_SIZE));
    }

    console.log(`[extract-keywords] perSubtitle: ${subtitleList.length} subtitles → ${batches.length} batches (Gemini)`);

    const allKeywords: string[] = [];
    const allAlternatives: string[][] = [];
    const usedKeywords = new Set<string>();

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      if (b > 0) await new Promise(r => setTimeout(r, 5000));

      const directionBlock = visualDirection
        ? `\n═══ VISUAL DIRECTION (apply to ALL queries) ═══\n${visualDirection}\n${contentProfilePromptBlock(contentProfile)}\n═══ END DIRECTION ═══\n`
        : `\n═══ CONTENT PROFILE (apply to ALL queries) ═══\n${contentProfilePromptBlock(contentProfile)}\n═══ END CONTENT PROFILE ═══\n`;

      const prompt = `You are a Visual Director and B-roll Editor for short-form video (TikTok/Reels).

═══ FULL SCRIPT — read this entire script first to understand the core message, tone, and theme ═══
${fullScript}
═══ END SCRIPT ═══
${directionBlock}
YOUR JOB:
For each subtitle phrase below, write exactly 3 Pexels stock video search queries that MATCH the VISUAL DIRECTION above AND the specific moment in that phrase.

Query 1 — Most specific to the phrase's exact visual moment (must match visual direction tone)
Query 2 — Broader visual that fits the script theme and visual direction
Query 3 — Safe fallback inside the content profile (2-6 words, never random nature/tech/animals unless the profile says so)

CRITICAL RULES:
▸ NO real person names (Dario Amodei, Elon Musk, Sam Altman…) — Pexels has none
▸ NO brand/company names (Anthropic, Google…) — no useful results
▸ Translate people/brands into what they LOOK LIKE visually:
   CEO presenting → "executive keynote stage spotlight"
   AI startup → "developer dark office multiple screens"
   Robot/AI → "humanoid robot arm factory" or "glowing neural network animation"
▸ Every query must describe something a camera can physically film in ONE SHOT
▸ English only, 2–6 words per query
▸ Vary shot styles across the batch: aerial, close-up, wide shot, slow-motion, time-lapse
▸ Ground abstract concepts in concrete objects: "hope" → "child sunrise field", "growth" → "plant sprouting soil close-up"
▸ Keep the visual MOOD consistent with the VISUAL DIRECTION above
▸ Generic fallbacks must stay inside the CONTENT PROFILE above

OUTPUT — JSON only, zero explanation:
{"keywords":[["q1","q2","q3"],["q1","q2","q3"],...]}
Return exactly ${batch.length} arrays in the same order as the phrases.

SUBTITLE PHRASES (batch ${b + 1}):
${batch.map((s, i) => `${b * BATCH_SIZE + i + 1}. ${s}`).join("\n")}`;

      const maxTokens = Math.min(4096, batch.length * 120 + 300);
      let rawAlts: string[][] = [];
      let lastBatchError: unknown = null;

      if (useHeuristicFallback) {
        rawAlts = batch.map((text, i) => fallbackQueriesForText(text, b * BATCH_SIZE + i, 3, visualDirection, contentProfile));
      } else {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (attempt > 0) await new Promise(r => setTimeout(r, 6000 * attempt));
            const text = await callLLM(prompt, maxTokens);
            console.log(`[extract-keywords] b${b} attempt${attempt}:`, text.slice(0, 120));
            rawAlts = parseKeywordAlternatives(text);
            if (rawAlts.length >= Math.floor(batch.length * 0.7)) break;
          } catch (e) {
            lastBatchError = e;
            const reason = useHeuristicKeywordFallback(e, "perSubtitle", subtitleList.length);
            if (reason) {
              heuristicFallbackReason = heuristicFallbackReason ?? reason;
              useHeuristicFallback = true;
              rawAlts = batch.map((text, i) => fallbackQueriesForText(text, b * BATCH_SIZE + i, 3, visualDirection, contentProfile));
              break;
            }
            console.error(`[extract-keywords] b${b} attempt${attempt} error:`, e);
          }
        }
      }

      if (rawAlts.length === 0 && lastBatchError) {
        const reason = useHeuristicKeywordFallback(lastBatchError, "perSubtitle", subtitleList.length);
        if (reason) {
          heuristicFallbackReason = heuristicFallbackReason ?? reason;
          useHeuristicFallback = true;
          rawAlts = batch.map((text, i) => fallbackQueriesForText(text, b * BATCH_SIZE + i, 3, visualDirection, contentProfile));
        } else {
          return geminiErrorResponse(lastBatchError);
        }
      }

      if (rawAlts.length === 0 && useHeuristicFallback) {
        rawAlts = batch.map((text, i) => fallbackQueriesForText(text, b * BATCH_SIZE + i, 3, visualDirection, contentProfile));
      }

      // Pad missing entries with empty arrays (will get generic fallback below)
      while (rawAlts.length < batch.length) rawAlts.push([]);

      const batchKeywords: string[] = [];
      const batchAlts: string[][] = [];

      for (let i = 0; i < batch.length; i++) {
        const alts = withBrollPreference(rawAlts[i] ?? []);
        const fallbackAlts = withBrollPreference(fallbackQueriesForText(batch[i] ?? fullScript, b * BATCH_SIZE + i, 3, visualDirection, contentProfile), { role: "fallback" });

        // Pick first valid keyword — in perSubtitle mode allow similar keywords
        // because adjacent subtitles can legitimately share visual themes
        let picked = "";
        for (const alt of alts) {
          if (alt && !usedKeywords.has(alt)) {
            picked = alt;
            break;
          }
        }

        // If all alternatives already used, use any valid one (don't fall back to unrelated)
        if (!picked && alts[0]) picked = alts[0];

        // Last resort: ask LLM gave nothing useful, use subtitle text words
        if (!picked) {
          picked = fallbackAlts.find((alt) => !usedKeywords.has(alt)) ?? fallbackAlts[0];
        }

        usedKeywords.add(picked);
        batchKeywords.push(picked);

        // Store alternatives, ensure first matches picked
        const cleanAlts = alts.filter(Boolean);
        if (cleanAlts.length === 0) cleanAlts.push(...fallbackAlts);
        if (cleanAlts[0] !== picked) cleanAlts.unshift(picked);
        batchAlts.push(cleanAlts.slice(0, 3));
      }

      allKeywords.push(...batchKeywords);
      allAlternatives.push(...batchAlts);
      console.log(`[extract-keywords] b${b}: ${batchKeywords.length}/${batch.length} keywords`);
    }

    console.log(`[extract-keywords] done: ${allKeywords.length}/${subtitleList.length}`);
    reportBrollPreferenceNoop();
    return NextResponse.json({
      keywords: allKeywords,
      keywordAlternatives: allAlternatives,
      sceneClipCounts: allKeywords.map(() => 1),
      sceneDurations: subtitleList.map(() => 3),
      keywordsPerScene: 1,
      visualDirection,
      contentProfile,
      relevanceSpec,
      fallback: useHeuristicFallback ? "heuristic" : undefined,
      fallbackReason: useHeuristicFallback ? heuristicFallbackReason : undefined,
    });
  }

  // ── Normal mode (whole script → N clips) ─────────────────────────────────────
  const rawScript = Array.isArray(scenes) && scenes.length > 0 ? scenes.join(" ") : (script ?? "");
  const cleanScript = preprocessScript(rawScript);
  if (!cleanScript) return NextResponse.json({ error: "script or scenes required" }, { status: 400 });
  const contentProfile = detectContentProfile(cleanScript);
  console.log(`[extract-keywords] contentProfile: ${contentProfile}`);

  const sceneList: string[] = Array.isArray(scenes) && scenes.length > 0
    ? scenes : cleanScript.split(/\n+/).filter(Boolean);
  const numScenes = Math.max(1, sceneList.length);

  // คำนวณว่าต้องการกี่ keywords จาก duration
  // สูตรต้องสอดคล้องกับ fetch-stock: avg=3.5s/clip, buffer=1.6, cap=15 clips/kw
  // ใช้ realistic clips/kw = 4 (ไม่ใช่ 15 ซึ่งเป็น cap) เพื่อให้ keyword หลากหลาย
  // และซ้ำน้อย — 1 keyword ที่ใช้สำหรับ 4 ฉาก/clips ต่างกันยังพอเข้าใจได้
  // ตัวอย่าง 5 นาที (300s):
  //   clips_needed = ceil(300/3.5 × 1.6) = 138 clips
  //   keywords_needed = max(numScenes, ceil(138/4)) = max(numScenes, 35)
  //   → ถ้า 26 scenes จะได้ kwPerScene = 2 (52 keywords รวม)
  const durSec = Number(audioDurationSec) > 0 ? Math.min(1800, Number(audioDurationSec)) : 0;
  const CLIP_AVG_SEC = 3.5;
  const BUFFER = 1.6;
  const CLIPS_PER_KW = 4; // realistic — fetch-stock caps at 15 but typical pick is ~4–6
  // กำหนดจำนวนคลิปเอง (targetClipCount > 0): ให้ LLM สร้าง keyword ตามจำนวนนั้นพอดี
  // (1 keyword/clip — แต่ละคลิปได้ภาพ/วิดีโอที่ต่างหัวข้อกัน). Auto (0): ใช้สูตรเดิมจาก duration
  const manualClips = Number(targetClipCount) > 0 ? Math.min(60, Math.floor(Number(targetClipCount))) : 0;
  const clipsNeeded = durSec > 0 ? Math.ceil((durSec / CLIP_AVG_SEC) * BUFFER) : numScenes;
  const keywordsNeeded = manualClips > 0
    ? manualClips
    : Math.max(numScenes, Math.ceil(clipsNeeded / CLIPS_PER_KW));
  // แต่ละ scene สร้างกี่ keyword (ปัดขึ้น)
  const kwPerScene = Math.max(1, Math.min(10, Math.ceil(keywordsNeeded / numScenes)));
  // โหมดกำหนดเอง: total = จำนวนที่ตั้งพอดี (trim ส่วนเกินทีหลัง). Auto: numScenes × kwPerScene
  const totalKw = manualClips > 0 ? manualClips : Math.min(500, numScenes * kwPerScene);

  console.log(`[extract-keywords] ${manualClips > 0 ? `manual=${manualClips}` : `dur=${durSec}s`} clips_needed=${clipsNeeded} keywords_needed=${keywordsNeeded} kw/scene=${kwPerScene} total=${totalKw}`);

  let useHeuristicFallback = false;
  let heuristicFallbackReason: string | null = null;

  // Analyze script → visual direction (tone) + per-script relevance spec
  let visualDirection = "";
  let relevanceSpec: RelevanceSpec | null = null;
  try {
    const analysisPrompt = `Analyze this video script. Return ONLY a JSON object (no prose, no markdown fences):
{
  "visualDirection": "<one concise English sentence, max 20 words: mood/tone, setting, color, energy>",
  "visualDomain": "<2-6 word English label of the literal subject, e.g. 'consumer drones and RC aircraft', 'home cooking', 'crypto trading'>",
  "positiveConcepts": ["<8-15 lowercase English nouns a camera can film that SHOULD appear for this exact topic>"],
  "avoidConcepts": ["<3-8 lowercase English nouns that are OFF-topic for THIS script and should be down-ranked>"],
  "safeFallbackQueries": ["<6-10 English Pexels search phrases, 2-5 words each, on-topic, filmable, no names/brands>"]
}
Ground the topic literally (a script about drones → drone/quadcopter/aerial, NOT generic tech). avoidConcepts come from THIS script's topic, not a fixed category.
${preferenceBlock ? `\n${preferenceBlock}` : ""}

Script: ${cleanScript.slice(0, 1500)}`;
    const raw = (await callLLM(analysisPrompt, 400, false)).trim();
    relevanceSpec = parseRelevanceSpec(raw);
    visualDirection = relevanceSpec?.visualDomain
      ? raw.match(/"visualDirection"\s*:\s*"([^"]{1,200})"/)?.[1]?.trim() ?? relevanceSpec.visualDomain
      : raw.replace(/^["']|["']$/g, "").slice(0, 200);
    console.log(`[extract-keywords] visualDirection: ${visualDirection} | spec: ${relevanceSpec ? relevanceSpec.visualDomain : "none"}`);
  } catch (e) {
    heuristicFallbackReason = useHeuristicKeywordFallback(e, "normal", numScenes);
    useHeuristicFallback = Boolean(heuristicFallbackReason);
  }
  visualDirection = appendBrollPreferenceToDirection(visualDirection, brollPreference);
  relevanceSpec = augmentRelevanceSpecWithBrollPreference(relevanceSpec, brollPreference);

  const directionBlock = visualDirection
    ? `\n═══ VISUAL DIRECTION ═══\n${visualDirection}\n${contentProfilePromptBlock(contentProfile)}\n═══ END DIRECTION ═══\n`
    : `\n═══ CONTENT PROFILE ═══\n${contentProfilePromptBlock(contentProfile)}\n═══ END CONTENT PROFILE ═══\n`;

  // ── โหมดกำหนดจำนวนคลิปเอง: ให้ LLM สร้าง keyword หลากหลายไม่ซ้ำตามจำนวนที่ตั้ง ──
  // ไม่ผูกกับ scenes — แตกหัวข้อจาก script เป็น N มุมที่ต่างกัน (เช่น script เรื่องเดียว
  // B-roll=5 → 5 มุมภาพที่ต่างกัน ไม่ซ้ำ)
  if (manualClips > 0) {
    const manualPrompt = `You are a Visual Director and B-roll Editor for short-form video (TikTok/Reels).

═══ FULL SCRIPT ═══
${cleanScript}
═══ END SCRIPT ═══
${directionBlock}
Generate EXACTLY ${manualClips} Pexels stock search queries that together illustrate this script.
Even if the script focuses on one topic, break it into ${manualClips} DISTINCT visual angles
(wide shot, close-up detail, people, environment, action, result, metaphor…).

CRITICAL RULES:
  • ALL ${manualClips} queries MUST be visually DISTINCT — no two queries about the same shot
  • NO real person names or brand names (Pexels has none) — translate to what they look like
  • English only, 2–6 words per query, each filmable in ONE shot
  • Ground abstract concepts in concrete filmable objects
  • Stay inside the content profile / visual direction above

OUTPUT (JSON only, no explanation):
{"keywords":["q1","q2",...]}
Exactly ${manualClips} distinct queries.`;

    let parsedFlat: string[][] = [];
    if (!useHeuristicFallback) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) await new Promise(r => setTimeout(r, 6000 * attempt));
          const text = await callLLM(manualPrompt, Math.min(4096, manualClips * 60 + 300));
          console.log(`[extract-keywords] manual=${manualClips} attempt${attempt}:`, text.slice(0, 120));
          parsedFlat = parseKeywordAlternatives(text); // flat → [[q1],[q2],...]
          if (parsedFlat.length >= Math.floor(manualClips * 0.7)) break;
        } catch (e) {
          const reason = useHeuristicKeywordFallback(e, "normal", manualClips);
          if (reason) { useHeuristicFallback = true; heuristicFallbackReason = heuristicFallbackReason ?? reason; break; }
        }
      }
    }

    // รวม keyword ที่ LLM ให้ + เติม fallback ถ้าไม่ครบ แล้ว dedup ให้ครบ ${manualClips}
    const flatKws = withBrollPreference(parsedFlat.map(g => g[0]).filter(Boolean));
    const fallbackPool = withBrollPreference(fallbackQueriesForText(cleanScript, 0, manualClips * 2, visualDirection, contentProfile), { role: "fallback" });
    const merged = [...flatKws, ...fallbackPool];
    const picked = pickDistinctKeywords(merged, merged.map(k => [k]), manualClips);
    // เติมจาก fallback อีกถ้ายังไม่ครบ (กันเคส LLM ให้น้อย + fallback ซ้ำ)
    while (picked.keywords.length < manualClips && fallbackPool.length > 0) {
      const extra = fallbackPool[picked.keywords.length % fallbackPool.length];
      const variant = `${extra} ${["closeup","wide","aerial","slow motion","detail"][picked.keywords.length % 5]}`;
      picked.keywords.push(withBrollPreference([sanitizeKeyword(variant) || extra])[0] ?? extra);
      picked.alternatives.push([extra]);
    }

    console.log(`[extract-keywords] manual mode: ${picked.keywords.length} distinct keywords (target ${manualClips})`);
    reportBrollPreferenceNoop();
    return NextResponse.json({
      keywords: picked.keywords,
      keywordAlternatives: picked.alternatives,
      scenes: sceneList,
      keywordsPerScene: 1,
      sceneClipCounts: picked.keywords.map(() => 1),
      sceneDurations: picked.keywords.map(() => Math.max(3, Math.ceil((durSec || numScenes * 3) / picked.keywords.length))),
      visualDirection,
      contentProfile,
      relevanceSpec,
      fallback: useHeuristicFallback ? "heuristic" : undefined,
      fallbackReason: useHeuristicFallback ? heuristicFallbackReason : undefined,
    });
  }

  // ถ้าต้องการมากกว่า 1 keyword/scene → ส่ง prompt แบบ multi-kw/scene
  const multiKwMode = kwPerScene > 1;

  const prompt = multiKwMode
    ? `You are a Visual Director and B-roll Editor for short-form video (TikTok/Reels).

═══ FULL SCRIPT ═══
${cleanScript}
═══ END SCRIPT ═══
${directionBlock}
This video is ${durSec.toFixed(0)}s long. We need ${totalKw} distinct B-roll search queries total — ${kwPerScene} per scene — to fill the entire video with varied footage.

For each scene below, write EXACTLY ${kwPerScene} different Pexels search queries that cover different visual moments or angles within that scene.
Each query set should progress through the scene: wide shot → detail shot → action shot (vary the style).

RULES:
  • NEVER use real person names or brand names
    - CEO/founder → "executive keynote stage spotlight"
    - AI company → "server room glowing screens"
  • English only, 2–6 words per query
  • Make queries VISUALLY DISTINCT from each other — no two similar shots
  • Ground abstract concepts in concrete filmable objects
  • Generic fallbacks must stay inside the CONTENT PROFILE above

OUTPUT (JSON only, no explanation):
{"keywords":[["q1a","q1b",...],["q2a","q2b",...],...]}
Exactly ${numScenes} arrays, each with exactly ${kwPerScene} queries, in scene order.

SCENES:
${sceneList.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
    : `You are a Visual Director and B-roll Editor for short-form video (TikTok/Reels).

═══ FULL SCRIPT ═══
${cleanScript}
═══ END SCRIPT ═══
${directionBlock}
STEP 1 — Understand the script's core message, tone, and main visual theme.
STEP 2 — For each scene below, write exactly 3 Pexels stock video search queries:
  Query 1 — Most specific to the scene's exact visual moment (match visual direction tone)
  Query 2 — Broader visual that fits the script theme
  Query 3 — Safe fallback inside the content profile (2–6 words, never random nature/tech/animals unless the profile says so)

RULES:
  • NEVER use real person names or brand names (Pexels has none)
    - CEO/founder → "executive keynote stage spotlight"
    - AI company → "server room glowing screens"
    - Robot/AI → "humanoid robot arm factory"
  • English only, 2–6 words per query
  • Vary shot styles: aerial, close-up, wide, slow-motion, time-lapse
  • Ground abstract concepts in concrete filmable objects
  • Generic fallbacks must stay inside the CONTENT PROFILE above

OUTPUT (JSON only, no explanation):
{"keywords":[["q1","q2","q3"],["q1","q2","q3"],...]}
Exactly ${numScenes} arrays in order.

SCENES:
${sceneList.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;

  function heuristicNormalResponse(reason: string | null) {
    const allAlternatives: string[][] = [];
    const allKeywords: string[] = [];

    for (let i = 0; i < numScenes; i++) {
      const sceneAlts = withBrollPreference(fallbackQueriesForText(sceneList[i] ?? cleanScript, i, Math.max(kwPerScene, 3), visualDirection, contentProfile), { role: "fallback" });
      for (let j = 0; j < kwPerScene; j++) {
        const picked = sceneAlts[j % sceneAlts.length];
        allKeywords.push(picked);
        allAlternatives.push([picked, ...sceneAlts.filter(a => a !== picked)].slice(0, 3));
      }
    }

    const sceneClipCounts = multiKwMode
      ? sceneList.map(() => kwPerScene)
      : sceneList.map(() => 1);
    const sceneDurations = sceneList.map(s => Math.max(5, Math.ceil(s.replace(/\s/g, "").length / 3)));

    console.log(`[extract-keywords] heuristic fallback: ${allKeywords.length} keywords for ${numScenes} scenes (${kwPerScene}/scene)`);
    reportBrollPreferenceNoop();
    return NextResponse.json({
      keywords: allKeywords,
      keywordAlternatives: allAlternatives,
      scenes: sceneList,
      keywordsPerScene: kwPerScene,
      sceneClipCounts,
      sceneDurations,
      visualDirection,
      contentProfile,
      relevanceSpec,
      fallback: "heuristic",
      fallbackReason: reason,
    });
  }

  if (useHeuristicFallback) {
    return heuristicNormalResponse(heuristicFallbackReason);
  }

  try {
    const maxTokens = Math.min(8192, totalKw * 80 + 400);
    const text = await callLLM(prompt, maxTokens);
    console.log(`[extract-keywords] normal mode (kwPerScene=${kwPerScene}):`, text.slice(0, 200));

    const parsed = parseKeywordAlternatives(text);

    // Build per-scene alternatives
    // multiKwMode: parsed[i] = [kwA, kwB, kwC, ...] — all are primaries for that scene
    // normal mode: parsed[i] = [q1, q2, q3] — q1 is primary, q2/q3 are alternatives
    const allAlternatives: string[][] = [];
    const allKeywords: string[] = [];
    const usedKeywords = new Set<string>();

    if (multiKwMode) {
      // แต่ละ scene → kwPerScene keywords แยกกัน
      for (let i = 0; i < numScenes; i++) {
        const sceneAlts = withBrollPreference((parsed[i] ?? []).filter(Boolean));
        const fallbackAlts = withBrollPreference(fallbackQueriesForText(sceneList[i] ?? cleanScript, i, Math.max(kwPerScene, 3), visualDirection, contentProfile), { role: "fallback" });
        // เติมถ้า LLM ให้มาน้อยกว่า kwPerScene
        let fallbackIndex = 0;
        while (sceneAlts.length < kwPerScene) {
          sceneAlts.push(fallbackAlts[fallbackIndex % fallbackAlts.length]);
          fallbackIndex++;
        }
        // สร้าง keyword แยกสำหรับแต่ละ slot ใน scene
        for (let j = 0; j < kwPerScene; j++) {
          let picked = sceneAlts[j] || sceneAlts[0];
          // ถ้าซ้ำมากเกินไป ใช้ตัวถัดไปจาก list ทั้งหมด
          if (isTooSimilar(picked, usedKeywords, 0.8) && sceneAlts.length > j + 1) {
            picked = sceneAlts[j + 1] || picked;
          }
          usedKeywords.add(picked);
          allKeywords.push(picked);
          // alternatives = ทุก query ของ scene นี้ (สลับลำดับให้ primary อยู่หน้า)
          const altsForSlot = [picked, ...sceneAlts.filter(a => a !== picked)].slice(0, 3);
          allAlternatives.push(altsForSlot);
        }
      }
    } else {
      for (let i = 0; i < numScenes; i++) {
        const alts = withBrollPreference((parsed[i] ?? []).filter(Boolean));
        const fallbackAlts = withBrollPreference(fallbackQueriesForText(sceneList[i] ?? cleanScript, i, 3, visualDirection, contentProfile), { role: "fallback" });

        let picked = "";
        for (const alt of alts) {
          if (alt && !isTooSimilar(alt, usedKeywords)) { picked = alt; break; }
        }
        if (!picked && alts[0]) picked = alts[0];

        if (!picked) {
          picked = fallbackAlts.find((alt) => !isTooSimilar(alt, usedKeywords)) ?? fallbackAlts[0];
        }

        usedKeywords.add(picked);
        allKeywords.push(picked);
        const cleanAlts = alts.filter(Boolean);
        if (cleanAlts.length === 0) cleanAlts.push(...fallbackAlts);
        if (cleanAlts[0] !== picked) cleanAlts.unshift(picked);
        allAlternatives.push(cleanAlts.slice(0, 3));
      }
    }

    const sceneClipCounts = multiKwMode
      ? sceneList.map(() => kwPerScene)  // แต่ละ scene ได้ kwPerScene clips
      : sceneList.map(() => 1);
    const sceneDurations = sceneList.map(s => Math.max(5, Math.ceil(s.replace(/\s/g, "").length / 3)));

    console.log(`[extract-keywords] ${allKeywords.length} keywords for ${numScenes} scenes (${kwPerScene}/scene, need ${keywordsNeeded})`);
    reportBrollPreferenceNoop();
    return NextResponse.json({
      keywords: allKeywords,
      keywordAlternatives: allAlternatives,
      scenes: sceneList,
      keywordsPerScene: kwPerScene,
      sceneClipCounts,
      sceneDurations,
      visualDirection,
      contentProfile,
      relevanceSpec,
    });
  } catch (e) {
    const reason = useHeuristicKeywordFallback(e, "normal", numScenes);
    if (reason) return heuristicNormalResponse(reason);
    return geminiErrorResponse(e);
  }
}
