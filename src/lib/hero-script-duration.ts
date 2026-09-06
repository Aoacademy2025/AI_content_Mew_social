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

/** Old/custom editor drafts need no inferred target. */
export function scriptTargetDuration(value: unknown): number | null {
  return value === 30 || value === 60 || value === 90 ? value : null;
}

/** Empirical envelopes from five fixed Thai scripts per voice, not confidence
 * intervals or a promise about future audio. Only these two voices were measured. */
const GEMINI_NARRATION_PACING: Record<string, { center: number; slow: number; fast: number }> = {
  Kore: { center: 3, slow: 2.9, fast: 3.5 },
  Aoede: { center: 2.8, slow: 2.5, fast: 3.5 },
};

export function narrationTargetFeedback(params: {
  text: string;
  targetSec: unknown;
  voiceEngine: string;
  voiceName: string;
}): { message: string; outsideTarget: boolean | null } | null {
  const target = scriptTargetDuration(params.targetSec);
  if (!target || !params.text.trim()) return null;
  const letters = params.text.match(/\p{L}/gu) ?? [];
  const thaiLetters = letters.filter((letter) => /[\u0E00-\u0E7F]/.test(letter)).length;
  const primarilyThai = letters.length > 0 && thaiLetters / letters.length >= 0.5;
  const pace = primarilyThai && params.voiceEngine === "gemini" && Object.hasOwn(GEMINI_NARRATION_PACING, params.voiceName)
    ? GEMINI_NARRATION_PACING[params.voiceName] : undefined;
  const targetLabel = `เป้าจากสคริปต์ ${target} วินาที (±10%)`;
  if (!pace) return {
    message: `${targetLabel} · ยังไม่มีค่าประมาณสำหรับข้อความและเสียงที่เลือก ความยาวจริงทราบหลังสร้างเสียง`,
    outsideTarget: null,
  };
  const words = tokenizeWords(params.text).length;
  const estimate = words / pace.center;
  const outsideTarget = estimate < target * 0.9 || estimate > target * 1.1;
  const action = outsideTarget ? "ค่าประมาณหลุดเป้า ปรับบทได้ก่อนสร้างเสียง" : "ตรวจจังหวะพูดและบทก่อนสร้างเสียง";
  return {
    message: `${targetLabel} · เสียง ${params.voiceName} ประมาณ ${Math.round(estimate)} วินาที ` +
      `(ช่วงประมาณ ${Math.floor(words / pace.fast)}–${Math.ceil(words / pace.slow)} วินาที) · ${action} ความยาวจริงทราบหลังสร้างเสียง`,
    outsideTarget,
  };
}
