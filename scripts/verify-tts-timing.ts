// Verify src/lib/tts-timing.ts — pure logic, real Thai cases.
// Run: npx tsx scripts/verify-tts-timing.ts

import {
  splitScriptForTts,
  chooseChunkChars,
  mergeSegmentTiming,
  mergeCharAlignments,
  charsPerSecGuard,
  buildWordsFromTiming,
  buildCaptionsFromCards,
  splitSentenceCards,
  pcmDurationMs,
  TtsTimingMismatchError,
  SHORT_SCRIPT_CHARS,
  CHUNK_CHARS_SHORT_SCRIPT,
  CHUNK_CHARS_LONG_SCRIPT,
  type TtsTiming,
} from "../src/lib/tts-timing";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures — realistic Thai script (newlines between sentences, no spaces
// inside Thai phrases, mixed punctuation)
// ---------------------------------------------------------------------------

const SCRIPT = [
  "รู้มั้ยว่าทำไมคนส่วนใหญ่ถึงเก็บเงินไม่อยู่",
  "เพราะเขาเก็บเงินที่เหลือจากการใช้ แทนที่จะใช้เงินที่เหลือจากการเก็บ",
  "ลองสลับลำดับดู แค่เปลี่ยนนิดเดียวชีวิตเปลี่ยนเลย",
  "เริ่มจากแบ่งเงินเดือนทันทีที่เงินเข้า ออมก่อนใช้เสมอ",
  "ถ้าคลิปนี้มีประโยชน์ กดติดตามไว้ได้เลย",
].join("\n");

const LONG_SCRIPT = Array.from({ length: 12 }, (_, i) =>
  `ประโยคที่${i + 1} ว่าด้วยเรื่องการลงทุนระยะยาวและการกระจายความเสี่ยงในพอร์ตการเงินส่วนบุคคล`
).join("\n"); // > SHORT_SCRIPT_CHARS → standard chunks

// ---------------------------------------------------------------------------
// 1) splitScriptForTts — iron rule: concat === fullText
// ---------------------------------------------------------------------------

for (const [label, text, max] of [
  ["short thai", SCRIPT, 120],
  ["long thai", LONG_SCRIPT, 350],
  ["no whitespace at all", "ก".repeat(1000), 300],
  ["tiny", "สั้นมาก", 800],
] as const) {
  const chunks = splitScriptForTts(text, max);
  check(`split/${label}: concat === fullText`, chunks.map((c) => c.text).join("") === text);
  check(`split/${label}: every chunk ≤ max`, chunks.every((c) => c.text.length <= max),
    `sizes=${chunks.map((c) => c.text.length).join(",")}`);
  check(`split/${label}: contiguous ranges`, chunks.every((c, i) =>
    c.text === text.slice(c.startChar, c.endChar) && (i === 0 ? c.startChar === 0 : c.startChar === chunks[i - 1].endChar)));
  check(`split/${label}: no empty chunks`, chunks.every((c) => c.text.length > 0));
}

{
  const chunks = splitScriptForTts(SCRIPT, 120);
  check("split: prefers newline boundaries", chunks.slice(0, -1).every((c) => /\s$/.test(c.text)),
    chunks.map((c) => JSON.stringify(c.text.slice(-8))).join(" | "));
}

// adaptive dial
check("chooseChunkChars: short script → big chunks", chooseChunkChars(900) === CHUNK_CHARS_SHORT_SCRIPT);
check("chooseChunkChars: boundary inclusive", chooseChunkChars(SHORT_SCRIPT_CHARS) === CHUNK_CHARS_SHORT_SCRIPT);
check("chooseChunkChars: long script → standard chunks", chooseChunkChars(5000) === CHUNK_CHARS_LONG_SCRIPT);

// ---------------------------------------------------------------------------
// 2) mergeSegmentTiming + pcmDurationMs
// ---------------------------------------------------------------------------

{
  const segs = mergeSegmentTiming([
    { text: "หนึ่ง", durationMs: 1200 },
    { text: "สอง", durationMs: 800 },
    { text: "สาม", durationMs: 1500 },
  ]);
  check("mergeSegmentTiming: cumulative offsets",
    segs[0].startMs === 0 && segs[1].startMs === 1200 && segs[2].startMs === 2000);
}

check("pcmDurationMs: 24kHz mono s16le, 48000 bytes = 1000ms", pcmDurationMs(48000, 24000) === 1000);
check("pcmDurationMs: half second", pcmDurationMs(24000, 24000) === 500);
check("pcmDurationMs: invalid rate → 0", pcmDurationMs(48000, 0) === 0);

// ---------------------------------------------------------------------------
// 3) charsPerSecGuard
// ---------------------------------------------------------------------------

{
  // 4 normal segments (~15 chars/s) + 1 truncated (audio far too short for its text)
  const segs = [
    { text: "ก".repeat(150), durationMs: 10_000 },
    { text: "ข".repeat(160), durationMs: 10_500 },
    { text: "ค".repeat(140), durationMs: 9_800 },
    { text: "ง".repeat(155), durationMs: 10_200 },
    { text: "จ".repeat(150), durationMs: 3_000 }, // 50 chars/s — API returned truncated audio
  ];
  check("guard: flags only the desynced segment", JSON.stringify(charsPerSecGuard(segs)) === "[4]",
    `got ${JSON.stringify(charsPerSecGuard(segs))}`);
  check("guard: all-normal → none", charsPerSecGuard(segs.slice(0, 4)).length === 0);
  check("guard: single segment → none", charsPerSecGuard([segs[0]]).length === 0);
  check("guard: whitespace not counted as spoken",
    charsPerSecGuard([
      { text: "ก".repeat(100) + " ".repeat(500), durationMs: 6_700 },
      { text: "ข".repeat(100), durationMs: 6_600 },
    ]).length === 0);
}

// ---------------------------------------------------------------------------
// 4) Gemini path: buildWordsFromTiming + buildCaptionsFromCards
// ---------------------------------------------------------------------------

function geminiTimingFor(fullText: string, maxChars: number, msPerSpokenChar = 70): TtsTiming {
  const parts = splitScriptForTts(fullText, maxChars).map((c) => ({
    text: c.text,
    durationMs: c.text.replace(/\s+/g, "").length * msPerSpokenChar,
  }));
  return { provider: "gemini", segments: mergeSegmentTiming(parts), chars: null };
}

{
  const timing = geminiTimingFor(SCRIPT, 120);
  const totalMs = timing.segments.at(-1)!.startMs + timing.segments.at(-1)!.durationMs;
  const words = buildWordsFromTiming(timing, SCRIPT);

  check("gemini words: produced", words.length > 10, `got ${words.length}`);
  check("gemini words: text comes from script verbatim",
    words.every((w) => SCRIPT.includes(w.word)));
  check("gemini words: spoken chars fully covered",
    words.map((w) => w.word).join("").replace(/\s+/g, "") === SCRIPT.replace(/\s+/g, ""));
  check("gemini words: monotonic non-overlapping",
    words.every((w, i) => w.endMs > w.startMs && (i === 0 || w.startMs >= words[i - 1].endMs)));
  check("gemini words: bounded by total duration",
    words[0].startMs >= 0 && words.at(-1)!.endMs <= totalMs);

  // Cards cut exactly at segment boundaries must inherit exact arithmetic offsets.
  const cards = timing.segments.map((s, i) => {
    const startChar = timing.segments.slice(0, i).reduce((sum, p) => sum + p.text.length, 0);
    return { startChar, endChar: startChar + s.text.length };
  });
  const caps = buildCaptionsFromCards(cards, timing, SCRIPT);
  check("gemini captions: one per segment card", caps.length === timing.segments.length);
  check("gemini captions: segment-boundary cards have EXACT segment times",
    caps.every((c, i) => Math.abs(c.startMs - timing.segments[i].startMs) <= 1),
    caps.map((c, i) => `${c.startMs}vs${timing.segments[i].startMs}`).join(","));
  check("gemini captions: text is trimmed slice", caps.every((c) => c.text === c.text.trim() && c.text.length > 0));
  check("gemini captions: default tags hook then body",
    caps[0].tag === "hook" && caps.slice(1).every((c) => c.tag === "body"));

  // splitSentenceCards drives the same path (PR-C phase 1)
  const sentCaps = buildCaptionsFromCards(splitSentenceCards(SCRIPT, 60), timing, SCRIPT);
  check("sentence cards: cover all spoken text",
    sentCaps.map((c) => c.text).join("").replace(/\s+/g, "") === SCRIPT.replace(/\s+/g, ""));
  check("sentence cards: monotonic", sentCaps.every((c, i) => i === 0 || c.startMs >= sentCaps[i - 1].endMs));
  check("sentence cards: ≤ 60 chars", sentCaps.every((c) => c.text.length <= 60));
}

// mismatch must throw (fail-open trigger), not silently mis-time
{
  const timing = geminiTimingFor(SCRIPT, 120);
  let threw = false;
  try { buildWordsFromTiming(timing, SCRIPT + "ส่วนเกิน"); } catch (e) { threw = e instanceof TtsTimingMismatchError; }
  check("gemini: fullText mismatch throws TtsTimingMismatchError", threw);
}

// ---------------------------------------------------------------------------
// 5) ElevenLabs path: char-level clock + alignment merge
// ---------------------------------------------------------------------------

{
  const text = "สวัสดีครับ ผมชื่อมิว วันนี้มาสอนออมเงิน";
  // Synthetic char alignment: 80ms per char, spaces included as 0-width-ish slots
  const characters = Array.from(text);
  const startSec = characters.map((_, i) => i * 0.08);
  const endSec = characters.map((_, i) => (i + 1) * 0.08);
  const timing: TtsTiming = {
    provider: "elevenlabs",
    segments: [{ text, startMs: 0, durationMs: Math.round(characters.length * 80) }],
    chars: { characters, startSec, endSec },
  };

  const words = buildWordsFromTiming(timing, text);
  check("el words: produced", words.length >= 5, `got ${words.length}`);
  const first = words[0];
  check("el words: char-exact start/end",
    first.startMs === Math.round(startSec[text.indexOf(first.word)] * 1000) &&
    first.endMs === Math.round(endSec[text.indexOf(first.word) + first.word.length - 1] * 1000),
    JSON.stringify(first));

  const caps = buildCaptionsFromCards([{ startChar: 0, endChar: 10 }, { startChar: 10, endChar: text.length }], timing, text);
  check("el captions: trimmed + char-exact",
    caps.length === 2 && caps[0].text === "สวัสดีครับ" && caps[0].startMs === 0 && caps[0].endMs === Math.round(endSec[9] * 1000));

  // alignment text mismatch → throw
  let threw = false;
  try {
    buildWordsFromTiming({ ...timing, chars: { characters: characters.slice(1), startSec: startSec.slice(1), endSec: endSec.slice(1) } }, text);
  } catch (e) { threw = e instanceof TtsTimingMismatchError; }
  check("el: alignment/fullText mismatch throws", threw);
}

{
  // merge two chunk alignments offset by REAL chunk duration (1.0s audio even
  // though alignment tail says 0.9s — trailing silence clipped by the model)
  const a = { characters: ["ก", "ข"], startSec: [0, 0.4], endSec: [0.4, 0.9] };
  const b = { characters: ["ค", "ง"], startSec: [0, 0.3], endSec: [0.3, 0.7] };
  const merged = mergeCharAlignments([a, b], [1.0, 0.8]);
  check("mergeCharAlignments: second chunk offset by real duration",
    merged.startSec[2] === 1.0 && merged.endSec[3] === 1.7 && merged.characters.join("") === "กขคง");

  let threw = false;
  try { mergeCharAlignments([a], [1.0, 2.0]); } catch (e) { threw = e instanceof TtsTimingMismatchError; }
  check("mergeCharAlignments: parts/durations length mismatch throws", threw);
}

// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll tts-timing checks passed ✓");
