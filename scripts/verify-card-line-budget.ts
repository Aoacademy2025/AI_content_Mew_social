// verify-card-line-budget.ts — Card Line Budget in the caption core (MCP upgrade T1).
//
// Plan: docs/plans/2026-10-01-mcp-upgrade-p0-p1.md (T1). Term: CONTEXT.md "Card Line Budget".
// A word-count Caption ("1"–"4") stays within one rendered line at the active subtitle
// size; a sentence Caption stays within two lines broken at a Thai word boundary. Text
// beyond the budget becomes another Caption — never a character changed, never a merge.
//
// RED fixtures (Mew's own 48-card clip is already within budget, so it is not the RED case):
//   (a) an LLM-accepted unspaced Thai run of 60+ base graphemes in sentence mode,
//   (b) a 3-word group over the one-line budget in word mode,
//   (c) Thai with heavy combining marks, proving the budget counts base graphemes.
// GREEN invariants on mcp-48-cards.json + every RED fixture, at sizes 80 and 60:
//   every card fits, every new split index is a wordBoundaries index, joined text equals
//   fullText (textExact comparison), timings monotonic / non-overlapping / within audio.
//   Mew's 48 cards stay byte-identical.
// Part E runs the real orchestrator (preview mode, throwaway SQLite, stub providers) so the
// final pass is proven on the path every MCP and web-editor clip takes.
//
// Run: node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-card-line-budget.ts

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CARD_SUBTITLE_SIZE,
  baseGraphemeCount,
  fitsCardLineBudget,
  maxCardCharsFor,
} from "../src/lib/card-line-budget";
import {
  DEFAULT_STYLE,
  cardsByWordCount,
  maxCardCharsFor as maxCardCharsForReexport,
} from "../src/lib/mcp/orchestrator-steps";
import {
  buildWordsFromTiming,
  enforceCardLineBudget,
  tokenizeWords,
  wordBoundaries,
  type ScriptCard,
  type TimedWord,
  type TtsTiming,
} from "../src/lib/tts-timing";
import { groupTimedCaptionWords } from "../src/lib/word-caption-groups";
import { captionsFromTtsTiming } from "../src/app/(dashboard)/video-editor/_components/tts-timing-captions";
import { regroupCaptions } from "../src/app/(dashboard)/video-editor/_v2/subtitle-style";
import { validateSubtitleQuality } from "../src/lib/mcp/subtitle-quality";
import {
  DEFAULT_STORY_FILM_EDITORIAL_CONFIG,
  captionsForStoryFilmEditorial,
} from "../src/lib/story-film-editorial";

let failures = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

type Cap = { text: string; startMs: number; endMs: number; tag?: string };
type Span = { start: number; end: number };

const SIZES = [80, 60] as const;
const THAI_MARK_AT_START = /^[ัิ-ฺ็-๎]/u;
const normCard = (value: string) => value.replace(/\s+/gu, " ").trim();
// The textExact comparison of validateSubtitleQuality: NFC, whitespace removed.
const canonicalVisible = (value: string) => value.normalize("NFC").replace(/\s+/gu, "");

/** Each caption's visible span on fullText, matched in order (whitespace-insensitive). */
function sourceSpans(captions: readonly Cap[], fullText: string): Span[] | null {
  const spans: Span[] = [];
  let pos = 0;
  for (const caption of captions) {
    while (pos < fullText.length && /\s/u.test(fullText[pos])) pos += 1;
    const start = pos;
    for (const unit of caption.text.replace(/\s+/gu, "")) {
      for (let i = 0; i < unit.length; i += 1) {
        while (pos < fullText.length && /\s/u.test(fullText[pos])) pos += 1;
        if (fullText[pos] !== unit[i]) return null;
        pos += 1;
      }
    }
    spans.push({ start, end: pos });
  }
  return spans;
}

function lineBreakFits(fullText: string, span: Span, oneLine: number, bounds: number[]): boolean {
  if (baseGraphemeCount(normCard(fullText.slice(span.start, span.end))) <= oneLine) return true;
  return bounds.some((b) => b > span.start && b < span.end
    && baseGraphemeCount(normCard(fullText.slice(span.start, b))) <= oneLine
    && baseGraphemeCount(normCard(fullText.slice(b, span.end))) <= oneLine);
}

/**
 * The GREEN invariants. `before` is the track handed to the pass; the pass may only add
 * card edges (never move or remove one) and every edge it adds must be a word boundary.
 */
function checkTrack(label: string, args: {
  before: readonly Cap[];
  after: readonly Cap[];
  fullText: string;
  mode: string;
  size: number;
  audioDurationMs: number;
  expectSplit?: boolean;
}) {
  const { before, after, fullText, mode, size, audioDurationMs } = args;
  const oneLine = maxCardCharsFor(size);
  const bounds = wordBoundaries(fullText);
  const boundSet = new Set(bounds);

  const over = after.filter((caption) => !fitsCardLineBudget(caption.text, mode, size));
  check(`${label}: every card fits its budget`, over.length === 0,
    over.map((c) => `${baseGraphemeCount(c.text)} base "${c.text}"`).join(" | "));

  const afterSpans = sourceSpans(after, fullText);
  const beforeSpans = sourceSpans(before, fullText);
  check(`${label}: every card maps onto fullText in order`, !!afterSpans && !!beforeSpans);
  if (!afterSpans || !beforeSpans) return;

  if (mode === "sentence") {
    const noBreak = after.filter((_, i) => !lineBreakFits(fullText, afterSpans[i], oneLine, bounds));
    check(`${label}: every sentence card has a two-line break at a word boundary`, noBreak.length === 0,
      noBreak.map((c) => `"${c.text}"`).join(" | "));
  }

  const beforeEdges = new Set(beforeSpans.slice(0, -1).map((span) => span.end));
  const afterEdges = afterSpans.slice(0, -1).map((span, i) => ({ end: span.end, nextStart: afterSpans[i + 1].start }));
  const lostEdges = [...beforeEdges].filter((edge) => !afterEdges.some((e) => e.end === edge));
  check(`${label}: never merges or moves an existing card edge`, lostEdges.length === 0, `lost edges ${lostEdges.join(",")}`);
  const newEdges = afterEdges.filter((edge) => !beforeEdges.has(edge.end));
  const offBoundary = newEdges.filter((edge) => {
    for (let b = edge.end; b <= edge.nextStart; b += 1) if (boundSet.has(b)) return false;
    return true;
  });
  check(`${label}: every split index is a wordBoundaries index`, offBoundary.length === 0,
    offBoundary.map((edge) => `${edge.end}:"${fullText.slice(Math.max(0, edge.end - 6), edge.end)}|${fullText.slice(edge.end, edge.end + 6)}"`).join(" "));
  if (args.expectSplit) check(`${label}: the over-budget card was split`, after.length > before.length,
    `${before.length} → ${after.length} cards`);

  check(`${label}: joined text equals fullText (textExact comparison)`,
    canonicalVisible(after.map((c) => c.text).join("")) === canonicalVisible(fullText));
  const qa = validateSubtitleQuality({ script: fullText, captions: after as Cap[] as never,
    audioDurationMs, timingSource: "provider_alignment" });
  check(`${label}: QA textExact holds and no spacing_mismatch`, qa.textExact && qa.code !== "spacing_mismatch",
    `textExact=${qa.textExact} code=${qa.code ?? "-"}`);
  const dangling = after.filter((c) => /[\p{Ps}\p{Pi}]$/u.test(c.text) || /^[\p{Pe}\p{Pf}ๆฯ]/u.test(c.text));
  check(`${label}: no card ends on an opening bracket or starts on a closing one / ๆ`, dangling.length === 0,
    dangling.map((c) => `"${c.text}"`).join(" | "));
  const broken = after.filter((c) => THAI_MARK_AT_START.test(c.text.trim()));
  check(`${label}: no card starts with a Thai combining mark (broken_thai_grapheme)`, broken.length === 0,
    broken.map((c) => `"${c.text}"`).join(" | "));
  check(`${label}: no card changed its text except by splitting`, after.every((c) => c.text === normCard(c.text) && c.text.length > 0));

  let previousEnd = 0;
  const badTiming: string[] = [];
  after.forEach((c, i) => {
    if (!Number.isFinite(c.startMs) || !Number.isFinite(c.endMs) || c.startMs < 0 || c.endMs <= c.startMs
      || c.startMs < previousEnd || c.endMs > audioDurationMs) badTiming.push(`#${i} ${c.startMs}-${c.endMs}`);
    previousEnd = c.endMs;
  });
  check(`${label}: timings monotonic, non-overlapping, within audioDurationMs`, badTiming.length === 0, badTiming.join(" "));
}

/** Word timing synthesized from caption spans (the fixture ships no words[]). */
function wordsFromCaptionSpans(captions: readonly Cap[], fullText: string): TimedWord[] {
  const spans = sourceSpans(captions, fullText);
  if (!spans) throw new Error("fixture captions do not map onto fullText");
  const tokens = tokenizeWords(fullText);
  const words: TimedWord[] = [];
  spans.forEach((span, i) => {
    const caption = captions[i];
    const inside = tokens.filter((t) => t.startChar >= span.start && t.startChar < span.end);
    const width = Math.max(1, span.end - span.start);
    for (const t of inside) {
      const a = (t.startChar - span.start) / width;
      const b = (Math.min(span.end, t.endChar) - span.start) / width;
      words.push({ ...t, startMs: Math.round(caption.startMs + a * (caption.endMs - caption.startMs)),
        endMs: Math.round(caption.startMs + b * (caption.endMs - caption.startMs)) });
    }
  });
  return words;
}

function geminiTiming(text: string, durationMs: number): TtsTiming {
  return { provider: "gemini", segments: [{ text, startMs: 0, durationMs }], chars: null };
}

// ── 0. The module: formula, re-export, base-grapheme counting ───────────────────────────
console.log("0) card-line-budget module");
check("maxCardCharsFor keeps the editor formula (80 → 24, 60 → 32)",
  maxCardCharsFor(80) === Math.max(10, Math.floor((1080 - 160) / (80 * 0.47))) && maxCardCharsFor(80) === 24
  && maxCardCharsFor(60) === 32);
check("orchestrator-steps re-exports the same maxCardCharsFor", maxCardCharsForReexport === maxCardCharsFor);
check("default size is 80 and matches DEFAULT_STYLE", DEFAULT_CARD_SUBTITLE_SIZE === 80
  && DEFAULT_STYLE.subtitleSize === DEFAULT_CARD_SUBTITLE_SIZE && maxCardCharsFor() === 24);
check("sentence may use two lines, word-count modes one",
  fitsCardLineBudget("ก".repeat(48), "sentence", 80) && !fitsCardLineBudget("ก".repeat(49), "sentence", 80)
  && fitsCardLineBudget("ก".repeat(24), "3", 80) && !fitsCardLineBudget("ก".repeat(25), "3", 80));

// ── (c) heavy combining marks: the budget counts base graphemes, not code units ─────────
console.log("(c) heavy combining marks");
const MEW_LONGEST = "กระจุกอยู่ที่เด็กซึ่งทำการบ้านเสร็จเร็วผิดปกติ";
const HEAVY = "ผู้ที่นี่ชี้ที่นั่นนี่นั่นที่นี้ผู้นั้นชี้นี่ผู้ที่นั่นที่นี่ชี้";
check("Mew's longest card is 46 code units but 33 base graphemes",
  MEW_LONGEST.length === 46 && baseGraphemeCount(MEW_LONGEST) === 33);
check("heavy-mark run is 64 code units but 24 base graphemes", HEAVY.length === 64 && baseGraphemeCount(HEAVY) === 24);
{
  // 128 code units, 48 base graphemes: exactly two lines at 80. A code-unit counter splits it.
  const text = HEAVY + HEAVY;
  const before: Cap[] = [{ text, startMs: 0, endMs: 6_000, tag: "hook" }];
  const words = buildWordsFromTiming(geminiTiming(text, 6_000), text);
  for (const size of SIZES) {
    const after = enforceCardLineBudget(before, words, text, "sentence", size);
    check(`(c) size ${size}: 48 base graphemes in 128 code units stays one card, untouched`,
      JSON.stringify(after) === JSON.stringify(before));
  }
  // 192 code units, 72 base graphemes: over two lines at 80 → must split.
  const longer = HEAVY + HEAVY + HEAVY;
  const longBefore: Cap[] = [{ text: longer, startMs: 0, endMs: 9_000, tag: "hook" }];
  const longWords = buildWordsFromTiming(geminiTiming(longer, 9_000), longer);
  for (const size of SIZES) {
    const after = enforceCardLineBudget(longBefore, longWords, longer, "sentence", size);
    checkTrack(`(c) size ${size} heavy 72-base card`, { before: longBefore, after, fullText: longer, mode: "sentence",
      size, audioDurationMs: 9_000, expectSplit: size === 80 });
  }
  // Word mode at size 160 (one line = 12 base): "ที่นั่นนี่นั่น" is 14 code units, 6 base.
  const heavyWords = buildWordsFromTiming(geminiTiming(HEAVY, 5_000), HEAVY);
  const cards = cardsByWordCount(heavyWords, 4, HEAVY, 160);
  check("(c) word mode 4 at size 160 keeps 4-word heavy-mark groups whole (5 cards)", cards.length === 5,
    cards.map((c) => `${c.text.length}u/${baseGraphemeCount(c.text)}b "${c.text}"`).join(" | "));
}

// ── tags: a split hook stays the first piece, a split cta the last ──────────────────────
console.log("tags and brackets");
{
  const text = HEAVY + HEAVY + HEAVY;
  const words = buildWordsFromTiming(geminiTiming(text, 9_000), text);
  const hook = enforceCardLineBudget([{ text, startMs: 0, endMs: 9_000, tag: "hook" }], words, text, "sentence", 80);
  check("split hook: only the first piece keeps hook", hook.length > 1 && hook[0].tag === "hook"
    && hook.slice(1).every((c) => c.tag === "body"), hook.map((c) => c.tag).join(","));
  const cta = enforceCardLineBudget([{ text, startMs: 0, endMs: 9_000, tag: "cta" }], words, text, "sentence", 80);
  check("split cta: only the last piece keeps cta", cta.length > 1 && cta[cta.length - 1].tag === "cta"
    && cta.slice(0, -1).every((c) => c.tag === "body"), cta.map((c) => c.tag).join(","));
  // Brackets around a long run: a cut never leaves "(" at a card end.
  for (const [name, bracketed] of [
    ["spaced", "เรื่องนี้สำคัญ (การลงทุนในหุ้นเทคโนโลยีที่กำลังเติบโต) และ (ตลาดโลกต้องอาศัยความอดทน) ครับ"],
    ["unspaced", "เรื่องนี้สำคัญมาก(การลงทุนในหุ้นเทคโนโลยีที่กำลังเติบโตอย่างรวดเร็ว)และ“ตลาดโลกต้องอาศัยความอดทนและวินัย”ครับ"],
  ] as const) {
    const bWords = buildWordsFromTiming(geminiTiming(bracketed, 8_000), bracketed);
    const before: Cap[] = [{ text: bracketed, startMs: 0, endMs: 8_000, tag: "body" }];
    for (const mode of ["sentence", "2"]) {
      for (const size of [80, 60, 120, 160]) {
        const after = enforceCardLineBudget(before, bWords, bracketed, mode, size);
        checkTrack(`brackets ${name} ${mode} size ${size}`, { before, after, fullText: bracketed, mode, size, audioDurationMs: 8_000 });
      }
    }
  }
}

// ── readable values: a time keeps its น., a number its digits, ๆ its word ──────────────
console.log("readable values");
{
  const text = "นัดกันพรุ่งนี้เช้าตอน 08:30 น. ที่หน้าตลาดหลักทรัพย์แห่งประเทศไทยนะครับ ไปๆ มาๆ ก็ได้กำไรมา 1,250.50 บาท";
  const words = buildWordsFromTiming(geminiTiming(text, 9_000), text);
  const before: Cap[] = [{ text, startMs: 0, endMs: 9_000, tag: "body" }];
  const broken: string[] = [];
  for (let size = 60; size <= 200; size += 10) {
    for (const mode of ["sentence", "1", "2", "3", "4"]) {
      const after = enforceCardLineBudget(before, words, text, mode, size);
      const bad = after.filter((c, i) => /^น\./.test(c.text) || /^[ๆ,.:]/.test(c.text)
        || (i > 0 && /[0-9๐-๙][.,:]?$/.test(after[i - 1].text) && /^[0-9๐-๙]/.test(c.text)));
      if (bad.length) broken.push(`${mode}@${size}: ${after.map((c) => `[${c.text}]`).join("")}`);
    }
  }
  check("no cut inside 08:30 น., 1,250.50 or before ๆ at sizes 60–200", broken.length === 0, broken.slice(0, 3).join("\n        "));
}

// ── (a) LLM-accepted unspaced Thai run, sentence mode ──────────────────────────────────
console.log("(a) LLM-accepted unspaced Thai run");
const A_PREFIX = "สวัสดีครับ วันนี้มาคุยเรื่องเงินกัน ";
const A_LONG = "การลงทุนในหุ้นเทคโนโลยีที่กำลังเติบโตอย่างรวดเร็วในตลาดโลกต้องอาศัยความอดทนและวินัยในการถือครองระยะยาวเสมอจึงจะได้ผลตอบแทนที่คุ้มค่า";
const A_SUFFIX = " ขอบคุณที่ติดตามครับ";
const A_TEXT = A_PREFIX + A_LONG + A_SUFFIX;
const A_DURATION_MS = 14_000;
function viralCardsFor(text: string): ScriptCard[] {
  const at = text.indexOf(A_LONG);
  return [
    { startChar: 0, endChar: at },
    { startChar: at, endChar: at + A_LONG.length },
    { startChar: at + A_LONG.length, endChar: text.length },
  ];
}
{
  check("(a) the unspaced run is 60+ base graphemes", baseGraphemeCount(A_LONG) >= 60, `${baseGraphemeCount(A_LONG)}`);
  const res = captionsFromTtsTiming(geminiTiming(A_TEXT, A_DURATION_MS), A_DURATION_MS, maxCardCharsFor(), viralCardsFor(A_TEXT));
  check("(a) the LLM card is accepted verbatim by the timing bridge", !!res && res.captions.some((c) => c.text === A_LONG));
  if (res) {
    const before = res.captions;
    for (const size of SIZES) {
      const after = enforceCardLineBudget(before, res.words, res.fullText, "sentence", size);
      checkTrack(`(a) size ${size}`, { before, after, fullText: res.fullText, mode: "sentence", size,
        audioDurationMs: A_DURATION_MS, expectSplit: true });
      // Split timing comes from word timing: each new card starts at its first word's onset.
      const spans = sourceSpans(after, res.fullText) ?? [];
      const wordStart = spans.map((span) => res.words.find((w) => w.startChar >= span.start && w.startChar < span.end)?.startMs);
      const insideLong = after.map((c, i) => ({ c, i })).filter(({ c }) => A_LONG.includes(c.text));
      check(`(a) size ${size}: split times are the first word's onset`,
        insideLong.slice(1).every(({ c, i }) => c.startMs === wordStart[i] && after[i - 1].endMs === c.startMs),
        insideLong.map(({ c, i }) => `${c.startMs}/${wordStart[i]}`).join(" "));
    }
    // Without word timing the split is proportional to base graphemes within the card span.
    const longCard = before.find((c) => c.text === A_LONG)!;
    const after = enforceCardLineBudget([longCard], [], res.fullText, "sentence", 80);
    const total = baseGraphemeCount(longCard.text);
    let consumed = 0;
    const proportional = after.slice(0, -1).every((piece, i) => {
      consumed += baseGraphemeCount(piece.text);
      const expected = longCard.startMs + (longCard.endMs - longCard.startMs) * consumed / total;
      return Math.abs(piece.endMs - expected) <= 1 && after[i + 1].startMs === piece.endMs;
    });
    check("(a) no word timing → split times proportional to base graphemes", after.length > 1 && proportional,
      after.map((c) => `${c.startMs}-${c.endMs} "${c.text}"`).join(" | "));
  }
}

// ── (b) word mode: a 3-word group over the one-line budget ──────────────────────────────
console.log("(b) word mode 3-word group over one line");
const B_TEXT = "มอยส์เจอไรเซอร์อินฟลูเอนเซอร์แอปพลิเคชันพอร์ตโฟลิโอมาร์เก็ตติ้งอีคอมเมิร์ซ";
const B_DURATION_MS = 6_000;
{
  const words = buildWordsFromTiming(geminiTiming(B_TEXT, B_DURATION_MS), B_TEXT);
  check("(b) six whole loanwords", words.length === 6, words.map((w) => w.word).join("|"));
  const firstThree = B_TEXT.slice(words[0].startChar, words[2].endChar);
  check("(b) the first 3-word group is over one line at 80 and 60",
    baseGraphemeCount(firstThree) > maxCardCharsFor(80) && baseGraphemeCount(firstThree) > maxCardCharsFor(60),
    `${baseGraphemeCount(firstThree)} base`);
  // The track an unbudgeted grouping (or a later merge) hands the final pass.
  const grouped: Cap[] = [0, 3].map((i) => ({
    text: B_TEXT.slice(words[i].startChar, words[i + 2].endChar),
    startMs: words[i].startMs,
    endMs: words[i + 2].endMs,
    tag: "body",
  }));
  for (const size of SIZES) {
    const fromGrouping = cardsByWordCount(words, 3, B_TEXT, size);
    checkTrack(`(b) size ${size} cardsByWordCount`, { before: fromGrouping, after: fromGrouping, fullText: B_TEXT,
      mode: "3", size, audioDurationMs: B_DURATION_MS });
    check(`(b) size ${size}: groupTimedCaptionWords is the same shared core`,
      JSON.stringify(groupTimedCaptionWords(words, 3, B_TEXT, size)) === JSON.stringify(fromGrouping));
    const after = enforceCardLineBudget(grouped, words, B_TEXT, "3", size);
    checkTrack(`(b) size ${size} final pass`, { before: grouped, after, fullText: B_TEXT, mode: "3", size,
      audioDurationMs: B_DURATION_MS, expectSplit: true });
  }
  const web = regroupCaptions([], "3", words, B_TEXT);
  check("(b) web regroupCaptions word mode keeps one line at the default size",
    web.length > 0 && web.every((c) => fitsCardLineBudget(c.text, "3", DEFAULT_CARD_SUBTITLE_SIZE)),
    web.map((c) => `"${c.text}"`).join(" | "));
  check("(b) web regroupCaptions defaults to the shared core at size 80",
    JSON.stringify(web.map((c) => c.text)) === JSON.stringify(cardsByWordCount(words, 3, B_TEXT).map((c) => c.text)));
  const server = [{ text: "การ์ดจากเซิร์ฟเวอร์ที่ยาวมากเกินหนึ่งบรรทัดแน่นอนเลยครับ", startMs: 0, endMs: 900, tag: "hook" as const }];
  const sentence = regroupCaptions(server, "sentence", words, B_TEXT);
  check("(b) web regroupCaptions sentence mode returns the server cards unchanged",
    JSON.stringify(sentence) === JSON.stringify(server) && sentence[0] !== server[0]);
  const film = captionsForStoryFilmEditorial({
    editorial: { ...DEFAULT_STORY_FILM_EDITORIAL_CONFIG, subtitleMode: "3", subtitleFontSize: 80 },
    track: { version: 1, source: "hero_voice_timing", fullText: B_TEXT, captions: [], words },
    scenes: [],
  });
  check("(b) Story Film word mode groups at its editorial size",
    film.length > 0 && film.every((c) => fitsCardLineBudget(c.text, "3", 80)), film.map((c) => `"${c.text}"`).join(" | "));
}

// ── Mew's 48 cards: within budget, byte-identical ──────────────────────────────────────
console.log("Mew's 48-card fixture");
{
  const fixture = JSON.parse(readFileSync(join(process.cwd(), "scripts/fixtures/mcp-48-cards.json"), "utf8")) as {
    subtitleMode: string; audioDurationMs: number; fullText: string; captions: Cap[];
  };
  check("fixture has 48 sentence cards", fixture.captions.length === 48 && fixture.subtitleMode === "sentence");
  const words = wordsFromCaptionSpans(fixture.captions, fixture.fullText);
  for (const size of SIZES) {
    const before = JSON.parse(JSON.stringify(fixture.captions)) as Cap[];
    const after = enforceCardLineBudget(before, words, fixture.fullText, "sentence", size);
    check(`fixture size ${size}: 48 cards byte-identical`, JSON.stringify(after) === JSON.stringify(fixture.captions));
    checkTrack(`fixture size ${size}`, { before: fixture.captions, after, fullText: fixture.fullText, mode: "sentence",
      size, audioDurationMs: fixture.audioDurationMs });
  }
}

// ── E. the orchestrator's final pass (preview mode, the path MCP and the web editor share) ─
async function verifyOrchestratorFinalPass() {
  console.log("E) orchestrator final pass on an LLM-accepted card");
  const dir = mkdtempSync(join(tmpdir(), "cardlinebudget-"));
  process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });
  const { runOrchestrator } = await import("../src/lib/mcp/orchestrator");
  const { createVideoJob, parseVideoJobOutput } = await import("../src/lib/mcp/video-job");
  const { prisma } = await import("../src/lib/prisma");

  const now = new Date();
  await prisma.user.create({
    data: {
      id: "u-budget", name: "Budget User", email: "budget@example.com",
      plan: "PRO", minutesLimit: 80, minutesUsed: 0,
      usagePeriodStartedAt: now, trialEndsAt: null, usageLimit: 100, usageCount: 0,
      geminiVoiceName: "Aoede", subStatus: "active", stripeSubscriptionId: "sub_budget_fixture",
      planExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
    },
  });
  await prisma.payment.create({
    data: { userId: "u-budget", stripeSessionId: "cs_budget_fixture", plan: "PRO", amount: 59_900,
      status: "PAID", periodDays: 30, paidAt: now },
  });

  const calls: string[] = [];
  let renderCount = 0;
  const caller = {
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push(path);
      if (path === "/api/videos/tts-gemini" || path === "/api/videos/tts") {
        return { voiceUrl: "/api/voices/budget.m4a", audioDurationMs: A_DURATION_MS,
          timing: geminiTiming(A_TEXT, A_DURATION_MS) } as T;
      }
      if (path === "/api/videos/split-script") {
        return { cards: viralCardsFor(String((body as { text?: string })?.text ?? "")) } as T;
      }
      // No acoustic clock: the provider clock (with the LLM cards) renders.
      if (path === "/api/videos/transcribe") return { words: [] } as T;
      if (path === "/api/videos/extract-keywords") {
        return { keywords: ["money"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [14],
          visualDirection: "", keywordAlternatives: [] } as T;
      }
      if (path === "/api/videos/fetch-stock") return { results: [{ videoUrl: "stock1.mp4", keyword: "money" }] } as T;
      if (path === "/api/videos/generate-config") return { config: { scenes: [], voiceUrl: "/api/voices/budget.m4a" } } as T;
      if (path === "/api/videos/render") { renderCount += 1; return { jobId: `render-${renderCount}` } as T; }
      if (path.startsWith("/api/videos/render-cancel")) return {} as T;
      throw new Error(`stub caller: unexpected POST ${path}`);
    },
    async patch<T>(): Promise<T> { return {} as T; },
    async get<T>(path: string): Promise<T> {
      if (path.startsWith("/api/videos/render-progress")) {
        const n = /render-(\d+)/.exec(path)?.[1] ?? "0";
        return { progress: 100, videoUrl: `/renders/out-${n}.mp4`, error: null, stage: "done" } as T;
      }
      if (path === "/api/music") return { tracks: [], userTracks: [] } as T;
      throw new Error(`stub caller: unexpected GET ${path}`);
    },
  };

  const queued = await createVideoJob("u-budget", { script: A_TEXT, previewMode: true, voiceProvider: "gemini" });
  await prisma.videoJob.update({ where: { id: queued.id }, data: { status: "processing" } });
  await runOrchestrator(queued.id, "u-budget", { caller, refundOneClip: async () => {}, sleep: async () => {} });
  const done = await prisma.videoJob.findUnique({ where: { id: queued.id } });
  check("E: preview job finished", done?.status === "done", `${done?.status} ${done?.errorMessage ?? ""}`);
  check("E: split-script was consulted (the LLM card path)", calls.includes("/api/videos/split-script"));
  const preview = parseVideoJobOutput(done?.outputJson ?? null)?.preview;
  const captions = (preview?.captions ?? []) as Cap[];
  const fullText = preview?.fullText ?? A_TEXT;
  check("E: preview captions present", captions.length > 0);
  checkTrack("E: preview captions at the default size", {
    before: captions, after: captions, fullText, mode: "sentence", size: DEFAULT_CARD_SUBTITLE_SIZE,
    audioDurationMs: A_DURATION_MS,
  });
  check("E: the 60+ grapheme LLM card no longer reaches the render as one card",
    !captions.some((c) => c.text === A_LONG) && captions.length > 3, `${captions.length} cards`);
  await prisma.$disconnect();
}

verifyOrchestratorFinalPass()
  .catch((error) => {
    failures += 1;
    console.error("  FAIL  E: orchestrator run threw", error);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failures} failed`);
    if (failures > 0) {
      console.error("❌ Card Line Budget verification FAILED");
      process.exit(1);
    }
    console.log("✅ Card Line Budget: all checks passed");
    process.exit(0);
  });
