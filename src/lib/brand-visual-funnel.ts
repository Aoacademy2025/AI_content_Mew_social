export type BrandVisualFunnelInputs = {
  controlStep2Users: number;
  treatmentStep2Users: number;
  controlObserved24hUsers: number;
  treatmentObserved24hUsers: number;
  controlFirstRenderWithin24hUsers: number;
  treatmentFirstRenderWithin24hUsers: number;
  treatmentBrandVisualSuccessUsersObserved7d: number;
  treatmentQualifiedWithin7dUsers: number;
};

function safeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Product-decision gate for the 50% → 100% rollout. The 24-hour and
 * seven-day denominators contain only users whose whole observation window has
 * elapsed, avoiding an artificially low rate from still-maturing signups. */
export function evaluateBrandVisualFunnel(raw: BrandVisualFunnelInputs) {
  const input = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, safeCount(value)]),
  ) as BrandVisualFunnelInputs;
  const controlFirstRenderRate = rate(
    input.controlFirstRenderWithin24hUsers,
    input.controlObserved24hUsers,
  );
  const treatmentFirstRenderRate = rate(
    input.treatmentFirstRenderWithin24hUsers,
    input.treatmentObserved24hUsers,
  );
  const brandLookRetentionRate = rate(
    input.treatmentQualifiedWithin7dUsers,
    input.treatmentBrandVisualSuccessUsersObserved7d,
  );
  const checks = {
    controlReachedStep2: input.controlStep2Users >= 100,
    treatmentReachedStep2: input.treatmentStep2Users >= 100,
    controlObservationComplete: input.controlObserved24hUsers >= 100,
    treatmentObservationComplete: input.treatmentObserved24hUsers >= 100,
    firstRenderWithinFivePoints: controlFirstRenderRate !== null
      && treatmentFirstRenderRate !== null
      && treatmentFirstRenderRate >= controlFirstRenderRate - 0.05,
    brandLookRetentionAtLeastTwentyPercent: brandLookRetentionRate !== null
      && brandLookRetentionRate >= 0.20,
  };
  return {
    ...input,
    controlFirstRenderRate,
    treatmentFirstRenderRate,
    treatmentVsControlPercentagePointDelta: controlFirstRenderRate !== null && treatmentFirstRenderRate !== null
      ? (treatmentFirstRenderRate - controlFirstRenderRate) * 100
      : null,
    brandLookRetentionRate,
    checks,
    canExpandTo100: Object.values(checks).every(Boolean),
  };
}
