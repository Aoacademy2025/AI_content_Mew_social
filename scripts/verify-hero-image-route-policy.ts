import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  isHeroRunpodRoute,
  usesCustomRunpodEndpoint,
} from "../src/lib/hero-image-route-policy";
import { creditCostFor, HERO_AI_IMAGE_CREDITS } from "../src/lib/credit-costs";

const require = createRequire(import.meta.url);
const { resolveHeroImageRouteRuntimeEnv } = require("../deploy/pm2-runtime-env.js") as {
  resolveHeroImageRouteRuntimeEnv: (
    applicationEnv: Record<string, string>,
    inheritedEnv: Record<string, string | undefined>,
  ) => Record<string, string>;
};

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

assert.deepEqual(
  resolveHeroImageRouteRuntimeEnv(
    {
      AI_STUDIO_Z_IMAGE_ROUTE: "public",
      AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED: "1",
    },
    {
      AI_STUDIO_Z_IMAGE_ROUTE: "custom",
      AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED: "0",
    },
  ),
  {
    AI_STUDIO_Z_IMAGE_ROUTE: "public",
    AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED: "1",
  },
  "the persisted application env must override stale PM2 or deploy-shell route values",
);

const previousRoute = process.env.AI_STUDIO_Z_IMAGE_ROUTE;
const previousPublicGate = process.env.AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED;
process.env.AI_STUDIO_Z_IMAGE_ROUTE = "public";
process.env.AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED = "1";
const ecosystemPath = require.resolve("../ecosystem.config.js");
delete require.cache[ecosystemPath];
const ecosystem = require(ecosystemPath) as {
  apps: Array<{ name: string; env?: Record<string, string>; env_production?: Record<string, string> }>;
};
if (previousRoute === undefined) delete process.env.AI_STUDIO_Z_IMAGE_ROUTE;
else process.env.AI_STUDIO_Z_IMAGE_ROUTE = previousRoute;
if (previousPublicGate === undefined) delete process.env.AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED;
else process.env.AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED = previousPublicGate;

for (const processName of ["ai-content", "mcp-video-worker"]) {
  const app = ecosystem.apps.find((item) => item.name === processName);
  assert.equal(app?.env?.AI_STUDIO_Z_IMAGE_ROUTE, "public", `${processName} must receive the selected image route`);
  assert.equal(app?.env?.AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED, "1", `${processName} must receive the public recovery gate`);
}
const web = ecosystem.apps.find((item) => item.name === "ai-content");
assert.equal(web?.env_production?.AI_STUDIO_Z_IMAGE_ROUTE, "public");
assert.equal(web?.env_production?.AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED, "1");

console.log("verify-hero-image-route-policy: ALL PASS");
