import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildKeywordsPayload, buildStockPayload } from "../src/lib/mcp/orchestrator-steps";
import { stylePack } from "../src/lib/style-pack-catalog";
import type { ResolvedStockMood } from "../src/lib/broll-preferences";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const ghostMood: ResolvedStockMood = { packId: "thai-ghost", ...stylePack("thai-ghost").stockMood };

// ---------------------------------------------------------------------------
// The payload builders are the ONE place the worker's B-roll preference turns
// into a request body. A Stock Mood resolved server-side must ride along with
// the region preference, or the keyword/stock routes never see the pack.
// ---------------------------------------------------------------------------
{
  const keywords = buildKeywordsPayload(["ฉากหนึ่ง", "ฉากสอง"], "สคริปต์", 12_000, {
    brollRegionPreference: "thai",
    stockMood: ghostMood,
  }) as Record<string, unknown>;
  assert.deepEqual(keywords.stockMood, ghostMood, "keywords payload carries the mood");
  assert.equal(keywords.brollRegionPreference, "thai", "region still rides along");

  const stock = buildStockPayload(
    ["old house"],
    30,
    "both",
    [{ text: "ฉากหนึ่ง", startMs: 0, endMs: 3000, tag: "body" }],
    "direction",
    undefined,
    undefined,
    { brollRegionPreference: "thai", stockMood: ghostMood },
  ) as Record<string, unknown>;
  assert.deepEqual(stock.stockMood, ghostMood, "stock payload carries the mood");
  assert.equal(stock.brollRegionPreference, "thai", "region still rides along");
}

// ---------------------------------------------------------------------------
// No mood, no key: a project without a pinned pack must produce byte-identical
// payloads to the ones the pipeline sent before wave 1.
// ---------------------------------------------------------------------------
{
  const keywords = buildKeywordsPayload(["ฉากหนึ่ง"], "สคริปต์", 12_000, { brollRegionPreference: "thai" });
  check("no mood → no stockMood key in the keywords payload", !("stockMood" in keywords));
  const stock = buildStockPayload(["old house"], 30, "both", [], undefined, undefined, undefined, {
    brollRegionPreference: "thai",
    stockMood: null,
  });
  check("null mood → no stockMood key in the stock payload", !("stockMood" in stock));
  const bare = buildKeywordsPayload(["ฉากหนึ่ง"], "สคริปต์", 12_000);
  check("no preference at all → no stockMood key", !("stockMood" in bare));
}

// ---------------------------------------------------------------------------
// Both worker paths (script + upload) must resolve the mood server-side. The
// client never supplies it for a render: it is read from the pinned Project
// Visual Context / Brand Revision snapshot inside the orchestrator.
// ---------------------------------------------------------------------------
{
  const source = readFileSync(new URL("../src/lib/mcp/orchestrator.ts", import.meta.url), "utf8");
  check("orchestrator imports stockMoodForProject", source.includes("stockMoodForProject"));
  const resolutions = source.match(/stockMood:\s*await resolveStockMood\(\)/g) ?? [];
  check(
    `both the script and upload keyword/stock payloads resolve the mood (found ${resolutions.length})`,
    resolutions.length === 4,
  );
  check(
    "the mood is read from the pinned context and the Brand Revision recipe",
    source.includes("projectVisualContextJson: job.projectVisualContextJson"),
  );
}

process.exit(failures ? 1 : 0);
