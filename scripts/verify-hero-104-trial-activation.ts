import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FIRST_CLIP_STARTERS,
  findFirstClipStarter,
  firstClipStarterHref,
  shouldApplyFirstClipStarterScript,
} from "@/lib/first-clip-starter";
import { isActiveStylePackId } from "@/lib/style-pack-catalog";

const REPO_ROOT = path.resolve(__dirname, "..");

// 1. Starter catalog integrity
assert.ok(FIRST_CLIP_STARTERS.length >= 3, "at least 3 proven starter templates configured");
for (const starter of FIRST_CLIP_STARTERS) {
  assert.ok(isActiveStylePackId(starter.templateId), `${starter.templateId} is an active style pack`);
  const lines = starter.script.split("\n").map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.length >= 5, `${starter.templateId} starter script has >=5 segments`);
  assert.equal(findFirstClipStarter(starter.templateId)?.templateId, starter.templateId);
  assert.equal(
    firstClipStarterHref(starter.templateId),
    `/video-editor?templateId=${starter.templateId}&sample=1&source=first_clip_starter`,
  );
}
assert.equal(findFirstClipStarter("nonexistent"), null);

// 2. Draft safety guard — never overwrite an existing user script
assert.equal(shouldApplyFirstClipStarterScript(""), true);
assert.equal(shouldApplyFirstClipStarterScript("   \n  "), true);
assert.equal(shouldApplyFirstClipStarterScript("สคริปต์ของลูกค้า"), false);

// 3. UI wiring & telemetry assertions
const heroSource = readFileSync(
  path.join(REPO_ROOT, "src/components/dashboard/first-clip-hero.tsx"),
  "utf8",
);
const shellSource = readFileSync(
  path.join(REPO_ROOT, "src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx"),
  "utf8",
);
const step1Source = readFileSync(
  path.join(REPO_ROOT, "src/app/(dashboard)/video-editor/_v2/Step1Script.tsx"),
  "utf8",
);

assert.match(heroSource, /first_clip_template_starter_clicked/, "FirstClipHero tracks 1-click starter launches");
assert.match(heroSource, /first-clip-no-api-key-reassurance/, "FirstClipHero displays no-API-key reassurance");
assert.match(heroSource, /first-clip-export-nudge/, "FirstClipHero highlights finish-export nudge for rendered_not_exported");
assert.match(shellSource, /shouldApplyFirstClipStarterScript/, "EditorV2Shell guards against overwriting existing user draft");
assert.match(step1Source, /ไม่ต้องใส่ API Key/, "Step1Script displays no-API-key reassurance on firstClipPath");

console.log(
  "verify-hero-104-trial-activation: PASS — 1-click template starters, draft-safe hydration guard, no-API-key reassurance, and export nudge verified",
);
