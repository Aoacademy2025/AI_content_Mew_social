// Structural production-wiring checks; runtime behavior is covered by the
// storyboard and generation-queue suites.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync("scripts/story-film-system-worker.ts", "utf8");
const ecosystem = readFileSync("ecosystem.config.js", "utf8");
const deploy = readFileSync("deploy/deploy.sh", "utf8");
const watchdog = readFileSync("scripts/ops-watchdog.sh", "utf8");

assert.match(worker, /providerBackends: \["hero_text", "hero_voice", "hero_render"\]/, "system worker must lease only Hero-owned text, voice and render jobs");
assert.doesNotMatch(worker, /providerBackends:\s*\[[^\]]*"grok_subscription"|spawn\([^\n]*grok/iu, "system worker must never consume the Grok subscription lane");
assert.match(worker, /heartbeatStoryFilmGenerationJob/, "long Gemini planning must renew its durable lease");
assert.match(worker, /markStoryFilmGenerationSubmitted/, "a provider attempt must be confirmed before completion");
assert.match(worker, /planStoryFilmStoryboardJob/, "the worker must delegate to the tested storyboard planner");
assert.match(worker, /startHeroVoiceGeneration/, "faceless narration must reuse the durable Hero Voice runtime");
assert.match(worker, /heroVoiceResultFromJob/, "only a completed durable voice result may become Narration Master");
assert.match(worker, /renderStoryFilmFinal/, "the Hero-owned lane must assemble the approved final film locally");
assert.match(ecosystem, /name: "story-film-system-worker"[\s\S]*?scripts\/story-film-system-worker\.ts/, "PM2 must own the long-lived system worker");
assert.match(deploy, /STORY_FILM_SYSTEM_WORKER_NAME="story-film-system-worker"[\s\S]*?restart_from_ecosystem "\$STORY_FILM_SYSTEM_WORKER_NAME"/, "deploy must reload the worker after web health");
assert.match(watchdog, /PM2_ONLINE_APPS=.*story-film-system-worker/, "operations watchdog must detect a stopped Story Film worker");

console.log("11 Story Film system-worker checks passed");
