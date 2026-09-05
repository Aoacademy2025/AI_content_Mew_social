import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readHeroVoiceCanaryDirectAudio, heroVoiceCanaryTerminalMetadata } from "../src/lib/hero-voice-canary-direct-audio";

const wav = Buffer.alloc(92);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24_000, 24); wav.writeUInt32LE(48_000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(48, 40);
const result = {
  outcome: "valid_completed" as const, primaryStatus: "completed" as const,
  audioSha256: createHash("sha256").update(wav).digest("hex"), durationMs: 1,
  audioBase64: wav.toString("base64"), delayTimeMs: 0, executionTimeMs: 1,
};
assert.deepEqual(readHeroVoiceCanaryDirectAudio(result), wav);
const maximumWav = Buffer.alloc(7_000_000);
wav.copy(maximumWav, 0, 0, 44);
maximumWav.writeUInt32LE(maximumWav.length - 8, 4);
maximumWav.writeUInt32LE(maximumWav.length - 44, 40);
assert.equal(readHeroVoiceCanaryDirectAudio({ ...result,
  audioBase64: maximumWav.toString("base64"),
  audioSha256: createHash("sha256").update(maximumWav).digest("hex"),
  durationMs: Math.round(((maximumWav.length - 44) / 2) * 1_000 / 24_000),
}).length, maximumWav.length);
for (const mutation of [
  { audioBase64: undefined }, { audioBase64: result.audioBase64 + "\n" },
  { audioBase64: Buffer.from("not audio").toString("base64") },
  { audioBase64: "A".repeat(9_333_340) }, { audioSha256: "0".repeat(64) },
  { durationMs: 2 }, { primaryStatus: "failed" as const },
  { outcome: "accepted_outcome_unknown" as const },
]) assert.throws(() => readHeroVoiceCanaryDirectAudio({ ...result, ...mutation }), /canary_direct_audio_invalid/);
const badWav = Buffer.from(wav); badWav.writeUInt32LE(16_000, 24);
assert.throws(() => readHeroVoiceCanaryDirectAudio({ ...result,
  audioBase64: badWav.toString("base64"), audioSha256: createHash("sha256").update(badWav).digest("hex"),
}));
const metadata = heroVoiceCanaryTerminalMetadata({ ...result, unexpectedSecret: "synthetic-private-material" } as typeof result);
assert.equal("audioBase64" in metadata, false);
assert.equal("unexpectedSecret" in metadata, false);
assert.deepEqual(metadata, {
  outcome: "valid_completed", primaryStatus: "completed", audioSha256: result.audioSha256,
  durationMs: 1, delayTimeMs: 0, executionTimeMs: 1,
});
assert.deepEqual(heroVoiceCanaryTerminalMetadata({ ...result, outcome: "provider_terminal_failed", primaryStatus: "failed" }), {
  outcome: "provider_terminal_failed", primaryStatus: "failed",
});
assert.deepEqual(heroVoiceCanaryTerminalMetadata({ ...result, outcome: "application_validation_failed", cancelDisposition: "confirmed" }), {
  outcome: "application_validation_failed", primaryStatus: "completed", cancelDisposition: "confirmed",
});
console.log("Hero Voice canary direct-audio validation and ledger projection passed (synthetic)");
