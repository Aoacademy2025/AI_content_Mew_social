import { randomUUID } from "node:crypto";
import type { Plan } from "@prisma/client";

import {
  parseHeroVoiceCanarySubmitCapabilityBytes,
} from "@/lib/hero-voice-canary-admission.server";
import {
  heroVoiceCanaryJcsBytes,
  heroVoiceCanarySha256,
  parseHeroVoiceCanaryStrictJson,
} from "@/lib/hero-voice-canary-canonical";
import { startHeroVoiceGeneration } from "@/lib/hero-voice-generation.server";
import {
  HERO_VOICE_CANARY_SCRIPTS,
  parseHeroVoiceCanaryManifest,
} from "@/lib/hero-voice-canary-manifest";
import { heroVoiceCloneCanaryAccessDecision } from "@/lib/omnivoice-policy";
import { prisma } from "@/lib/prisma";

const HEX64 = /^[0-9a-f]{64}$/u;

export type HeroVoiceCanarySubmitActor = Readonly<{
  id: string;
  plan: Plan;
  email?: string | null;
  role?: string | null;
  suspended?: boolean | null;
}>;

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/**
 * Server-only submission seam shared by the loopback HTTP route and the
 * executable runtime integration verifier. Authentication owns actor/ownerHmac
 * construction; this boundary rechecks policy and all owner/manifest bindings.
 */
export async function submitHeroVoiceCanarySlot(input: {
  actor: HeroVoiceCanarySubmitActor;
  ownerHmac: string;
  runId: string;
  slotId: string;
  capabilityBytes: Buffer;
  submitHmac: string;
}): Promise<Readonly<{ id: string; status: string }>> {
  if (!heroVoiceCloneCanaryAccessDecision(input.actor).allowed) {
    throw new Error("canary_submit_not_found");
  }
  const capability = parseHeroVoiceCanarySubmitCapabilityBytes(input.capabilityBytes);
  if (capability.runId !== input.runId || capability.slotId !== input.slotId) {
    throw new Error("canary_submit_not_found");
  }
  const run = await prisma.reviewRun.findFirst({
    where: { id: input.runId, ownerHmac: input.ownerHmac },
  });
  if (!run?.slotManifestJson || !run.slotManifestSha256 || !run.referenceVoiceId
    || heroVoiceCanarySha256(run.slotManifestJson) !== run.slotManifestSha256) {
    throw new Error("canary_submit_not_found");
  }
  let manifest;
  try {
    manifest = parseHeroVoiceCanaryManifest(
      parseHeroVoiceCanaryStrictJson(Buffer.from(run.slotManifestJson, "utf8")),
    );
  } catch {
    throw new Error("canary_submit_not_found");
  }
  const slot = manifest.slots.find((candidate) => candidate.slotId === input.slotId);
  const script = slot && HERO_VOICE_CANARY_SCRIPTS.find((candidate) => candidate.scriptId === slot.scriptId);
  if (!slot || !script || slot.runnerKind !== "CandidateAiStudioV3" || slot.phase !== "candidate"
    || slot.arm.seed === null || slot.matchedSettings.speed !== 1) {
    throw new Error("canary_submit_not_found");
  }

  const result = await startHeroVoiceGeneration({
    userId: input.actor.id,
    plan: input.actor.plan,
    text: script.sourceText,
    voiceId: run.referenceVoiceId,
    speed: slot.matchedSettings.speed,
    studio: true,
    cloneCanarySurface: "ai-studio",
    cloneSeed: slot.arm.seed,
    canaryAdmission: {
      ownerHmac: input.ownerHmac,
      capabilityBytes: input.capabilityBytes,
      submitHmac: input.submitHmac,
    },
    // Canary admission is the one-use identity. This random value only passes
    // the stock syntax guard and is never persisted or reused.
    idempotencyKey: `canary:${randomUUID()}`,
  });
  return Object.freeze({ id: result.job.id, status: result.job.status });
}

/** Exact authenticated body/path handler used by the Next route. Keeping it
 * server-only makes the real route protocol executable in the integration
 * verifier without weakening Clerk or loopback attestation in production. */
export async function submitHeroVoiceCanarySlotRequest(input: {
  actor: HeroVoiceCanarySubmitActor;
  ownerHmac: string;
  runId: string;
  slotId: string;
  requestBytes: Buffer;
}): Promise<Readonly<{ id: string; status: string }>> {
  if (input.requestBytes.length === 0 || input.requestBytes.length > 4_096) throw new Error("canary_submit_not_found");
  let parsed: unknown;
  try { parsed = parseHeroVoiceCanaryStrictJson(input.requestBytes); } catch { throw new Error("canary_submit_not_found"); }
  if (!exactObject(parsed, ["capability", "submitHmac"])
    || !heroVoiceCanaryJcsBytes(parsed).equals(input.requestBytes)
    || typeof parsed.submitHmac !== "string" || !HEX64.test(parsed.submitHmac)) {
    throw new Error("canary_submit_not_found");
  }
  const capabilityBytes = heroVoiceCanaryJcsBytes(parsed.capability);
  let capability;
  try { capability = parseHeroVoiceCanarySubmitCapabilityBytes(capabilityBytes); } catch { throw new Error("canary_submit_not_found"); }
  if (capability.runId !== input.runId || capability.slotId !== input.slotId) throw new Error("canary_submit_not_found");
  return submitHeroVoiceCanarySlot({
    actor: input.actor,
    ownerHmac: input.ownerHmac,
    runId: input.runId,
    slotId: input.slotId,
    capabilityBytes,
    submitHmac: parsed.submitHmac,
  });
}
