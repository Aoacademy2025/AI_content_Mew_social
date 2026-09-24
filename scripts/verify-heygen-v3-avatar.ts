import assert from "node:assert/strict";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHeyGenV3VideoRequest,
  createHeyGenV3Avatar,
  HeyGenV3RequestError,
  parseFfmpegDurationMs,
  readHeyGenV3AudioFile,
  uploadHeyGenV3Audio,
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
assert.equal(heygenLookEngineCompatibility([{ avatar_id: "unknown-look" }], "unknown-look", "avatar_iv"), "unknown");
assert.equal(heygenLookEngineCompatibility([{ avatar_id: "known-empty", supported_api_engines: [] }], "known-empty", "avatar_iv"), "incompatible");
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
  remove_background: true,
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
  const uploaded = await uploadHeyGenV3Audio({
    heygenKey: "secret-key",
    audioBytes: new Uint8Array([1, 2, 3]),
    durationMs: 42_000,
    fetcher,
  });
  const submitted = await createHeyGenV3Avatar({
    heygenKey: "secret-key",
    avatarId: "look-private-v",
    engine: "avatar_v",
    audioAssetId: uploaded.audioAssetId,
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
    await uploadHeyGenV3Audio({
      heygenKey: "secret-key",
      audioBytes: new Uint8Array([1]),
      durationMs: 600_001,
      fetcher: async () => { preflightCalls += 1; return Response.json({}); },
    });
  } catch (error) {
    preflightCode = error instanceof Error && "code" in error ? String(error.code) : "";
  }
  assert.equal(preflightCode, "avatar_audio_too_long");
  assert.equal(preflightCalls, 0, "audio limits fail before asset upload or paid create");

  const sparseDir = mkdtempSync(join(tmpdir(), "heygen-v3-audio-"));
  const oversizedPath = join(sparseDir, "oversized.mp3");
  writeFileSync(oversizedPath, "");
  truncateSync(oversizedPath, 32 * 1024 * 1024 + 1);
  assert.throws(
    () => readHeyGenV3AudioFile(oversizedPath, 1_000),
    (error) => error instanceof Error && "code" in error && error.code === "avatar_audio_too_large",
    "oversized local MP3 is rejected from stat metadata before a full read",
  );
  rmSync(sparseDir, { recursive: true, force: true });

  let uploadFailure: unknown;
  try {
    await uploadHeyGenV3Audio({
      heygenKey: "secret-key",
      audioBytes: new Uint8Array([1]),
      durationMs: 1_000,
      fetcher: async () => { throw new Error("private transport details"); },
    });
  } catch (error) { uploadFailure = error; }
  assert(uploadFailure instanceof HeyGenV3RequestError && uploadFailure.operation === "upload" && uploadFailure.status === 503, "upload transport failure is known to occur before paid create");

  let malformedCreate: unknown;
  let malformedCalls = 0;
  try {
    await createHeyGenV3Avatar({
      heygenKey: "secret-key",
      avatarId: "look-private-v",
      engine: "avatar_v",
      audioAssetId: "asset-malformed",
      idempotencyKey: "stable-malformed-create-key",
      fetcher: async () => {
        malformedCalls += 1;
        return Response.json({ data: {} });
      },
    });
  } catch (error) { malformedCreate = error; }
  assert.equal(malformedCalls, 1);
  assert(malformedCreate instanceof Error && !(malformedCreate instanceof HeyGenV3RequestError), "successful create without video_id remains an unknown paid outcome");

  const replayBodies: string[] = [];
  const replayKeys: string[] = [];
  const replayFetcher: typeof fetch = async (_input, init) => {
    replayBodies.push(String(init?.body));
    replayKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
    return Response.json({ data: { video_id: `video-${replayBodies.length}` } });
  };
  const replayInput = {
    heygenKey: "secret-key",
    avatarId: "look-private-v",
    engine: "avatar_v" as const,
    audioAssetId: "persisted-asset-intro",
    idempotencyKey: "stable-account-job-intro-body",
    fetcher: replayFetcher,
  };
  await createHeyGenV3Avatar(replayInput);
  await createHeyGenV3Avatar(replayInput);
  assert.deepEqual(replayKeys, [replayInput.idempotencyKey, replayInput.idempotencyKey]);
  assert.equal(replayBodies[0], replayBodies[1], "a repeated paid key always has a byte-identical create body");
  console.log("ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
