export type WebVitalMetric = "LCP" | "CLS" | "INP";

export const WEB_VITALS_MEASUREMENT_VERSION = "web-vitals@6.2.2+report-sequence-v1";

type ReportedMetric = {
  name: WebVitalMetric;
  id: string;
  value: number;
  navigationType?: string;
};

export type WebVitalTelemetryEvent = {
  path: string;
  value: number;
  properties: Record<string, string | number>;
};

type WebVitalTelemetryRow = {
  name: string;
  sessionId: string | null;
  value: number | null;
  properties: string | null;
  createdAt: Date;
};

function percentile(values: number[], p: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function properties(row: WebVitalTelemetryRow): Record<string, unknown> {
  if (!row.properties) return {};
  try {
    return JSON.parse(row.properties) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Translates official web-vitals reports into our privacy-safe document telemetry.
 * The library owns metric semantics; this boundary only pins attribution and suppresses
 * identical lifecycle callbacks. Changed values remain separate rows for resilient beacon delivery.
 */
export function createWebVitalReporter(
  path: string,
  navigationId: string,
  emit: (event: WebVitalTelemetryEvent) => void,
  now: () => number = () => performance.now(),
) {
  const lastValueByMetricId = new Map<string, number>();
  let reportSequence = 0;

  return (metric: ReportedMetric) => {
    if (!Number.isFinite(metric.value) || metric.value < 0 || !metric.id) return;
    const key = `${metric.name}:${metric.id}`;
    if (lastValueByMetricId.get(key) === metric.value) return;
    lastValueByMetricId.set(key, metric.value);

    emit({
      path,
      value: metric.value,
      properties: {
        metric: metric.name,
        metricVersion: WEB_VITALS_MEASUREMENT_VERSION,
        metricId: metric.id,
        navigationId,
        navigationType: metric.navigationType ?? "navigate",
        scope: "document",
        reportedAt: now(),
        reportSequence: ++reportSequence,
      },
    });
  };
}

/**
 * Keeps the latest value for each updated document metric by browser report sequence,
 * independently of database timestamp precision or retrieval order. Rows without this
 * exact collector version are historical proxies and intentionally do not join this baseline.
 */
export function summarizeWebVitals(rows: WebVitalTelemetryRow[]) {
  const latest = new Map<string, { metric: WebVitalMetric; value: number; reportSequence: number }>();

  for (const row of rows) {
    if (row.name !== "web_vital" || row.value == null || !Number.isFinite(row.value) || row.value < 0) continue;
    const props = properties(row);
    const metric = props.metric;
    const metricId = props.metricId;
    const reportSequence = props.reportSequence;
    if (
      props.metricVersion !== WEB_VITALS_MEASUREMENT_VERSION
      || (metric !== "LCP" && metric !== "CLS" && metric !== "INP")
      || typeof metricId !== "string"
      || !metricId
      || typeof reportSequence !== "number"
      || !Number.isSafeInteger(reportSequence)
      || reportSequence < 1
    ) continue;

    const key = `${row.sessionId ?? "no-session"}:${metric}:${metricId}`;
    const current = latest.get(key);
    if (!current || reportSequence > current.reportSequence) {
      latest.set(key, { metric, value: row.value, reportSequence });
    }
  }

  return (["LCP", "INP", "CLS"] as const).map((metric) => {
    const values = Array.from(latest.values())
      .filter((entry) => entry.metric === metric)
      .map((entry) => entry.value);
    return { metric, p75: percentile(values, 75), count: values.length };
  });
}
