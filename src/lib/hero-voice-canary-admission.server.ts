import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";

import {
  decodeHeroVoiceCanaryReviewIkm,
  deriveHeroVoiceCanaryRunKey,
  heroVoiceCanaryHexMatches,
  heroVoiceCanaryHmacHex,
  heroVoiceCanaryJcsBytes,
  heroVoiceCanarySha256,
  parseHeroVoiceCanaryStrictJson,
} from "@/lib/hero-voice-canary-canonical";
import { parseHeroVoiceCanaryManifest, type HeroVoiceCanarySlot } from "@/lib/hero-voice-canary-manifest";
import { verifyHeroVoiceCanaryLedger } from "@/lib/hero-voice-canary-ledger.server";
import { runHeroVoiceCanarySerializedMutation } from "@/lib/hero-voice-deletion-coordinator.server";
import { prisma } from "@/lib/prisma";

const CAPABILITY_KEYS = [
  "expiresAtMs", "issuedAtMs", "revision", "runId", "slotId", "slotManifestSha256", "submitNonce", "version",
] as const;
const HEX64 = /^[0-9a-f]{64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{7,159}$/u;
const NONCE = /^[A-Za-z0-9_-]{22}$/u;
export const HERO_VOICE_CANARY_SUBMIT_TTL_MS = 300_000 as const;

export type HeroVoiceCanarySubmitCapability = Readonly<{
  version: 1;
  runId: string;
  slotId: string;
  revision: number;
  slotManifestSha256: string;
  submitNonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
}>;

export type SignedHeroVoiceCanarySubmitCapability = Readonly<{
  capability: HeroVoiceCanarySubmitCapability;
  capabilityBytes: Buffer;
  submitHmac: string;
}>;

export class HeroVoiceCanaryAdmissionError extends Error {
  constructor(readonly code = "CANARY_SUBMIT_NOT_FOUND", readonly status = 404) {
    super("Not found");
    this.name = "HeroVoiceCanaryAdmissionError";
  }
}

function reviewIkm(): Buffer {
  const encoded = process.env.HERO_VOICE_CANARY_REVIEW_KEY;
  if (!encoded) throw new HeroVoiceCanaryAdmissionError();
  try { return decodeHeroVoiceCanaryReviewIkm(encoded); } catch {
    throw new HeroVoiceCanaryAdmissionError();
  }
}

function submitKey(runId: string): Buffer {
  return deriveHeroVoiceCanaryRunKey(reviewIkm(), "submit", runId);
}

function exactCapability(value: unknown): HeroVoiceCanarySubmitCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HeroVoiceCanaryAdmissionError();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== CAPABILITY_KEYS.length
    || ![...CAPABILITY_KEYS].sort().every((key, index) => keys[index] === key)
    || record.version !== 1 || typeof record.runId !== "string" || !OPAQUE_ID.test(record.runId)
    || typeof record.slotId !== "string" || !OPAQUE_ID.test(record.slotId)
    || !Number.isSafeInteger(record.revision) || (record.revision as number) < 1
    || typeof record.slotManifestSha256 !== "string" || !HEX64.test(record.slotManifestSha256)
    || typeof record.submitNonce !== "string" || !NONCE.test(record.submitNonce)
    || !Number.isSafeInteger(record.issuedAtMs) || (record.issuedAtMs as number) < 1
    || !Number.isSafeInteger(record.expiresAtMs)
    || (record.expiresAtMs as number) !== (record.issuedAtMs as number) + HERO_VOICE_CANARY_SUBMIT_TTL_MS) {
    throw new HeroVoiceCanaryAdmissionError();
  }
  return record as HeroVoiceCanarySubmitCapability;
}

export function parseHeroVoiceCanarySubmitCapabilityBytes(bytes: Uint8Array): HeroVoiceCanarySubmitCapability {
  const source = Buffer.from(bytes);
  let parsed: unknown;
  try { parsed = parseHeroVoiceCanaryStrictJson(source); } catch {
    throw new HeroVoiceCanaryAdmissionError();
  }
  const capability = exactCapability(parsed);
  if (!heroVoiceCanaryJcsBytes(capability).equals(source)) throw new HeroVoiceCanaryAdmissionError();
  return capability;
}

function runManifest(run: { slotManifestJson: string | null; slotManifestSha256: string | null }) {
  if (!run.slotManifestJson || !run.slotManifestSha256
    || heroVoiceCanarySha256(run.slotManifestJson) !== run.slotManifestSha256) {
    throw new HeroVoiceCanaryAdmissionError();
  }
  let parsed: unknown;
  try { parsed = parseHeroVoiceCanaryStrictJson(Buffer.from(run.slotManifestJson, "utf8")); } catch {
    throw new HeroVoiceCanaryAdmissionError();
  }
  try { return parseHeroVoiceCanaryManifest(parsed); } catch {
    throw new HeroVoiceCanaryAdmissionError();
  }
}

/** Creates the only submit capability for a slot. Expired capabilities are not
 * replaced: expiry is a terminal harness failure, preserving no-replacement. */
export async function issueHeroVoiceCanarySubmitCapability(input: {
  runId: string;
  ownerHmac: string;
  slotId: string;
  nowMs?: number;
}): Promise<SignedHeroVoiceCanarySubmitCapability> {
  const issuedAtMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 1 || !HEX64.test(input.ownerHmac)) {
    throw new HeroVoiceCanaryAdmissionError();
  }
  return runHeroVoiceCanarySerializedMutation(async () => {
    const run = await prisma.reviewRun.findFirst({ where: { id: input.runId, ownerHmac: input.ownerHmac } });
    if (!run || run.state !== "collecting" || run.closedAt || run.inFlightSlotId !== null
      || !run.slotManifestSha256 || !run.referenceVoiceId) throw new HeroVoiceCanaryAdmissionError();
    const manifest = runManifest(run);
    const records = await verifyHeroVoiceCanaryLedger({ runId: run.id, ownerHmac: run.ownerHmac });
    const dispatched = records.filter(({ record }) => record.type === "dispatch_intent").length;
    if (manifest.slots[dispatched]?.slotId !== input.slotId) throw new HeroVoiceCanaryAdmissionError();
    const submitNonce = randomBytes(16).toString("base64url");
    const capability: HeroVoiceCanarySubmitCapability = Object.freeze({
      version: 1,
      runId: run.id,
      slotId: input.slotId,
      revision: run.revision,
      slotManifestSha256: run.slotManifestSha256,
      submitNonce,
      issuedAtMs,
      expiresAtMs: issuedAtMs + HERO_VOICE_CANARY_SUBMIT_TTL_MS,
    });
    const capabilityBytes = heroVoiceCanaryJcsBytes(capability);
    const submitHmac = heroVoiceCanaryHmacHex(submitKey(run.id), capability);
    try {
      await prisma.canarySubmitNonce.create({
        data: {
          runId: run.id,
          ownerHmac: run.ownerHmac,
          slotId: input.slotId,
          revision: run.revision,
          slotManifestSha256: run.slotManifestSha256,
          nonceSha256: heroVoiceCanarySha256(submitNonce),
          issuedAtMs: BigInt(issuedAtMs),
          expiresAtMs: BigInt(capability.expiresAtMs),
        },
      });
    } catch {
      throw new HeroVoiceCanaryAdmissionError();
    }
    return Object.freeze({ capability, capabilityBytes, submitHmac });
  });
}

export type ConsumedHeroVoiceCanaryAdmission = Readonly<{
  runId: string;
  slotId: string;
  ownerHmac: string;
  referenceVoiceId: string;
  manifestSha256: string;
  slot: HeroVoiceCanarySlot;
}>;

async function validateHeroVoiceCanaryAdmission(input: {
  client: Prisma.TransactionClient | typeof prisma;
  ownerHmac: string;
  capabilityBytes: Uint8Array;
  submitHmac: string;
  nowMs: number;
  requireUnusedNonce: boolean;
}): Promise<ConsumedHeroVoiceCanaryAdmission & { capability: HeroVoiceCanarySubmitCapability }> {
  if (!HEX64.test(input.ownerHmac) || !HEX64.test(input.submitHmac)
    || !Number.isSafeInteger(input.nowMs)) throw new HeroVoiceCanaryAdmissionError();
  const capability = parseHeroVoiceCanarySubmitCapabilityBytes(input.capabilityBytes);
  const expectedHmac = heroVoiceCanaryHmacHex(submitKey(capability.runId), capability);
  if (!heroVoiceCanaryHexMatches(expectedHmac, input.submitHmac)
    || input.nowMs < capability.issuedAtMs || input.nowMs >= capability.expiresAtMs) {
    throw new HeroVoiceCanaryAdmissionError();
  }
  const run = await input.client.reviewRun.findFirst({
    where: { id: capability.runId, ownerHmac: input.ownerHmac },
  });
  if (!run || run.state !== "collecting" || run.closedAt || run.inFlightSlotId !== null
    || run.revision !== capability.revision || run.slotManifestSha256 !== capability.slotManifestSha256
    || !run.referenceVoiceId) throw new HeroVoiceCanaryAdmissionError();
  const manifest = runManifest(run);
  const slot = manifest.slots.find((candidate) => candidate.slotId === capability.slotId);
  if (!slot || slot.runnerKind !== "CandidateAiStudioV3" || slot.phase !== "candidate") {
    throw new HeroVoiceCanaryAdmissionError();
  }
  if (input.requireUnusedNonce) {
    const nonce = await input.client.canarySubmitNonce.findFirst({
      where: {
        runId: run.id,
        ownerHmac: input.ownerHmac,
        slotId: slot.slotId,
        revision: capability.revision,
        slotManifestSha256: capability.slotManifestSha256,
        nonceSha256: heroVoiceCanarySha256(capability.submitNonce),
        issuedAtMs: BigInt(capability.issuedAtMs),
        expiresAtMs: BigInt(capability.expiresAtMs),
        usedAt: null,
        jobId: null,
      },
      select: { id: true },
    });
    if (!nonce) throw new HeroVoiceCanaryAdmissionError();
  }
  return Object.freeze({
    runId: run.id,
    slotId: slot.slotId,
    ownerHmac: run.ownerHmac,
    referenceVoiceId: run.referenceVoiceId,
    manifestSha256: capability.slotManifestSha256,
    slot,
    capability,
  });
}

/** Read-only preparation check. Consumption remains inside the later atomic
 * nonce/reservation/job transaction; this view only lets generation construct
 * the exact manifest-owned text/normalizer request before that transaction. */
export async function inspectHeroVoiceCanaryAdmission(input: {
  ownerHmac: string;
  capabilityBytes: Uint8Array;
  submitHmac: string;
  nowMs?: number;
}): Promise<ConsumedHeroVoiceCanaryAdmission> {
  return validateHeroVoiceCanaryAdmission({
    client: prisma,
    ownerHmac: input.ownerHmac,
    capabilityBytes: input.capabilityBytes,
    submitHmac: input.submitHmac,
    nowMs: input.nowMs ?? Date.now(),
    requireUnusedNonce: true,
  });
}

/** Must be called inside the same SQLite transaction that reserves local
 * minutes and creates the job/attempt. It performs no transaction of its own. */
export async function consumeHeroVoiceCanaryAdmissionInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    ownerHmac: string;
    capabilityBytes: Uint8Array;
    submitHmac: string;
    jobId: string;
    nowMs?: number;
  },
): Promise<ConsumedHeroVoiceCanaryAdmission> {
  const nowMs = input.nowMs ?? Date.now();
  if (!OPAQUE_ID.test(input.jobId)) throw new HeroVoiceCanaryAdmissionError();
  const validated = await validateHeroVoiceCanaryAdmission({
    client: tx,
    ownerHmac: input.ownerHmac,
    capabilityBytes: input.capabilityBytes,
    submitHmac: input.submitHmac,
    nowMs,
    requireUnusedNonce: false,
  });
  const { capability, slot } = validated;
  const consumed = await tx.canarySubmitNonce.updateMany({
    where: {
      runId: validated.runId,
      ownerHmac: input.ownerHmac,
      slotId: slot.slotId,
      revision: capability.revision,
      slotManifestSha256: capability.slotManifestSha256,
      nonceSha256: heroVoiceCanarySha256(capability.submitNonce),
      issuedAtMs: BigInt(capability.issuedAtMs),
      expiresAtMs: BigInt(capability.expiresAtMs),
      usedAt: null,
      jobId: null,
    },
    data: { usedAt: new Date(nowMs), jobId: input.jobId },
  });
  if (consumed.count !== 1) throw new HeroVoiceCanaryAdmissionError();
  return Object.freeze({
    runId: validated.runId,
    slotId: slot.slotId,
    ownerHmac: validated.ownerHmac,
    referenceVoiceId: validated.referenceVoiceId,
    manifestSha256: capability.slotManifestSha256,
    slot,
  });
}
