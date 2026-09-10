import assert from "node:assert/strict";

import { generateAvatarVideo } from "../src/lib/mcp/avatar-steps";
import {
  PipelineHttpError,
  type PipelineCaller,
} from "../src/lib/mcp/pipeline-client";
import {
  httpStatusForCode,
  toErrorResponse,
  providerError,
  type ProviderErrorCode,
} from "../src/lib/provider-errors";

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

  // HERO-18: HeyGen answered 404 "avatar look not found". The taxonomy calls that
  // `fatal` and OUR route reports `fatal` as 500, so a status-only rule read a
  // definitive refusal as an unproven outcome: the job died as "manual recovery
  // required", the customer was told to check credits, and the retained render
  // reservation was never refunded. The response is built by the SHIPPED route
  // helper, so a change to that mapping fails here instead of in production.
  const lookNotFound = toErrorResponse(providerError(
    "fatal",
    "heygen",
    'HeyGen generate failed (404): {"code":"internal_error","message":"avatar look not found"}',
    { status: 404 },
  ));
  assert.equal(lookNotFound.status, 500, "our own route still answers a fatal upstream with 500");
  assert.equal(lookNotFound.body.providerStatus, 404, "the upstream status must survive to the pipeline");
  const refusedAvatar = await generateAvatarVideo(
    callerWithPost(async () => {
      throw new PipelineHttpError("POST", "/api/heygen/generate-with-bg", lookNotFound.status, lookNotFound.body);
    }),
    "avatar-1",
    "/api/renders/audio.mp3",
  );
  assert.equal(refusedAvatar.kind, "rejected", "a definitive 404 must never be filed as an unknown outcome");
  assert.equal(refusedAvatar.kind === "rejected" ? refusedAvatar.code : null, "fatal");

  // A 500 that carries no verdict of its own is OUR failure, not the provider's, and
  // still cannot prove whether the paid generate was accepted.
  const ourOwnFailure = await generateAvatarVideo(
    callerWithPost(async () => {
      throw new PipelineHttpError("POST", "/api/heygen/generate-with-bg", 500, {
        error: "HeyGen generate failed: {}",
        retryable: false,
      });
    }),
    "avatar-1",
    "/api/renders/audio.mp3",
  );
  assert.equal(ourOwnFailure.kind, "unknown", "an uncoded 500 keeps the outcome unproven");

  // The class guard: every definitive taxonomy code must reach the pipeline as a
  // rejection whatever HTTP status our own route maps it to. Adding a sixth code that
  // routes through a 5xx cannot silently reopen the unknown path — it fails here.
  const codes: readonly ProviderErrorCode[] = ["invalid_key", "quota", "rate_limit", "transient", "fatal"];
  for (const code of codes) {
    const response = toErrorResponse(providerError(code, "heygen", `upstream ${code}`, { status: 404 }));
    assert.equal(response.status, httpStatusForCode(code));
    const outcome = await generateAvatarVideo(
      callerWithPost(async () => {
        throw new PipelineHttpError("POST", "/api/heygen/generate-with-bg", response.status, response.body);
      }),
      "avatar-1",
      "/api/renders/audio.mp3",
    );
    assert.equal(
      outcome.kind,
      code === "transient" ? "unknown" : "rejected",
      `taxonomy code ${code} (route status ${response.status}) reached the pipeline as ${outcome.kind}`,
    );
  }

  console.log("ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
