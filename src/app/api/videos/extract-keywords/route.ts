import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { geminiGenerateText } from "@/lib/gemini";

export const maxDuration = 30;
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

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { script, scenes, perSubtitle = false } = body ?? {};

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { geminiKey: true, openaiKey: true, ttsProvider: true },
  });
  let apiKey = process.env.SERVER_OPENAI_API_KEY || null;
  let useGemini = false;
  if (!apiKey) {
    const preferGemini = user?.ttsProvider === "gemini";
    const preferOpenAI = user?.ttsProvider === "elevenlabs" || user?.ttsProvider === "openai";
    if (preferGemini && user?.geminiKey) { apiKey = decrypt(user.geminiKey); useGemini = true; }
    else if (preferOpenAI && user?.openaiKey) { apiKey = decrypt(user.openaiKey); }
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

    const prompt = `You are a professional B-roll video editor for TikTok/Reels short-form videos.

I have a Thai script split into subtitle phrases. For each phrase, choose the single best English Pexels search query that visually represents that moment on screen.

RULES:
- Output ONLY a valid JSON array of strings — one query per subtitle, same order, same count
- Each query must be 2-5 English words describing something a camera can physically film
- Translate Thai content into concrete English visuals (people, places, objects, actions)
- Vary shots across phrases: wide shot, close-up, aerial, slow motion, action
- Make each query unique — no two phrases should have the same query
- Match the mood: dramatic → tense scene, happy → bright colorful scene, financial → money/charts

SUBTITLE PHRASES:
${subtitleList.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Return ONLY JSON array with exactly ${subtitleList.length} strings:`;

    let kwText = "[]";
    try {
      if (useGemini) {
        kwText = await geminiGenerateText(apiKey!, prompt, 2048);
      } else {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: 2048, temperature: 0.5, response_format: { type: "json_object" } }),
        });
        if (r.ok) { const d = await r.json(); kwText = d.choices?.[0]?.message?.content ?? "[]"; }
      }
    } catch (e) {
      console.error("[extract-keywords] perSubtitle LLM error:", e);
    }

    try {
      const match = kwText.match(/\[[\s\S]*\]/);
      const parsed: string[] = JSON.parse(match?.[0] ?? "[]");
      const keywords = parsed.filter((k): k is string => typeof k === "string" && k.trim().length > 0);
      console.log(`[extract-keywords] perSubtitle: ${keywords.length} keywords for ${subtitleList.length} subtitles`);
      return NextResponse.json({
        keywords,
        sceneClipCounts: keywords.map(() => 1),
        sceneDurations: subtitleList.map(() => 3),
        keywordsPerScene: 1,
      });
    } catch {
      return NextResponse.json({ keywords: [], sceneClipCounts: [], sceneDurations: [], keywordsPerScene: 1 });
    }
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
