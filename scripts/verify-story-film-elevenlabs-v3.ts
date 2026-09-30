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

const v4 = elevenLabsV3RequestBody({ text: "สวัสดีครับ", languageCode: "th", speed: 1.1, model: "v4" });
assert.equal(v4.model_id, "eleven_v4");
assert.equal(v4.language_code, "th");
assert.equal("speed" in v4.voice_settings, false);
assert.equal("style" in v4.voice_settings, false);
assert.equal("use_speaker_boost" in v4.voice_settings, false);
assert.equal(v4.voice_settings.stability, 0.5);
assert.equal(v4.voice_settings.similarity_boost, 0.75);

const server = readFileSync("src/lib/story-film.server.ts", "utf8");
const worker = readFileSync("scripts/story-film-system-worker.ts", "utf8");
const mcp = readFileSync("src/app/api/story-film/[transport]/route.ts", "utf8");
const settings = readFileSync("src/components/settings/api-key-settings.tsx", "utf8");
assert.match(server, /narrationProvider === "elevenlabs"/);
assert.match(server, /elevenLabsProviderModelId\(elevenLabsSpeechModel/);
assert.match(worker, /providerBackend === "elevenlabs"/);
assert.match(worker, /languageCode: "th"/);
assert.match(worker, /model: speechModel/);
assert.match(mcp, /narrationProvider: z\.enum\(\["hero_voice", "elevenlabs"\]\)/);
assert.match(settings, /เสียงเดิม/);
assert.match(settings, /เสียงใหม่/);
assert.match(settings, /elevenlabsModel/);

console.log("ok: ElevenLabs v3 stays the default, v4 omits style and speed, and the account choice reaches Story Film");
