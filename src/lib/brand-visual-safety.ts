export type BrandVisualSafetyInputs = {
  terminalJobs: number;
  usableJobs: number;
  failedJobs: number;
  correctlyRestoredFailedJobs: number;
  staleReservations: number;
  negativeCreditBalances: number;
  invalidAllowances: number;
  averageCogsBahtPerImage: number | null;
  highestDailyCogsBahtPerImage: number | null;
};

export function summarizeBrandVisualDailyCogs(input: {
  costsByDay: ReadonlyMap<string, number>;
  imagesByDay: ReadonlyMap<string, number>;
  usdThbRate: number;
}): {
  highestDailyCogsBahtPerImage: number | null;
  unattributedCostDays: string[];
} {
  const unattributedCostDays = [...input.costsByDay]
    .filter(([key, usdMicros]) => usdMicros > 0 && (input.imagesByDay.get(key) ?? 0) === 0)
    .map(([key]) => key)
    .sort();
  if (unattributedCostDays.length > 0) {
    return { highestDailyCogsBahtPerImage: null, unattributedCostDays };
  }
  const dailyCosts = [...input.costsByDay].flatMap(([key, usdMicros]) => {
    const images = input.imagesByDay.get(key) ?? 0;
    return images > 0
      ? [(usdMicros / 1_000_000) * input.usdThbRate / images]
      : [];
  });
  return {
    highestDailyCogsBahtPerImage: dailyCosts.length ? Math.max(...dailyCosts) : null,
    unattributedCostDays,
  };
}

export function evaluateBrandVisualSafety(input: BrandVisualSafetyInputs) {
  const enoughSample = input.terminalJobs >= 100;
  const usableRate = input.terminalJobs > 0 ? input.usableJobs / input.terminalJobs : null;
  const restorationRate = input.failedJobs > 0
    ? input.correctlyRestoredFailedJobs / input.failedJobs
    : 1;
  const checks = {
    enoughSample,
    usableRateAtLeast95Percent: usableRate !== null && usableRate >= 0.95,
    failedJobsRestored100Percent: restorationRate === 1,
    noStaleReservations: input.staleReservations === 0,
    noNegativeBalances: input.negativeCreditBalances === 0,
    noInvalidAllowances: input.invalidAllowances === 0,
    averageCogsAtMost030Baht: input.averageCogsBahtPerImage !== null
      && input.averageCogsBahtPerImage <= 0.30,
    dailyCogsAtMost050Baht: input.highestDailyCogsBahtPerImage !== null
      && input.highestDailyCogsBahtPerImage <= 0.50,
  };
  return {
    usableRate,
    restorationRate,
    checks,
    canExpand: Object.values(checks).every(Boolean),
  };
}
