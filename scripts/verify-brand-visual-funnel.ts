import assert from "node:assert/strict";
import { evaluateBrandVisualFunnel } from "../src/lib/brand-visual-funnel";

const passing = evaluateBrandVisualFunnel({
  controlStep2Users: 112,
  treatmentStep2Users: 108,
  controlObserved24hUsers: 105,
  treatmentObserved24hUsers: 103,
  controlFirstRenderWithin24hUsers: 84,
  treatmentFirstRenderWithin24hUsers: 78,
  treatmentBrandVisualSuccessUsersObserved7d: 50,
  treatmentQualifiedWithin7dUsers: 10,
});
assert.equal(passing.canExpandTo100, true);
assert.equal(passing.controlFirstRenderRate, 0.8);
assert.ok(Math.abs((passing.treatmentFirstRenderRate ?? 0) - (78 / 103)) < 1e-12);
assert.equal(passing.brandLookRetentionRate, 0.2);

for (const failing of [
  { controlStep2Users: 99 },
  { treatmentStep2Users: 99 },
  { controlObserved24hUsers: 99 },
  { treatmentObserved24hUsers: 99 },
  { treatmentFirstRenderWithin24hUsers: 76 },
  { treatmentQualifiedWithin7dUsers: 9 },
]) {
  const result = evaluateBrandVisualFunnel({
    controlStep2Users: 112,
    treatmentStep2Users: 108,
    controlObserved24hUsers: 105,
    treatmentObserved24hUsers: 103,
    controlFirstRenderWithin24hUsers: 84,
    treatmentFirstRenderWithin24hUsers: 78,
    treatmentBrandVisualSuccessUsersObserved7d: 50,
    treatmentQualifiedWithin7dUsers: 10,
    ...failing,
  });
  assert.equal(result.canExpandTo100, false, `expected ${JSON.stringify(failing)} to block full rollout`);
}

assert.equal(evaluateBrandVisualFunnel({
  controlStep2Users: 100,
  treatmentStep2Users: 100,
  controlObserved24hUsers: 100,
  treatmentObserved24hUsers: 100,
  controlFirstRenderWithin24hUsers: 0,
  treatmentFirstRenderWithin24hUsers: 0,
  treatmentBrandVisualSuccessUsersObserved7d: 0,
  treatmentQualifiedWithin7dUsers: 0,
}).canExpandTo100, false, "an empty Brand Visual retention denominator cannot pass");

console.log("brand visual funnel verification: ok");
