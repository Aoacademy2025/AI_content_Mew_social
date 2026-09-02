import assert from "node:assert/strict";
import {
  evaluateBrandVisualSafety,
  summarizeBrandVisualDailyCogs,
} from "../src/lib/brand-visual-safety";
import { summarizeStylePackAcceptance, stylePackAcceptanceForCohort } from "../src/lib/brand-visual-rollout-health.server";

const passing = evaluateBrandVisualSafety({
  terminalJobs: 100,
  usableJobs: 95,
  failedJobs: 5,
  correctlyRestoredFailedJobs: 5,
  staleReservations: 0,
  duplicateDeductions: 0,
  negativeCreditBalances: 0,
  invalidAllowances: 0,
  cogsDataAdmitted: true,
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
  { duplicateDeductions: 1 },
  { negativeCreditBalances: 1 },
  { invalidAllowances: 1 },
  { cogsDataAdmitted: false },
  { averageCogsBahtPerImage: 0.301 },
  { highestDailyCogsBahtPerImage: 0.501 },
]) {
  const result = evaluateBrandVisualSafety({
    terminalJobs: 100,
    usableJobs: 95,
    failedJobs: 5,
    correctlyRestoredFailedJobs: 5,
    staleReservations: 0,
    duplicateDeductions: 0,
    negativeCreditBalances: 0,
    invalidAllowances: 0,
    cogsDataAdmitted: true,
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

// Task 9 (Telemetry): admin health segments first-pass acceptance by packId —
// a pure summarizer over the packId already carried on first_pass_visual_exported
// / first_pass_visual_rejected, so the DB-backed health function stays a thin
// query + this summary.
const segments = summarizeStylePackAcceptance({
  exportedPackIds: ["thai-ghost", "thai-ghost", "thai-history", null],
  rejectedPackIds: ["thai-ghost", null],
});
const ghost = segments.find((segment) => segment.packId === "thai-ghost");
assert.ok(ghost, "thai-ghost segment is present");
assert.equal(ghost?.exported, 2);
assert.equal(ghost?.rejected, 1);
assert.ok(Math.abs((ghost?.acceptanceRate ?? 0) - (2 / 3)) < 1e-9, "acceptanceRate = exported / (exported + rejected)");

const history = segments.find((segment) => segment.packId === "thai-history");
assert.equal(history?.exported, 1);
assert.equal(history?.rejected, 0);
assert.equal(history?.acceptanceRate, 1, "no rejections at all → acceptanceRate 1");

const none = segments.find((segment) => segment.packId === "none");
assert.ok(none, "unpinned (packId: null) events roll up into a \"none\" segment");
assert.equal(none?.exported, 1);
assert.equal(none?.rejected, 1);
assert.ok(Math.abs((none?.acceptanceRate ?? 0) - 0.5) < 1e-9);

assert.equal(
  summarizeStylePackAcceptance({ exportedPackIds: [], rejectedPackIds: [] }).length,
  0,
  "no events at all → no segments (never a fabricated zero-row)",
);

const zeroExported = summarizeStylePackAcceptance({
  exportedPackIds: [],
  rejectedPackIds: ["dark-story"],
});
assert.equal(zeroExported[0]?.acceptanceRate, 0, "rejections with no exports → acceptanceRate 0, not null");

// Fix-up: acceptance.byStylePack must apply the SAME cohort gate the rest of
// the health payload uses (canary/jobs/settlement/leadingMetrics.rerolls all
// filter to the current rollout's safetyCohort) — an event tagged with a
// DIFFERENT cohort (or no cohort at all) must never count, exactly like
// rerollCount's own `properties.cohort === safetyCohort` filter.
const cohortEvents = [
  { name: "first_pass_visual_exported" as const, packId: "thai-ghost", cohort: "treatment-50" },
  { name: "first_pass_visual_exported" as const, packId: "thai-ghost", cohort: "treatment-10" }, // wrong cohort
  { name: "first_pass_visual_exported" as const, packId: "thai-ghost", cohort: null }, // no cohort at all
  { name: "first_pass_visual_rejected" as const, packId: "thai-ghost", cohort: "treatment-50" },
  { name: "first_pass_visual_rejected" as const, packId: "thai-ghost", cohort: "internal" }, // wrong cohort
];
const gated = stylePackAcceptanceForCohort({ events: cohortEvents, safetyCohort: "treatment-50" });
const gatedGhost = gated.find((segment) => segment.packId === "thai-ghost");
assert.equal(gatedGhost?.exported, 1, "only the in-cohort export counts");
assert.equal(gatedGhost?.rejected, 1, "only the in-cohort rejection counts");
assert.equal(
  stylePackAcceptanceForCohort({ events: cohortEvents, safetyCohort: null }).length,
  0,
  "no active safety cohort (rollout off) → no per-pack segments at all, same as the canary/reroll metrics",
);

console.log("brand visual rollout health verification: ok");
