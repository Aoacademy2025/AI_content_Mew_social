import assert from "node:assert/strict";
import fs from "node:fs";
import {
  heroImageStyleForBrollWindow,
  parseHeroBrollWindowRequest,
} from "../src/lib/broll-window-hero";

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
assert.match(
  route,
  /isHeroAiBetaUser/,
  "the route must use the same Hero rollout policy as new-video generation",
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
assert.match(
  route,
  /refundSettledVideoImageJob/,
  "a local derivative failure must refund the exact settled Hero image",
);
assert.match(
  route,
  /retrySameRequest:\s*true/,
  "an unconfirmed refund must preserve the same idempotent request for recovery",
);
assert.doesNotMatch(
  inspector,
  /AI_MODELS|setAiModel|costKeyForKieModel|model:\s*aiModel/,
  "the per-window UI must not expose or submit legacy KIE models",
);
assert.match(
  inspector,
  /HERO_AI_IMAGE_CREDITS/,
  "the per-window UI must disclose the shared Hero price",
);
assert.match(
  inspector,
  /crypto\.randomUUID\(\)/,
  "the browser must provide a retry-stable request id before credits are reserved",
);
assert.match(
  inspector,
  /retrySameRequest[^\n]+aiRequestRef/,
  "the browser must retain the request id while refund state is ambiguous",
);
assert.match(
  shell,
  /aiImageEnabled=\{p\.heroAiBeta\}/,
  "the per-window UI gate must use Hero access rather than Managed KIE access",
);

const valid = parseHeroBrollWindowRequest({
  prompt: "  Thai coffee shop in morning light  ",
  requestId: "fdfbf8f4-1964-4ac8-98f7-6cc25bf86fd3",
  videoJobId: "video-job-123456",
  sceneIndex: 2,
  durationSec: 8.2,
  visualStyle: "cinematic",
});
assert.equal(valid.ok, true);
if (valid.ok) {
  assert.equal(valid.value.prompt, "Thai coffee shop in morning light");
  assert.equal(valid.value.heroStyle, "cinematic");
  assert.equal(valid.value.kenBurnsDurationSec, 9.2);
  assert.match(valid.value.idempotencyKey, /^broll-window:/);
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

console.log("verify-hero-broll-window-migration: ALL PASS");
