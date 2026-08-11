"use strict";

function applicationValue(applicationEnv, inheritedEnv, key) {
  if (Object.prototype.hasOwnProperty.call(applicationEnv, key)) {
    return String(applicationEnv[key] ?? "").trim();
  }
  return String(inheritedEnv[key] ?? "").trim();
}

/** Resolve the image-route switches that PM2 must forward explicitly. The
 * persisted application .env is authoritative over stale values inherited by
 * the PM2 daemon or deploy shell; unknown routes fail closed. */
function resolveHeroImageRouteRuntimeEnv(applicationEnv, inheritedEnv = process.env) {
  const route = applicationValue(applicationEnv, inheritedEnv, "AI_STUDIO_Z_IMAGE_ROUTE");
  const publicGate = applicationValue(applicationEnv, inheritedEnv, "AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED");
  return {
    AI_STUDIO_Z_IMAGE_ROUTE: route === "custom" || route === "public" ? route : "disabled",
    AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED: publicGate === "1" ? "1" : "0",
  };
}

module.exports = { resolveHeroImageRouteRuntimeEnv };
