// Verify: preview-voice fixes (styled calls pinned to 2.5-flash + tail fade).
// Run: GEMINI_TEST_KEY=<key> npx tsx scripts/verify-preview-voice-fix.ts
// Never prints the key. Live cost: 3 short calls, a few cents at most.
//
// Background (measured 2026-09-26): the English style prefix is read aloud on
// 3.x TTS (+2.7s on 3.8) and no TTS model accepts systemInstruction (3.x: 400,
// 2.5: 500) — so styled calls pin modelLock to gemini-2.5-flash-preview-tts,
// the one model that honors the prefix as direction (measured +0.96s: slower
// serious delivery, listening-confirmed, no English spoken).
//
// What it proves:
//  A) neutral Thai preview on the 3.8-first chain (baseline)
//  B) prefix sent to 3.8 speaks notably longer — the bug, reproduced
//  C) prefix pinned to 2.5 matches the neutral ballpark — fixed, no English
//  D) raw PCM ends hot (the end-pop); withTailFade ends at exactly 0 with
//     identical byte length (subtitle timing untouched)
// Wavs land in os.tmpdir() for listening before/after.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { callGeminiTts, GEMINI_TTS_38_MODEL } from "../src/lib/gemini-tts-provider.server";
import { pcmDurationMs } from "../src/lib/tts-timing";
import { resolveGeminiVoiceStyle, applyVoiceStyle } from "../src/lib/gemini-voice-styles";
import { withTailFade, TTS_TAIL_FADE_MS } from "../src/lib/pcm-tail-fade";
import { getVoicePreviewCachePath, VOICE_PREVIEW_TEXT } from "../src/lib/voice-preview-cache";

const STYLE_MODEL_LOCK = "gemini-2.5-flash-preview-tts";
const VOICE = "Puck"; // matches the reported case (male voice + serious style)
const STYLE = "serious";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

function tailStats(pcm: Buffer, sampleRate: number, windowMs = 100) {
  const total = Math.floor(pcm.length / 2);
  const w = Math.min(total, Math.round((sampleRate * windowMs) / 1000));
  let maxAbs = 0;
  for (let i = total - w; i < total; i++) maxAbs = Math.max(maxAbs, Math.abs(pcm.readInt16LE(i * 2)));
  return { maxAbs, last: total > 0 ? pcm.readInt16LE((total - 1) * 2) : 0, total };
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
  check("serious resolves with direction", resolveGeminiVoiceStyle(STYLE).direction.length > 10);
  check("neutral applies nothing", applyVoiceStyle("สวัสดี", "neutral") === "สวัสดี");
  check("unknown style applies nothing", resolveGeminiVoiceStyle("nope").id === "neutral");

  // Tail fade unit checks.
  const hot = Buffer.alloc(4800);
  for (let i = 0; i < 2400; i++) hot.writeInt16LE(30000, i * 2); // full-scale ends hot
  const faded = withTailFade(hot, 24000);
  check("fade preserves byte length", faded.length === hot.length);
  check("fade ends at exactly zero", faded.readInt16LE(faded.length - 2) === 0);
  check("fade leaves input unmutated", hot.readInt16LE(hot.length - 2) === 30000);
  const midIdx = 2400 - Math.round((24000 * TTS_TAIL_FADE_MS) / 1000 / 2);
  const midVal = Math.abs(faded.readInt16LE(midIdx * 2));
  check("fade ramps mid-window down (~half)", midVal > 0 && midVal < 30000, `got ${midVal}`);
  check("empty buffer safe", withTailFade(Buffer.alloc(0), 24000).length === 0);
  check("short buffer (shorter than fade) ends at zero", withTailFade(Buffer.from([1, 2, 3, 4]), 24000).readInt16LE(2) === 0);

  // Cache-bust check: v2 key differs, repeated v2 identical, unversioned stable.
  const base = { provider: "gemini" as const, userId: "u1", voiceKey: `${VOICE}:${STYLE}`, text: VOICE_PREVIEW_TEXT, ext: "wav" as const };
  const pV1 = getVoicePreviewCachePath(base).filePath;
  const pV2a = getVoicePreviewCachePath({ ...base, cacheVersion: "v2" }).filePath;
  const pV2b = getVoicePreviewCachePath({ ...base, cacheVersion: "v2" }).filePath;
  check("v2 cache path differs from v1 (forces regen)", pV1 !== pV2a);
  check("v2 cache path stable", pV2a === pV2b);

  // ---- live checks (needs key) ----
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
  const dl = (ms: number) => Date.now() + ms;

  // A: neutral baseline on the 3.8-first chain (what prod serves today).
  const rA = await callGeminiTts(apiKey, VOICE_PREVIEW_TEXT, VOICE, undefined, dl(180_000), {}, GEMINI_TTS_38_MODEL);
  check("A: neutral returns audio", rA.ok === true);
  if (!rA.ok) {
    console.error(`        status=${rA.status} body=${rA.errBody.slice(0, 200)}`);
    process.exit(1);
  }
  const msA = pcmDurationMs(rA.pcm.length, rA.sampleRate);
  console.log(`        A neutral: model=${rA.model} rate=${rA.sampleRate} duration=${msA}ms`);
  check("A: duration sane for preview text (1s..30s)", msA > 1000 && msA < 30_000, `got ${msA}ms`);

  // B: prefix sent to 3.8 (the reported bug — direction read aloud).
  const styledText = applyVoiceStyle(VOICE_PREVIEW_TEXT, STYLE);
  const rB = await callGeminiTts(apiKey, styledText, VOICE, undefined, dl(180_000), {}, GEMINI_TTS_38_MODEL);
  check("B: prefixed 3.8 call returns audio", rB.ok === true);
  if (!rB.ok) {
    console.error(`        status=${rB.status} body=${rB.errBody.slice(0, 200)}`);
    process.exit(1);
  }
  const msB = pcmDurationMs(rB.pcm.length, rB.sampleRate);
  console.log(`        B prefix-on-3.8: duration=${msB}ms (extra vs neutral: ${msB - msA}ms = direction read aloud)`);
  check("B: prefixed audio notably longer than neutral (bug reproduced)", msB - msA > 1000, `extra=${msB - msA}ms`);

  // C: NEW — same prefix pinned to 2.5-flash (honored as direction, not spoken).
  const rC = await callGeminiTts(apiKey, styledText, VOICE, STYLE_MODEL_LOCK, dl(180_000));
  check("C: pinned styled call returns audio", rC.ok === true);
  if (!rC.ok) {
    console.error(`        status=${rC.status} body=${rC.errBody.slice(0, 200)}`);
    process.exit(1);
  }
  const msC = pcmDurationMs(rC.pcm.length, rC.sampleRate);
  console.log(`        C pinned-2.5: model=${rC.model} duration=${msC}ms (vs neutral ${msA}ms)`);
  check("C: styled model is the pinned 2.5 (no 3.x fallback)", rC.model === STYLE_MODEL_LOCK, `got ${rC.model}`);
  check("C: duration in neutral ballpark (no English read aloud)", msC - msA < 1500, `A=${msA}ms C=${msC}ms`);

  // D: tail stats before/after fade on the NEW audio.
  const pre = tailStats(rC.pcm, rC.sampleRate);
  const fadedC = withTailFade(rC.pcm, rC.sampleRate);
  const post = tailStats(fadedC, rC.sampleRate);
  console.log(`        D tail: pre maxAbs(last 100ms)=${pre.maxAbs} last=${pre.last} → post maxAbs=${post.maxAbs} last=${post.last}`);
  check("D: faded length identical (timing untouched)", fadedC.length === rC.pcm.length);
  check("D: faded tail ends at zero (no end-pop)", post.last === 0);

  const pA = join(tmpdir(), "preview-fix-A-neutral.wav");
  const pB = join(tmpdir(), "preview-fix-B-prefix-38.wav");
  const pC = join(tmpdir(), "preview-fix-C-pinned-25.wav");
  writeFileSync(pA, wavBuffer(rA.pcm, rA.sampleRate));
  writeFileSync(pB, wavBuffer(rB.pcm, rB.sampleRate));
  writeFileSync(pC, wavBuffer(fadedC, rC.sampleRate));
  console.log(`        saved:\n          ${pA}\n          ${pB}  <- old bug: English first + end pop\n          ${pC}  <- fixed bytes (prod-equivalent)`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed. Listen to B vs C before shipping.");
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
