// Run with: npm run verify:story-film-worker-api
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isStoryFilmWorkerAuthorized } from "../src/lib/story-film-worker-auth.server";

process.env.STORY_FILM_WORKER_TOKEN = "story-film-worker-test-token-32-chars-minimum";
assert.equal(isStoryFilmWorkerAuthorized(new Request("https://hero.test", {
  headers: { Authorization: `Bearer ${process.env.STORY_FILM_WORKER_TOKEN}` },
})), true);
assert.equal(isStoryFilmWorkerAuthorized(new Request("https://hero.test", {
  headers: { Authorization: "Bearer wrong" },
})), false);
console.log("ok: worker API fails closed and uses an independent bearer secret");

const routePaths = [
  "src/app/api/internal/story-film-worker/lease/route.ts",
  "src/app/api/internal/story-film-worker/jobs/[id]/heartbeat/route.ts",
  "src/app/api/internal/story-film-worker/jobs/[id]/submitted/route.ts",
  "src/app/api/internal/story-film-worker/jobs/[id]/failure/route.ts",
  "src/app/api/internal/story-film-worker/jobs/[id]/complete/route.ts",
];
for (const routePath of routePaths) {
  assert.match(readFileSync(routePath, "utf8"), /isStoryFilmWorkerAuthorized\(request\)/, `${routePath} must own its auth gate`);
}
console.log("ok: lease, heartbeat, submission, failure and completion all authenticate at the route boundary");

const proxy = readFileSync("src/proxy.ts", "utf8");
const ecosystem = readFileSync("ecosystem.config.js", "utf8");
assert.match(proxy, /"\/api\/internal\/story-film-worker\(\.\*\)"/);
assert.match(ecosystem, /STORY_FILM_WORKER_TOKEN: reviewedRuntimeValue\("STORY_FILM_WORKER_TOKEN"\)/);
assert.match(ecosystem, /name: "ai-content"[\s\S]*?\.\.\.storyFilmRuntimeEnv/);
const complete = readFileSync(routePaths.at(-1)!, "utf8");
assert.match(complete, /probeVideoMedia\(outputPath\)/);
assert.match(complete, /probeMediaDurationMs\(outputPath\)/);
assert.match(complete, /sharp\(outputPath\)\.metadata\(\)/);
assert.match(complete, /completeStoryFilmGenerationJob/);
console.log("ok: middleware passes the pull worker through to route auth and server-side artifact probes");
