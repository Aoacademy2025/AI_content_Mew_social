export type WebVitalMetric = "LCP" | "CLS" | "INP";

export type WebVitalEmission = {
  metric: WebVitalMetric;
  value: number;
};

/**
 * Document-scoped Core Web Vitals accumulator.
 *
 * PerformanceObserver entries are document lifecycle data, not Next.js soft-navigation
 * data. The one-shot flush prevents visibilitychange, pagehide and React cleanup from
 * writing the same cumulative values multiple times under whichever SPA route happens
 * to be current at flush time.
 */
export function createWebVitalsAccumulator() {
  let lcp = 0;
  let cls = 0;
  let inp = 0;
  let flushed = false;

  return {
    recordLcp(value: number) {
      if (!flushed && Number.isFinite(value) && value > 0) lcp = value;
    },
    recordCls(value: number) {
      if (!flushed && Number.isFinite(value) && value > 0) cls += value;
    },
    recordInp(value: number) {
      if (!flushed && Number.isFinite(value) && value > inp) inp = value;
    },
    flush(): WebVitalEmission[] {
      if (flushed) return [];
      flushed = true;
      const emissions: WebVitalEmission[] = [];
      if (lcp > 0) emissions.push({ metric: "LCP", value: Math.round(lcp) });
      if (cls > 0) emissions.push({ metric: "CLS", value: Number(cls.toFixed(4)) });
      if (inp > 0) emissions.push({ metric: "INP", value: Math.round(inp) });
      return emissions;
    },
  };
}
