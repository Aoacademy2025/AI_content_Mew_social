import type { SignedHeroVoiceCanarySubmitCapability } from "@/lib/hero-voice-canary-admission.server";
import { heroVoiceCanaryJcsBytes, parseHeroVoiceCanaryStrictJson } from "@/lib/hero-voice-canary-canonical";
import type { HeroVoiceCanarySlot } from "@/lib/hero-voice-canary-manifest";

const MAX_BODY_BYTES = 4_096;

async function readReply(response: Response, signal: AbortSignal): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length");
  if (response.status !== 202 || !response.body
    || (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES))) {
    void response.body?.cancel().catch(() => {});
    throw new Error("canary_loopback_submit_rejected");
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) throw new Error("canary_loopback_submit_response_invalid");
      chunks.push(Buffer.from(value));
    }
    if (length === 0) throw new Error("canary_loopback_submit_response_invalid");
    return Buffer.concat(chunks, length);
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Credential-bearing loopback client, with no runtime DB/auth/storage imports.
 * The isolated adapter can use it without importing the authority-owning runner.
 * No retry: even a malformed reply can follow a successfully received request. */
export async function submitHeroVoiceCanaryCandidateViaLoopback(input: {
  origin: string;
  attestation: string;
  cookieHeader: string;
  slot: HeroVoiceCanarySlot;
  signed: SignedHeroVoiceCanarySubmitCapability;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ disposition: "application_accepted"; applicationJobId: string }> {
  let origin: URL;
  try { origin = new URL(input.origin); } catch { throw new Error("canary_loopback_origin_invalid"); }
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port
    || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || input.slot.runnerKind !== "CandidateAiStudioV3") throw new Error("canary_loopback_origin_invalid");
  if (input.slot.slotId !== input.signed.capability.slotId
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{7,159}$/u.test(input.signed.capability.runId)
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{7,159}$/u.test(input.signed.capability.slotId)
    || !Buffer.isBuffer(input.signed.capabilityBytes)
    || !input.signed.capabilityBytes.equals(heroVoiceCanaryJcsBytes(input.signed.capability))
    || !/^[0-9a-f]{64}$/u.test(input.signed.submitHmac)) throw new Error("canary_loopback_capability_invalid");
  if (!input.attestation || input.attestation.length > MAX_BODY_BYTES || /[\r\n]/u.test(input.attestation)
    || !input.cookieHeader || input.cookieHeader.length > 16_384 || /[\r\n]/u.test(input.cookieHeader)) {
    throw new Error("canary_loopback_credentials_invalid");
  }
  const body = heroVoiceCanaryJcsBytes({ capability: input.signed.capability, submitHmac: input.signed.submitHmac });
  if (body.length > MAX_BODY_BYTES) throw new Error("canary_loopback_capability_invalid");
  const url = new URL(
    `/api/ai-studio/voice-clone-canary/runs/${encodeURIComponent(input.signed.capability.runId)}`
      + `/slots/${encodeURIComponent(input.signed.capability.slotId)}/submit`, origin,
  );
  const deadline = AbortSignal.timeout(20_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  let parsed: unknown;
  try {
    signal.throwIfAborted();
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST", redirect: "error", cache: "no-store", signal,
      headers: {
        "content-type": "application/json", "content-length": String(body.length),
        "x-hero-voice-canary-loopback-attestation": input.attestation, cookie: input.cookieHeader,
      },
      body: body.toString("utf8"),
    });
    parsed = parseHeroVoiceCanaryStrictJson(await readReply(response, signal));
  } catch {
    // Never retain provider bodies, fetch errors, cookies, or signed material.
    throw new Error("canary_loopback_submit_failed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).length !== 1 || !("job" in parsed)) throw new Error("canary_loopback_submit_response_invalid");
  const job = parsed.job;
  if (!job || typeof job !== "object" || Array.isArray(job)
    || Object.keys(job).sort().join(",") !== "id,status"
    || !("id" in job) || typeof job.id !== "string" || !/^[A-Za-z0-9_-]{8,160}$/u.test(job.id)
    || !("status" in job) || typeof job.status !== "string" || !/^[a-z_]{1,32}$/u.test(job.status)) {
    throw new Error("canary_loopback_submit_response_invalid");
  }
  return { disposition: "application_accepted", applicationJobId: job.id };
}
