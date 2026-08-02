import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { saveVideoAccountDefaults } from "../src/lib/video-account-defaults";
import { validateVideoSettingsPatch } from "../src/lib/video-settings";

async function main() {
  const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
  const result = await saveVideoAccountDefaults(
    {
      elevenlabsVoiceId: "  voice-123  ",
      heygenAvatarId: "  avatar-456  ",
      ttsProvider: "elevenlabs",
      geminiVoiceName: "  Aoede  ",
    },
    async (input, init) => {
      calls.push({ input, init });
      return Response.json({ ok: true });
    },
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "/api/user/video-settings");
  assert.equal(calls[0].init?.method, "PATCH");
  assert.equal(new Headers(calls[0].init?.headers).get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    elevenlabsVoiceId: "voice-123",
    heygenAvatarId: "avatar-456",
    ttsProvider: "elevenlabs",
    geminiVoiceName: "Aoede",
  }, "account defaults are normalized before persistence");

  await assert.rejects(
    () => saveVideoAccountDefaults({ elevenlabsVoiceId: "voice-123" }, async () =>
      Response.json({ error: "Unauthorized" }, { status: 401 })),
    /บันทึกค่าเริ่มต้นไม่สำเร็จ/,
    "the editor must not silently swallow an account-default save failure",
  );

  assert.deepEqual(validateVideoSettingsPatch({
    elevenlabsVoiceId: "  voice-123  ",
    heygenAvatarId: " avatar-456 ",
    ttsProvider: "elevenlabs",
    geminiVoiceName: "Aoede",
  }), {
    ok: true,
    data: {
      elevenlabsVoiceId: "voice-123",
      heygenAvatarId: "avatar-456",
      ttsProvider: "elevenlabs",
      geminiVoiceName: "Aoede",
    },
  });
  assert.equal(validateVideoSettingsPatch({ ttsProvider: "unknown" }).ok, false);
  assert.equal(validateVideoSettingsPatch({ geminiVoiceName: "made-up-voice" }).ok, false);
  assert.equal(validateVideoSettingsPatch({ elevenlabsVoiceId: "x".repeat(257) }).ok, false);
  assert.equal(validateVideoSettingsPatch({ heygenAvatarId: "bad\nvalue" }).ok, false);
  assert.equal(validateVideoSettingsPatch({ ignored: "field" }).ok, false);

  const hookSource = readFileSync(join(process.cwd(), "src/app/(dashboard)/video-editor/_v2/useV2Project.ts"), "utf8");
  assert.match(hookSource, /saveAccountVideoDefaults/);
  assert.match(hookSource, /saveVideoAccountDefaults/);

  const uiSource = readFileSync(join(process.cwd(), "src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx"), "utf8");
  assert.match(uiSource, /บันทึกเสียงนี้เป็นค่าเริ่มต้น/);
  assert.match(uiSource, /บันทึกอวตารนี้เป็นค่าเริ่มต้น/);
  assert.match(uiSource, /p\.saveAccountVideoDefaults/);

  const routeSource = readFileSync(join(process.cwd(), "src/app/api/user/video-settings/route.ts"), "utf8");
  assert.match(routeSource, /validateVideoSettingsPatch/);

  console.log("video account defaults verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
