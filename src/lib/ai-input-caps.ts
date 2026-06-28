// ai-input-caps.ts — managed-Gemini cost guard (L4)
//
// Bounds the per-request blast radius of the Gemini text endpoints. A single
// authed request must not be able to smuggle an unbounded `script`, `scenes[]`,
// or `whisperWords[]` that amplifies into a large/looping server-key Gemini
// spend (extract-keywords batches scenes by 15 and re-embeds the full script in
// EACH batch, so an uncapped scenes[] = dozens-hundreds of calls per request).
//
// These are generous sanity bounds — well above any legitimate short-form video
// (a 10-min BUSINESS clip is ~600 captions / ~1.5k transcript words). The real
// cost bound is the monthly audio ceiling (ai-spend-limits) + rate-limit; this
// just stops one pathological request.

export const AI_INPUT_CAPS = {
  scriptChars: 12000,     // matches the existing per-route substring caps
  scenes: 1000,           // captions / subtitle lines / scenes array
  transcriptWords: 20000, // whisperWords array (align-scenes)
} as const;

export function checkAiInputCaps(input: {
  script?: string | null;
  scenes?: readonly unknown[] | null;
  words?: readonly unknown[] | null;
}): { ok: true } | { ok: false; message: string } {
  if (input.script != null && input.script.length > AI_INPUT_CAPS.scriptChars) {
    return { ok: false, message: `สคริปต์ยาวเกินกำหนด (สูงสุด ${AI_INPUT_CAPS.scriptChars.toLocaleString()} ตัวอักษร)` };
  }
  if (input.scenes != null && input.scenes.length > AI_INPUT_CAPS.scenes) {
    return { ok: false, message: `จำนวนฉาก/บรรทัดเกินกำหนด (สูงสุด ${AI_INPUT_CAPS.scenes.toLocaleString()})` };
  }
  if (input.words != null && input.words.length > AI_INPUT_CAPS.transcriptWords) {
    return { ok: false, message: `จำนวนคำในทรานสคริปต์เกินกำหนด (สูงสุด ${AI_INPUT_CAPS.transcriptWords.toLocaleString()})` };
  }
  return { ok: true };
}
