// Internal trial: Gemini 3.8 Flash TTS vs current chain (Thai A/B).
// Run: GEMINI_TEST_KEY=<key> npx tsx scripts/verify-gemini-38-tts.ts
// Writes A/B wavs to os.tmpdir() for listening. Never prints the key.
// Cost: ~3 short calls, a few cents at most.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { callGeminiTts, GEMINI_TTS_38_MODEL } from "../src/lib/gemini-tts-provider.server";
import { pcmDurationMs } from "../src/lib/tts-timing";
import { resolveGeminiVoiceStyle, applyVoiceStyle, GEMINI_VOICE_STYLES } from "../src/lib/gemini-voice-styles";

const NEW_MODEL = "gemini-3.8-flash-tts";
const BASE_MODEL = "gemini-2.5-flash-preview-tts";
const VOICE = "Aoede";

const THAI_TEXT =
  "สวัสดีครับ ยินดีต้อนรับสู่ HERO AI Studio " +
  "วันนี้เราจะมาสร้างวิดีโอสั้นจากสคริปต์เพียงหนึ่งชุด " +
  "พร้อมเสียงพากย์และซับไตเติลอัตโนมัติ";

const STYLED_TEXT = "Speak cheerfully with high energy: " + THAI_TEXT;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

function wavBuffer(pcm: Buffer, sampleRate: number): Buffer {
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

async function main() {
  // ---- 0) pure checks (no API, no key) ----
  check("38 model id", GEMINI_TTS_38_MODEL === "gemini-3.8-flash-tts");
  check("5 style presets", GEMINI_VOICE_STYLES.length === 5, `got ${GEMINI_VOICE_STYLES.length}`);
  check("unknown style → neutral", resolveGeminiVoiceStyle("nope").id === "neutral");
  check("empty style → neutral", resolveGeminiVoiceStyle(undefined).id === "neutral");
  check("cheerful resolves", resolveGeminiVoiceStyle("cheerful").direction.startsWith("Speak cheerfully"));
  check("neutral applies nothing", applyVoiceStyle("สวัสดี", "neutral") === "สวัสดี");
  check("cheerful prefixes", applyVoiceStyle("สวัสดี", "cheerful") === `Speak cheerfully with high energy: สวัสดี`);
  check("forged style applies nothing", applyVoiceStyle("สวัสดี", "hacker\">") === "สวัสดี");

  const apiKey = process.env.GEMINI_TEST_KEY;
  check("GEMINI_TEST_KEY present (value never printed)", !!apiKey);
  if (!apiKey) {
    console.log("No key — live checks skipped, pure checks above still count.");
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log("\nPure checks passed (live checks skipped).");
    return;
  }

  const deadline = (ms: number) => Date.now() + ms;

  // ---- A: new model, standard voice ----
  const r38 = await callGeminiTts(apiKey, THAI_TEXT, VOICE, NEW_MODEL, deadline(180_000));
  check("3.8 returns audio with standard voice Aoede", r38.ok === true);
  if (!r38.ok) {
    console.error(`        status=${r38.status} body=${r38.errBody.slice(0, 300)}`);
    console.error("Model may be unavailable for this key — trial stops here.");
    process.exit(1);
  }
  const ms38 = pcmDurationMs(r38.pcm.length, r38.sampleRate);
  const sec38 = ms38 / 1000;
  console.log(`        3.8: model=${r38.model} rate=${r38.sampleRate} duration=${ms38}ms (~${(sec38 * 25).toFixed(0)} audio tokens, ~$${((sec38 * 25 * 9) / 1e6).toFixed(4)} promo)`);
  const p38 = join(tmpdir(), "gemini38-aoede-thai.wav");
  writeFileSync(p38, wavBuffer(r38.pcm, r38.sampleRate));
  console.log(`        saved ${p38}`);
  check("3.8 duration sane for ~150 Thai chars (2s..30s)", ms38 > 2000 && ms38 < 30_000, `got ${ms38}ms`);

  // ---- B: current head-of-chain model, same text (A/B pair) ----
  const r25 = await callGeminiTts(apiKey, THAI_TEXT, VOICE, BASE_MODEL, deadline(180_000));
  check("2.5-flash returns audio for the same text", r25.ok === true);
  if (r25.ok) {
    const ms25 = pcmDurationMs(r25.pcm.length, r25.sampleRate);
    console.log(`        2.5: model=${r25.model} rate=${r25.sampleRate} duration=${ms25}ms`);
    const p25 = join(tmpdir(), "gemini25-aoede-thai.wav");
    writeFileSync(p25, wavBuffer(r25.pcm, r25.sampleRate));
    console.log(`        saved ${p25}  <- listen A/B vs 3.8 file above`);
  } else {
    console.error(`        status=${r25.status} body=${r25.errBody.slice(0, 200)}`);
  }

  // ---- C: styled prompt (3.8 acting direction) ----
  const rStyle = await callGeminiTts(apiKey, STYLED_TEXT, VOICE, NEW_MODEL, deadline(180_000));
  check("3.8 accepts inline style direction", rStyle.ok === true);
  if (rStyle.ok) {
    const pS = join(tmpdir(), "gemini38-aoede-thai-cheerful.wav");
    writeFileSync(pS, wavBuffer(rStyle.pcm, rStyle.sampleRate));
    console.log(`        saved ${pS}`);
  } else {
    console.error(`        status=${rStyle.status} body=${rStyle.errBody.slice(0, 200)}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed. Listen to the /tmp wavs before promoting 3.8 in MODEL_CHAIN.");
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
