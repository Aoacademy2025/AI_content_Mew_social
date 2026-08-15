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

console.log(`\n✅ ALL ${passed} MCP CREATE INPUT CHECKS PASSED`);
