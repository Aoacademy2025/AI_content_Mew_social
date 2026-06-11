// Estimate the spoken duration of a script BEFORE running (paid) TTS, so the
// duration-cap gate can fire *before* spending on ElevenLabs/HeyGen instead of
// only at the final render/burn.
//
// Rate is the team's calibrated natural-TTS pace, identical to the estimate used
// in the editor's runKeywords step: ~2 Thai chars/sec + ~3 English words/sec.
// Kept here as the single source so both stay in sync.
export function estimateScriptDurationSec(script: string): number {
  const thaiCharCount = (script.match(/[฀-๿]/g) ?? []).length;
  const englishWordCount = script.replace(/[฀-๿]/g, " ").split(/\s+/).filter(Boolean).length;
  return thaiCharCount / 2 + englishWordCount / 3;
}
