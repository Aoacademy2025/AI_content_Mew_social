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

function getFfmpegPath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(process.cwd(), "node_modules", "@ffmpeg-installer", `${process.platform}-${process.arch}`, `ffmpeg${ext}`);
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

// ── Local Whisper via Python script ──────────────────────────────────────────
// Uses openai-whisper (pip install openai-whisper) with word_timestamps=True.
// Returns null if Python/whisper not available → caller falls back to OpenAI API.
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? "medium";
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
      maxBuffer: 20 * 1024 * 1024,
      timeout: 240_000,  // 4 min max
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
      select: { openaiKey: true, geminiKey: true },
    });

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
      inputPath = path.join(process.cwd(), "public", audioUrl);
      if (!fs.existsSync(inputPath)) return NextResponse.json({ error: "File not found" }, { status: 400 });
    } else {
      // If URL points to our own server, rewrite to localhost to avoid self-fetch issues
      const fetchUrl = audioUrl.replace(/^https?:\/\/[^/]+(\/.*)$/, (_: string, p: string) => `http://localhost:3000${p}`);
      const audioRes = await fetch(fetchUrl);
      if (!audioRes.ok) return NextResponse.json({ error: `Failed to fetch audio file (${audioRes.status}): ${fetchUrl}` }, { status: 400 });
      inputPath = path.join(tmpDir, `transcribe-tmp-${ts}.mp4`);
      fs.writeFileSync(inputPath, Buffer.from(await audioRes.arrayBuffer()));
      needsCleanup = true;
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
    if (needsCleanup) try { fs.unlinkSync(inputPath); } catch {}

    type WhisperWord = { word: string; start: number; end: number };
    type WhisperSegment = { text: string; start: number; end: number };
    let words: WhisperWord[] = [];
    let segments: WhisperSegment[] = [];
    let fullText = "";

    // ── Strategy 1: Local Whisper (free, better Thai accuracy) ──
    console.log(`[transcribe] trying local Whisper (model=${WHISPER_MODEL})...`);
    const localResult = await runLocalWhisper(mp3Path);

    if (localResult && (localResult.words.length > 0 || localResult.segments.length > 0)) {
      console.log(`[transcribe] local Whisper OK — ${localResult.words.length} words, ${localResult.segments.length} segs`);
      words    = localResult.words;
      segments = localResult.segments;
      fullText = localResult.text;
      try { fs.unlinkSync(mp3Path); } catch {}
    } else {
      // ── Strategy 2: OpenAI Whisper API (fallback) ──
      console.log("[transcribe] local Whisper unavailable — falling back to OpenAI API");
      let apiKey = process.env.SERVER_OPENAI_API_KEY ?? null;
      if (!apiKey) {
        if (!user?.openaiKey) {
          try { fs.unlinkSync(mp3Path); } catch {}
          return NextResponse.json({ error: "OpenAI API key not set (and local Whisper not available)", missingKey: "openai" }, { status: 400 });
        }
        apiKey = Buffer.from(user.openaiKey, "base64").toString("utf-8");
      }

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
        return apiError({ route: "videos/transcribe", error: new Error(err), notifyUser: true });
      }

      const data = await whisperRes.json();
      words    = data.words    ?? [];
      segments = data.segments ?? [];
      fullText = data.text     ?? "";
      console.log(`[transcribe] OpenAI Whisper OK — ${words.length} words, ${segments.length} segs`);
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
      const sourceText: string = (typeof script === "string" && script.trim().length > 0)
        ? script.trim() : fullText;
      const audioDur = segments.length > 0
        ? segments[segments.length - 1].end
        : words.length > 0
          ? words[words.length - 1].end
          : 30; // reasonable fallback

      // ── Step 1: Get phrases from GPT (split script into natural subtitle lines) ──
      let phrases: string[] = [];

      if (apiKey) {
        try {
          const durationSec = audioDur;
          const minPhrases = Math.max(2, Math.floor(durationSec / 5));
          const maxPhrases = Math.max(minPhrases + 2, Math.ceil(durationSec / 2));

          const splitPrompt = `You are an expert Thai short-video subtitle editor for TikTok/Reels.

TASK: Split the script into natural subtitle phrases.

━━━ SPLITTING RULES ━━━
• Audio duration: ${durationSec.toFixed(1)}s → target ${minPhrases}–${maxPhrases} phrases total
• Each phrase = one complete thought unit (8–30 chars).
• Split at sentence-ending punctuation (. ? ! ฯ) or major conjunctions (แต่, และ, เพราะ, จึง).
• NEVER split mid-sentence just to hit a char limit.
• Short punchy lines like "ผิดสัตว์", "ลองดูก่อน" → keep as ONE phrase.
• NEVER split a date expression — keep "วันที่ 13 เมษายน 2569", "13 เมษายน 2569" as ONE phrase each.
• NEVER change, correct, or modify any word from the original script. Copy every character exactly as-is.

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
              const stripped = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
              const jsonMatch = stripped.match(/\{[\s\S]*\}/);
              gptRawText = jsonMatch ? jsonMatch[0] : stripped;
            } catch (e) {
              console.warn("[transcribe] Gemini split failed:", e);
            }
          } else {
            const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: splitPrompt }], max_tokens: 800, temperature: 0, response_format: { type: "json_object" } }),
            });
            if (gptRes.ok) {
              const d = await gptRes.json();
              gptRawText = d.choices?.[0]?.message?.content ?? "{}";
            }
          }

          if (gptRawText !== "{}") {
            try {
              const parsed = JSON.parse(gptRawText);
              const raw: string[] = Array.isArray(parsed.phrases) ? parsed.phrases : [];
              const normalize = (s: string) => s.replace(/\s+/g, "").replace(/[.,!?。、฿"'\-–—]/g, "");
              const origStripped = normalize(sourceText);
              const outStripped = normalize(raw.join(""));
              const charRatio = origStripped.length > 0 ? outStripped.length / origStripped.length : 0;
              if (raw.length > 0 && charRatio >= 0.90 && charRatio <= 1.05) {
                phrases = raw.map((p: string) => p.trim()).filter(Boolean);
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
          result.push({ text: phrases[i], startMs: Math.round(startSec * 1000), endMs: Math.round(endSec * 1000) });
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

    return NextResponse.json({ captions, segments: rawSegments, words: wordTimestamps, fullText });
  } catch (error) {
    return apiError({ route: "videos/transcribe", error, notifyUser: true });
  }
}
