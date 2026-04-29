import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import path from "path";
import fs from "fs";

export const maxDuration = 120;
export const runtime = "nodejs";

// POST /api/videos/tts-gemini
// Body: { text, voiceName? }
// Returns: { voiceUrl }
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => null);
    const { text, voiceName = "Aoede" } = body ?? {};
    if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });

    // Get user's Gemini key
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { geminiKey: true },
    });
    if (!user?.geminiKey) {
      return NextResponse.json({ error: "Gemini API key not set", missingKey: "gemini" }, { status: 400 });
    }
    const apiKey = Buffer.from(user.geminiKey, "base64").toString("utf-8");

    // Gemini TTS API (multimodal live / speech synthesis)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: text.trim() }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("[tts-gemini] error:", res.status, err);
      if (res.status === 401) {
        // API key invalid — prompt user to re-enter
        return NextResponse.json({ error: "Gemini API Key ไม่ถูกต้อง กรุณาตรวจสอบใน Settings", missingKey: "gemini" }, { status: 401 });
      }
      if (res.status === 403) {
        // Key valid but model not enabled for this account — don't prompt for key again
        return NextResponse.json({ error: "Gemini API Key ไม่มีสิทธิ์ใช้ TTS — กรุณาเปิดใช้งาน Gemini API ใน Google AI Studio ก่อน", retryable: false }, { status: 403 });
      }
      if (res.status === 404) {
        return NextResponse.json({ error: "ไม่พบ Gemini TTS model — กรุณาตรวจสอบว่า account รองรับ gemini-3.1-flash-tts-preview", retryable: false }, { status: 404 });
      }
      return NextResponse.json({ error: `Gemini TTS ไม่สำเร็จ (${res.status}): ${err.slice(0, 200)}` }, { status: 500 });
    }

    const data = await res.json();

    // Extract base64 audio from response
    const part = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    const audioB64: string | undefined = part?.data;
    const mimeType: string = part?.mimeType ?? "audio/L16;rate=24000";

    if (!audioB64) {
      return NextResponse.json({ error: "Gemini ไม่ส่งข้อมูลเสียงกลับมา" }, { status: 500 });
    }

    const pcmBuffer = Buffer.from(audioB64, "base64");

    // Parse sample rate from mimeType e.g. "audio/L16;rate=24000"
    const rateMatch = mimeType.match(/rate=(\d+)/);
    const sampleRate = rateMatch ? parseInt(rateMatch[1]) : 24000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);

    // Build WAV header (44 bytes)
    const wavHeader = Buffer.alloc(44);
    wavHeader.write("RIFF", 0);
    wavHeader.writeUInt32LE(36 + pcmBuffer.length, 4);
    wavHeader.write("WAVE", 8);
    wavHeader.write("fmt ", 12);
    wavHeader.writeUInt32LE(16, 16);           // subchunk1 size
    wavHeader.writeUInt16LE(1, 20);            // PCM format
    wavHeader.writeUInt16LE(numChannels, 22);
    wavHeader.writeUInt32LE(sampleRate, 24);
    wavHeader.writeUInt32LE(byteRate, 28);
    wavHeader.writeUInt16LE(blockAlign, 32);
    wavHeader.writeUInt16LE(bitsPerSample, 34);
    wavHeader.write("data", 36);
    wavHeader.writeUInt32LE(pcmBuffer.length, 40);

    const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);

    // Save to file
    const rendersDir = path.join(process.cwd(), "public", "renders");
    fs.mkdirSync(rendersDir, { recursive: true });
    const filename = `tts-${Date.now()}.wav`;
    const outPath = path.join(rendersDir, filename);
    fs.writeFileSync(outPath, wavBuffer);

    return NextResponse.json({ voiceUrl: `/api/renders/${filename}` });
  } catch (error) {
    return apiError({ route: "POST /api/videos/tts-gemini", error, notifyUser: true });
  }
}
