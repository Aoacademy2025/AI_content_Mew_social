import assert from "node:assert/strict";
import {
  evaluateBrandVisualSafety,
  summarizeBrandVisualDailyCogs,
} from "../src/lib/brand-visual-safety";

const passing = evaluateBrandVisualSafety({
  terminalJobs: 100,
  usableJobs: 95,
  failedJobs: 5,
  correctlyRestoredFailedJobs: 5,
  staleReservations: 0,
  negativeCreditBalances: 0,
  invalidAllowances: 0,
  averageCogsBahtPerImage: 0.30,
  highestDailyCogsBahtPerImage: 0.50,
});
assert.equal(passing.canExpand, true);
assert.equal(passing.usableRate, 0.95);
assert.equal(passing.restorationRate, 1);

for (const failing of [
  { terminalJobs: 99 },
  { usableJobs: 94 },
  { correctlyRestoredFailedJobs: 4 },
  { staleReservations: 1 },
  { negativeCreditBalances: 1 },
  { invalidAllowances: 1 },
  { averageCogsBahtPerImage: 0.301 },
  { highestDailyCogsBahtPerImage: 0.501 },
]) {
  const result = evaluateBrandVisualSafety({
    terminalJobs: 100,
    usableJobs: 95,
    failedJobs: 5,
    correctlyRestoredFailedJobs: 5,
    staleReservations: 0,
    negativeCreditBalances: 0,
    invalidAllowances: 0,
    averageCogsBahtPerImage: 0.30,
    highestDailyCogsBahtPerImage: 0.50,
    ...failing,
  });
  assert.equal(result.canExpand, false, `expected ${JSON.stringify(failing)} to block expansion`);
}

const unattributed = summarizeBrandVisualDailyCogs({
  costsByDay: new Map([
    ["2026-08-08", 10_000],
    ["2026-08-09", 20_000],
  ]),
  imagesByDay: new Map([["2026-08-08", 2]]),
  usdThbRate: 35,
});
assert.equal(unattributed.highestDailyCogsBahtPerImage, null);
assert.deepEqual(unattributed.unattributedCostDays, ["2026-08-09"]);

const attributed = summarizeBrandVisualDailyCogs({
  costsByDay: new Map([
    ["2026-08-08", 10_000],
    ["2026-08-09", 20_000],
  ]),
  imagesByDay: new Map([
    ["2026-08-08", 2],
    ["2026-08-09", 4],
  ]),
  usdThbRate: 35,
});
assert.ok(Math.abs((attributed.highestDailyCogsBahtPerImage ?? 0) - 0.175) < 1e-9);
assert.deepEqual(attributed.unattributedCostDays, []);

console.log("brand visual rollout health verification: ok");
