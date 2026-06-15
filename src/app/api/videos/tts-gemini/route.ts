import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import { getGeminiErrorInfo } from "@/lib/gemini-errors";
import path from "path";
import fs from "fs";
import { setGlobalDispatcher, Agent } from "undici";

// Long scripts (5-6 min) produce large base64 audio responses — extend timeouts
setGlobalDispatcher(new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }));

export const maxDuration = 300;
export const runtime = "nodejs";

// POST /api/videos/tts-gemini
// Body: { text, voiceName? }
// Returns: { voiceUrl }
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => null);
    const { text, voiceName = "Aoede" } = body ?? {};
    if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });

    // Get user's Gemini key
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { geminiKey: true },
    });
    if (!user?.geminiKey) {
      return NextResponse.json({ error: "Gemini API key not set", missingKey: "gemini" }, { status: 400 });
    }
    const apiKey = Buffer.from(user.geminiKey, "base64").toString("utf-8");

    // Gemini TTS — prefer 2.5 Flash TTS first because it is the expected low-cost path.
    // Newer preview models can have stricter access/quota, so keep them as fallbacks only.
    // Send key as both ?key= query param AND x-goog-api-key header to support both
    // classic AIza* keys and newer AQ.* keys.
    const requestBody = JSON.stringify({
      contents: [{ parts: [{ text: text.trim() }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    });

    const MODEL_CHAIN = [
      "gemini-2.5-flash-preview-tts",   // widely available preview
      "gemini-3.1-flash-tts-preview",   // newer preview, may be restricted
      "gemini-2.5-pro-preview-tts",     // last resort
    ];

    // For each model: retry transient errors with exponential backoff.
    // For auth/access errors (401/403/404): try next model in the chain.
    let res: Response | null = null;
    let lastErrBody = "";
    let usedModel = "";
    const MAX_ATTEMPTS = 3;

    outer:
    for (const model of MODEL_CHAIN) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: requestBody,
        });

        if (res.ok) {
          usedModel = model;
          console.log(`[tts-gemini] ok with ${model} (attempt ${attempt})`);
          break outer;
        }

        lastErrBody = await res.text();

        // Auth / model-access errors → try next model (don't retry same one)
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          console.warn(`[tts-gemini] ${model} returned ${res.status} — trying next model`);
          break;  // exit inner retry loop, move to next model
        }

        // 400 = bad request, won't get better by retrying or switching model
        if (res.status === 400) {
          console.error(`[tts-gemini] bad request (400) for ${model}:`, lastErrBody.slice(0, 200));
          break outer;
        }

        // Retryable transient (429, 500, 502, 503, 504) — backoff and retry SAME model
        if (attempt < MAX_ATTEMPTS) {
          const delayMs = 1500 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
          console.warn(`[tts-gemini] ${model} transient ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}), retry in ${delayMs}ms`);
          await new Promise(r => setTimeout(r, delayMs));
        } else {
          console.warn(`[tts-gemini] ${model} exhausted retries — trying next model`);
        }
      }
    }

    if (!res || !res.ok) {
      const status = res?.status ?? 500;
      if (status === 401) {
        return NextResponse.json({
          error: "Gemini API Key ไม่ถูกต้อง — Key นี้ไม่มีสิทธิ์ใช้ TTS preview models (ลองทั้ง 3 models แล้ว). กรุณาสร้าง key ใหม่จาก aistudio.google.com แล้วใส่ใน Settings",
          missingKey: "gemini",
        }, { status: 401 });
      }
      if (status === 403) {
        // Distinguish "API not enabled" from "key valid but lacks TTS access"
        const isApiDisabled = lastErrBody.includes("SERVICE_DISABLED") || lastErrBody.includes("has not been used") || lastErrBody.includes("PERMISSION_DENIED");
        if (isApiDisabled) {
          return NextResponse.json({
            error: "Generative Language API ยังไม่ได้เปิดในโปรเจกต์ Google Cloud ของคุณ → เข้า console.cloud.google.com → APIs & Services → Library → ค้น 'Generative Language API' → Enable",
            retryable: false,
          }, { status: 403 });
        }
        return NextResponse.json({
          error: "Gemini key นี้ไม่มีสิทธิ์ใช้ TTS preview models — ลองสร้าง key ใหม่ที่ aistudio.google.com/apikey หรือสลับเป็น ElevenLabs",
          retryable: false,
        }, { status: 403 });
      }
      if (status === 404) {
        return NextResponse.json({
          error: "ไม่พบ Gemini TTS model ที่ใช้งานได้ในบัญชีของคุณ — ลองสลับเป็น ElevenLabs ก่อน",
          retryable: false,
        }, { status: 404 });
      }
      if (status === 429) {
        const info = getGeminiErrorInfo(lastErrBody, status);
        return NextResponse.json({
          error: info.userMessage,
          retryable: info.retryable,
          provider: "gemini",
          reason: info.kind,
        }, { status: info.status });
      }
      const info = getGeminiErrorInfo(lastErrBody, status);
      if (info.kind !== "unknown") {
        return NextResponse.json({
          error: info.userMessage,
          retryable: info.retryable,
          provider: "gemini",
          reason: info.kind,
        }, { status: info.status });
      }
      return NextResponse.json({
        error: `Gemini TTS ฝั่ง Google ขัดข้องชั่วคราว (${status}) — ลองอีก 1-2 นาที หรือสลับเป็น ElevenLabs`,
        retryable: true,
      }, { status: 503 });
    }
    void usedModel; // for future telemetry

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
    try {
      const rendersDir = path.join(process.cwd(), "public", "renders");
      fs.mkdirSync(rendersDir, { recursive: true });
      const filename = `tts-${Date.now()}.wav`;
      const outPath = path.join(rendersDir, filename);
      fs.writeFileSync(outPath, wavBuffer);
      console.log("[tts-gemini] saved audio to", filename);
      return NextResponse.json({ voiceUrl: `/api/renders/${filename}` });
    } catch (writeErr) {
      console.error("[tts-gemini] file write error:", writeErr);
      return apiError({ route: "POST /api/videos/tts-gemini (file write)", error: writeErr, notifyUser: true });
    }
  } catch (error) {
    console.error("[tts-gemini] top-level error:", error);
    return apiError({ route: "POST /api/videos/tts-gemini", error, notifyUser: true });
  }
}
