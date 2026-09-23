import assert from "node:assert/strict";

import {
  avatarCheckpointRouting,
  avatarProviderIdempotencyKey,
  parseAvatarProviderCheckpoint,
  providerPollDelayMs,
  serializeAvatarProviderCheckpoint,
  videoJobInputFingerprint,
  videoJobScriptFingerprint,
} from "../src/lib/mcp/avatar-provider-checkpoint";

const validObject = {
  version: 1,
  provider: "heygen",
  phase: "intro_wait",
  providerStartedAt: "2026-07-13T08:00:00.000Z",
  providerDeadlineAt: "2026-07-13T10:00:00.000Z",
  baseUrl: "/api/renders/base.mp4",
  voiceUrl: "/api/renders/voice.mp3",
  audioDurationMs: 90_000,
  captions: [{ text: "ทดสอบ", startMs: 0, endMs: 900 }],
  words: [],
  fullText: "ทดสอบ",
  baseConfig: { voiceFile: "/api/renders/voice.mp3" },
  avatar: {
    mode: "full",
    id: "avatar-1",
    introSecs: 5,
    tailSecs: 5,
    layout: { scale: 1, offsetX: 0, offsetY: 0 },
    introVideoId: "hg-1",
  },
} as const;

const valid = JSON.stringify(validObject);
const parsed = parseAvatarProviderCheckpoint(valid);
assert.equal(parsed?.avatar.introVideoId, "hg-1");
assert.deepEqual(avatarCheckpointRouting(parsed!), { engine: "avatar_iii", apiVersion: "v2" }, "missing routing stays legacy III/v2");
assert.equal(parseAvatarProviderCheckpoint(serializeAvatarProviderCheckpoint(parsed!))?.phase, "intro_wait");
assert.equal(parseAvatarProviderCheckpoint("{"), null);
assert.equal(parseAvatarProviderCheckpoint(JSON.stringify({ version: 1 })), null);

const missingWaitId = structuredClone(validObject) as Record<string, unknown>;
missingWaitId.avatar = {
  ...(missingWaitId.avatar as Record<string, unknown>),
  introVideoId: undefined,
};
assert.equal(parseAvatarProviderCheckpoint(JSON.stringify(missingWaitId)), null);

const validGenerate = structuredClone(validObject) as Record<string, unknown>;
validGenerate.phase = "intro_generate";
validGenerate.avatar = {
  ...(validGenerate.avatar as Record<string, unknown>),
  introVideoId: undefined,
};
assert.equal(parseAvatarProviderCheckpoint(JSON.stringify(validGenerate))?.phase, "intro_generate");

const v3Generate = structuredClone(validGenerate) as Record<string, unknown>;
v3Generate.avatar = {
  ...(v3Generate.avatar as Record<string, unknown>),
  engine: "avatar_v",
  apiVersion: "v3",
  introIdempotencyKey: "stable-v3-intro-key",
};
const parsedV3 = parseAvatarProviderCheckpoint(JSON.stringify(v3Generate));
assert.deepEqual(parsedV3 && avatarCheckpointRouting(parsedV3), { engine: "avatar_v", apiVersion: "v3" });
const mismatched = structuredClone(v3Generate) as Record<string, unknown>;
(mismatched.avatar as Record<string, unknown>).apiVersion = "v2";
assert.equal(parseAvatarProviderCheckpoint(JSON.stringify(mismatched)), null, "v3 engine cannot resume on a v2 route");

const introKey = avatarProviderIdempotencyKey({ accountId: "u1", jobId: "j1", slot: "intro", engine: "avatar_v", avatarId: "look", audioUrl: "/renders/intro.mp3" });
const sameIntroKey = avatarProviderIdempotencyKey({ accountId: "u1", jobId: "j1", slot: "intro", engine: "avatar_v", avatarId: "look", audioUrl: "/renders/intro.mp3" });
const changedBodyKey = avatarProviderIdempotencyKey({ accountId: "u1", jobId: "j1", slot: "intro", engine: "avatar_v", avatarId: "look", audioUrl: "/renders/changed.mp3" });
const tailKey = avatarProviderIdempotencyKey({ accountId: "u1", jobId: "j1", slot: "tail", engine: "avatar_v", avatarId: "look", audioUrl: "/renders/intro.mp3" });
assert.equal(introKey, sameIntroKey, "logical create key is stable");
assert.notEqual(introKey, changedBodyKey, "changed request body gets a different key");
assert.notEqual(introKey, tailKey, "intro and tail have separate logical create keys");
assert.equal(introKey.includes("u1") || introKey.includes("j1"), false, "provider key does not expose account/job ids");

assert.equal(providerPollDelayMs(0, 9 * 60_000), 15_000);
assert.equal(providerPollDelayMs(0, 20 * 60_000), 30_000);
assert.equal(providerPollDelayMs(0, 40 * 60_000), 60_000);
assert.equal(providerPollDelayMs(0, 1_000, 120), 120_000);
assert.equal(providerPollDelayMs(0, 1_000, 999), 120_000);

const fingerprintA = videoJobInputFingerprint('{"script":"x","avatarMode":"full","nested":{"b":2,"a":1}}');
const fingerprintB = videoJobInputFingerprint('{"nested":{"a":1,"b":2},"avatarMode":"full","script":"x"}');
assert.equal(fingerprintA, fingerprintB);
assert.notEqual(fingerprintA, videoJobInputFingerprint('{"script":"x","avatarMode":"bookend"}'));

assert.equal(
  videoJobScriptFingerprint('{"script":"x","avatarMode":"full"}'),
  videoJobScriptFingerprint('{"script":"x","avatarMode":"bookend","previewMode":true}'),
);
assert.notEqual(videoJobScriptFingerprint('{"script":"x"}'), videoJobScriptFingerprint('{"script":"y"}'));
assert.equal(videoJobScriptFingerprint('{'), null);
assert.equal(videoJobScriptFingerprint('{"avatarMode":"full"}'), null);

console.log("ALL PASS");
