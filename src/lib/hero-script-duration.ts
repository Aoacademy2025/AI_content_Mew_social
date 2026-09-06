import { tokenizeWords } from "@/lib/tts-timing";

// Spoken writing budget, including natural pauses. The old 4 words/second
// target substantially overestimated Gemini's measured narration pace.
// Calibration and limitations: docs/audits/2026-09-06-hero-script-duration.md.
// This is an estimate for writing; only the generated audio gives real duration.
export const HERO_SCRIPT_WORDS_PER_SECOND = 3;
export const HERO_SCRIPT_DURATION_TOLERANCE = 0.1;

export function wordBudgetForDuration(durationSec: number): number {
  return Math.round(durationSec * HERO_SCRIPT_WORDS_PER_SECOND);
}

export function scriptWordRange(wordBudget: number): { min: number; max: number } {
  return {
    min: Math.ceil(wordBudget * (1 - HERO_SCRIPT_DURATION_TOLERANCE)),
    max: Math.floor(wordBudget * (1 + HERO_SCRIPT_DURATION_TOLERANCE)),
  };
}

export function assessScriptDuration(text: string, durationSec: number) {
  const words = tokenizeWords(text).length;
  const budget = wordBudgetForDuration(durationSec);
  const range = scriptWordRange(budget);
  return {
    words,
    budget,
    range,
    estimatedSec: words / HERO_SCRIPT_WORDS_PER_SECOND,
    targetSec: durationSec,
    withinTarget: words >= range.min && words <= range.max,
  };
}

export function scriptDurationWarning(assessment: ReturnType<typeof assessScriptDuration>): string | undefined {
  if (assessment.withinTarget) return undefined;
  return `สคริปต์นี้ประมาณ ${Math.round(assessment.estimatedSec)} วินาที ยัง${assessment.words > assessment.range.max ? "ยาว" : "สั้น"}กว่าเป้าหมาย ${assessment.targetSec} วินาที (±10%) ปรับเนื้อหาหรือเลือกความยาวใหม่ได้`;
}
