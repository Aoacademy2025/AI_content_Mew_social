// Structural production-wiring checks; runtime behavior is covered by the
// storyboard and generation-queue suites.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const worker = readFileSync("scripts/story-film-system-worker.ts", "utf8");
const ecosystem = readFileSync("ecosystem.config.js", "utf8");
const deploy = readFileSync("deploy/deploy.sh", "utf8");
const watchdog = readFileSync("scripts/ops-watchdog.sh", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>;
};

assert.match(worker, /providerBackends: \["hero_text", "hero_alignment", "hero_voice", "elevenlabs", "hero_render"\]/, "system worker must lease Hero text, presenter alignment, configured narration, and render jobs");
assert.doesNotMatch(worker, /providerBackends:\s*\[[^\]]*"grok_subscription"|spawn\([^\n]*grok/iu, "system worker must never consume the Grok subscription lane");
assert.match(worker, /heartbeatStoryFilmGenerationJob/, "long Gemini planning must renew its durable lease");
assert.match(worker, /markStoryFilmGenerationSubmitted/, "a provider attempt must be confirmed before completion");
assert.match(worker, /planStoryFilmStoryboardJob/, "the worker must delegate to the tested storyboard planner");
assert.match(worker, /startHeroVoiceGeneration/, "faceless narration must reuse the durable Hero Voice runtime");
assert.match(worker, /heroVoiceResultFromJob/, "only a completed durable voice result may become Narration Master");
assert.match(worker, /synthesizeElevenLabsV3/, "faceless narration may use the shared ElevenLabs v3 adapter");
assert.match(worker, /storyFilmCaptionTrackFromTtsTiming/, "narration provider timing must become a durable caption track");
assert.match(worker, /elevenlabs_alignment/, "ElevenLabs character alignment must be preserved as caption timing");
assert.match(worker, /hero_voice_timing/, "Hero Voice timing must be preserved as caption timing");
assert.match(worker, /persistCaptionAlignment/, "presenter uploads must produce a durable forced-alignment artifact");
assert.match(worker, /NonRetryableStoryFilmProviderError/, "an uncertain paid ElevenLabs POST must not auto-spend quota twice");
assert.match(worker, /renderStoryFilmFinal/, "the Hero-owned lane must assemble the approved final film locally");
assert.match(ecosystem, /name: "story-film-system-worker"[\s\S]*?scripts\/story-film-system-worker\.ts/, "PM2 must own the long-lived system worker");
const storyFilmWorkerBlock = /name: "story-film-system-worker"[\s\S]*?\n\s*\},\n\s*\},/u.exec(ecosystem)?.[0] ?? "";
assert.match(
  storyFilmWorkerBlock,
  /--import=\.\/scripts\/register-server-only-node\.mjs --import tsx scripts\/story-film-system-worker\.ts/u,
  "the Story Film worker must preload the direct-Node server-only shim before rendering",
);
assert.doesNotMatch(
  storyFilmWorkerBlock,
  /--conditions=react-server/u,
  "the Story Film worker must not select React's RSC export for Remotion",
);
assert.equal(
  packageJson.scripts?.["worker:story-film-system"],
  "node --import=./scripts/register-server-only-node.mjs --import tsx scripts/story-film-system-worker.ts",
  "the manual Story Film worker command must use the same Remotion-safe runtime as PM2",
);
const remotionRuntimeSmoke = spawnSync(process.execPath, [
  "--import=./scripts/register-server-only-node.mjs",
  "--import",
  "tsx",
  "-e",
  "import('./src/remotion/SubtitleOverlayComposition.tsx').then(() => console.log('ok')).catch((error) => { console.error(error); process.exit(1) })",
], { cwd: process.cwd(), encoding: "utf8" });
assert.equal(
  remotionRuntimeSmoke.status,
  0,
  `the worker runtime must load Hero's Remotion composition (${remotionRuntimeSmoke.stderr.trim()})`,
);
assert.match(deploy, /STORY_FILM_SYSTEM_WORKER_NAME="story-film-system-worker"[\s\S]*?restart_from_ecosystem "\$STORY_FILM_SYSTEM_WORKER_NAME"/, "deploy must reload the worker after web health");
assert.match(watchdog, /PM2_ONLINE_APPS=.*story-film-system-worker/, "operations watchdog must detect a stopped Story Film worker");

console.log("Story Film system-worker checks passed");
