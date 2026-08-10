import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createBlankBrandProfileSeed,
  createBrandProfileSeedFromCurrentDefaults,
  currentBrandVoiceDefaults,
} from "../src/lib/brand-profile-seed";

const blank = createBlankBrandProfileSeed();
assert.deepEqual(blank.visual.palette, ["#2B2926", "#F5F1E8", "#A8A29E"]);
assert.equal(blank.visual.personality, "สมดุล ชัดเจน และปรับให้เข้ากับแบรนด์ได้");
assert.equal(blank.visual.peopleAndSetting, "");
assert.deepEqual(blank.visual.memorableCues, []);
assert.equal(blank.visual.visualNotes, "");
assert.equal(blank.brandMark.enabled, false);
assert.equal(blank.voice.voiceId, null);
assert.ok(
  !JSON.stringify(blank).match(/Mewsocial|38BDF8|วงกลม|ลูกศร|กล้าตรง|ชาวไทย/i),
  "a blank profile must never inherit the Mewsocial differentiation benchmark",
);

const imported = createBrandProfileSeedFromCurrentDefaults({
  script: {
    styleId: "legacy-style",
    tone: "อบอุ่นและกระชับ",
    analysisNotes: "เปิดด้วยคำถาม",
    sampleText: "ตัวอย่างเดิม",
  },
  voice: { provider: "elevenlabs", voiceId: "voice-legacy" },
  subtitle: { presetId: "subtitle-legacy", config: { fontFamily: "Kanit" } },
  brandMark: {
    assetId: "asset-legacy",
    assetName: "legacy.png",
    enabled: true,
    position: "bottom-left",
    sizePct: 21,
    opacity: 0.75,
  },
});
assert.equal(imported.script.styleId, "legacy-style");
assert.equal(imported.script.tone, "อบอุ่นและกระชับ");
assert.equal(imported.voice.voiceId, "voice-legacy");
assert.equal(imported.subtitle.presetId, "subtitle-legacy");
assert.equal(imported.brandMark.assetId, "asset-legacy");
assert.equal(imported.brandMark.position, "bottom-left");
assert.deepEqual(
  imported.visual,
  blank.visual,
  "explicit legacy import seeds writing/voice/subtitle/mark only, never a guessed visual identity",
);

assert.deepEqual(
  currentBrandVoiceDefaults({
    ttsProvider: "omnivoice",
    elevenlabsVoiceId: "must-not-cross-provider-boundary",
    geminiVoiceName: "must-not-cross-provider-boundary",
  }),
  { provider: "omnivoice", voiceId: null },
  "an account without a persisted OmniVoice id must use its provider default instead of an ElevenLabs id",
);
assert.deepEqual(
  currentBrandVoiceDefaults({
    ttsProvider: "gemini",
    elevenlabsVoiceId: "eleven-id",
    geminiVoiceName: "Kore",
  }),
  { provider: "gemini", voiceId: "Kore" },
);

const pageSource = readFileSync("src/app/(dashboard)/brands/page.tsx", "utf8");
assert.ok(pageSource.includes("สร้างแบรนด์จากค่าที่ใช้อยู่"));
assert.ok(pageSource.includes("createBrandProfileSeedFromCurrentDefaults"));
assert.ok(
  !pageSource.match(/function newPayload[\s\S]{0,2200}(#38BDF8|วงกลมเน้นจุดสำคัญ|ลูกศรนำสายตา)/),
  "the Brand Library page must not hard-code the gate-only Mewsocial brief",
);

console.log("verify-brand-profile-seed: PASS neutral blank + explicit legacy import");
