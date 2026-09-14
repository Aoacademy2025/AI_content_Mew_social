import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contentPreflightStockDegradeReason } from "../src/lib/content-preflight-degrade";

function preflightError(code: string) {
  return { name: "ContentPreflightError", code };
}

assert.equal(
  contentPreflightStockDegradeReason({
    analyzerError: preflightError("INVALID_ANALYSIS"),
  }),
  "invalid_analysis",
  "analyzer exhaustion degrades to stock instead of failing the create job",
);
assert.equal(
  contentPreflightStockDegradeReason({
    analyzerError: preflightError("KEY_REQUIRED"),
  }),
  null,
  "a missing Gemini key still fails closed",
);
assert.equal(
  contentPreflightStockDegradeReason({
    analyzerError: preflightError("TEXT_QUOTA"),
  }),
  null,
  "a text quota miss still fails closed",
);
assert.equal(
  contentPreflightStockDegradeReason({ pinnedWindowCount: 4, narrativeAligned: false }),
  "narrative_mismatch",
  "TTS text that cannot host the accepted Narrative windows degrades to stock",
);
assert.equal(
  contentPreflightStockDegradeReason({ pinnedWindowCount: 4, narrativeAligned: true }),
  null,
  "aligned Narrative windows keep the Brand Visual plan",
);
assert.equal(
  contentPreflightStockDegradeReason({ pinnedWindowCount: 0, narrativeAligned: false }),
  null,
  "no pin means there is nothing to degrade",
);

const orchestrator = readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
assert.match(
  orchestrator,
  /contentPreflightStockDegradeReason/,
  "the script worker must share the degrade helper",
);
assert.match(
  orchestrator,
  /brand_visual_preflight_degraded/,
  "a degraded create must leave a durable server event distinct from a failed job",
);
assert.doesNotMatch(
  orchestrator,
  /throw new ContentPreflightError\(\s*"NARRATIVE_MISMATCH"/,
  "a Narrative/TTS mismatch must not fail the VideoJob",
);
assert.match(
  orchestrator,
  /forceStockBroll/,
  "degrade must switch the remaining pipeline off AI image spend",
);

console.log("verify-content-preflight-degrade: ALL PASS");
