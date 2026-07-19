// Pure contract checks for the OmniVoice app/worker boundary.
// Run: npm run verify:omnivoice

import fs from "node:fs";
import {
  createOmniVoiceAdmissionCounter,
  isOmniVoiceInfo,
  isValidOmniVoiceId,
  pcmFromWav,
  userInOmniVoiceAllowlist,
} from "../src/lib/omnivoice-core";
import { parseTtsProvider, resolveJobTtsProvider } from "../src/lib/tts-providers";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

function monoPcm16Wav(sampleRate = 24_000, pcm = Buffer.alloc(480)): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

check("allowlist: missing config fails closed", !userInOmniVoiceAllowlist("user_a", undefined));
check("allowlist: empty config fails closed", !userInOmniVoiceAllowlist("user_a", ""));
check("allowlist: exact canary user passes", userInOmniVoiceAllowlist("user_a", "user_b, user_a"));
check("allowlist: other user denied", !userInOmniVoiceAllowlist("user_c", "user_b,user_a"));
check("allowlist: global rollout requires explicit wildcard", userInOmniVoiceAllowlist("any_user", "*"));
check("provider rollback: saved OmniVoice default falls back to Gemini", resolveJobTtsProvider(undefined, "omnivoice") === "gemini");
check("provider parity: saved ElevenLabs default remains ElevenLabs", resolveJobTtsProvider(undefined, "elevenlabs") === "elevenlabs");
check("provider canary: explicit OmniVoice job remains explicit", resolveJobTtsProvider("omnivoice", "gemini") === "omnivoice");
check("draft: explicit OmniVoice selection is preserved while unavailable", parseTtsProvider("omnivoice") === "omnivoice");

const admission = createOmniVoiceAdmissionCounter(3);
const leases = [admission.tryAcquire(), admission.tryAcquire(), admission.tryAcquire()];
check("admission: allows worker active+pending envelope", leases.every(Boolean) && admission.inFlight() === 3);
check("admission: rejects requests beyond three in flight", admission.tryAcquire() === null);
leases[0]?.release();
check("admission: release opens one slot", admission.tryAcquire() !== null && admission.inFlight() === 3);

check("voice id: accepts worker identifiers", isValidOmniVoiceId("voice_01-A"));
check("voice id: rejects traversal", !isValidOmniVoiceId("../voice_01"));
check("voice id: rejects whitespace", !isValidOmniVoiceId("voice 01"));
check("voice id: enforces length", !isValidOmniVoiceId("v".repeat(65)));
check("voice payload: accepts required fields", isOmniVoiceInfo({
  voice_id: "voice_01", desc: "Thai voice", instruct: "calm", preview_url: "/preview",
}));
check("voice payload: rejects invalid id", !isOmniVoiceInfo({
  voice_id: "../../etc", desc: "bad", instruct: "bad", preview_url: "/preview",
}));

const pcm = Buffer.from([0, 0, 1, 0, 255, 255, 2, 0]);
const parsed = pcmFromWav(monoPcm16Wav(24_000, pcm));
check("wav parser: preserves PCM bytes", parsed.pcm.equals(pcm));
check("wav parser: preserves sample rate", parsed.sampleRate === 24_000);
check("wav parser: rejects non-WAV", throws(() => pcmFromWav(Buffer.from("not a wav"))));

const stereo = monoPcm16Wav();
stereo.writeUInt16LE(2, 22);
check("wav parser: rejects stereo worker output", throws(() => pcmFromWav(stereo)));
const truncated = monoPcm16Wav();
truncated.writeUInt32LE(truncated.length, 40);
check("wav parser: rejects truncated chunks", throws(() => pcmFromWav(truncated)));

const orchestratorSource = fs.readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
const jobsRouteSource = fs.readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
const omniRouteSource = fs.readFileSync("src/app/api/videos/tts-omnivoice/route.ts", "utf8");
const configSource = fs.readFileSync("src/lib/omnivoice.ts", "utf8");
const omniCall = orchestratorSource.slice(
  orchestratorSource.indexOf('"/api/videos/tts-omnivoice"'),
  orchestratorSource.indexOf('"/api/videos/tts-gemini"'),
);
check("orchestrator: OmniVoice synthesis explicitly disables retries", omniCall.includes("{ retries: 0 }"));
check("job admission: OmniVoice readiness is checked before enqueue", jobsRouteSource.includes("await checkOmniVoiceReady(config)"));
check("timing invariant: worker receives the exact chunk text", omniRouteSource.includes("chunks[index].text") && !omniRouteSource.includes("normalizeNumbersForTts"));
check("capacity: managed AI-audio reserve is enforced", omniRouteSource.includes("reserveAiAudioMinutes(user.id, estimatedMinutes, { enforce: true })"));
check("timeout: upstream budget leaves post-processing headroom", configSource.includes("250_000, 240_000"));

if (failures > 0) {
  console.error(`\n${failures} OmniVoice verification(s) failed.`);
  process.exit(1);
}
console.log("\nOmniVoice contract checks passed.");
