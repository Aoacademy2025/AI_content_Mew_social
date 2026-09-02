import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildKeywordsPayload,
  buildStockPayload,
  createStockMoodResolver,
} from "../src/lib/mcp/orchestrator-steps";
import { stylePack } from "../src/lib/style-pack-catalog";
import type { ResolvedStockMood } from "../src/lib/broll-preferences";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const ghostMood: ResolvedStockMood = { packId: "thai-ghost", ...stylePack("thai-ghost").stockMood };

type PackId = "thai-ghost" | "thai-history";

function packSnapshot(id: PackId) {
  const pack = stylePack(id);
  return {
    id: pack.id,
    version: pack.version,
    stockMood: {
      queryToken: pack.stockMood.queryToken,
      positive: [...pack.stockMood.positive],
      avoid: [...pack.stockMood.avoid],
      direction: pack.stockMood.direction,
      fallbackQueries: [...pack.stockMood.fallbackQueries],
    },
    pacing: pack.pacing,
    musicMood: pack.musicMood,
  };
}

const recipeJsonFor = (id: PackId) => JSON.stringify({
  schemaVersion: 1,
  visualFormatId: "cinematic-realism",
  recipeVersion: "cinematic-realism@1",
  brandVisualLanguage: null,
  defaultTreatment: "clear",
  treatmentPolicy: "adaptive",
  lockedTreatmentPin: null,
  stylePack: packSnapshot(id),
});

const contextJsonFor = (id: PackId) => JSON.stringify({
  schemaVersion: 2,
  source: "brand-revision",
  visualFormatId: "cinematic-realism",
  recipeVersion: "cinematic-realism@1",
  treatment: "สารคดีสืบสวน",
  treatmentPin: { presetId: "investigative-news-crime", version: "v1.0.0", source: "adaptive" },
  brandVisualLanguage: null,
  stylePack: packSnapshot(id),
});

// ---------------------------------------------------------------------------
// The payload builders are the ONE place the worker's B-roll preference turns
// into a request body. A Stock Mood resolved server-side must ride along with
// the region preference, or the keyword/stock routes never see the pack.
// ---------------------------------------------------------------------------
function verifyPayloadBuilders() {
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

  // No mood, no key: a project without a pinned pack must produce byte-identical
  // payloads to the ones the pipeline sent before wave 1.
  const noMoodKeywords = buildKeywordsPayload(["ฉากหนึ่ง"], "สคริปต์", 12_000, { brollRegionPreference: "thai" });
  check("no mood → no stockMood key in the keywords payload", !("stockMood" in noMoodKeywords));
  const noMoodStock = buildStockPayload(["old house"], 30, "both", [], undefined, undefined, undefined, {
    brollRegionPreference: "thai",
    stockMood: null,
  });
  check("null mood → no stockMood key in the stock payload", !("stockMood" in noMoodStock));
  const bare = buildKeywordsPayload(["ฉากหนึ่ง"], "สคริปต์", 12_000);
  check("no preference at all → no stockMood key", !("stockMood" in bare));
}

// ---------------------------------------------------------------------------
// createStockMoodResolver: BOTH worker paths pin the job's Project Visual
// Context (upload via pinProjectVisualContextToVideoJob, script via
// ensureVideoJobContentPreflight) AFTER the job row was read, and only THEN
// reach the keyword step. So the resolver must read the context LAZILY, at
// resolve() time — reading it eagerly hands every upload-mode clip the pre-pin
// value and silently ignores the pack pinned for that clip.
// ---------------------------------------------------------------------------
async function verifyStockMoodResolver() {
  {
    // The upload path's real ordering: the job row is read with no pinned
    // context, the pin lands mid-run, and only then does the keyword step ask.
    let pinnedContextJson: string | null = null;
    let contextReads = 0;
    let recipeReads = 0;
    const resolve = createStockMoodResolver({
      projectVisualContextJson: async () => { contextReads++; return pinnedContextJson; },
      brandRevisionRecipeJson: async () => { recipeReads++; return recipeJsonFor("thai-ghost"); },
    });
    check("the resolver reads nothing before it is asked", contextReads === 0 && recipeReads === 0);

    pinnedContextJson = contextJsonFor("thai-history"); // pinProjectVisualContextToVideoJob

    const mood = await resolve();
    assert.equal(mood?.packId, "thai-history", "the context pinned for THIS job wins over the Brand Revision");
    assert.equal(mood?.queryToken, stylePack("thai-history").stockMood.queryToken);

    // memoized: the keyword payload and the stock payload must not re-read
    await resolve();
    await resolve();
    check("the resolver reads each source at most once", contextReads === 1 && recipeReads === 1);
  }

  {
    // No per-clip pack pinned → the Brand Revision recipe still supplies one.
    const resolve = createStockMoodResolver({
      projectVisualContextJson: async () => null,
      brandRevisionRecipeJson: async () => recipeJsonFor("thai-ghost"),
    });
    assert.equal((await resolve())?.packId, "thai-ghost");
  }

  {
    // Fail-open: a lookup that throws can never fail a render.
    const contextDown = createStockMoodResolver({
      projectVisualContextJson: async () => { throw new Error("db down"); },
      brandRevisionRecipeJson: async () => recipeJsonFor("thai-ghost"),
    });
    assert.equal(await contextDown(), null, "a failed lookup means no mood, never a thrown render");
    const recipeDown = createStockMoodResolver({
      projectVisualContextJson: async () => contextJsonFor("thai-history"),
      brandRevisionRecipeJson: async () => { throw new Error("db down"); },
    });
    assert.equal(await recipeDown(), null);
  }
  console.log("PASS stock mood resolver: lazy post-pin read, precedence, memoization, fail-open");
}

// ---------------------------------------------------------------------------
// Both worker paths must resolve the mood server-side, through that resolver.
// The client never supplies it for a render.
// ---------------------------------------------------------------------------
function verifyOrchestratorWiring() {
  const source = readFileSync(new URL("../src/lib/mcp/orchestrator.ts", import.meta.url), "utf8");
  check("orchestrator builds the lazy resolver", source.includes("createStockMoodResolver({"));
  const resolutions = source.match(/stockMood:\s*await resolveStockMood\(\)/g) ?? [];
  check(
    `both the script and upload keyword/stock payloads resolve the mood (found ${resolutions.length})`,
    resolutions.length === 4,
  );
  check(
    "the pinned context is re-read from the job row, not the pre-pin snapshot",
    /projectVisualContextJson: async \(\) =>/.test(source)
      && /select: \{ projectVisualContextJson: true \}/.test(source),
  );
}

async function main() {
  verifyPayloadBuilders();
  await verifyStockMoodResolver();
  verifyOrchestratorWiring();
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
