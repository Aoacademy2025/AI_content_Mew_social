// Bridge: TTS route `timing` response → editor captions + words (PR-C).
// Pure function over @/lib/tts-timing so video-editor/page.tsx only needs a
// few wiring lines — keeps the page diff tiny for parallel work on that file.

import {
  buildWordsFromTiming,
  buildCaptionsFromCards,
  splitSentenceCards,
  TtsTimingMismatchError,
  type TtsTiming,
  type TimedWord,
} from "@/lib/tts-timing";
import type { Caption } from "./types";

export interface TimingCaptionsResult {
  captions: Caption[];
  words: TimedWord[];
  audioDurationMs: number;
}

// Build editor captions + word timeline straight from a TTS response's
// `timing`. Returns null whenever the timing is missing or unusable — the
// caller then falls back to the transcribe path (fail-open), which is exactly
// the pre-PR-C behavior.
export function captionsFromTtsTiming(
  timing: TtsTiming | null | undefined,
  audioDurationMsHint: number,
  maxCardChars: number,
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
    const cards = splitSentenceCards(fullText, Math.max(10, maxCardChars));
    const caps = buildCaptionsFromCards(cards, timing, fullText);
    if (words.length === 0 || caps.length === 0) return null;

    const last = timing.segments[timing.segments.length - 1];
    const segTotalMs = Math.round(last.startMs + last.durationMs);
    const audioDurationMs =
      Number.isFinite(audioDurationMsHint) && audioDurationMsHint > 0 ? Math.round(audioDurationMsHint) : segTotalMs;

    return {
      captions: caps.map((c) => ({ text: c.text, startMs: c.startMs, endMs: c.endMs, tag: c.tag })),
      words,
      audioDurationMs,
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
