/** Synthetic IPC fixture: never imports provider transports or stores audio. */
export function createHeroVoiceCanaryTask7Adapter() {
  return {
    async dispatchDirect(slot: { slotId: string }) {
      switch (slot.slotId) {
        case "rejected": return { disposition: "provider_rejected" };
        case "unknown": return { disposition: "transport_unknown" };
        case "malformed": return { disposition: "provider_rejected", providerJobId: "unexpected" };
        case "hang": return new Promise(() => {});
        case "oversized": process.stdout.write("x".repeat(1_048_577)); return new Promise(() => {});
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
import { heroVoiceCanaryJcsBytes } from "../../src/lib/hero-voice-canary-canonical";
import type { SignedHeroVoiceCanarySubmitCapability } from "../../src/lib/hero-voice-canary-admission.server";
