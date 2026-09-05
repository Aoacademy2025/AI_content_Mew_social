import { heroVoiceCanaryJcsBytes, heroVoiceCanarySha256 } from "../../src/lib/hero-voice-canary-canonical";
import type { SignedHeroVoiceCanarySubmitCapability } from "../../src/lib/hero-voice-canary-admission.server";

/** Synthetic IPC fixture: never imports provider transports or stores audio. */
export function createHeroVoiceCanaryTask7Adapter() {
  return {
    async awaitDirectTerminal() {
      const wav = Buffer.alloc(7_000_000);
      wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(24_000, 24); wav.writeUInt32LE(48_000, 28); wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
      return {
        outcome: "valid_completed", primaryStatus: "completed", audioBase64: wav.toString("base64"),
        audioSha256: heroVoiceCanarySha256(wav), durationMs: Math.round((wav.length - 44) / 48),
        delayTimeMs: 0, executionTimeMs: 1,
      };
    },
    async dispatchDirect(slot: { slotId: string }) {
      switch (slot.slotId) {
        case "rejected": return { disposition: "provider_rejected" };
        case "unknown": return { disposition: "transport_unknown" };
        case "malformed": return { disposition: "provider_rejected", providerJobId: "unexpected" };
        case "hang": return new Promise(() => {});
        case "oversized": process.stdout.write("x".repeat(10_000_001)); return new Promise(() => {});
        case "invalid-json": process.stdout.write("not-json\n"); return new Promise(() => {});
        case "exit": process.exit(0);
        default: return { disposition: "provider_accepted", providerJobId: "synthetic-provider" };
      }
    },
    async submitCandidate(slot: { slotId: string }, signed: SignedHeroVoiceCanarySubmitCapability) {
      if (!Buffer.isBuffer(signed.capabilityBytes)
        || !signed.capabilityBytes.equals(heroVoiceCanaryJcsBytes(signed.capability))) throw new Error("synthetic_capability_mismatch");
      switch (slot.slotId) {
        case "rejected": return { disposition: "application_rejected" };
        case "unknown": return { disposition: "transport_unknown" };
        case "malformed": return { disposition: "application_accepted", applicationJobId: "../invalid" };
        default: return { disposition: "application_accepted", applicationJobId: "synthetic-application" };
      }
    },
  };
}
