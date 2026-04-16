import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const maxDuration = 30;
export const runtime = "nodejs";

function decrypt(k: string) {
  return Buffer.from(k, "base64").toString("utf-8");
}

/**
 * POST /api/videos/align-scenes
 * Body: { scenes: string[], whisperWords: { word, startMs, endMs }[] }
 *
 * Uses GPT to find which whisper word index each scene starts at,
 * based on text similarity between script scenes and Whisper transcript.
 * Returns: { boundaries: number[] } — word index where each scene starts (length = scenes.length)
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const {
    scenes,
    whisperWords,
  }: {
    scenes: string[];
    whisperWords: { word: string; startMs: number; endMs: number }[];
  } = body ?? {};

  if (!scenes?.length || !whisperWords?.length) {
    return NextResponse.json({ error: "scenes and whisperWords required" }, { status: 400 });
  }

  let apiKey = process.env.SERVER_OPENAI_API_KEY || null;
  if (!apiKey) {
    const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { openaiKey: true } });
    if (!user?.openaiKey) return NextResponse.json({ error: "OpenAI key not set", missingKey: "openai" }, { status: 400 });
    apiKey = decrypt(user.openaiKey);
  }

  // Build whisper transcript with word indices for GPT to reference
  const transcript = whisperWords.map((w, i) => `[${i}]${w.word}`).join(" ");
  const sceneList = scenes.map((s, i) => `${i + 1}. ${s}`).join("\n");

  const prompt = `You are a speech alignment expert. Match each Thai script scene to where it starts in the Whisper word list.

Script scenes (${scenes.length} scenes):
${sceneList}

Whisper word list (index[word]):
${transcript}

Task: For each scene, find the word index where that scene begins in the whisper transcript.
- Scene 1 always starts at index 0
- Each scene must start AFTER the previous scene starts
- Find the closest matching content, accounting for slight Whisper transcription variations
- Return ONLY a JSON array of ${scenes.length} integers (word indices), one per scene
- Example for 3 scenes: [0, 45, 89]`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      temperature: 0,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    return NextResponse.json({ error: `OpenAI failed: ${err.slice(0, 200)}` }, { status: 500 });
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "[]";

  try {
    const match = text.match(/\[[\d,\s]+\]/);
    const parsed: number[] = JSON.parse(match?.[0] ?? "[]");

    if (!Array.isArray(parsed) || parsed.length !== scenes.length) {
      throw new Error("bad length");
    }

    // Validate: must be strictly non-decreasing, within bounds
    const W = whisperWords.length;
    const validated = parsed.map((v, i) => {
      const clamped = Math.max(i === 0 ? 0 : parsed[i - 1], Math.min(W - 1, Math.round(v)));
      return clamped;
    });

    return NextResponse.json({ boundaries: validated });
  } catch {
    // Fallback: proportional split
    const charCounts = scenes.map(s => Math.max(1, s.replace(/\s/g, "").length));
    const totalChars = charCounts.reduce((a, b) => a + b, 0);
    const boundaries: number[] = [];
    let cum = 0;
    for (const count of charCounts) {
      boundaries.push(Math.round((cum / totalChars) * whisperWords.length));
      cum += count;
    }
    return NextResponse.json({ boundaries });
  }
}
