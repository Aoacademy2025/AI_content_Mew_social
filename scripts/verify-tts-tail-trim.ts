// Verify: trimTrailingGlitch + finalizeTtsPcm (3.8 tail static fix).
// Run: GEMINI_TEST_KEY=<key> npx tsx scripts/verify-tts-tail-trim.ts
// Never prints the key. Live cost: 1 short call.
// Pure checks run without a key; live checks prove the real 3.8 glitch
// (quiet gap + full-scale static to edge) is removed while speech survives.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { callGeminiTts, GEMINI_TTS_38_MODEL } from "../src/lib/gemini-tts-provider.server";
import { pcmDurationMs } from "../src/lib/tts-timing";
import { trimTrailingGlitch, finalizeTtsPcm } from "../src/lib/pcm-tail-fade";
import { VOICE_PREVIEW_TEXT } from "../src/lib/voice-preview-cache";

const RATE = 24000;
const sec = (s: number) => Math.round(RATE * s);

function synth(frames: Array<[ms: number, peak: number]>): Buffer {
  const totalSec = frames.reduce((a, [ms]) => a + ms / 1000, 0);
  const buf = Buffer.alloc(Math.round(totalSec * RATE) * 2);
  let o = 0;
  for (const [ms, peak] of frames) {
    const n = Math.round((RATE * ms) / 1000);
    for (let k = 0; k < n && o < buf.length / 2; k++, o++) {
      buf.writeInt16LE(k % 2 === 0 ? peak : -peak, o * 2);
    }
  }
  return buf;
}

function wavBuffer(pcm: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

async function main() {
  // ---- 0) pure checks: synthetic glitch shaped like the measured 3.8 tail ----
  // speech(1s @15000) + gap(150ms @40) + blast(200ms @32000)
  const glitch = synth([[1000, 15000], [150, 40], [200, 32000]]);
  const trimmed = trimTrailingGlitch(glitch, RATE);
  const trimmedMs = (Math.floor(trimmed.length / 2) / RATE) * 1000;
  check("glitch trimmed (≈1.08s kept)", trimmedMs > 1000 && trimmedMs < 1150, `got ${trimmedMs.toFixed(0)}ms`);
  check("speech intact (0.5s sample untouched)", trimmed.readInt16LE(sec(0.5) * 2) === 15000);
  check("blast gone (no full-scale tail)", (() => {
    let m = 0;
    for (let i = 0; i < Math.floor(trimmed.length / 2); i++) m = Math.max(m, Math.abs(trimmed.readInt16LE(i * 2)));
    return m <= 15000;
  })());

  // Clean ending (speech to edge, no gap) → byte-identical, no cut.
  const clean = synth([[2000, 15000]]);
  check("clean ending untouched", trimTrailingGlitch(clean, RATE).equals(clean));

  // Loud ending WITHOUT a preceding gap → untouched (never nuke speech).
  const loudEnd = synth([[1000, 3000], [300, 25000]]);
  check("loud ending without gap untouched", trimTrailingGlitch(loudEnd, RATE).equals(loudEnd));

  // All silence → untouched. Empty → safe.
  const silence = synth([[500, 0]]);
  check("silence untouched", trimTrailingGlitch(silence, RATE).equals(silence));
  check("empty safe", trimTrailingGlitch(Buffer.alloc(0), RATE).length === 0);

  // finalize = trim + fade.
  const final = finalizeTtsPcm(glitch, RATE);
  check("finalize shorter than raw", final.length < glitch.length);
  check("finalize ends at zero", final.readInt16LE(final.length - 2) === 0);

  // ---- live check (needs key): real 3.8 neutral ----
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
  const r = await callGeminiTts(apiKey, VOICE_PREVIEW_TEXT, "Puck", undefined, Date.now() + 180_000, {}, GEMINI_TTS_38_MODEL);
  check("live 3.8 returns audio", r.ok === true);
  if (!r.ok) {
    console.error(`        status=${r.status} body=${r.errBody.slice(0, 200)}`);
    process.exit(1);
  }
  const rawMs = pcmDurationMs(r.pcm.length, r.sampleRate);
  const fixed = finalizeTtsPcm(r.pcm, r.sampleRate);
  const fixedMs = pcmDurationMs(fixed.length, r.sampleRate);
  const removed = rawMs - fixedMs;
  console.log(`        raw=${rawMs}ms fixed=${fixedMs}ms removed=${removed}ms lastRaw=${r.pcm.readInt16LE(r.pcm.length - 2)} lastFixed=${fixed.readInt16LE(fixed.length - 2)}`);
  check("glitch removed (100-600ms cut)", removed > 100 && removed < 600, `removed=${removed}ms`);
  check("speech preserved (>=80% kept)", fixedMs / rawMs >= 0.8, `${fixedMs}/${rawMs}ms`);
  check("fixed ends at zero", fixed.readInt16LE(fixed.length - 2) === 0);

  const pRaw = join(tmpdir(), "trim-raw-38.wav");
  const pFixed = join(tmpdir(), "trim-fixed-38.wav");
  writeFileSync(pRaw, wavBuffer(r.pcm, r.sampleRate));
  writeFileSync(pFixed, wavBuffer(fixed, r.sampleRate));
  console.log(`        saved:\n          ${pRaw}  <- glitchy\n          ${pFixed}  <- fixed (prod-equivalent)`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed. Listen to raw vs fixed before shipping.");
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
