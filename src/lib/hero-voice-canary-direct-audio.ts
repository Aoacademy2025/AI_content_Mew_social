import { heroVoiceCanarySha256 } from "@/lib/hero-voice-canary-canonical";
import { validatePcm16MonoWav } from "@/lib/hero-voice-clone-runners";
import type { HeroVoiceCanaryAdapterResult, HeroVoiceCanaryDirectAdapterResult } from "@/lib/hero-voice-canary-runner.server";

const MAX_AUDIO_BYTES = 7_000_000;
const MAX_BASE64_CHARACTERS = 4 * Math.ceil(MAX_AUDIO_BYTES / 3);

/** Audio is an IPC payload, never ledger metadata. A child assertion/hash alone
 * cannot make a direct slot valid: the parent must inspect the delivered bytes
 * and register them recoverably before recording completion. This checks the
 * delivered WAV, not the still-required worker/stage observation evidence. */
export function readHeroVoiceCanaryDirectAudio(result: HeroVoiceCanaryDirectAdapterResult): Buffer {
  const invalid = () => new Error("canary_direct_audio_invalid");
  if (result.outcome !== "valid_completed" || result.primaryStatus !== "completed"
    || typeof result.audioBase64 !== "string" || !result.audioBase64.length
    || result.audioBase64.length > MAX_BASE64_CHARACTERS || result.audioBase64.length % 4 !== 0) throw invalid();
  // Canonical roundtrip rejects whitespace, URL-safe spelling, bad padding and
  // nonzero pad bits without a repeated-group regexp exhausting the JS stack
  // on an otherwise valid maximum-sized WAV.
  const audio = Buffer.from(result.audioBase64, "base64");
  if (audio.length > MAX_AUDIO_BYTES || audio.toString("base64") !== result.audioBase64) throw invalid();
  const wav = validatePcm16MonoWav(audio, { sampleRate: 24_000 });
  if (!wav || wav.durationMs < 1 || result.audioSha256 !== heroVoiceCanarySha256(audio)
    || result.durationMs !== wav.durationMs) throw invalid();
  return audio;
}

/** Explicit allowlist: do not spread child results into durable ledger calls.
 * In particular, delivered audio and future raw observations must stay private. */
export function heroVoiceCanaryTerminalMetadata(result: HeroVoiceCanaryAdapterResult): HeroVoiceCanaryAdapterResult {
  const status = {
    outcome: result.outcome,
    primaryStatus: result.primaryStatus,
    ...(result.cancelDisposition !== undefined ? { cancelDisposition: result.cancelDisposition } : {}),
  };
  // Failure rows have null audio AND timing fields in the canonical ledger;
  // retain only the primary state and orthogonal cancellation disposition.
  if (result.outcome !== "valid_completed") return status;
  return {
    ...status,
    ...(result.audioSha256 !== undefined ? { audioSha256: result.audioSha256 } : {}),
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ...(result.delayTimeMs !== undefined ? { delayTimeMs: result.delayTimeMs } : {}),
    ...(result.executionTimeMs !== undefined ? { executionTimeMs: result.executionTimeMs } : {}),
  };
}
