import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { apiError } from "@/lib/api-error";
import { omnivoiceBaseUrl, isValidOmniVoiceId, pcmFromWav, type OmniTtsResponse } from "@/lib/omnivoice";
import {
  splitScriptForTts,
  mergeSegmentTiming,
  charsPerSecGuard,
  pcmDurationMs,
} from "@/lib/tts-timing";
import {
  cachedVoicePreview,
  getVoicePreviewCachePath,
  normalizeVoicePreviewText,
} from "@/lib/voice-preview-cache";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { getFfmpegPath } from "@/lib/ffmpeg-path";

export const maxDuration = 300;
export const runtime = "nodejs";

// OmniVoice = self-hosted server ของเราเอง (ไม่ใช่ BYOK, ไม่มี per-call spend)
// → ไม่มี minute-quota / AI-ceiling logic เหมือน tts-gemini; แค่ auth ก็พอ
// โครง segmented + timing ลอกแบบ tts-gemini เพื่อให้ซับ exact-by-arithmetic
// (ข้าม transcribe) ตาม gotcha ใน CLAUDE.md

const MAX_ATTEMPTS = 2;
const SEGMENTED_BUDGET_MS = 240_000;

type CallResult =
  | { ok: true; pcm: Buffer; sampleRate: number }
  | { ok: false; status: number; errBody: string };

async function callOmniVoice(
  voiceId: string,
  text: string,
  speed: number,
  deadline?: number,
): Promise<CallResult> {
  let lastStatus = 500;
  let lastErrBody = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (deadline && Date.now() >= deadline) {
      return { ok: false, status: 408, errBody: "segmented time budget exhausted" };
    }
    try {
      const res = await fetch(`${omnivoiceBaseUrl()}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_id: voiceId, text, speed }),
        // GPU ~1s/ประโยค แต่ CPU ~30s/ประโยค + คิวภายใน — เผื่อ 180s
        signal: AbortSignal.timeout(180_000),
      });
      if (res.ok) {
        const data = (await res.json()) as OmniTtsResponse;
        if (!data.audio_base64) return { ok: false, status: 500, errBody: "no audio in response" };
        const { pcm, sampleRate } = pcmFromWav(Buffer.from(data.audio_base64, "base64"));
        return { ok: true, pcm, sampleRate: sampleRate || data.sample_rate || 24000 };
      }
      lastStatus = res.status;
      lastErrBody = await res.text().catch(() => "");
      // 404 = voice ไม่มี / 422 = body ผิด — retry ไม่ช่วย
      if (res.status === 404 || res.status === 422) break;
    } catch (e) {
      lastStatus = 503;
      lastErrBody = e instanceof Error ? e.message : String(e);
    }
    if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 1500 * attempt));
  }
  return { ok: false, status: lastStatus, errBody: lastErrBody };
}

function omniErrorResponse(status: number, errBody: string) {
  if (status === 404) {
    return NextResponse.json({ error: "ไม่พบเสียง OmniVoice ที่เลือก — เลือกเสียงใหม่อีกครั้ง" }, { status: 404 });
  }
  if (status === 422) {
    return NextResponse.json({ error: "ข้อความไม่ผ่านการตรวจของ OmniVoice server" }, { status: 422 });
  }
  console.error(`[tts-omnivoice] upstream ${status}:`, errBody.slice(0, 200));
  return NextResponse.json({
    error: "OmniVoice TTS ขัดข้องชั่วคราว — ลองอีกครั้ง หรือสลับเป็น Gemini/ElevenLabs",
    retryable: true,
  }, { status: 503 });
}

// PCM s16le mono → WAV (layout เดียวกับ tts-gemini)
function wavFromPcm(pcmBuffer: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcmBuffer.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(numChannels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([h, pcmBuffer]);
}

function saveWav(wavBuffer: Buffer): { voiceUrl: string; filePath: string } {
  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const filename = `tts-omni-${Date.now()}.wav`;
  const filePath = path.join(rendersDir, filename);
  fs.writeFileSync(filePath, wavBuffer);
  return { voiceUrl: `/api/renders/${filename}`, filePath };
}

// silencedetect เดียวกับ tts-gemini — card boundary snap ใช้ตอนตัดซับ
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

// POST /api/videos/tts-omnivoice
// Body: { text, voiceId, speed?, preview? }
// Returns: { voiceUrl, audioDurationMs, timing? } — สัญญาเดียวกับ tts-gemini
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => null);
    const { text, voiceId = "voice_01", speed = 1.0, preview = false } = body ?? {};
    if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });
    if (!isValidOmniVoiceId(voiceId)) return NextResponse.json({ error: "voiceId ไม่ถูกต้อง" }, { status: 400 });
    const spd = Math.min(3.0, Math.max(0.3, Number(speed) || 1.0));

    if (preview === true) {
      const previewText = normalizeVoicePreviewText(text);
      const cache = getVoicePreviewCachePath({
        provider: "omnivoice",
        userId: authUser.id,
        voiceKey: voiceId,
        text: previewText,
        ext: "wav",
      });
      const cached = cachedVoicePreview(cache.filePath, cache.voiceUrl);
      if (cached) return NextResponse.json({ ...cached, preview: true });
      const r = await callOmniVoice(voiceId, previewText, spd);
      if (!r.ok) return omniErrorResponse(r.status, r.errBody);
      fs.writeFileSync(cache.filePath, wavFromPcm(r.pcm, r.sampleRate));
      return NextResponse.json({
        voiceUrl: cache.voiceUrl,
        audioDurationMs: Math.round(pcmDurationMs(r.pcm.length, r.sampleRate)),
        preview: true,
        cached: false,
      });
    }

    // IRON RULE เดียวกับ tts-gemini: fullText คือ string เดียวที่ทั้ง TTS และซับเห็น
    const fullText: string = (text as string).trim();
    const chunks = splitScriptForTts(fullText);
    const deadline = Date.now() + SEGMENTED_BUDGET_MS;
    console.log(`[tts-omnivoice] script ${fullText.length} chars → ${chunks.length} segment(s)`);

    // ---- Segmented pass ----
    let pcms: Buffer[] | null = [];
    const durations: number[] = [];
    let sampleRate = 0;
    let failOpen = "";

    for (let i = 0; i < chunks.length; i++) {
      const r = await callOmniVoice(voiceId, chunks[i].text, spd, chunks.length > 1 ? deadline : undefined);
      if (!r.ok) {
        if (chunks.length === 1) return omniErrorResponse(r.status, r.errBody);
        failOpen = `segment ${i + 1}/${chunks.length} failed (${r.status})`;
        pcms = null;
        break;
      }
      if (sampleRate === 0) sampleRate = r.sampleRate;
      else if (r.sampleRate !== sampleRate) {
        failOpen = `sample rate changed mid-clip (${sampleRate} → ${r.sampleRate})`;
        pcms = null;
        break;
      }
      pcms.push(r.pcm);
      durations.push(Math.round(pcmDurationMs(r.pcm.length, r.sampleRate)));
    }

    // ---- Desync guard: segment ที่อัตราพูดหลุด median = เสียงเพี้ยน → gen ใหม่ ----
    if (pcms && chunks.length > 1) {
      const GUARD_ROUNDS = 3;
      for (let round = 1; round <= GUARD_ROUNDS; round++) {
        const outliers = charsPerSecGuard(chunks.map((c, i) => ({ text: c.text, durationMs: durations[i] })));
        if (outliers.length === 0) break;
        if (round === GUARD_ROUNDS) {
          failOpen = `guard still failing after retries: [${outliers.join(", ")}]`;
          pcms = null;
          break;
        }
        console.warn(`[tts-omnivoice] guard round ${round}: outlier segments [${outliers.join(", ")}] — retrying`);
        for (const idx of outliers) {
          const r = await callOmniVoice(voiceId, chunks[idx].text, spd, deadline);
          if (r.ok && r.sampleRate === sampleRate) {
            pcms[idx] = r.pcm;
            durations[idx] = Math.round(pcmDurationMs(r.pcm.length, sampleRate));
          }
        }
      }
    }

    // ---- Fail-open: segmented พัง → single call ไม่มี timing (editor จะใช้ transcribe fallback) ----
    if (!pcms) {
      console.warn(`[tts-omnivoice] fail-open → single call (${failOpen})`);
      const r = await callOmniVoice(voiceId, fullText, spd);
      if (!r.ok) return omniErrorResponse(r.status, r.errBody);
      const { voiceUrl } = saveWav(wavFromPcm(r.pcm, r.sampleRate));
      return NextResponse.json({
        voiceUrl,
        audioDurationMs: Math.round(pcmDurationMs(r.pcm.length, r.sampleRate)),
      });
    }

    // ---- Success: concat PCM → WAV เดียว → timing ตรงเป๊ะ ----
    const segments = mergeSegmentTiming(chunks.map((c, i) => ({ text: c.text, durationMs: durations[i] })));
    const audioDurationMs = durations.reduce((a, b) => a + b, 0);
    const { voiceUrl, filePath } = saveWav(wavFromPcm(Buffer.concat(pcms), sampleRate));
    const sil = await detectSilences(filePath).catch(() => ({ midpoints: [] as number[], intervals: [] as { startMs: number; endMs: number }[] }));
    console.log(`[tts-omnivoice] done: ${chunks.length} segment(s), ${audioDurationMs}ms total`);
    return NextResponse.json({
      voiceUrl,
      audioDurationMs,
      timing: { provider: "omnivoice" as const, segments, chars: null, silences: sil.midpoints, silenceIntervals: sil.intervals },
    });
  } catch (error) {
    console.error("[tts-omnivoice] top-level error:", error);
    return apiError({ route: "POST /api/videos/tts-omnivoice", error, notifyUser: true });
  }
}
