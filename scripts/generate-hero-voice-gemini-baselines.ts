// T4 — Gemini baseline clips for the Hero Voice emotion-quality blind A/B.
// Renders the 3 fixed Thai eval scripts x {Aoede (female default), Puck (first
// male voice in the product's picker list)} through the SAME call path the
// product uses today (src/app/api/videos/tts-gemini/route.ts), so the "Gemini"
// arm of the A/B is an honest reference, not a re-implementation.
//
// Run: npx tsx scripts/generate-hero-voice-gemini-baselines.ts
//
// Source-of-truth file:line refs (see task-4-report.md for the full trace):
//   - Model chain + request/response shape: src/app/api/videos/tts-gemini/route.ts:44-163
//   - WAV framing (mono 16-bit PCM, 44-byte RIFF header):
//     src/app/api/videos/tts-gemini/route.ts:235-257
//   - Managed key resolution: src/lib/gemini-key.ts:7-19 (imported directly, not
//     re-implemented)
//   - Voice roster + gender/order: src/lib/gemini-voices.ts:1-17 (imported
//     directly; GEMINI_VOICES[0] = "Puck", the first Male-gendered entry, is
//     the male arm per the amended brief)
//   - Chunk sizing (imported, not re-implemented; these scripts are short
//     enough to always produce exactly 1 chunk — chooseChunkChars only kicks
//     in above 1600 chars): src/lib/tts-timing.ts:83-89,184+

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import dotenv from "dotenv";
import { Agent, fetch as undiciFetch } from "undici";

import { resolveGeminiKey, KeyRequiredError } from "../src/lib/gemini-key";
import { GEMINI_VOICES } from "../src/lib/gemini-voices";
import { splitScriptForTts, pcmDurationMs } from "../src/lib/tts-timing";
import { getFfmpegPath } from "../src/lib/ffmpeg-path";

dotenv.config({ path: ".env", override: false, quiet: true });

// ---------------------------------------------------------------------------
// Fixed eval scripts — VERBATIM from the brief, including punctuation. The
// guillemets (« ») in the brief are the brief's own quoting delimiters, not
// part of the spoken text, so they are not included here.
// ---------------------------------------------------------------------------
const SCRIPTS: { id: "s1" | "s2" | "s3"; text: string }[] = [
  {
    id: "s1",
    text: "หยุดเลื่อนก่อน! ถ้าคุณทำคลิปสั้นแล้วยอดไม่ขึ้นสักที วันนี้มีคำตอบ เพราะปัญหาไม่ใช่คอนเทนต์คุณไม่ดี แต่คุณพลาดสามวินาทีแรกต่างหาก เดี๋ยวเล่าให้ฟังว่าแก้ยังไง",
  },
  {
    id: "s2",
    text: "เมื่อวันที่ 15 มีนาคม 2568 ร้านเล็กๆ ร้านหนึ่งในเชียงใหม่ เริ่มโพสต์คลิปวันละ 1 คลิป ผ่านไป 90 วัน ยอดขายเพิ่มขึ้น 250 เปอร์เซ็นต์ จากลูกค้าแค่ 20 คนต่อเดือน กลายเป็น 500 คน เคล็ดลับของเขาไม่ใช่โชค แต่คือความสม่ำเสมอ และการเล่าเรื่องที่คนฟังแล้วรู้สึกว่า เรื่องนี้มันคือเรา",
  },
  {
    id: "s3",
    text: "ลองใช้ HERO AI Creator Studio ดูสิครับ แค่วางสคริปต์ ระบบจะใส่เสียงพากย์ ซับไตเติล และ B-roll ให้อัตโนมัติ ไม่ต้องเปิด Premiere ไม่ต้องจ้างทีมตัดต่อ สมัครวันนี้ ทดลองใช้ฟรี 7 วัน แล้วคุณจะรู้ว่าทำคลิปมันง่ายกว่าที่คิด",
  },
];

const FEMALE_VOICE = "Aoede"; // product's single universal default (route.ts:321,323)
const firstMale = GEMINI_VOICES.find((v) => v.gender === "Male");
if (!firstMale) throw new Error("GEMINI_VOICES has no Male-gendered entry — cannot resolve male arm");
const MALE_VOICE = firstMale.id; // GEMINI_VOICES[0] per src/lib/gemini-voices.ts:2

const VOICES: { arm: "female" | "male"; voiceName: string }[] = [
  { arm: "female", voiceName: FEMALE_VOICE },
  { arm: "male", voiceName: MALE_VOICE },
];

const OUTPUT_DIR = path.resolve("artifacts", "hero-voice-ab-2026-07-24", "gemini");

// ---------------------------------------------------------------------------
// Exact replica of the production model chain + retry semantics.
// Source: src/app/api/videos/tts-gemini/route.ts:44-163 (callGeminiTts is not
// exported, so this mirrors it verbatim rather than re-implementing new
// behavior — same models, same order, same request body shape, same retry/
// backoff rules).
// ---------------------------------------------------------------------------
const MODEL_CHAIN = [
  "gemini-2.5-flash-preview-tts",
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-pro-preview-tts",
];
const MAX_ATTEMPTS = 3;
const NO_AUDIO = "__NO_AUDIO__";

const geminiTtsDispatcher = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });

type TtsCallResult =
  | { ok: true; pcm: Buffer; sampleRate: number; model: string }
  | { ok: false; status: number; errBody: string };

async function callGeminiTts(apiKey: string, text: string, voiceName: string): Promise<TtsCallResult> {
  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  });

  let lastErrBody = "";
  let lastStatus = 500;

  for (const model of MODEL_CHAIN) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await undiciFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
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
        console.log(`[gemini-baselines] ok with ${model} (attempt ${attempt}), mimeType=${mimeType}`);
        return {
          ok: true,
          pcm: Buffer.from(audioB64, "base64"),
          sampleRate: rateMatch ? parseInt(rateMatch[1], 10) : 24000,
          model,
        };
      }

      lastErrBody = await res.text();
      lastStatus = res.status;

      if (res.status === 401 || res.status === 403 || res.status === 404) {
        console.warn(`[gemini-baselines] ${model} returned ${res.status} — trying next model`);
        break;
      }
      if (res.status === 400) {
        console.error(`[gemini-baselines] bad request (400) for ${model}:`, lastErrBody.slice(0, 200));
        return { ok: false, status: 400, errBody: lastErrBody };
      }
      if (attempt < MAX_ATTEMPTS) {
        const delayMs = 1500 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
        console.warn(`[gemini-baselines] ${model} transient ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}), retry in ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        console.warn(`[gemini-baselines] ${model} exhausted retries — trying next model`);
      }
    }
  }

  return { ok: false, status: lastStatus, errBody: lastErrBody };
}

// PCM s16le mono -> WAV (44-byte header). Verbatim from
// src/app/api/videos/tts-gemini/route.ts:235-257.
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
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(numChannels, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(byteRate, 28);
  wavHeader.writeUInt16LE(blockAlign, 32);
  wavHeader.writeUInt16LE(bitsPerSample, 34);
  wavHeader.write("data", 36);
  wavHeader.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([wavHeader, pcmBuffer]);
}

// Resample raw s16le mono PCM to 24kHz via ffmpeg — only invoked when the API
// returns a rate other than 24000 (should not happen for this model chain,
// but the brief requires the conversion path to exist and be noted).
function resamplePcmTo24k(pcm: Buffer, fromRate: number): Buffer {
  const ffmpeg = getFfmpegPath();
  const tmpIn = path.join(OUTPUT_DIR, `.resample-in-${process.pid}-${Date.now()}.raw`);
  const tmpOut = path.join(OUTPUT_DIR, `.resample-out-${process.pid}-${Date.now()}.raw`);
  fs.writeFileSync(tmpIn, pcm);
  try {
    execFileSync(ffmpeg, [
      "-y",
      "-f", "s16le", "-ar", String(fromRate), "-ac", "1", "-i", tmpIn,
      "-f", "s16le", "-ar", "24000", "-ac", "1",
      tmpOut,
    ]);
    return fs.readFileSync(tmpOut);
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

function isNonSilent(pcm: Buffer): boolean {
  // Simple peak-amplitude check over s16le samples.
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const sample = Math.abs(pcm.readInt16LE(i));
    if (sample > peak) peak = sample;
    if (peak > 500) return true; // early exit once clearly non-silent
  }
  return peak > 500;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

type ClipMeta = {
  scriptId: string;
  arm: "male" | "female";
  voiceName: string;
  model: string;
  apiSampleRateHz: number;
  outputSampleRateHz: number;
  resampled: boolean;
  textSha256: string;
  durationMs: number;
  nonSilent: boolean;
  generatedAt: string;
  file: string;
};

async function main() {
  const managed = process.env.MANAGED_GEMINI === "1";
  const hasServerKey = !!process.env.GEMINI_SERVER_KEY?.trim();
  if (!managed || !hasServerKey) {
    console.error(
      "[gemini-baselines] BLOCKED — MANAGED_GEMINI=1 and/or GEMINI_SERVER_KEY not present in .env. " +
      "Not substituting any other key, not touching prod. See src/lib/gemini-key.ts:7-19.",
    );
    process.exitCode = 1;
    return;
  }

  let apiKey: string;
  let mode: "managed" | "byok";
  try {
    // Same call the production route makes (src/app/api/videos/tts-gemini/route.ts:334-342).
    // A null geminiKey means: if managed isn't actually resolvable, this throws
    // KeyRequiredError rather than silently falling back to a BYOK path we
    // don't have — which is exactly what we want here (managed-only baseline).
    const resolved = resolveGeminiKey({ geminiKey: null, plan: "BUSINESS" });
    apiKey = resolved.key;
    mode = resolved.mode;
  } catch (e) {
    if (e instanceof KeyRequiredError) {
      console.error("[gemini-baselines] BLOCKED — resolveGeminiKey threw KeyRequiredError.");
      process.exitCode = 1;
      return;
    }
    throw e;
  }
  if (mode !== "managed") {
    console.error(`[gemini-baselines] BLOCKED — resolveGeminiKey resolved mode="${mode}", expected "managed".`);
    process.exitCode = 1;
    return;
  }
  console.log("[gemini-baselines] key resolved via managed path (mode=managed, no values printed)");

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const metas: ClipMeta[] = [];

  for (const script of SCRIPTS) {
    // Mirrors the production route's chunking call (route.ts:437) — these
    // scripts are all well under SHORT_SCRIPT_CHARS (1600), so this always
    // produces exactly one chunk whose text === script.text.
    const chunks = splitScriptForTts(script.text);
    if (chunks.length !== 1) {
      throw new Error(`${script.id}: expected 1 chunk for a short eval script, got ${chunks.length}`);
    }

    for (const { arm, voiceName } of VOICES) {
      console.log(`[gemini-baselines] generating ${script.id}-${arm} (voice=${voiceName})...`);
      const r = await callGeminiTts(apiKey, chunks[0].text, voiceName);
      if (!r.ok) {
        throw new Error(`${script.id}-${arm}: Gemini TTS call failed (status=${r.status}) ${r.errBody.slice(0, 300)}`);
      }

      let pcm = r.pcm;
      let outputRate = r.sampleRate;
      let resampled = false;
      if (r.sampleRate !== 24000) {
        console.warn(`[gemini-baselines] ${script.id}-${arm}: API returned ${r.sampleRate}Hz, resampling to 24000Hz`);
        pcm = resamplePcmTo24k(r.pcm, r.sampleRate);
        outputRate = 24000;
        resampled = true;
      }

      const durationMs = Math.round(pcmDurationMs(pcm.length, outputRate));
      const nonSilent = isNonSilent(pcm);
      const filename = `${script.id}-${arm}.wav`;
      const outPath = path.join(OUTPUT_DIR, filename);
      fs.writeFileSync(outPath, wavFromPcm(pcm, outputRate));

      console.log(`[gemini-baselines] wrote ${filename}: ${durationMs}ms, model=${r.model}, nonSilent=${nonSilent}, resampled=${resampled}`);

      metas.push({
        scriptId: script.id,
        arm,
        voiceName,
        model: r.model,
        apiSampleRateHz: r.sampleRate,
        outputSampleRateHz: outputRate,
        resampled,
        textSha256: sha256(script.text),
        durationMs,
        nonSilent,
        generatedAt: new Date().toISOString(),
        file: filename,
      });
    }
  }

  const metadata = {
    task: "T4 — Gemini baseline clips (Hero Voice emotion-quality blind A/B)",
    generatedAt: new Date().toISOString(),
    callPath: {
      endpoint: "POST /api/videos/tts-gemini",
      route: "src/app/api/videos/tts-gemini/route.ts:44-163 (model chain, request/response shape, retry semantics)",
      wavFraming: "src/app/api/videos/tts-gemini/route.ts:235-257",
      keyResolution: "src/lib/gemini-key.ts:7-19 (imported and called directly, managed mode)",
      voiceRoster: "src/lib/gemini-voices.ts:1-17",
      chunkSizing: "src/lib/tts-timing.ts:83-89,184+ (imported, not re-implemented)",
      modelChain: MODEL_CHAIN,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "<per-clip, see clips[]>" } } },
      },
    },
    voices: {
      female: { voiceName: FEMALE_VOICE, rationale: "product's single universal default — route.ts:321,323" },
      male: { voiceName: MALE_VOICE, rationale: "first Male-gendered entry in GEMINI_VOICES — src/lib/gemini-voices.ts:2" },
    },
    outputFormat: "mono, 24000 Hz, 16-bit PCM WAV",
    clips: metas,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, "metadata.json"), JSON.stringify(metadata, null, 2));
  console.log(`[gemini-baselines] wrote metadata.json (${metas.length} clips)`);

  const anySilent = metas.some((m) => !m.nonSilent);
  if (anySilent) {
    console.error("[gemini-baselines] WARNING: at least one clip failed the non-silent check — see metadata.json");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[gemini-baselines] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
