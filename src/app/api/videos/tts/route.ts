import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { fetchWithBudget } from "@/lib/fetch-budget";
import { classifyHttpStatus, isProviderError, providerError, toErrorResponse } from "@/lib/provider-errors";

export const maxDuration = 300; // TTS budget is 300s/attempt (long scripts)
export const runtime = "nodejs";

// POST /api/videos/tts
// Body: { text, voiceId? }
// Returns: { voiceUrl, filename }
export async function POST(req: Request) {
  try {
    return await handleTts(req);
  } catch (error) {
    if (isProviderError(error)) {
      console.error(`[tts] ${error.provider}/${error.code}:`, error.message);
      const { body: errBody, status } = toErrorResponse(error);
      return NextResponse.json(errBody, { status });
    }
    console.error("[tts] unexpected error:", error);
    return NextResponse.json({ error: "ระบบเสียงทำงานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" }, { status: 500 });
  }
}

async function handleTts(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { text, voiceId = "9lvVsLbaxGND6aZnt1W1", languageCode = "th" } = body ?? {};
  if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { id: authUser.id },
    select: { elevenlabsKey: true, plan: true },
  });
  if (user?.plan === "FREE") return NextResponse.json({ error: "ElevenLabs TTS ใช้ได้เฉพาะแผน Pro ขึ้นไป" }, { status: 403 });
  if (!user?.elevenlabsKey) return NextResponse.json({ error: "ElevenLabs API key not set", missingKey: "elevenlabs" }, { status: 400 });
  const apiKey = Buffer.from(user.elevenlabsKey, "base64").toString("utf-8");

  // retries: 0 — TTS POST spends user character credits; a client-side timeout after server-side success would double-charge on retry (same policy as HeyGen generate)
  // returnHttpErrors keeps the language_code-fallback logic below working.
  const res = await fetchWithBudget(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: text.trim(),
      model_id: "eleven_v3",
      language_code: languageCode,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true },
    }),
  }, { provider: "elevenlabs", timeoutMs: 300_000, retries: 0, wallClockMs: 660_000, returnHttpErrors: true });

  if (!res.ok) {
    const err = await res.text();
    console.error("[tts] ElevenLabs error:", res.status, err);
    // If language_code caused the error, retry without it
    if (languageCode) {
      console.log("[tts] retrying without language_code...");
      const retry = await fetchWithBudget(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text.trim(),
          model_id: "eleven_v3",
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true },
        }),
      }, { provider: "elevenlabs", timeoutMs: 300_000, retries: 0, wallClockMs: 320_000, returnHttpErrors: true });
      if (retry.ok) {
        const rendersDir = path.join(process.cwd(), "public", "renders");
        fs.mkdirSync(rendersDir, { recursive: true });
        const filename = `tts-${Date.now()}.mp3`;
        const outPath = path.join(rendersDir, filename);
        fs.writeFileSync(outPath, Buffer.from(await retry.arrayBuffer()));
        return NextResponse.json({ voiceUrl: `/api/renders/${filename}` });
      }
      const retryErr = await retry.text();
      console.error("[tts] retry also failed:", retry.status, retryErr);
    }
    // ElevenLabs ส่ง quota หมดเป็น 401 + "quota_exceeded" — แยกจาก key ผิด
    const code = err.includes("quota_exceeded") ? ("quota" as const) : classifyHttpStatus(res.status);
    const pErr = providerError(code, "elevenlabs", `ElevenLabs failed (${res.status}): ${err.slice(0, 200)}`, { status: res.status });
    const { body: errBody, status } = toErrorResponse(pErr);
    return NextResponse.json(errBody, { status });
  }

  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });

  const filename = `tts-${Date.now()}.mp3`;
  const outPath = path.join(rendersDir, filename);
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));

  return NextResponse.json({ voiceUrl: `/api/renders/${filename}` });
}
