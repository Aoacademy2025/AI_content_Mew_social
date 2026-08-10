import assert from "node:assert/strict";
import fs from "node:fs";
import {
  heroImageStyleForBrollWindow,
  parseHeroBrollWindowRequest,
} from "../src/lib/broll-window-hero";
import {
  clearPendingBrollSceneReroll,
  readPendingBrollSceneReroll,
  writePendingBrollSceneReroll,
} from "../src/lib/broll-reroll-client-state";

const route = fs.readFileSync("src/app/api/videos/broll-window/generate/route.ts", "utf8");
const inspector = fs.readFileSync(
  "src/app/(dashboard)/video-editor/_v2/BrollWindowInspector.tsx",
  "utf8",
);
const shell = fs.readFileSync(
  "src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx",
  "utf8",
);
const contract = fs.readFileSync("src/lib/broll-window-hero.ts", "utf8");
const jobsRoute = fs.readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
const generateConfigRoute = fs.readFileSync("src/app/api/videos/generate-config/route.ts", "utf8");

assert.match(
  route,
  /generateHeroImageForVideo/,
  "per-window generation must use the durable Hero AI Image service",
);
assert.doesNotMatch(
  route,
  /generateKieImageKenBurns|decryptKey|KIE_API_KEY|resolveKieImageAccess/,
  "per-window Hero AI Image must never enter the legacy KIE/BYOK path",
);
assert.doesNotMatch(
  route,
  /provider:\s*generated\.provider|model:\s*generated\.providerModel|"RunPod custom endpoint"/,
  "the customer Scene Reroll contract must not expose its underlying provider or model",
);
assert.match(
  route,
  /resolveProjectVisualPromptForVideoScene/,
  "Scene Reroll must compile the exact pinned Visual Beat instead of trusting a browser prompt",
);
assert.match(
  route,
  /getRunpodImageCostSnapshot/,
  "the route must preserve the live RunPod cost admission guard",
);
assert.match(
  contract,
  /requestId[\s\S]+videoJobId[\s\S]+sceneIndex[\s\S]+durationSec/,
  "the route contract must carry an idempotent request and owned window context",
);
assert.doesNotMatch(
  contract,
  /prompt:\s*string/,
  "the browser contract must not carry an editable provider prompt",
);
assert.match(
  route,
  /refundSettledVideoImageJob/,
  "a local derivative failure must refund the exact settled Hero image",
);
assert.match(
  route,
  /deferVisualBeatLink:\s*true[\s\S]+applyKenBurns[\s\S]+recordVisualBeatAsset/,
  "Scene Reroll must replace the Visual Beat only after its customer-facing derivative succeeds",
);
assert.match(
  route,
  /retrySameRequest:\s*true/,
  "an unconfirmed refund must preserve the same idempotent request for recovery",
);
assert.doesNotMatch(
  inspector,
  /AI_MODELS|setAiModel|costKeyForKieModel|model:\s*aiModel|พรอมต์เต็ม|buildBrollImagePrompt/,
  "the V1 reroll UI must expose neither legacy models nor raw prompt editing",
);
assert.match(
  inspector,
  /HERO_AI_IMAGE_CREDITS/,
  "the per-window UI must disclose the shared Hero price",
);
assert.match(
  inspector,
  /writePendingBrollSceneReroll/,
  "the browser must persist its request identity before credits or allowance are reserved",
);
assert.match(
  inspector,
  /readPendingBrollSceneReroll/,
  "the browser must recover the same request identity after reload or scene navigation",
);
assert.ok(
  inspector.indexOf("readPendingBrollSceneReroll(storage, videoJobId, index!)")
    < inspector.indexOf("allowanceEligible && (allowanceRemaining ?? 0) <= 0"),
  "an existing Scene Reroll must be recovered before the live Starter allowance guard",
);
assert.match(
  inspector,
  /autoRecoveryAttemptRef[\s\S]+readPendingBrollSceneReroll[\s\S]+void handleGenerate\(pending\.requestId\)/,
  "a persisted Scene Reroll must resume automatically when its scene opens after reload",
);
assert.match(
  shell,
  /sceneRerollEnabled=\{p\.heroAiImageEligible\s*\|\|\s*Boolean\(job\.contentPreflightId\)\}/,
  "the per-window V1 gate must admit Brand Visual cohorts and already-pinned rollback jobs",
);
assert.ok(
  route.indexOf("const existingImageJob") < route.indexOf("await checkHeroImageRate")
    && route.indexOf("const existingImageJob") < route.indexOf("await getRunpodImageCostSnapshot"),
  "same-request recovery must replay before fresh daily-cap and COGS admission",
);
assert.match(route, /brand_look_scene_rerolled/,
  "a delivered post-phase Scene Reroll must emit the V1 leading-metric event");
assert.match(jobsRoute, /projectVisualPin:\s*srcJob\.projectVisualContextJson/,
  "a broll-rerender child must inherit the source job's immutable visual pin");
assert.match(
  generateConfigRoute,
  /sv\.assetMeta\?\.provider\s*\?\?\s*sv\.provider/,
  "render preview metadata must retain RunPod/KIE ownership so existing AI scenes remain rerollable",
);

const valid = parseHeroBrollWindowRequest({
  requestId: "fdfbf8f4-1964-4ac8-98f7-6cc25bf86fd3",
  videoJobId: "video-job-123456",
  sceneIndex: 2,
  durationSec: 8.2,
  visualStyle: "cinematic",
});
assert.equal(valid.ok, true);
if (valid.ok) {
  assert.equal(valid.value.kenBurnsDurationSec, 9.2);
  assert.match(valid.value.idempotencyKey, /^broll-window:/);
  assert.equal("prompt" in valid.value, false);
}
assert.equal(
  parseHeroBrollWindowRequest({
    prompt: "x",
    requestId: "not-a-uuid",
    videoJobId: "video-job-123456",
    sceneIndex: 0,
    durationSec: 5,
  }).ok,
  false,
  "malformed retry identifiers must fail before credit reservation",
);
assert.equal(heroImageStyleForBrollWindow("surreal"), "illustration");

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
};
const operation = {
  version: 1 as const,
  videoJobId: "video-job-123456",
  sceneIndex: 2,
  requestId: "fdfbf8f4-1964-4ac8-98f7-6cc25bf86fd3",
  createdAt: "2026-08-10T00:00:00.000Z",
};
writePendingBrollSceneReroll(storage, operation);
assert.deepEqual(
  readPendingBrollSceneReroll(storage, operation.videoJobId, operation.sceneIndex, new Date("2026-08-10T01:00:00.000Z")),
  operation,
  "an ambiguous Scene Reroll survives reload with the exact request identity",
);
clearPendingBrollSceneReroll(storage, operation.videoJobId, operation.sceneIndex, operation.requestId);
assert.equal(readPendingBrollSceneReroll(storage, operation.videoJobId, operation.sceneIndex), null);

console.log("verify-hero-broll-window-migration: ALL PASS");
