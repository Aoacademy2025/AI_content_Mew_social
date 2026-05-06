import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { geminiGenerateText } from "@/lib/gemini";

export const maxDuration = 300; // 5 min — batched LLM calls for 100+ subtitles
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

function buildFallbackKeyword(_phrase: string, index: number, batchOffset: number): string {
  const fallbackPool = [
    "cinematic wide street shot",
    "person walking in city",
    "nature landscape aerial view",
    "office workspace close up",
    "business team meeting room",
    "city skyline at dusk",
    "hands typing on laptop",
    "documents on office desk",
    "futuristic technology screen",
    "dramatic portrait lighting studio",
    "coffee shop busy crowd",
    "sunset highway road trip",
    "scientist working laboratory",
    "athlete running stadium",
    "chef cooking restaurant kitchen",
    "drone aerial cityscape shot",
    "stock market trading floor",
    "mountain summit sunrise fog",
    "underwater ocean coral reef",
    "engineer inspecting machinery factory",
    "crowd cheering concert stage",
    "child playing outdoor park",
    "doctor hospital medical equipment",
    "rocket launch space debris",
  ];
  // Always return pure English from the pool — never prepend Thai phrase text
  return fallbackPool[(batchOffset + index) % fallbackPool.length];
}

function extractQuotedStringArray(raw: string): string[] {
  // Strip markdown code fences that Gemini sometimes wraps around JSON
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const inObj = stripped.match(/\{[\s\S]*\}/)?.[0];
  try {
    const parsed = inObj ? JSON.parse(inObj) : null;
    const arr: unknown[] = Array.isArray(parsed?.keywords) ? parsed.keywords : Array.isArray(parsed) ? parsed : [];
    return arr.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim());
  } catch {
    // Fallback: parse manually quoted strings
    const arr = stripped.match(/"([^"]{3,200})"/g);
    if (!arr) return [];
    return arr.map((s) => s.replace(/^"|"$/g, "").trim()).filter(Boolean);
  }
}

function normalizeKeyword(keyword: string): string {
  return keyword
    .replace(/\s+/g, " ")
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .trim()
    .toLowerCase();
}

const THAI_RE = /[฀-๿]/;

// Angle suffixes to make near-duplicate keywords unique while keeping meaning
const ANGLE_SUFFIXES = ["close up", "wide shot", "aerial view", "slow motion", "detail shot", "action shot", "portrait", "establishing shot"];

function ensureKeywordsShape(keywords: string[], expectedCount: number, batch: string[], batchOffset: number): string[] {
  const out: string[] = [];
  const used = new Set<string>();

  for (let i = 0; i < expectedCount; i++) {
    const raw = keywords[i] ?? "";
    const hasThai = THAI_RE.test(raw);
    const norm = normalizeKeyword(raw);
    const wordCount = norm.split(" ").filter(Boolean).length;
    const isValid = !hasThai && norm.length >= 4 && wordCount >= 2 && wordCount <= 7;

    if (isValid && !used.has(norm)) {
      used.add(norm);
      out.push(norm);
      continue;
    }

    // Try angle suffix variation to make it unique instead of falling back to pool
    if (isValid) {
      for (const suffix of ANGLE_SUFFIXES) {
        const variant = `${norm} ${suffix}`;
        if (!used.has(variant)) {
          used.add(variant);
          out.push(variant);
          break;
        }
      }
      if (out.length === i + 1) continue;
    }

    // Last resort: fallback pool (only when LLM gave Thai or empty)
    const fb = buildFallbackKeyword(batch[i] ?? "", batchOffset + i, batchOffset);
    const fbVariant = used.has(fb) ? `${fb} ${ANGLE_SUFFIXES[i % ANGLE_SUFFIXES.length]}` : fb;
    used.add(fbVariant);
    out.push(fbVariant);
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
    if (wantGemini && user?.geminiKey) { apiKey = decrypt(user.geminiKey); useGemini = true; }
    else if (wantOpenAI && user?.openaiKey) { apiKey = decrypt(user.openaiKey); }
    else if (user?.geminiKey) { apiKey = decrypt(user.geminiKey); useGemini = true; }
    else if (user?.openaiKey) { apiKey = decrypt(user.openaiKey); }
    else return NextResponse.json({ error: "Gemini or OpenAI key not set", missingKey: "gemini" }, { status: 400 });
  }

  // perSubtitle mode: called after transcribe with subtitle phrases already split
  // LLM picks the best B-roll query for each phrase
  if (perSubtitle) {
    const subtitleList: string[] = Array.isArray(scenes) && scenes.length > 0
      ? scenes
      : (script ?? "").split(/\n+/).map((s: string) => s.trim()).filter(Boolean);

    if (!subtitleList.length) return NextResponse.json({ error: "script or scenes required" }, { status: 400 });

    // For long videos (many subtitles), split into batches of 30 to avoid token limits.
    // Each batch is a separate LLM call; results are concatenated in order.
    const BATCH_SIZE = 30;

    async function fetchKeywordBatch(batch: string[], startIdx: number, usedKeywords: string[]): Promise<string[]> {
      // Keep avoid list short to not bloat prompt — last 20 keywords only
      const avoidList = usedKeywords.length > 0
        ? `ALREADY USED — pick different visuals: ${usedKeywords.slice(-20).join("; ")}`
        : "";

      const prompt = `You are a professional B-roll video editor for TikTok/Reels short-form videos.

I have a Thai script split into subtitle phrases. For each phrase, choose the single best English Pexels search query that visually represents that moment on screen.

RULES:
- Output ONLY: {"keywords":["query1","query2",...]}
- Exactly ${batch.length} queries, same order as subtitles
- ENGLISH ONLY — never output Thai (ก-๙)
- 2-5 English words per query, something a camera can physically film
- Translate Thai → concrete English visuals (people, places, objects, actions)
- Each query MUST be unique — no duplicates within this response
- Vary shot types: wide, close-up, aerial, slow motion, action, drone, time lapse
- Match mood: dramatic=tense, science=lab/particles, financial=money/charts
${avoidList ? `- ${avoidList}` : ""}
SUBTITLE PHRASES (${startIdx + 1}–${startIdx + batch.length}):
${batch.map((s, i) => `${startIdx + i + 1}. ${s}`).join("\n")}

JSON only:`;

      // output tokens: ~25 per keyword + buffer
      const maxTokens = Math.min(4096, batch.length * 30 + 300);

      let kwText = "{}";
      if (useGemini) {
        kwText = await geminiGenerateText(apiKey!, prompt, maxTokens);
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
        if (r.ok) { const d = await r.json(); kwText = d.choices?.[0]?.message?.content ?? "{}"; }
      }

      const keywords = extractQuotedStringArray(kwText);
      console.log(`[extract-keywords] batch raw sample:`, kwText.slice(0, 200));
      console.log(`[extract-keywords] batch parsed ${keywords.length}/${batch.length}:`, keywords.slice(0, 3));
      if (keywords.length > 0) return keywords.slice(0, batch.length);
      return [];
    }

    // Split into batches and call LLM for each
    const allKeywords: string[] = [];
    const batches: string[][] = [];
    for (let i = 0; i < subtitleList.length; i += BATCH_SIZE) {
      batches.push(subtitleList.slice(i, i + BATCH_SIZE));
    }

    console.log(`[extract-keywords] perSubtitle: ${subtitleList.length} subtitles → ${batches.length} batches`);

    // Global used set — no keyword may repeat across all batches
    const globalUsed = new Set<string>();

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      let rawKws: string[] = [];

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));
          rawKws = await fetchKeywordBatch(batch, b * BATCH_SIZE, [...allKeywords]);
          if (rawKws.length >= batch.length) break;
        } catch (e) {
          console.error(`[extract-keywords] batch ${b} attempt ${attempt} error:`, e);
        }
      }

      // Resolve each slot: use LLM answer if valid+unique, else angle-variant, else fallback
      const batchOut: string[] = [];
      for (let i = 0; i < batch.length; i++) {
        const raw = rawKws[i] ?? "";
        const hasThai = THAI_RE.test(raw);
        const norm = normalizeKeyword(raw);
        const wc = norm.split(" ").filter(Boolean).length;
        const valid = !hasThai && norm.length >= 4 && wc >= 2 && wc <= 7;

        if (valid && !globalUsed.has(norm)) {
          globalUsed.add(norm);
          batchOut.push(norm);
          continue;
        }

        // Try angle suffix variants to keep meaning while making unique
        let pushed = false;
        if (valid) {
          for (const suffix of ANGLE_SUFFIXES) {
            const v = `${norm} ${suffix}`;
            if (!globalUsed.has(v)) {
              globalUsed.add(v);
              batchOut.push(v);
              pushed = true;
              break;
            }
          }
        }
        if (pushed) continue;

        // Fallback from pool — try until unique
        for (let fi = 0; fi < 48; fi++) {
          const fb = buildFallbackKeyword(batch[i], b * BATCH_SIZE + i + fi, b * BATCH_SIZE);
          if (!globalUsed.has(fb)) {
            globalUsed.add(fb);
            batchOut.push(fb);
            break;
          }
        }
        if (batchOut.length < i + 1) batchOut.push(`${norm || "scene"} shot ${b * BATCH_SIZE + i}`);
      }

      console.log(`[extract-keywords] batch ${b}: ${batchOut.length}/${batch.length} keywords`);
      allKeywords.push(...batchOut);
    }

    console.log(`[extract-keywords] perSubtitle: ${allKeywords.length} keywords for ${subtitleList.length} subtitles`);
    return NextResponse.json({
      keywords: allKeywords,
      sceneClipCounts: allKeywords.map(() => 1),
      sceneDurations: subtitleList.map(() => 3),
      keywordsPerScene: 1,
    });
  }

  // Normal mode: send full script to LLM, let it decide everything
  const rawScript = Array.isArray(scenes) && scenes.length > 0
    ? scenes.join(" ")
    : (script ?? "");

  const cleanScript = preprocessScript(rawScript);
  if (!cleanScript) return NextResponse.json({ error: "script or scenes required" }, { status: 400 });

  const prompt = `You are a professional video editor and content strategist for TikTok/Reels short-form videos.

I will give you a Thai script. Your job is to:
1. Understand the full meaning and story of the script
2. Decide how many B-roll clips are needed (based on script length and pacing — roughly 1 clip per 3-5 seconds)
3. For each clip, write the best English Pexels search query that visually matches that part of the story

RULES FOR QUERIES:
- Each query must be 2-5 English words describing something a camera can physically film
- Translate Thai content into concrete English visuals — people doing things, real places, real objects
- Vary the shots: wide establishing shot → close detail → action → reaction → aerial → crowd
- Match the emotional tone: dramatic script → intense visuals, financial script → money/trading, nature script → landscapes
- Every query must be unique — no repeats across the entire list
- Think cinematically: what would a film director cut to at each moment?

SCRIPT:
"${cleanScript}"

Return ONLY valid JSON in this exact format — no markdown, no explanation:
{
  "totalClips": <number>,
  "queries": ["query 1", "query 2", ...]
}`;

  let text = "{}";
  if (useGemini) {
    try {
      text = await geminiGenerateText(apiKey!, prompt, 4096);
      console.log(`[extract-keywords] Gemini raw:`, text.slice(0, 200));
    } catch (e) {
      console.error("[extract-keywords] Gemini error:", e);
      return NextResponse.json({ error: `Gemini failed: ${e instanceof Error ? e.message : e}` }, { status: 500 });
    }
  } else {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4096,
        temperature: 0.6,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return NextResponse.json({ error: `OpenAI failed (${res.status}): ${errText.slice(0, 200)}` }, { status: 500 });
    }
    const data = await res.json();
    text = data.choices?.[0]?.message?.content ?? "{}";
  }

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] ?? "{}");

    const queries: string[] = Array.isArray(parsed.queries)
      ? parsed.queries.filter((q: unknown): q is string => typeof q === "string" && q.trim().length > 0)
      : [];

    if (queries.length === 0) throw new Error("empty queries");

    // Distribute queries evenly across scenes for sceneClipCounts
    const sceneList: string[] = Array.isArray(scenes) && scenes.length > 0
      ? scenes
      : cleanScript.split(/\n+/).filter(Boolean);
    const numScenes = Math.max(1, sceneList.length);
    const perScene = Math.ceil(queries.length / numScenes);
    const sceneClipCounts = sceneList.map((_, i) => {
      const start = i * perScene;
      return Math.min(perScene, queries.length - start);
    }).filter(c => c > 0);

    const sceneDurations = sceneList.map(s => Math.max(5, Math.ceil(s.replace(/\s/g, "").length / 3)));

    console.log(`[extract-keywords] ${queries.length} keywords for ${numScenes} scenes`);

    return NextResponse.json({
      keywords: queries,
      scenes: sceneList,
      keywordsPerScene: perScene,
      sceneClipCounts,
      sceneDurations,
    });
  } catch (e) {
    console.error("[extract-keywords] parse error:", e, "raw:", text.slice(0, 300));
    return NextResponse.json({ keywords: [], scenes: [], keywordsPerScene: 3, sceneClipCounts: [], sceneDurations: [] });
  }
}
