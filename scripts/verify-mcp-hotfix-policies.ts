import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { shouldCheckTtsMinuteQuota } from "../src/lib/tts-minute-admission";

const require = createRequire(import.meta.url);
const ecosystem = require("../ecosystem.config.js") as {
  apps?: Array<{
    name?: string;
    script?: string;
    args?: string;
    env?: Record<string, unknown>;
  }>;
};

assert.equal(
  shouldCheckTtsMinuteQuota("managed", true),
  false,
  "managed TTS must defer minute/credit settlement to the queued render when MINUTE_QUOTA is enabled",
);
assert.equal(
  shouldCheckTtsMinuteQuota("managed", false),
  true,
  "legacy managed TTS keeps its fail-fast minute gate when render settlement is disabled",
);
assert.equal(
  shouldCheckTtsMinuteQuota("byok", true),
  false,
  "BYOK never consumes the platform minute gate at TTS",
);

const routeSource = readFileSync("src/app/api/videos/tts-gemini/route.ts", "utf8");
assert.match(
  routeSource,
  /shouldCheckTtsMinuteQuota\(geminiMode, process\.env\.MINUTE_QUOTA === "1"\)/,
  "the production Gemini TTS route uses the shared admission policy",
);

const mcpWorker = ecosystem.apps?.find((app) => app.name === "mcp-video-worker");
assert.equal(
  mcpWorker?.script,
  "node",
  "mcp-video-worker must launch through Node so server-only module conditions reach the runtime",
);
assert.equal(
  mcpWorker?.args,
  "--conditions=react-server --import tsx scripts/mcp-video-worker.ts",
  "mcp-video-worker must resolve server-only modules through the react-server export condition",
);
assert.equal(
  mcpWorker?.env?.RENDER_VIA_QUEUE,
  "1",
  "mcp-video-worker must expose settled billing receipts by enabling the durable render queue",
);

console.log("✅ MCP hotfix policy checks passed");
