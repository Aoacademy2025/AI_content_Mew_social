import assert from "node:assert/strict";

import { generateAvatarVideo } from "../src/lib/mcp/avatar-steps";
import {
  PipelineHttpError,
  type PipelineCaller,
} from "../src/lib/mcp/pipeline-client";

function callerWithPost(post: PipelineCaller["post"]): PipelineCaller {
  return {
    post,
    get: async () => ({} as never),
    patch: async () => ({} as never),
  };
}

async function main() {
  let acceptedRetries: number | undefined;
  const accepted = await generateAvatarVideo(
    callerWithPost(async (_path, _body, opts) => {
      acceptedRetries = opts?.retries;
      return { videoId: "hg-123" } as never;
    }),
    "avatar-1",
    "/api/renders/audio.mp3",
  );
  assert.deepEqual(accepted, { kind: "accepted", providerVideoId: "hg-123" });
  assert.equal(acceptedRetries, 0, "paid HeyGen generate must never inherit HTTP retries");

  const quota = await generateAvatarVideo(
    callerWithPost(async () => {
      throw new PipelineHttpError("POST", "/api/heygen/generate-with-bg", 402, {
        code: "quota",
        provider: "heygen",
        userAction: "เครดิต HeyGen ไม่เพียงพอสำหรับสร้าง Avatar",
      });
    }),
    "avatar-1",
    "/api/renders/audio.mp3",
  );
  assert.equal(quota.kind, "rejected");
  assert.equal(quota.kind === "rejected" ? quota.code : null, "quota");

  const invalidKey = await generateAvatarVideo(
    callerWithPost(async () => {
      throw new PipelineHttpError("POST", "/api/heygen/generate-with-bg", 401, {
        code: "invalid_key",
        provider: "heygen",
      });
    }),
    "avatar-1",
    "/api/renders/audio.mp3",
  );
  assert.equal(invalidKey.kind, "rejected");
  assert.equal(invalidKey.kind === "rejected" ? invalidKey.code : null, "invalid_key");

  const providerUnavailable = await generateAvatarVideo(
    callerWithPost(async () => {
      throw new PipelineHttpError("POST", "/api/heygen/generate-with-bg", 503, {
        code: "transient",
        provider: "heygen",
      });
    }),
    "avatar-1",
    "/api/renders/audio.mp3",
  );
  assert.equal(providerUnavailable.kind, "unknown");

  const socketLost = await generateAvatarVideo(
    callerWithPost(async () => { throw new Error("socket closed"); }),
    "avatar-1",
    "/api/renders/audio.mp3",
  );
  assert.equal(socketLost.kind, "unknown");

  console.log("ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
