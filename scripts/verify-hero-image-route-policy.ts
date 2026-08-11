import assert from "node:assert/strict";
import {
  isHeroRunpodRoute,
  usesCustomRunpodEndpoint,
} from "../src/lib/hero-image-route-policy";
import { creditCostFor, HERO_AI_IMAGE_CREDITS } from "../src/lib/credit-costs";

assert.equal(isHeroRunpodRoute("runpod-custom"), true);
assert.equal(isHeroRunpodRoute("runpod-public"), true);
assert.equal(isHeroRunpodRoute("kie-market"), false);
assert.equal(isHeroRunpodRoute(null), false);

assert.equal(usesCustomRunpodEndpoint("runpod-custom"), true);
assert.equal(usesCustomRunpodEndpoint("runpod-public"), false);
assert.equal(usesCustomRunpodEndpoint("kie-market"), false);

assert.equal(
  creditCostFor("image-open-fast-1k"),
  HERO_AI_IMAGE_CREDITS,
  "public incident route must preserve the price already disclosed for Hero AI Image",
);

console.log("verify-hero-image-route-policy: ALL PASS");
