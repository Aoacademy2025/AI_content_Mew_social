// verify-v2-preview-output.ts — parseVideoJobOutput: v2 ใหม่มี field re-composite ครบ,
// v2 เก่า (ไม่มี field) และ v1 ยังอ่านได้ (readers MUST accept both — ADR 0001)
// Run: npx tsx scripts/verify-v2-preview-output.ts
import { parseVideoJobOutput } from "../src/lib/mcp/video-job";

let fail = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) fail++;
}

const newV2 = parseVideoJobOutput(JSON.stringify({
  version: 2, mode: "preview", videoUrl: "/api/renders/composite-1.mp4",
  preview: {
    captions: [], config: {}, voiceUrl: "/api/renders/tts.mp3", audioDurationMs: 10000,
    avatarModel: "avat_1", avatarVideoUrl: "https://files.heygen.ai/a.mp4",
    avatarMode: "bookend", avatarIntroSecs: 5, avatarTailSecs: 5,
    compositeBaseUrl: "/api/renders/base-1.mp4", tailAvatarUrl: null,
  },
}));
check("new v2: compositeBaseUrl present", newV2?.preview?.compositeBaseUrl === "/api/renders/base-1.mp4");
check("new v2: avatarMode present", newV2?.preview?.avatarMode === "bookend");
check("new v2: intro/tail secs", newV2?.preview?.avatarIntroSecs === 5 && newV2?.preview?.avatarTailSecs === 5);

const oldV2 = parseVideoJobOutput(JSON.stringify({
  version: 2, mode: "preview", videoUrl: "/api/renders/x.mp4",
  preview: { captions: [], config: {}, voiceUrl: "/v.mp3", audioDurationMs: 1, avatarModel: "none", avatarVideoUrl: null },
}));
check("old v2: parses fine", oldV2?.version === 2 && !!oldV2.preview);
check("old v2: new fields undefined", oldV2?.preview?.compositeBaseUrl === undefined && oldV2?.preview?.tailAvatarUrl === undefined);

const v1 = parseVideoJobOutput(JSON.stringify({ videoUrl: "/api/renders/y.mp4", videoId: "vid1" }));
check("v1: parses fine", v1?.version === 1 && v1.videoUrl === "/api/renders/y.mp4");
check("garbage: null", parseVideoJobOutput("{not json") === null);

process.exit(fail ? 1 : 0);
