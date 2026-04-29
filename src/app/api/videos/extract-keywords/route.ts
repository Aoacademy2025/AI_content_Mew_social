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

// POST /api/videos/extract-keywords
// Body: { script } OR { scenes: string[] }
// Returns: { keywords: string[] } — one per scene (Pexels search terms in English)
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { script, scenes } = body ?? {};

  // Support both: scenes array (preferred) or plain script (split by newline)
  const sceneList: string[] = Array.isArray(scenes) && scenes.length > 0
    ? scenes
    : (script ?? "").split(/\n+/).map((s: string) => s.trim()).filter((s: string) => s.length > 0);

  if (!sceneList.length) return NextResponse.json({ error: "script or scenes required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { geminiKey: true, openaiKey: true, ttsProvider: true } });
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

  const fullScript = sceneList.join(" ");

  // Estimate duration per scene: Thai speech ~3 chars/sec, min 5s per scene
  const sceneDurations = sceneList.map(s => Math.max(5, Math.ceil(s.replace(/\s/g, "").length / 3)));
  const totalEstimatedSec = sceneDurations.reduce((a, b) => a + b, 0);
  // Target: 1 unique keyword per 3s of content (+30% buffer), min 2 per scene, cap total at 15
  const rawClipsPerScene = sceneDurations.map(d => Math.max(2, Math.ceil((d / 3) * 1.3)));
  const rawTotal = rawClipsPerScene.reduce((a, b) => a + b, 0);
  const MAX_TOTAL_CLIPS = 15;
  const scale = rawTotal > MAX_TOTAL_CLIPS ? MAX_TOTAL_CLIPS / rawTotal : 1;
  const clipsPerScene = rawClipsPerScene.map(c => Math.max(1, Math.round(c * scale)));
  const totalClips = clipsPerScene.reduce((a, b) => a + b, 0);
  const scenesText = sceneList
    .map((s, i) => `Scene ${i + 1} (${sceneDurations[i]}s, need ${clipsPerScene[i]} unique clips): ${s}`)
    .join("\n");

  const prompt = `You are a professional video editor sourcing B-roll footage from Pexels for a vertical short-form video (TikTok/Reels style).

VIDEO STATS:
- Total estimated duration: ${totalEstimatedSec}s
- Total unique clip queries needed: ${totalClips}
- Scenes: ${sceneList.length}

FULL SCRIPT: "${fullScript}"

SCENES (each line = one scene, with how many unique Pexels search queries it needs):
${scenesText}

RULES:
1. Output EXACTLY the number of queries listed for each scene — no more, no less
2. Every query across the ENTIRE JSON must be globally unique (never repeat a noun or visual)
3. If script is Thai → translate the core visual subject to English first, then write the query
4. Queries must describe something a camera can physically film (no abstract concepts)
5. Within a scene: vary the shot — wide → close-up → action → aerial → crowd (never same angle twice)
6. Across scenes: if same topic continues, change subject within that domain
   e.g. war scene: soldier running → tank firing → explosion debris → jet bombing → civilians fleeing
7. Match the energy of the content:
   - Action/conflict → fire, explosion, running, crash, debris
   - Wealth/money → gold coins, luxury car, mansion interior, cash stack
   - Technology → circuit board close-up, server room, typing hands, drone aerial
8. BANNED words: concept, idea, success, growth, abstract, metaphor, symbol, innovation

OUTPUT FORMAT — return ONLY valid JSON, no markdown, no explanation:
[
  {
    "scene": 1,
    "duration_seconds": ${sceneDurations[0] ?? 10},
    "clips_needed": ${clipsPerScene[0] ?? 4},
    "queries": ["query1", "query2", ...]
  }
]

CRITICAL: The total number of queries across all scenes must equal ${totalClips}. Every query must be unique.`;

  let text = "[]";
  if (useGemini) {
    try {
      text = await geminiGenerateText(apiKey, prompt, 8000);
      console.log(`[extract-keywords] Gemini OK`);
    } catch (e) {
      console.error("[extract-keywords] Gemini error:", e);
      return NextResponse.json({ error: `Gemini failed: ${e instanceof Error ? e.message : e}` }, { status: 500 });
    }
  } else {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: 8000, temperature: 0.4 }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[extract-keywords] OpenAI error:", res.status, errText);
      return NextResponse.json({ error: `OpenAI failed (${res.status}): ${errText.slice(0, 200)}` }, { status: 500 });
    }
    const data = await res.json();
    text = data.choices?.[0]?.message?.content ?? "[]";
  }

  try {
    const match = text.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(match?.[0] ?? "[]");

    // Parse scene objects: { scene, duration_seconds, clips_needed, queries }
    let nested: string[][];
    let sceneClipCounts: number[] = [];

    if (Array.isArray(parsed[0])) {
      nested = parsed as string[][];
      sceneClipCounts = nested.map(q => q.length);
    } else if (parsed[0]?.queries) {
      const objs = parsed as { queries: string[]; clips_needed?: number }[];
      nested = objs.map(s => s.queries);
      sceneClipCounts = objs.map(s => s.queries.length);
    } else {
      nested = [parsed as string[]];
      sceneClipCounts = [nested[0].length];
    }

    const keywords: string[] = nested.flat();
    // keywordsPerScene: max clips in any single scene (used by generate-config for window mapping)
    const keywordsPerScene = sceneClipCounts.length > 0
      ? Math.max(...sceneClipCounts)
      : Math.round(keywords.length / Math.max(1, nested.length));

    console.log(`[extract-keywords] ${sceneList.length} scenes → ${keywords.length} keywords, max ${keywordsPerScene}/scene`);
    console.log(`[extract-keywords] scene clip counts:`, sceneClipCounts);

    return NextResponse.json({
      keywords,
      scenes: sceneList,
      keywordsPerScene,
      sceneClipCounts,   // per-scene clip counts for generate-config
      sceneDurations,    // estimated durations per scene
    });
  } catch {
    return NextResponse.json({ keywords: [], scenes: sceneList, keywordsPerScene: 3, sceneClipCounts: [], sceneDurations: [] });
  }
}
