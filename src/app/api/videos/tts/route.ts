import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";

export const maxDuration = 120;
export const runtime = "nodejs";

// POST /api/videos/tts
// Body: { text, voiceId? }
// Returns: { voiceUrl, filename }
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { text, voiceId = "9lvVsLbaxGND6aZnt1W1", languageCode = "th" } = body ?? {};
  if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { elevenlabsKey: true },
  });
  if (!user?.elevenlabsKey) return NextResponse.json({ error: "ElevenLabs API key not set", missingKey: "elevenlabs" }, { status: 400 });
  const apiKey = Buffer.from(user.elevenlabsKey, "base64").toString("utf-8");

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: text.trim(),
      model_id: "eleven_v3",
      language_code: languageCode,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[tts] ElevenLabs error:", res.status, err);
    // If language_code caused the error, retry without it
    if (languageCode) {
      console.log("[tts] retrying without language_code...");
      const retry = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text.trim(),
          model_id: "eleven_v3",
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true },
        }),
      });
      if (retry.ok) {
        const rendersDir = path.join(process.cwd(), "public", "renders");
        fs.mkdirSync(rendersDir, { recursive: true });
        const filename = `tts-${Date.now()}.mp3`;
        const outPath = path.join(rendersDir, filename);
        fs.writeFileSync(outPath, Buffer.from(await retry.arrayBuffer()));
        return NextResponse.json({ voiceUrl: `/renders/${filename}` });
      }
      const retryErr = await retry.text();
      console.error("[tts] retry also failed:", retry.status, retryErr);
    }
    return NextResponse.json({ error: `ElevenLabs failed (${res.status}): ${err.slice(0, 200)}` }, { status: 500 });
  }

  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });

  const filename = `tts-${Date.now()}.mp3`;
  const outPath = path.join(rendersDir, filename);
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));

  return NextResponse.json({ voiceUrl: `/renders/${filename}` });
}
