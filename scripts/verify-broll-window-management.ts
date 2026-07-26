import assert from "node:assert/strict";
import fs from "node:fs";

const inspector = fs.readFileSync(
  "src/app/(dashboard)/video-editor/_v2/BrollWindowInspector.tsx",
  "utf8",
);
const editor = fs.readFileSync(
  "src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts",
  "utf8",
);
const desktop = fs.readFileSync(
  "src/app/(dashboard)/video-editor/_v2/PostPhase.tsx",
  "utf8",
);
const mobile = fs.readFileSync(
  "src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx",
  "utf8",
);
const jobsRoute = fs.readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
const orchestrator = fs.readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
const composition = fs.readFileSync("src/remotion/ShortVideoComposition.tsx", "utf8");

assert.match(inspector, /แสดง B-roll ช่วงนี้/u);
assert.match(inspector, /สลับกับฉากก่อนหน้า/u);
assert.match(inspector, /สลับกับฉากถัดไป/u);
assert.match(inspector, /คลิป Avatar ต้นฉบับ/u);
assert.match(editor, /undoWindowEdits/u);
assert.match(editor, /redoWindowEdits/u);
assert.match(editor, /enabled:\s*e\.enabled/u);
assert.doesNotMatch(desktop, /avatarModel !== "upload-cutaway"/u);
assert.doesNotMatch(mobile, /avatarModel !== "upload-cutaway"/u);
assert.doesNotMatch(jobsRoute, /cutaway_not_supported/u);
assert.match(orchestrator, /mode:\s*"cutaway"/u);
assert.match(orchestrator, /resolveCutawayPersonRanges/u);
assert.match(composition, /brollEnabled/u);
assert.match(mobile, /minHeight:\s*44/u);

console.log("B-roll window management UI/render contract passed");
