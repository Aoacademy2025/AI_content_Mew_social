import assert from "node:assert/strict";

import {
  advanceAvatarProvider,
  type AvatarCompositeAttemptResult,
  type AvatarProviderAdvanceDeps,
  type AvatarProviderGenerateResult,
} from "../src/lib/mcp/avatar-provider-resume";
import type { AvatarProviderCheckpointV1 } from "../src/lib/mcp/avatar-provider-checkpoint";

function checkpoint(
  phase: AvatarProviderCheckpointV1["phase"] = "intro_wait",
  mode: AvatarProviderCheckpointV1["avatar"]["mode"] = "full",
): AvatarProviderCheckpointV1 {
  return {
    version: 1,
    provider: "heygen",
    phase,
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
      mode,
      id: "avatar-1",
      introSecs: 5,
      tailSecs: 5,
      layout: { scale: 1, offsetX: 0, offsetY: 0 },
      introAudioUrl: "/api/renders/intro.mp3",
      tailAudioUrl: mode === "bookend-both" ? "/api/renders/tail.mp3" : undefined,
      introVideoId: phase === "intro_generate" ? undefined : "hg-intro",
    },
  };
}

function accepted(providerVideoId: string): AvatarProviderGenerateResult {
  return { kind: "accepted", providerVideoId };
}

async function main() {
  // A persisted provider ID is polled, never generated again—even after a worker restart.
  let generateCalls = 0;
  let compositeCalls = 0;
  const persisted: AvatarProviderCheckpointV1[] = [];
  const pendingDeps: AvatarProviderAdvanceDeps = {
    now: () => new Date("2026-07-13T09:20:00.000Z"),
    generate: async () => { generateCalls++; return accepted("unexpected"); },
    poll: async () => ({ status: "processing", videoUrl: null, errorMsg: null }),
    composite: async () => {
      compositeCalls++;
      return { kind: "completed", videoUrl: "/api/renders/composite.mp4" };
    },
    persist: async (value) => { persisted.push(value); return true; },
  };
  const pending = await advanceAvatarProvider(checkpoint(), pendingDeps);
  assert.equal(pending.kind, "waiting");
  assert.equal(generateCalls, 0);
  assert.equal(compositeCalls, 0);
  const restarted = await advanceAvatarProvider(checkpoint(), pendingDeps);
  assert.equal(restarted.kind, "waiting");
  assert.equal(generateCalls, 0);

  // Completion persists the composite phase before invoking composite.
  const completed = await advanceAvatarProvider(checkpoint(), {
    ...pendingDeps,
    poll: async () => ({
      status: "completed",
      videoUrl: "https://files2.heygen.ai/intro.mp4",
      errorMsg: null,
    }),
  });
  assert.equal(completed.kind, "ready");
  assert.equal(completed.kind === "ready" ? completed.compositeUrl : null, "/api/renders/composite.mp4");
  assert.equal(generateCalls, 0);
  assert.equal(compositeCalls, 1);
  assert.equal(persisted.at(-1)?.phase, "composite");

  // A fresh generate is allowed only in the same uninterrupted call that persisted intent.
  generateCalls = 0;
  const fresh = await advanceAvatarProvider(checkpoint("intro_generate"), {
    ...pendingDeps,
    allowGenerate: true,
    generate: async () => { generateCalls++; return accepted("hg-intro"); },
  });
  assert.equal(fresh.kind, "waiting");
  assert.equal(fresh.kind === "waiting" ? fresh.checkpoint.avatar.introVideoId : null, "hg-intro");
  assert.equal(generateCalls, 1);

  const v3Fresh = checkpoint("intro_generate");
  v3Fresh.avatar.engine = "avatar_v";
  v3Fresh.avatar.apiVersion = "v3";
  v3Fresh.avatar.introIdempotencyKey = "stable-v3-intro";
  const v3Order: string[] = [];
  let seenRouting: unknown;
  const v3Started = await advanceAvatarProvider(v3Fresh, {
    ...pendingDeps,
    allowGenerate: true,
    upload: async (_avatarId, audioUrl, routing) => {
      v3Order.push("upload");
      assert.equal(audioUrl, "/api/renders/intro.mp3");
      assert.deepEqual(routing, { engine: "avatar_v", apiVersion: "v3" });
      return { kind: "accepted", audioAssetId: "persisted-v3-intro-asset" };
    },
    persist: async (value) => {
      v3Order.push(value.avatar.introAudioAssetId ? "persist:asset" : `persist:${value.phase}`);
      return true;
    },
    generate: (async (_avatarId: string, audioAssetId: string, routing: unknown) => {
      v3Order.push("create");
      assert.equal(audioAssetId, "persisted-v3-intro-asset", "paid create receives only the persisted asset identity");
      seenRouting = routing;
      return accepted("hg-v3");
    }) as unknown as AvatarProviderAdvanceDeps["generate"],
  });
  assert.equal(v3Started.kind, "waiting");
  assert.deepEqual(seenRouting, { engine: "avatar_v", apiVersion: "v3", idempotencyKey: "stable-v3-intro" });
  assert.deepEqual(v3Order, ["upload", "persist:asset", "create", "persist:asset"], "upload asset is durably persisted before paid create");
  assert.equal(v3Started.kind === "waiting" ? v3Started.checkpoint.avatar.introAudioAssetId : null, "persisted-v3-intro-asset");

  let blockedCreateCalls = 0;
  const persistenceLost = await advanceAvatarProvider(v3Fresh, {
    ...pendingDeps,
    allowGenerate: true,
    upload: async () => ({ kind: "accepted", audioAssetId: "unpersisted-asset" }),
    persist: async () => false,
    generate: async () => { blockedCreateCalls += 1; return accepted("must-not-create"); },
  });
  assert.equal(persistenceLost.kind, "failed");
  assert.equal(blockedCreateCalls, 0, "losing the asset checkpoint guard prevents paid create");

  const persistenceErrored = await advanceAvatarProvider(v3Fresh, {
    ...pendingDeps,
    allowGenerate: true,
    upload: async () => ({ kind: "accepted", audioAssetId: "unpersisted-asset" }),
    persist: async () => { throw new Error("database unavailable"); },
    generate: async () => { blockedCreateCalls += 1; return accepted("must-not-create"); },
  });
  assert.equal(persistenceErrored.kind === "failed" ? persistenceErrored.outcome : null, "definitive", "checkpoint write failure remains a known pre-create failure");
  assert.equal(blockedCreateCalls, 0, "checkpoint write failure prevents paid create");

  const restartWithAsset = checkpoint("intro_generate");
  restartWithAsset.avatar.engine = "avatar_v";
  restartWithAsset.avatar.apiVersion = "v3";
  restartWithAsset.avatar.introIdempotencyKey = "stable-v3-intro";
  restartWithAsset.avatar.introAudioAssetId = "persisted-v3-intro-asset";
  let restartExternalCalls = 0;
  const parkedRestart = await advanceAvatarProvider(restartWithAsset, {
    ...pendingDeps,
    upload: async () => { restartExternalCalls += 1; return { kind: "accepted", audioAssetId: "duplicate" }; },
    generate: async () => { restartExternalCalls += 1; return accepted("duplicate"); },
  });
  assert.equal(parkedRestart.kind, "failed");
  assert.equal(parkedRestart.kind === "failed" ? parkedRestart.outcome : null, "unknown");
  assert.equal(restartExternalCalls, 0, "restart after persisted asset never uploads or resubmits the paid create");

  const quotaRejected = await advanceAvatarProvider(checkpoint("intro_generate"), {
    ...pendingDeps,
    allowGenerate: true,
    generate: async () => ({
      kind: "rejected",
      code: "quota",
      message: "เครดิต HeyGen ไม่เพียงพอสำหรับสร้าง Avatar",
    }),
  });
  assert.equal(quotaRejected.kind, "failed");
  assert.equal(quotaRejected.kind === "failed" ? quotaRejected.code : null, "quota");
  assert.equal(quotaRejected.kind === "failed" ? quotaRejected.outcome : null, "definitive");

  const transportLost = await advanceAvatarProvider(checkpoint("intro_generate"), {
    ...pendingDeps,
    allowGenerate: true,
    generate: async () => { throw new Error("socket closed"); },
  });
  assert.equal(transportLost.kind, "failed");
  assert.equal(transportLost.kind === "failed" ? transportLost.outcome : null, "unknown");
  assert.match(transportLost.kind === "failed" ? transportLost.message : "", /unknown provider outcome/);

  const pollQuotaRejected = await advanceAvatarProvider(checkpoint("intro_wait"), {
    ...pendingDeps,
    poll: async () => ({
      status: "failed",
      videoUrl: null,
      errorMsg: "เครดิต HeyGen ไม่เพียงพอ",
      errorCode: "quota",
    }),
  });
  assert.equal(pollQuotaRejected.kind, "failed");
  assert.equal(pollQuotaRejected.kind === "failed" ? pollQuotaRejected.code : null, "quota");
  assert.equal(pollQuotaRejected.kind === "failed" ? pollQuotaRejected.provider : null, "heygen");
  assert.equal(pollQuotaRejected.kind === "failed" ? pollQuotaRejected.outcome : null, "definitive");

  const stranded = await advanceAvatarProvider(checkpoint("intro_generate"), {
    ...pendingDeps,
    generate: async () => { generateCalls++; return accepted("must-not-run"); },
  });
  assert.equal(stranded.kind, "failed");
  assert.match(stranded.kind === "failed" ? stranded.message : "", /unknown provider outcome/);
  assert.equal(generateCalls, 1);

  // bookend-both: intro completion persists tail_generate, generates tail exactly once,
  // then a restarted tail_wait only polls the stored tail ID.
  generateCalls = 0;
  compositeCalls = 0;
  const both = checkpoint("intro_wait", "bookend-both");
  both.avatar.engine = "avatar_iv";
  both.avatar.apiVersion = "v3";
  both.avatar.introIdempotencyKey = "stable-v3-intro";
  both.avatar.tailIdempotencyKey = "stable-v3-tail";
  const tailStarted = await advanceAvatarProvider(both, {
    ...pendingDeps,
    upload: async (_avatarId, audioUrl) => {
      assert.equal(audioUrl, "/api/renders/tail.mp3");
      return { kind: "accepted", audioAssetId: "persisted-v3-tail-asset" };
    },
    generate: async (_avatarId, audioAssetId) => {
      generateCalls++;
      assert.equal(audioAssetId, "persisted-v3-tail-asset");
      return accepted("hg-tail");
    },
    poll: async (id) => {
      assert.equal(id, "hg-intro");
      return { status: "completed", videoUrl: "https://files2.heygen.ai/intro.mp4", errorMsg: null };
    },
  });
  assert.equal(tailStarted.kind, "waiting");
  assert.equal(tailStarted.kind === "waiting" ? tailStarted.checkpoint.phase : null, "tail_wait");
  assert.equal(tailStarted.kind === "waiting" ? tailStarted.checkpoint.avatar.tailVideoId : null, "hg-tail");
  assert.equal(tailStarted.kind === "waiting" ? tailStarted.checkpoint.avatar.tailAudioAssetId : null, "persisted-v3-tail-asset");
  assert.equal(generateCalls, 1);

  const tailWaiting = tailStarted.kind === "waiting" ? tailStarted.checkpoint : null;
  assert.ok(tailWaiting);
  const afterRestart = await advanceAvatarProvider(tailWaiting, {
    ...pendingDeps,
    generate: async () => { generateCalls++; return accepted("duplicate"); },
    poll: async (id) => {
      assert.equal(id, "hg-tail");
      return { status: "processing", videoUrl: null, errorMsg: null };
    },
  });
  assert.equal(afterRestart.kind, "waiting");
  assert.equal(generateCalls, 1);
  assert.equal(compositeCalls, 0);

  // Cancellation winning the guarded persistence prevents composite from starting.
  compositeCalls = 0;
  const canceled = await advanceAvatarProvider(checkpoint(), {
    ...pendingDeps,
    poll: async () => ({
      status: "completed",
      videoUrl: "https://files2.heygen.ai/intro.mp4",
      errorMsg: null,
    }),
    persist: async () => false,
    composite: async () => {
      compositeCalls++;
      return { kind: "completed", videoUrl: "/must-not-exist.mp4" };
    },
  });
  assert.equal(canceled.kind, "failed");
  assert.equal(compositeCalls, 0);

  const expired = await advanceAvatarProvider(checkpoint(), {
    ...pendingDeps,
    now: () => new Date("2026-07-13T10:00:00.001Z"),
  });
  assert.equal(expired.kind, "failed");
  assert.match(expired.kind === "failed" ? expired.message : "", /deadline/);
  assert.equal(expired.kind === "failed" ? expired.provider : null, "heygen");
  assert.equal(expired.kind === "failed" ? expired.code : null, "transient");
  assert.equal(expired.kind === "failed" ? expired.outcome : null, "definitive");

  // Composite is local work, so an expired HeyGen-provider deadline must not reject a
  // healthy composite that already has the persisted provider output.
  const expiredComposite = checkpoint("composite");
  expiredComposite.avatar.introVideoUrl = "https://files2.heygen.ai/intro.mp4";
  const completedAfterProviderDeadline = await advanceAvatarProvider(expiredComposite, {
    ...pendingDeps,
    now: () => new Date("2026-07-13T10:00:00.001Z"),
  });
  assert.equal(completedAfterProviderDeadline.kind, "ready");

  // A deterministic FFmpeg timeout must be terminal immediately. Retrying the same
  // input/geometry cannot change the outcome and previously caused the 84↔86 loop.
  const timedOut: AvatarCompositeAttemptResult = {
    kind: "failed",
    code: "COMPOSITE_TIMEOUT",
    message: "ประกอบวิดีโอใช้เวลานานเกินกำหนด",
    retryable: false,
  };
  const timeoutResult = await advanceAvatarProvider(expiredComposite, {
    ...pendingDeps,
    composite: async () => timedOut,
  });
  assert.equal(timeoutResult.kind, "failed");
  assert.equal(timeoutResult.kind === "failed" ? timeoutResult.code : null, "COMPOSITE_TIMEOUT");
  assert.equal(timeoutResult.kind === "failed" ? timeoutResult.provider : null, "composite");
  assert.equal(timeoutResult.kind === "failed" ? timeoutResult.outcome : null, "definitive");

  // A genuinely transient composite failure gets one parked retry, persisted in the
  // checkpoint. The second identical failure is terminal instead of retrying forever.
  const transientFailure: AvatarCompositeAttemptResult = {
    kind: "failed",
    code: "COMPOSITE_TRANSIENT",
    message: "composite worker temporarily unavailable",
    retryable: true,
  };
  const firstTransient = await advanceAvatarProvider(expiredComposite, {
    ...pendingDeps,
    composite: async () => transientFailure,
  });
  assert.equal(firstTransient.kind, "waiting");
  assert.equal(firstTransient.kind === "waiting" ? firstTransient.checkpoint.compositeAttempts : null, 1);
  assert.equal(firstTransient.kind === "waiting" ? firstTransient.retryAfterSec : null, 60);

  assert.equal(firstTransient.kind, "waiting");
  const exhausted = await advanceAvatarProvider(firstTransient.checkpoint, {
    ...pendingDeps,
    composite: async () => transientFailure,
  });
  assert.equal(exhausted.kind, "failed");
  assert.equal(exhausted.kind === "failed" ? exhausted.code : null, "COMPOSITE_RETRY_EXHAUSTED");
  assert.equal(exhausted.kind === "failed" ? exhausted.provider : null, "composite");
  assert.equal(exhausted.kind === "failed" ? exhausted.outcome : null, "definitive");

  console.log("ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
