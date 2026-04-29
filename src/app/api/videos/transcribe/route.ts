import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { apiError } from "@/lib/api-error";
import { geminiGenerateText } from "@/lib/gemini";

export const maxDuration = 300;  // local Whisper can take longer

const SRT_TIME_RE = /^\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?$/;
const SRT_ARROW_RE = /^\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?\s*-->\s*\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?$/;

function stripSrtArtifacts(input: string): string {
  return input
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (l === "✕" || l === "···" || l === "..." || l === "…") return false;
      if (SRT_ARROW_RE.test(l) || SRT_TIME_RE.test(l)) return false;
      if (/^\d{1,6}$/.test(l)) return false;
      if (/^(CTA|HOOK|BODY|OUTRO|INTRO)$/i.test(l)) return false;
      return true;
    })
    .join("\n")
    .replace(/\([^\n]{0,80}\n[^\n]{0,80}\)/g, (m) => m.replace(/\n/g, " "))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeTranscriptionText(input: string): string {
  if (!input) return "";
  const filtered = stripSrtArtifacts(input);
  return filtered
    .replace(/\r/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^\s*[·•…]{2,}\s*$/gm, "")
    .replace(/^\s*✕\s*$/gm, "")
    .replace(/\"{2,}/g, "")
    .replace(/\.{2,}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitizePhraseText(input: string): string {
  return sanitizeTranscriptionText(input)
    .replace(/^[·•…]{2,}$/g, "")
    .replace(/^\s*✕+\s*$/g, "")
    .replace(/["“”'’]/g, "")
    .replace(/\.{2,}/g, "")
    .trim();
}

function normalizeForCompare(input: string): string {
  return sanitizeTranscriptionText(input)
    .replace(/\s+/g, "")
    .replace(/[.,!?·•…฿"'\-–—()]/g, "");
}

function splitTextByTargetLen(input: string, targetLen: number, minChunk: number): string[] {
  const text = sanitizeTranscriptionText(input);
  if (!text) return [];

  const tokens = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  const maxLen = Math.max(minChunk, Math.floor(targetLen));

  if (tokens.length <= 1) {
    let chunk = "";
    for (const ch of [...text]) {
      chunk += ch;
      if (chunk.replace(/\s+/g, "").length >= maxLen && /\s/.test(ch)) {
        out.push(chunk.trim());
        chunk = "";
      }
    }
    if (chunk.trim()) out.push(chunk.trim());
    if (out.length <= 1 && text.length > maxLen * 1.4) {
      const chars = [...text];
      const fixed: string[] = [];
      for (let i = 0; i < chars.length; i += maxLen) {
        fixed.push(chars.slice(i, i + maxLen).join("").trim());
      }
      return fixed.filter(Boolean);
    }
    return out;
  }

  let line = "";
  for (const tok of tokens) {
    const next = line ? `${line} ${tok}` : tok;
    if (line && next.replace(/\s+/g, "").length > maxLen) {
      out.push(line.trim());
      line = tok;
    } else {
      line = next;
    }
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

function expandPhrasesToTargetDensity(phrases: string[], targetCount: number, fallbackText: string): string[] {
  if (!Array.isArray(phrases) || phrases.length === 0) return [];
  if (phrases.length >= targetCount) return phrases;
  const combined = sanitizeTranscriptionText(phrases.join(" "));
  const source = combined || sanitizeTranscriptionText(fallbackText);
  if (!source) return phrases;
  const targetLen = Math.max(10, Math.floor(source.replace(/\s+/g, "").length / targetCount));
  return splitTextByTargetLen(source, targetLen, 10);
}

function parseSplitPhrasesFromRaw(raw: string): string[] {
  if (!raw) return [];
  try {
    const stripped = raw
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    const arr = Array.isArray(parsed?.phrases) ? parsed.phrases : [];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p): p is string => typeof p === "string")
      .map((p) => sanitizePhraseText(p))
      .filter((p) => p.length > 0);
  } catch {
    return [];
  }
}

function getFfmpegPath(): string {
  if (process.platform !== "win32") return "/usr/bin/ffmpeg";
  return path.join(process.cwd(), "node_modules", "@ffmpeg-installer", `win32-${process.arch}`, "ffmpeg.exe");
}

function getFfprobePath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  const ffmpegDir = path.join(
    process.cwd(),
    "node_modules",
    "@ffmpeg-installer",
    `${process.platform}-${process.arch}`,
  );
  const probe = path.join(ffmpegDir, `ffprobe${ext}`);
  if (fs.existsSync(probe)) return probe;
  return path.join(ffmpegDir, `ffmpeg${ext}`);
}

function extractAudioMp3(ffmpegPath: string, inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, [
      "-y", "-i", inputPath,
      "-vn", "-acodec", "libmp3lame", "-ab", "64k", "-ar", "16000", "-ac", "1",
      outputPath,
    ], { maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg audio extract failed: ${err.message}\n${stderr?.slice(-300)}`));
      else resolve();
    });
  });
}

function getAudioDurationMs(audioPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = getFfprobePath();
    if (!fs.existsSync(probe)) return reject(new Error("ffprobe/ffmpeg not found"));

    if (probe.toLowerCase().includes("ffprobe")) {
      execFile(probe, [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "csv=p=0", audioPath,
      ], (err, stdout) => {
        if (err) return reject(err);
        const sec = parseFloat(stdout.trim());
        if (!Number.isFinite(sec)) return reject(new Error("Could not parse duration"));
        resolve(Math.max(1, Math.round(sec * 1000)));
      });
      return;
    }

    execFile(probe, ["-i", audioPath, "-f", "null", "-"], { maxBuffer: 5 * 1024 * 1024 }, (_err, _stdout, stderr) => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
      if (!m) return reject(new Error("Could not parse duration from ffmpeg"));
      const ms = (parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 1000 + parseInt(m[4], 10) * 10;
      resolve(Math.max(1, ms));
    });
  });
}

// ── Local Whisper via Python script ──────────────────────────────────────────
// Uses openai-whisper (pip install openai-whisper) with word_timestamps=True.
// Returns null if Python/whisper not available → caller falls back to OpenAI API.
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? "base";
const WHISPER_SCRIPT = path.join(process.cwd(), "scripts", "whisper_transcribe.py");

function getPythonCmd(): string {
  return process.platform === "win32" ? "python" : "python3";
}

interface LocalWhisperResult {
  text: string;
  words: { word: string; start: number; end: number }[];
  segments: { text: string; start: number; end: number }[];
  language: string;
}

function runLocalWhisper(audioPath: string): Promise<LocalWhisperResult | null> {
  return new Promise((resolve) => {
    if (!fs.existsSync(WHISPER_SCRIPT)) { resolve(null); return; }
    const python = getPythonCmd();
    execFile(python, [WHISPER_SCRIPT, audioPath, WHISPER_MODEL], {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 600_000,  // 10 min max
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    }, (err, stdout, stderr) => {
      if (err) {
        console.error("[transcribe] local whisper error:", stderr?.slice(-500));
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.error) { console.error("[transcribe] whisper script error:", parsed.error); resolve(null); return; }
        resolve(parsed as LocalWhisperResult);
      } catch {
        console.error("[transcribe] whisper JSON parse failed:", stdout.slice(0, 200));
        resolve(null);
      }
    });
  });
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { audioUrl, scriptPrompt, script } = await req.json();
    if (!audioUrl) {
      return NextResponse.json({ error: "audioUrl is required" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { openaiKey: true, geminiKey: true, ttsProvider: true },
    });

    // Use the exact same model selection as Extract Keywords (LLM) step 1:
    // SERVER_OPENAI_API_KEY → OpenAI; else ttsProvider drives preference; else whichever key exists
    const hasServerKey = !!process.env.SERVER_OPENAI_API_KEY;
    const preferGemini = !hasServerKey && user?.ttsProvider === "gemini";
    const preferOpenAI = !hasServerKey && (user?.ttsProvider === "elevenlabs" || user?.ttsProvider === "openai");
    const useGeminiTranscribe = !hasServerKey && (
      (preferGemini && !!user?.geminiKey) ||
      (!preferOpenAI && !!user?.geminiKey)
    );
    const useOpenAITranscribe = !useGeminiTranscribe && (
      hasServerKey ||
      (preferOpenAI && !!user?.openaiKey) ||
      !!user?.openaiKey
    );

    // Resolve local file path or download remote
    const ts = Date.now();
    const tmpDir = path.join(process.cwd(), "stocks");
    fs.mkdirSync(tmpDir, { recursive: true });
    let inputPath: string;
    let needsCleanup = false;

    if (audioUrl.startsWith("/api/stocks/")) {
      const filename = audioUrl.replace("/api/stocks/", "");
      inputPath = path.join(tmpDir, filename);
      if (!fs.existsSync(inputPath)) return NextResponse.json({ error: "File not found" }, { status: 400 });
    } else if (audioUrl.startsWith("/")) {
      inputPath = path.join(process.cwd(), "public", audioUrl.replace(/^\/api\/renders\//, "/renders/"));
      if (!fs.existsSync(inputPath)) return NextResponse.json({ error: "File not found" }, { status: 400 });
    } else {
      // Extract local path from full URL if pointing to our own server, then read from disk
      const localMatch = audioUrl.match(/^https?:\/\/[^/]+(\/.*)/);
      const localPath = localMatch ? path.join(process.cwd(), "public", localMatch[1].replace(/^\/api\/renders\//, "/renders/")) : null;
      if (localPath && fs.existsSync(localPath)) {
        inputPath = localPath;
      } else {
        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) return NextResponse.json({ error: `Failed to fetch audio file (${audioRes.status}): ${audioUrl}` }, { status: 400 });
        inputPath = path.join(tmpDir, `transcribe-tmp-${ts}.mp4`);
        fs.writeFileSync(inputPath, Buffer.from(await audioRes.arrayBuffer()));
        needsCleanup = true;
      }
    }

    // Extract audio as mp3 (mono 16kHz) — required for both local Whisper and OpenAI API
    const ffmpeg = getFfmpegPath();
    const mp3Path = path.join(tmpDir, `transcribe-audio-${ts}.mp3`);
    try {
      await extractAudioMp3(ffmpeg, inputPath, mp3Path);
    } catch (e) {
      console.error("[transcribe] ffmpeg extract failed:", e);
      if (needsCleanup) try { fs.unlinkSync(inputPath); } catch {}
      return NextResponse.json({ error: "ไม่สามารถแกะเสียงจากไฟล์ได้" }, { status: 500 });
    }
    let sourceAudioDurationMs = 0;
    try {
      sourceAudioDurationMs = await getAudioDurationMs(mp3Path);
      console.log(`[transcribe] source audio duration ${sourceAudioDurationMs}ms`);
    } catch (e) {
      console.warn("[transcribe] failed to read mp3 duration:", e);
    }
    if (needsCleanup) try { fs.unlinkSync(inputPath); } catch {}

    type WhisperWord = { word: string; start: number; end: number };
    type WhisperSegment = { text: string; start: number; end: number };
    let words: WhisperWord[] = [];
    let segments: WhisperSegment[] = [];
    let fullText = "";

    if (useGeminiTranscribe) {
      // ── Strategy 1: Gemini Audio Transcribe ──
      console.log("[transcribe] using Gemini transcribe...");
      try {
        const geminiKey = Buffer.from(user!.geminiKey!, "base64").toString("utf-8");
        const audioBuffer = fs.readFileSync(mp3Path);
        try { fs.unlinkSync(mp3Path); } catch {}
        const audioB64 = audioBuffer.toString("base64");

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: `Transcribe this Thai audio exactly word-for-word. Return ONLY the transcribed text, no explanation, no translation.\n${script ? `Reference script (do NOT modify): ${script.trim()}` : ""}` },
                  { inlineData: { mimeType: "audio/mp3", data: audioB64 } },
                ],
              }],
              generationConfig: { temperature: 0 },
            }),
          }
        );

        if (!geminiRes.ok) {
          const errBody = await geminiRes.text().catch(() => "");
          console.error("[transcribe] Gemini error body:", errBody.slice(0, 500));
          if (geminiRes.status === 401 || geminiRes.status === 403) {
            throw { status: geminiRes.status, body: errBody };
          }
          throw new Error(`Gemini transcribe failed: ${geminiRes.status} — ${errBody.slice(0, 200)}`);
        }
        const geminiData = await geminiRes.json();
        fullText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
        console.log(`[transcribe] Gemini OK — ${fullText.length} chars`);
      } catch (e: unknown) {
        console.error("[transcribe] Gemini transcribe error:", e);
        const status = (e as { status?: number })?.status;
        if (status === 401) {
          return NextResponse.json({ error: "Gemini API Key ไม่ถูกต้อง กรุณาตรวจสอบใน Settings", missingKey: "gemini" }, { status: 401 });
        }
        if (status === 403) {
          return NextResponse.json({ error: "Gemini API Key ไม่มีสิทธิ์ใช้งาน กรุณาเปิดใช้งาน Gemini API ใน Google AI Studio", retryable: false }, { status: 403 });
        }
        return NextResponse.json({ error: "Gemini transcribe ไม่สำเร็จ กรุณาลองใหม่", retryable: true }, { status: 503 });
      }
    } else if (useOpenAITranscribe) {
      // ── Strategy 2: OpenAI Whisper API ──
      console.log("[transcribe] using OpenAI Whisper API...");
      const rawKey = process.env.SERVER_OPENAI_API_KEY ?? (user?.openaiKey ? Buffer.from(user.openaiKey, "base64").toString("utf-8") : "");
      const apiKey = rawKey;
      const audioBuffer = fs.readFileSync(mp3Path);
      try { fs.unlinkSync(mp3Path); } catch {}
      const audioBlob = new Blob([audioBuffer], { type: "audio/mpeg" });
      const form = new FormData();
      form.append("file", audioBlob, "audio.mp3");
      form.append("model", "whisper-1");
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      form.append("timestamp_granularities[]", "segment");
      if (scriptPrompt?.trim()) form.append("prompt", scriptPrompt.trim().slice(0, 800));

      const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!whisperRes.ok) {
        const err = await whisperRes.text();
        return NextResponse.json({ error: `OpenAI Whisper ไม่สำเร็จ: ${err.slice(0, 200)}` }, { status: 500 });
      }
      const data = await whisperRes.json();
      words    = data.words    ?? [];
      segments = data.segments ?? [];
      fullText = data.text     ?? "";
      console.log(`[transcribe] OpenAI Whisper OK — ${words.length} words`);
    } else {
      // ── Strategy 3: Local Whisper (fallback) ──
      console.log(`[transcribe] trying local Whisper (model=${WHISPER_MODEL})...`);
      const localResult = await runLocalWhisper(mp3Path);
      if (localResult && (localResult.words.length > 0 || localResult.segments.length > 0)) {
        console.log(`[transcribe] local Whisper OK — ${localResult.words.length} words, ${localResult.segments.length} segs`);
        words    = localResult.words;
        segments = localResult.segments;
        fullText = localResult.text;
        try { fs.unlinkSync(mp3Path); } catch {}
      } else {
        try { fs.unlinkSync(mp3Path); } catch {}
        return NextResponse.json({ error: "Whisper ไม่สำเร็จ กรุณากด Transcribe ใหม่อีกครั้ง", retryable: true }, { status: 503 });
      }
    }

    // ── Get LLM key for subtitle splitting (Gemini preferred, fallback OpenAI) ──
    let apiKey = process.env.SERVER_OPENAI_API_KEY ?? null;
    let useGemini = false;
    if (!apiKey) {
      if (user?.geminiKey) { apiKey = Buffer.from(user.geminiKey, "base64").toString("utf-8"); useGemini = true; }
      else if (user?.openaiKey) { apiKey = Buffer.from(user.openaiKey, "base64").toString("utf-8"); }
    }

    // Detect if Thai — local Whisper large-v3-turbo has word-level for Thai too,
    // but quality varies. Use segment-level grouping for Thai; word-level for Latin scripts.
    const isThai = /[\u0E00-\u0E7F]/.test(fullText);

    let captions;

    if (isThai || words.length === 0) {
      const sourceRaw: string = (typeof script === "string" && script.trim().length > 0)
        ? script.trim() : fullText;
      const sourceText = sanitizeTranscriptionText(sourceRaw);
      const fallbackDur = sourceAudioDurationMs > 0 ? sourceAudioDurationMs / 1000 : 30;
      const audioDur = Math.max(
        segments.length > 0 ? segments[segments.length - 1].end : 0,
        words.length > 0 ? words[words.length - 1].end : 0,
        fallbackDur
      );

      // ── Step 1: Get phrases from GPT (split script into natural subtitle lines) ──
      let phrases: string[] = [];
      let minPhrases = 4;
      let maxPhrases = 6;
      const openAiSplitModel = process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini";

      if (apiKey) {
        try {
          const durationSec = audioDur;
          const sourceLen = sourceText.replace(/\s+/g, "").length;
          minPhrases = Math.max(4, Math.floor(durationSec / 5));
          maxPhrases = Math.max(minPhrases + 2, Math.ceil(durationSec / 2));

          const splitPrompt = `You are an expert Thai short-video subtitle editor for TikTok/Reels.

TASK: Rewrite the script into short natural subtitle phrases.

━━━ SPLITTING RULES ━━━
• Audio duration: ${durationSec.toFixed(1)}s → target ${minPhrases}–${maxPhrases} phrases total
• Each phrase = one complete thought unit (8–30 chars ideal, hard max 36 chars).
• Split at sentence-ending punctuation (. ? ! ฯ) or major conjunctions (แต่, และ, เพราะ, จึง).
• NEVER split mid-sentence just to hit a char limit.
• Short punchy lines like "ผิดสัตว์", "ลองดูก่อน" → keep as ONE phrase.
• NEVER split a date expression — keep "วันที่ 13 เมษายน 2569", "13 เมษายน 2569" as ONE phrase each.
• Keep core meaning but rewrite wording for subtitle readability.
• Do NOT invent facts not present in the source.

━━━ OUTPUT FORMAT ━━━
Return ONLY valid JSON — no markdown, no explanation:
{"phrases":["phrase1","phrase2"]}

━━━ SCRIPT TO PROCESS ━━━
${sourceText.trim()}`;

          let gptRawText = "{}";
          if (useGemini) {
            try {
              const raw = await geminiGenerateText(apiKey, splitPrompt, 4096);
              console.log(`[transcribe] Gemini split raw:`, raw.slice(0, 300));
              gptRawText = parseSplitPhrasesFromRaw(raw).length > 0 ? raw : "{}";
            } catch (e) {
              console.warn("[transcribe] Gemini split failed:", e);
            }
          } else {
            const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ model: openAiSplitModel, messages: [{ role: "user", content: splitPrompt }], max_tokens: 800, temperature: 0, response_format: { type: "json_object" } }),
            });
            if (gptRes.ok) {
              const d = await gptRes.json();
              gptRawText = d.choices?.[0]?.message?.content ?? "{}";
            }
          }

          if (gptRawText !== "{}") {
            try {
              const raw = parseSplitPhrasesFromRaw(gptRawText);
              const origStripped = normalizeForCompare(sourceText);
              const outStripped = normalizeForCompare(raw.join(""));
              const charRatio = origStripped.length > 0 ? outStripped.length / origStripped.length : 0;
              if (raw.length > 0 && charRatio >= 0.45 && charRatio <= 1.80) {
                const expanded = expandPhrasesToTargetDensity(raw, minPhrases, sourceText);
                phrases = expanded.length > 0 ? expanded : raw;
                console.log(`[transcribe] LLM split → ${phrases.length} phrases (ratio=${charRatio.toFixed(3)})`);
              } else {
                console.warn(`[transcribe] LLM mismatch — orig:${origStripped.length} out:${outStripped.length} ratio=${charRatio.toFixed(3)}, using fallback`);
              }
            } catch (e) {
              console.warn("[transcribe] LLM parse failed:", e);
            }
          }
        } catch (e) {
          console.warn("[transcribe] LLM split failed:", e);
        }
      }

      if (phrases.length > 0 && phrases.length < minPhrases) {
        phrases = expandPhrasesToTargetDensity(phrases, minPhrases, sourceText);
      }

      // ── Fallback: split by sentence punctuation or newlines ─────────────────
      if (phrases.length === 0) {
        const MONTHS = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
        const isMonth = (s: string) => MONTHS.some(m => s.trim().startsWith(m));
        const isYear  = (s: string) => /^\d{4}$/.test(s.trim());
        const isDateN = (s: string) => /^(วันที่\s*)?\d{1,2}$/.test(s.trim());

        // If single paragraph (no newlines), split by sentence-ending punctuation first
        let rawLines: string[];
        if (!sourceText.includes("\n")) {
          // Split at Thai sentence ends: . ! ? ฯ — keep delimiter
          rawLines = sourceText
            .split(/(?<=[.!?ฯ])\s+/)
            .flatMap(chunk => chunk.split(/(?<=[\u0E00-\u0E7F]{10,})\s+(?=[\u0E00-\u0E7F])/))
            .filter(Boolean);
          if (rawLines.length <= 1) {
            // Last resort: split by spaces every ~15 chars of Thai content
            const chars = [...sourceText];
            const out: string[] = []; let buf = "";
            for (const ch of chars) {
              buf += ch;
              const thaiLen = (buf.match(/[\u0E00-\u0E7F]/g) ?? []).length;
              if (thaiLen >= 15 && /\s/.test(ch)) { out.push(buf.trim()); buf = ""; }
            }
            if (buf.trim()) out.push(buf.trim());
            rawLines = out.length > 1 ? out : [sourceText];
          }
        } else {
          rawLines = sourceText.split("\n");
        }

        for (let i = 0; i < rawLines.length; i++) {
          const cur = rawLines[i].trim();
          if (!cur) continue;
          if (isDateN(cur)) {
            const num = cur.replace(/^วันที่\s*/, "").trim();
            let combined = num; let skip = 0;
            if (i + 1 < rawLines.length && isMonth(rawLines[i + 1])) {
              combined += " " + rawLines[i + 1].trim(); skip++;
              if (i + 2 < rawLines.length && isYear(rawLines[i + 2])) { combined += " " + rawLines[i + 2].trim(); skip++; }
            }
            phrases.push(combined); i += skip; continue;
          }
          if (isMonth(cur) && i + 1 < rawLines.length && isYear(rawLines[i + 1])) {
            phrases.push(cur + " " + rawLines[i + 1].trim()); i++; continue;
          }
          phrases.push(cur);
        }
        console.log(`[transcribe] fallback split → ${phrases.length} phrases`);
        if (phrases.length > 0 && phrases.length < minPhrases) {
          phrases = expandPhrasesToTargetDensity(phrases, minPhrases, sourceText);
        }
      }

      // ── Step 2: Align phrases → Whisper timestamps ──────────────────────────
      // Strategy A (preferred): word-level forced alignment
      //   Strip each phrase and each whisper word to bare Thai chars,
      //   greedily consume words until phrase chars are covered → use word start/end.
      // Strategy B (fallback): segment-level char-weighted mapping
      //   Use Whisper segment start/end times, weighted by phrase char length.

      if (phrases.length > 0) {
        // ── Timestamp mapping: proportional by char length across audio timeline ──
        //
        // We DO NOT try to match phrase text against Whisper output — Thai Whisper
        // often transcribes differently from the script (different spelling, particles,
        // spaces).  Instead we use Whisper only for the AUDIO TIMELINE (where is
        // each second of speech) and distribute phrases proportionally by char count.
        //
        // Timeline source priority:
        //   1. word-level timestamps  → finer-grained, 1 entry per word char
        //   2. segment-level timestamps → fallback, 1 entry per segment
        //
        // Both produce a sorted array of { sec } "time points" that span [0, audioDur].
        // We then divide that array proportionally among phrases by their char counts.

        // Build a sorted timeline of (sec) anchor points
        type TimePoint = { sec: number };
        let timeline: TimePoint[] = [];

        if (words.length > 0) {
          // One point per word (use word midpoint for stability)
          for (const w of words) {
            timeline.push({ sec: (w.start + w.end) / 2 });
          }
        } else if (segments.length > 0) {
          for (const seg of segments) {
            timeline.push({ sec: seg.start });
            timeline.push({ sec: seg.end });
          }
        }

        // Normalise: make sure we have at least 2 points covering [0, audioDur]
        if (timeline.length === 0 || timeline[0].sec > 0.1) {
          timeline.unshift({ sec: 0 });
        }
        if (timeline[timeline.length - 1].sec < audioDur - 0.1) {
          timeline.push({ sec: audioDur });
        }

        // Helper: get time at fractional position [0,1] through the timeline
        function timeAtFrac(frac: number): number {
          const f = Math.max(0, Math.min(1, frac));
          if (f === 0) return timeline[0].sec;
          if (f === 1) return timeline[timeline.length - 1].sec;
          const idx = f * (timeline.length - 1);
          const lo  = Math.floor(idx);
          const hi  = Math.min(lo + 1, timeline.length - 1);
          const rem = idx - lo;
          return timeline[lo].sec + rem * (timeline[hi].sec - timeline[lo].sec);
        }

        // Distribute phrases proportionally by their char count
        const charLengths = phrases.map(p => Math.max(1, p.replace(/\s+/g, "").length));
        const totalPhraseChars = charLengths.reduce((a, b) => a + b, 0);
        const result: { text: string; startMs: number; endMs: number }[] = [];
        let cumChars = 0;

        for (let i = 0; i < phrases.length; i++) {
          const startFrac = cumChars / totalPhraseChars;
          cumChars += charLengths[i];
          const endFrac = cumChars / totalPhraseChars;
          const startSec = timeAtFrac(startFrac);
          const endSec   = timeAtFrac(endFrac);
          const cleanedText = phrases[i].replace(/["""'’]/g, "").replace(/\.{2,}/g, "").trim();
          result.push({ text: cleanedText, startMs: Math.round(startSec * 1000), endMs: Math.round(endSec * 1000) });
        }

        // Pin first caption to 0 and last to audioDur
        if (result.length > 0) {
          result[0].startMs = 0;
          result[result.length - 1].endMs = Math.round(audioDur * 1000);
        }

        captions = result.map(g => ({ text: g.text, startMs: g.startMs, endMs: g.endMs, timestampMs: g.startMs, confidence: 1 }));
        console.log(`[transcribe] proportional-mapped ${captions.length} captions, dur=${audioDur.toFixed(2)}s, points=${timeline.length}`);
        captions.forEach((c, i) => console.log(`  [${i}] ${(c.startMs/1000).toFixed(2)}s–${(c.endMs/1000).toFixed(2)}s "${c.text.slice(0,30)}"`));

      } else {
        // Last resort: use raw Whisper segments grouped by duration
        const merged: { text: string; startMs: number; endMs: number }[] = [];
        let buf = "", bufStart = 0, bufEnd = 0;
        for (const seg of segments) {
          const text = seg.text.trim();
          if (!text) continue;
          if (!buf) { buf = text; bufStart = seg.start; bufEnd = seg.end; continue; }
          if (buf.length + text.length > 20 || seg.end - bufStart > 4) {
            merged.push({ text: buf, startMs: Math.round(bufStart * 1000), endMs: Math.round(bufEnd * 1000) });
            buf = text; bufStart = seg.start; bufEnd = seg.end;
          } else { buf += text; bufEnd = seg.end; }
        }
        if (buf) merged.push({ text: buf, startMs: Math.round(bufStart * 1000), endMs: Math.round(bufEnd * 1000) });
        captions = merged.map(g => ({ text: g.text, startMs: g.startMs, endMs: g.endMs, timestampMs: g.startMs, confidence: 1 }));
      }
    } else if (words.length > 0) {
      // Word-level grouping for non-Thai (English, etc.)
      const MAX_WORDS = 4;
      const MAX_DURATION_S = 2.0;

      const groups: { text: string; startMs: number; endMs: number }[] = [];
      let bucket: string[] = [];
      let bucketStart = words[0].start;
      let bucketEnd = words[0].end;

      for (const w of words) {
        const tooLong = (w.end - bucketStart) > MAX_DURATION_S;
        const tooMany = bucket.length >= MAX_WORDS;

        if ((tooLong || tooMany) && bucket.length > 0) {
          groups.push({
            text: bucket.join(" "),
            startMs: Math.round(bucketStart * 1000),
            endMs: Math.round(bucketEnd * 1000),
          });
          bucket = [w.word];
          bucketStart = w.start;
          bucketEnd = w.end;
        } else {
          bucket.push(w.word);
          bucketEnd = w.end;
        }
      }
      if (bucket.length > 0) {
        groups.push({
          text: bucket.join(" "),
          startMs: Math.round(bucketStart * 1000),
          endMs: Math.round(bucketEnd * 1000),
        });
      }

      captions = groups.map((g) => ({
        text: g.text.trim(),
        startMs: g.startMs,
        endMs: g.endMs,
        timestampMs: g.startMs,
        confidence: 1,
      }));
    }

    // Also return raw segment-level timestamps (natural speech boundaries)
    const rawSegments = segments.map((seg) => ({
      text: seg.text.trim(),
      startMs: Math.round(seg.start * 1000),
      endMs: Math.round(seg.end * 1000),
    }));

    // Raw word timestamps for forced alignment on client
    const wordTimestamps = words.map((w) => ({
      word: w.word,
      startMs: Math.round(w.start * 1000),
      endMs: Math.round(w.end * 1000),
    }));

    const safeFullText = sanitizeTranscriptionText(fullText);
    const resolvedDurationMs = Math.max(
      sourceAudioDurationMs,
      captions.at(-1)?.endMs ?? 0,
      rawSegments.at(-1)?.endMs ?? 0,
      wordTimestamps.at(-1)?.endMs ?? 0,
      1000,
    );

    return NextResponse.json({
      captions,
      segments: rawSegments,
      words: wordTimestamps,
      fullText: safeFullText,
      audioDurationMs: resolvedDurationMs,
    });
  } catch (error) {
    return apiError({ route: "videos/transcribe", error, notifyUser: true });
  }
}
