import "server-only";

import { prisma } from "@/lib/prisma";
import { heroVoiceCanaryJcsBytes, heroVoiceCanarySha256, parseHeroVoiceCanaryStrictJson } from "@/lib/hero-voice-canary-canonical";
import { parseHeroVoiceCanaryManifest } from "@/lib/hero-voice-canary-manifest";
import { verifyHeroVoiceCanaryLedger } from "@/lib/hero-voice-canary-ledger.server";
import { validatePcm16MonoWav } from "@/lib/hero-voice-clone-runners";
import {
  heroVoiceCanaryRunAcceptsDirectOutput,
  persistHeroVoiceCanaryRunOutputWithinSerializedMutation,
  runHeroVoiceCanarySerializedMutation,
} from "@/lib/hero-voice-deletion-coordinator.server";
import { artifactSourcePath, heroVoiceCanaryStorageContext, readPrivateFileNoFollow } from "@/lib/hero-voice-canary-storage.server";

type Scope = Readonly<{ runId: string; ownerHmac: string; slotId: string }>;

function invalid(): never { throw new Error("CANARY_RUN_OUTPUT_INVALID"); }

/** Use the provider contract's PCM validator and rounded sample duration. */
function wavMetadata(audio: Buffer): { audioSha256: string; durationMs: number } {
  if (!Buffer.isBuffer(audio) || audio.length > 7_000_000) invalid();
  const parsed = validatePcm16MonoWav(audio, { sampleRate: 24_000 });
  if (!parsed || !Number.isSafeInteger(parsed.durationMs) || parsed.durationMs < 1) invalid();
  return { audioSha256: heroVoiceCanarySha256(audio), durationMs: parsed.durationMs };
}

async function authority(input: Scope) {
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(input.runId) || !/^[0-9a-f]{64}$/u.test(input.ownerHmac)
    || !/^[A-Za-z0-9_.-]{1,120}$/u.test(input.slotId)) invalid();
  const run = await prisma.reviewRun.findFirst({ where: { id: input.runId, ownerHmac: input.ownerHmac } });
  if (!run || run.state === "closed" || !run.slotManifestJson || !run.slotManifestSha256) invalid();
  const bytes = Buffer.from(run.slotManifestJson);
  if (heroVoiceCanarySha256(bytes) !== run.slotManifestSha256) invalid();
  const manifest = parseHeroVoiceCanaryManifest(parseHeroVoiceCanaryStrictJson(bytes));
  if (!heroVoiceCanaryJcsBytes(manifest).equals(bytes)) invalid();
  const slot = manifest.slots.find((item) => item.slotId === input.slotId);
  // Candidate finals are application-owned generation outputs, not direct outputs.
  if (!slot || slot.phase === "candidate") invalid();
  const records = await verifyHeroVoiceCanaryLedger(input);
  const accepted = records.map((item) => item.record).filter((record) => record.type === "provider_accepted" && record.slotId === input.slotId);
  const frozen = records[0]?.record;
  if (frozen?.type !== "run_created" || frozen.manifestSha256 !== run.slotManifestSha256
    || accepted.length !== 1 || accepted[0].type !== "provider_accepted" || !accepted[0].providerJobId) invalid();
  return { run, providerJobId: accepted[0].providerJobId };
}

/** Only the trusted parent receives this byte interface; adapter IPC has no
 * filesystem paths, database handle, signing key, or registry mutation API. */
export async function writeHeroVoiceCanaryRunOutput(input: Scope & {
  providerJobId: string; audio: Buffer;
}): Promise<{ audioSha256: string; durationMs: number }> {
  // Copy before the first await so a caller cannot mutate the validated bytes.
  if (!Buffer.isBuffer(input.audio) || input.audio.length > 7_000_000) invalid();
  const audio = Buffer.from(input.audio);
  const metadata = wavMetadata(audio);
  return runHeroVoiceCanarySerializedMutation(async () => {
    const { run, providerJobId } = await authority(input);
    if (providerJobId !== input.providerJobId) invalid();
    const existing = await prisma.canaryRunOutput.findUnique({ where: { runId_slotId: { runId: input.runId, slotId: input.slotId } } });
    if (existing) {
      if (existing.ownerHmac !== input.ownerHmac || existing.providerJobId !== providerJobId
        || existing.audioSha256 !== metadata.audioSha256 || existing.durationMs !== metadata.durationMs) invalid();
      const stored = readPrivateFileNoFollow(artifactSourcePath(heroVoiceCanaryStorageContext(), "review_private", existing.storageKey), 7_000_000);
      if (!stored.equals(audio)) invalid();
      return metadata;
    }
    if (!heroVoiceCanaryRunAcceptsDirectOutput(run, input.slotId)) invalid();
    await persistHeroVoiceCanaryRunOutputWithinSerializedMutation({ ...input, audio, ...metadata });
    return metadata;
  });
}

export async function readHeroVoiceCanaryRunOutput(input: Scope): Promise<Buffer> {
  return runHeroVoiceCanarySerializedMutation(async () => {
    const { providerJobId } = await authority(input);
    const row = await prisma.canaryRunOutput.findFirst({ where: {
      runId: input.runId, slotId: input.slotId, ownerHmac: input.ownerHmac, providerJobId,
    } });
    if (!row) invalid();
    const audio = readPrivateFileNoFollow(artifactSourcePath(heroVoiceCanaryStorageContext(), "review_private", row.storageKey), 7_000_000);
    const metadata = wavMetadata(audio);
    if (metadata.audioSha256 !== row.audioSha256 || metadata.durationMs !== row.durationMs) invalid();
    return audio;
  });
}
