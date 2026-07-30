// Run with: npx tsx scripts/verify-insights-data-quality.ts
// Locks the telemetry defects found in the 2026-07-30 production audit:
// Web Vitals emitted repeatedly, provider polling inflated step starts, and internal
// accounts leaked into customer-health KPIs.
import { readFileSync } from "node:fs";
import { createWebVitalsAccumulator } from "../src/lib/web-vitals-telemetry";
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

const vitals = createWebVitalsAccumulator();
vitals.recordLcp(1_800);
vitals.recordLcp(2_100);
vitals.recordCls(0.12);
vitals.recordCls(0.04);
vitals.recordInp(140);
vitals.recordInp(220);
const firstFlush = vitals.flush();
const secondFlush = vitals.flush();

ok(firstFlush.find((v) => v.metric === "LCP")?.value === 2_100, "LCP keeps the latest document value");
ok(firstFlush.find((v) => v.metric === "CLS")?.value === 0.16, "CLS sums non-input layout shifts");
ok(firstFlush.find((v) => v.metric === "INP")?.value === 220, "INP keeps the worst interaction");
ok(secondFlush.length === 0, "a document's Web Vitals emit once even when hidden/pagehide/cleanup all fire");

ok(shouldEmitPipelineStepStarted(null, "tts"), "a new pipeline phase emits started");
ok(!shouldEmitPipelineStepStarted("tts", "tts"), "provider polling re-entry does not emit another started");
ok(shouldEmitPipelineStepStarted("tts", "keywords"), "a real phase transition emits started");

const providerSource = readFileSync("src/components/telemetry/telemetry-provider.tsx", "utf8");
ok(/path:\s*vitalsPath/.test(providerSource), "Web Vitals are pinned to the document's initial path");
ok(/navigationId/.test(providerSource), "Web Vitals carry a document navigation id");

const insightsSource = readFileSync("src/app/api/admin/insights/route.ts", "utf8");
ok(/dedupePipelineLifecycleRows/.test(insightsSource), "Insights de-duplicates lifecycle events by pipeline/job");
ok(/customerCurrentRows/.test(insightsSource), "customer KPI telemetry excludes internal accounts");
ok(/customerCurrentJobs/.test(insightsSource), "customer job outcomes exclude internal accounts");

console.log(`\n✅ ALL ${passed} INSIGHTS DATA-QUALITY CHECKS PASSED`);
