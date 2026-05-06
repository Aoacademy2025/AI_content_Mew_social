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
const ANGLE_SUFFIXES = ["close up", "wide shot", "aerial view", "slow motion", "detail shot", "action shot"];

function normalizeKeyword(k: string): string {
  return k.replace(/\s+/g, " ").replace(/[^a-zA-Z0-9\s-]/g, "").trim().toLowerCase();
}

function isValidKeyword(raw: string): boolean {
  if (THAI_RE.test(raw)) return false;
  const norm = normalizeKeyword(raw);
  const wc = norm.split(" ").filter(Boolean).length;
  return norm.length >= 4 && wc >= 2 && wc <= 8;
}

// Strip markdown code fences Gemini sometimes adds
function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function parseKeywordsFromLLM(raw: string): string[] {
  const cleaned = stripFences(raw);
  // Try JSON object with keywords array
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      const arr: unknown[] = Array.isArray(parsed?.keywords) ? parsed.keywords
        : Array.isArray(parsed?.queries) ? parsed.queries
        : Array.isArray(parsed) ? parsed : [];
      const result = arr.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map(k => k.trim());
      if (result.length > 0) return result;
    } catch { /* fall through */ }
  }
  // Try bare array
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const parsed = JSON.parse(arrMatch[0]);
      if (Array.isArray(parsed)) {
        const result = parsed.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map(k => k.trim());
        if (result.length > 0) return result;
      }
    } catch { /* fall through */ }
  }
  // Fallback: extract quoted strings
  const quoted = cleaned.match(/"([^"]{3,150})"/g);
  if (quoted) return quoted.map(s => s.slice(1, -1).trim()).filter(Boolean);
  return [];
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
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

  let geminiKey: string | null = null;
  let openaiKey: string | null = null;
  const serverOpenAI = process.env.SERVER_OPENAI_API_KEY || null;

  if (user?.geminiKey) geminiKey = decrypt(user.geminiKey);
  if (user?.openaiKey) openaiKey = decrypt(user.openaiKey);
  if (serverOpenAI) openaiKey = serverOpenAI;

  // Determine primary LLM
  let useGemini = false;
  let apiKey: string | null = null;
  if (serverOpenAI) {
    apiKey = serverOpenAI; useGemini = false;
  } else if (preferredLLM === "gemini" && geminiKey) {
    apiKey = geminiKey; useGemini = true;
  } else if (preferredLLM === "openai" && openaiKey) {
    apiKey = openaiKey; useGemini = false;
  } else if (geminiKey) {
    apiKey = geminiKey; useGemini = true;
  } else if (openaiKey) {
    apiKey = openaiKey; useGemini = false;
  } else {
    return NextResponse.json({ error: "Gemini or OpenAI key not set", missingKey: "gemini" }, { status: 400 });
  }

  async function callLLM(prompt: string, maxTokens: number): Promise<string> {
    if (useGemini) {
      try {
        return await geminiGenerateText(apiKey!, prompt, maxTokens);
      } catch (e: unknown) {
        const status = (e as { status?: number })?.status ?? 0;
        // Fallback to OpenAI if Gemini 503 and OpenAI key available
        if ((status === 503 || status === 429) && openaiKey) {
          console.warn(`[extract-keywords] Gemini ${status} — falling back to OpenAI`);
          const r = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [{ role: "user", content: prompt }],
              max_tokens: maxTokens,
              temperature: 0.5,
              response_format: { type: "json_object" },
            }),
          });
          if (r.ok) { const d = await r.json(); return d.choices?.[0]?.message?.content ?? "{}"; }
        }
        throw e;
      }
    } else {
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
      return "{}";
    }
  }

  // ── perSubtitle mode ──
  if (perSubtitle) {
    const subtitleList: string[] = Array.isArray(scenes) && scenes.length > 0
      ? scenes
      : (script ?? "").split(/\n+/).map((s: string) => s.trim()).filter(Boolean);

    if (!subtitleList.length) return NextResponse.json({ error: "script or scenes required" }, { status: 400 });

    const BATCH_SIZE = 20; // smaller = less likely to hit rate limit
    const batches: string[][] = [];
    for (let i = 0; i < subtitleList.length; i += BATCH_SIZE) {
      batches.push(subtitleList.slice(i, i + BATCH_SIZE));
    }

    console.log(`[extract-keywords] perSubtitle: ${subtitleList.length} subtitles → ${batches.length} batches`);

    const allKeywords: string[] = [];
    const globalUsed = new Set<string>();

    // Pre-populate fallback pool into globalUsed tracking (not blocking, just for awareness)
    let fallbackIdx = 0;

    function nextFallback(): string {
      // Cycle through pool with index tracking to ensure uniqueness
      for (let i = 0; i < FALLBACK_POOL.length * 2; i++) {
        const candidate = FALLBACK_POOL[(fallbackIdx + i) % FALLBACK_POOL.length];
        if (!globalUsed.has(candidate)) {
          globalUsed.add(candidate);
          fallbackIdx = (fallbackIdx + i + 1) % FALLBACK_POOL.length;
          return candidate;
        }
        // Try with angle suffix
        for (const suffix of ANGLE_SUFFIXES) {
          const v = `${candidate} ${suffix}`;
          if (!globalUsed.has(v)) {
            globalUsed.add(v);
            fallbackIdx = (fallbackIdx + i + 1) % FALLBACK_POOL.length;
            return v;
          }
        }
      }
      // Absolute last resort
      const unique = `scene ${globalUsed.size}`;
      globalUsed.add(unique);
      return unique;
    }

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];

      // Delay between batches to avoid rate limiting
      if (b > 0) await sleep(3000);

      const avoidHint = allKeywords.length > 0
        ? `Already used (avoid repeating): ${allKeywords.slice(-15).join(", ")}`
        : "";

      const prompt = `You are a B-roll video editor. For each Thai subtitle phrase below, write ONE English Pexels search query that visually matches it.

OUTPUT FORMAT: {"keywords":["query1","query2",...]}
- Exactly ${batch.length} queries, same order
- English only — no Thai characters
- 2-5 words per query, something a camera can film
- Translate Thai meaning into visual English (person/place/object/action)
- All queries must be unique
- Vary shot styles (close-up, wide, aerial, slow motion, action)
${avoidHint ? `- ${avoidHint}` : ""}
SUBTITLES:
${batch.map((s, i) => `${b * BATCH_SIZE + i + 1}. ${s}`).join("\n")}

Respond with JSON only:`;

      const maxTokens = Math.min(2048, batch.length * 30 + 200);
      let rawKws: string[] = [];

      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          if (attempt > 0) await sleep(4000 * attempt);
          const text = await callLLM(prompt, maxTokens);
          console.log(`[extract-keywords] b${b} attempt${attempt} raw:`, text.slice(0, 150));
          rawKws = parseKeywordsFromLLM(text);
          if (rawKws.length >= Math.floor(batch.length * 0.8)) break; // accept if ≥80% returned
        } catch (e) {
          console.error(`[extract-keywords] b${b} attempt${attempt} error:`, e);
        }
      }

      console.log(`[extract-keywords] b${b}: LLM returned ${rawKws.length}/${batch.length}`);

      // Resolve each subtitle slot
      for (let i = 0; i < batch.length; i++) {
        const raw = rawKws[i] ?? "";
        if (isValidKeyword(raw)) {
          const norm = normalizeKeyword(raw);
          if (!globalUsed.has(norm)) {
            globalUsed.add(norm);
            allKeywords.push(norm);
            continue;
          }
          // Try angle suffix variants
          let found = false;
          for (const suffix of ANGLE_SUFFIXES) {
            const v = `${norm} ${suffix}`;
            if (!globalUsed.has(v)) {
              globalUsed.add(v);
              allKeywords.push(v);
              found = true;
              break;
            }
          }
          if (found) continue;
        }
        // Use fallback pool
        allKeywords.push(nextFallback());
      }
    }

    console.log(`[extract-keywords] done: ${allKeywords.length} keywords for ${subtitleList.length} subtitles`);
    return NextResponse.json({
      keywords: allKeywords,
      sceneClipCounts: allKeywords.map(() => 1),
      sceneDurations: subtitleList.map(() => 3),
      keywordsPerScene: 1,
    });
  }

  // ── Normal mode (scene-based) ──
  const rawScript = Array.isArray(scenes) && scenes.length > 0 ? scenes.join(" ") : (script ?? "");
  const cleanScript = preprocessScript(rawScript);
  if (!cleanScript) return NextResponse.json({ error: "script or scenes required" }, { status: 400 });

  const prompt = `You are a professional video editor for TikTok/Reels short-form videos.

Given this Thai script, decide how many B-roll clips are needed (roughly 1 clip per 3-5 seconds) and write the best English Pexels search query for each clip.

RULES:
- Each query: 2-5 English words, something a camera can physically film
- Translate Thai → concrete English visuals (people, places, objects, actions)
- Vary shots: wide → close → action → aerial → crowd
- Every query must be unique
- Match mood: dramatic=intense, financial=money/trading, science=lab

SCRIPT: "${cleanScript}"

Return ONLY valid JSON:
{"totalClips":<number>,"queries":["query1","query2",...]}`;

  let text = "{}";
  try {
    text = await callLLM(prompt, 4096);
    console.log(`[extract-keywords] normal mode raw:`, text.slice(0, 200));
  } catch (e) {
    console.error("[extract-keywords] LLM error:", e);
    return NextResponse.json({ error: `LLM failed: ${e instanceof Error ? e.message : e}` }, { status: 500 });
  }

  try {
    const queries = parseKeywordsFromLLM(text);
    if (queries.length === 0) throw new Error("empty queries");

    const sceneList: string[] = Array.isArray(scenes) && scenes.length > 0
      ? scenes : cleanScript.split(/\n+/).filter(Boolean);
    const numScenes = Math.max(1, sceneList.length);
    const perScene = Math.ceil(queries.length / numScenes);
    const sceneClipCounts = sceneList.map((_, i) => Math.min(perScene, queries.length - i * perScene)).filter(c => c > 0);
    const sceneDurations = sceneList.map(s => Math.max(5, Math.ceil(s.replace(/\s/g, "").length / 3)));

    console.log(`[extract-keywords] ${queries.length} keywords for ${numScenes} scenes`);
    return NextResponse.json({ keywords: queries, scenes: sceneList, keywordsPerScene: perScene, sceneClipCounts, sceneDurations });
  } catch (e) {
    console.error("[extract-keywords] parse error:", e, "raw:", text.slice(0, 300));
    return NextResponse.json({ keywords: [], scenes: [], keywordsPerScene: 3, sceneClipCounts: [], sceneDurations: [] });
  }
}
