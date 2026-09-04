import { heroVoiceCanarySha256 } from "@/lib/hero-voice-canary-canonical";
import {
  HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
  type HeroVoiceCanaryReferencePointer,
} from "@/lib/hero-voice-canary-manifest";
import {
  artifactSourcePath,
  heroVoiceCanaryStorageContext,
  readPrivateFileNoFollow,
} from "@/lib/hero-voice-canary-storage.server";

const HEX64 = /^[0-9a-f]{64}$/u;
const SOURCE_URI = /^private:\/\/user-voice\/([0-9A-Fa-f-]{36}\.wav)$/u;

function readUInt32(bytes: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error("canary_reference_wav_invalid");
  return bytes.readUInt32LE(offset);
}

/** Rejects every WAV shape except the canonical 10.000 s mono 24 kHz PCM16
 * reference contract. Unknown chunks are allowed but bounds/padding are exact. */
export function assertCanonicalHeroVoiceCanaryReferenceWav(bytes: Buffer): void {
  if (bytes.length < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF"
    || bytes.subarray(8, 12).toString("ascii") !== "WAVE"
    || readUInt32(bytes, 4) + 8 !== bytes.length) throw new Error("canary_reference_wav_invalid");
  let offset = 12;
  let formatSeen = false;
  let dataSeen = false;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = readUInt32(bytes, offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length) throw new Error("canary_reference_wav_invalid");
    if (id === "fmt ") {
      if (formatSeen || size !== 16 || bytes.readUInt16LE(start) !== 1
        || bytes.readUInt16LE(start + 2) !== 1 || bytes.readUInt32LE(start + 4) !== 24_000
        || bytes.readUInt32LE(start + 8) !== 48_000 || bytes.readUInt16LE(start + 12) !== 2
        || bytes.readUInt16LE(start + 14) !== 16) throw new Error("canary_reference_wav_invalid");
      formatSeen = true;
    } else if (id === "data") {
      if (dataSeen || size !== 480_000) throw new Error("canary_reference_wav_invalid");
      dataSeen = true;
    }
    offset = end + (size % 2);
  }
  if (offset !== bytes.length || !formatSeen || !dataSeen) throw new Error("canary_reference_wav_invalid");
}

export function loadHeroVoiceCanaryReference(input: {
  pointer: HeroVoiceCanaryReferencePointer;
  expectedSha256: string;
}): Readonly<{ wavBytes: Buffer; sha256: string; transcript: typeof HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT }> {
  if (!HEX64.test(input.expectedSha256) || input.pointer.referenceSha256 !== input.expectedSha256
    || input.pointer.transcript !== HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT || input.pointer.durationMs !== 10_000) {
    throw new Error("canary_reference_identity_invalid");
  }
  const matched = SOURCE_URI.exec(input.pointer.sourceUri);
  if (!matched) throw new Error("canary_reference_identity_invalid");
  const storage = heroVoiceCanaryStorageContext();
  const filename = artifactSourcePath(storage, "user_voice_reference", matched[1]);
  const wavBytes = readPrivateFileNoFollow(filename);
  const sha256 = heroVoiceCanarySha256(wavBytes);
  if (sha256 !== input.expectedSha256) throw new Error("canary_reference_identity_invalid");
  assertCanonicalHeroVoiceCanaryReferenceWav(wavBytes);
  return Object.freeze({ wavBytes, sha256, transcript: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT });
}
