import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { geminiGenerateText } from "@/lib/gemini";

export const maxDuration = 300;
export const runtime = "nodejs";

function decrypt(k: string) {
  return Buffer.from(k, "base64").toString("utf-8");
}

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
    .replace(/^[^a-zA-Z0-9\u0E00-\u0E7F]+|[^a-zA-Z0-9\u0E00-\u0E7F\s.,!?()"']+$/g, "")
    .trim();
}

const FALLBACK_POOL = [
  "cinematic wide street shot", "person walking in city", "nature landscape aerial view",
  "office workspace close up", "business team meeting room", "city skyline at dusk",
  "hands typing on laptop", "documents on office desk", "futuristic technology screen",
  "dramatic portrait lighting studio", "coffee shop busy crowd", "sunset highway road trip",
  "scientist working laboratory", "athlete running stadium", "chef cooking restaurant kitchen",
  "drone aerial cityscape shot", "stock market trading floor", "mountain summit sunrise fog",
  "underwater ocean coral reef", "engineer inspecting machinery factory",
  "crowd cheering concert stage", "child playing outdoor park",
  "doctor hospital medical equipment", "rocket launch space debris",
  "man reading book library", "woman jogging park morning", "rain falling on window",
  "teacher writing whiteboard classroom", "construction worker building site",
  "airplane taking off runway", "hands holding smartphone", "coffee pouring into cup",
  "traffic jam highway aerial", "solar panels rooftop", "fire burning campfire",
  "chess pieces on board", "boxing match arena", "empty road desert horizon",
  "neon lights city night", "hands shaking deal", "microscope laboratory closeup",
  "crowd people walking station", "dog running grass field", "piano keys close up",
  "astronaut space suit", "server room data center", "painter canvas art studio",
  "waterfall jungle tropical", "map navigation digital", "hands clay pottery",
];

const THAI_RE = /[฀-๿]/;

const NOISE_KEYWORD_RE = /^(scene|scenes|keywords?|keyword|clips?|shot|shots|video|videos)\s*[:\-]?\s*\d+$/i;
const LOW_VALUE_KEYWORD_RE = /^(one|two|three|four|five|six|seven|eight|nine|ten)\s+word$/i;

function isNoiseKeyword(keyword: string): boolean {
  if (!keyword) return true;
  if (NOISE_KEYWORD_RE.test(keyword)) return true;
  if (/^["'`(]?(scene|keywords?|keyword|clip|clips?|shot|shots|video|videos)[)"'`]?$/i.test(keyword)) return true;
  if (/^\d+$/.test(keyword)) return true;
  if (/^(scene|keywords?)/i.test(keyword)) return true;
  if (LOW_VALUE_KEYWORD_RE.test(keyword)) return true;
  return false;
}

function hashText(input: string): number {
  let hash = 2166136261;
  const str = input.toLowerCase();
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function buildFallbackKeyword(seedText: string, i: number): string {
  const baseSeed = (hashText(seedText) + i * 97) % FALLBACK_POOL.length;
  return FALLBACK_POOL[baseSeed];
}

function normalizeKeyword(k: string): string {
  return k.replace(/\s+/g, " ").replace(/[^a-zA-Z0-9\s-]/g, "").trim().toLowerCase();
}

function sanitizeKeywordCandidate(raw: string): string {
  const normalized = normalizeKeyword(raw);
  if (!normalized) return "";
  if (isNoiseKeyword(normalized)) return "";
  if (THAI_RE.test(normalized)) return "";
  if (!/[a-z]/i.test(normalized)) return "";
  const words = normalized.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 8) return "";
  return normalized;
}

function splitLooseLinesIntoGroups(raw: string): string[][] {
  const lines = raw
    .replace(/`/g, "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const out: string[][] = [];
  for (const line of lines) {
    const noLeading = line
      .replace(/^\s*[\-\*\u2022]\s*/, "")
      .replace(/^\s*\d+\s*[)\].:,-]?\s*/, "")
      .replace(/^\s*\[?\d+\s*\]\s*/, "")
      .trim();

    if (!noLeading) continue;
    if (/^(hook|subtitle|subtitles|output|result|scene|keyword|keywords)\b/i.test(noLeading)) continue;

    const parts = noLeading
      .split(/\s*[|,;]\s*/)
      .map((p) => p.trim())
      .filter(Boolean);

    const rawCandidates = parts.length > 0 ? parts : [noLeading];
    const sanitized = rawCandidates
      .map((p) => sanitizeKeywordCandidate(p))
      .filter((p) => p.length > 0);
    if (sanitized.length > 0) out.push(sanitized);
  }

  return out;
}

// Parse LLM response that returns array of string arrays: {"keywords":[["a","b","c"],...]}
// Returns string[][] — one array of alternatives per subtitle.
// Falls back to wrapping flat strings if LLM returns old format.
function extractKeywordAlternatives(raw: string): string[][] {
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const objMatch = stripped.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      const arr: unknown[] = Array.isArray(parsed?.keywords) ? parsed.keywords
        : Array.isArray(parsed?.queries) ? parsed.queries
        : Array.isArray(parsed) ? parsed : [];
      if (arr.length > 0) {
        // New format: array of arrays
        if (Array.isArray(arr[0])) {
          return arr.map(group =>
            (Array.isArray(group) ? group : [group])
              .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
              .map(k => sanitizeKeywordCandidate(k))
              .filter((k) => k.length > 0)
          ).filter(g => g.length > 0);
        }
        // Old format: flat array of strings — wrap each in single-element array
        return arr
          .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
          .map(k => sanitizeKeywordCandidate(k))
          .filter((k) => k.length > 0)
          .map(k => [k]);
      }
    } catch { /* fall through */ }
  }
  // Fallback: extract quoted strings as flat list
  const quoted = stripped.match(/"([^"]{3,200})"/g);
  if (quoted?.length) {
    return quoted
      .map(s => sanitizeKeywordCandidate(s.slice(1, -1).trim()))
      .filter((s) => s.length > 0)
      .map(s => [s]);
  }

  // Last resort: parse loose numbered/text lines
  const loose = splitLooseLinesIntoGroups(stripped);
  if (loose.length > 0) return loose;

  return [];
}

function extractQuotedStringArray(raw: string, expectedCount = 0): string[] {
  const arr = extractKeywordAlternatives(raw)
    .map(g => g[0])
    .filter((s): s is string => typeof s === "string");

  if (expectedCount > 0 && arr.length < expectedCount) {
    const seed = raw.split(/\s+/).slice(0, 8).join(" ");
    const out: string[] = [];
    for (let i = arr.length; i < expectedCount; i++) {
      out.push(buildFallbackKeyword(seed, i));
    }
    return [...arr, ...out];
  }

  return arr;
}

function ensureKeywordsShape(
  keywords: string[],
  subtitleHints: string[],
  expectedCount: number,
  globalUsed: Set<string>,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < expectedCount; i++) {
    const norm = sanitizeKeywordCandidate(keywords[i] ?? "");
    const wc = norm.split(" ").filter(Boolean).length;
    const valid = norm.length > 0 && wc >= 2 && wc <= 8;

    if (valid && !out.includes(norm)) {
      globalUsed.add(norm);
      out.push(norm);
      continue;
    }

    // Find next unused fallback
    let pushed = false;
    for (let fi = 0; fi < FALLBACK_POOL.length * 2; fi++) {
      const seed = `${subtitleHints[i] ?? "fallback"}-${i}-${fi}`;
      const fb = buildFallbackKeyword(seed, fi + i);
      if (!globalUsed.has(fb)) {
        globalUsed.add(fb);
        out.push(fb);
        pushed = true;
        break;
      }
    }
    if (!pushed) {
      let unique = buildFallbackKeyword(`${subtitleHints[i] ?? "fallback"}-${i}`, globalUsed.size + i);
      while (globalUsed.has(unique)) {
        unique = `${unique}-${globalUsed.size}`;
      }
      globalUsed.add(unique);
      out.push(unique);
    }
  }
  return out;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { script, scenes, perSubtitle = false, preferredLLM } = body ?? {};

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { geminiKey: true, openaiKey: true, ttsProvider: true },
  });

  let apiKey = process.env.SERVER_OPENAI_API_KEY || null;
  let useGemini = false;
  if (!apiKey) {
    const wantGemini = preferredLLM === "gemini";
    const wantOpenAI = preferredLLM === "openai";
    if (wantGemini && user?.geminiKey)       { apiKey = decrypt(user.geminiKey); useGemini = true; }
    else if (wantOpenAI && user?.openaiKey)  { apiKey = decrypt(user.openaiKey); }
    else if (user?.geminiKey)                { apiKey = decrypt(user.geminiKey); useGemini = true; }
    else if (user?.openaiKey)                { apiKey = decrypt(user.openaiKey); }
    else return NextResponse.json({ error: "Gemini or OpenAI key not set", missingKey: "gemini" }, { status: 400 });
  }

  async function callLLM(prompt: string, maxTokens: number): Promise<string> {
    if (useGemini) {
      return await geminiGenerateText(apiKey!, prompt, maxTokens);
    }
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.5,
        response_format: { type: "json_object" },
      }),
    });
    if (r.ok) { const d = await r.json(); return d.choices?.[0]?.message?.content ?? "{}"; }
    throw new Error(`OpenAI ${r.status}`);
  }

  // ── perSubtitle mode ──
  if (perSubtitle) {
    const subtitleList: string[] = Array.isArray(scenes) && scenes.length > 0
      ? scenes.map((s: string) => sanitizeSubtitleForKeyword(s)).filter(Boolean)
      : (script ?? "").split(/\n+/).map((s: string) => sanitizeSubtitleForKeyword(s)).filter(Boolean);

    if (!subtitleList.length) return NextResponse.json({ error: "script or scenes required" }, { status: 400 });

    const BATCH_SIZE = 30;
    const batches: string[][] = [];
    for (let i = 0; i < subtitleList.length; i += BATCH_SIZE) {
      batches.push(subtitleList.slice(i, i + BATCH_SIZE));
    }

    console.log(`[extract-keywords] perSubtitle: ${subtitleList.length} subtitles → ${batches.length} batches (${useGemini ? "Gemini" : "OpenAI"})`);

    const allKeywords: string[] = [];
    const allAlternatives: string[][] = [];
    const globalUsed = new Set<string>();

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];

      // Delay between batches to stay within Gemini rate limits
      if (b > 0) await new Promise(r => setTimeout(r, 8000));

      const prompt = `You are a professional B-roll video editor for TikTok/Reels short-form videos.

For each subtitle phrase below, write 3 English Pexels search queries ordered from MOST to LEAST specific.
The system will try query 1 first, then 2, then 3 if no video is found.

RULES:
- Output ONLY: {"keywords":[["q1a","q1b","q1c"],["q2a","q2b","q2c"],...]}
- Exactly ${batch.length} arrays, same order as subtitles
- Each array has exactly 3 queries, most specific → most generic
- English only — no Thai characters
- 2-5 words per query, something a camera can physically film
- Think: what VIDEO CLIP would a viewer expect to see while hearing this subtitle?
- Use VISUAL METAPHORS for abstract concepts:
  * AI / technology → ["developer coding screen", "tech startup office", "computer screen typing"]
  * competition / ranking → ["chess match closeup", "race track finish line", "leaderboard display"]
  * money / economy → ["stock market trading floor", "financial chart growth", "business meeting handshake"]
  * people / society → ["crowd walking city street", "diverse team meeting", "people gathering outdoors"]
  * change / transition → ["door opening bright light", "sunrise time lapse", "before after transformation"]
  * surprise / discovery → ["person shocked reaction screen", "lightbulb idea moment", "excited person news"]
- Query 3 should always be a safe broad fallback (1-2 words) that Pexels will definitely have results for

SUBTITLE PHRASES (${b * BATCH_SIZE + 1}–${b * BATCH_SIZE + batch.length}):
${batch.map((s, i) => `${b * BATCH_SIZE + i + 1}. ${s}`).join("\n")}

Important:
- Keep each output query tightly grounded to the same subtitle line.
- Do not use generic words like "news", "technology", "people" if a more specific visual exists.
- If subtitle is abstract, use strong visual metaphors that can be filmed in one shot.

JSON only:`;

      const maxTokens = Math.min(4096, batch.length * 80 + 200);
      let rawAlts: string[][] = [];

      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          if (attempt > 0) await new Promise(r => setTimeout(r, 8000 * attempt));
          const text = await callLLM(prompt, maxTokens);
          console.log(`[extract-keywords] b${b} attempt${attempt}:`, text.slice(0, 120));
          rawAlts = extractKeywordAlternatives(text);
          const readyCount = rawAlts.filter(g => g.length > 0).length;
          if (rawAlts.length === batch.length && readyCount >= Math.max(1, Math.floor(batch.length * 0.3))) break;
        } catch (e) {
          console.error(`[extract-keywords] b${b} attempt${attempt} error:`, e);
        }
      }

      // Primary keywords (first alternative) go through ensureKeywordsShape for dedup/fallback
      const primaryKws = rawAlts.map(g => g[0] ?? "");
      const batchOut = ensureKeywordsShape(primaryKws, batch, batch.length, globalUsed);
      console.log(`[extract-keywords] b${b}: ${batchOut.length}/${batch.length} keywords`);
      if (rawAlts.length < batch.length) {
        console.log(`[extract-keywords] b${b}: rawAlts only ${rawAlts.length}/${batch.length}, fallback used for ${batch.length - rawAlts.length} lines (or invalid lines)`);
      }
      allKeywords.push(...batchOut);

      // Store all alternatives per subtitle (pad/trim to batch.length)
      for (let i = 0; i < batch.length; i++) {
        const alts = rawAlts[i] ?? [];
        // Filter Thai, normalize; keep up to 3 unique alternatives
        const cleaned = alts
          .map(k => sanitizeKeywordCandidate(k))
          .filter((k, idx, arr) => k.length > 0 && arr.indexOf(k) === idx)
          .slice(0, 3);
        // Always ensure first alt matches what ensureKeywordsShape picked
        if (cleaned[0] !== batchOut[i]) cleaned.unshift(batchOut[i]);
        allAlternatives.push(cleaned.slice(0, 3));
      }
    }

    console.log(`[extract-keywords] done: ${allKeywords.length}/${subtitleList.length}`);
    return NextResponse.json({
      keywords: allKeywords,
      keywordAlternatives: allAlternatives,
      sceneClipCounts: allKeywords.map(() => 1),
      sceneDurations: subtitleList.map(() => 3),
      keywordsPerScene: 1,
    });
  }

  // ── Normal mode ──
  const rawScript = Array.isArray(scenes) && scenes.length > 0 ? scenes.join(" ") : (script ?? "");
  const cleanScript = preprocessScript(rawScript);
  if (!cleanScript) return NextResponse.json({ error: "script or scenes required" }, { status: 400 });

  const prompt = `You are a professional video editor for TikTok/Reels short-form videos.

Given this Thai script, decide how many B-roll clips are needed (roughly 1 clip per 3-5 seconds) and write the best English Pexels search query for each.

RULES:
- Each query: 2-5 English words, something a camera can physically film
- Translate Thai → concrete English visuals
- Vary shots: wide → close → action → aerial
- Every query must be unique
- Never output placeholders or indexes like "scene 12", "clip 1", "keywords 12"

SCRIPT: "${cleanScript}"

Return ONLY valid JSON:
{"totalClips":<number>,"queries":["query1","query2",...]}`;

  try {
    const text = await callLLM(prompt, 4096);
    console.log(`[extract-keywords] normal mode:`, text.slice(0, 200));
    const sceneList: string[] = Array.isArray(scenes) && scenes.length > 0
      ? scenes : cleanScript.split(/\n+/).filter(Boolean);
    const numScenes = Math.max(1, sceneList.length);
    const queriesRaw = extractQuotedStringArray(text, numScenes);
    const queries = [...(queriesRaw.length > numScenes ? queriesRaw.slice(0, numScenes) : queriesRaw)];
    if (queries.length === 0) throw new Error("empty queries");

    if (queries.length < numScenes) {
      const seed = cleanScript.slice(0, 140);
      while (queries.length < numScenes) {
        queries.push(buildFallbackKeyword(seed, queries.length));
      }
    }
    const perScene = Math.ceil(queries.length / numScenes);
    const sceneClipCounts = sceneList.map((_, i) => Math.min(perScene, queries.length - i * perScene)).filter(c => c > 0);
    const sceneDurations = sceneList.map(s => Math.max(5, Math.ceil(s.replace(/\s/g, "").length / 3)));

    console.log(`[extract-keywords] ${queries.length} keywords for ${numScenes} scenes`);
    return NextResponse.json({ keywords: queries, scenes: sceneList, keywordsPerScene: perScene, sceneClipCounts, sceneDurations });
  } catch (e) {
    console.error("[extract-keywords] error:", e);
    return NextResponse.json({ keywords: [], scenes: [], keywordsPerScene: 3, sceneClipCounts: [], sceneDurations: [] });
  }
}
