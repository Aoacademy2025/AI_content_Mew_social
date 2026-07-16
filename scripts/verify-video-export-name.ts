import assert from "node:assert/strict";
import {
  resolveVideoDisplayName,
  resolveVideoDownloadFilename,
} from "../src/lib/video-export-name";

assert.equal(
  resolveVideoDisplayName({ projectTitle: "  แคมเปญเปิดตัว  ", headline: "หัวข้อ", script: "สคริปต์" }),
  "แคมเปญเปิดตัว",
  "a meaningful project title wins",
);
assert.equal(
  resolveVideoDisplayName({ projectTitle: " New Project ", headline: "หัวข้อเดิม", script: "สคริปต์" }),
  "หัวข้อเดิม",
  "the default project title falls back to the content headline",
);
assert.equal(
  resolveVideoDisplayName({ projectTitle: "New Project", script: "สคริปต์สั้น" }),
  "สคริปต์สั้น",
  "the default project title falls back to script",
);
assert.equal(
  resolveVideoDisplayName({ projectTitle: "", headline: "", script: "" }),
  "Untitled",
  "empty candidates fall back to Untitled",
);
assert.equal(
  resolveVideoDisplayName({ script: "ก".repeat(45) }),
  `${"ก".repeat(40)}...`,
  "script fallback is capped at 40 Unicode code points",
);
assert.equal(
  resolveVideoDownloadFilename({ projectTitle: "คลิปเปิดตัวสินค้า" }),
  "คลิปเปิดตัวสินค้า.mp4",
  "Thai project names remain readable",
);
assert.equal(
  resolveVideoDownloadFilename({ projectTitle: "แคมเปญ: เปิด/ตัว* ?" }),
  "แคมเปญ เปิด ตัว.mp4",
  "invalid filename characters become collapsed spaces",
);
assert.equal(
  resolveVideoDownloadFilename({ projectTitle: "A\u0000B...  " }),
  "A B.mp4",
  "control characters and trailing dots/spaces are removed",
);
assert.equal(
  resolveVideoDownloadFilename({ projectTitle: "<>:\"/\\|?*" }),
  "Untitled.mp4",
  "an empty sanitized stem falls back safely",
);
assert.equal(
  resolveVideoDownloadFilename({ projectTitle: "CON" }),
  "Untitled.mp4",
  "reserved Windows device names fall back safely",
);
const longFilename = resolveVideoDownloadFilename({ projectTitle: "ก".repeat(100) });
assert.equal(Array.from(longFilename.slice(0, -4)).length, 80, "filename stem is capped at 80 code points");
assert.equal(
  resolveVideoDownloadFilename({ projectTitle: "New Project", script: "ชื่อจากสคริปต์" }),
  "ชื่อจากสคริปต์.mp4",
  "download naming uses the same fallback policy",
);

console.log("PASS video export naming behavior");
