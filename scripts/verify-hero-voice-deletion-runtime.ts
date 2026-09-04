import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type Coordinator = typeof import("../src/lib/hero-voice-deletion-coordinator.server");

const PRIVATE_BYTES = Buffer.from("synthetic-private-audio-sentinel", "utf8");
const REVIEW_BYTES = Buffer.from("synthetic-private-review-sentinel", "utf8");
const AUTH_ISSUER = process.env.HERO_VOICE_CANARY_AUTH_ISSUER!;

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writePrivate(filename: string, bytes: Buffer): void {
  fs.writeFileSync(filename, bytes, { flag: "wx", mode: 0o600 });
  fs.chmodSync(filename, 0o600);
}

function syntheticWav(durationMs = 7_000): Buffer {
  const sampleRate = 24_000;
  const samples = Math.round(sampleRate * durationMs / 1_000);
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
  const [{ prisma }, coordinator, storage, voices, accountDelete] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/hero-voice-deletion-coordinator.server"),
    import("../src/lib/hero-voice-canary-storage.server"),
    import("../src/lib/user-voices.server"),
    import("../src/lib/account-hard-delete.server"),
  ]);
  const context = storage.heroVoiceCanaryStorageContext();
  await prisma.siteConfig.create({
    data: {
      key: storage.HERO_VOICE_CANARY_DATABASE_MARKER_KEY,
      value: storage.HERO_VOICE_CANARY_DATABASE_MARKER_VALUE,
    },
  });
  assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "ready" });

  async function createUser(label: string) {
    const suffix = randomUUID();
    return prisma.user.create({
      data: {
        id: `user-${suffix}`,
        clerkId: `subject-${suffix}`,
        name: `Synthetic ${label}`,
        email: `${suffix}@example.invalid`,
      },
    });
  }

  async function createVoiceFixture(label: string) {
    const user = await createUser(label);
    const voiceId = randomUUID();
    const filename = `${randomUUID()}.wav`;
    const pathname = path.join(context.userVoiceRoot, filename);
    writePrivate(pathname, PRIVATE_BYTES);
    await prisma.userVoice.create({
      data: {
        id: voiceId,
        userId: user.id,
        name: "Synthetic voice",
        refText: "synthetic reference transcript",
        filename,
        durationMs: 7_000,
      },
    });
    return { user, voiceId, filename, pathname };
  }

  async function createReviewFixture(label: string, state = "revealed") {
    const authSubject = `review-subject-${label}-${randomUUID()}`;
    const ownerHmac = coordinator.computeHeroVoiceCanaryOwnerHmac({ authIssuer: AUTH_ISSUER, authSubject });
    const storageKey = `review-${randomUUID()}.wav`;
    const pathname = path.join(context.reviewRoot, storageKey);
    writePrivate(pathname, REVIEW_BYTES);
    const manifest = coordinator.serializeHeroVoiceCanaryReviewArtifactManifest([
      { storageKey, sha256: hash(REVIEW_BYTES) },
    ]);
    const run = await prisma.reviewRun.create({
      data: {
        id: `run-${randomUUID()}`,
        ownerHmac,
        state,
        revision: 7,
        privateArtifactManifestJson: manifest,
        rawScoresJson: JSON.stringify({ private: true }),
        revealCiphertextJson: JSON.stringify({ ciphertext: "opaque" }),
        ledgerSequence: 4,
        ledgerHeadHmac: "a".repeat(64),
        sanitizedAggregatesJson: coordinator.serializeHeroVoiceCanarySanitizedReviewAggregates({
          candidateCerPasses: 17,
          candidateCriticalFlagCount: 0,
          candidateLosses: 2,
          candidateWins: 15,
          completePairs: 18,
          ties: 1,
          version: 1,
        }),
      },
    });
    return { authSubject, ownerHmac, storageKey, pathname, run };
  }

  async function createAccountFixture(label: string) {
    const voice = await createVoiceFixture(`account-${label}`);
    const authSubject = voice.user.clerkId!;
    const ownerHmac = coordinator.computeHeroVoiceCanaryOwnerHmac({ authIssuer: AUTH_ISSUER, authSubject });
    const jobId = `job-${randomUUID()}`;
    const generatedKey = `clone-${jobId}.wav`;
    const generatedPath = path.join(context.generatedRoot, generatedKey);
    writePrivate(generatedPath, PRIVATE_BYTES);
    await prisma.aiGenerationJob.create({
      data: {
        id: jobId,
        userId: voice.user.id,
        kind: "voice",
        provider: "runpod",
        model: `user_${voice.voiceId}`,
        providerModel: "omnivoice-clone",
        providerRoute: "runpod-custom",
        status: "failed",
        chargeState: "refunded",
        attempts: {
          create: {
            sequence: 1,
            provider: "runpod",
            providerModel: "omnivoice-clone",
            providerRoute: "runpod-custom",
            status: "failed",
            estimatedCostUsdMicros: 0,
          },
        },
      },
    });
    await prisma.creditBalance.create({ data: { userId: voice.user.id, granted: 3, purchased: 2 } });
    await prisma.creditLedger.create({
      data: { userId: voice.user.id, delta: 5, kind: "grant", balanceAfter: 5 },
    });
    const reviewKey = `account-review-${randomUUID()}.json`;
    const reviewPath = path.join(context.reviewRoot, reviewKey);
    writePrivate(reviewPath, REVIEW_BYTES);
    await prisma.reviewRun.create({
      data: {
        id: `run-${randomUUID()}`,
        ownerHmac,
        state: label.endsWith("locked") ? "locked" : "collecting",
        privateArtifactManifestJson: coordinator.serializeHeroVoiceCanaryReviewArtifactManifest([
          { storageKey: reviewKey, sha256: hash(REVIEW_BYTES) },
        ]),
        rawScoresJson: "{}",
        revealCiphertextJson: "{}",
      },
    });
    return { ...voice, authSubject, ownerHmac, generatedPath, reviewPath, jobId };
  }

  const crashSteps: Coordinator["HERO_VOICE_DELETION_OPERATION_KINDS"] extends never
    ? never
    : import("../src/lib/hero-voice-deletion-coordinator.server").HeroVoiceDeletionCrashStep[] = [
      "before-transaction-a",
      "after-transaction-a",
      "before-move",
      "after-move",
      "before-progress-commit",
      "after-progress-commit",
      "before-transaction-b",
      "after-transaction-b",
      "before-unlink",
      "after-unlink",
      "before-transaction-c",
      "after-transaction-c",
    ];

  async function injectOne(step: import("../src/lib/hero-voice-deletion-coordinator.server").HeroVoiceDeletionCrashStep) {
    let injected = false;
    coordinator.setHeroVoiceDeletionCrashObserverForTests((observed) => {
      if (!injected && observed === step) {
        injected = true;
        throw new coordinator.HeroVoiceDeletionSimulatedCrash(step);
      }
    });
    return () => {
      coordinator.setHeroVoiceDeletionCrashObserverForTests();
      assert.equal(injected, true, `crash step was reached: ${step}`);
    };
  }

  for (const step of crashSteps) {
    const fixture = await createVoiceFixture(`voice-${step}`);
    const clear = await injectOne(step);
    await assert.rejects(
      coordinator.deleteHeroVoiceCanaryVoice(fixture.user.id, fixture.voiceId),
      (error: unknown) => error instanceof coordinator.HeroVoiceDeletionSimulatedCrash,
    );
    clear();
    coordinator.resetHeroVoiceDeletionCoordinatorForTests();
    assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "ready" });
    if (step === "before-transaction-a") {
      assert.equal(await coordinator.deleteHeroVoiceCanaryVoice(fixture.user.id, fixture.voiceId), true);
    }
    assert.equal(await prisma.userVoice.count({ where: { id: fixture.voiceId } }), 0);
    assert.equal(fs.existsSync(fixture.pathname), false);
  }

  for (const step of crashSteps) {
    const fixture = await createReviewFixture(`review-${step}`);
    const clear = await injectOne(step);
    await assert.rejects(
      coordinator.closeHeroVoiceCanaryReviewRun({
        runId: fixture.run.id,
        ownerHmac: fixture.ownerHmac,
        expectedRevision: 7,
      }),
      (error: unknown) => error instanceof coordinator.HeroVoiceDeletionSimulatedCrash,
    );
    clear();
    coordinator.resetHeroVoiceDeletionCoordinatorForTests();
    assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "ready" });
    if (step === "before-transaction-a") {
      await coordinator.closeHeroVoiceCanaryReviewRun({
        runId: fixture.run.id,
        ownerHmac: fixture.ownerHmac,
        expectedRevision: 7,
      });
    }
    const closed = await prisma.reviewRun.findUniqueOrThrow({ where: { id: fixture.run.id } });
    assert.equal(closed.state, "closed");
    assert.equal(closed.revision, 8);
    assert.equal(closed.privateArtifactManifestJson, null);
    assert.equal(closed.rawScoresJson, null);
    assert.equal(closed.revealCiphertextJson, null);
    assert.equal(closed.ledgerSequence, 0);
    assert.equal(closed.ledgerHeadHmac, null);
    assert.equal(closed.sanitizedAggregatesJson, coordinator.serializeHeroVoiceCanarySanitizedReviewAggregates({
      candidateCerPasses: 17,
      candidateCriticalFlagCount: 0,
      candidateLosses: 2,
      candidateWins: 15,
      completePairs: 18,
      ties: 1,
      version: 1,
    }));
    assert.ok(closed.receiptId);
    assert.equal(fs.existsSync(fixture.pathname), false);
  }

  for (const step of crashSteps) {
    const fixture = await createAccountFixture(`account-${step}`);
    const clear = await injectOne(step);
    await assert.rejects(
      coordinator.hardDeleteHeroVoiceCanaryAccount({
        userId: fixture.user.id,
        authIssuer: AUTH_ISSUER,
        authSubject: fixture.authSubject,
      }),
      (error: unknown) => error instanceof coordinator.HeroVoiceDeletionSimulatedCrash,
    );
    clear();
    coordinator.resetHeroVoiceDeletionCoordinatorForTests();
    assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "ready" });
    if (step === "before-transaction-a") {
      assert.equal(await coordinator.hardDeleteHeroVoiceCanaryAccount({
        userId: fixture.user.id,
        authIssuer: AUTH_ISSUER,
        authSubject: fixture.authSubject,
      }), true);
    }
    assert.equal(await prisma.user.count({ where: { id: fixture.user.id } }), 0);
    assert.equal(await prisma.aiGenerationJob.count({ where: { id: fixture.jobId } }), 0);
    assert.equal(await prisma.aiGenerationAttempt.count({ where: { jobId: fixture.jobId } }), 0);
    assert.equal(await prisma.creditBalance.count({ where: { userId: fixture.user.id } }), 0);
    assert.equal(await prisma.creditLedger.count({ where: { userId: fixture.user.id } }), 0);
    assert.equal(await prisma.reviewRun.count({ where: { ownerHmac: fixture.ownerHmac } }), 0);
    assert.equal(fs.existsSync(fixture.pathname), false);
    assert.equal(fs.existsSync(fixture.generatedPath), false);
    assert.equal(fs.existsSync(fixture.reviewPath), false);
  }

  // Exact delete-vs-generation claim outcomes: an active job wins with 409;
  // after terminal failure the reference is preserved and a later delete wins.
  const active = await createVoiceFixture("active-job");
  const activeJob = await prisma.aiGenerationJob.create({
    data: {
      userId: active.user.id,
      kind: "voice",
      provider: "runpod",
      model: `user_${active.voiceId}`,
      providerModel: "omnivoice-clone",
      providerRoute: "runpod-custom",
      status: "queued",
    },
  });
  await assert.rejects(
    coordinator.deleteHeroVoiceCanaryVoice(active.user.id, active.voiceId),
    (error: unknown) => error instanceof coordinator.HeroVoiceDeletionError
      && error.code === "USER_VOICE_IN_USE" && error.status === 409,
  );
  assert.equal(fs.existsSync(active.pathname), true);
  await prisma.aiGenerationJob.update({ where: { id: activeJob.id }, data: { status: "failed" } });
  assert.equal(await coordinator.deleteHeroVoiceCanaryVoice(active.user.id, active.voiceId), true);
  assert.equal(fs.existsSync(active.pathname), false);

  // A simulated B failure restores bytes and clears the deletion claim. A later
  // terminal job permits a fresh deletion transaction.
  const rollback = await createVoiceFixture("rollback");
  const clearAfterA = await injectOne("after-transaction-a");
  await assert.rejects(coordinator.deleteHeroVoiceCanaryVoice(rollback.user.id, rollback.voiceId));
  clearAfterA();
  const rollbackJob = await prisma.aiGenerationJob.create({
    data: {
      userId: rollback.user.id,
      kind: "voice",
      provider: "runpod",
      model: `user_${rollback.voiceId}`,
      status: "queued",
    },
  });
  coordinator.resetHeroVoiceDeletionCoordinatorForTests();
  assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "read_only" });
  const restored = await prisma.userVoice.findUniqueOrThrow({ where: { id: rollback.voiceId } });
  assert.equal(restored.deletionTransactionId, null);
  assert.equal(fs.existsSync(rollback.pathname), true);
  const rolledBackIntent = await prisma.deletionTransaction.findFirstOrThrow({
    where: { operationKind: "single_voice_delete", status: "rolled_back" },
    orderBy: { rolledBackAt: "desc" },
  });
  assert.ok(rolledBackIntent.rolledBackAt);
  await prisma.aiGenerationJob.update({ where: { id: rollbackJob.id }, data: { status: "failed" } });
  coordinator.resetHeroVoiceDeletionCoordinatorForTests();
  assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "ready" });
  assert.equal(await coordinator.deleteHeroVoiceCanaryVoice(rollback.user.id, rollback.voiceId), true);

  // Owner isolation is indistinguishable from absence and never returns paths.
  const owner = await createVoiceFixture("owner-isolation");
  const other = await createUser("other-owner");
  assert.equal(await voices.readUserVoiceWav(other.id, owner.voiceId), null);
  assert.equal((await voices.listUserVoices(other.id)).length, 0);
  assert.equal(await coordinator.deleteHeroVoiceCanaryVoice(other.id, owner.voiceId), false);
  assert.equal(fs.existsSync(owner.pathname), true);
  assert.equal(await coordinator.deleteHeroVoiceCanaryVoice(owner.user.id, owner.voiceId), true);

  // Review-root/key and verified issuer/subject consistency are mandatory.
  const identityFixture = await createAccountFixture("identity");
  await assert.rejects(
    coordinator.hardDeleteHeroVoiceCanaryAccount({
      userId: identityFixture.user.id,
      authIssuer: "https://wrong.invalid",
      authSubject: identityFixture.authSubject,
    }),
    (error: unknown) => error instanceof coordinator.HeroVoiceDeletionError
      && error.code === "CANARY_AUTH_CLAIMS_INVALID",
  );
  const savedKey = process.env.HERO_VOICE_CANARY_REVIEW_KEY;
  delete process.env.HERO_VOICE_CANARY_REVIEW_KEY;
  assert.throws(
    () => coordinator.computeHeroVoiceCanaryOwnerHmac({
      authIssuer: AUTH_ISSUER,
      authSubject: identityFixture.authSubject,
    }),
    (error: unknown) => error instanceof coordinator.HeroVoiceDeletionError
      && error.code === "CANARY_REVIEW_KEY_INVALID",
  );
  process.env.HERO_VOICE_CANARY_REVIEW_KEY = savedKey;
  assert.equal(await accountDelete.hardDeleteUserWithHeroVoiceCanaryArtifacts({
    userId: identityFixture.user.id,
    authIssuer: AUTH_ISSUER,
    authSubject: identityFixture.authSubject,
  }), true);

  // The storage/key binding predates A. Changing a root or the review key before
  // a delete cannot bless an empty replacement store and falsely report success.
  const preBindingVoice = await createVoiceFixture("pre-a-root-binding");
  const originalVoiceRoot = process.env.USER_VOICE_STORAGE_DIR!;
  const alternateVoiceRoot = path.join(context.canaryRoot, "alternate-private-references");
  fs.mkdirSync(alternateVoiceRoot, { mode: 0o700 });
  process.env.USER_VOICE_STORAGE_DIR = alternateVoiceRoot;
  await assert.rejects(
    coordinator.deleteHeroVoiceCanaryVoice(preBindingVoice.user.id, preBindingVoice.voiceId),
    (error: unknown) => error instanceof coordinator.HeroVoiceDeletionError
      && error.code === "CANARY_STORAGE_BINDING_INVALID",
  );
  coordinator.resetHeroVoiceDeletionCoordinatorForTests();
  assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "read_only" });
  assert.equal(await prisma.userVoice.count({ where: { id: preBindingVoice.voiceId } }), 1);
  assert.equal(fs.existsSync(preBindingVoice.pathname), true);
  process.env.USER_VOICE_STORAGE_DIR = originalVoiceRoot;
  coordinator.resetHeroVoiceDeletionCoordinatorForTests();
  assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "ready" });
  assert.equal(await coordinator.deleteHeroVoiceCanaryVoice(preBindingVoice.user.id, preBindingVoice.voiceId), true);

  const preBindingAccount = await createAccountFixture("pre-a-key-binding");
  process.env.HERO_VOICE_CANARY_REVIEW_KEY = Buffer.alloc(32, 11).toString("base64url");
  await assert.rejects(
    coordinator.hardDeleteHeroVoiceCanaryAccount({
      userId: preBindingAccount.user.id,
      authIssuer: AUTH_ISSUER,
      authSubject: preBindingAccount.authSubject,
    }),
    (error: unknown) => error instanceof coordinator.HeroVoiceDeletionError
      && error.code === "CANARY_STORAGE_BINDING_INVALID",
  );
  coordinator.resetHeroVoiceDeletionCoordinatorForTests();
  assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "read_only" });
  assert.equal(await prisma.user.count({ where: { id: preBindingAccount.user.id } }), 1);
  assert.equal(await prisma.reviewRun.count({ where: { ownerHmac: preBindingAccount.ownerHmac } }), 1);
  assert.equal(fs.existsSync(preBindingAccount.pathname), true);
  assert.equal(fs.existsSync(preBindingAccount.generatedPath), true);
  assert.equal(fs.existsSync(preBindingAccount.reviewPath), true);
  process.env.HERO_VOICE_CANARY_REVIEW_KEY = savedKey;
  coordinator.resetHeroVoiceDeletionCoordinatorForTests();
  assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "ready" });
  assert.equal(await coordinator.hardDeleteHeroVoiceCanaryAccount({
    userId: preBindingAccount.user.id,
    authIssuer: AUTH_ISSUER,
    authSubject: preBindingAccount.authSubject,
  }), true);

  // Close retains only the exact numeric aggregate schema. Malformed JSON and
  // extra raw/mapping/subject/transcript-shaped keys fail before A or any move.
  for (const [label, invalidAggregates] of [
    ["malformed", "{"],
    ["out-of-range", JSON.stringify({
      candidateCerPasses: 19,
      candidateCriticalFlagCount: 0,
      candidateLosses: 2,
      candidateWins: 15,
      completePairs: 18,
      ties: 1,
      version: 1,
    })],
    ["sensitive-extra", JSON.stringify({
      candidateCerPasses: 17,
      candidateCriticalFlagCount: 0,
      candidateLosses: 2,
      candidateWins: 15,
      completePairs: 18,
      ties: 1,
      version: 1,
      rawScores: { A: "private" },
      mapping: { A: "candidate" },
      authSubject: "subject-private",
      transcript: "private transcript",
    })],
  ] as const) {
    const fixture = await createReviewFixture(`invalid-aggregate-${label}`);
    await prisma.reviewRun.update({
      where: { id: fixture.run.id },
      data: { sanitizedAggregatesJson: invalidAggregates },
    });
    await assert.rejects(
      coordinator.closeHeroVoiceCanaryReviewRun({
        runId: fixture.run.id,
        ownerHmac: fixture.ownerHmac,
        expectedRevision: 7,
      }),
      (error: unknown) => error instanceof coordinator.HeroVoiceDeletionError
        && error.code === "REVIEW_AGGREGATES_INVALID"
        && !String(error).includes("private"),
    );
    assert.equal((await prisma.reviewRun.findUniqueOrThrow({ where: { id: fixture.run.id } })).state, "revealed");
    assert.equal(fs.existsSync(fixture.pathname), true);
    await prisma.reviewRun.update({
      where: { id: fixture.run.id },
      data: {
        sanitizedAggregatesJson: coordinator.serializeHeroVoiceCanarySanitizedReviewAggregates({
          candidateCerPasses: 17,
          candidateCriticalFlagCount: 0,
          candidateLosses: 2,
          candidateWins: 15,
          completePairs: 18,
          ties: 1,
          version: 1,
        }),
      },
    });
    await coordinator.closeHeroVoiceCanaryReviewRun({
      runId: fixture.run.id,
      ownerHmac: fixture.ownerHmac,
      expectedRevision: 7,
    });
  }

  // A nonterminal account intent is bound to both the private review root and
  // the out-of-band review key. Startup fails closed if either changes, then
  // completes the same intent once the exact configuration is restored.
  const consistency = await createAccountFixture("configuration-consistency");
  const clearConsistencyCrash = await injectOne("after-transaction-a");
  await assert.rejects(
    coordinator.hardDeleteHeroVoiceCanaryAccount({
      userId: consistency.user.id,
      authIssuer: AUTH_ISSUER,
      authSubject: consistency.authSubject,
    }),
    (error: unknown) => error instanceof coordinator.HeroVoiceDeletionSimulatedCrash,
  );
  clearConsistencyCrash();
  const originalReviewRoot = process.env.HERO_VOICE_CANARY_REVIEW_ROOT!;
  const alternateReviewRoot = path.join(context.canaryRoot, "alternate-private-review");
  fs.mkdirSync(alternateReviewRoot, { mode: 0o700 });
  process.env.HERO_VOICE_CANARY_REVIEW_ROOT = alternateReviewRoot;
  coordinator.resetHeroVoiceDeletionCoordinatorForTests();
  assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "read_only" });
  process.env.HERO_VOICE_CANARY_REVIEW_ROOT = originalReviewRoot;
  process.env.HERO_VOICE_CANARY_REVIEW_KEY = Buffer.alloc(32, 9).toString("base64url");
  coordinator.resetHeroVoiceDeletionCoordinatorForTests();
  assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "read_only" });
  process.env.HERO_VOICE_CANARY_REVIEW_KEY = savedKey;
  coordinator.resetHeroVoiceDeletionCoordinatorForTests();
  assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "ready" });
  assert.equal(await prisma.user.count({ where: { id: consistency.user.id } }), 0);
  assert.equal(fs.existsSync(consistency.pathname), false);
  assert.equal(fs.existsSync(consistency.generatedPath), false);
  assert.equal(fs.existsSync(consistency.reviewPath), false);

  // Final-component symlinks and path swaps after O_NOFOLLOW open are rejected
  // before rename/unlink can operate on the substituted inode.
  const symlinkTarget = path.join(context.reviewRoot, `symlink-target-${randomUUID()}.wav`);
  const symlinkPath = path.join(context.reviewRoot, `symlink-${randomUUID()}.wav`);
  writePrivate(symlinkTarget, REVIEW_BYTES);
  fs.symlinkSync(symlinkTarget, symlinkPath);
  assert.throws(
    () => storage.readPrivateFileNoFollow(symlinkPath),
    (error: unknown) => error instanceof storage.HeroVoiceCanaryStorageError
      && error.message === "Hero Voice canary private storage is unavailable"
      && !error.message.includes(symlinkPath),
  );
  assert.equal(fs.readFileSync(symlinkTarget).equals(REVIEW_BYTES), true);
  fs.unlinkSync(symlinkPath);
  storage.unlinkPrivateFileNoFollow(symlinkTarget);

  const outsideCanary = path.join(path.dirname(context.canaryRoot), `outside-canary-${randomUUID()}.wav`);
  writePrivate(outsideCanary, REVIEW_BYTES);
  assert.throws(
    () => storage.readPrivateFileNoFollow(outsideCanary),
    (error: unknown) => error instanceof storage.HeroVoiceCanaryStorageError
      && error.message === "Hero Voice canary private storage is unavailable"
      && !error.message.includes(outsideCanary),
  );
  assert.equal(fs.readFileSync(outsideCanary).equals(REVIEW_BYTES), true);
  fs.unlinkSync(outsideCanary);

  for (const operation of ["rename", "unlink"] as const) {
    const source = path.join(context.reviewRoot, `${operation}-source-${randomUUID()}.wav`);
    const held = path.join(context.reviewRoot, `${operation}-held-${randomUUID()}.wav`);
    const destination = path.join(context.reviewRoot, `${operation}-destination-${randomUUID()}.wav`);
    const substitute = Buffer.from(`substitute-${operation}`, "utf8");
    writePrivate(source, REVIEW_BYTES);
    storage.setHeroVoiceCanaryFileOperationObserverForTests((step, basename) => {
      if (step === "after-open-before-stability" && basename === path.basename(source)) {
        fs.renameSync(source, held);
        writePrivate(source, substitute);
      }
    });
    assert.throws(
      () => operation === "rename"
        ? storage.renamePrivateFileNoFollow(source, destination)
        : storage.unlinkPrivateFileNoFollow(source),
      (error: unknown) => error instanceof storage.HeroVoiceCanaryStorageError
        && error.message === "Hero Voice canary private storage is unavailable",
    );
    storage.setHeroVoiceCanaryFileOperationObserverForTests();
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.readFileSync(source).equals(substitute), true, "substituted target was not operated on");
    assert.equal(fs.readFileSync(held).equals(REVIEW_BYTES), true, "opened inode remains intact");
    storage.unlinkPrivateFileNoFollow(source);
    storage.unlinkPrivateFileNoFollow(held);
  }

  // Parent directory descriptors are held across the check/use boundary too.
  // Swapping either a rename destination parent or an unlink source parent
  // cannot redirect an operation to the replacement directory.
  {
    const source = path.join(context.reviewRoot, `parent-rename-source-${randomUUID()}.wav`);
    const destinationDirectory = path.join(context.reviewRoot, `parent-rename-destination-${randomUUID()}`);
    const heldDirectory = `${destinationDirectory}-held`;
    const destination = path.join(destinationDirectory, `destination-${randomUUID()}.wav`);
    fs.mkdirSync(destinationDirectory, { mode: 0o700 });
    writePrivate(source, REVIEW_BYTES);
    storage.setHeroVoiceCanaryFileOperationObserverForTests((step) => {
      if (step === "before-rename") {
        fs.renameSync(destinationDirectory, heldDirectory);
        fs.mkdirSync(destinationDirectory, { mode: 0o700 });
      }
    });
    assert.throws(
      () => storage.renamePrivateFileNoFollow(source, destination),
      (error: unknown) => error instanceof storage.HeroVoiceCanaryStorageError,
    );
    storage.setHeroVoiceCanaryFileOperationObserverForTests();
    assert.equal(fs.readFileSync(source).equals(REVIEW_BYTES), true);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(path.join(heldDirectory, path.basename(destination))), false);
    storage.unlinkPrivateFileNoFollow(source);
    fs.rmdirSync(destinationDirectory);
    fs.rmdirSync(heldDirectory);
  }
  {
    const sourceDirectory = path.join(context.reviewRoot, `parent-unlink-source-${randomUUID()}`);
    const heldDirectory = `${sourceDirectory}-held`;
    const source = path.join(sourceDirectory, `source-${randomUUID()}.wav`);
    fs.mkdirSync(sourceDirectory, { mode: 0o700 });
    writePrivate(source, REVIEW_BYTES);
    storage.setHeroVoiceCanaryFileOperationObserverForTests((step) => {
      if (step === "before-unlink") {
        fs.renameSync(sourceDirectory, heldDirectory);
        fs.mkdirSync(sourceDirectory, { mode: 0o700 });
      }
    });
    assert.throws(
      () => storage.unlinkPrivateFileNoFollow(source),
      (error: unknown) => error instanceof storage.HeroVoiceCanaryStorageError,
    );
    storage.setHeroVoiceCanaryFileOperationObserverForTests();
    const heldSource = path.join(heldDirectory, path.basename(source));
    assert.equal(fs.readFileSync(heldSource).equals(REVIEW_BYTES), true);
    assert.equal(fs.existsSync(source), false);
    storage.unlinkPrivateFileNoFollow(heldSource);
    fs.rmdirSync(sourceDirectory);
    fs.rmdirSync(heldDirectory);
  }

  // FFmpeg receives only stdin/stdout bytes. Swapping either the source entry
  // or its parent after the protected read cannot redirect the converter.
  for (const sourceSwap of ["entry", "parent"] as const) {
    const user = await createUser(`conversion-source-${sourceSwap}`);
    const externalDirectory = path.join(path.dirname(context.canaryRoot), `external-input-${randomUUID()}`);
    const externalSource = sourceSwap === "entry"
      ? path.join(path.dirname(context.canaryRoot), `external-input-${randomUUID()}.bin`)
      : path.join(externalDirectory, "source.bin");
    if (sourceSwap === "parent") fs.mkdirSync(externalDirectory, { mode: 0o700 });
    writePrivate(externalSource, Buffer.from("external-input-must-not-be-read", "utf8"));
    let heldPath = "";
    let swapped = false;
    voices.setHeroVoiceCanaryConversionObserverForTests((step, paths) => {
      if (step === "after-secure-input-read") {
        if (sourceSwap === "entry") {
          heldPath = `${paths.rawSource}.held`;
          fs.renameSync(paths.rawSource, heldPath);
          fs.symlinkSync(externalSource, paths.rawSource);
        } else {
          heldPath = `${paths.stagingDirectory}-held`;
          fs.renameSync(paths.stagingDirectory, heldPath);
          fs.symlinkSync(externalDirectory, paths.stagingDirectory, "dir");
        }
        swapped = true;
      } else if (step === "before-secure-output-write") {
        if (sourceSwap === "entry") {
          fs.unlinkSync(paths.rawSource);
          fs.renameSync(heldPath, paths.rawSource);
        } else {
          fs.unlinkSync(paths.stagingDirectory);
          fs.renameSync(heldPath, paths.stagingDirectory);
        }
      }
    });
    const created = await voices.createUserVoice({
      userId: user.id,
      name: `Pipe source ${sourceSwap}`,
      refText: "synthetic pipe source transcript",
      audio: syntheticWav(),
      consent: true,
    });
    voices.setHeroVoiceCanaryConversionObserverForTests();
    assert.equal(swapped, true);
    assert.equal(fs.readFileSync(externalSource).equals(Buffer.from("external-input-must-not-be-read", "utf8")), true);
    assert.equal(await voices.deleteUserVoice(user.id, created.id), true);
    await prisma.user.delete({ where: { id: user.id } });
    fs.unlinkSync(externalSource);
    if (sourceSwap === "parent") fs.rmdirSync(externalDirectory);
  }

  // A substituted normalized entry or parent is rejected by the protected
  // writer before any external target can be opened or truncated.
  for (const destinationSwap of ["entry", "parent"] as const) {
    const user = await createUser(`conversion-destination-${destinationSwap}`);
    const externalDirectory = path.join(path.dirname(context.canaryRoot), `external-output-${randomUUID()}`);
    const externalTarget = destinationSwap === "entry"
      ? path.join(path.dirname(context.canaryRoot), `external-output-${randomUUID()}.wav`)
      : path.join(externalDirectory, "normalized.wav");
    if (destinationSwap === "parent") fs.mkdirSync(externalDirectory, { mode: 0o700 });
    const externalBytes = Buffer.from("external-output-must-not-be-truncated", "utf8");
    writePrivate(externalTarget, externalBytes);
    let heldStagingDirectory = "";
    let observedUpload: Readonly<{ rawSource: string; normalizedWav: string; stagingDirectory: string }> | undefined;
    voices.setHeroVoiceCanaryConversionObserverForTests((step, paths) => {
      if (step !== "before-secure-output-write") return;
      observedUpload = paths;
      if (destinationSwap === "entry") {
        fs.symlinkSync(externalTarget, paths.normalizedWav);
      } else {
        heldStagingDirectory = `${paths.stagingDirectory}-held`;
        fs.renameSync(paths.stagingDirectory, heldStagingDirectory);
        fs.symlinkSync(externalDirectory, paths.stagingDirectory, "dir");
      }
    });
    await assert.rejects(
      voices.createUserVoice({
        userId: user.id,
        name: `Pipe destination ${destinationSwap}`,
        refText: "synthetic pipe destination transcript",
        audio: syntheticWav(),
        consent: true,
      }),
      (error: unknown) => error instanceof voices.UserVoiceError
        && error.code === "USER_VOICE_STORAGE_FAILED",
    );
    voices.setHeroVoiceCanaryConversionObserverForTests();
    assert.equal(fs.readFileSync(externalTarget).equals(externalBytes), true);
    const intent = await prisma.deletionTransaction.findFirstOrThrow({
      where: { operationKind: "voice_upload", scopeUserId: user.id, status: "planned" },
      orderBy: { plannedAt: "desc" },
    });
    assert.ok(observedUpload);
    if (destinationSwap === "entry") {
      fs.unlinkSync(observedUpload.normalizedWav);
    } else {
      fs.unlinkSync(observedUpload.stagingDirectory);
      fs.renameSync(heldStagingDirectory, observedUpload.stagingDirectory);
    }
    coordinator.resetHeroVoiceDeletionCoordinatorForTests();
    assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "ready" });
    assert.equal(await prisma.userVoice.count({ where: { userId: user.id } }), 0);
    assert.equal((await prisma.deletionTransaction.findUniqueOrThrow({ where: { id: intent.id } })).status, "rolled_back");
    await prisma.user.delete({ where: { id: user.id } });
    fs.unlinkSync(externalTarget);
    if (destinationSwap === "parent") fs.rmdirSync(externalDirectory);
  }

  // Empty-directory removal holds no-follow descriptors for both the target
  // and parent. Entry and parent swaps are observed and rejected before rmdir.
  {
    const transactionId = randomUUID();
    const directory = path.dirname(storage.artifactQuarantinePath(context, transactionId, randomUUID()));
    const heldDirectory = `${directory}-held`;
    storage.setHeroVoiceCanaryFileOperationObserverForTests((step) => {
      if (step === "before-rmdir") {
        fs.renameSync(directory, heldDirectory);
        fs.mkdirSync(directory, { mode: 0o700 });
      }
    });
    assert.throws(
      () => storage.removeEmptyQuarantineDirectory(context, transactionId),
      (error: unknown) => error instanceof storage.HeroVoiceCanaryStorageError,
    );
    storage.setHeroVoiceCanaryFileOperationObserverForTests();
    assert.equal(fs.statSync(directory).isDirectory(), true);
    assert.equal(fs.statSync(heldDirectory).isDirectory(), true);
    fs.rmdirSync(directory);
    fs.renameSync(heldDirectory, directory);
    storage.removeEmptyQuarantineDirectory(context, transactionId);
  }
  {
    const transactionId = randomUUID();
    const upload = storage.heroVoiceCanaryUploadPaths(context, transactionId, true);
    const heldParent = `${context.uploadStagingRoot}-held-${randomUUID()}`;
    storage.setHeroVoiceCanaryFileOperationObserverForTests((step) => {
      if (step === "before-rmdir") {
        fs.renameSync(context.uploadStagingRoot, heldParent);
        fs.mkdirSync(context.uploadStagingRoot, { mode: 0o700 });
        fs.mkdirSync(upload.stagingDirectory, { mode: 0o700 });
      }
    });
    assert.throws(
      () => storage.removeEmptyUploadStagingDirectory(context, transactionId),
      (error: unknown) => error instanceof storage.HeroVoiceCanaryStorageError,
    );
    storage.setHeroVoiceCanaryFileOperationObserverForTests();
    assert.equal(fs.statSync(upload.stagingDirectory).isDirectory(), true);
    assert.equal(fs.statSync(path.join(heldParent, transactionId)).isDirectory(), true);
    fs.rmdirSync(upload.stagingDirectory);
    fs.rmdirSync(context.uploadStagingRoot);
    fs.renameSync(heldParent, context.uploadStagingRoot);
    storage.removeEmptyUploadStagingDirectory(context, transactionId);
  }

  // Native filesystem failures are collapsed to a fixed opaque error. Neither
  // thrown text nor captured logs may contain the injected absolute-path sentinel.
  const fsSentinel = `/absolute/private/${randomUUID()}/secret.wav`;
  const capturedFsLogs: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => { capturedFsLogs.push(values.map(String).join(" ")); };
  const expectOpaqueFailure = (operation: () => unknown) => {
    assert.throws(
      operation,
      (error: unknown) => error instanceof storage.HeroVoiceCanaryStorageError
        && error.message === "Hero Voice canary private storage is unavailable"
        && !String(error).includes(fsSentinel),
    );
    storage.setHeroVoiceCanaryFileOperationObserverForTests();
  };
  try {
    const renameSource = path.join(context.reviewRoot, `opaque-rename-${randomUUID()}.wav`);
    const renameDestination = path.join(context.reviewRoot, `opaque-renamed-${randomUUID()}.wav`);
    writePrivate(renameSource, REVIEW_BYTES);
    storage.setHeroVoiceCanaryFileOperationObserverForTests((step) => {
      if (step === "before-rename") throw new Error(fsSentinel);
    });
    expectOpaqueFailure(() => storage.renamePrivateFileNoFollow(renameSource, renameDestination));
    storage.unlinkPrivateFileNoFollow(renameSource);

    const unlinkSource = path.join(context.reviewRoot, `opaque-unlink-${randomUUID()}.wav`);
    writePrivate(unlinkSource, REVIEW_BYTES);
    storage.setHeroVoiceCanaryFileOperationObserverForTests((step) => {
      if (step === "before-unlink") throw new Error(fsSentinel);
    });
    expectOpaqueFailure(() => storage.unlinkPrivateFileNoFollow(unlinkSource));
    storage.unlinkPrivateFileNoFollow(unlinkSource);

    storage.setHeroVoiceCanaryFileOperationObserverForTests((step) => {
      if (step === "before-fsync") throw new Error(fsSentinel);
    });
    expectOpaqueFailure(() => storage.fsyncDirectory(context.reviewRoot));

    const rmdirTransactionId = randomUUID();
    storage.artifactQuarantinePath(context, rmdirTransactionId, randomUUID());
    storage.setHeroVoiceCanaryFileOperationObserverForTests((step) => {
      if (step === "before-rmdir") throw new Error(fsSentinel);
    });
    expectOpaqueFailure(() => storage.removeEmptyQuarantineDirectory(context, rmdirTransactionId));
    storage.removeEmptyQuarantineDirectory(context, rmdirTransactionId);

    const responseFixture = await createVoiceFixture("opaque-delete-response");
    storage.setHeroVoiceCanaryFileOperationObserverForTests((step) => {
      if (step === "before-rename") throw new Error(fsSentinel);
    });
    await assert.rejects(
      voices.deleteUserVoice(responseFixture.user.id, responseFixture.voiceId),
      (error: unknown) => error instanceof voices.UserVoiceError
        && error.code === "USER_VOICE_STORAGE_FAILED"
        && error.status === 500
        && !String(error).includes(fsSentinel)
        && !String(error).includes(responseFixture.pathname),
    );
    storage.setHeroVoiceCanaryFileOperationObserverForTests();
    coordinator.resetHeroVoiceDeletionCoordinatorForTests();
    assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "ready" });
    assert.equal(await prisma.userVoice.count({ where: { id: responseFixture.voiceId } }), 0);
  } finally {
    storage.setHeroVoiceCanaryFileOperationObserverForTests();
    console.error = originalConsoleError;
  }
  assert.equal(capturedFsLogs.join("\n").includes(fsSentinel), false);

  // SQLite settings are read back in the same canary context.
  const foreignKeys = await prisma.$queryRawUnsafe<Array<{ foreign_keys: bigint }>>("PRAGMA foreign_keys");
  const journal = await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode");
  const synchronous = await prisma.$queryRawUnsafe<Array<{ synchronous: bigint }>>("PRAGMA synchronous");
  assert.equal(Number(foreignKeys[0].foreign_keys), 1);
  assert.equal(journal[0].journal_mode.toLowerCase(), "wal");
  assert.equal(Number(synchronous[0].synchronous), 2);
  for (const suffix of ["-wal", "-shm"] as const) {
    const sidecar = `${context.databasePath}${suffix}`;
    if (fs.existsSync(sidecar)) assert.equal(fs.statSync(sidecar).mode & 0o777, 0o600);
  }

  const receipts = await prisma.deletionTransaction.findMany({ where: { status: "done" } });
  assert.ok(receipts.length >= crashSteps.length * 3);
  for (const receipt of receipts) {
    assert.equal(receipt.scopeUserId, null);
    assert.equal(receipt.scopeVoiceId, null);
    assert.equal(receipt.scopeReviewRunId, null);
    assert.equal(receipt.scopeOwnerHmac, null);
    assert.ok(receipt.receiptJson);
    assert.doesNotMatch(receipt.receiptJson!, /subject-|@example\.invalid|synthetic-private|\.wav|private-references|private-review/u);
    const parsed = JSON.parse(receipt.receiptJson!);
    assert.deepEqual(Object.keys(parsed).sort(), [
      "artifactSha256", "dbCommittedAt", "doneAt", "outcome", "plannedAt", "receiptId", "transactionId", "version",
    ]);
  }
  assert.equal(await prisma.deletionTransaction.count({ where: { status: { in: ["planned", "db_committed"] } } }), 0);

  // Startup does not silently repair a database with over-broad permissions.
  fs.chmodSync(context.databasePath, 0o644);
  coordinator.resetHeroVoiceDeletionCoordinatorForTests();
  assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "read_only" });
  fs.chmodSync(context.databasePath, 0o600);
  coordinator.resetHeroVoiceDeletionCoordinatorForTests();
  assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "ready" });

  // A bad marker makes startup sticky read-only and blocks mutations.
  await prisma.siteConfig.update({
    where: { key: storage.HERO_VOICE_CANARY_DATABASE_MARKER_KEY },
    data: { value: "not-a-canary" },
  });
  coordinator.resetHeroVoiceDeletionCoordinatorForTests();
  assert.deepEqual(await coordinator.initializeHeroVoiceDeletionCoordinator(), { mode: "read_only" });
  await assert.rejects(
    coordinator.assertHeroVoiceCanaryMutationReady(),
    (error: unknown) => error instanceof coordinator.HeroVoiceCanaryReadOnlyError,
  );

  await prisma.$disconnect();
  console.log("Hero Voice same-SQLite deletion/recovery crash matrix passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
