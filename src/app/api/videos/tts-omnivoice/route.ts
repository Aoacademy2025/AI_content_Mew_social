import { execFile } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { checkMinuteQuota, refundMinutes, reserveMinutes } from "@/lib/minute-limits";
import {
  estimateTtsAudioMinutes,
  reconcileAiAudioMinutes,
  refundAiAudioMinutes,
  reserveAiAudioMinutes,
} from "@/lib/ai-spend-limits";
import {
  callOmniVoice,
  isOmniVoiceUserAllowed,
  isValidOmniVoiceId,
  OmniVoiceConfigError,
  omnivoiceConfig,
  pcmFromWav,
  type OmniVoiceBackend,
  type OmniVoiceCallResult,
} from "@/lib/omnivoice";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { omnivoiceAdmission } from "@/lib/omnivoice-admission";
import { splitHeroVoiceScriptForTts } from "@/lib/hero-voice-speech";
import {
  mergeSegmentTiming,
  pcmDurationMs,
} from "@/lib/tts-timing";
import { audioDurationLimitViolation, videoExpiryFor } from "@/lib/plan-limits";
import { omnivoiceScriptCharCapForPlan } from "@/lib/omnivoice-limits";
import { prisma } from "@/lib/prisma";

export const maxDuration = 900;
export const runtime = "nodejs";

function upstreamError(result: Extract<OmniVoiceCallResult, { ok: false }>) {
  if (result.code === "RUNPOD_QUEUE_TIMEOUT") {
    const cancellationConfirmed = result.cancelled === true;
    return NextResponse.json(
      {
        code: "OMNIVOICE_QUEUE_TIMEOUT",
        error: cancellationConfirmed
          ? "Hero Voice หาเครื่องว่างไม่ทันภายใน 2 นาที งานเดิมถูกยกเลิกแล้ว กรุณาลองใหม่หรือสลับเป็น Gemini สำหรับงานเร่งด่วน"
          : "Hero Voice หาเครื่องว่างไม่ทัน และยังยืนยันการยกเลิกงานเดิมไม่ได้ กรุณารอสักครู่ก่อนลองใหม่",
        retryable: cancellationConfirmed,
        fallbackProvider: cancellationConfirmed ? "gemini" : undefined,
      },
      { status: 504 },
    );
  }
  if (result.status === 404) {
    return NextResponse.json({ error: "ไม่พบเสียง Hero Voice ที่เลือก — กรุณาเลือกเสียงใหม่" }, { status: 404 });
  }
  if (result.status === 422) {
    return NextResponse.json({ error: "ข้อความไม่ผ่านการตรวจของ Hero Voice" }, { status: 422 });
  }
  if (result.status === 429) {
    return NextResponse.json(
      { error: "คิว Hero Voice เต็ม กรุณาลองใหม่ภายหลัง หรือสลับเป็น Gemini/ElevenLabs", retryable: true },
      { status: 429, headers: { "Retry-After": result.retryAfter ?? "30" } },
    );
  }
  console.error(`[tts-omnivoice] upstream status=${result.status} reason=${result.reason}`);
  return NextResponse.json(
    { error: "Hero Voice ขัดข้องชั่วคราว กรุณาลองใหม่หรือสลับเป็น Gemini/ElevenLabs", retryable: true },
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
  let studioReservedMin = 0;
  let studioMinuteReserveSettled = true;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isOmniVoiceUserAllowed(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });

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
      if (!studioMinuteReserveSettled && studioReservedMin > 0) {
        await refundMinutes(user.id, studioReservedMin).catch(() => {});
      }
      studioMinuteReserveSettled = true;
    };
    const settleReconcile = async (actualMinutes: number) => {
      await reconcileAiAudioMinutes(user.id, aiReservedMin, actualMinutes, { enforce: true });
      aiReserveSettled = true;
    };

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const requestedBackend: OmniVoiceBackend | undefined = body?.backend === "runpod" || body?.backend === "hostinger"
      ? body.backend
      : undefined;
    const config = omnivoiceConfig();
    if (requestedBackend && requestedBackend !== config.backend) {
      return NextResponse.json(
        { error: "Hero Voice backend ของงานนี้ไม่ตรงกับ rollout ปัจจุบัน กรุณาสร้างงานใหม่", retryable: false },
        { status: 409 },
      );
    }
    const fullText = typeof body?.text === "string" ? body.text.trim() : "";
    const voiceId = typeof body?.voiceId === "string" && body.voiceId.trim() ? body.voiceId.trim() : "voice_01";
    const preview = body?.preview === true;
    const studio = body?.studio === true;
    const parsedSpeed = typeof body?.speed === "number" ? body.speed : Number(body?.speed);
    const speed = Number.isFinite(parsedSpeed) ? Math.min(3, Math.max(0.3, parsedSpeed)) : 1;

    if (!fullText) return NextResponse.json({ error: "text required" }, { status: 400 });
    if (!isValidOmniVoiceId(voiceId)) return NextResponse.json({ error: "voiceId ไม่ถูกต้อง" }, { status: 400 });
    if (preview) {
      return NextResponse.json({ error: "ใช้เสียงตัวอย่างที่เตรียมไว้จากรายการ Hero Voice" }, { status: 400 });
    }
    const planScriptCap = omnivoiceScriptCharCapForPlan(user.plan);
    if (!preview && fullText.length > planScriptCap) {
      return NextResponse.json({
        code: "OMNIVOICE_SCRIPT_TOO_LONG",
        error: `สคริปต์ยาวเกินแพ็กเกจ ${user.plan} กรุณาย่อให้ไม่เกินประมาณ ${planScriptCap.toLocaleString("th-TH")} ตัวอักษร`,
        maxChars: planScriptCap,
      }, { status: 413 });
    }

    const deadline = Date.now() + config.requestBudgetMs;
    const quota = await checkMinuteQuota(user.id);
    if (!quota.allowed) {
      return NextResponse.json({ code: "QUOTA_MINUTES", message: quota.message }, { status: 409 });
    }

    const chunks = splitHeroVoiceScriptForTts(fullText, config.maxChunkChars);
    const pcms: Buffer[] = [];
    const durations: number[] = [];
    const generationTimes: number[] = [];
    const delayTimes: number[] = [];
    const executionTimes: number[] = [];
    const providerJobIds: string[] = [];
    const workerVersions = new Set<string>();
    const workerLanguages = new Set<string>();
    const workerNumSteps = new Set<number>();
    let sampleRate = 0;
    const admission = omnivoiceAdmission.tryAcquire();
    if (!admission) {
      return NextResponse.json(
        { error: "คิว Hero Voice ฝั่งแอปเต็ม กรุณาลองใหม่ภายหลัง หรือสลับเป็น Gemini/ElevenLabs", retryable: true },
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
      if (studio) {
        studioReservedMin = Math.max(1, Math.ceil(estimatedMinutes));
        const studioReserve = await reserveMinutes(user.id, studioReservedMin);
        if (!studioReserve.allowed) {
          await settleRefund();
          return NextResponse.json({ code: "QUOTA_MINUTES", message: studioReserve.message }, { status: 409 });
        }
        studioMinuteReserveSettled = false;
      }

      for (let index = 0; index < chunks.length; index++) {
        const result = await callOmniVoice(
          config,
          voiceId,
          chunks[index].speechText,
          speed,
          deadline,
        );
        if (!result.ok) { await settleRefund(); return upstreamError(result); }
        const { pcm, sampleRate: resultSampleRate } = pcmFromWav(Buffer.from(result.response.audio_base64, "base64"));
        if (sampleRate === 0) sampleRate = resultSampleRate;
        if (resultSampleRate !== sampleRate) {
          await settleRefund();
          return NextResponse.json({ error: "Hero Voice ส่งรูปแบบเสียงไม่สม่ำเสมอ", retryable: true }, { status: 503 });
        }
        pcms.push(pcm);
        durations.push(Math.round(pcmDurationMs(pcm.length, resultSampleRate)));
        generationTimes.push(typeof result.response.generation_time === "number" ? result.response.generation_time : 0);
        delayTimes.push(result.delayTimeMs);
        executionTimes.push(result.executionTimeMs);
        if (result.providerJobId) providerJobIds.push(result.providerJobId);
        if (result.response.worker_version) workerVersions.add(result.response.worker_version);
        if (result.response.language) workerLanguages.add(result.response.language);
        if (typeof result.response.num_step === "number") workerNumSteps.add(result.response.num_step);
      }
    } finally {
      admission.release();
    }

    const audioDurationMs = durations.reduce((sum, value) => sum + value, 0);
    const { voiceUrl, filePath } = saveWav(wavFromPcm(Buffer.concat(pcms), sampleRate));
    // The worker CPU was successfully spent even if a later render-minute reserve
    // loses a race, so settle the managed-audio ceiling before that reservation.
    await settleReconcile(audioDurationMs / 60_000);
    const durationViolation = audioDurationLimitViolation(audioDurationMs, user.plan);
    if (durationViolation) {
      try { fs.unlinkSync(filePath); } catch {}
      if (!studioMinuteReserveSettled) {
        await refundMinutes(user.id, studioReservedMin).catch(() => {});
        studioMinuteReserveSettled = true;
      }
      return NextResponse.json(durationViolation, { status: 413 });
    }
    if (studio) {
      const actualBilledMinutes = Math.max(1, Math.ceil(audioDurationMs / 60_000));
      if (actualBilledMinutes > studioReservedMin) {
        const extra = actualBilledMinutes - studioReservedMin;
        const extraReserve = await reserveMinutes(user.id, extra);
        if (!extraReserve.allowed) {
          try { fs.unlinkSync(filePath); } catch {}
          await refundMinutes(user.id, studioReservedMin).catch(() => {});
          studioMinuteReserveSettled = true;
          return NextResponse.json({ code: "QUOTA_MINUTES", message: extraReserve.message }, { status: 409 });
        }
        studioReservedMin = actualBilledMinutes;
      } else if (actualBilledMinutes < studioReservedMin) {
        await refundMinutes(user.id, studioReservedMin - actualBilledMinutes);
        studioReservedMin = actualBilledMinutes;
      }
      studioMinuteReserveSettled = true;
    } else if (process.env.MINUTE_QUOTA !== "1") {
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
        providerExecutionTimeMs: executionTimes.reduce((sum, value) => sum + value, 0),
        providerDelayTimeMs: delayTimes.reduce((sum, value) => sum + value, 0),
        backend: config.backend,
        numStep: config.numStep,
        workerVersions: [...workerVersions].join(","),
        languageHints: [...workerLanguages].join(","),
        effectiveNumSteps: [...workerNumSteps].sort((a, b) => a - b).join(","),
        segments: chunks.length,
      },
    }).catch(() => {});

    let studioJob: { id: string; status: string; outputUrl: string | null } | null = null;
    if (studio) {
      studioJob = await prisma.aiGenerationJob.create({
        data: {
          userId: user.id,
          kind: "voice",
          provider: config.backend === "runpod" ? "runpod" : "omnivoice",
          model: voiceId,
          providerModel: "omnivoice",
          providerRoute: config.backend === "runpod" ? "runpod-custom" : "hostinger-kvm",
          providerEndpoint: config.backend === "runpod" ? config.endpointId : config.baseUrl,
          status: "completed",
          inputPreview: fullText.replace(/\s+/g, " ").slice(0, 180),
          inputJson: JSON.stringify({
            voiceId,
            speed,
            scriptChars: fullText.length,
            backend: config.backend,
            segments: chunks.length,
            providerJobIds,
            workerVersions: [...workerVersions],
            languageHints: [...workerLanguages],
            effectiveNumSteps: [...workerNumSteps].sort((a, b) => a - b),
          }),
          outputUrl: voiceUrl,
          creditCost: 0,
          chargeState: "none",
          delayTimeMs: delayTimes.reduce((sum, value) => sum + value, 0),
          executionTimeMs: executionTimes.reduce((sum, value) => sum + value, 0),
          startedAt: new Date(),
          finishedAt: new Date(),
          mediaExpiresAt: videoExpiryFor(user.plan),
        },
        select: { id: true, status: true, outputUrl: true },
      }).catch((error) => {
        console.error("[tts-omnivoice] could not record AI Studio history:", error instanceof Error ? error.message : error);
        return null;
      });
    }

    return NextResponse.json({
      voiceUrl,
      audioDurationMs,
      studioJob,
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
    if (!studioMinuteReserveSettled && aiReserveUserId && studioReservedMin > 0) {
      await refundMinutes(aiReserveUserId, studioReservedMin).catch(() => {});
      studioMinuteReserveSettled = true;
    }
    if (!(error instanceof OmniVoiceConfigError)) {
      console.error("[tts-omnivoice] request failed:", error);
    }
    return NextResponse.json({ error: "Hero Voice ยังไม่พร้อมใช้งาน", retryable: true }, { status: 503 });
  }
}
