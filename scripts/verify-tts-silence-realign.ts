// Verify silence-anchored realignment of the Gemini char clock (tts-timing.ts).
// Root cause it guards: Gemini has only per-CHUNK exact duration (800 chars ≈
// 50-60s), so within a chunk time was spread char-proportionally — a real
// breath/sentence pause mid-chunk therefore shifts every following subtitle
// early/late until the chunk end re-anchors it ("เพี้ยนกลางคลิป กลับมาตรงตอนจบ").
// The fix re-anchors the clock at the REAL pauses ffmpeg silencedetect already
// found (timing.silenceIntervals): text speech-mass runs are matched to audio
// speech-run durations globally (monotonic DP), so both the caption track AND
// the word timeline land on speech onsets. MUST be byte-identical legacy when
// there are no usable silences, when TTS_SILENCE_REALIGN=0, on any degenerate
// input (fail-open), and on the ElevenLabs path (real char timing).
// Run: npx tsx scripts/verify-tts-silence-realign.ts
import {
  buildWordsFromTiming,
  buildCaptionsFromCards,
  type TtsTiming,
  type TimedWord,
  type SilenceInterval,
} from "../src/lib/tts-timing";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}
function fmt(words: TimedWord[]) {
  return words.map((w) => `${w.word}@${Math.round(w.startMs)}-${Math.round(w.endMs)}`).join(" ");
}
function gemini(text: string, durationMs: number, silenceIntervals?: SilenceInterval[]): TtsTiming {
  return {
    provider: "gemini",
    segments: [{ text, startMs: 0, durationMs }],
    chars: null,
    ...(silenceIntervals ? { silenceIntervals, silences: silenceIntervals.map((s) => Math.round((s.startMs + s.endMs) / 2)) } : {}),
  };
}
function withEnv<T>(realign: string | undefined, fn: () => T): T {
  const prev = process.env.TTS_SILENCE_REALIGN;
  if (realign === undefined) delete process.env.TTS_SILENCE_REALIGN;
  else process.env.TTS_SILENCE_REALIGN = realign;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.TTS_SILENCE_REALIGN;
    else process.env.TTS_SILENCE_REALIGN = prev;
  }
}
const startOf = (words: TimedWord[], w: string) => words.find((x) => x.word === w)?.startMs ?? NaN;

// A) Mid-chunk 2s breath pause at a steady speech rate: legacy drifts ~0.8s,
// realigned lands on speech onset.
// Truth: "หนึ่ง สอง สาม" (11 chars) spoken 0-3000ms (~3.7cps), pause 3000-5000ms,
// "สี่ ห้า หก" (8 chars) 5000-7200ms (~3.6cps).
{
  const text = "หนึ่ง สอง สาม สี่ ห้า หก";
  const sil = [{ startMs: 3000, endMs: 5000 }];
  const legacy = withEnv("0", () => buildWordsFromTiming(gemini(text, 7200, sil), text));
  const realigned = withEnv(undefined, () => buildWordsFromTiming(gemini(text, 7200, sil), text));
  const legacyErr = Math.abs(startOf(legacy, "สี่") - 5000);
  check("A1: legacy clock really drifts at the pause (test is meaningful)", legacyErr > 500,
    `legacy start("สี่")=${Math.round(startOf(legacy, "สี่"))}ms truth=5000ms err=${Math.round(legacyErr)}ms`);
  check("A2: realigned start of post-pause word ≈ speech onset (5000ms)", Math.abs(startOf(realigned, "สี่") - 5000) <= 100,
    `start("สี่")=${Math.round(startOf(realigned, "สี่"))}ms\n        words: ${fmt(realigned)}`);
  const lastPre = realigned.find((w) => w.word === "สาม");
  check("A3: pre-pause word ends by the pause start (+60ms)", !!lastPre && lastPre.endMs <= 3060,
    `end("สาม")=${lastPre ? Math.round(lastPre.endMs) : "?"}ms (pause starts 3000)`);
  const last = realigned[realigned.length - 1];
  check("A4: end stays anchored to chunk duration", Math.abs(last.endMs - 7200) < 60, `lastEnd=${Math.round(last.endMs)}`);
  const monotonic = realigned.every((w, i) => i === 0 || w.startMs >= realigned[i - 1].startMs);
  check("A5: word timeline stays monotonic", monotonic, fmt(realigned));
}

// B) Two pauses, three runs — anchors land on both onsets; bare (no-space)
// boundary pause also anchors.
{
  const text = "หนึ่งสองสาม สี่ห้าหกเจ็ด แปดเก้าสิบ";
  const sil = [{ startMs: 2000, endMs: 2600 }, { startMs: 4600, endMs: 5200 }];
  const w = withEnv(undefined, () => buildWordsFromTiming(gemini(text, 7000, sil), text));
  check("B1: run-2 first word starts ≈ pause-1 end", Math.abs(startOf(w, "สี่") - 2600) <= 120,
    `start("สี่")=${Math.round(startOf(w, "สี่"))}ms truth=2600ms\n        ${fmt(w)}`);
  check("B2: run-3 first word starts ≈ pause-2 end", Math.abs(startOf(w, "แปด") - 5200) <= 120,
    `start("แปด")=${Math.round(startOf(w, "แปด"))}ms truth=5200ms\n        ${fmt(w)}`);

  // pause at a boundary with NO space: "หนึ่งสอง | สามสี่ห้า"
  const t2 = "หนึ่งสองสามสี่ห้า";
  const sil2 = [{ startMs: 1400, endMs: 2000 }];
  const w2 = withEnv(undefined, () => buildWordsFromTiming(gemini(t2, 5000, sil2), t2));
  const post = w2.find((x) => x.startMs >= 1900);
  check("B3: bare word-boundary pause still anchors (some word starts ≈ 2000ms)",
    !!post && Math.abs(post.startMs - 2000) <= 120,
    `words: ${fmt(w2)}`);
}

// C) No silences at all → byte-identical legacy (regression guard)
{
  const text = "หนึ่ง สอง สาม สี่ ห้า";
  const off = withEnv("0", () => buildWordsFromTiming(gemini(text, 5000), text));
  const on = withEnv(undefined, () => buildWordsFromTiming(gemini(text, 5000), text));
  check("C: no-silence timing is byte-identical (realign on vs off)", JSON.stringify(off) === JSON.stringify(on),
    `off=${fmt(off)}\n        on=${fmt(on)}`);
}

// D) TTS_SILENCE_REALIGN=0 disables the feature entirely (instant rollback parity)
{
  const text = "หนึ่ง สอง สาม สี่ ห้า หก";
  const sil = [{ startMs: 3000, endMs: 5000 }];
  const a = withEnv("0", () => buildWordsFromTiming(gemini(text, 7200, sil), text));
  const b = withEnv("0", () => buildWordsFromTiming(gemini(text, 7200, sil), text));
  const legacyNoSil = withEnv("0", () => buildWordsFromTiming(gemini(text, 7200), text));
  check("D: rollback knob = deterministic legacy behavior", JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(a) === JSON.stringify(legacyNoSil));
}

// E) Degenerate silences (more pauses than the text can host) → fail-open to legacy
{
  const text = "หนึ่ง สอง";
  const sil = Array.from({ length: 8 }, (_, i) => ({ startMs: 200 + i * 300, endMs: 350 + i * 300 }));
  const legacy = withEnv("0", () => buildWordsFromTiming(gemini(text, 3000, sil), text));
  const realigned = withEnv(undefined, () => buildWordsFromTiming(gemini(text, 3000, sil), text));
  check("E: nonsense silences fail-open to exact legacy", JSON.stringify(legacy) === JSON.stringify(realigned),
    `legacy=${fmt(legacy)}\n        realigned=${fmt(realigned)}`);
}

// F) ElevenLabs path (real char timing) must ignore silenceIntervals completely
{
  const t = "ab cd";
  const chars = { characters: [...t], startSec: [0, 0.4, 0.8, 0.8, 1.2], endSec: [0.4, 0.8, 0.8, 1.2, 1.6] };
  const el = (sil?: SilenceInterval[]): TtsTiming => ({
    provider: "elevenlabs",
    segments: [{ text: t, startMs: 0, durationMs: 1600 }],
    chars,
    ...(sil ? { silenceIntervals: sil } : {}),
  });
  const off = withEnv(undefined, () => buildWordsFromTiming(el(), t));
  const on = withEnv(undefined, () => buildWordsFromTiming(el([{ startMs: 700, endMs: 900 }]), t));
  check("F: ElevenLabs timing untouched by silence intervals", JSON.stringify(off) === JSON.stringify(on));
}

// G) Two segments: silence inside segment 2 realigns seg-2 only; seg-1 output
// identical to legacy; segment boundary stays exact.
{
  const segA = "หนึ่ง สอง สาม ";
  const segB = "สี่ ห้า หก เจ็ด";
  const text = segA + segB;
  const timing = (sil?: SilenceInterval[]): TtsTiming => ({
    provider: "gemini",
    segments: [
      { text: segA, startMs: 0, durationMs: 4000 },
      { text: segB, startMs: 4000, durationMs: 6000 },
    ],
    chars: null,
    ...(sil ? { silenceIntervals: sil } : {}),
  });
  // truth in seg B: "สี่" 4000-5000, pause 5000-6200, "ห้า หก เจ็ด" 6200-10000
  const sil = [{ startMs: 5000, endMs: 6200 }];
  const legacy = withEnv("0", () => buildWordsFromTiming(timing(sil), text));
  const w = withEnv(undefined, () => buildWordsFromTiming(timing(sil), text));
  const segAWords = (ws: TimedWord[]) => ws.filter((x) => x.startChar < segA.length);
  check("G1: segment without silences is byte-identical legacy",
    JSON.stringify(segAWords(legacy)) === JSON.stringify(segAWords(w)),
    `legacy=${fmt(segAWords(legacy))}\n        realigned=${fmt(segAWords(w))}`);
  check("G2: seg-2 post-pause word starts ≈ pause end (6200ms)", Math.abs(startOf(w, "ห้า") - 6200) <= 120,
    `start("ห้า")=${Math.round(startOf(w, "ห้า"))}ms\n        ${fmt(w)}`);
  check("G3: seg-2 first word still starts at the segment seam (4000ms)", Math.abs(startOf(w, "สี่") - 4000) <= 60,
    `start("สี่")=${Math.round(startOf(w, "สี่"))}ms`);
}

// H) Leading silence (TTS breathes in before speaking): first word starts at
// speech onset, not t=0.
{
  const text = "หนึ่ง สอง สาม";
  const sil = [{ startMs: 0, endMs: 600 }];
  const w = withEnv(undefined, () => buildWordsFromTiming(gemini(text, 3600, sil), text));
  check("H: leading silence pushes first word to speech onset (≈600ms)", Math.abs(w[0].startMs - 600) <= 80,
    `start=${Math.round(w[0].startMs)}ms\n        ${fmt(w)}`);
}

// I) Caption cards get the same anchoring: a card starting after the pause
// begins exactly at speech onset (so the downstream snap becomes a no-op).
{
  const text = "หนึ่ง สอง สาม สี่ ห้า หก";
  const sil = [{ startMs: 3000, endMs: 5000 }];
  const iSii = text.indexOf("สี่");
  const cards = [
    { startChar: 0, endChar: iSii },
    { startChar: iSii, endChar: text.length },
  ];
  const caps = withEnv(undefined, () => buildCaptionsFromCards(cards, gemini(text, 7200, sil), text));
  check("I1: post-pause card starts ≈ speech onset", caps.length === 2 && Math.abs(caps[1].startMs - 5000) <= 100,
    caps.map((c) => `"${c.text}"@${Math.round(c.startMs)}-${Math.round(c.endMs)}`).join(" "));
  check("I2: captions monotonic + end anchored", caps.length === 2 && caps[0].endMs <= caps[1].startMs && Math.abs(caps[1].endMs - 7200) < 60);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
