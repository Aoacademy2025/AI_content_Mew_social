import assert from "node:assert/strict";
import fs from "node:fs";

import type { HeroVoiceDeletionCrashStep } from "../src/lib/hero-voice-deletion-coordinator.server";

const mode = process.argv[2] as "setup" | "crash" | "recover";
const crashStep = process.argv[3] as HeroVoiceDeletionCrashStep;
const OWNER_ID = "upload-owner";
const AUTH_SUBJECT = "upload-subject";
const AUTH_ISSUER = process.env.HERO_VOICE_CANARY_AUTH_ISSUER!;

function syntheticWav(): Buffer {
  const sampleRate = 24_000;
  const samples = sampleRate * 7;
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * index / sampleRate) * 8_000), index * 2);
  }
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

async function main() {
  const [{ prisma }, coordinator, storage, voices] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/hero-voice-deletion-coordinator.server"),
    import("../src/lib/hero-voice-canary-storage.server"),
    import("../src/lib/user-voices.server"),
  ]);
  if (mode === "setup") {
    await prisma.siteConfig.create({
      data: {
        key: storage.HERO_VOICE_CANARY_DATABASE_MARKER_KEY,
        value: storage.HERO_VOICE_CANARY_DATABASE_MARKER_VALUE,
      },
    });
    assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "ready" });
    await prisma.user.create({
      data: {
        id: OWNER_ID,
        clerkId: AUTH_SUBJECT,
        name: "Upload crash owner",
        email: "upload-crash@example.invalid",
      },
    });
    await prisma.creditBalance.create({ data: { userId: OWNER_ID, granted: 2 } });
    await prisma.creditLedger.create({
      data: { userId: OWNER_ID, delta: 2, kind: "grant", balanceAfter: 2 },
    });
  } else if (mode === "crash") {
    assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "ready" });
    coordinator.setHeroVoiceDeletionCrashObserverForTests((observed) => {
      if (observed === crashStep) process.exit(86);
    });
    await voices.createUserVoice({
      userId: OWNER_ID,
      name: "Crash recovery voice",
      refText: "synthetic crash recovery transcript",
      audio: syntheticWav(),
      consent: true,
    });
    throw new Error("upload crash boundary was not reached");
  } else if (mode === "recover") {
    assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "ready" });
    const committed = crashStep === "after-upload-row-commit";
    assert.equal(await prisma.userVoice.count({ where: { userId: OWNER_ID } }), committed ? 1 : 0);
    const uploadIntent = await prisma.deletionTransaction.findFirstOrThrow({
      where: { operationKind: "voice_upload" },
    });
    assert.equal(uploadIntent.status, committed ? "done" : "rolled_back");
    assert.equal(uploadIntent.scopeUserId, null);
    assert.equal(uploadIntent.scopeVoiceId, null);
    const context = storage.heroVoiceCanaryStorageContext();
    assert.deepEqual(fs.readdirSync(context.uploadStagingRoot), []);
    const referenceFiles = fs.readdirSync(context.userVoiceRoot).filter((entry) => entry !== "generated");
    assert.equal(referenceFiles.length, committed ? 1 : 0);
    if (committed) {
      const reference = await prisma.userVoice.findFirstOrThrow({ where: { userId: OWNER_ID } });
      const pathname = storage.artifactSourcePath(context, "user_voice_reference", reference.filename);
      assert.equal(storage.readPrivateFileNoFollow(pathname).length > 44, true);
    }
    assert.equal(await coordinator.hardDeleteHeroVoiceCanaryAccount({
      userId: OWNER_ID,
      authIssuer: AUTH_ISSUER,
      authSubject: AUTH_SUBJECT,
    }), true);
    assert.equal(await prisma.user.count({ where: { id: OWNER_ID } }), 0);
    assert.equal(await prisma.userVoice.count({ where: { userId: OWNER_ID } }), 0);
    assert.equal(await prisma.creditBalance.count({ where: { userId: OWNER_ID } }), 0);
    assert.equal(await prisma.creditLedger.count({ where: { userId: OWNER_ID } }), 0);
    assert.deepEqual(fs.readdirSync(context.uploadStagingRoot), []);
    assert.deepEqual(fs.readdirSync(context.userVoiceRoot), ["generated"]);
  } else {
    throw new Error("unknown upload crash verifier mode");
  }
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
