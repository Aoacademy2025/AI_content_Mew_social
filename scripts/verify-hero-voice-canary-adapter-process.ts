import assert from "node:assert/strict";

import type { SignedHeroVoiceCanarySubmitCapability } from "../src/lib/hero-voice-canary-admission.server";
import type { HeroVoiceCanarySlot } from "../src/lib/hero-voice-canary-manifest";
import { heroVoiceCanaryJcsBytes } from "../src/lib/hero-voice-canary-canonical";
import { readHeroVoiceCanaryDirectAudio } from "../src/lib/hero-voice-canary-direct-audio";
import { HeroVoiceCanaryTask7AdapterProcess } from "../src/lib/hero-voice-canary-task7-adapter-process.server";

const slot = (slotId: string) => ({ slotId }) as HeroVoiceCanarySlot;
const capability: SignedHeroVoiceCanarySubmitCapability["capability"] = {
  version: 1, runId: "synthetic-run", slotId: "synthetic-slot", revision: 1,
  slotManifestSha256: "a".repeat(64), submitNonce: "b".repeat(22),
  issuedAtMs: 1, expiresAtMs: 300_001,
};
const signed: SignedHeroVoiceCanarySubmitCapability = {
  capability, capabilityBytes: heroVoiceCanaryJcsBytes(capability), submitHmac: "c".repeat(64),
};
const originalNodeEnv = process.env.NODE_ENV;
Object.assign(process.env, { NODE_ENV: "test" });

async function main() {
  const adapter = new HeroVoiceCanaryTask7AdapterProcess({
    modulePath: "scripts/fixtures/hero-voice-canary-protocol-adapter.ts", testOnly: true,
  });
  try {
    assert.deepEqual(await adapter.dispatchDirect(slot("accepted"), Buffer.from("{}")), {
      disposition: "provider_accepted", providerJobId: "synthetic-provider",
    });
    assert.deepEqual(await adapter.dispatchDirect(slot("rejected"), Buffer.from("{}")), {
      disposition: "provider_rejected",
    });
    assert.deepEqual(await adapter.dispatchDirect(slot("unknown"), Buffer.from("{}")), {
      disposition: "transport_unknown",
    });
    assert.deepEqual(await adapter.submitCandidate(slot("accepted"), signed), {
      disposition: "application_accepted", applicationJobId: "synthetic-application",
    });
    assert.deepEqual(await adapter.submitCandidate(slot("rejected"), signed), {
      disposition: "application_rejected",
    });
    assert.deepEqual(await adapter.submitCandidate(slot("unknown"), signed), {
      disposition: "transport_unknown",
    });
    assert.equal(readHeroVoiceCanaryDirectAudio(await adapter.awaitDirectTerminal(slot("maximum-audio"), "synthetic-provider")).length, 7_000_000);
    await assert.rejects(adapter.dispatchDirect(slot("malformed"), Buffer.from("{}")), /task7_adapter_result_invalid/);
    await assert.rejects(adapter.submitCandidate(slot("malformed"), signed), /task7_adapter_result_invalid/);
  } finally {
    await adapter.dispose();
  }
  for (const scenario of ["hang", "exit", "oversized", "invalid-json", "dispose", "concurrent"] as const) {
    const child = new HeroVoiceCanaryTask7AdapterProcess({
      modulePath: "scripts/fixtures/hero-voice-canary-protocol-adapter.ts", testOnly: true,
      timeoutMsForTests: 1_000,
    });
    try {
      await child.dispatchDirect(slot("accepted"), Buffer.from("{}"));
      const pending = child.dispatchDirect(slot(scenario === "dispose" || scenario === "concurrent" ? "hang" : scenario), Buffer.from("{}"));
      const failed = assert.rejects(pending, /task7_adapter_(?:process|protocol)/);
      if (scenario === "concurrent") {
        await assert.rejects(child.dispatchDirect(slot("accepted"), Buffer.from("{}")), /task7_adapter_process_busy/);
      }
      if (scenario === "dispose") await child.dispose();
      await failed;
      await assert.rejects(child.dispatchDirect(slot("accepted"), Buffer.from("{}")), /task7_adapter_process_closed/);
    } finally {
      await child.dispose();
    }
  }
  console.log("Hero Voice canary adapter IPC checks passed: dispositions, 7 MB WAV transfer, malformed/oversized frames, exit, timeout, disposal, one-in-flight (synthetic, no network)");
}

void main().catch(() => {
  console.error("Hero Voice canary adapter IPC verification failed");
  process.exitCode = 1;
}).finally(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else Object.assign(process.env, { NODE_ENV: originalNodeEnv });
});
