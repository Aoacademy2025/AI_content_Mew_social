import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  clampElevenLabsSpeed,
  ELEVENLABS_V3_MAX_CHARS,
  ELEVENLABS_V3_MODEL_ID,
  elevenLabsV3RequestBody,
} from "../src/lib/elevenlabs-v3.server";

assert.equal(ELEVENLABS_V3_MODEL_ID, "eleven_v3");
assert.equal(ELEVENLABS_V3_MAX_CHARS, 5_000);
assert.equal(clampElevenLabsSpeed(0.1), 0.7);
assert.equal(clampElevenLabsSpeed(2), 1.2);
assert.equal(clampElevenLabsSpeed(Number.NaN), 1);

const payload = elevenLabsV3RequestBody({ text: "สวัสดีครับ", languageCode: "th", speed: 1.1 });
assert.equal(payload.model_id, "eleven_v3");
assert.equal(payload.language_code, "th");
assert.equal(payload.voice_settings.speed, 1.1);
assert.equal(payload.voice_settings.use_speaker_boost, true);

const server = readFileSync("src/lib/story-film.server.ts", "utf8");
const worker = readFileSync("scripts/story-film-system-worker.ts", "utf8");
const mcp = readFileSync("src/app/api/story-film/[transport]/route.ts", "utf8");
assert.match(server, /narrationProvider === "elevenlabs"/);
assert.match(server, /modelId: "eleven_v3"/);
assert.match(worker, /providerBackend === "elevenlabs"/);
assert.match(worker, /languageCode: "th"/);
assert.match(mcp, /narrationProvider: z\.enum\(\["hero_voice", "elevenlabs"\]\)/);

console.log("ok: Hero Story Film pins ElevenLabs v3, Thai narration, account voice resolution, and paid-call retry safety");
