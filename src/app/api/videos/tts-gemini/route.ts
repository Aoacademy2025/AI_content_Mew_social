import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { checkMinuteQuota, reserveMinutes } from "@/lib/minute-limits";
import { shouldCheckTtsMinuteQuota } from "@/lib/tts-minute-admission";
import {
  reserveAiAudioMinutes,
  refundAiAudioMinutes,
  reconcileAiAudioMinutes,
  estimateTtsAudioMinutes,
} from "@/lib/ai-spend-limits";
import { getGeminiErrorInfo, parseRetryDelayMs } from "@/lib/gemini-errors";
import { recordTelemetryEvent } from "@/lib/telemetry";
import {
  splitScriptForTts,
  mergeSegmentTiming,
  charsPerSecGuard,
  pcmDurationMs,
} from "@/lib/tts-timing";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { Agent, fetch as undiciFetch } from "undici";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import {
  cachedVoicePreview,
  getVoicePreviewCachePath,
  normalizeVoicePreviewText,
} from "@/lib/voice-preview-cache";

// Long scripts (5-6 min) produce large base64 audio responses — extend timeouts
// for the Gemini TTS call ONLY, via a per-request dispatcher. (Previously this
// was setGlobalDispatcher, which silently let EVERY fetch in the whole Node
// process hang up to 10 minutes per phase — design doc §1 root cause 5.)
const geminiTtsDispatcher = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });

export const maxDuration = 300;
export const runtime = "nodejs";

// Gemini TTS — prefer 2.5 Flash TTS first because it is the expected low-cost path.
// Newer preview models can have stricter access/quota, so keep them as fallbacks only.
const MODEL_CHAIN = [
  "gemini-2.5-flash-preview-tts",   // widely available preview
  "gemini-3.1-flash-tts-preview",   // newer preview, may be restricted
  "gemini-2.5-pro-preview-tts",     // last resort
];
const MAX_ATTEMPTS = 3;

// Time budget for the segmented pass. It must leave room for the single-call
// fail-open below to still complete inside the proxy window when segments
// keep hitting free-tier RPM waits.
const SEGMENTED_BUDGET_MS = 240_000;

// Sentinel for "HTTP 200 but no audio in the response" so the error mapping
// can keep returning the exact same message as before.
const NO_AUDIO = "__NO_AUDIO__";

type TtsCallResult =
  | { ok: true; pcm: Buffer; sampleRate: number; model: string }
  | { ok: false; status: number; errBody: string };

// One Gemini TTS call with the original model-chain + retry/backoff semantics.
// modelLock pins all segments of a clip to the model that served segment 0 —
// mixing models mid-clip would change the voice at a chunk seam.
async function callGeminiTts(
  apiKey: string,
  text: string,
  voiceName: string,
  modelLock?: string,
  deadline?: number,
): Promise<TtsCallResult> {
  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  });

  const models = modelLock ? [modelLock] : MODEL_CHAIN;
  let lastErrBody = "";
  let lastStatus = 500;

  for (const model of models) {
    // Send key as both ?key= query param AND x-goog-api-key header to support
    // both classic AIza* keys and newer AQ.* keys.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (deadline && Date.now() >= deadline) {
        return { ok: false, status: 408, errBody: "segmented time budget exhausted" };
      }
      // Agent + fetch come from the SAME undici import so the dispatcher is actually honored.
      // Handing a node_modules Agent to Node's built-in global fetch is NOT reliable — it
      // silently fell back to undici's ~300s default, so the 600s above never took effect and
      // long (5-6 min) TTS calls died with HeadersTimeoutError. (Same fix as pipeline-client.ts.)
      const res = await undiciFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: requestBody,
        dispatcher: geminiTtsDispatcher,
      });

      if (res.ok) {
        const data = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
        };
        const part = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        const audioB64: string | undefined = part?.data;
        if (!audioB64) return { ok: false, status: 500, errBody: NO_AUDIO };
        const mimeType: string = part?.mimeType ?? "audio/L16;rate=24000";
        const rateMatch = mimeType.match(/rate=(\d+)/);
        console.log(`[tts-gemini] ok with ${model} (attempt ${attempt})`);
        return {
          ok: true,
          pcm: Buffer.from(audioB64, "base64"),
          sampleRate: rateMatch ? parseInt(rateMatch[1]) : 24000,
          model,
        };
      }

      lastErrBody = await res.text();
      lastStatus = res.status;

      // Auth / model-access errors → try next model (don't retry same one)
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        console.warn(`[tts-gemini] ${model} returned ${res.status} — trying next model`);
        break;  // exit inner retry loop, move to next model
      }

      // 400 = bad request, won't get better by retrying or switching model
      if (res.status === 400) {
        console.error(`[tts-gemini] bad request (400) for ${model}:`, lastErrBody.slice(0, 200));
        return { ok: false, status: 400, errBody: lastErrBody };
      }

      // Retryable transient (429, 500, 502, 503, 504) — backoff and retry SAME
      // model. 429 bodies often carry Google's own retryDelay hint; honor it,
      // it is far more accurate than exponential guessing on free-tier RPM.
      if (attempt < MAX_ATTEMPTS) {
        const hinted = res.status === 429 ? parseRetryDelayMs(lastErrBody) : null;
        const delayMs = hinted ?? 1500 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
        if (deadline && Date.now() + delayMs >= deadline) {
          return { ok: false, status: 408, errBody: "segmented time budget exhausted" };
        }
        console.warn(`[tts-gemini] ${model} transient ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}), retry in ${delayMs}ms${hinted ? " (server hint)" : ""}`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        console.warn(`[tts-gemini] ${model} exhausted retries — trying next model`);
      }
    }
  }

  return { ok: false, status: lastStatus, errBody: lastErrBody };
}

// Map a failed call to the exact user-facing responses this route has always
// returned (text unchanged — the editor surfaces these verbatim).
// `managed` = true when Gemini runs on the platform key (MANAGED_GEMINI=1).
// In that case a failure is a platform issue — don't tell the user to fix their key.
function geminiErrorResponse(status: number, errBody: string, managed = false) {
  if (errBody === NO_AUDIO) {
    return NextResponse.json({ error: "Gemini ไม่ส่งข้อมูลเสียงกลับมา" }, { status: 500 });
  }
  if (status === 401) {
    if (managed) {
      return NextResponse.json({
        error: "ระบบ TTS ขัดข้องชั่วคราว — กรุณาลองใหม่อีกครั้งหรือแจ้งทีมงาน",
      }, { status: 503 });
    }
    return NextResponse.json({
      error: "Gemini API Key ไม่ถูกต้อง — Key นี้ไม่มีสิทธิ์ใช้ TTS preview models (ลองทั้ง 3 models แล้ว). กรุณาสร้าง key ใหม่จาก aistudio.google.com แล้วใส่ใน Settings",
      missingKey: "gemini",
    }, { status: 401 });
  }
  if (status === 403) {
    if (managed) {
      return NextResponse.json({
        error: "ระบบ TTS ขัดข้องชั่วคราว — กรุณาลองใหม่อีกครั้งหรือแจ้งทีมงาน",
        retryable: false,
      }, { status: 503 });
    }
    // Distinguish "API not enabled" from "key valid but lacks TTS access"
    const isApiDisabled = errBody.includes("SERVICE_DISABLED") || errBody.includes("has not been used") || errBody.includes("PERMISSION_DENIED");
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
    const info = getGeminiErrorInfo(errBody, status);
    return NextResponse.json({
      error: info.userMessage,
      retryable: info.retryable,
      provider: "gemini",
      reason: info.kind,
    }, { status: info.status });
  }
  const info = getGeminiErrorInfo(errBody, status);
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

// PCM s16le mono → WAV (44-byte header, same layout this route always wrote)
function wavFromPcm(pcmBuffer: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

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

  return Buffer.concat([wavHeader, pcmBuffer]);
}

function saveWav(wavBuffer: Buffer): { voiceUrl: string; filePath: string } {
  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const filename = `tts-${Date.now()}.wav`;
  const filePath = path.join(rendersDir, filename);
  fs.writeFileSync(filePath, wavBuffer);
  return { voiceUrl: `/api/renders/${filename}`, filePath };
}

// Real pauses via ffmpeg silencedetect (same detector the transcribe route uses
// for chunk planning). Returns both the midpoints (legacy) and the full
// intervals (start/end ms); card boundaries snap to the pause END (speech onset)
// so a caption appears exactly when its words are spoken. Failure → empty (the
// snap is a polish, never a dependency).
function detectSilences(wavPath: string): Promise<{ midpoints: number[]; intervals: { startMs: number; endMs: number }[] }> {
  return new Promise((resolve) => {
    execFile(getFfmpegPath(), [
      "-i", wavPath,
      "-af", "silencedetect=noise=-30dB:d=0.25",
      "-f", "null", "-",
    ], { maxBuffer: 20 * 1024 * 1024, timeout: 30_000 }, (_err, _stdout, stderr) => {
      const midpoints: number[] = [];
      const intervals: { startMs: number; endMs: number }[] = [];
      const re = /silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stderr || "")) !== null) {
        const start = parseFloat(m[1]);
        const end = parseFloat(m[2]);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
          midpoints.push(Math.round(((start + end) / 2) * 1000));
          intervals.push({ startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
        }
      }
      midpoints.sort((a, b) => a - b);
      intervals.sort((a, b) => a.startMs - b.startMs);
      resolve({ midpoints, intervals });
    });
  });
}

// POST /api/videos/tts-gemini
// Body: { text, voiceName? }
// Returns: { voiceUrl, audioDurationMs, timing? }
//   timing (additive — old clients ignore it) = exact-by-arithmetic subtitle
//   timing derived from per-segment PCM durations. Absent when the segmented
//   pass failed and we fell back to a single uninstrumented call — the editor
//   then uses the transcribe fallback as before.
export async function POST(req: Request) {
  // AI-audio ceiling reserve tracking (managed mode). The route reserves an
  // estimate up front (atomic) and settles it (reconcile on success / refund on
  // failure). These outer vars let the top-level catch refund a still-held
  // reserve if generation throws — so a failed call never leaks ceiling minutes
  // (parity with the old "charge only after success"). All no-ops under BYOK.
  let aiReserveUserId: string | null = null;
  let aiReservedMin = 0;
  let aiReserveEnforce = false;
  let aiReserveSettled = true;
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => null);
    const { text, voiceName = "Aoede", preview = false } = body ?? {};
    if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });
    const selectedVoice = GEMINI_VOICES.some((v) => v.id === voiceName) ? voiceName : "Aoede";

    // Get user's Gemini key (managed or BYOK)
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { geminiKey: true, plan: true },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    let apiKey: string;
    let geminiMode: "managed" | "byok";
    try {
      const resolved = resolveGeminiKey(user);
      apiKey = resolved.key;
      geminiMode = resolved.mode;
    } catch (e) {
      if (e instanceof KeyRequiredError) {
        return NextResponse.json({ code: "KEY_REQUIRED", action: "/settings?tab=api-keys" }, { status: 409 });
      }
      throw e;
    }

    // Telemetry: key mode adoption (fire-and-forget — must not block or throw)
    recordTelemetryEvent(authUser.id, {
      name: "gemini_key_mode",
      category: "product",
      source: "server",
      properties: { mode: geminiMode, plan: user.plan },
    }).catch(() => {});

    // Managed mode = server Gemini key = OUR spend → enforce the AI-audio ceiling.
    // BYOK (enforceAi=false) → reserve always-allows with NO DB touch + reconcile is
    // a no-op (byte-identical).
    const enforceAi = geminiMode === "managed";

    // Settle helpers for the up-front AI-audio reserve. markReserved arms the
    // outer-scope refund tracking; settleReconcile adjusts the held reserve to the
    // real audio length on success; settleRefund gives the whole reserve back on a
    // failure return. enforceAi=false → reconcile is a no-op and refund is skipped,
    // so BYOK touches the DB exactly as before (byte-identical).
    const markReserved = (minutes: number) => {
      aiReserveUserId = authUser.id;
      aiReservedMin = minutes;
      aiReserveEnforce = enforceAi;
      aiReserveSettled = false;
    };
    const settleRefund = async () => {
      if (!aiReserveSettled && aiReserveEnforce && aiReservedMin > 0) {
        await refundAiAudioMinutes(authUser.id, aiReservedMin).catch(() => {});
      }
      aiReserveSettled = true;
    };
    const settleReconcile = async (actualMinutes: number) => {
      await reconcileAiAudioMinutes(authUser.id, aiReservedMin, actualMinutes, { enforce: enforceAi });
      aiReserveSettled = true;
    };

    if (preview === true) {
      const previewText = normalizeVoicePreviewText(text);
      const cache = getVoicePreviewCachePath({
        provider: "gemini",
        userId: authUser.id,
        voiceKey: selectedVoice,
        text: previewText,
        ext: "wav",
      });
      const cached = cachedVoicePreview(cache.filePath, cache.voiceUrl);
      if (cached) return NextResponse.json({ ...cached, preview: true });

      // Cache MISS = fresh server-key spend. Reserve an ESTIMATE up front (atomic)
      // so randomized preview text can't loop-burn Gemini past the ceiling via a
      // read-only peek (the audit's CRITICAL preview hole) — concurrent previews
      // now each consume a real slice of the ceiling. Reconciled to the real audio
      // length after success; refunded on failure. enforceAi=false (BYOK) → no DB
      // touch (byte-identical).
      const previewEstMin = estimateTtsAudioMinutes(previewText);
      const previewReserve = await reserveAiAudioMinutes(authUser.id, previewEstMin, { enforce: enforceAi });
      if (!previewReserve.allowed) return NextResponse.json({ code: "QUOTA_AI_AUDIO", message: previewReserve.message }, { status: 429 });
      markReserved(previewEstMin);
      const r = await callGeminiTts(apiKey, previewText, selectedVoice);
      if (!r.ok) { await settleRefund(); return geminiErrorResponse(r.status, r.errBody, geminiMode === "managed"); }
      fs.writeFileSync(cache.filePath, wavFromPcm(r.pcm, r.sampleRate));
      await settleReconcile(pcmDurationMs(r.pcm.length, r.sampleRate) / 60_000);
      return NextResponse.json({
        voiceUrl: cache.voiceUrl,
        audioDurationMs: Math.round(pcmDurationMs(r.pcm.length, r.sampleRate)),
        preview: true,
        cached: false,
      });
    }

    // Legacy-only fail-fast check. With MINUTE_QUOTA=1 the queued base render owns
    // the atomic minutes-or-credits settlement; blocking here would reject users
    // who intentionally bought overflow credits before that settlement can run.
    if (shouldCheckTtsMinuteQuota(geminiMode, process.env.MINUTE_QUOTA === "1")) {
      const quota = await checkMinuteQuota(authUser.id);
      if (!quota.allowed) {
        return NextResponse.json({ code: "QUOTA_MINUTES", message: quota.message }, { status: 409 });
      }
    }

    // IRON RULE: fullText is the one string both TTS and subtitles see.
    // Chunks are exact contiguous slices of it (concat === fullText).
    const fullText: string = (text as string).trim();

    // AI-audio ceiling (managed): bounds server-Gemini TTS spend independently of
    // render minutes (TTS is a separate, loopable endpoint, and there is NO global
    // render queue so concurrent re-rolls really race). Reserve an ESTIMATE from the
    // script up front — ATOMICALLY — so racing calls can't all pass a read-only peek
    // and overshoot the ceiling (transcribe already reserves atomically). Reconciled
    // to the real audio length after generation; refunded in full on any failure.
    // enforceAi=false (BYOK) → no DB touch (byte-identical).
    const estMin = estimateTtsAudioMinutes(fullText);
    const aiReserve = await reserveAiAudioMinutes(authUser.id, estMin, { enforce: enforceAi });
    if (!aiReserve.allowed) return NextResponse.json({ code: "QUOTA_AI_AUDIO", message: aiReserve.message }, { status: 429 });
    markReserved(estMin);

    const chunks = splitScriptForTts(fullText);
    const deadline = Date.now() + SEGMENTED_BUDGET_MS;
    console.log(`[tts-gemini] script ${fullText.length} chars → ${chunks.length} segment(s)`);

    // ---- Segmented pass (a 1-chunk short clip is the same flow, just N=1) ----
    let pcms: Buffer[] | null = [];
    const durations: number[] = [];
    let sampleRate = 0;
    let modelLock: string | undefined;
    let failOpen = "";

    for (let i = 0; i < chunks.length; i++) {
      const r = await callGeminiTts(apiKey, chunks[i].text, selectedVoice, modelLock, chunks.length > 1 ? deadline : undefined);
      if (!r.ok) {
        // A 1-chunk clip has no fallback that differs from what just failed —
        // surface the mapped error exactly like the old single-call route.
        if (chunks.length === 1) { await settleRefund(); return geminiErrorResponse(r.status, r.errBody, geminiMode === "managed"); }
        failOpen = `segment ${i + 1}/${chunks.length} failed (${r.status})`;
        pcms = null;
        break;
      }
      if (!modelLock) modelLock = r.model;
      if (sampleRate === 0) sampleRate = r.sampleRate;
      else if (r.sampleRate !== sampleRate) {
        failOpen = `sample rate changed mid-clip (${sampleRate} → ${r.sampleRate})`;
        pcms = null;
        break;
      }
      pcms.push(r.pcm);
      durations.push(Math.round(pcmDurationMs(r.pcm.length, r.sampleRate)));
      const spoken = chunks[i].text.replace(/\s+/g, "").length;
      console.log(`[tts-gemini] seg ${i + 1}/${chunks.length}: ${durations[i]}ms, ${spoken} chars, ${(spoken / Math.max(durations[i], 1) * 1000).toFixed(1)} cps`);
    }

    // ---- Deterministic desync guard: retry segments whose speaking rate is
    // an outlier (API returned truncated/repeated audio for that chunk) ----
    if (pcms && chunks.length > 1) {
      const GUARD_ROUNDS = 3; // 2 regeneration rounds, then fail open
      for (let round = 1; round <= GUARD_ROUNDS; round++) {
        const outliers = charsPerSecGuard(chunks.map((c, i) => ({ text: c.text, durationMs: durations[i] })));
        if (outliers.length === 0) break;
        if (round === GUARD_ROUNDS) {
          failOpen = `guard still failing after retries: [${outliers.join(", ")}]`;
          pcms = null;
          break;
        }
        console.warn(`[tts-gemini] guard round ${round}: segments off cps median: [${outliers.join(", ")}] — retrying those`);
        for (const idx of outliers) {
          const r = await callGeminiTts(apiKey, chunks[idx].text, selectedVoice, modelLock, deadline);
          if (r.ok && r.sampleRate === sampleRate) {
            pcms[idx] = r.pcm;
            durations[idx] = Math.round(pcmDurationMs(r.pcm.length, sampleRate));
            console.log(`[tts-gemini] guard: seg ${idx + 1} regenerated → ${durations[idx]}ms`);
          }
        }
      }
    }

    // ---- Fail-open: segmented pass broke → one plain call, no timing.
    // The editor sees no `timing` and uses the transcribe fallback, i.e.
    // exactly the pre-PR-B behavior. Users never lose TTS to this feature. ----
    if (!pcms) {
      console.warn(`[tts-gemini] fail-open → single call (${failOpen})`);
      const r = await callGeminiTts(apiKey, fullText, selectedVoice);
      if (!r.ok) { await settleRefund(); return geminiErrorResponse(r.status, r.errBody, geminiMode === "managed"); }
      const failOpenDurationMs = Math.round(pcmDurationMs(r.pcm.length, r.sampleRate));
      // Write the WAV FIRST, then reserve render minutes — same MON-6 ordering as
      // the success path: a failed disk write can't leak render minutes because the
      // reserve never runs, and the still-un-settled AI-audio reserve is refunded by
      // the outer catch on a throw.
      const { voiceUrl, filePath } = saveWav(wavFromPcm(r.pcm, r.sampleRate));
      // Reserve minutes AFTER the WAV exists (managed users only).
      // When MINUTE_QUOTA is on, the render route reserves minutes by output duration
      // instead — skip here so the same video isn't charged twice (TTS + render).
      // Flag off → unchanged: managed still reserves at TTS time.
      if (geminiMode === "managed" && process.env.MINUTE_QUOTA !== "1") {
        const minutes = Math.max(1, Math.ceil(failOpenDurationMs / 60_000));
        const reserved = await reserveMinutes(authUser.id, minutes);
        if (!reserved.allowed) {
          try { fs.unlinkSync(filePath); } catch {}
          await settleRefund();
          return NextResponse.json({ code: "QUOTA_MINUTES", message: reserved.message }, { status: 409 });
        }
        // Telemetry: minute burn (fire-and-forget)
        recordTelemetryEvent(authUser.id, {
          name: "minute_reserve",
          category: "product",
          source: "server",
          properties: { minutes, remaining: reserved.remaining, plan: user.plan },
        }).catch(() => {});
      }
      await settleReconcile(failOpenDurationMs / 60_000);
      return NextResponse.json({
        voiceUrl,
        audioDurationMs: failOpenDurationMs,
      });
    }

    // ---- Success: concat PCM, write one WAV, return exact timing ----
    const segments = mergeSegmentTiming(chunks.map((c, i) => ({ text: c.text, durationMs: durations[i] })));
    const audioDurationMs = durations.reduce((a, b) => a + b, 0);
    // Write the WAV FIRST, then reserve render minutes. If the disk write throws
    // (disk-full — real on this box), reserveMinutes never runs, so a failed save
    // can't leak render minutes to the outer catch (MON-6). The AI-audio reserve is
    // still un-settled at this point, so a throw here refunds it via the catch. On a
    // quota-minutes loss we unlink the just-written WAV so nothing is orphaned.
    const { voiceUrl, filePath } = saveWav(wavFromPcm(Buffer.concat(pcms), sampleRate));
    // Reserve minutes AFTER the WAV exists (managed users only).
    // When MINUTE_QUOTA is on, the render route reserves minutes by output duration
    // instead — skip here so the same video isn't charged twice (TTS + render).
    // Flag off → unchanged: managed still reserves at TTS time.
    if (geminiMode === "managed" && process.env.MINUTE_QUOTA !== "1") {
      const minutes = Math.max(1, Math.ceil(audioDurationMs / 60_000));
      const reserved = await reserveMinutes(authUser.id, minutes);
      if (!reserved.allowed) {
        try { fs.unlinkSync(filePath); } catch {}
        await settleRefund();
        return NextResponse.json({ code: "QUOTA_MINUTES", message: reserved.message }, { status: 409 });
      }
      // Telemetry: minute burn (fire-and-forget)
      recordTelemetryEvent(authUser.id, {
        name: "minute_reserve",
        category: "product",
        source: "server",
        properties: { minutes, remaining: reserved.remaining, plan: user.plan },
      }).catch(() => {});
    }
    await settleReconcile(audioDurationMs / 60_000);
    const sil = await detectSilences(filePath).catch(() => ({ midpoints: [] as number[], intervals: [] as { startMs: number; endMs: number }[] }));
    console.log(`[tts-gemini] done: ${chunks.length} segment(s), ${audioDurationMs}ms total, ${sil.intervals.length} silences`);
    return NextResponse.json({
      voiceUrl,
      audioDurationMs,
      timing: { provider: "gemini" as const, segments, chars: null, silences: sil.midpoints, silenceIntervals: sil.intervals },
    });
  } catch (error) {
    // Generation threw after the up-front reserve → refund it so a crash never
    // leaks ceiling minutes (managed only; BYOK never held a reserve).
    if (!aiReserveSettled && aiReserveEnforce && aiReserveUserId && aiReservedMin > 0) {
      await refundAiAudioMinutes(aiReserveUserId, aiReservedMin).catch(() => {});
    }
    console.error("[tts-gemini] top-level error:", error);
    return apiError({ route: "POST /api/videos/tts-gemini", error, notifyUser: true });
  }
}
