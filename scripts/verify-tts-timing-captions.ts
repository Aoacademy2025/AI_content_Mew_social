// Verify the editor bridge: TTS `timing` response → editor captions + words.
// Run: npx tsx scripts/verify-tts-timing-captions.ts

import { captionsFromTtsTiming } from "../src/app/(dashboard)/video-editor/_components/tts-timing-captions";
import { splitScriptForTts, mergeSegmentTiming, type TtsTiming } from "../src/lib/tts-timing";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

const SCRIPT = [
  "รู้มั้ยว่าทำไมคนส่วนใหญ่ถึงเก็บเงินไม่อยู่",
  "เพราะเขาเก็บเงินที่เหลือจากการใช้ แทนที่จะใช้เงินที่เหลือจากการเก็บ",
  "ลองสลับลำดับดู แค่เปลี่ยนนิดเดียวชีวิตเปลี่ยนเลย",
  "เริ่มจากแบ่งเงินเดือนทันทีที่เงินเข้า ออมก่อนใช้เสมอ",
].join("\n");

function geminiTiming(fullText: string, maxChars = 120, msPerChar = 70): TtsTiming {
  const parts = splitScriptForTts(fullText, maxChars).map((c) => ({
    text: c.text,
    durationMs: c.text.replace(/\s+/g, "").length * msPerChar,
  }));
  return { provider: "gemini", segments: mergeSegmentTiming(parts), chars: null };
}

// 1) Happy path — the exact flow applyTtsTiming() runs
{
  const timing = geminiTiming(SCRIPT);
  const res = captionsFromTtsTiming(timing, 0, 27);
  check("happy: returns result", res !== null);
  if (res) {
    check("happy: captions cover all spoken text",
      res.captions.map((c) => c.text).join("").replace(/\s+/g, "") === SCRIPT.replace(/\s+/g, ""));
    check("happy: captions ≤ maxCardChars", res.captions.every((c) => c.text.length <= 27));
    check("happy: captions monotonic", res.captions.every((c, i) => i === 0 || c.startMs >= res.captions[i - 1].endMs));
    check("happy: editor Caption shape (text/startMs/endMs/tag only)",
      res.captions.every((c) => typeof c.text === "string" && typeof c.startMs === "number" && typeof c.endMs === "number" && ["hook", "body", "cta"].includes(c.tag ?? "body")));
    check("happy: first card tagged hook", res.captions[0].tag === "hook");
    check("happy: words monotonic non-overlapping",
      res.words.every((w, i) => w.endMs > w.startMs && (i === 0 || w.startMs >= res.words[i - 1].endMs)));
    const total = timing.segments.at(-1)!.startMs + timing.segments.at(-1)!.durationMs;
    check("happy: audioDurationMs from segments when no hint", Math.abs(res.audioDurationMs - total) <= 1, `${res.audioDurationMs} vs ${total}`);
    check("happy: audioDurationMs prefers positive hint", captionsFromTtsTiming(timing, 99_999, 27)!.audioDurationMs === 99_999);
  }
}

// 2) Trim trap — route trims input; bridge must rebuild fullText from segments,
//    so a script with surrounding whitespace still works via its trimmed timing
{
  const timing = geminiTiming(SCRIPT.trim());
  const res = captionsFromTtsTiming(timing, 0, 27);
  check("trim trap: bridge never needs local script state", res !== null && res.words.length > 0);
}

// 3) Fail-open paths — every bad input returns null (never throws)
{
  check("null timing → null", captionsFromTtsTiming(null, 0, 27) === null);
  check("undefined timing → null", captionsFromTtsTiming(undefined, 0, 27) === null);
  check("empty segments → null", captionsFromTtsTiming({ provider: "gemini", segments: [], chars: null }, 0, 27) === null);
  check("segment with zero duration → null",
    captionsFromTtsTiming({ provider: "gemini", segments: [{ text: "ก", startMs: 0, durationMs: 0 }], chars: null }, 0, 27) === null);
  check("segment with non-string text → null",
    captionsFromTtsTiming({ provider: "gemini", segments: [{ text: 42 as unknown as string, startMs: 0, durationMs: 100 }], chars: null }, 0, 27) === null);
  check("whitespace-only script → null",
    captionsFromTtsTiming({ provider: "gemini", segments: [{ text: "  \n ", startMs: 0, durationMs: 100 }], chars: null }, 0, 27) === null);
  // malformed garbage from a hypothetical broken response must not crash
  check("garbage object → null",
    captionsFromTtsTiming({ provider: "gemini", segments: [{ bad: true }] } as unknown as TtsTiming, 0, 27) === null);
}

// 4) ElevenLabs char-level path through the same bridge
{
  const text = "สวัสดีครับ ผมชื่อมิว วันนี้มาสอนออมเงิน";
  const characters = Array.from(text);
  const timing: TtsTiming = {
    provider: "elevenlabs",
    segments: [{ text, startMs: 0, durationMs: characters.length * 80 }],
    chars: {
      characters,
      startSec: characters.map((_, i) => i * 0.08),
      endSec: characters.map((_, i) => (i + 1) * 0.08),
    },
  };
  const res = captionsFromTtsTiming(timing, 0, 20);
  check("elevenlabs: char-exact words via bridge", res !== null && res.words[0].startMs === 0 && res.words.length >= 5);
  // broken alignment (mismatch) → null, not a crash
  const broken = { ...timing, chars: { ...timing.chars!, characters: characters.slice(1), startSec: timing.chars!.startSec.slice(1), endSec: timing.chars!.endSec.slice(1) } };
  check("elevenlabs: mismatched alignment → null (fail-open)", captionsFromTtsTiming(broken, 0, 20) === null);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll tts-timing-captions checks passed ✓");
