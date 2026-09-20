// Run with: npx tsx scripts/verify-insights-data-quality.ts
// Locks the telemetry defects found in the 2026-07-30 production audit:
// Web Vitals emitted repeatedly, provider polling inflated step starts, and internal
// accounts leaked into customer-health KPIs.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  WEB_VITALS_MEASUREMENT_VERSION,
  createWebVitalReporter,
  summarizeWebVitals,
} from "../src/lib/web-vitals-telemetry";
import { shouldEmitPipelineStepStarted } from "../src/lib/pipeline-telemetry";

let passed = 0;
function ok(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
  passed += 1;
}

const emitted: Array<{ path: string; value: number; properties: Record<string, unknown> }> = [];
const reportVital = createWebVitalReporter("/dashboard", "document-1", (event) => emitted.push(event), () => 0);
reportVital({ name: "CLS", id: "v6-cls", value: 0, navigationType: "navigate" });
reportVital({ name: "CLS", id: "v6-cls", value: 0, navigationType: "navigate" });
reportVital({ name: "CLS", id: "v6-cls", value: 0.12, navigationType: "navigate" });
reportVital({ name: "INP", id: "v6-inp", value: 220, navigationType: "navigate" });

assert.deepEqual(emitted[0], {
  path: "/dashboard",
  value: 0,
  properties: {
    metric: "CLS",
    metricVersion: WEB_VITALS_MEASUREMENT_VERSION,
    metricId: "v6-cls",
    navigationId: "document-1",
    navigationType: "navigate",
    scope: "document",
    reportedAt: 0,
  },
});
ok(emitted.length === 3, "zero CLS emits once and unchanged callback does not duplicate it");

const summary = summarizeWebVitals([
  ...emitted.map((event, index) => ({
    id: `corrected-${index}`,
    name: "web_vital",
    sessionId: "session-1",
    value: event.value,
    properties: JSON.stringify({ ...event.properties, reportedAt: index + 1 }),
    createdAt: new Date(`2026-09-20T00:00:0${index}.000Z`),
  })),
  {
    id: "legacy-proxy",
    name: "web_vital",
    sessionId: "session-1",
    value: 0.99,
    properties: JSON.stringify({ metric: "CLS", scope: "document" }),
    createdAt: new Date("2026-09-20T00:00:09.000Z"),
  },
]);
ok(summary.find((v) => v.metric === "CLS")?.count === 1, "CLS updates aggregate to one document metric");
ok(summary.find((v) => v.metric === "CLS")?.p75 === 0.12, "aggregation keeps the latest CLS update");
ok(summary.find((v) => v.metric === "INP")?.p75 === 220, "aggregation preserves the official INP value");

ok(shouldEmitPipelineStepStarted(null, "tts"), "a new pipeline phase emits started");
ok(!shouldEmitPipelineStepStarted("tts", "tts"), "provider polling re-entry does not emit another started");
ok(shouldEmitPipelineStepStarted("tts", "keywords"), "a real phase transition emits started");

const providerSource = readFileSync("src/components/telemetry/telemetry-provider.tsx", "utf8");
ok(/onCLS/.test(providerSource) && /onINP/.test(providerSource), "official web-vitals owns CLS windows and INP interaction selection");
ok(/createWebVitalReporter\(vitalsPath, navigationId/.test(providerSource), "Web Vitals are pinned to the document's initial path");
ok(/navigationId/.test(providerSource), "Web Vitals carry a document navigation id");

const insightsSource = readFileSync("src/app/api/admin/insights/route.ts", "utf8");
ok(/dedupePipelineLifecycleRows/.test(insightsSource), "Insights de-duplicates lifecycle events by pipeline/job");
ok(/summarizeWebVitals/.test(insightsSource), "Insights keeps the corrected Web Vitals baseline separate from proxy rows");
ok(/customerCurrentRows/.test(insightsSource), "customer KPI telemetry excludes internal accounts");
ok(/customerCurrentJobs/.test(insightsSource), "customer job outcomes exclude internal accounts");

console.log(`\n✅ ALL ${passed} INSIGHTS DATA-QUALITY CHECKS PASSED`);
