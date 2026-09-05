import assert from "node:assert/strict";
import { projectAcousticClock, mergeUncertainCaptionCards, mergeShortAcousticCards } from "../src/lib/acoustic-subtitle-clock";

const text = "แมว กิน ปลา";
const words = [
  { word: "แมว", startChar: 0, endChar: 3, startMs: 3000, endMs: 3500 },
  { word: "กิน", startChar: 4, endChar: 7, startMs: 3500, endMs: 4000 },
  { word: "ปลา", startChar: 8, endChar: 11, startMs: 4000, endMs: 4500 },
];
const characters = [0, 1, 2, 4, 5, 6, 8, 9, 10].map((startChar, i) => ({
  startChar, endChar: startChar + 1,
  startMs: 200 + i * 100, endMs: 300 + i * 100, confidence: .99,
}));
const complete = projectAcousticClock({ text, baselineWords: words, characters, audioDurationMs: 5000 });
assert(complete);
assert.equal(complete.words[0].startMs, 200, "audible start replaces three-second late source clock");
assert.equal(complete.verifiedWordCount, 3);
assert.deepEqual(complete.uncertainRanges, []);
assert.deepEqual(complete.words.map(w => w.word), words.map(w => w.word), "source wording is immutable");

const partial = projectAcousticClock({ text, baselineWords: words, characters: characters.filter(c => c.startChar < 4 || c.startChar >= 8), audioDurationMs: 5000 });
assert(partial);
assert.equal(partial.words[0].startMs, 200, "a missing middle word must not throw away the valid opening anchor");
assert.equal(partial.words[2].startMs, 800, "a missing middle word must not throw away the valid ending anchor");
assert(partial.words[1].startMs >= partial.words[0].endMs);
assert(partial.words[1].endMs <= partial.words[2].startMs);
assert.equal(partial.uncertainRanges.length, 1);
assert.equal(partial.verifiedWordCount, 2);

const cards = partial.words.map(w => ({ text: w.word, startMs: w.startMs, endMs: w.endMs }));
const merged = mergeUncertainCaptionCards(cards, [{ startMs: 450, endMs: 850 }], text);
assert(merged.length < cards.length, "uncertain speech is shown as a phrase, not fabricated word flashes");
assert.equal(merged.map(c => c.text).join("").replace(/\s/g, ""), "แมวกินปลา");

assert.equal(mergeUncertainCaptionCards([
  { text: "AI", startMs: 0, endMs: 100 }, { text: "Creator", startMs: 100, endMs: 200 },
], [{ startMs: 0, endMs: 200 }], "AI Creator")[0].text, "AI Creator", "merging preserves the original space between English words");
assert.equal(projectAcousticClock({ text, baselineWords: words, characters: [], audioDurationMs: 5000 }), null);
assert.equal(projectAcousticClock({ text, baselineWords: words, characters: [...characters].reverse(), audioDurationMs: 5000 }), null, "unordered clocks cannot be promoted");
assert.equal(projectAcousticClock({ text, baselineWords: words, characters: characters.map(c => ({ ...c, startMs: Number.NaN })), audioDurationMs: 5000 }), null);
assert.equal(projectAcousticClock({ text, baselineWords: words, characters: characters.map(c => ({ ...c, confidence: .01 })), audioDurationMs: 5000 }), null, "low-confidence alignment cannot relabel fallback as verified");

const readable = mergeShortAcousticCards([
  { text: "แมว", startMs: 0, endMs: 80 }, { text: "กิน", startMs: 100, endMs: 180 },
  { text: "ปลา", startMs: 200, endMs: 280 },
], text, 240);
assert.equal(readable.length, 1);
assert.equal(readable[0].startMs, 0);
assert.equal(readable[0].endMs, 280, "readability grouping must not stretch the true acoustic clock");

const paused = mergeShortAcousticCards([
  { text: "แมว", startMs: 0, endMs: 80 }, { text: "กิน", startMs: 5000, endMs: 5400 },
], "แมว กิน", 240);
assert.equal(paused.length, 2, "a short word before a pause must not reveal the next phrase early");

const detachedVowel = characters.map((c, i) => ({ ...c, startMs: c.startMs + (i ? 1500 : 0), endMs: c.endMs + (i ? 1500 : 0) }));
const detached = projectAcousticClock({ text, baselineWords: words, characters: detachedVowel, audioDurationMs: 5000 });
assert(detached);
assert.equal(detached.verifiedWordCount, 2, "a confident character detached into the preceding phrase is not a verified word start");
assert.equal(detached.uncertainRanges[0].startChar, 0);
console.log("acoustic subtitle clock: regression, partial anchors, immutable text, pause and invalid evidence PASS");
