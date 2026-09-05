import assert from "node:assert/strict";
import type { SignedHeroVoiceCanarySubmitCapability } from "../src/lib/hero-voice-canary-admission.server";
import { heroVoiceCanaryJcsBytes } from "../src/lib/hero-voice-canary-canonical";
import type { HeroVoiceCanarySlot } from "../src/lib/hero-voice-canary-manifest";
import { submitHeroVoiceCanaryCandidateViaLoopback } from "../src/lib/hero-voice-canary-loopback-transport";

const capability: SignedHeroVoiceCanarySubmitCapability["capability"] = {
  version: 1, runId: "synthetic-run", slotId: "synthetic-slot", revision: 1,
  slotManifestSha256: "a".repeat(64), submitNonce: "b".repeat(22), issuedAtMs: 1, expiresAtMs: 300_001,
};
const input = {
  origin: "http://127.0.0.1:43117", attestation: "synthetic-attestation", cookieHeader: "session=synthetic",
  slot: { slotId: capability.slotId, runnerKind: "CandidateAiStudioV3" } as HeroVoiceCanarySlot,
  signed: { capability, capabilityBytes: heroVoiceCanaryJcsBytes(capability), submitHmac: "c".repeat(64) },
};

async function main() {
  let calls = 0;
  const accepted = (async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, "error");
    return Response.json({ job: { id: "synthetic-application", status: "queued" } }, { status: 202 });
  }) as typeof fetch;
  assert.equal((await submitHeroVoiceCanaryCandidateViaLoopback({ ...input, fetchImpl: accepted })).applicationJobId, "synthetic-application");
  for (const origin of ["https://127.0.0.1:43117", "http://localhost:43117", "http://127.0.0.1:43117/path", "http://user:password@127.0.0.1:43117"]) {
    await assert.rejects(submitHeroVoiceCanaryCandidateViaLoopback({ ...input, origin, fetchImpl: accepted }));
  }
  await assert.rejects(submitHeroVoiceCanaryCandidateViaLoopback({ ...input,
    slot: { ...input.slot, slotId: "different-slot" }, fetchImpl: accepted,
  }));
  assert.equal(calls, 1, "invalid configuration must fail before sending credentials/capability");

  let cancelled = false;
  let pulled = 0;
  const tooLarge = new Response(new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(4_097));
      if (pulled > 3) controller.close();
    },
    cancel() { cancelled = true; },
  }), { status: 202 });
  await assert.rejects(submitHeroVoiceCanaryCandidateViaLoopback({ ...input,
    fetchImpl: (async () => tooLarge) as typeof fetch,
  }));
  assert.equal(cancelled, true, "oversized body must be cancelled while streaming");
  assert.ok(pulled < 4, "must not buffer the entire response before enforcing cap");

  const controller = new AbortController();
  let cancelledStalledBody = false;
  const stalled = new Response(new ReadableStream({
    start() { setTimeout(() => controller.abort(), 20); },
    cancel() { cancelledStalledBody = true; },
  }), { status: 202 });
  await assert.rejects(submitHeroVoiceCanaryCandidateViaLoopback({ ...input, signal: controller.signal,
    fetchImpl: (async () => stalled) as typeof fetch,
  }));
  assert.equal(cancelledStalledBody, true, "deadline must also bound a stalled response body");

  for (const response of [
    Response.json({ job: { id: "synthetic-application", status: "queued", extra: true } }, { status: 202 }),
    new Response('{"job":{"id":"synthetic-application","id":"duplicate","status":"queued"}}', { status: 202 }),
    Response.json({ job: { id: "../unsafe", status: "queued" } }, { status: 202 }),
    new Response("", { status: 202 }),
    new Response("ignored", { status: 302, headers: { location: "https://invalid.example" } }),
  ]) {
    await assert.rejects(submitHeroVoiceCanaryCandidateViaLoopback({ ...input,
      fetchImpl: (async () => response) as typeof fetch,
    }));
  }

  await assert.rejects(submitHeroVoiceCanaryCandidateViaLoopback({ ...input,
    fetchImpl: (async () => { throw new Error("synthetic-private-header"); }) as typeof fetch,
  }), (error: unknown) => error instanceof Error && !error.message.includes("synthetic-private-header"));
  console.log("Hero Voice canary loopback checks passed (synthetic, no network)");
}

void main().catch(() => { console.error("Hero Voice canary loopback verification failed"); process.exitCode = 1; });
