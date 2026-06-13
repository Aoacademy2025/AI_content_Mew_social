//   npx tsx scripts/verify-mcp-orchestrator-steps.ts
import {
  DEFAULT_STYLE, maxCardCharsFor, buildKeywordsPayload, buildStockPayload,
  buildConfigPayload, buildBurnConfig,
} from "../src/lib/mcp/orchestrator-steps";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

const caps = [
  { text: "สวัสดี", startMs: 0, endMs: 1000, tag: "hook" as const },
  { text: "โลก", startMs: 1000, endMs: 2000, tag: "body" as const },
];

assert(maxCardCharsFor(80) === Math.max(10, Math.floor((1080 - 160) / (80 * 0.47))), "maxCardChars matches editor formula");

const kw = buildKeywordsPayload(caps.map((c) => c.text), "สคริปต์", 2000);
assert(JSON.stringify(kw.scenes) === JSON.stringify(["สวัสดี", "โลก"]), "keywords payload scenes = caption texts");
assert(kw.audioDurationSec === 2 && kw.preferredLLM === null, "keywords payload duration + preferredLLM:null");

const stock = buildStockPayload(["a", "b"], 12, "both", caps);
assert(stock.keywords.length === 2 && stock.download === true && stock.stockSource === "both", "stock payload basics");
assert(stock.perSubtitleMode === true && stock.overrideClipCount === 2, "per-subtitle mode when caps==keywords count");

const cfg = buildConfigPayload(caps, [{ src: "x" }], "/v.mp3", 2000, ["สวัสดี", "โลก"], 5, [1, 1], [1, 1]);
assert(cfg.voiceFile === "/v.mp3" && cfg.audioDurationMs === 2000, "config payload voice/duration");
assert(cfg.subtitleStylePreset === DEFAULT_STYLE.subtitleStylePreset && cfg.fontFamily === DEFAULT_STYLE.fontFamily, "config uses default style");
assert(JSON.stringify(cfg.sceneClipCounts) === JSON.stringify([1, 1]), "config sceneClipCounts passthrough");

const burn = buildBurnConfig("/base.mp4", caps, 2000, 30);
assert(burn.videoUrl === "/base.mp4" && burn.durationInFrames === 60, "burn durationInFrames = round(ms/1000*fps)");
assert(burn.keywordPopups.length === 2, "one popup per caption");
const p0 = burn.keywordPopups[0];
assert(p0.start === 0 && p0.end === 30 && p0.isHighlight === true && p0.tag === "hook", "popup frame timing + hook highlight");
assert(p0.size === DEFAULT_STYLE.subtitleSize && p0.topPercent === DEFAULT_STYLE.subtitlePosition, "popup uses default style");

console.log(`\n✅ ALL ${passed} ORCHESTRATOR-STEP CHECKS PASSED`);
