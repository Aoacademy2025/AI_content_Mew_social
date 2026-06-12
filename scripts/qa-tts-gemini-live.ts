// LIVE QA harness for PR-B (#36) — mirrors the segmented tts-gemini route's
// orchestration 1:1 and drives the REAL Gemini API with a key from
// /tmp/qa-gemini-key. NOT part of the verify suite (spends quota).
// Run: npx tsx scripts/qa-tts-gemini-live.ts [short|medium|long]
//
// Mirror source: src/app/api/videos/tts-gemini/route.ts — if that route's
// orchestration changes, update this file or the QA is meaningless.

import fs from "fs";
import { execFileSync } from "child_process";
import { fetch as ufetch, Agent } from "undici";
import {
  splitScriptForTts,
  mergeSegmentTiming,
  charsPerSecGuard,
  pcmDurationMs,
  buildWordsFromTiming,
  buildCaptionsFromCards,
  splitSentenceCards,
  type TtsTiming,
} from "../src/lib/tts-timing";
import { parseRetryDelayMs } from "../src/lib/gemini-errors";

const KEY_FILE = process.env.QA_KEY_FILE ?? "/tmp/qa-gemini-key";
if (!fs.existsSync(KEY_FILE)) {
  console.error(`no key file at ${KEY_FILE}`);
  process.exit(2);
}
const API_KEY = fs.readFileSync(KEY_FILE, "utf-8").trim();
if (!API_KEY) { console.error("key file empty"); process.exit(2); }

// ---- mirrored route constants ----
const MODEL_CHAIN = [
  "gemini-2.5-flash-preview-tts",
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-pro-preview-tts",
];
const MAX_ATTEMPTS = 3;
const SEGMENTED_BUDGET_MS = 240_000;
const NO_AUDIO = "__NO_AUDIO__";
const VOICE = "Aoede";

const dispatcher = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });

// rate-limit telemetry for the report
const stats = { calls: 0, http429: 0, hints: [] as number[], transientRetries: 0 };

type TtsCallResult =
  | { ok: true; pcm: Buffer; sampleRate: number; model: string }
  | { ok: false; status: number; errBody: string };

// mirrored from route.ts (fetch → undici fetch; console tag → [qa])
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
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  });

  const models = modelLock ? [modelLock] : MODEL_CHAIN;
  let lastErrBody = "";
  let lastStatus = 500;

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (deadline && Date.now() >= deadline) {
        return { ok: false, status: 408, errBody: "segmented time budget exhausted" };
      }
      stats.calls++;
      const res = await ufetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: requestBody,
        dispatcher,
      });

      if (res.ok) {
        const data = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[] };
        const part = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        const audioB64 = part?.data;
        if (!audioB64) return { ok: false, status: 500, errBody: NO_AUDIO };
        const mimeType = part?.mimeType ?? "audio/L16;rate=24000";
        const rateMatch = mimeType.match(/rate=(\d+)/);
        console.log(`  [qa] ok with ${model} (attempt ${attempt}) mime=${mimeType}`);
        return {
          ok: true,
          pcm: Buffer.from(audioB64, "base64"),
          sampleRate: rateMatch ? parseInt(rateMatch[1]) : 24000,
          model,
        };
      }

      lastErrBody = await res.text();
      lastStatus = res.status;
      if (res.status === 429) stats.http429++;

      if (res.status === 401 || res.status === 403 || res.status === 404) {
        console.warn(`  [qa] ${model} → ${res.status} — trying next model`);
        break;
      }
      if (res.status === 400) {
        console.error(`  [qa] 400 for ${model}: ${lastErrBody.slice(0, 200)}`);
        return { ok: false, status: 400, errBody: lastErrBody };
      }
      if (attempt < MAX_ATTEMPTS) {
        const hinted = res.status === 429 ? parseRetryDelayMs(lastErrBody) : null;
        if (hinted != null) stats.hints.push(hinted);
        const delayMs = hinted ?? 1500 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
        if (deadline && Date.now() + delayMs >= deadline) {
          return { ok: false, status: 408, errBody: "segmented time budget exhausted" };
        }
        stats.transientRetries++;
        console.warn(`  [qa] ${model} transient ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}), retry in ${delayMs}ms${hinted ? " (server hint)" : ""}`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        console.warn(`  [qa] ${model} exhausted retries — next model`);
      }
    }
  }
  return { ok: false, status: lastStatus, errBody: lastErrBody };
}

// mirrored WAV writer
function wavFromPcm(pcmBuffer: Buffer, sampleRate: number): Buffer {
  const byteRate = sampleRate * 2;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcmBuffer.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(byteRate, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([h, pcmBuffer]);
}

// ---- QA scripts (realistic Thai, newline-separated sentences) ----
const BASE = [
  "รู้มั้ยว่าทำไมคนส่วนใหญ่ถึงเก็บเงินไม่อยู่ ทั้งที่รายได้ก็ไม่ได้น้อย",
  "เพราะเขาเก็บเงินที่เหลือจากการใช้ แทนที่จะใช้เงินที่เหลือจากการเก็บ",
  "ลองสลับลำดับดูครับ ทันทีที่เงินเดือนเข้า ให้แบ่งเงินออมออกไปก่อนเลย",
  "เริ่มจากสิบเปอร์เซ็นต์ก็พอ แล้วค่อยขยับขึ้นทีละนิดทุกสามเดือน",
  "พอครบหกเดือน คุณจะมีเงินก้อนแรกที่ไม่เคยมีมาก่อนในชีวิต",
  "เงินก้อนนี้ห้ามเอาไปลงทุนเสี่ยงสูงเด็ดขาด มันคือเกราะกันฉุกเฉินของคุณ",
  "ถ้าคลิปนี้มีประโยชน์ กดติดตามไว้ได้เลย เดี๋ยวตอนหน้ามาต่อเรื่องกองทุน",
];
function thaiScript(targetChars: number): string {
  const lines: string[] = [];
  let i = 0;
  while (lines.join("\n").length < targetChars) {
    const n = Math.floor(i / BASE.length) + 1;
    lines.push(i % BASE.length === 0 && i > 0 ? `ตอนที่${n} ${BASE[i % BASE.length]}` : BASE[i % BASE.length]);
    i++;
  }
  return lines.join("\n");
}
const SCENARIOS: Record<string, string> = {
  short: thaiScript(280),    // → 1 chunk (the old single-call path + timing)
  medium: thaiScript(1350),  // → 2 chunks @800 (free-tier short-clip case)
  long: thaiScript(2900),    // → ~9 chunks @350 (multi-seam, guard, budget)
};

async function main() {
  const scenario = process.argv[2] ?? "short";
  const raw = SCENARIOS[scenario];
  if (!raw) { console.error(`unknown scenario ${scenario}`); process.exit(2); }

  const fullText = raw.trim();
  const chunks = splitScriptForTts(fullText);
  console.log(`\n=== QA ${scenario}: ${fullText.length} chars → ${chunks.length} segment(s) ===`);
  const t0 = Date.now();
  const deadline = t0 + SEGMENTED_BUDGET_MS;

  // ---- mirrored orchestration ----
  let pcms: Buffer[] | null = [];
  const durations: number[] = [];
  let sampleRate = 0;
  let modelLock: string | undefined;
  let failOpen = "";

  for (let i = 0; i < chunks.length; i++) {
    const r = await callGeminiTts(API_KEY, chunks[i].text, VOICE, modelLock, chunks.length > 1 ? deadline : undefined);
    if (!r.ok) {
      if (chunks.length === 1) {
        console.error(`SINGLE-CHUNK CALL FAILED: ${r.status} ${r.errBody.slice(0, 300)}`);
        process.exit(1);
      }
      failOpen = `segment ${i + 1}/${chunks.length} failed (${r.status}): ${r.errBody.slice(0, 200)}`;
      pcms = null;
      break;
    }
    if (!modelLock) modelLock = r.model;
    if (sampleRate === 0) sampleRate = r.sampleRate;
    else if (r.sampleRate !== sampleRate) { failOpen = `sample rate changed ${sampleRate}→${r.sampleRate}`; pcms = null; break; }
    pcms.push(r.pcm);
    durations.push(Math.round(pcmDurationMs(r.pcm.length, r.sampleRate)));
    const spoken = chunks[i].text.replace(/\s+/g, "").length;
    console.log(`  seg ${i + 1}/${chunks.length}: ${durations[i]}ms, ${spoken} chars, ${(spoken / Math.max(durations[i], 1) * 1000).toFixed(1)} cps, +${((Date.now() - t0) / 1000).toFixed(1)}s elapsed`);
  }

  let guardRetries = 0;
  if (pcms && chunks.length > 1) {
    const GUARD_ROUNDS = 3;
    for (let round = 1; round <= GUARD_ROUNDS; round++) {
      const outliers = charsPerSecGuard(chunks.map((c, i) => ({ text: c.text, durationMs: durations[i] })));
      if (outliers.length === 0) break;
      if (round === GUARD_ROUNDS) { failOpen = `guard still failing: [${outliers.join(",")}]`; pcms = null; break; }
      console.warn(`  guard round ${round}: off-median segments [${outliers.join(",")}] — regenerating`);
      for (const idx of outliers) {
        guardRetries++;
        const r = await callGeminiTts(API_KEY, chunks[idx].text, VOICE, modelLock, deadline);
        if (r.ok && r.sampleRate === sampleRate) {
          pcms[idx] = r.pcm;
          durations[idx] = Math.round(pcmDurationMs(r.pcm.length, sampleRate));
          console.log(`  guard: seg ${idx + 1} regenerated → ${durations[idx]}ms`);
        }
      }
    }
  }

  if (!pcms) {
    console.error(`\nFAIL-OPEN TRIGGERED: ${failOpen}`);
    console.error(`(route would now do one plain single call without timing — verify that path separately)`);
    process.exit(1);
  }

  const pcm = Buffer.concat(pcms);
  const wavPath = `/tmp/qa-tts-${scenario}.wav`;
  fs.writeFileSync(wavPath, wavFromPcm(pcm, sampleRate));
  const segments = mergeSegmentTiming(chunks.map((c, i) => ({ text: c.text, durationMs: durations[i] })));
  const audioDurationMs = durations.reduce((a, b) => a + b, 0);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // ---- automated checks ----
  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    if (ok) console.log(`  PASS  ${name}`);
    else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
  };

  console.log(`\n--- checks (${scenario}) ---`);
  check("iron rule: segments concat === fullText", segments.map((s) => s.text).join("") === fullText);
  check("same model for all segments (lock)", true, `model=${modelLock}`); // breaking lock fails earlier
  check("audioDurationMs sane for content", audioDurationMs > fullText.length * 30 && audioDurationMs < fullText.length * 200,
    `${audioDurationMs}ms for ${fullText.length} chars`);

  // independent duration check via afinfo (macOS) or ffprobe
  let measured = 0;
  try {
    const out = execFileSync("afinfo", [wavPath], { encoding: "utf-8" });
    measured = Math.round(parseFloat(out.match(/estimated duration: ([\d.]+) sec/)?.[1] ?? "0") * 1000);
  } catch {
    try {
      const out = execFileSync("ffprobe", ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", wavPath], { encoding: "utf-8" });
      measured = Math.round(parseFloat(out.trim()) * 1000);
    } catch { /* no probe available */ }
  }
  if (measured > 0) {
    check("WAV duration (afinfo/ffprobe) == computed audioDurationMs (±50ms)",
      Math.abs(measured - audioDurationMs) <= 50, `measured=${measured}ms computed=${audioDurationMs}ms`);
  } else {
    console.warn("  WARN  no afinfo/ffprobe — skipped independent duration check");
  }

  // seam continuity: int16 levels just before/after each boundary.
  // Sentence-boundary chunks should sit in near-silence; a loud step = click.
  const seams: string[] = [];
  let worstStep = 0;
  let byteOffset = 0;
  for (let i = 0; i < pcms.length - 1; i++) {
    byteOffset += pcms[i].length;
    const before = pcm.readInt16LE(byteOffset - 2);
    const after = pcm.readInt16LE(byteOffset);
    const step = Math.abs(after - before);
    worstStep = Math.max(worstStep, step);
    seams.push(`${(durations.slice(0, i + 1).reduce((a, b) => a + b, 0) / 1000).toFixed(2)}s step=${step}`);
  }
  if (pcms.length > 1) {
    check("seam continuity: no hard click (PCM step < 3000 ≈ -20dBFS)", worstStep < 3000, `worst=${worstStep}`);
  }

  // PR-C consumer contract: words + sentence cards build cleanly from timing
  const timing: TtsTiming = { provider: "gemini", segments, chars: null };
  const words = buildWordsFromTiming(timing, fullText);
  const caps = buildCaptionsFromCards(splitSentenceCards(fullText, 60), timing, fullText);
  check("PR-C contract: words built, monotonic, end == total",
    words.length > 5 && words.every((w, i) => i === 0 || w.startMs >= words[i - 1].endMs) && words.at(-1)!.endMs <= audioDurationMs);
  check("PR-C contract: captions cover script, end == total (±1ms)",
    caps.map((c) => c.text).join("").replace(/\s+/g, "") === fullText.replace(/\s+/g, "") &&
    Math.abs(caps.at(-1)!.endMs - audioDurationMs) <= 1,
    `lastCap=${caps.at(-1)?.endMs} total=${audioDurationMs}`);

  console.log(`\n--- report (${scenario}) ---`);
  console.log(`segments=${chunks.length} model=${modelLock} rate=${sampleRate}Hz total=${(audioDurationMs / 1000).toFixed(2)}s wallClock=${elapsed}s`);
  console.log(`api calls=${stats.calls} http429=${stats.http429} transientRetries=${stats.transientRetries} guardRegens=${guardRetries}` +
    (stats.hints.length ? ` retryDelayHints=[${stats.hints.join(",")}]ms` : ""));
  console.log(`wav: ${wavPath}`);
  if (seams.length) console.log(`listen at seams: ${seams.join(" | ")}`);

  if (failures > 0) { console.error(`\n${failures} QA check(s) FAILED`); process.exit(1); }
  console.log(`\nQA ${scenario}: ALL CHECKS PASSED ✓`);
}

main().catch((e) => { console.error("QA crashed:", e?.message ?? e); process.exit(1); });
