import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { decryptKey } from "@/lib/key-crypto";
import path from "path";
import fs from "fs";
import os from "os";
import { execFileSync } from "child_process";
import {
  classifyHttpResponse,
  isProviderError,
  providerError,
  toErrorResponse,
} from "@/lib/provider-errors";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import {
  cachedVoicePreview,
  getVoicePreviewCachePath,
  normalizeVoicePreviewText,
} from "@/lib/voice-preview-cache";
import {
  splitScriptForTts,
  mergeSegmentTiming,
  mergeCharAlignments,
  type TtsCharAlignment,
} from "@/lib/tts-timing";
import {
  synthesizeElevenLabsV3,
  type ElevenLabsAlignment,
} from "@/lib/elevenlabs-v3.server";

export const maxDuration = 300; // TTS budget is 300s/attempt (long scripts)
export const runtime = "nodejs";

// ~1,500 chars per chunk at sentence boundaries (VideoForge-proven size for
// ElevenLabs). Chunks are exact contiguous slices of the script — the same
// iron rule as tts-gemini: subtitle text must be the string sent to TTS.
const ELEVENLABS_CHUNK_CHARS = 1500;

function ffprobeDurationSec(filePath: string): number {
  const ffprobe = getFfmpegPath().replace(/ffmpeg(\.exe)?$/, (m) => m.replace("ffmpeg", "ffprobe"));
  try {
    const out = execFileSync(ffprobe, ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", filePath], { encoding: "utf-8", timeout: 10_000 });
    return parseFloat(out.trim()) || 0;
  } catch {
    return 0;
  }
}

function concatMp3(ffmpegPath: string, parts: string[], outPath: string, workDir: string): void {
  const listFile = path.join(workDir, "concat_list.txt");
  fs.writeFileSync(listFile, parts.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n"));
  execFileSync(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outPath], { stdio: "pipe", timeout: 60_000 });
}

function normalizeAlignment(a: ElevenLabsAlignment): { characters: string[]; startSec: number[]; endSec: number[] } {
  return { characters: a.characters, startSec: a.character_start_times_seconds, endSec: a.character_end_times_seconds };
}

// POST /api/videos/tts
// Body: { text, voiceId?, languageCode? }
// Returns: { voiceUrl, audioDurationMs, timing? }
//   timing (additive — old clients ignore it): char-level alignment from
//   ElevenLabs /with-timestamps, merged across chunks with real (ffprobe)
//   chunk durations. `timing.chars` is null when any chunk had to fall back
//   to the plain endpoint — segments stay exact, the editor interpolates.
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
  const { text, voiceId = "9lvVsLbaxGND6aZnt1W1", languageCode = "th", preview = false, speed = 1 } = body ?? {};
  if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { id: authUser.id },
    select: { elevenlabsKey: true, plan: true },
  });
  if (user?.plan === "FREE") return NextResponse.json({ error: "ElevenLabs TTS ใช้ได้เฉพาะแผน Pro ขึ้นไป" }, { status: 403 });
  if (!user?.elevenlabsKey) return NextResponse.json({ error: "ElevenLabs API key not set", missingKey: "elevenlabs" }, { status: 400 });
  const apiKey = decryptKey(user.elevenlabsKey);
  const selectedVoiceId = typeof voiceId === "string" && voiceId.trim() ? voiceId.trim() : "9lvVsLbaxGND6aZnt1W1";

  if (preview === true) {
    const previewText = normalizeVoicePreviewText(text);
    const cache = getVoicePreviewCachePath({
      provider: "elevenlabs",
      userId: authUser.id,
      voiceKey: `${selectedVoiceId}:${languageCode ?? ""}`,
      text: previewText,
      ext: "mp3",
    });
    const cached = cachedVoicePreview(cache.filePath, cache.voiceUrl);
    if (cached) return NextResponse.json({ ...cached, preview: true });

    const r = await synthesizeElevenLabsV3({ apiKey, voiceId: selectedVoiceId, text: previewText, languageCode, speed, label: "preview" });
    if (!r.ok) {
      const code = classifyHttpResponse(r.status, r.errBody);
      const pErr = providerError(code, "elevenlabs", `ElevenLabs preview failed (${r.status}): ${r.errBody.slice(0, 200)}`, { status: r.status });
      const { body: errBody, status } = toErrorResponse(pErr);
      return NextResponse.json(errBody, { status });
    }
    fs.writeFileSync(cache.filePath, r.mp3);
    const durationSec = ffprobeDurationSec(cache.filePath);
    return NextResponse.json({
      voiceUrl: cache.voiceUrl,
      ...(durationSec > 0 ? { audioDurationMs: Math.round(durationSec * 1000) } : {}),
      preview: true,
      cached: false,
    });
  }

  // IRON RULE: fullText is the one string both TTS and subtitles see.
  const fullText: string = (text as string).trim();
  const chunks = splitScriptForTts(fullText, ELEVENLABS_CHUNK_CHARS);
  console.log(`[tts] ElevenLabs script ${fullText.length} chars → ${chunks.length} chunk(s)`);

  const mp3s: Buffer[] = [];
  const alignments: (ElevenLabsAlignment | null)[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const r = await synthesizeElevenLabsV3({
      apiKey,
      voiceId: selectedVoiceId,
      text: chunks[i].text,
      languageCode,
      speed,
      label: `chunk ${i + 1}/${chunks.length}`,
    });
    if (!r.ok) {
      // Same failure surface as the old single-call route. No automatic
      // full-script re-run: chunks already generated were paid for — burning
      // the full script again on top would double the user's credit spend.
      const code = classifyHttpResponse(r.status, r.errBody);
      const pErr = providerError(code, "elevenlabs", `ElevenLabs failed (${r.status}): ${r.errBody.slice(0, 200)}`, { status: r.status });
      const { body: errBody, status } = toErrorResponse(pErr);
      return NextResponse.json(errBody, { status });
    }
    mp3s.push(r.mp3);
    alignments.push(r.alignment);
  }

  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const filename = `tts-${Date.now()}.mp3`;
  const outPath = path.join(rendersDir, filename);

  // Per-chunk durations come from the real audio (ffprobe), not the
  // alignment tail — the model occasionally clips trailing silence
  // (VideoForge lesson). Offsets derived from these are what keep chunk 2+'s
  // char timestamps honest.
  let durationsSec: number[] = [];

  if (mp3s.length === 1) {
    fs.writeFileSync(outPath, mp3s[0]);
    durationsSec = [ffprobeDurationSec(outPath)];
  } else {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-el-"));
    try {
      const partPaths = mp3s.map((buf, i) => {
        const p = path.join(workDir, `chunk_${i}.mp3`);
        fs.writeFileSync(p, buf);
        return p;
      });
      durationsSec = partPaths.map(ffprobeDurationSec);
      concatMp3(getFfmpegPath(), partPaths, outPath, workDir);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  const probedTotalSec = ffprobeDurationSec(outPath);
  const audioDurationMs = Math.round((probedTotalSec > 0 ? probedTotalSec : durationsSec.reduce((a, b) => a + b, 0)) * 1000);

  // timing.chars only when EVERY chunk has alignment AND the merged text is
  // exactly fullText — anything less degrades to segments-only (editor then
  // interpolates within segments instead of silently mis-timing).
  let chars: TtsCharAlignment | null = null;
  const haveProbes = durationsSec.every((d) => d > 0);
  const completeAlignments = alignments.filter((a): a is ElevenLabsAlignment => a !== null);
  if (completeAlignments.length === alignments.length && haveProbes) {
    try {
      const merged = mergeCharAlignments(completeAlignments.map(normalizeAlignment), durationsSec);
      if (merged.characters.join("") === fullText) {
        chars = merged;
      } else {
        console.warn(`[tts] alignment text != script (${merged.characters.length} vs ${fullText.length} chars) — dropping char timing`);
      }
    } catch (e) {
      console.warn(`[tts] alignment merge failed — dropping char timing: ${e instanceof Error ? e.message : e}`);
    }
  }

  const segments = haveProbes
    ? mergeSegmentTiming(chunks.map((c, i) => ({ text: c.text, durationMs: Math.round(durationsSec[i] * 1000) })))
    : null;

  for (let i = 0; i < chunks.length; i++) {
    console.log(`[tts] chunk ${i + 1}/${chunks.length}: ${Math.round((durationsSec[i] ?? 0) * 1000)}ms, ${chunks[i].text.replace(/\s+/g, "").length} chars, aligned=${alignments[i] ? "yes" : "no"}`);
  }
  console.log(`[tts] done: ${chunks.length} chunk(s), ${audioDurationMs}ms total, charTiming=${chars ? "exact" : "none"}`);

  return NextResponse.json({
    voiceUrl: `/api/renders/${filename}`,
    // omit when ffprobe is unavailable (e.g. Windows without @ffprobe-installer)
    // — a 0 here would mislead timing consumers
    ...(audioDurationMs > 0 ? { audioDurationMs } : {}),
    ...(segments ? {
      timing: {
        provider: "elevenlabs" as const,
        segments,
        chars,
      },
    } : {}),
  });
}
