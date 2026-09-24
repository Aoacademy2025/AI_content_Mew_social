import { createVideoJobInputSchema } from "../src/lib/mcp/create-video-input";

let passed = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
  passed += 1;
}

const selected = createVideoJobInputSchema.parse({
  script: "สวัสดีครับ",
  voiceProvider: "gemini",
  geminiVoiceName: "Kore",
});
check(selected.geminiVoiceName === "Kore", "create_video_job accepts a listed Gemini voice");

check(
  createVideoJobInputSchema.safeParse({
    script: "สวัสดีครับ",
    voiceProvider: "gemini",
    geminiVoiceName: "not-a-real-voice",
  }).success === false,
  "create_video_job rejects an unknown Gemini voice before queueing",
);

const avatarV = createVideoJobInputSchema.parse({
  script: "สวัสดีครับ",
  avatarMode: "full",
  avatarId: "private-look",
  avatarEngine: "avatar_v",
});
check(avatarV.avatarEngine === "avatar_v", "create_video_job preserves an explicit Avatar V selection");
check(
  createVideoJobInputSchema.safeParse({ script: "สวัสดีครับ", avatarEngine: "newest" }).success === false,
  "create_video_job rejects an unknown avatar engine before queueing",
);
check(
  createVideoJobInputSchema.parse({ script: "สวัสดีครับ", avatarMode: "none" }).avatarEngine === undefined,
  "avatar-off input keeps the legacy engine field absent",
);

console.log(`\n✅ ALL ${passed} MCP CREATE INPUT CHECKS PASSED`);
