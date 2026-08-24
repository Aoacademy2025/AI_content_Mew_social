import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalPlanCapabilities, supplementalPlanFeatures } from "../src/lib/marketing-plan-facts";
import { PLAN_CONFIG_DEFAULTS } from "../src/lib/plan-config";

const marketingSources = [
  "src/app/page.tsx",
  "src/components/marketing/studio-workbench.tsx",
  "src/components/marketing/product-feature-visual.tsx",
  "src/components/marketing/pricing-toggle.tsx",
];

const forbiddenJargon = [
  /\bworkflow\b/iu,
  /\bHook\b/u,
  /B-roll/iu,
  /\bStock\b/u,
  /\bAutoMix\b/u,
  /\bFaceless\b/iu,
  /cutaway/iu,
  /\bTimeline\b/iu,
  /\bSFX\b/u,
  /keyword/iu,
  /Visual Format/iu,
  /\bReroll\b/iu,
  /Brand Profiles?/iu,
  /AI Avatar/iu,
];

for (const source of marketingSources) {
  const copy = readFileSync(resolve(source), "utf8");
  for (const jargon of forbiddenJargon) {
    assert.doesNotMatch(copy, jargon, `${source} must explain ${jargon} in everyday Thai`);
  }
}

const planCopy = (["free", "pro", "business"] as const).flatMap((tier) => [
  ...canonicalPlanCapabilities(tier),
  ...supplementalPlanFeatures(PLAN_CONFIG_DEFAULTS[`${tier}_features`].split("|")),
]).join(" | ");

for (const jargon of forbiddenJargon) {
  assert.doesNotMatch(planCopy, jargon, `pricing must explain ${jargon} in everyday Thai`);
}

console.log("PASS marketing page uses everyday Thai instead of unexplained production jargon");
