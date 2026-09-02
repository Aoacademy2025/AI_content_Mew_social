import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildKeywordsPayload,
  buildStockPayload,
  buildConfigPayload,
  createStylePackRenderResolver,
} from "../src/lib/mcp/orchestrator-steps";
import { buildBrollWindows } from "../src/lib/broll-windows";
import { stylePack, PACING_CADENCE_MULTIPLIER, PACING_MIN_HOLD_SEC } from "../src/lib/style-pack-catalog";
import type { ResolvedStockMood } from "../src/lib/broll-preferences";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const ghostMood: ResolvedStockMood = { packId: "thai-ghost", ...stylePack("thai-ghost").stockMood };

type PackId = "thai-ghost" | "thai-history" | "premium-product";

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
// createStylePackRenderResolver: BOTH worker paths pin the job's Project Visual
// Context (upload via pinProjectVisualContextToVideoJob, script via
// ensureVideoJobContentPreflight) AFTER the job row was read, and only THEN
// reach the keyword step. So the resolver must read the context LAZILY, at
// resolve() time — reading it eagerly hands every upload-mode clip the pre-pin
// value and silently ignores the pack pinned for that clip.
//
// resolveStockMood and resolvePacing (Task 5) read the SAME memoized snapshot,
// so this verifies both facets share precedence, memoization, and fail-open.
// ---------------------------------------------------------------------------
async function verifyStylePackRenderResolver() {
  {
    // The upload path's real ordering: the job row is read with no pinned
    // context, the pin lands mid-run, and only then does the keyword step ask.
    let pinnedContextJson: string | null = null;
    let contextReads = 0;
    let recipeReads = 0;
    const { resolveStockMood, resolvePacing } = createStylePackRenderResolver({
      projectVisualContextJson: async () => { contextReads++; return pinnedContextJson; },
      brandRevisionRecipeJson: async () => { recipeReads++; return recipeJsonFor("thai-ghost"); },
    });
    check("the resolver reads nothing before it is asked", contextReads === 0 && recipeReads === 0);

    pinnedContextJson = contextJsonFor("thai-history"); // pinProjectVisualContextToVideoJob

    const mood = await resolveStockMood();
    assert.equal(mood?.packId, "thai-history", "the context pinned for THIS job wins over the Brand Revision");
    assert.equal(mood?.queryToken, stylePack("thai-history").stockMood.queryToken);

    const pacing = await resolvePacing();
    assert.equal(pacing, stylePack("thai-history").pacing, "pacing comes from the SAME pinned context as the mood");

    // memoized: the keyword payload, the stock payload, and pacing must not re-read —
    // resolveStockMood and resolvePacing share ONE snapshot load.
    await resolveStockMood();
    await resolvePacing();
    check("the resolver reads each source at most once across BOTH facets", contextReads === 1 && recipeReads === 1);
  }

  {
    // No per-clip pack pinned → the Brand Revision recipe still supplies one, for
    // both the mood and the pacing.
    const { resolveStockMood, resolvePacing } = createStylePackRenderResolver({
      projectVisualContextJson: async () => null,
      brandRevisionRecipeJson: async () => recipeJsonFor("thai-ghost"),
    });
    assert.equal((await resolveStockMood())?.packId, "thai-ghost");
    assert.equal(await resolvePacing(), stylePack("thai-ghost").pacing);
  }

  {
    // Neither source carries a pack → mood is null, pacing is null too (Fix
    // round 1: NOT "normal" — a caller deciding whether to send an explicit
    // minHoldSec override must be able to tell "no pack" apart from "a
    // pinned pack whose pacing happens to be normal").
    const { resolveStockMood, resolvePacing } = createStylePackRenderResolver({
      projectVisualContextJson: async () => null,
      brandRevisionRecipeJson: async () => null,
    });
    assert.equal(await resolveStockMood(), null, "no pack pinned anywhere → no mood");
    assert.equal(await resolvePacing(), null, "no pack pinned anywhere → null pacing (not \"normal\")");
  }

  {
    // Fail-open: a lookup that throws can never fail a render, for either facet.
    // resolvePacing() fails open to null (Fix round 1) — NOT "normal" — so a
    // failed lookup is indistinguishable from "no pack pinned" downstream.
    const contextDown = createStylePackRenderResolver({
      projectVisualContextJson: async () => { throw new Error("db down"); },
      brandRevisionRecipeJson: async () => recipeJsonFor("thai-ghost"),
    });
    assert.equal(await contextDown.resolveStockMood(), null, "a failed lookup means no mood, never a thrown render");
    assert.equal(await contextDown.resolvePacing(), null, "a failed lookup means null pacing, never a thrown render");

    const recipeDown = createStylePackRenderResolver({
      projectVisualContextJson: async () => contextJsonFor("thai-history"),
      brandRevisionRecipeJson: async () => { throw new Error("db down"); },
    });
    assert.equal(await recipeDown.resolveStockMood(), null);
    assert.equal(await recipeDown.resolvePacing(), null);
  }

  {
    // Independent pacing values are carried through correctly (not hard-coded to
    // one pack's value) — premium-product is "slow".
    const { resolvePacing } = createStylePackRenderResolver({
      projectVisualContextJson: async () => contextJsonFor("premium-product"),
      brandRevisionRecipeJson: async () => null,
    });
    assert.equal(await resolvePacing(), "slow");
  }

  console.log("PASS style pack render resolver: lazy post-pin read, precedence, memoization, fail-open (mood + pacing)");
}

// ---------------------------------------------------------------------------
// Fix round 1 (Important, plan-mandated): minHoldSec must be sent ONLY when
// a pack is actually pinned — resolvePacing() returning "normal" for BOTH
// "no pack" and "a pinned normal-pacing pack" made the orchestrator send
// minHoldSec: 4 unconditionally for every AI-gen/auto-mix job, silently
// overriding the operator's STOCK_MIN_HOLD_SEC env default even with no pack
// pinned. These are REAL calls through buildConfigPayload/buildBrollWindows —
// not source-text greps — exercising the exact orchestrator expressions:
//   cadenceMultiplier: pacing ? PACING_CADENCE_MULTIPLIER[pacing] : 1
//   aiGenSource && pacing ? PACING_MIN_HOLD_SEC[pacing] : undefined
// ---------------------------------------------------------------------------
async function verifyPacingDrivesConfigPayload() {
  const captions = Array.from({ length: 12 }, (_, i) => ({
    startMs: i * 1500,
    endMs: (i + 1) * 1500,
    text: `c${i}`,
  }));
  const durationMs = captions[captions.length - 1].endMs;
  const aiGenSource = true; // AI-gen / auto-mix source, per the orchestrator's own gate

  async function buildConfigFor(resolver: ReturnType<typeof createStylePackRenderResolver>) {
    const pacing = await resolver.resolvePacing();
    // Mirrors the orchestrator's script-path window build for the case that
    // exercises minHoldSec: window mode off, no manual/narrative windows →
    // brollWindows stays empty, so buildConfigPayload's minHoldSec gate applies.
    const brollWindows: { startMs: number; endMs: number }[] = [];
    return buildConfigPayload(
      captions, [], "voice.mp3", durationMs, captions.map((c) => c.text),
      5, [], [],
      brollWindows,
      aiGenSource && pacing ? PACING_MIN_HOLD_SEC[pacing] : undefined,
    ) as Record<string, unknown>;
  }

  {
    // (a) no pack pinned anywhere → the config payload has NO minHoldSec key
    // at all, so the route's own STOCK_MIN_HOLD_SEC / legacy default applies —
    // exactly as before this task.
    const resolver = createStylePackRenderResolver({
      projectVisualContextJson: async () => null,
      brandRevisionRecipeJson: async () => null,
    });
    const cfg = await buildConfigFor(resolver);
    check("(a) no pack pinned → generate-config payload has NO minHoldSec key", !("minHoldSec" in cfg));
  }

  {
    // (b) a pack with pacing "slow" is pinned → minHoldSec === PACING_MIN_HOLD_SEC.slow (6).
    assert.equal(stylePack("premium-product").pacing, "slow", "fixture sanity: premium-product is slow");
    assert.equal(PACING_MIN_HOLD_SEC.slow, 6, "fixture sanity: slow min-hold is 6s");
    const resolver = createStylePackRenderResolver({
      projectVisualContextJson: async () => contextJsonFor("premium-product"),
      brandRevisionRecipeJson: async () => null,
    });
    const cfg = await buildConfigFor(resolver);
    check("(b) slow pack pinned → minHoldSec === 6", cfg.minHoldSec === 6, `${cfg.minHoldSec}`);
  }

  {
    // (c) the resolver's loader throws → fail-open to null pacing → NO
    // minHoldSec key (never a thrown render, and never a silent override of
    // the operator's default), AND the window cadence multiplier falls back
    // to exactly ×1 — identical windows to an explicit cadenceMultiplier: 1.
    const resolver = createStylePackRenderResolver({
      projectVisualContextJson: async () => { throw new Error("db down"); },
      brandRevisionRecipeJson: async () => recipeJsonFor("premium-product"),
    });
    const cfg = await buildConfigFor(resolver);
    check("(c) loader throws → no minHoldSec key (fail-open, no silent override)", !("minHoldSec" in cfg));

    const pacing = await resolver.resolvePacing();
    const explicitOne = buildBrollWindows(captions, 4, durationMs, { cadenceMultiplier: 1 });
    const failOpen = buildBrollWindows(captions, 4, durationMs, {
      cadenceMultiplier: pacing ? PACING_CADENCE_MULTIPLIER[pacing] : 1,
    });
    check(
      "(c) loader throws → cadence multiplier falls back to ×1 (windows identical to explicit ×1)",
      JSON.stringify(explicitOne) === JSON.stringify(failOpen),
    );
  }

  console.log("PASS pacing → generate-config payload: minHoldSec ONLY when a pack is pinned; fail-open is ×1 / no key");
}

// ---------------------------------------------------------------------------
// Both worker paths must resolve the mood/pacing server-side, through that
// resolver. The client never supplies them for a render.
// ---------------------------------------------------------------------------
function verifyOrchestratorWiring() {
  const source = readFileSync(new URL("../src/lib/mcp/orchestrator.ts", import.meta.url), "utf8");
  check("orchestrator builds the shared style pack resolver", source.includes("createStylePackRenderResolver({"));
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
  check(
    "the script path resolves pacing and scales buildBrollWindows' cadenceMultiplier, null-safe",
    /const pacing = await resolvePacing\(\);/.test(source)
      && /cadenceMultiplier: pacing \? PACING_CADENCE_MULTIPLIER\[pacing\] : 1/.test(source),
  );
  check(
    "the script path's AI-gen/auto-mix config payload sends minHoldSec ONLY when a pack is pinned (pacing truthy)",
    /aiGenSource && pacing \? PACING_MIN_HOLD_SEC\[pacing\] : undefined/.test(source),
  );
}

async function main() {
  verifyPayloadBuilders();
  await verifyStylePackRenderResolver();
  await verifyPacingDrivesConfigPayload();
  verifyOrchestratorWiring();
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
