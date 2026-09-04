import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
const migration = fs.readFileSync(
  "prisma/migrations/20260904070000_hero_voice_canary_deletion_recovery/migration.sql",
  "utf8",
);
const coordinator = fs.readFileSync("src/lib/hero-voice-deletion-coordinator.server.ts", "utf8");
const canaryStorage = fs.readFileSync("src/lib/hero-voice-canary-storage.server.ts", "utf8");
const userVoices = fs.readFileSync("src/lib/user-voices.server.ts", "utf8");
const accountDelete = fs.readFileSync("src/lib/account-hard-delete.server.ts", "utf8");
const generation = fs.readFileSync("src/lib/hero-voice-generation.server.ts", "utf8");
const clerkAuth = fs.readFileSync("src/lib/clerk-auth.ts", "utf8");
const instrumentation = fs.readFileSync("src/instrumentation.ts", "utf8");

assert.match(schema, /model DeletionTransaction\s*\{/u);
assert.match(schema, /model DeletionArtifact\s*\{/u);
assert.match(schema, /model ReviewRun\s*\{/u);
assert.match(schema, /deletionTransactionId\s+String\?/u);
assert.match(migration, /ALTER TABLE "UserVoice" ADD COLUMN "deletionTransactionId"/u);
assert.match(coordinator, /PRAGMA foreign_keys = ON/u);
assert.match(coordinator, /PRAGMA journal_mode = WAL/u);
assert.match(coordinator, /PRAGMA synchronous = FULL/u);
assert.match(coordinator, /computeHeroVoiceCanaryOwnerHmac/u);
assert.match(coordinator, /creditBalance\.deleteMany/u);
assert.match(coordinator, /creditLedger\.deleteMany/u);
assert.match(coordinator, /reviewRun\.deleteMany\(\{ where: \{ ownerHmac/u);
assert.match(coordinator, /runHeroVoiceCanarySerializedMutation/u);
assert.match(coordinator, /configurationHmac: reviewConfigurationHmac\(\)/u);
assert.match(coordinator, /HERO_VOICE_CANARY_STORAGE_BINDING_KEY/u);
assert.match(coordinator, /requireDurableStorageBinding/u);
assert.match(coordinator, /operationKind: "voice_upload"/u);
assert.match(coordinator, /parseSanitizedReviewAggregates/u);
assert.match(canaryStorage, /O_NOFOLLOW/u);
assert.match(canaryStorage, /fstatSync/u);
assert.match(canaryStorage, /sameInode/u);
assert.match(canaryStorage, /assertCanaryContainedPath/u);
assert.match(canaryStorage, /openStablePrivateDirectory/u);
assert.match(canaryStorage, /renamePrivateFileNoFollow/u);
assert.match(canaryStorage, /unlinkPrivateFileNoFollow/u);
assert.match(canaryStorage, /removeEmptyPrivateDirectory/u);
assert.match(canaryStorage, /\.voice-upload-staging-v1/u);
assert.match(userVoices, /deleteHeroVoiceCanaryVoice\(userId, id\)/u);
assert.match(userVoices, /runHeroVoiceCanarySerializedMutation\(\(\) => createUserVoiceUnlocked/u);
assert.match(userVoices, /createCanaryUserVoice/u);
assert.match(userVoices, /"-i", "pipe:0"/u);
assert.match(userVoices, /"pipe:1"/u);
assert.match(userVoices, /normalizeCanaryReferenceWav\(rawSource\)/u);
assert.match(userVoices, /writeNewPrivateFileNoFollow\(upload\.normalizedWav, wav\)/u);
assert.match(userVoices, /after-upload-final-rename/u);
assert.match(generation, /deletionTransactionId: null/u);
assert.match(generation, /assertNoCanaryAccountDeletionInTransaction/u);
assert.match(generation, /runHeroVoiceCanarySerializedMutation\(\(\) => startHeroVoiceGenerationUnlocked/u);
assert.match(clerkAuth, /runHeroVoiceCanarySerializedMutation\(\(\) => getCurrentUserForClerkId/u);
assert.match(accountDelete, /hardDeleteUserWithHeroVoiceCanaryArtifacts/u);
assert.match(instrumentation, /initializeHeroVoiceDeletionCoordinator/u);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hero-voice-deletion-"));
const databasePath = path.join(root, "canary.sqlite");
const voiceRoot = path.join(root, "private-references");
const reviewRoot = path.join(root, "private-review");
fs.mkdirSync(voiceRoot, { mode: 0o700 });
fs.mkdirSync(reviewRoot, { mode: 0o700 });
const env = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: `file:${databasePath}?connection_limit=1`,
  HERO_VOICE_CANARY_EXECUTION_MODE: "1",
  HERO_VOICE_CANARY_ROOT: root,
  HERO_VOICE_CANARY_REVIEW_ROOT: reviewRoot,
  HERO_VOICE_CANARY_REVIEW_KEY: Buffer.alloc(32, 7).toString("base64url"),
  HERO_VOICE_CANARY_AUTH_ISSUER: "https://test.clerk.invalid",
  USER_VOICE_STORAGE_DIR: voiceRoot,
};

try {
  const pushed = spawnSync(
    "npx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
  if (pushed.status !== 0) {
    process.stderr.write(pushed.stdout);
    process.stderr.write(pushed.stderr);
    process.exit(pushed.status ?? 1);
  }
  fs.chmodSync(databasePath, 0o600);
  const runtime = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "scripts/verify-hero-voice-deletion-runtime.ts"],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
  process.stdout.write(runtime.stdout);
  process.stderr.write(runtime.stderr);
  process.exitCode = runtime.status ?? 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
