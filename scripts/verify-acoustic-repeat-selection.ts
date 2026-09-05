import assert from "node:assert/strict";
import { selectAcousticSubtitleClock } from "../src/lib/acoustic-subtitle-selection";
import type { AcousticWorkerResult } from "../src/lib/acoustic-subtitle-worker";

const text = "ร้านเล็ก ๆ ก่อนเปิด";
const characters = [...text].flatMap((c, i) => /[\p{L}\p{M}]/u.test(c) && c !== "ๆ" ? [{
  startChar: i, endChar: i + 1, startMs: 1000 + i * 100, endMs: 1100 + i * 100, confidence: .99,
}] : []);
const result: AcousticWorkerResult = {
  evidence: { status: "partial", mode: "apply", applied: false, version: "thai-ctc-v1", modelRevision: "fixture", durationMs: 1 },
  clock: { version: "thai-ctc-v1", modelRevision: "fixture", audioHash: "fixture", textHash: "fixture", audioDurationMs: 4000, characters },
};
const select = (input = result, existingTimingSource = "forced_alignment") => selectAcousticSubtitleClock({ text,
  maxCardChars: 30, existingTimingSource, result: input });
const repaired = select();
assert(repaired.replacement, "a bounded repetition mark must not discard every verified Thai word boundary");
assert.equal(repaired.evidence.status, "partial", "interpolated repetition is still approximate");
assert.equal(repaired.evidence.applied, true);
assert.equal(repaired.replacement.words[0].startMs, 1000);
assert.equal(repaired.replacement.fullText, text);
assert.equal(select({ ...result, evidence: { ...result.evidence, mode: "shadow" } }).replacement, undefined);
assert.equal(select(result, "provider_alignment").replacement, undefined, "do not replace ElevenLabs provider alignment with partial timing");
assert.equal(select({ ...result, clock: { ...result.clock!, characters: characters.filter(c => c.startChar >= 4) } }).replacement,
  undefined, "an actual missing Thai word still preserves the existing complete alignment");
const longPause = { ...result, clock: { ...result.clock!, audioDurationMs: 8000,
  characters: characters.map(c => c.startChar > text.indexOf("ๆ") ? { ...c, startMs: c.startMs + 3000, endMs: c.endMs + 3000 } : c) } };
assert.equal(select(longPause).replacement, undefined, "a long unsupported pause is not a qualified repetition bridge");
console.log("acoustic repeat selection PASS: reliable islands, partial provenance, shadow, provider protection, missing words, pauses");
