import assert from "node:assert/strict";

import {
  buildHeyGenV3VideoRequest,
  HeyGenV3RequestError,
  parseFfmpegDurationMs,
  submitHeyGenV3Avatar,
  validateHeyGenV3Audio,
} from "../src/lib/heygen-v3-avatar";
import {
  HEYGEN_ENGINE_INCOMPATIBLE_MESSAGE,
  HEYGEN_ENGINE_UNKNOWN_MESSAGE,
  heygenLookEngineCompatibility,
} from "../src/lib/heygen-avatar-engine";

assert.equal(parseFfmpegDurationMs("Duration: 00:10:00.00, start: 0.000000"), 600_000);
assert.equal(parseFfmpegDurationMs("ffmpeg could not read input"), null);

const privateLooks = [
  { avatar_id: "look-iv", supported_api_engines: ["avatar_iii", "avatar_iv"] as const },
  { avatar_id: "look-v", supported_api_engines: ["avatar_iv", "avatar_v"] as const },
];
assert.equal(heygenLookEngineCompatibility(privateLooks, "look-v", "avatar_v"), "compatible");
assert.equal(heygenLookEngineCompatibility(privateLooks, "look-iv", "avatar_v"), "incompatible");
assert.equal(heygenLookEngineCompatibility(privateLooks, "missing", "avatar_iv"), "unknown");
assert.equal(HEYGEN_ENGINE_UNKNOWN_MESSAGE, "ยังตรวจสอบรุ่นที่ Avatar นี้รองรับไม่ได้ กรุณาลองใหม่");
assert.equal(HEYGEN_ENGINE_INCOMPATIBLE_MESSAGE, "Avatar นี้ไม่รองรับรุ่นที่เลือก กรุณาเลือกรุ่นที่รองรับหรือเปลี่ยน Avatar");

const request = buildHeyGenV3VideoRequest({
  avatarId: "look-private-v",
  engine: "avatar_v",
  audioAssetId: "asset-audio",
});
assert.deepEqual(request, {
  type: "avatar",
  avatar_id: "look-private-v",
  audio_asset_id: "asset-audio",
  engine: { type: "avatar_v" },
  resolution: "1080p",
  aspect_ratio: "9:16",
  output_format: "mp4",
  background: { type: "color", value: "#00FF00" },
  fit: "contain",
});
assert.equal(buildHeyGenV3VideoRequest({
  avatarId: "look-private-iv",
  engine: "avatar_iv",
  audioAssetId: "asset-iv",
}).engine.type, "avatar_iv", "Avatar IV is explicit rather than relying on the provider default");

assert.equal(validateHeyGenV3Audio({ durationMs: 600_000, sizeBytes: 32 * 1024 * 1024 }), null);
assert.equal(
  validateHeyGenV3Audio({ durationMs: 600_001, sizeBytes: 10 })?.message,
  "เสียงสำหรับ Avatar รุ่นนี้ต้องยาวไม่เกิน 10 นาที กรุณาเลือกช่วงต้น/ท้ายคลิปหรือใช้เสียงที่สั้นลง",
);
assert.equal(
  validateHeyGenV3Audio({ durationMs: 1000, sizeBytes: 32 * 1024 * 1024 + 1 })?.message,
  "ไฟล์เสียงสำหรับ Avatar ใหญ่เกินขนาดที่ HeyGen รองรับ กรุณาใช้ไฟล์เสียงที่เล็กลง",
);

const calls: Array<{ url: string; init?: RequestInit }> = [];
const fetcher: typeof fetch = async (input, init) => {
  const url = String(input);
  calls.push({ url, init });
  if (url.endsWith("/v3/assets")) {
    return Response.json({ data: { asset_id: "asset-audio" } });
  }
  if (url.endsWith("/v3/videos")) {
    return Response.json({ data: { video_id: "video-v3" } });
  }
  throw new Error(`unexpected request ${url}`);
};

async function main() {
  const submitted = await submitHeyGenV3Avatar({
    heygenKey: "secret-key",
    avatarId: "look-private-v",
    engine: "avatar_v",
    audioBytes: new Uint8Array([1, 2, 3]),
    durationMs: 42_000,
    idempotencyKey: "stable-account-job-intro-body",
    fetcher,
  });
  assert.equal(submitted.videoId, "video-v3");
  assert.equal(calls.length, 2, "one upload and one paid create");
  const createCall = calls[1];
  assert.equal(createCall?.init?.headers && new Headers(createCall.init.headers).get("Idempotency-Key"), "stable-account-job-intro-body");
  assert.deepEqual(JSON.parse(String(createCall?.init?.body)), request);
  assert.equal(String(createCall?.init?.body).includes("secret-key"), false, "provider key is absent from the paid request body");

  let preflightCalls = 0;
  let preflightCode = "";
  try {
    await submitHeyGenV3Avatar({
      heygenKey: "secret-key",
      avatarId: "look-private-v",
      engine: "avatar_v",
      audioBytes: new Uint8Array([1]),
      durationMs: 600_001,
      idempotencyKey: "stable-too-long-key",
      fetcher: async () => { preflightCalls += 1; return Response.json({}); },
    });
  } catch (error) {
    preflightCode = error instanceof Error && "code" in error ? String(error.code) : "";
  }
  assert.equal(preflightCode, "avatar_audio_too_long");
  assert.equal(preflightCalls, 0, "audio limits fail before asset upload or paid create");

  let uploadFailure: unknown;
  try {
    await submitHeyGenV3Avatar({
      heygenKey: "secret-key",
      avatarId: "look-private-v",
      engine: "avatar_v",
      audioBytes: new Uint8Array([1]),
      durationMs: 1_000,
      idempotencyKey: "stable-upload-failure-key",
      fetcher: async () => { throw new Error("private transport details"); },
    });
  } catch (error) { uploadFailure = error; }
  assert(uploadFailure instanceof HeyGenV3RequestError && uploadFailure.operation === "upload" && uploadFailure.status === 503, "upload transport failure is known to occur before paid create");

  let malformedCreate: unknown;
  let malformedCalls = 0;
  try {
    await submitHeyGenV3Avatar({
      heygenKey: "secret-key",
      avatarId: "look-private-v",
      engine: "avatar_v",
      audioBytes: new Uint8Array([1]),
      durationMs: 1_000,
      idempotencyKey: "stable-malformed-create-key",
      fetcher: async (input) => {
        malformedCalls += 1;
        return String(input).endsWith("/v3/assets")
          ? Response.json({ data: { asset_id: "asset-malformed" } })
          : Response.json({ data: {} });
      },
    });
  } catch (error) { malformedCreate = error; }
  assert.equal(malformedCalls, 2);
  assert(malformedCreate instanceof Error && !(malformedCreate instanceof HeyGenV3RequestError), "successful create without video_id remains an unknown paid outcome");
  console.log("ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
