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

function normalizeKeyword(k: string): string {
  return k.replace(/\s+/g, " ").replace(/[^a-zA-Z0-9\s-]/g, "").trim().toLowerCase();
}

function extractQuotedStringArray(raw: string): string[] {
  // Strip markdown code fences Gemini sometimes adds
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const objMatch = stripped.match(/\{[\s\S]*\}/);
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
  // Fallback: extract quoted strings
  const quoted = stripped.match(/"([^"]{3,200})"/g);
  if (!quoted) return [];
  return quoted.map(s => s.slice(1, -1).trim()).filter(Boolean);
}

function buildFallbackKeyword(index: number): string {
  return FALLBACK_POOL[index % FALLBACK_POOL.length];
}

function ensureKeywordsShape(keywords: string[], expectedCount: number, globalUsed: Set<string>, batchOffset: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < expectedCount; i++) {
    const raw = keywords[i] ?? "";
    const hasThai = THAI_RE.test(raw);
    const norm = normalizeKeyword(raw);
    const wc = norm.split(" ").filter(Boolean).length;
    const valid = !hasThai && norm.length >= 4 && wc >= 2 && wc <= 8;

    if (valid && !globalUsed.has(norm)) {
      globalUsed.add(norm);
      out.push(norm);
      continue;
    }

    // Find next unused fallback
    let pushed = false;
    for (let fi = 0; fi < FALLBACK_POOL.length * 2; fi++) {
      const fb = buildFallbackKeyword(batchOffset + i + fi);
      if (!globalUsed.has(fb)) {
        globalUsed.add(fb);
        out.push(fb);
        pushed = true;
        break;
      }
    }
    if (!pushed) {
      const unique = `${norm || "scene"} ${batchOffset + i}`;
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
      ? scenes
      : (script ?? "").split(/\n+/).map((s: string) => s.trim()).filter(Boolean);

    if (!subtitleList.length) return NextResponse.json({ error: "script or scenes required" }, { status: 400 });

    const BATCH_SIZE = 30;
    const batches: string[][] = [];
    for (let i = 0; i < subtitleList.length; i += BATCH_SIZE) {
      batches.push(subtitleList.slice(i, i + BATCH_SIZE));
    }

    console.log(`[extract-keywords] perSubtitle: ${subtitleList.length} subtitles → ${batches.length} batches (${useGemini ? "Gemini" : "OpenAI"})`);

    const allKeywords: string[] = [];
    const globalUsed = new Set<string>();

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];

      // Delay between batches to stay within rate limits
      if (b > 0) await new Promise(r => setTimeout(r, 3000));

      const prompt = `You are a professional B-roll video editor for TikTok/Reels short-form videos.

For each Thai subtitle phrase below, write ONE English Pexels search query that visually matches it.

RULES:
- Output ONLY: {"keywords":["query1","query2",...]}
- Exactly ${batch.length} queries, same order as subtitles
- English only — no Thai characters
- 2-5 words per query, something a camera can physically film
- Translate Thai meaning into visual English (person/place/object/action)
- All queries must be unique
- Vary shot styles: wide, close-up, aerial, slow motion, action

SUBTITLE PHRASES (${b * BATCH_SIZE + 1}–${b * BATCH_SIZE + batch.length}):
${batch.map((s, i) => `${b * BATCH_SIZE + i + 1}. ${s}`).join("\n")}

JSON only:`;

      const maxTokens = Math.min(2048, batch.length * 30 + 200);
      let rawKws: string[] = [];

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) await new Promise(r => setTimeout(r, 4000 * attempt));
          const text = await callLLM(prompt, maxTokens);
          console.log(`[extract-keywords] b${b} attempt${attempt}:`, text.slice(0, 120));
          rawKws = extractQuotedStringArray(text);
          if (rawKws.length > 0) break;
        } catch (e) {
          console.error(`[extract-keywords] b${b} attempt${attempt} error:`, e);
        }
      }

      const batchOut = ensureKeywordsShape(rawKws, batch.length, globalUsed, b * BATCH_SIZE);
      console.log(`[extract-keywords] b${b}: ${batchOut.length}/${batch.length} keywords`);
      allKeywords.push(...batchOut);
    }

    console.log(`[extract-keywords] done: ${allKeywords.length}/${subtitleList.length}`);
    return NextResponse.json({
      keywords: allKeywords,
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

SCRIPT: "${cleanScript}"

Return ONLY valid JSON:
{"totalClips":<number>,"queries":["query1","query2",...]}`;

  try {
    const text = await callLLM(prompt, 4096);
    console.log(`[extract-keywords] normal mode:`, text.slice(0, 200));
    const queries = extractQuotedStringArray(text);
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
    console.error("[extract-keywords] error:", e);
    return NextResponse.json({ keywords: [], scenes: [], keywordsPerScene: 3, sceneClipCounts: [], sceneDurations: [] });
  }
}
