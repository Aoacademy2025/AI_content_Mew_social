import { execFile } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { checkMinuteQuota, reserveMinutes } from "@/lib/minute-limits";
import {
  estimateTtsAudioMinutes,
  reconcileAiAudioMinutes,
  refundAiAudioMinutes,
  reserveAiAudioMinutes,
} from "@/lib/ai-spend-limits";
import {
  isOmniVoiceUserAllowed,
  isValidOmniVoiceId,
  OmniVoiceConfigError,
  omnivoiceAuthHeaders,
  omnivoiceConfig,
  pcmFromWav,
  type OmniTtsResponse,
} from "@/lib/omnivoice";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { omnivoiceAdmission } from "@/lib/omnivoice-admission";
import {
  mergeSegmentTiming,
  pcmDurationMs,
  splitScriptForTts,
} from "@/lib/tts-timing";

export const maxDuration = 300;
export const runtime = "nodejs";

type OmniConfig = ReturnType<typeof omnivoiceConfig>;

type CallResult =
  | { ok: true; pcm: Buffer; sampleRate: number; generationTimeSec: number }
  | { ok: false; status: number; reason: string; retryAfter?: string };

async function callOmniVoice(
  config: OmniConfig,
  voiceId: string,
  text: string,
  speed: number,
  deadline: number,
): Promise<CallResult> {
  const remainingMs = deadline - Date.now();
  if (remainingMs < 1_000) return { ok: false, status: 504, reason: "request budget exhausted" };

  try {
    const response = await fetch(`${config.baseUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...omnivoiceAuthHeaders(config.apiKey) },
      body: JSON.stringify({
        voice_id: voiceId,
        text,
        speed,
        num_step: config.numStep,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(remainingMs),
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        reason: (await response.text().catch(() => "")).slice(0, 200),
        retryAfter: response.headers.get("retry-after") ?? undefined,
      };
    }

    const data = (await response.json()) as Partial<OmniTtsResponse>;
    if (typeof data.audio_base64 !== "string" || data.audio_base64.length === 0 || data.audio_base64.length > 30_000_000) {
      return { ok: false, status: 502, reason: "invalid audio payload" };
    }
    const { pcm, sampleRate } = pcmFromWav(Buffer.from(data.audio_base64, "base64"));
    return {
      ok: true,
      pcm,
      sampleRate,
      generationTimeSec: typeof data.generation_time === "number" ? data.generation_time : 0,
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      status: timedOut ? 504 : 503,
      reason: error instanceof Error ? error.message : "request failed",
    };
  }
}

function upstreamError(result: Extract<CallResult, { ok: false }>) {
  if (result.status === 404) {
    return NextResponse.json({ error: "ไม่พบเสียง OmniVoice ที่เลือก — กรุณาเลือกเสียงใหม่" }, { status: 404 });
  }
  if (result.status === 422) {
    return NextResponse.json({ error: "ข้อความไม่ผ่านการตรวจของ OmniVoice" }, { status: 422 });
  }
  if (result.status === 429) {
    return NextResponse.json(
      { error: "คิว OmniVoice เต็ม กรุณาลองใหม่ภายหลัง หรือสลับเป็น Gemini/ElevenLabs", retryable: true },
      { status: 429, headers: { "Retry-After": result.retryAfter ?? "30" } },
    );
  }
  console.error(`[tts-omnivoice] upstream status=${result.status} reason=${result.reason}`);
  return NextResponse.json(
    { error: "OmniVoice ขัดข้องชั่วคราว กรุณาลองใหม่หรือสลับเป็น Gemini/ElevenLabs", retryable: true },
    { status: result.status === 504 ? 504 : 503 },
  );
}

function wavFromPcm(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function saveWav(wav: Buffer): { voiceUrl: string; filePath: string } {
  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const filename = `tts-omni-${Date.now()}-${randomUUID().slice(0, 8)}.wav`;
  const filePath = path.join(rendersDir, filename);
  fs.writeFileSync(filePath, wav);
  return { voiceUrl: `/api/renders/${filename}`, filePath };
}

function detectSilences(wavPath: string): Promise<{
  midpoints: number[];
  intervals: { startMs: number; endMs: number }[];
}> {
  return new Promise((resolve) => {
    execFile(getFfmpegPath(), [
      "-i", wavPath,
      "-af", "silencedetect=noise=-30dB:d=0.25",
      "-f", "null", "-",
    ], { maxBuffer: 20 * 1024 * 1024, timeout: 30_000 }, (_error, _stdout, stderr) => {
      const midpoints: number[] = [];
      const intervals: { startMs: number; endMs: number }[] = [];
      const pattern = /silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(stderr || "")) !== null) {
        const start = Number.parseFloat(match[1]);
        const end = Number.parseFloat(match[2]);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
          midpoints.push(Math.round(((start + end) / 2) * 1000));
          intervals.push({ startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
        }
      }
      resolve({
        midpoints: midpoints.sort((a, b) => a - b),
        intervals: intervals.sort((a, b) => a.startMs - b.startMs),
      });
    });
  });
}

export async function POST(request: Request) {
  let aiReserveUserId: string | null = null;
  let aiReservedMin = 0;
  let aiReserveSettled = true;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isOmniVoiceUserAllowed(user.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const markReserved = (minutes: number) => {
      aiReserveUserId = user.id;
      aiReservedMin = minutes;
      aiReserveSettled = false;
    };
    const settleRefund = async () => {
      if (!aiReserveSettled && aiReservedMin > 0) {
        await refundAiAudioMinutes(user.id, aiReservedMin).catch(() => {});
      }
      aiReserveSettled = true;
    };
    const settleReconcile = async (actualMinutes: number) => {
      await reconcileAiAudioMinutes(user.id, aiReservedMin, actualMinutes, { enforce: true });
      aiReserveSettled = true;
    };

    const config = omnivoiceConfig();
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const fullText = typeof body?.text === "string" ? body.text.trim() : "";
    const voiceId = typeof body?.voiceId === "string" && body.voiceId.trim() ? body.voiceId.trim() : "voice_01";
    const preview = body?.preview === true;
    const parsedSpeed = typeof body?.speed === "number" ? body.speed : Number(body?.speed);
    const speed = Number.isFinite(parsedSpeed) ? Math.min(3, Math.max(0.3, parsedSpeed)) : 1;

    if (!fullText) return NextResponse.json({ error: "text required" }, { status: 400 });
    if (!isValidOmniVoiceId(voiceId)) return NextResponse.json({ error: "voiceId ไม่ถูกต้อง" }, { status: 400 });
    if (preview) {
      return NextResponse.json({ error: "ใช้เสียงตัวอย่างที่เตรียมไว้จากรายการ OmniVoice" }, { status: 400 });
    }
    if (!preview && fullText.length > config.maxScriptChars) {
      return NextResponse.json({
        code: "OMNIVOICE_SCRIPT_TOO_LONG",
        error: `OmniVoice บนเครื่องปัจจุบันรองรับไม่เกิน ${config.maxScriptChars} ตัวอักษรต่อคลิป กรุณาย่อสคริปต์หรือสลับเป็น Gemini/ElevenLabs`,
        maxChars: config.maxScriptChars,
      }, { status: 413 });
    }

    const deadline = Date.now() + config.requestBudgetMs;
    const quota = await checkMinuteQuota(user.id);
    if (!quota.allowed) {
      return NextResponse.json({ code: "QUOTA_MINUTES", message: quota.message }, { status: 409 });
    }

    const chunks = splitScriptForTts(fullText);
    const pcms: Buffer[] = [];
    const durations: number[] = [];
    const generationTimes: number[] = [];
    let sampleRate = 0;
    const admission = omnivoiceAdmission.tryAcquire();
    if (!admission) {
      return NextResponse.json(
        { error: "คิว OmniVoice ฝั่งแอปเต็ม กรุณาลองใหม่ภายหลัง หรือสลับเป็น Gemini/ElevenLabs", retryable: true },
        { status: 429, headers: { "Retry-After": "30" } },
      );
    }
    try {
      const estimatedMinutes = estimateTtsAudioMinutes(fullText);
      const aiReserve = await reserveAiAudioMinutes(user.id, estimatedMinutes, { enforce: true });
      if (!aiReserve.allowed) {
        return NextResponse.json({ code: "QUOTA_AI_AUDIO", message: aiReserve.message }, { status: 429 });
      }
      markReserved(estimatedMinutes);

      for (let index = 0; index < chunks.length; index++) {
        const result = await callOmniVoice(
          config,
          voiceId,
          chunks[index].text,
          speed,
          deadline,
        );
        if (!result.ok) { await settleRefund(); return upstreamError(result); }
        if (sampleRate === 0) sampleRate = result.sampleRate;
        if (result.sampleRate !== sampleRate) {
          await settleRefund();
          return NextResponse.json({ error: "OmniVoice ส่ง sample rate ไม่สม่ำเสมอ", retryable: true }, { status: 503 });
        }
        pcms.push(result.pcm);
        durations.push(Math.round(pcmDurationMs(result.pcm.length, result.sampleRate)));
        generationTimes.push(result.generationTimeSec);
      }
    } finally {
      admission.release();
    }

    const audioDurationMs = durations.reduce((sum, value) => sum + value, 0);
    const { voiceUrl, filePath } = saveWav(wavFromPcm(Buffer.concat(pcms), sampleRate));
    // The worker CPU was successfully spent even if a later render-minute reserve
    // loses a race, so settle the managed-audio ceiling before that reservation.
    await settleReconcile(audioDurationMs / 60_000);
    if (process.env.MINUTE_QUOTA !== "1") {
      const reserved = await reserveMinutes(user.id, Math.max(1, Math.ceil(audioDurationMs / 60_000)));
      if (!reserved.allowed) {
        try { fs.unlinkSync(filePath); } catch {}
        return NextResponse.json({ code: "QUOTA_MINUTES", message: reserved.message }, { status: 409 });
      }
    }

    const silences = await detectSilences(filePath).catch(() => ({
      midpoints: [] as number[],
      intervals: [] as { startMs: number; endMs: number }[],
    }));
    recordTelemetryEvent(user.id, {
      name: "omnivoice_tts",
      category: "product",
      source: "server",
      properties: {
        scriptChars: fullText.length,
        audioDurationMs,
        generationTimeMs: Math.round(generationTimes.reduce((sum, value) => sum + value, 0) * 1000),
        numStep: config.numStep,
        segments: chunks.length,
      },
    }).catch(() => {});

    return NextResponse.json({
      voiceUrl,
      audioDurationMs,
      timing: {
        provider: "omnivoice" as const,
        segments: mergeSegmentTiming(chunks.map((chunk, index) => ({ text: chunk.text, durationMs: durations[index] }))),
        chars: null,
        silences: silences.midpoints,
        silenceIntervals: silences.intervals,
      },
    });
  } catch (error) {
    if (!aiReserveSettled && aiReserveUserId && aiReservedMin > 0) {
      await refundAiAudioMinutes(aiReserveUserId, aiReservedMin).catch(() => {});
      aiReserveSettled = true;
    }
    if (!(error instanceof OmniVoiceConfigError)) {
      console.error("[tts-omnivoice] request failed:", error);
    }
    return NextResponse.json({ error: "OmniVoice unavailable", retryable: true }, { status: 503 });
  }
}
