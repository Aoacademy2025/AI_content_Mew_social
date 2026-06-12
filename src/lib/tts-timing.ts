// TTS-derived subtitle timing — pure helpers shared by the Gemini/ElevenLabs TTS
// routes (PR-B/PR-D) and the editor (PR-C). See docs/plan-tts-derived-subtitle-timing-2026-06-12.md
//
// Iron rule: every char index in this file refers to ONE string — the exact
// fullText sent to TTS. Chunks are contiguous slices of it (concat(chunks) ===
// fullText, no trim/re-join), so subtitle text can never drift from the audio.

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

export interface TtsTiming {
  provider: "gemini" | "elevenlabs";
  segments: TtsSegment[];
  chars: TtsCharAlignment | null; // gemini has no char-level timing
  // Real-pause midpoints (ms) from ffmpeg silencedetect over the final audio.
  // Card boundaries snap to these on the Gemini line (PR-E); ElevenLabs char
  // timing is already ground truth and never needs it.
  silences?: number[] | null;
}

export interface TimedWord { word: string; startMs: number; endMs: number }

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

// Best cut position in fullText within (from, hardMax]: prefer the last
// newline, then the last whitespace run (cut after it), then a Segmenter word
// boundary, then hardMax. minCut avoids degenerate tiny chunks when a newline
// sits right at the start of the window.
function findCut(fullText: string, from: number, hardMax: number, minCut: number): number {
  const window = fullText.slice(from, hardMax);

  const nl = window.lastIndexOf("\n");
  if (nl >= 0 && from + nl + 1 >= minCut) return from + nl + 1;

  let ws = -1;
  for (let i = window.length - 1; i >= 0; i--) {
    if (/\s/.test(window[i])) { ws = i; break; }
  }
  if (ws >= 0 && from + ws + 1 >= minCut) return from + ws + 1;

  const seg = thaiWordSegmenter();
  if (seg) {
    let best = -1;
    for (const tok of seg.segment(window)) {
      if (tok.index > 0 && from + tok.index >= minCut && from + tok.index <= hardMax) {
        best = Math.max(best, from + tok.index);
      }
    }
    if (best > from) return best;
  }
  return hardMax;
}

// Split fullText into TTS chunks of ≤ maxChars, cutting at sentence/phrase
// boundaries. Invariant: chunks are contiguous, non-empty, and concatenate to
// exactly fullText.
export function splitScriptForTts(fullText: string, maxChars?: number): TtsScriptChunk[] {
  const limit = Math.max(1, maxChars ?? chooseChunkChars(fullText.length));
  const chunks: TtsScriptChunk[] = [];
  let pos = 0;
  while (pos < fullText.length) {
    let end: number;
    if (fullText.length - pos <= limit) {
      end = fullText.length;
    } else {
      const minCut = pos + Math.max(1, Math.floor(limit * 0.4));
      end = findCut(fullText, pos, pos + limit, minCut);
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

// Spaces get zero duration: within a segment, time is distributed over
// non-space chars only (same weighting the transcribe interpolator uses).
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
  let charBase = 0;
  let totalMs = 0;
  for (const seg of timing.segments) {
    const spokenTotal = seg.text.replace(/\s+/g, "").length;
    let spokenSeen = 0;
    for (let i = 0; i < seg.text.length; i++) {
      startMsAt[charBase + i] = seg.startMs + (spokenTotal > 0 ? (spokenSeen / spokenTotal) * seg.durationMs : 0);
      if (!/\s/.test(seg.text[i])) spokenSeen++;
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
function tokenizeWords(fullText: string): { word: string; startChar: number; endChar: number }[] {
  const seg = thaiWordSegmenter();
  const out: { word: string; startChar: number; endChar: number }[] = [];
  if (seg) {
    for (const tok of seg.segment(fullText)) {
      if (tok.isWordLike === false || tok.segment.trim().length === 0) continue;
      out.push({ word: tok.segment, startChar: tok.index, endChar: tok.index + tok.segment.length });
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

// Snap shared card boundaries into real pauses. Only boundaries BETWEEN cards
// move (start of first / end of last stay put), each by at most maxSnapMs,
// and never so far that a card drops below minCardMs.
export function snapCaptionsToSilences<T extends { startMs: number; endMs: number }>(
  captions: T[],
  silenceMidpointsMs: number[],
  maxSnapMs = 1500,
  minCardMs = 240,
): T[] {
  if (captions.length < 2 || silenceMidpointsMs.length === 0) return captions;
  const sil = [...silenceMidpointsMs].sort((a, b) => a - b);
  for (let i = 0; i < captions.length - 1; i++) {
    const a = captions[i];
    const b = captions[i + 1];
    const boundary = (a.endMs + b.startMs) / 2;
    let best = -1;
    let bestDist = Infinity;
    for (const m of sil) {
      const d = Math.abs(m - boundary);
      if (d < bestDist) { bestDist = d; best = m; }
    }
    if (best < 0 || bestDist > maxSnapMs) continue;
    if (best - a.startMs < minCardMs) continue; // would crush card i
    if (b.endMs - best < minCardMs) continue;   // would crush card i+1
    a.endMs = Math.round(best);
    b.startMs = Math.round(best);
  }
  return captions;
}

// ---------------------------------------------------------------------------
// PCM math (Gemini returns s16le PCM; duration is exact from byte length)
// ---------------------------------------------------------------------------

export function pcmDurationMs(byteLength: number, sampleRate: number, channels = 1, bytesPerSample = 2): number {
  if (sampleRate <= 0 || channels <= 0 || bytesPerSample <= 0) return 0;
  return (byteLength / (sampleRate * channels * bytesPerSample)) * 1000;
}
