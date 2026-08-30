// Bridge: TTS route `timing` response → editor captions + words (PR-C).
// Pure function over @/lib/tts-timing so video-editor/page.tsx only needs a
// few wiring lines — keeps the page diff tiny for parallel work on that file.

import {
  buildWordsFromTiming,
  buildCaptionsFromCards,
  splitSentenceCards,
  snapCaptionsToSilences,
  mergeShortCaptions,
  snapCardsToWordBoundaries,
  tokenizeWords,
  TtsTimingMismatchError,
  type TtsTiming,
  type TimedWord,
  type ScriptCard,
  type SilenceInterval,
} from "@/lib/tts-timing";
import type { Caption } from "./types";

// Sentence/viral caption-track pause handling (2026-06-17 fix). Word-count modes
// use a separate path (cardsByWordCount) and are NOT touched by either knob.
//   SNAP_TARGET "onset"  → next caption appears when its speech resumes (was
//                          "midpoint", which showed it ~0.15–0.5s early).
//   MIN_CARD_MS          → merge captions shown shorter than this into the
//                          previous one so fast/over-split phrases don't flash
//                          (0 disables merge). Flip these to roll back — the web
//                          caption build runs client-side, so they're build-time
//                          constants (kept consistent web↔MCP), not runtime env.
const SNAP_TARGET: "onset" | "midpoint" = "onset";
const MIN_CARD_MS = 600;

export interface TimingCaptionsResult {
  captions: Caption[];
  words: TimedWord[];
  audioDurationMs: number;
  fullText: string; // the exact TTS-spoken text (timing.segments joined) — for slicing cards with original spacing
}

// LLM cards must be sane char ranges over fullText: ordered, non-overlapping,
// in bounds. Anything off → null → sentence cards.
function validCards(cards: ScriptCard[] | null | undefined, textLen: number): ScriptCard[] | null {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  let prevEnd = 0;
  for (const c of cards) {
    if (!Number.isInteger(c?.startChar) || !Number.isInteger(c?.endChar)) return null;
    if (c.startChar < prevEnd || c.endChar <= c.startChar || c.endChar > textLen) return null;
    prevEnd = c.endChar;
  }
  return cards;
}

// Build editor captions + word timeline straight from a TTS response's
// `timing`. Returns null whenever the timing is missing or unusable — the
// caller then falls back to the transcribe path (fail-open), which is exactly
// the pre-PR-C behavior.
export function captionsFromTtsTiming(
  timing: TtsTiming | null | undefined,
  audioDurationMsHint: number,
  maxCardChars: number,
  cardsOverride?: ScriptCard[] | null,
): TimingCaptionsResult | null {
  try {
    if (!timing || !Array.isArray(timing.segments) || timing.segments.length === 0) return null;
    for (const s of timing.segments) {
      if (typeof s.text !== "string" || !Number.isFinite(s.startMs) || !Number.isFinite(s.durationMs) || s.durationMs <= 0) {
        return null;
      }
    }

    // IRON RULE: subtitle text must be the exact string TTS spoke. Rebuild it
    // from the segments themselves — never from local script state (the route
    // trims its input before synthesis, so they can differ at the edges).
    const fullText = timing.segments.map((s) => s.text).join("");
    if (!fullText.trim()) return null;

    const words = buildWordsFromTiming(timing, fullText);
    // Viral cards from /api/videos/split-script when they validate against
    // fullText; deterministic sentence cards otherwise (PR-E §6 phase 2).
    // Either way, card edges are then forced onto real word boundaries — no
    // source is allowed to split a Thai word across two cards.
    const rawCards = validCards(cardsOverride, fullText.length)
      ?? splitSentenceCards(fullText, Math.max(10, maxCardChars));
    const cards = snapCardsToWordBoundaries(rawCards, fullText);

    // Gemini's intra-segment times are char-proportional, so card edges are
    // anchored to the REAL pauses (ffmpeg silencedetect). Drop the LEADING/
    // TRAILING silence (the quiet before the first / after the last word) so the
    // opening card never snaps onto the pre-speech gap and gets crushed to a
    // flash. ElevenLabs char timing already sits on the real pauses → leave alone.
    //
    // NOTE: splitting a straddling card at a pause (former splitCardsAtSilences,
    // #81) was REVERTED — it located the split via the char clock, which on a
    // pause-heavy/drifting clip is itself off, so it cut at the wrong word, over-
    // split (35→57 cards), and orphaned punctuation into their own cards, making
    // EVERY Gemini clip worse. Pause-accurate splitting needs real word timing
    // (ElevenLabs), not a guess from the drifted clock.
    let intervals: SilenceInterval[] = [];
    if (timing.provider === "gemini" || timing.provider === "omnivoice") {
      const segTotal = timing.segments.reduce((m, s) => Math.max(m, s.startMs + s.durationMs), 0);
      const raw: SilenceInterval[] =
        Array.isArray(timing.silenceIntervals) && timing.silenceIntervals.length > 0
          ? timing.silenceIntervals.filter((s) => Number.isFinite(s?.startMs) && Number.isFinite(s?.endMs))
          : Array.isArray(timing.silences)
            ? timing.silences.filter((s) => Number.isFinite(s)).map((m) => ({ startMs: m, endMs: m }))
            : [];
      intervals = raw.filter((s) => s.startMs > 150 && s.endMs < segTotal - 150);
    }

    let caps = buildCaptionsFromCards(cards, timing, fullText);
    if (words.length === 0 || caps.length === 0) return null;

    // Snap card boundaries to the speech ONSET of each real pause, then merge any
    // card too short to read — pause-aware so split runs aren't re-joined.
    if ((timing.provider === "gemini" || timing.provider === "omnivoice") && intervals.length > 0) {
      snapCaptionsToSilences(caps, intervals, { target: SNAP_TARGET });
      caps = mergeShortCaptions(caps, MIN_CARD_MS, intervals, fullText);
    }

    const last = timing.segments[timing.segments.length - 1];
    const segTotalMs = Math.round(last.startMs + last.durationMs);
    const audioDurationMs =
      Number.isFinite(audioDurationMsHint) && audioDurationMsHint > 0 ? Math.round(audioDurationMsHint) : segTotalMs;

    return {
      captions: caps.map((c) => ({ text: c.text, startMs: c.startMs, endMs: c.endMs, tag: c.tag })),
      words,
      audioDurationMs,
      fullText,
    };
  } catch (e) {
    if (e instanceof TtsTimingMismatchError) {
      console.warn("[tts-timing] timing/text mismatch — falling back to transcribe:", e.message);
    } else {
      console.warn("[tts-timing] failed to build captions from timing — falling back to transcribe:", e);
    }
    return null;
  }
}

/** Rung 3 of the subtitle timing ladder (ADR 0056): the fallback clock used when the TTS
 * provider returned no usable timing at all. Spreads the exact spoken script across the
 * measured audio duration, char-proportionally. Every caller must report it as
 * `avatar_script_clock` — it is an estimate, never measured timing. */
export function captionsFromSpokenScript(
  script: string,
  audioDurationMs: number,
  maxCardChars: number,
): TimingCaptionsResult | null {
  const fullText = script.normalize("NFC");
  if (!fullText.trim()) return null;
  const durationMs = Math.round(audioDurationMs);
  if (!Number.isFinite(durationMs) || durationMs < 400) return null;
  const cards = snapCardsToWordBoundaries(
    splitSentenceCards(fullText, Math.max(10, maxCardChars)),
    fullText,
  );
  if (cards.length === 0) return null;
  const weights = cards.map((card) => Math.max(1, card.endChar - card.startChar));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0;
  const captions = cards.map((card, index) => {
    const share = Math.max(240, Math.round((weights[index] / weightSum) * durationMs));
    const startMs = cursor;
    cursor = index === cards.length - 1 ? durationMs : Math.min(durationMs, cursor + share);
    return {
      text: fullText.slice(card.startChar, card.endChar).trim(),
      startMs,
      endMs: cursor,
      tag: (index === 0 ? "hook" : index === cards.length - 1 ? "cta" : "body") as Caption["tag"],
    };
  });
  if (captions.some((caption) => !caption.text)) return null;
  captions[captions.length - 1].endMs = durationMs;
  const tokens = tokenizeWords(fullText);
  const tokenWeight = tokens.reduce((sum, token) => sum + Math.max(1, token.endChar - token.startChar), 0) || 1;
  let wordCursor = 0;
  const words: TimedWord[] = tokens.map((token, index) => {
    const share = Math.max(80, Math.round((Math.max(1, token.endChar - token.startChar) / tokenWeight) * durationMs));
    const startMs = wordCursor;
    wordCursor = index === tokens.length - 1 ? durationMs : Math.min(durationMs, wordCursor + share);
    return { word: token.word, startMs, endMs: wordCursor, startChar: token.startChar, endChar: token.endChar };
  });
  return { captions, words, audioDurationMs: durationMs, fullText };
}
