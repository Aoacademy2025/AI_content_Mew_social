import assert from "node:assert/strict";
import fs from "node:fs";
import { selectSceneCoverage } from "../src/lib/hero-image-scene-coverage";

async function main() {
  // ---- nothing to borrow from -----------------------------------------
  assert.deepEqual(
    selectSceneCoverage({ coveredSourceIndexes: [], missingSourceIndexes: [0, 1] }),
    [],
    "with no delivered scene there is nothing to cover with, so the batch must still fail",
  );
  assert.deepEqual(
    selectSceneCoverage({ coveredSourceIndexes: [0, 1], missingSourceIndexes: [] }),
    [],
    "a complete batch needs no coverage",
  );

  // ---- the one-scene-of-eight case ------------------------------------
  {
    const assignments = selectSceneCoverage({
      coveredSourceIndexes: [0, 1, 2, 3, 5, 6, 7],
      missingSourceIndexes: [4],
    });
    assert.deepEqual(
      assignments,
      [{ sourceIndex: 4, coveredFromSourceIndex: 3 }],
      "a single gap borrows the preceding scene",
    );
  }

  // ---- a tie goes to the preceding scene -------------------------------
  {
    const assignments = selectSceneCoverage({
      coveredSourceIndexes: [2, 4],
      missingSourceIndexes: [3],
    });
    assert.deepEqual(
      assignments,
      [{ sourceIndex: 3, coveredFromSourceIndex: 2 }],
      "equidistant neighbours resolve backwards so the previous shot holds",
    );
  }

  // ---- a gap at the very start borrows forwards ------------------------
  {
    const assignments = selectSceneCoverage({
      coveredSourceIndexes: [3, 4],
      missingSourceIndexes: [0, 1],
    });
    assert.deepEqual(
      assignments,
      [
        { sourceIndex: 0, coveredFromSourceIndex: 3 },
        { sourceIndex: 1, coveredFromSourceIndex: 3 },
      ],
      "with no preceding scene the nearest following one covers the opening windows",
    );
  }

  // ---- the 2026-09-09 shape: 6 delivered, 2 lost at the tail -----------
  {
    const assignments = selectSceneCoverage({
      coveredSourceIndexes: [0, 1, 2, 3, 4, 5],
      missingSourceIndexes: [6, 7],
    });
    assert.deepEqual(
      assignments,
      [
        { sourceIndex: 6, coveredFromSourceIndex: 5 },
        { sourceIndex: 7, coveredFromSourceIndex: 5 },
      ],
      "the production failure shape covers both tail windows from the last delivered scene",
    );
  }

  // ---- purity and hygiene ----------------------------------------------
  {
    const covered = [5, 1, 1, 3];
    const missing = [2, 2, 4, 3];
    const assignments = selectSceneCoverage({
      coveredSourceIndexes: covered,
      missingSourceIndexes: missing,
    });
    assert.deepEqual(covered, [5, 1, 1, 3], "the input arrays are never mutated");
    assert.deepEqual(missing, [2, 2, 4, 3], "the input arrays are never mutated");
    assert.deepEqual(
      assignments,
      [
        { sourceIndex: 2, coveredFromSourceIndex: 1 },
        { sourceIndex: 4, coveredFromSourceIndex: 3 },
      ],
      "duplicates collapse, a window that is already covered is never assigned, and output is window-ordered",
    );
  }

  // ---- static wiring guards -------------------------------------------
  const route = fs.readFileSync("src/app/api/videos/fetch-stock/route.ts", "utf8");
  assert.match(
    route,
    /selectSceneCoverage/,
    "the batch must actually use the coverage selection",
  );
  assert.doesNotMatch(
    route,
    /if \(failures\.length === 0\) \{\s*\n\s*await forEachInFailFastBatches\(\s*\n\s*generatedScenes,/,
    "the download phase must no longer be gated on a completely clean batch",
  );
  assert.match(
    route,
    /fallbackSceneCount/,
    "coverage must be visible in fetch-stock telemetry",
  );
  const refundCall = route.indexOf("refundSettledVideoImageBatch({");
  assert.ok(refundCall > 0, "the whole-batch refund path must still exist for a batch that delivered nothing");
  assert.ok(
    route.indexOf("selectSceneCoverage(") < refundCall,
    "coverage must run before the refund decision, so a covered window never triggers a refund",
  );
  assert.match(
    route,
    /systemicFailure|failure\.systemic/,
    "systemic failures must still be distinguishable and keep failing the batch",
  );

  console.log("verify-hero-image-scene-coverage: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
