import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_EDITOR_PROJECT_TITLE_LENGTH,
  validateEditorProjectRename,
} from "../src/lib/editor-project-title";

const thaiTitle = "รีวิวตู้เย็นสำหรับคอนโด";
assert.deepEqual(
  validateEditorProjectRename(`  ${thaiTitle}  `),
  { ok: true, title: thaiTitle },
  "a Gallery rename trims surrounding whitespace and preserves Thai",
);
assert.deepEqual(
  validateEditorProjectRename("   "),
  { ok: false, message: "กรุณาใส่ชื่อโปรเจกต์" },
  "an empty Gallery rename explains what is missing",
);
assert.deepEqual(
  validateEditorProjectRename("ก".repeat(MAX_EDITOR_PROJECT_TITLE_LENGTH + 1)),
  { ok: false, message: `ชื่อโปรเจกต์ยาวได้ไม่เกิน ${MAX_EDITOR_PROJECT_TITLE_LENGTH} ตัวอักษร` },
  "an overlong Gallery rename is rejected instead of silently truncated",
);

const galleryPath = "src/app/(dashboard)/videos/page.tsx";
const gallerySource = readFileSync(galleryPath, "utf8");
assert.match(
  gallerySource,
  /project\?: \{ id: string; title: string \} \| null;/,
  "Gallery videos carry the linked project id required for an ownership-scoped rename",
);
assert.match(
  gallerySource,
  /fetch\(`\/api\/editor-projects\/\$\{encodeURIComponent\(projectId\)\}`,[\s\S]*?method: "PATCH"[\s\S]*?JSON\.stringify\(\{ title \}\)/,
  "Gallery rename persists through the existing authenticated project PATCH boundary",
);
assert.match(
  gallerySource,
  /setVideos\(current => current\.map\([\s\S]*?video\.project\?\.id === projectId/,
  "renaming a project updates every linked rendered-video card",
);
assert.match(
  gallerySource,
  /aria-label="ชื่อโปรเจกต์"[\s\S]*?maxLength=\{MAX_EDITOR_PROJECT_TITLE_LENGTH\}/,
  "the inline editor has an accessible name and mirrors the server title limit",
);
assert.match(
  gallerySource,
  /onKeyDown=\{handleRenameKeyDown\}/,
  "the inline editor supports keyboard save and cancel",
);
assert.ok(
  (gallerySource.match(/aria-label="เปลี่ยนชื่อโปรเจกต์"/g) ?? []).length >= 2,
  "rename is exposed for both draft and rendered project cards",
);
assert.doesNotMatch(
  gallerySource,
  /rename[\s\S]{0,200}<Dialog/i,
  "rename stays inline instead of interrupting the Gallery with a modal",
);

const videosRouteSource = readFileSync("src/app/api/videos/route.ts", "utf8");
assert.match(
  videosRouteSource,
  /project: \{ select: \{ id: true, title: true \} \}/,
  "the Gallery API returns only the linked project id and title needed by rename",
);

const ciSource = readFileSync(".github/workflows/ci.yml", "utf8");
assert.match(
  ciSource,
  /Verify Gallery project rename[\s\S]*?npm run verify:gallery-project-rename/,
  "the Gallery rename regression runs in CI",
);

console.log("verify-gallery-project-rename: PASS validation, ownership route, inline controls, linked-card sync");
