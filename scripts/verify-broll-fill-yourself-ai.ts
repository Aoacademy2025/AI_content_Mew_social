// HERO-44 (b): a "ใส่ B-roll เอง" video still gets a scene plan (content preflight) when the
// account can use Hero AI Image, so the per-window "สร้างภาพ AI" tab works on it — while the
// run itself still contacts no stock/image provider. Accounts without Hero AI Image access
// skip the plan (no LLM spend for a tab they cannot open).
import { readFileSync } from "node:fs";
import { fillYourselfWantsScenePlan } from "../src/lib/broll-fill-yourself";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ok - ${msg}`);
  else { failed++; console.error(`  FAIL - ${msg}`); }
}

console.log("who gets a scene plan");
assert(fillYourselfWantsScenePlan({ stockSource: "none", projectId: "p1", canUseHeroAiImage: true }) === true, "fill-yourself + Hero AI Image access + a project => plan");
assert(fillYourselfWantsScenePlan({ stockSource: "none", projectId: "p1", canUseHeroAiImage: false }) === false, "no Hero AI Image access (FREE) => no plan, no LLM spend");
assert(fillYourselfWantsScenePlan({ stockSource: "none", projectId: null, canUseHeroAiImage: true }) === false, "no project (MCP / legacy) => no plan");
assert(fillYourselfWantsScenePlan({ stockSource: "stock", projectId: "p1", canUseHeroAiImage: true }) === false, "other sources are untouched by this rule");

console.log("wiring");
const jobs = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
assert(/fillYourselfWantsScenePlan\(/.test(jobs), "the jobs route asks the rule when deciding to carry a visual context");
assert(/requestsBrandVisualImage = Boolean\(\s*projectId && \(useHeroRunpodImage \|\| autoMixRequestsAi \|\| fillYourselfPlan\)/.test(jobs), "a fill-yourself job with access is treated like an AI-image job for the visual pin");
const orch = readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
assert(/const needsAiVisualPlan = input\.stockSource === "kie-image" \|\| input\.stockSource === "auto-mix" \|\| brollDisabled;/.test(orch), "the script worker runs the content preflight for fill-yourself too");
assert(/\} else if \(needsAiVisualPlan && !brollDisabled\) \{\s*throw error;/.test(orch), "a failed plan never fails a fill-yourself render — the video still ships, only without AI");
const upload = orch.slice(orch.indexOf('if (input.mode === "upload")'), orch.indexOf('await step("keywords", 40);', orch.indexOf('if (input.mode === "upload")')));
assert(/if \(upVisibleWindows\.length > 0 \|\| brollDisabled\)/.test(upload) && /windows: \(brollDisabled \? upWindows : upVisibleWindows\)/.test(upload), "the upload worker plans scenes for all windows of a fill-yourself clip");

assert(/if \(!degrade && brollDisabled\) \{/.test(upload), "a failed optional plan on the upload path is logged, not fatal");

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log("\nALL PASSED");
