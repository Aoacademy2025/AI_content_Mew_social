// TTS-derived subtitle timing — pure helpers shared by the Gemini/ElevenLabs TTS
// routes (PR-B/PR-D) and the editor (PR-C). See docs/plan-tts-derived-subtitle-timing-2026-06-12.md
//
// Iron rule: every char index in this file refers to ONE string — the exact
// fullText sent to TTS. Chunks are contiguous slices of it (concat(chunks) ===
// fullText, no trim/re-join), so subtitle text can never drift from the audio.

import { loanwordSpans } from "@/lib/thai-loanwords";

export type CaptionTag = "hook" | "body" | "cta";

export interface TtsScriptChunk {
  text: string;      // fullText.slice(startChar, endChar) — exact, untrimmed
  startChar: number;
  endChar: number;
}

export interface TtsSegment {
  text: string;
  startMs: number;
  durationMs: number;
}

// ElevenLabs /with-timestamps alignment, normalized + merged across chunks.
export interface TtsCharAlignment {
  characters: string[];
  startSec: number[];
  endSec: number[];
}

// A detected silence in the final audio (ffmpeg silencedetect): startMs = speech
// stops, endMs = speech resumes. The boundary snap targets endMs (speech onset).
export interface SilenceInterval { startMs: number; endMs: number }

export interface TtsTiming {
  provider: "gemini" | "elevenlabs";
  segments: TtsSegment[];
  chars: TtsCharAlignment | null; // gemini has no char-level timing
  // Real-pause midpoints (ms) from ffmpeg silencedetect over the final audio.
  // Card boundaries snap to these on the Gemini line (PR-E); ElevenLabs char
  // timing is already ground truth and never needs it. Legacy field kept for
  // back-compat; new generations also send silenceIntervals (below).
  silences?: number[] | null;
  // Full silence intervals (start/end ms) — lets the snap target the pause END
  // (speech onset) so a card appears exactly when its words are spoken, instead
  // of the pause midpoint (which showed the next card ~0.15–0.5s early).
  silenceIntervals?: SilenceInterval[] | null;
}

export interface TimedWord { word: string; startMs: number; endMs: number; startChar: number; endChar: number }

export interface TimedCaption {
  text: string;
  startMs: number;
  endMs: number;
  tag: CaptionTag;
}

export interface ScriptCard {
  startChar: number;
  endChar: number;
  tag?: CaptionTag;
}

// Thrown when timing data doesn't line up with fullText. Callers must treat
// this as "no timing available" and fall through to the transcribe path
// (fail-open) — never render subtitles from mismatched timing.
export class TtsTimingMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TtsTimingMismatchError";
  }
}

// ---------------------------------------------------------------------------
// Chunk sizing (the free-tier dial — plan §10.1)
// ---------------------------------------------------------------------------

// Short scripts use big chunks so free-tier (no billing) Gemini keys spend as
// few requests as today; long scripts use standard chunks for better in-chunk
// accuracy (those users need billing for RPM/RPD anyway). Thai speech runs
// roughly 13-16 chars/sec, so 800 chars ≈ 50-60s, 350 chars ≈ 22-27s.
export const SHORT_SCRIPT_CHARS = 1600;
export const CHUNK_CHARS_SHORT_SCRIPT = 800;
export const CHUNK_CHARS_LONG_SCRIPT = 350;

export function chooseChunkChars(totalChars: number): number {
  return totalChars <= SHORT_SCRIPT_CHARS ? CHUNK_CHARS_SHORT_SCRIPT : CHUNK_CHARS_LONG_SCRIPT;
}

// ---------------------------------------------------------------------------
// Script splitting
// ---------------------------------------------------------------------------

type WordSegmenter = { segment: (s: string) => Iterable<{ segment: string; index: number; isWordLike?: boolean }> };

function thaiWordSegmenter(): WordSegmenter | null {
  const I = Intl as unknown as { Segmenter?: new (locale: string, opts: { granularity: string }) => WordSegmenter };
  return I.Segmenter ? new I.Segmenter("th", { granularity: "word" }) : null;
}

// Thai combining marks that bind to the consonant on their LEFT (sara
// am/u/i/etc above-below vowels, tone marks, and thanthakhat ◌์). A word can
// never START with one of these — they're always glued to a preceding base
// char. Ranges: U+0E31 (mai han-akat), U+0E33 (sara am), U+0E34–U+0E3A
// (above/below vowels + phinthu), U+0E47–U+0E4E (tone marks, thanthakhat,
// nikhahit, yamakkan). U+0E4C is thanthakhat (◌์) specifically.
const THAI_GARAN = "์"; // ◌์ thanthakhat — silences the preceding consonant, always word-final
function isThaiLeftBindingMark(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c === 0x0e31 || (c >= 0x0e33 && c <= 0x0e3a) || (c >= 0x0e47 && c <= 0x0e4e);
}

// Reject a segmenter boundary that lands somewhere a Thai word can't begin.
// Intl.Segmenter("th", {granularity:"word"}) mis-splits loanwords: it breaks
// "คอมเมนต์" (comment) into "คอม | เมน | ต์", emitting a boundary right before
// the garan cluster "ต์" (ต + ◌์). Cutting there orphans "ต์" — a silent,
// always-word-final cluster — onto the next card. We drop any boundary that
//   (a) starts on a left-binding combining mark (incl. ◌์), or
//   (b) starts on a consonant immediately followed by ◌์ — a garan cluster.
// Dropping (b)'s boundary keeps the cluster attached to the prior token (the
// segmenter still has a real boundary before it, e.g. before "เมน"), so the
// loanword stays whole. Sentinels (start 0, end == length) are never filtered.
function isValidThaiWordStart(fullText: string, index: number): boolean {
  if (index <= 0 || index >= fullText.length) return true;
  const ch = fullText[index];
  if (isThaiLeftBindingMark(ch)) return false; // (a)
  if (fullText[index + 1] === THAI_GARAN) return false; // (b) consonant + ◌์ garan cluster
  return true;
}

// Word-boundary positions of the FULL text, from the same segmenter that
// drives the word timeline — the single source of truth for where a cut is
// allowed. Tokenizing a truncated window instead is how "โมเดลธุ|รกิจ" cuts
// happened: Thai segmentation is context-dependent, so boundaries must come
// from the whole string, never a slice. Boundaries the segmenter places inside
// a Thai garan/combining cluster are dropped (see isValidThaiWordStart).
function wordBoundaries(fullText: string): number[] {
  const seg = thaiWordSegmenter();
  if (!seg) return [];
  // Loanwords ICU mis-splits (แอดมิน, แชตบอต, คอมเมนต์, …): drop any boundary that
  // lands INSIDE one and force boundaries at its edges, so the whole loanword
  // stays a single token. This feeds BOTH card-edge snapping (sentence/viral) and
  // the word timeline (tokenizeWords → MCP word-count + web split modes), closing
  // the gap where isValidThaiWordStart only re-glued garan clusters, not loanwords.
  const spans = loanwordSpans(fullText);
  const insideLoanword = (i: number) => spans.some((s) => i > s.start && i < s.end);
  const set = new Set<number>([0, fullText.length]);
  for (const tok of seg.segment(fullText)) {
    if (tok.index > 0 && isValidThaiWordStart(fullText, tok.index) && !insideLoanword(tok.index)) set.add(tok.index);
  }
  for (const s of spans) { if (s.start > 0) set.add(s.start); if (s.end < fullText.length) set.add(s.end); }
  return [...set].sort((a, b) => a - b);
}

// Best cut position in fullText within (from, hardMax]: prefer the last
// newline, then the last whitespace run (cut after it), then the last
// full-text word boundary in range, then hardMax. minCut avoids degenerate
// tiny chunks when a newline sits right at the start of the window.
function findCut(fullText: string, from: number, hardMax: number, minCut: number, boundaries: number[]): number {
  const window = fullText.slice(from, hardMax);

  const nl = window.lastIndexOf("\n");
  if (nl >= 0 && from + nl + 1 >= minCut) return from + nl + 1;

  let ws = -1;
  for (let i = window.length - 1; i >= 0; i--) {
    if (/\s/.test(window[i])) { ws = i; break; }
  }
  if (ws >= 0 && from + ws + 1 >= minCut) return from + ws + 1;

  let best = -1;
  for (const b of boundaries) {
    if (b > hardMax) break;
    if (b > from && b >= minCut) best = b;
  }
  if (best > from) return best;
  return hardMax;
}

// Split fullText into TTS chunks of ≤ maxChars, cutting at sentence/phrase
// boundaries. Invariant: chunks are contiguous, non-empty, and concatenate to
// exactly fullText.
export function splitScriptForTts(fullText: string, maxChars?: number): TtsScriptChunk[] {
  const limit = Math.max(1, maxChars ?? chooseChunkChars(fullText.length));
  const bounds = fullText.length > limit ? wordBoundaries(fullText) : [];
  const chunks: TtsScriptChunk[] = [];
  let pos = 0;
  while (pos < fullText.length) {
    let end: number;
    if (fullText.length - pos <= limit) {
      end = fullText.length;
    } else {
      const minCut = pos + Math.max(1, Math.floor(limit * 0.4));
      end = findCut(fullText, pos, pos + limit, minCut, bounds);
      if (end <= pos) end = Math.min(pos + limit, fullText.length);
    }
    chunks.push({ text: fullText.slice(pos, end), startChar: pos, endChar: end });
    pos = end;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Merging per-chunk results
// ---------------------------------------------------------------------------

// Gemini path: per-chunk durations come from PCM byte length (exact), so
// offsets are exact by arithmetic.
export function mergeSegmentTiming(parts: { text: string; durationMs: number }[]): TtsSegment[] {
  let offset = 0;
  return parts.map((p) => {
    const seg = { text: p.text, startMs: offset, durationMs: p.durationMs };
    offset += p.durationMs;
    return seg;
  });
}

// ElevenLabs path: offset chunk i by the REAL audio duration (ffprobe) of
// chunks 0..i-1, not by the alignment's trailing timestamp — the model
// occasionally clips trailing silence (VideoForge lesson, 02-tts.ts).
export function mergeCharAlignments(
  parts: { characters: string[]; startSec: number[]; endSec: number[] }[],
  partDurationsSec: number[],
): TtsCharAlignment {
  if (parts.length !== partDurationsSec.length) {
    throw new TtsTimingMismatchError(`mergeCharAlignments: ${parts.length} parts vs ${partDurationsSec.length} durations`);
  }
  const merged: TtsCharAlignment = { characters: [], startSec: [], endSec: [] };
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.characters.length !== p.startSec.length || p.characters.length !== p.endSec.length) {
      throw new TtsTimingMismatchError(`mergeCharAlignments: part ${i} array lengths differ`);
    }
    for (let c = 0; c < p.characters.length; c++) {
      merged.characters.push(p.characters[c]);
      merged.startSec.push(offset + p.startSec[c]);
      merged.endSec.push(offset + p.endSec[c]);
    }
    offset += partDurationsSec[i];
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Per-segment sanity guard (deterministic, no LLM)
// ---------------------------------------------------------------------------

// Flags segments whose speaking rate (non-space chars per second) falls
// outside ±tolerance of the median across all segments — the symptom of the
// API returning truncated or repeated audio for that chunk. Caller retries
// just those chunks. With <2 segments there is nothing to compare against.
export function charsPerSecGuard(
  segments: { text: string; durationMs: number }[],
  tolerance = 0.4,
): number[] {
  if (segments.length < 2) return [];
  const cps = segments.map((s) => {
    const chars = s.text.replace(/\s+/g, "").length;
    return chars / Math.max(s.durationMs, 1) * 1000;
  });
  const sorted = [...cps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median <= 0) return [];
  return cps
    .map((v, i) => (v < median * (1 - tolerance) || v > median * (1 + tolerance) ? i : -1))
    .filter((i) => i >= 0);
}

// ---------------------------------------------------------------------------
// Char clock: char index on fullText → milliseconds
// ---------------------------------------------------------------------------

interface CharClock {
  startOf(charIndex: number): number; // ms at which fullText[charIndex] starts
  endOf(charIndex: number): number;   // ms at which fullText[charIndex] ends
  totalMs: number;
}

// Gemini has no per-char timing, so within a segment we spread the segment's
// (exact) duration across its characters. A plain char-proportional split assumes
// a uniform speech rate and therefore MIS-times pause-heavy scripts: an ellipsis
// ("…" or "...") is only ~1-3 characters but the model actually pauses ~0.4-0.6s
// there, so every following card lands a beat early until the segment end
// re-anchors it ("off early, in sync by the end"). Give each ellipsis extra
// weight so the clock advances over the pause. Scripts with no ellipsis are
// byte-for-byte unchanged (all weights are 1), and ElevenLabs (real per-char
// timing) never reaches this branch. Tunable via TTS_PAUSE_WEIGHT (0 = legacy).
function ellipsisPauseWeight(): number {
  const raw = Number(process.env.TTS_PAUSE_WEIGHT);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5;
}

// Per-char weight within a segment: whitespace 0, normal char 1, plus a one-time
// pause bonus on the last char of each ellipsis run ("…" or a run of 2+ ".").
function segmentCharWeights(text: string, pauseWeight: number): Float64Array {
  const w = new Float64Array(text.length);
  for (let i = 0; i < text.length; i++) w[i] = /\s/.test(text[i]) ? 0 : 1;
  if (pauseWeight > 0) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "…") {
        w[i] += pauseWeight;
      } else if (text[i] === "." && (i + 1 >= text.length || text[i + 1] !== ".")) {
        // end of a "." run — runs of 2+ dots are an ellipsis pause
        let n = 0;
        for (let j = i; j >= 0 && text[j] === "."; j--) n++;
        if (n >= 2) w[i] += pauseWeight;
      }
    }
  }
  return w;
}

// Spaces get zero duration: within a segment, time is distributed over
// non-space chars only (same weighting the transcribe interpolator uses),
// with extra weight at ellipsis pauses (see ellipsisPauseWeight).
function buildCharClock(timing: TtsTiming, fullText: string): CharClock {
  if (timing.provider === "elevenlabs" && timing.chars) {
    const { characters, startSec, endSec } = timing.chars;
    if (characters.join("") !== fullText) {
      throw new TtsTimingMismatchError(
        `elevenlabs alignment text (${characters.length} chars) != fullText (${fullText.length} chars)`,
      );
    }
    const totalMs = endSec.length ? endSec[endSec.length - 1] * 1000 : 0;
    return {
      startOf: (i) => startSec[Math.min(i, startSec.length - 1)] * 1000,
      endOf: (i) => endSec[Math.min(i, endSec.length - 1)] * 1000,
      totalMs,
    };
  }

  const joined = timing.segments.map((s) => s.text).join("");
  if (joined !== fullText) {
    throw new TtsTimingMismatchError(
      `segment texts (${joined.length} chars) != fullText (${fullText.length} chars)`,
    );
  }

  // startMsAt[i] = time at the boundary BEFORE char i; length fullText.length+1
  const startMsAt = new Float64Array(fullText.length + 1);
  const pauseWeight = ellipsisPauseWeight();
  let charBase = 0;
  let totalMs = 0;
  for (const seg of timing.segments) {
    const w = segmentCharWeights(seg.text, pauseWeight);
    let weightTotal = 0;
    for (let i = 0; i < w.length; i++) weightTotal += w[i];
    let weightSeen = 0;
    for (let i = 0; i < seg.text.length; i++) {
      startMsAt[charBase + i] = seg.startMs + (weightTotal > 0 ? (weightSeen / weightTotal) * seg.durationMs : 0);
      weightSeen += w[i];
    }
    charBase += seg.text.length;
    totalMs = Math.max(totalMs, seg.startMs + seg.durationMs);
  }
  startMsAt[fullText.length] = totalMs;
  return {
    startOf: (i) => startMsAt[Math.max(0, Math.min(i, fullText.length))],
    endOf: (i) => startMsAt[Math.max(0, Math.min(i + 1, fullText.length))],
    totalMs,
  };
}

// ---------------------------------------------------------------------------
// Words + captions
// ---------------------------------------------------------------------------

function enforceMonotonic<T extends { startMs: number; endMs: number }>(items: T[], totalMs: number): T[] {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    it.startMs = Math.round(it.startMs);
    it.endMs = Math.round(it.endMs);
    if (i > 0 && it.startMs < items[i - 1].endMs) it.startMs = items[i - 1].endMs;
    if (it.endMs <= it.startMs) it.endMs = it.startMs + 1;
  }
  if (items.length > 0 && totalMs > 0) {
    const last = items[items.length - 1];
    if (last.endMs > totalMs) last.endMs = Math.max(last.startMs + 1, Math.round(totalMs));
  }
  return items;
}

// Word tokens with char ranges on fullText (Thai-aware; falls back to
// whitespace splitting when Intl.Segmenter is unavailable).
export function tokenizeWords(fullText: string): { word: string; startChar: number; endChar: number }[] {
  const out: { word: string; startChar: number; endChar: number }[] = [];
  // Derive word tokens from the loanword-aware boundary set (single source of
  // truth) instead of raw Intl.Segmenter tokens — so loanwords ICU mis-splits
  // stay whole here too, not just at card edges. Each segment is whitespace-
  // trimmed (offsets kept exact) and punctuation-only segments are dropped.
  const bounds = wordBoundaries(fullText); // [] when Intl.Segmenter is unavailable
  if (bounds.length >= 2) {
    for (let i = 0; i < bounds.length - 1; i++) {
      let s = bounds[i];
      let e = bounds[i + 1];
      while (s < e && /\s/.test(fullText[s])) s++;
      while (e > s && /\s/.test(fullText[e - 1])) e--;
      if (e <= s) continue;
      const word = fullText.slice(s, e);
      if (!/[\p{L}\p{N}]/u.test(word)) continue; // skip punctuation/whitespace-only segments
      out.push({ word, startChar: s, endChar: e });
    }
    if (out.length > 0) return out;
  }
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fullText)) !== null) {
    out.push({ word: m[0], startChar: m.index, endChar: m.index + m[0].length });
  }
  return out;
}

export function buildWordsFromTiming(timing: TtsTiming, fullText: string): TimedWord[] {
  const clock = buildCharClock(timing, fullText);
  const words = tokenizeWords(fullText).map((t) => ({
    word: t.word,
    startMs: clock.startOf(t.startChar),
    endMs: clock.endOf(t.endChar - 1),
    startChar: t.startChar,
    endChar: t.endChar,
  }));
  return enforceMonotonic(words, clock.totalMs);
}

// cards = orderly char ranges on fullText (from sentence splitting now, the
// LLM split-script route later). Returns the same shape the editor's
// transcribe pipeline feeds into setCaptions.
export function buildCaptionsFromCards(cards: ScriptCard[], timing: TtsTiming, fullText: string): TimedCaption[] {
  const clock = buildCharClock(timing, fullText);
  const caps: TimedCaption[] = [];
  for (const card of cards) {
    const raw = fullText.slice(card.startChar, card.endChar);
    const text = raw.trim();
    if (!text) continue;
    // Time the trimmed content, not the surrounding whitespace.
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    const firstChar = card.startChar + lead;
    const lastChar = card.endChar - trail - 1;
    caps.push({
      text,
      startMs: clock.startOf(firstChar),
      endMs: clock.endOf(lastChar),
      tag: card.tag ?? (caps.length === 0 ? "hook" : "body"),
    });
  }
  return enforceMonotonic(caps, clock.totalMs);
}

// Deterministic sentence/line card splitting (plan §6 phase 1) — same boundary
// rules as the TTS chunker, smaller targets. Cards cover all of fullText.
export function splitSentenceCards(fullText: string, maxCardChars = 60): ScriptCard[] {
  return splitScriptForTts(fullText, maxCardChars).map((c) => ({ startChar: c.startChar, endChar: c.endChar }));
}

// ---------------------------------------------------------------------------
// LLM card mapping + silence snapping (PR-E polish)
// ---------------------------------------------------------------------------

export interface CardPiece { text: string; tag?: CaptionTag }

// Map LLM-cut card texts back onto fullText as exact char ranges.
// Whitespace-insensitive on the pieces (LLMs reflow spaces/newlines freely)
// but every visible char must match fullText in order — any edit, skip, or
// invention → null, and the caller falls back to sentence cards. This is what
// lets the LLM choose WHERE to cut without ever being able to change WHAT the
// subtitles say.
export function mapCardTextsToRanges(fullText: string, pieces: CardPiece[]): ScriptCard[] | null {
  if (!Array.isArray(pieces) || pieces.length === 0) return null;
  const cards: ScriptCard[] = [];
  let pos = 0;
  for (const piece of pieces) {
    if (typeof piece?.text !== "string") return null;
    const visible = Array.from(piece.text).filter((c) => !/\s/.test(c));
    if (visible.length === 0) continue;
    while (pos < fullText.length && /\s/.test(fullText[pos])) pos++;
    const startChar = pos;
    for (const ch of visible) {
      while (pos < fullText.length && /\s/.test(fullText[pos])) pos++;
      if (pos >= fullText.length || fullText[pos] !== ch) return null;
      pos++;
    }
    const card: ScriptCard = { startChar, endChar: pos };
    if (piece.tag === "hook" || piece.tag === "body" || piece.tag === "cta") card.tag = piece.tag;
    cards.push(card);
  }
  // the pieces must cover every visible char of fullText (กฎ 6: ห้ามข้าม)
  while (pos < fullText.length && /\s/.test(fullText[pos])) pos++;
  if (pos !== fullText.length) return null;
  return cards.length > 0 ? cards : null;
}

// Whitespace-insensitive match of one piece's visible chars at fullText[pos…].
// Returns the end position (exclusive) on full match, or -1 with mismatch info.
function matchPieceAt(
  fullText: string,
  pos: number,
  pieceText: string,
): { ok: true; end: number } | { ok: false; expected: string; got: string; at: number } {
  let p = pos;
  for (const ch of Array.from(pieceText).filter((c) => !/\s/.test(c))) {
    while (p < fullText.length && /\s/.test(fullText[p])) p++;
    if (p >= fullText.length || fullText[p] !== ch) {
      return { ok: false, expected: fullText[p] ?? "<EOF>", got: ch, at: p };
    }
    p++;
  }
  return { ok: true, end: p };
}

export interface TolerantCardsResult {
  cards: ScriptCard[];
  accepted: number;
  rejected: number;
  firstMismatch: string | null;
}

// Partial-acceptance variant of mapCardTextsToRanges: pieces that reproduce
// the script verbatim become viral cards; a piece that deviates (LLMs love to
// normalize curly quotes, em dashes, list numbering, ๆ spacing) is dropped and
// only ITS span falls back to sentence cards — instead of one bad card
// rejecting the whole clip. The iron rule is unchanged: every accepted card is
// still a verbatim slice, and gaps are covered so no text is ever lost.
export function mapCardTextsToRangesTolerant(
  fullText: string,
  pieces: CardPiece[],
  maxCardChars: number,
): TolerantCardsResult | null {
  if (!Array.isArray(pieces) || pieces.length === 0) return null;
  const clean = pieces.filter((p) => typeof p?.text === "string" && Array.from(p.text).some((c) => !/\s/.test(c)));
  if (clean.length === 0) return null;

  const cards: ScriptCard[] = [];
  let accepted = 0;
  let rejected = 0;
  let firstMismatch: string | null = null;

  const skipWs = (p: number) => {
    while (p < fullText.length && /\s/.test(fullText[p])) p++;
    return p;
  };

  // Search ahead (bounded) for a position where this piece matches in full.
  const findAhead = (fromPos: number, pieceText: string): number => {
    const firstVisible = Array.from(pieceText).find((c) => !/\s/.test(c));
    if (!firstVisible) return -1;
    let scanned = 0;
    for (let p = skipWs(fromPos); p < fullText.length && scanned < 800; p = skipWs(p + 1), scanned++) {
      if (fullText[p] !== firstVisible) continue;
      if (matchPieceAt(fullText, p, pieceText).ok) return p;
    }
    return -1;
  };

  const fillGapWithSentences = (from: number, to: number) => {
    if (fullText.slice(from, to).trim().length === 0) return;
    for (const c of splitSentenceCards(fullText.slice(from, to), maxCardChars)) {
      cards.push({ startChar: c.startChar + from, endChar: c.endChar + from });
    }
  };

  let pos = 0;
  let i = 0;
  while (i < clean.length) {
    const start = skipWs(pos);
    const m = matchPieceAt(fullText, start, clean[i].text);
    if (m.ok) {
      const card: ScriptCard = { startChar: start, endChar: m.end };
      const tag = clean[i].tag;
      if (tag === "hook" || tag === "body" || tag === "cta") card.tag = tag;
      cards.push(card);
      accepted++;
      pos = m.end;
      i++;
      continue;
    }

    if (!firstMismatch) {
      const ctx = fullText.slice(Math.max(0, m.at - 12), m.at + 12).replace(/\n/g, " ");
      firstMismatch = `piece ${i + 1}/${clean.length} "${clean[i].text.slice(0, 30)}…" expected "${m.expected}" got "${m.got}" near "…${ctx}…"`;
    }

    // resync: find the next piece that matches somewhere ahead; everything
    // between pos and that point becomes sentence cards
    let resyncPiece = -1;
    let resyncPos = -1;
    for (let j = i + 1; j < Math.min(i + 5, clean.length); j++) {
      const q = findAhead(start, clean[j].text);
      if (q >= 0) { resyncPiece = j; resyncPos = q; break; }
    }
    if (resyncPiece === -1) {
      rejected += clean.length - i;
      fillGapWithSentences(start, fullText.length);
      pos = fullText.length;
      break;
    }
    rejected += resyncPiece - i;
    fillGapWithSentences(start, resyncPos);
    pos = resyncPos;
    i = resyncPiece;
  }

  // leftover tail the pieces never covered (e.g. LLM stopped early)
  if (skipWs(pos) < fullText.length) fillGapWithSentences(skipWs(pos), fullText.length);

  if (accepted === 0) return null;
  return { cards, accepted, rejected, firstMismatch };
}

// Snap card edges to real word boundaries of fullText — the guarantee that no
// card can ever split a Thai word ("ธุรกิจ" → "ธุ" | "รกิจ"), regardless of
// where the cards came from (LLM viral cuts, sentence splitter, anything
// future). Cards are normalized to contiguous coverage first (gaps between
// validated cards are whitespace-only), then each interior edge moves to the
// nearest allowed boundary; a card that collapses donates its range to its
// neighbor, so total coverage — and the iron rule — are preserved exactly.
export function snapCardsToWordBoundaries(cards: ScriptCard[], fullText: string): ScriptCard[] {
  if (cards.length === 0) return cards;
  const bounds = wordBoundaries(fullText);
  if (bounds.length === 0) return cards;

  const startPos = cards[0].startChar;
  const endPos = cards[cards.length - 1].endChar;
  const snap = (p: number): number => {
    let best = p;
    let bestDist = Infinity;
    for (const b of bounds) {
      const d = Math.abs(b - p);
      if (d < bestDist) { bestDist = d; best = b; }
      if (b > p && d > bestDist) break;
    }
    return best;
  };

  // interior shared edges (card i's end == card i+1's start after
  // contiguous normalization), snapped then clamped monotonic
  let prev = startPos;
  const edges = cards.slice(0, -1).map((c) => {
    const v = Math.min(Math.max(snap(c.endChar), prev), endPos);
    prev = v;
    return v;
  });

  const out: ScriptCard[] = [];
  let s = startPos;
  for (let i = 0; i < cards.length; i++) {
    const e = i < edges.length ? edges[i] : endPos;
    if (fullText.slice(s, e).trim().length > 0) {
      const card: ScriptCard = { startChar: s, endChar: e };
      if (cards[i].tag) card.tag = cards[i].tag;
      out.push(card);
    } else if (out.length > 0) {
      out[out.length - 1].endChar = e; // collapsed card donates its range backwards
    }
    s = e;
  }
  return out.length > 0 ? out : cards;
}

// Snap shared card boundaries into real pauses. Only boundaries BETWEEN cards
// move (start of first / end of last stay put), each by at most maxSnapMs, and
// never so far that a card drops below minCardMs.
//
// target "onset" (default, 2026-06-17 fix): snap to the pause END — the previous
// caption holds through the whole pause and the next caption appears exactly when
// its speech resumes. target "midpoint" (legacy rollback): snap to the pause
// centre, which made the next caption appear ~0.15–0.5s before its speech.
//
// Accepts SilenceInterval[]; an old timing that only has midpoints can pass
// degenerate intervals {startMs:m, endMs:m} → both targets collapse to the
// midpoint, i.e. exactly the legacy behaviour (graceful back-compat).
export function snapCaptionsToSilences<T extends { startMs: number; endMs: number }>(
  captions: T[],
  silences: SilenceInterval[],
  opts: { target?: "onset" | "midpoint"; maxSnapMs?: number; minCardMs?: number } = {},
): T[] {
  const target = opts.target ?? "onset";
  const maxSnapMs = opts.maxSnapMs ?? 1500;
  const minCardMs = opts.minCardMs ?? 240;
  if (captions.length < 2 || silences.length === 0) return captions;
  const sil = [...silences].sort((a, b) => a.startMs - b.startMs);
  const pointOf = (s: SilenceInterval) => (target === "onset" ? s.endMs : (s.startMs + s.endMs) / 2);
  for (let i = 0; i < captions.length - 1; i++) {
    const a = captions[i];
    const b = captions[i + 1];
    const boundary = (a.endMs + b.startMs) / 2;
    let bestPoint = NaN;
    let bestDist = Infinity;
    for (const s of sil) {
      const p = pointOf(s);
      const d = Math.abs(p - boundary);
      if (d < bestDist) { bestDist = d; bestPoint = p; }
    }
    if (!Number.isFinite(bestPoint) || bestDist > maxSnapMs) continue;
    const snapTo = Math.round(bestPoint);
    if (snapTo - a.startMs < minCardMs) continue; // would crush card i
    if (b.endMs - snapTo < minCardMs) continue;   // would crush card i+1
    a.endMs = snapTo;
    b.startMs = snapTo;
  }
  return captions;
}

// Merge any caption shown for less than minMs into the PREVIOUS caption (combine
// text + extend its end) so a fast / over-split phrase isn't flashed on screen
// too briefly to read ("ขึ้นแว้บ–หายก่อนพูดจบ"). The first caption never merges
// backward and the previous caption keeps its tag. minMs <= 0 is a no-op.
//
// Pause-aware: a short caption that BEGINS at a real pause starts a new speech
// run, so it is NOT merged back across the pause (that would re-join what
// splitCardsAtSilences deliberately split). Pass the silence intervals to enable
// this; omit them to merge purely by duration.
//
// Used ONLY on the sentence/viral caption track (after snapCaptionsToSilences).
// The per-word timeline that feeds word-count modes (cardsByWordCount) is built
// separately by buildWordsFromTiming and never passes through here, so "1 word /
// card" modes keep every card.
export function mergeShortCaptions<T extends { text: string; startMs: number; endMs: number }>(
  captions: T[],
  minMs: number,
  silences: SilenceInterval[] = [],
): T[] {
  if (minMs <= 0 || captions.length < 2) return captions;
  const atPause = (t: number) => silences.some((s) => t >= s.startMs - 60 && t <= s.endMs + 60);
  const out: T[] = [];
  for (const c of captions) {
    const prev = out[out.length - 1];
    if (prev && c.endMs - c.startMs < minMs && !atPause(c.startMs)) {
      prev.endMs = c.endMs;
      prev.text = `${prev.text} ${c.text}`.trim();
    } else {
      out.push({ ...c });
    }
  }
  return out;
}

// Split any card whose char range STRADDLES a real pause, inserting a boundary
// at the word that ends nearest the pause — so every detected pause becomes a
// card edge. Without this a long card straddles a pause (e.g. a real 0.6s gap
// mid-card): snapCaptionsToSilences can't move a boundary that isn't there, the
// card drifts across the gap, and the next card lands late. The split point is a
// word boundary (word.endChar) so a Thai word is never cut. Cards with no
// straddled pause are returned unchanged. Gemini-only (ElevenLabs char timing
// already sits on the real pauses).
export function splitCardsAtSilences(
  cards: ScriptCard[],
  words: TimedWord[],
  silences: SilenceInterval[],
  tolMs = 600,
): ScriptCard[] {
  if (cards.length === 0 || words.length === 0 || silences.length === 0) return cards;
  // candidate split positions = end of the word spoken just before each pause
  const splitChars = new Set<number>();
  for (const s of silences) {
    let best: TimedWord | null = null;
    let bestDist = Infinity;
    for (const w of words) {
      const d = Math.abs(w.endMs - s.startMs);
      if (d < bestDist) { bestDist = d; best = w; }
    }
    if (best && bestDist <= tolMs) splitChars.add(best.endChar);
  }
  if (splitChars.size === 0) return cards;
  const out: ScriptCard[] = [];
  for (const c of cards) {
    const inside = [...splitChars].filter((p) => p > c.startChar && p < c.endChar).sort((a, b) => a - b);
    if (inside.length === 0) { out.push(c); continue; }
    let s = c.startChar;
    for (const p of inside) {
      const piece: ScriptCard = { startChar: s, endChar: p };
      if (s === c.startChar && c.tag) piece.tag = c.tag; // only the first piece keeps the tag
      out.push(piece);
      s = p;
    }
    out.push({ startChar: s, endChar: c.endChar });
  }
  return out;
}

// ---------------------------------------------------------------------------
// PCM math (Gemini returns s16le PCM; duration is exact from byte length)
// ---------------------------------------------------------------------------

export function pcmDurationMs(byteLength: number, sampleRate: number, channels = 1, bytesPerSample = 2): number {
  if (sampleRate <= 0 || channels <= 0 || bytesPerSample <= 0) return 0;
  return (byteLength / (sampleRate * channels * bytesPerSample)) * 1000;
}
