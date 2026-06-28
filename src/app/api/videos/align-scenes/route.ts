import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { geminiGenerateText } from "@/lib/gemini";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { checkAiInputCaps } from "@/lib/ai-input-caps";

export const maxDuration = 30;
export const runtime = "nodejs";

export async function POST(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { scenes, whisperWords }: {
    scenes: string[];
    whisperWords: { word: string; startMs: number; endMs: number }[];
  } = body ?? {};

  if (!scenes?.length || !whisperWords?.length) {
    return NextResponse.json({ error: "scenes and whisperWords required" }, { status: 400 });
  }
  const inputCaps = checkAiInputCaps({ scenes, words: whisperWords });
  if (!inputCaps.ok) return NextResponse.json({ error: inputCaps.message }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: authUser.id }, select: { geminiKey: true, plan: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  let apiKey: string;
  try {
    apiKey = resolveGeminiKey(user).key;
  } catch (e) {
    if (e instanceof KeyRequiredError) {
      return NextResponse.json({ code: "KEY_REQUIRED", action: "/settings?tab=api-keys" }, { status: 409 });
    }
    throw e;
  }

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

  try {
    const text = await geminiGenerateText(apiKey, prompt, 200);
    const match = text.match(/\[[\d,\s]+\]/);
    const parsed: number[] = JSON.parse(match?.[0] ?? "[]");

    if (!Array.isArray(parsed) || parsed.length !== scenes.length) throw new Error("bad length");

    const W = whisperWords.length;
    const validated = parsed.map((v, i) => {
      return Math.max(i === 0 ? 0 : parsed[i - 1], Math.min(W - 1, Math.round(v)));
    });

    return NextResponse.json({ boundaries: validated });
  } catch {
    // Fallback: proportional split by char count
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
