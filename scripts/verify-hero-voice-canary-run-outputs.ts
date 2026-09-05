import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeHeroVoiceCanaryRunOutput, readHeroVoiceCanaryRunOutput } from "../src/lib/hero-voice-canary-run-outputs.server";
import { prisma } from "../src/lib/prisma";
import { buildHeroVoiceCanaryManifest, HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT } from "../src/lib/hero-voice-canary-manifest";
import { heroVoiceCanarySha256 } from "../src/lib/hero-voice-canary-canonical";
import { createHeroVoiceCanaryRun, commitHeroVoiceCanaryDispatchIntent, recordHeroVoiceCanarySubmission } from "../src/lib/hero-voice-canary-ledger.server";
import { prepareHeroVoiceCanaryWireRequest } from "../src/lib/hero-voice-canary-wire";
import {
  initializeHeroVoiceDeletionCoordinator, computeHeroVoiceCanaryOwnerHmac,
  resetHeroVoiceDeletionCoordinatorForTests, closeHeroVoiceCanaryReviewRun,
  hardDeleteHeroVoiceCanaryAccount, setHeroVoiceDeletionCrashObserverForTests,
  HeroVoiceDeletionSimulatedCrash, type HeroVoiceDeletionCrashStep,
} from "../src/lib/hero-voice-deletion-coordinator.server";
import { setHeroVoiceCanaryFileOperationObserverForTests } from "../src/lib/hero-voice-canary-storage.server";

assert.equal(typeof writeHeroVoiceCanaryRunOutput, "function");
assert.equal(typeof readHeroVoiceCanaryRunOutput, "function");

function wav(fill = 1) {
  const bytes = Buffer.alloc(92, fill);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24); bytes.writeUInt32LE(48_000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(48, 40);
  return bytes;
}
const claims = { authIssuer: "https://test.clerk.invalid", authSubject: "user_output_tester" };

function child(args: string[], env = process.env) {
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/verify-hero-voice-canary-run-outputs.ts", ...args], {
    env, encoding: "utf8", timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function newAcceptedRun() {
  const ownerHmac = computeHeroVoiceCanaryOwnerHmac(claims);
  const reference = Buffer.from("synthetic-reference-only");
  const built = buildHeroVoiceCanaryManifest({
    experimentId: `experiment-${randomUUID()}`, referenceSha256: heroVoiceCanarySha256(reference),
    refTextSha256: heroVoiceCanarySha256(HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT),
    baseline: { endpointId: "baseline-endpoint", templateId: "baseline-template", imageDigest: `sha256:${"a".repeat(64)}` },
    candidate: { endpointId: "candidate-endpoint", templateId: "candidate-template", imageDigest: `sha256:${"b".repeat(64)}`,
      sourceRevision: "8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb", modelManifestSha256: "c".repeat(64) },
    rateUsdMicrosPerSecond: 100, nonGpuReserveComponents: [{ name: "registry", usdMicros: 1000, evidenceSha256: "e".repeat(64) }],
  });
  const runId = `run-${randomUUID()}`;
  await createHeroVoiceCanaryRun({ runId, ownerHmac, referenceVoiceId: `user_${randomUUID()}`, ...built });
  const slot = built.manifest.slots[0];
  const scope = { runId, ownerHmac, slotId: slot.slotId };
  await commitHeroVoiceCanaryDispatchIntent({ ...scope, prepared: prepareHeroVoiceCanaryWireRequest({ slot, referenceWav: reference, refText: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT }) });
  await assert.rejects(writeHeroVoiceCanaryRunOutput({ ...scope, providerJobId: "provider-output", audio: wav() }));
  await recordHeroVoiceCanarySubmission({ ...scope, disposition: "provider_accepted", providerJobId: "provider-output" });
  return { ...scope, providerJobId: "provider-output", audio: wav() };
}

async function stop(runId: string) {
  await prisma.reviewRun.update({ where: { id: runId }, data: { runState: "aborted_no_go", inFlightSlotId: null, parkDisposition: "confirmed" } });
}

async function runtime() {
  await prisma.siteConfig.create({ data: { key: "hero_voice_canary_database_marker", value: "hero-voice-canary-v1" } });
  assert.equal((await initializeHeroVoiceDeletionCoordinator()).mode, "ready");
  await prisma.user.create({ data: { id: "output-tester", clerkId: claims.authSubject, name: "Synthetic", email: "output@test.invalid" } });
  const input = await newAcceptedRun();
  for (const bad of [
    { ...input, ownerHmac: "f".repeat(64) }, { ...input, runId: "missing" },
    { ...input, slotId: "final.candidate.script-01.repeat-01" }, { ...input, slotId: "../escape" },
    { ...input, providerJobId: "wrong-provider" }, { ...input, audio: Buffer.alloc(7_000_001) },
    { ...input, audio: Buffer.from("RIFF-invalid") },
  ]) await assert.rejects(writeHeroVoiceCanaryRunOutput(bad));
  const stereo = wav(); stereo.writeUInt16LE(2, 22);
  const wrongRate = wav(); wrongRate.writeUInt32LE(48_000, 24);
  const submillisecond = wav().subarray(0, 46); submillisecond.writeUInt32LE(38, 4); submillisecond.writeUInt32LE(2, 40);
  for (const audio of [stereo, wrongRate, wav().subarray(0, 91), submillisecond]) await assert.rejects(writeHeroVoiceCanaryRunOutput({ ...input, audio }));
  assert.equal(await prisma.canaryRunOutput.count(), 0);
  const observed = await writeHeroVoiceCanaryRunOutput(input);
  assert.deepEqual(observed, { audioSha256: heroVoiceCanarySha256(wav()), durationMs: 1 });
  assert.deepEqual(await readHeroVoiceCanaryRunOutput(input), wav());
  const row = await prisma.canaryRunOutput.findUniqueOrThrow({ where: { runId_slotId: { runId: input.runId, slotId: input.slotId } } });
  const filename = path.join(process.env.HERO_VOICE_CANARY_REVIEW_ROOT!, row.storageKey);
  const inode = fs.statSync(filename).ino;
  await Promise.all([writeHeroVoiceCanaryRunOutput(input), writeHeroVoiceCanaryRunOutput(input)]);
  assert.equal(fs.statSync(filename).ino, inode);
  assert.equal(await prisma.canaryRunOutput.count({ where: { runId: input.runId } }), 1);
  fs.writeFileSync(filename, wav(2));
  await assert.rejects(readHeroVoiceCanaryRunOutput(input));
  await assert.rejects(writeHeroVoiceCanaryRunOutput(input));
  fs.writeFileSync(filename, wav());
  await assert.rejects(writeHeroVoiceCanaryRunOutput({ ...input, audio: wav(2) }));
  await assert.rejects(readHeroVoiceCanaryRunOutput({ ...input, ownerHmac: "f".repeat(64) }));
  await assert.rejects(readHeroVoiceCanaryRunOutput({ ...input, slotId: "ablation.reference-enhancement.delta.script-01" }));
  await assert.rejects(closeHeroVoiceCanaryReviewRun({ ...input, expectedRevision: 1 }));
  await stop(input.runId);
  await closeHeroVoiceCanaryReviewRun({ ...input, expectedRevision: 1 });
  assert.equal(fs.existsSync(filename), false);
  assert.equal(await prisma.canaryRunOutput.count({ where: { runId: input.runId } }), 0);
  assert.equal((await prisma.reviewRun.findUniqueOrThrow({ where: { id: input.runId } })).sanitizedAggregatesJson, null);
  await assert.rejects(writeHeroVoiceCanaryRunOutput(input));
  await assert.rejects(readHeroVoiceCanaryRunOutput(input));

  for (const point of ["after-run-output-intent", "after-create", "after-write", "after-rename", "after-run-output-bytes", "after-run-output-row-commit"] as const) {
    const crashInput = await newAcceptedRun();
    if (["after-create", "after-write", "after-rename"].includes(point)) setHeroVoiceCanaryFileOperationObserverForTests((step) => {
      if (step === point) throw new Error("synthetic_partial_write_crash");
    });
    else setHeroVoiceDeletionCrashObserverForTests((step) => {
      if (step === point) throw new HeroVoiceDeletionSimulatedCrash(step);
    });
    await assert.rejects(writeHeroVoiceCanaryRunOutput(crashInput));
    setHeroVoiceCanaryFileOperationObserverForTests();
    setHeroVoiceDeletionCrashObserverForTests();
    await prisma.$disconnect();
    child(["--recover", crashInput.runId, crashInput.slotId, point === "after-run-output-row-commit" ? "committed" : "rolled_back"]);
    resetHeroVoiceDeletionCoordinatorForTests();
    assert.equal((await initializeHeroVoiceDeletionCoordinator()).mode, "ready");
    await stop(crashInput.runId);
    await closeHeroVoiceCanaryReviewRun({ ...crashInput, expectedRevision: 1 });
  }

  for (const step of ["after-transaction-a", "after-move", "after-transaction-b", "after-unlink"] as HeroVoiceDeletionCrashStep[]) {
    const crashInput = await newAcceptedRun();
    await writeHeroVoiceCanaryRunOutput(crashInput);
    await stop(crashInput.runId);
    setHeroVoiceDeletionCrashObserverForTests((observedStep) => {
      if (observedStep === step) throw new HeroVoiceDeletionSimulatedCrash(step);
    });
    await assert.rejects(closeHeroVoiceCanaryReviewRun({ ...crashInput, expectedRevision: 1 }));
    setHeroVoiceDeletionCrashObserverForTests();
    await prisma.$disconnect();
    child(["--recover", crashInput.runId, crashInput.slotId, "closed"]);
    resetHeroVoiceDeletionCoordinatorForTests();
    assert.equal((await initializeHeroVoiceDeletionCoordinator()).mode, "ready");
  }

  const accountInput = await newAcceptedRun();
  await writeHeroVoiceCanaryRunOutput(accountInput);
  const accountRow = await prisma.canaryRunOutput.findFirstOrThrow({ where: { runId: accountInput.runId } });
  // A declared intermediate recreated after commit is still enumerated by deletion.
  fs.writeFileSync(path.join(process.env.HERO_VOICE_CANARY_REVIEW_ROOT!, accountRow.stagingStorageKey), Buffer.from("synthetic-intermediate"), { mode: 0o600, flag: "wx" });
  setHeroVoiceDeletionCrashObserverForTests((step) => { if (step === "after-transaction-b") throw new HeroVoiceDeletionSimulatedCrash(step); });
  await assert.rejects(hardDeleteHeroVoiceCanaryAccount({ ...claims, userId: "output-tester" }));
  setHeroVoiceDeletionCrashObserverForTests();
  await prisma.$disconnect();
  child(["--recover", accountInput.runId, accountInput.slotId, "deleted"]);
  resetHeroVoiceDeletionCoordinatorForTests();
  await assert.rejects(writeHeroVoiceCanaryRunOutput(accountInput));
  assert.deepEqual(fs.readdirSync(process.env.HERO_VOICE_CANARY_REVIEW_ROOT!), []);
  assert.equal(await prisma.canaryRunOutput.count(), 0);
  console.log("PASS direct-output WAV/authority/immutability, process restart recovery, explicit aborted close and account deletion");
}

async function recover() {
  assert.equal((await initializeHeroVoiceDeletionCoordinator()).mode, "ready");
  const [runId, slotId, outcome] = process.argv.slice(3);
  const scope = { runId, slotId, ownerHmac: computeHeroVoiceCanaryOwnerHmac(claims) };
  assert.equal(await prisma.deletionTransaction.count({ where: { status: { in: ["planned", "db_committed"] } } }), 0);
  if (outcome === "committed") assert.deepEqual(await readHeroVoiceCanaryRunOutput(scope), wav());
  else {
    await assert.rejects(readHeroVoiceCanaryRunOutput(scope));
    assert.equal(await prisma.canaryRunOutput.count({ where: { runId } }), 0);
  }
  if (outcome === "closed") assert.equal((await prisma.reviewRun.findUniqueOrThrow({ where: { id: runId } })).state, "closed");
  if (outcome === "deleted") assert.equal(await prisma.user.count({ where: { id: "output-tester" } }), 0);
}

async function main() {
  if (process.argv[2] === "--runtime") return runtime();
  if (process.argv[2] === "--recover") return recover();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hero-canary-output-test-"));
  const database = path.join(root, "canary.sqlite");
  const references = path.join(root, "references");
  const review = path.join(root, "review");
  fs.mkdirSync(references, { mode: 0o700 }); fs.mkdirSync(review, { mode: 0o700 });
  const env = { ...process.env, NODE_ENV: "test", DATABASE_URL: `file:${database}?connection_limit=1`,
    HERO_VOICE_CANARY_EXECUTION_MODE: "1", HERO_VOICE_CANARY_ROOT: root,
    HERO_VOICE_CANARY_REVIEW_ROOT: review, USER_VOICE_STORAGE_DIR: references,
    HERO_VOICE_CANARY_REVIEW_KEY: Buffer.alloc(32, 7).toString("base64url"), HERO_VOICE_CANARY_AUTH_ISSUER: claims.authIssuer };
  try {
    const pushed = spawnSync("npx", ["prisma", "db", "push", "--skip-generate"], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(pushed.status, 0, pushed.stderr);
    fs.chmodSync(database, 0o600);
    child(["--runtime"], env);
    console.log("PASS synthetic private direct-output SQLite suite");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
