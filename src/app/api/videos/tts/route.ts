import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import os from "os";
import { execFileSync } from "child_process";
import { fetchWithBudget } from "@/lib/fetch-budget";
import { classifyHttpStatus, isProviderError, providerError, toErrorResponse } from "@/lib/provider-errors";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import {
  splitScriptForTts,
  mergeSegmentTiming,
  mergeCharAlignments,
  type TtsCharAlignment,
} from "@/lib/tts-timing";

export const maxDuration = 300; // TTS budget is 300s/attempt (long scripts)
export const runtime = "nodejs";

// ~1,500 chars per chunk at sentence boundaries (VideoForge-proven size for
// ElevenLabs). Chunks are exact contiguous slices of the script — the same
// iron rule as tts-gemini: subtitle text must be the string sent to TTS.
const ELEVENLABS_CHUNK_CHARS = 1500;

// ElevenLabs /with-timestamps response alignment (their field names)
interface ElAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

type ElCallResult =
  | { ok: true; mp3: Buffer; alignment: ElAlignment | null }
  | { ok: false; status: number; errBody: string };

// One ElevenLabs call for one chunk, degrading gracefully:
//   1. /with-timestamps + language_code
//   2. /with-timestamps without language_code (some keys/models reject it)
//   3. plain endpoint + language_code        (audio only, no timing)
//   4. plain endpoint without language_code
// retries: 0 at the HTTP layer everywhere — TTS POST spends user character
// credits; a client-side timeout after server-side success would double-charge
// on retry (same policy as HeyGen generate). Failed HTTP calls are not charged,
// so walking down this chain never double-spends.
async function callElevenLabs(
  apiKey: string,
  voiceId: string,
  text: string,
  languageCode: string | undefined,
  label: string,
): Promise<ElCallResult> {
  const variants: { withTimestamps: boolean; lang: boolean }[] = [
    { withTimestamps: true, lang: !!languageCode },
    ...(languageCode ? [{ withTimestamps: true, lang: false }] : []),
    { withTimestamps: false, lang: !!languageCode },
    ...(languageCode ? [{ withTimestamps: false, lang: false }] : []),
  ];

  let lastStatus = 500;
  let lastErrBody = "";

  for (const v of variants) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}${v.withTimestamps ? "/with-timestamps" : ""}`;
    const res = await fetchWithBudget(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_v3",
        ...(v.lang ? { language_code: languageCode } : {}),
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true },
      }),
    }, { provider: "elevenlabs", timeoutMs: 300_000, retries: 0, wallClockMs: 320_000, returnHttpErrors: true });

    if (res.ok) {
      if (v.withTimestamps) {
        const data = await res.json() as { audio_base64: string; alignment: ElAlignment | null };
        if (!v.lang || !languageCode) console.log(`[tts] ${label}: ok via ${v.withTimestamps ? "with-timestamps" : "plain"}${v.lang ? "" : " (no language_code)"}`);
        return { ok: true, mp3: Buffer.from(data.audio_base64, "base64"), alignment: data.alignment ?? null };
      }
      console.warn(`[tts] ${label}: with-timestamps unavailable — fell back to plain endpoint (no char timing)`);
      return { ok: true, mp3: Buffer.from(await res.arrayBuffer()), alignment: null };
    }

    lastStatus = res.status;
    lastErrBody = await res.text();
    console.error(`[tts] ${label} ${v.withTimestamps ? "with-timestamps" : "plain"}${v.lang ? "+lang" : ""} failed: ${res.status} ${lastErrBody.slice(0, 150)}`);

    // Auth/quota errors won't be fixed by switching endpoint or dropping
    // language_code — stop walking the chain and surface the real error.
    if (res.status === 401 || res.status === 429 || lastErrBody.includes("quota_exceeded")) break;
  }

  return { ok: false, status: lastStatus, errBody: lastErrBody };
}

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

function normalizeAlignment(a: ElAlignment): { characters: string[]; startSec: number[]; endSec: number[] } {
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
  const { text, voiceId = "9lvVsLbaxGND6aZnt1W1", languageCode = "th" } = body ?? {};
  if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { id: authUser.id },
    select: { elevenlabsKey: true, plan: true },
  });
  if (user?.plan === "FREE") return NextResponse.json({ error: "ElevenLabs TTS ใช้ได้เฉพาะแผน Pro ขึ้นไป" }, { status: 403 });
  if (!user?.elevenlabsKey) return NextResponse.json({ error: "ElevenLabs API key not set", missingKey: "elevenlabs" }, { status: 400 });
  const apiKey = Buffer.from(user.elevenlabsKey, "base64").toString("utf-8");

  // IRON RULE: fullText is the one string both TTS and subtitles see.
  const fullText: string = (text as string).trim();
  const chunks = splitScriptForTts(fullText, ELEVENLABS_CHUNK_CHARS);
  console.log(`[tts] ElevenLabs script ${fullText.length} chars → ${chunks.length} chunk(s)`);

  const mp3s: Buffer[] = [];
  const alignments: (ElAlignment | null)[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const r = await callElevenLabs(apiKey, voiceId, chunks[i].text, languageCode, `chunk ${i + 1}/${chunks.length}`);
    if (!r.ok) {
      // Same failure surface as the old single-call route. No automatic
      // full-script re-run: chunks already generated were paid for — burning
      // the full script again on top would double the user's credit spend.
      const code = r.errBody.includes("quota_exceeded") ? ("quota" as const) : classifyHttpStatus(r.status);
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
  if (alignments.every((a): a is ElAlignment => a !== null) && haveProbes) {
    try {
      const merged = mergeCharAlignments(alignments.map(normalizeAlignment), durationsSec);
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
