import { tokenizeWords } from "@/lib/tts-timing";

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

/** Compare the measured take without rounding the acceptance boundary. */
export function compareNarrationDuration(targetSec: unknown, audioDurationMs: number) {
  const target = scriptTargetDuration(targetSec);
  if (!target || !Number.isFinite(audioDurationMs) || audioDurationMs <= 0) return null;
  return {
    targetSec: target,
    actualSec: audioDurationMs / 1000,
    deltaSec: audioDurationMs / 1000 - target,
    withinTarget: audioDurationMs >= target * 900 && audioDurationMs <= target * 1100,
  };
}
